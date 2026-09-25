import * as THREE from 'three';
import { BALLOON, BOT, JUMPPAD, MATCH, NET, PLAYER, PLAYER_COLORS, TANK, TEAM_COLORS, WATER_TINT, WEAPONS } from '../config';
import { Emitter } from '../core/events';
import { emptyIntent, type Input, type Intent } from '../core/input';
import { mulberry32 } from '../core/rng';
import type { Sfx } from '../audio/sfx';
import type { RenderContext } from '../render/renderer';
import type { GameAssets } from '../render/assets';
import { Fx } from '../render/fx';
import type { Hud, ScoreRow } from '../ui/hud';
import type { Profile } from '../ui/profile';
import { Session } from '../net/session';
import type { Transport } from '../net/transport';
import type { NetHit, NetShot, NetSplash } from '../net/protocol';
import type { DamageSource, GameMode, MatchState, PeerId, PlayerInfo, TeamId } from '../types';
import { isInWater, solvePadLaunch, type GameMap, type SpawnPoint } from '../world/map';
import { Avatar } from './avatar';
import { BotActor, RemoteActor, Vitality } from './actors';
import { BotBrain, BotDirector, botName, botShotDirection } from './bots';
import { MatchHost, MatchView } from './match';
import { PlayerBody } from './playerBody';
import { ProjectileSystem, type HitTarget } from './projectiles';
import { pickSpawn, type SpawnThreat } from './spawns';
import { ViewModel } from './viewmodel';
import { Arsenal, type FireRequest } from './weapons';
import { HAT_IDS } from '../types';

export interface GameOptions {
  transport: Transport;
  /** HUD 에 보여 줄 방 이름 */
  roomLabel: string;
  /** 초대 링크용 코드(빠른 대전·연습은 null) */
  roomCode: string | null;
  /** 내가 호스트일 때 쓸 모드 */
  mode: GameMode;
  /** 사람이 적으면 봇으로 채우기 */
  botFill: boolean;
  profile: Profile;
}

interface GameEvents {
  /** 네트워크 경고 등 사용자에게 알릴 메시지 */
  notice: (text: string) => void;
  /** 정원(사람 MATCH.maxPlayers)을 넘었고 내가 가장 늦게 온 쪽이라 나가야 함 */
  roomFull: () => void;
}

/** 개발·테스트용 조작 훅(DEV 빌드 또는 ?debug) */
export interface DebugApi {
  state(): Record<string, unknown>;
  setIntent(i: Partial<Intent> | null): void;
  aimAt(id: PeerId): boolean;
  teleport(x: number, y: number, z: number): void;
  /** 시선 설정(라디안). yaw 0 = −Z 방향 */
  look(yaw: number, pitch: number): void;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _color = new THREE.Color();

/**
 * 한 판(방) 동안의 게임. 로컬 플레이어 조작, 원격 플레이어 보간, 호스트 역할(경기·봇),
 * 투사체·효과·HUD·효과음을 한 루프에서 묶는다.
 */
export class Game extends Emitter<GameEvents> {
  readonly session: Session;
  private readonly projectiles: ProjectileSystem;
  private readonly fx: Fx;
  private readonly viewmodel: ViewModel;
  private readonly body: PlayerBody;
  private readonly arsenal = new Arsenal();
  private readonly vit = new Vitality();
  private readonly remotes = new Map<PeerId, RemoteActor>();
  private readonly bots = new Map<PeerId, BotActor>();
  /** 봇 공용 상태(인지 목록·발사 소리·봐주기·대상 나눠 갖기) — 호스트일 때만 쓴다 */
  private readonly botDirector = new BotDirector();
  private matchHost: MatchHost | null = null;
  private readonly matchView = new MatchView();
  private pendingShots: NetShot[] = [];
  private pendingHits: NetHit[] = [];
  private netAccum = 0;
  private matchAccum = 0;
  private pingAccum = 0;
  private readonly pings = new Map<PeerId, number>();
  private time = 0;
  private recoil = 0;
  private padCooldown = 0;
  private refillSfx = 0;
  private lowWaterWarned = false;
  private deathPos = new THREE.Vector3();
  private deathT = 0;
  private lastSpawn: SpawnPoint | null = null;
  private targets: HitTarget[] = [];
  private botSeq = 0;
  private botGrace: number;
  private disposed = false;
  private inputEnabled = true;
  private debugIntent: Partial<Intent> | null = null;
  private lastRound = -1;
  private lastPhase: MatchState['phase'] | null = null;
  private readonly rnd = mulberry32((Math.random() * 1e9) | 0);
  private readonly disposers: Array<() => void> = [];
  private myColor = '';
  private roomFullEmitted = false;

  constructor(
    private readonly ctx: RenderContext,
    private readonly input: Input,
    private readonly sfx: Sfx,
    private readonly hud: Hud,
    private readonly assets: GameAssets,
    private readonly map: GameMap,
    private readonly opts: GameOptions,
  ) {
    super();
    const selfInfo: PlayerInfo = {
      id: '', name: opts.profile.name, cosmetics: { ...opts.profile.cosmetics }, isBot: false, joinedAt: Date.now(),
    };
    this.session = new Session(opts.transport, selfInfo);
    this.botGrace = opts.transport.peers().length > 0 ? 2 : 0;

    ctx.scene.add(map.root);
    const balloonTpl = assets.weapons.get('balloon');
    let balloonGeo: THREE.BufferGeometry | undefined;
    let balloonMat: THREE.Material | undefined;
    balloonTpl?.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!balloonGeo && m.isMesh && !m.userData.isOutline) {
        balloonGeo = m.geometry;
        balloonMat = Array.isArray(m.material) ? m.material[0] : m.material;
      }
    });
    this.projectiles = new ProjectileSystem(map.collision, {
      targets: () => this.targets,
      onHit: (shooter, victim, amount, source, dir) => this.onAuthoritativeHit(shooter, victim, amount, source, dir),
      onImpact: (point, normal, _source, color) => {
        this.fx.impact(point, normal, 1, color);
        if (point.distanceToSquared(this.body.position) < 100) this.sfx.play('impact', { pos: point, volume: 0.35 });
      },
      onBodySplash: (point, victim, _source, color) => {
        this.fx.bodyHit(point, color);
        (this.remotes.get(victim)?.avatar ?? this.bots.get(victim)?.avatar)?.hit(point);
        this.sfx.play('hit', { pos: point, volume: 0.5 });
      },
      onBurst: (point, shooter) => this.onBurst(point, shooter),
    }, balloonGeo, balloonMat);
    this.projectiles.addTo(ctx.scene);
    this.fx = new Fx(ctx.scene);

    this.body = new PlayerBody(map.collision);
    this.viewmodel = new ViewModel(assets, ctx, this.colorOf(this.session.selfId));
    this.viewmodel.setWeapon(this.arsenal.current);

    this.bindSession();
    this.disposers.push(this.input.on('key', (code, down) => {
      if (down && code === 'KeyR') this.sfx.play('switch');
    }));

    if (this.session.isHost) this.becomeHost();
    this.respawnLocal();
    this.hud.show(true);
    this.installDebug();
    this.ctx.beginQualityProbe();
  }

  // ================================================================ lifecycle

  setInputEnabled(v: boolean): void {
    this.inputEnabled = v;
  }

  get roomCode(): string | null {
    return this.opts.roomCode;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.disposers.forEach((d) => d());
    this.projectiles.dispose();
    for (const r of this.remotes.values()) r.avatar.dispose();
    for (const b of this.bots.values()) b.avatar.dispose();
    this.remotes.clear();
    this.bots.clear();
    this.ctx.scene.remove(this.map.root, this.projectiles.dropletMesh, this.projectiles.balloonMesh);
    this.viewmodel.dispose();
    this.fx.dispose();
    this.hud.show(false);
    if ((window as unknown as { __splash?: unknown }).__splash) delete (window as unknown as { __splash?: unknown }).__splash;
    await this.session.close();
  }

  // ================================================================ session wiring

  private bindSession(): void {
    const s = this.session;
    s.on('playerInfo', (info) => this.onPlayerInfo(info));
    s.on('playerLeft', (id) => this.onPlayerLeft(id));
    s.on('botInfos', (infos) => this.onBotInfos(infos));
    s.on('snapshot', (id, snap, localT) => this.remotes.get(id)?.buffer.push(localT, snap));
    s.on('shots', (shots, from) => this.onRemoteShots(shots, from));
    s.on('hits', (hits) => this.onRemoteHits(hits));
    s.on('splash', (ev) => this.handleSplash(ev));
    s.on('match', (m, _from, localT) => this.onMatch(m, localT));
    s.on('hostChanged', (_id, isSelf) => (isSelf ? this.becomeHost() : this.loseHost()));
    s.on('error', (msg) => this.emit('notice', msg));
  }

  private onPlayerInfo(info: PlayerInfo): void {
    let r = this.remotes.get(info.id);
    if (!r) {
      r = new RemoteActor(info, this.makeAvatar(info));
      this.remotes.set(info.id, r);
      this.hud.toast(`${info.name} 님이 들어왔어요 💦`);
      this.sfx.play('click');
    } else {
      r.info = info;
      this.refreshAvatar(r);
    }
    if (this.matchHost) {
      this.matchHost.addPlayer(info.id);
      this.session.sendMatch(this.matchHost.snapshot(), info.id);
      this.session.sendBotInfos([...this.bots.values()].map((b) => b.info), info.id);
      this.adjustBots();
    }
    this.checkCapacity();
  }

  /**
   * 정원 초과 처리: 방 탐색은 일부만 보고 판단하므로 입장 뒤에도 확인한다.
   * 모든 피어가 같은 (joinedAt, id) 순서로 판단하므로 늦게 온 사람만 나간다.
   */
  private checkCapacity(): void {
    if (this.roomFullEmitted || !this.session.online) return;
    const humans = this.session.players().filter((p) => !p.isBot);
    if (humans.length <= MATCH.maxPlayers) return;
    humans.sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const rank = humans.findIndex((p) => p.id === this.session.selfId);
    if (rank >= MATCH.maxPlayers) {
      this.roomFullEmitted = true;
      this.emit('roomFull');
    }
  }

  private onPlayerLeft(id: PeerId): void {
    const r = this.remotes.get(id);
    if (!r) return;
    this.hud.toast(`${r.info.name} 님이 나갔어요`);
    r.avatar.dispose();
    this.remotes.delete(id);
    // 떠난 사람에게 보낼 명중은 받을 권한자가 없다
    this.pendingHits = this.pendingHits.filter((h) => h.victim !== id);
    if (this.matchHost) {
      this.matchHost.removePlayer(id);
      this.adjustBots();
      this.broadcastMatch();
    }
  }

  private onBotInfos(infos: PlayerInfo[]): void {
    if (this.session.isHost) return;
    const keep = new Set(infos.map((i) => i.id));
    for (const [id, r] of this.remotes) {
      if (r.info.isBot && !keep.has(id)) {
        r.avatar.dispose();
        this.remotes.delete(id);
      }
    }
    for (const info of infos) {
      const r = this.remotes.get(info.id);
      if (!r) {
        this.remotes.set(info.id, new RemoteActor(info, this.makeAvatar(info)));
      } else if (r.info.name !== info.name || r.info.cosmetics.color !== info.cosmetics.color || r.info.cosmetics.hat !== info.cosmetics.hat) {
        // 같은 id 인데 모습이 다른 봇(봇 id 는 호스트별이라 드물지만, 합쳐진 두 호스트의 id 앞자리가 겹친 경우 등):
        // 모습을 바꾸고 이전 봇의 위치 기록은 버린다
        r.info = info;
        r.buffer.clear();
        this.refreshAvatar(r);
      } else {
        r.info = info;
      }
    }
  }

  private onMatch(m: MatchState, localT: number): void {
    if (this.session.isHost) return;
    this.matchView.apply(m, localT);
    this.afterMatchUpdate(m);
  }

  /** 경기 상태가 바뀐 뒤: 새 라운드면 전원 부활, 팀 색 갱신 */
  private afterMatchUpdate(m: MatchState): void {
    const newRound = m.round !== this.lastRound && this.lastRound !== -1;
    const toPlaying = m.phase === 'playing' && this.lastPhase === 'results';
    if ((newRound || toPlaying) && m.phase === 'playing') {
      this.respawnLocal();
      for (const b of this.bots.values()) this.respawnBot(b);
      this.hud.centerMessage('새 경기 시작!', m.mode === 'tdm' ? '팀을 도와 적을 흠뻑 적셔요' : '모두를 흠뻑 적셔요', 2);
      this.sfx.play('spawn');
    }
    if (m.phase === 'results' && this.lastPhase === 'playing') this.sfx.play('win');
    this.lastRound = m.round;
    this.lastPhase = m.phase;
    this.refreshAllIdentities();
  }

  // ================================================================ host role

  private becomeHost(): void {
    const prev = this.matchView.state;
    this.matchHost = prev
      ? MatchHost.fromState(prev, this.session.selfId, this.matchView.elapsedSinceReceive(performance.now()))
      : new MatchHost(this.opts.mode, this.session.selfId);
    for (const p of this.session.players()) this.matchHost.addPlayer(p.id);
    // 원격으로 보던 봇을 이어받아 시뮬레이션
    for (const [id, r] of [...this.remotes]) {
      if (!r.info.isBot) continue;
      this.remotes.delete(id);
      const bot = new BotActor(r.info, r.avatar, this.makeBrain(id), this.map.collision);
      if (r.hasData) {
        bot.body.teleport(r.pos, r.yaw);
        bot.vitality.soak = r.soak * PLAYER.maxSoak;
        bot.vitality.alive = r.alive;
        if (!r.alive) bot.vitality.respawnIn = 1;
      } else {
        this.respawnBot(bot);
      }
      this.bots.set(id, bot);
      this.matchHost.addPlayer(id);
    }
    // 받은 경기 상태에 남아 있던 떠난 사람(방금 나간 이전 호스트 등)은 점수판·우승 후보에서 뺀다
    this.matchHost.retain([...this.session.players().map((p) => p.id), ...this.bots.keys()]);
    this.adjustBots();
    this.broadcastMatch();
    this.lastRound = this.matchHost.snapshot().round;
    this.lastPhase = this.matchHost.phase;
    if (this.remotes.size > 0) this.hud.toast('방장이 되었어요 👑');
  }

  private loseHost(): void {
    this.matchHost = null;
    for (const b of this.bots.values()) b.avatar.dispose();
    this.bots.clear();
  }

  private humanCount(): number {
    return 1 + [...this.remotes.values()].filter((r) => !r.info.isBot).length;
  }

  /** 사람 수에 맞춰 봇 추가·제거(호스트) */
  private adjustBots(): void {
    if (!this.matchHost || this.botGrace > 0) return;
    const want = this.opts.botFill ? Math.max(0, MATCH.botFillTo - this.humanCount()) : 0;
    let changed = false;
    while (this.bots.size < want) {
      // 봇 id 는 호스트마다 다르게(bot-<내 id 앞 4자>-N): 따로 시작한 두 호스트가 합쳐질 때 진 쪽 봇과 이긴 쪽 봇이
      // 같은 id 로 섞이지 않는다(진 쪽 손님 화면의 봇 교체, 사라진 봇을 향한 명중이 엉뚱한 봇에 가는 일 방지).
      // 이름은 이어받은 봇(이전 호스트가 만든 봇)과 겹치지 않게 고른다
      const names = new Set([...this.bots.values()].map((b) => b.info.name));
      const prefix = `bot-${this.session.selfId.slice(0, 4)}-`;
      let n = this.botSeq++;
      while (names.has(botName(n)) || this.bots.has(prefix + n)) n = this.botSeq++;
      const id = prefix + n;
      const info: PlayerInfo = {
        id, name: botName(n), isBot: true, joinedAt: 0,
        cosmetics: { color: Math.floor(this.rnd() * PLAYER_COLORS.length), hat: HAT_IDS[1 + Math.floor(this.rnd() * (HAT_IDS.length - 1))] },
      };
      const bot = new BotActor(info, this.makeAvatar(info), this.makeBrain(id), this.map.collision);
      this.bots.set(id, bot);
      this.matchHost.addPlayer(id);
      this.respawnBot(bot);
      changed = true;
    }
    while (this.bots.size > want) {
      // 점수가 가장 낮은 봇부터 뺀다
      const scores = this.matchHost.snapshot().scores;
      const victim = [...this.bots.keys()].sort((a, b) => (scores[a]?.splashes ?? 0) - (scores[b]?.splashes ?? 0))[0];
      this.bots.get(victim)!.avatar.dispose();
      this.bots.delete(victim);
      this.matchHost.removePlayer(victim);
      changed = true;
    }
    if (changed) {
      this.broadcastMatch();
      this.refreshAllIdentities();
    }
  }

  private makeBrain(id: PeerId): BotBrain {
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return new BotBrain(h ^ ((this.rnd() * 1e9) | 0), () => this.teamOf(id));
  }

  /** 경기 상태 + 봇 목록 방송. 1Hz 로 반복되므로 순서가 꼬여 놓친 피어(호스트 이전·합류 직후)도 곧 따라잡는다 */
  private broadcastMatch(): void {
    if (!this.matchHost) return;
    this.matchAccum = 0;
    this.session.sendBotInfos([...this.bots.values()].map((b) => b.info));
    this.session.sendMatch(this.matchHost.snapshot());
  }

  // ================================================================ identity / colors

  teamOf(id: PeerId): TeamId {
    return this.matchHost ? this.matchHost.teamOf(id) : this.matchView.teamOf(id);
  }

  private mode(): GameMode {
    return this.matchHost?.mode ?? this.matchView.state?.mode ?? this.opts.mode;
  }

  private infoOf(id: PeerId): PlayerInfo | undefined {
    if (id === this.session.selfId) return this.session.self;
    return this.remotes.get(id)?.info ?? this.bots.get(id)?.info;
  }

  colorOf(id: PeerId): string {
    const team = this.teamOf(id);
    if (this.mode() === 'tdm' && (team === 0 || team === 1)) return TEAM_COLORS[team];
    const info = this.infoOf(id);
    return PLAYER_COLORS[info?.cosmetics.color ?? 0];
  }

  private waterColor(id: PeerId, out: THREE.Color): THREE.Color {
    return out.set(WATER_TINT.base).lerp(_color.set(this.colorOf(id)), WATER_TINT.mix);
  }

  private nameOf(id: PeerId): string {
    return this.infoOf(id)?.name ?? '???';
  }

  private makeAvatar(info: PlayerInfo): Avatar {
    const color = this.colorOf(info.id);
    const avatar = new Avatar(this.assets, info.name + (info.isBot ? ' 🤖' : ''), color, info.cosmetics.hat, this.nameColor(info.id));
    avatar.root.userData.appliedColor = color;
    avatar.effects = this.fx;
    this.ctx.scene.add(avatar.root);
    return avatar;
  }

  private nameColor(id: PeerId): string {
    const team = this.teamOf(id);
    return this.mode() === 'tdm' && (team === 0 || team === 1) ? TEAM_COLORS[team] : '#ffffff';
  }

  private refreshAvatar(a: RemoteActor | BotActor): void {
    const color = this.colorOf(a.info.id);
    a.avatar.setIdentity(a.info.name + (a.info.isBot ? ' 🤖' : ''), color, a.info.cosmetics.hat, this.nameColor(a.info.id));
    a.avatar.root.userData.appliedColor = color;
  }

  private refreshAllIdentities(): void {
    for (const a of [...this.remotes.values(), ...this.bots.values()]) {
      if (a.avatar.root.userData.appliedColor !== this.colorOf(a.info.id)) this.refreshAvatar(a);
    }
    const mine = this.colorOf(this.session.selfId);
    if (mine !== this.myColor) {
      this.myColor = mine;
      this.viewmodel.setColor(mine);
    }
  }

  // ================================================================ combat events

  /** 권한 있는 투사체(내 것, 호스트면 봇 것)가 누군가를 맞힘 */
  private onAuthoritativeHit(shooter: PeerId, victim: PeerId, amount: number, source: DamageSource, dir: THREE.Vector3): void {
    if (shooter === this.session.selfId) {
      this.hud.hitMarker(false, amount);
      // 연속 명중 음 사다리는 Sfx 가 처리
      this.sfx.play('hitmark');
    }
    if (victim === this.session.selfId) {
      this.applyLocalHit(amount, shooter, source, dir);
      return;
    }
    const bot = this.bots.get(victim);
    if (bot) {
      this.applyBotHit(bot, amount, shooter, source);
      return;
    }
    this.pendingHits.push({ victim, shooter, amount, source, dir: [dir.x, dir.y, dir.z] });
  }

  private onRemoteHits(hits: NetHit[]): void {
    for (const h of hits) {
      if (h.victim === this.session.selfId) {
        this.applyLocalHit(h.amount, h.shooter, h.source, _v.set(h.dir[0], h.dir[1], h.dir[2]));
      } else {
        const bot = this.bots.get(h.victim);
        if (bot) this.applyBotHit(bot, h.amount, h.shooter, h.source);
      }
    }
  }

  private applyLocalHit(amount: number, shooter: PeerId, source: DamageSource, dir: THREE.Vector3): void {
    if (this.phase() !== 'playing') return;
    const wasAlive = this.vit.alive;
    const died = this.vit.applyHit(amount, shooter, source);
    if (!wasAlive) return;
    this.sfx.play('hit', { volume: 0.8 });
    // 화면 기준 피격 방향: 물이 날아온 반대 방향
    const from = Math.atan2(-dir.x, -dir.z);
    let rel = from - this.body.yaw;
    while (rel > Math.PI) rel -= Math.PI * 2;
    while (rel < -Math.PI) rel += Math.PI * 2;
    this.hud.damageFrom(-rel + Math.PI);
    if (died) {
      const ev: NetSplash = { victim: this.session.selfId, killer: shooter, source, pos: [this.body.position.x, this.body.position.y, this.body.position.z] };
      this.session.sendSplash(ev);
      this.handleSplash(ev);
    }
  }

  private applyBotHit(bot: BotActor, amount: number, shooter: PeerId, source: DamageSource): void {
    if (this.phase() !== 'playing') return;
    bot.brain.lastAttacker = shooter;
    if (bot.vitality.applyHit(amount, shooter, source)) {
      const p = bot.body.position;
      const ev: NetSplash = { victim: bot.info.id, killer: shooter, source, pos: [p.x, p.y, p.z] };
      this.session.sendSplash(ev);
      this.handleSplash(ev);
    }
  }

  /** 누군가 흠뻑 젖어 쓰러짐(모든 피어에서 같은 처리) */
  private handleSplash(ev: NetSplash): void {
    const pos = _v.set(ev.pos[0], ev.pos[1] + 0.8, ev.pos[2]);
    // 보이는 캐릭터는 쏜 사람 색으로 부풀었다 펑!, 아니면(내가 젖음 등) 그 자리에서 바로 펑
    const victimAvatar = this.remotes.get(ev.victim)?.avatar ?? this.bots.get(ev.victim)?.avatar;
    if (victimAvatar?.root.visible) victimAvatar.splashOut(this.colorOf(ev.killer));
    else this.fx.splashOut(pos, this.colorOf(ev.killer), ev.pos[1]);
    this.sfx.play('splashed', { pos, volume: 0.9 });
    const self = this.session.selfId;
    const killer = ev.killer === ev.victim ? '물웅덩이' : this.nameOf(ev.killer);
    const bySelf = ev.killer === self && ev.victim !== self;
    // 킬피드·연속 기록·흠뻑 카드(누가 무엇으로)는 HUD 가 처리
    this.hud.splash({
      killer, killerColor: this.colorOf(ev.killer), victim: this.nameOf(ev.victim), victimColor: this.colorOf(ev.victim),
      source: ev.source, bySelf, onSelf: ev.victim === self,
    });
    if (bySelf) {
      this.hud.hitMarker(true);
      this.sfx.play('kill');
    }
    if (ev.victim === self) {
      this.deathPos.copy(this.body.position);
      this.deathT = 0;
    }
    if (this.matchHost) {
      this.matchHost.recordSplash(ev.victim, ev.killer);
      this.broadcastMatch();
      this.afterMatchUpdate(this.matchHost.snapshot());
    }
  }

  private onBurst(point: THREE.Vector3, _shooter: PeerId): void {
    this.fx.burst(point, BALLOON.blastRadius);
    this.sfx.play('burst', { pos: point });
    // 넉백: 모든 피어가 자기 몸(호스트는 봇 포함)에 적용
    const push = (body: PlayerBody) => {
      _v2.copy(body.position).setY(body.position.y + PLAYER.height * 0.5).sub(point);
      const d = _v2.length();
      if (d > BALLOON.blastRadius) return;
      _v2.y = 0;
      if (_v2.lengthSq() < 1e-4) _v2.set(0, 0, 1);
      _v2.normalize().multiplyScalar(BALLOON.knockback * (1 - d / BALLOON.blastRadius * 0.5));
      body.launch(BALLOON.knockUp, _v2);
    };
    if (this.vit.alive) push(this.body);
    for (const b of this.bots.values()) if (b.vitality.alive) push(b.body);
  }

  private onRemoteShots(shots: NetShot[], from: PeerId): void {
    const now = performance.now();
    const clock = this.session.clock(from);
    for (const s of shots) {
      if (s.shooter === this.session.selfId || this.bots.has(s.shooter)) continue;
      if (this.matchHost) this.botDirector.noteFire(s.shooter);
      const advance = clock.ready ? THREE.MathUtils.clamp((now - clock.toLocal(s.t)) / 1000, 0, 0.2) : 0;
      _origin.set(s.origin[0], s.origin[1], s.origin[2]);
      _aim.set(s.dir[0], s.dir[1], s.dir[2]);
      this.waterColor(s.shooter, _color);
      const team = this.teamOf(s.shooter);
      if (s.kind === 'balloon') {
        this.projectiles.throwBalloon(s.shooter, team, _origin, _aim, _v.set(s.inherit[0], s.inherit[1], s.inherit[2]), false, _color, advance);
        this.sfx.play('throw', { pos: _origin });
      } else {
        this.projectiles.fireGun(s.shooter, team, s.kind, _origin, _aim, s.seed, s.spread, false, _color, advance);
        this.sfx.play(s.kind, { pos: _origin, volume: 0.7 });
      }
    }
  }

  // ================================================================ spawning

  private threats(forTeam: TeamId, exclude: PeerId): SpawnThreat[] {
    const out: SpawnThreat[] = [];
    const add = (id: PeerId, pos: THREE.Vector3, alive: boolean) => {
      if (id === exclude) return;
      const team = this.teamOf(id);
      if (forTeam !== -1 && team === forTeam) return;
      out.push({ pos, team, alive });
    };
    add(this.session.selfId, this.body.position, this.vit.alive);
    for (const r of this.remotes.values()) if (this.shown(r)) add(r.info.id, r.pos, r.alive);
    for (const b of this.bots.values()) add(b.info.id, b.body.position, b.vitality.alive);
    return out;
  }

  private respawnLocal(): void {
    const team = this.teamOf(this.session.selfId);
    const sp = pickSpawn(this.map, team, this.threats(team, this.session.selfId), this.lastSpawn);
    this.lastSpawn = sp;
    this.body.teleport(sp.pos, sp.yaw);
    this.vit.spawn();
    this.arsenal.reset();
  }

  private respawnBot(bot: BotActor): void {
    const team = this.teamOf(bot.info.id);
    const sp = pickSpawn(this.map, team, this.threats(team, bot.info.id), bot.lastSpawn as SpawnPoint | null, this.rnd);
    bot.lastSpawn = sp;
    bot.body.teleport(sp.pos, sp.yaw);
    bot.vitality.spawn();
    bot.arsenal.reset();
    bot.brain.reset();
  }

  // ================================================================ per-frame

  private phase(): MatchState['phase'] {
    return this.matchHost?.phase ?? this.matchView.state?.phase ?? 'playing';
  }

  private refillRate(pos: THREE.Vector3): { rate: number; inWater: boolean } {
    _v.copy(pos).setY(pos.y + 0.3);
    if (isInWater(this.map, _v)) return { rate: TANK.poolPerSec, inWater: true };
    for (const f of this.map.fountains) {
      const dx = f.pos.x - pos.x;
      const dz = f.pos.z - pos.z;
      if (dx * dx + dz * dz <= f.radius * f.radius && Math.abs(f.pos.y - pos.y) < 2) return { rate: TANK.fountainPerSec, inWater: false };
    }
    return { rate: 0, inWater: false };
  }

  private movementState(body: PlayerBody): 'still' | 'moving' | 'air' {
    if (!body.grounded) return 'air';
    return Math.hypot(body.velocity.x, body.velocity.z) > 1 ? 'moving' : 'still';
  }

  update(dt: number): void {
    if (this.disposed) return;
    this.time += dt;
    const now = performance.now();
    const playing = this.phase() === 'playing';
    if (this.botGrace > 0) {
      this.botGrace -= dt;
      if (this.botGrace <= 0) this.adjustBots();
    }

    // ---------------- 로컬 플레이어
    const look = this.input.consumeLook();
    let intent = this.inputEnabled ? this.input.sample() : (this.input.sample(), emptyIntent());
    if (this.debugIntent) intent = { ...intent, ...this.debugIntent };
    if (this.vit.alive && this.inputEnabled) {
      this.body.yaw += look.dYaw;
      this.body.pitch = THREE.MathUtils.clamp(this.body.pitch + look.dPitch, -1.5, 1.5);
      this.viewmodel.addSway(look.dYaw, look.dPitch);
    }
    const refill = this.refillRate(this.body.position);
    if (this.vit.alive) {
      this.body.speedScale = (refill.inWater ? PLAYER.waterSpeedScale : 1) * this.arsenal.moveScale;
      this.body.step(dt, intent);
      if (this.body.jumped) this.sfx.play('jump', { volume: 0.5 });
      if (this.body.slideStarted) this.sfx.play('land', { volume: 0.6, pitch: 1.4 });
      // 발소리·착지(젖을수록 철벅) — 간격·세기 판단은 Sfx 가 한다
      const wet = this.vit.soak / PLAYER.maxSoak;
      this.sfx.footsteps(dt, this.body.grounded && !this.body.sliding ? Math.hypot(this.body.velocity.x, this.body.velocity.z) : 0, wet, refill.inWater);
      if (this.body.landedSpeed > 0) this.sfx.landing(this.body.landedSpeed / PLAYER.hardLandingSpeed, wet);
      if (refill.inWater && Math.hypot(this.body.velocity.x, this.body.velocity.z) > 1 && this.rnd() < dt * 8) this.fx.sprinkle(this.body.position);
      this.checkJumpPads(this.body, dt, true);
      if (this.body.position.y < this.map.bounds.killY) this.respawnLocal();

      const reqs = this.arsenal.tick(dt, intent, refill.rate, playing, this.movementState(this.body));
      for (const req of reqs) this.fireLocal(req);
      if (this.arsenal.dryFire) this.sfx.play('dry');
      if (this.arsenal.switched) {
        this.viewmodel.setWeapon(this.arsenal.current);
        this.sfx.play('switch');
      }
      if (refill.rate > 0 && this.arsenal.tank < TANK.capacity) {
        this.refillSfx -= dt;
        if (this.refillSfx <= 0) {
          this.refillSfx = 0.12;
          this.sfx.play('refill', { volume: 0.4 });
        }
      }
      if (this.arsenal.lowWater && !this.lowWaterWarned) {
        this.lowWaterWarned = true;
        this.sfx.play('lowWater');
      } else if (this.arsenal.tank > 40) {
        this.lowWaterWarned = false;
      }
    }
    if (this.vit.tick(dt)) {
      this.respawnLocal();
      this.sfx.play('spawn');
    }
    if (!this.vit.alive) this.deathT += dt;

    // ---------------- 봇(호스트)
    if (this.matchHost) this.updateBots(dt, playing);

    // ---------------- 원격 보간
    const renderT = now - NET.interpDelayMs;
    for (const r of this.remotes.values()) {
      r.sample(renderT);
      if (!this.shown(r)) {
        r.avatar.root.visible = false;
        continue;
      }
      r.avatar.update(dt, { pos: r.pos, vel: r.vel, yaw: r.yaw, pitch: r.pitch, grounded: r.grounded, soak: r.soak, alive: r.alive, shielded: r.shielded, weapon: r.weapon });
    }

    // ---------------- 투사체·효과
    this.rebuildTargets();
    this.projectiles.update(dt);
    this.fx.update(dt);

    // ---------------- 네트워크
    this.session.update(now);
    this.netAccum += dt;
    if (this.netAccum >= 1 / NET.stateHz) {
      this.netAccum = 0;
      this.sendNet(now);
    }
    if (this.matchHost) {
      const changed = this.matchHost.tick(dt * 1000, this.presentIds());
      this.matchAccum += dt * 1000;
      if (changed || this.matchAccum >= NET.matchBroadcastMs) {
        this.broadcastMatch();
        if (changed) this.afterMatchUpdate(this.matchHost.snapshot());
      }
    }
    this.pingAccum += dt;
    if (this.pingAccum > 3) {
      this.pingAccum = 0;
      for (const id of this.session.transport.peers()) {
        this.session.transport.ping(id).then((ms) => this.pings.set(id, ms), () => undefined);
      }
    }

    // ---------------- 카메라·HUD
    this.updateCamera(dt);
    this.updateHud(dt, refill.rate > 0, now);
  }

  private presentIds(): PeerId[] {
    return [this.session.selfId, ...[...this.remotes.values()].filter((r) => !r.info.isBot).map((r) => r.info.id), ...this.bots.keys()];
  }

  /**
   * 화면에 보이고 맞을 수 있는 원격: 스냅샷을 받았고, 오래 말이 없는 사람이 아님.
   * 탭이 강제로 닫힌 사람은 전송 계층이 10초 넘게 지나서야 떠났다고 알리는데, 그동안 멈춘 유령으로 서서
   * 명중 표시만 뜨고 쓰러지지 않는 일을 막는다(다시 말하면 곧바로 돌아온다).
   */
  private shown(r: RemoteActor): boolean {
    return r.hasData && !this.session.isSilent(r.info.id);
  }

  private checkJumpPads(body: PlayerBody, dt: number, isLocal: boolean): void {
    if (isLocal) this.padCooldown = Math.max(0, this.padCooldown - dt);
    if (isLocal && this.padCooldown > 0) return;
    for (const pad of this.map.jumpPads) {
      const dx = pad.pos.x - body.position.x;
      const dz = pad.pos.z - body.position.z;
      if (dx * dx + dz * dz <= pad.radius * pad.radius && Math.abs(body.position.y - pad.pos.y) < 0.6 && body.velocity.y <= 0.5) {
        const v = solvePadLaunch(pad, body.position, PLAYER.gravity);
        body.velocity.x = 0;
        body.velocity.z = 0;
        body.launch(v.vy, _v2.set(v.vx, 0, v.vz), true);
        if (isLocal) this.padCooldown = JUMPPAD.cooldown;
        this.sfx.play('jumppad', { pos: pad.pos });
        this.fx.sprinkle(pad.pos, 8);
        return;
      }
    }
  }

  private fireLocal(req: FireRequest): void {
    this.vit.breakShield();
    const self = this.session.selfId;
    // 봇 "듣기"(호스트)
    if (this.matchHost) this.botDirector.noteFire(self);
    this.ctx.camera.updateMatrixWorld();
    const eye = this.body.eyePosition(_v2);
    this.body.aimDirection(_aim);
    // 총구에서 나가되, 조준점(화면 중앙이 가리키는 곳)으로 모이게
    const hit = this.map.collision.raycast(eye, _aim, 80);
    const aimPoint = hit ? hit.point : _v.copy(eye).addScaledVector(_aim, 80);
    this.viewmodel.muzzleWorld(_origin);
    if (_origin.lengthSq() === 0 || _origin.distanceTo(eye) > 1.2) _origin.copy(eye).addScaledVector(_aim, 0.4);
    // 총구가 벽 속이면 눈 위치에서 발사
    if (!this.map.collision.lineOfSight(eye, _origin)) _origin.copy(eye);
    const dir = _v.subVectors(aimPoint, _origin);
    if (dir.dot(_aim) <= 0 || dir.lengthSq() < 0.25) dir.copy(_aim);
    dir.normalize();
    this.waterColor(self, _color);
    const team = this.teamOf(self);
    if (req.kind === 'balloon') {
      _origin.copy(eye).addScaledVector(_aim, 0.5);
      this.projectiles.throwBalloon(self, team, _origin, _aim, this.body.velocity, true, _color);
      this.pendingShots.push(this.shot(self, 'balloon', req, _origin, _aim, this.body.velocity));
      this.sfx.play('throw');
      return;
    }
    this.projectiles.fireGun(self, team, req.kind, _origin, dir, req.seed, req.spread, true, _color);
    this.pendingShots.push(this.shot(self, req.kind, req, _origin, dir, null));
    const def = WEAPONS[req.kind];
    this.sfx.play(req.kind, { volume: 0.8 });
    this.viewmodel.kick(THREE.MathUtils.degToRad(def.recoilDeg));
    this.recoil += THREE.MathUtils.degToRad(def.recoilDeg);
  }

  private shot(shooter: PeerId, kind: NetShot['kind'], req: FireRequest, origin: THREE.Vector3, dir: THREE.Vector3, inherit: THREE.Vector3 | null): NetShot {
    return {
      shooter, kind, t: performance.now(), seed: req.seed, spread: req.spread,
      origin: [origin.x, origin.y, origin.z], dir: [dir.x, dir.y, dir.z],
      inherit: inherit ? [inherit.x, inherit.y, inherit.z] : [0, 0, 0],
    };
  }

  private updateBots(dt: number, playing: boolean): void {
    // 인지 목록(재사용 객체): 나, 보이는 원격, 봇. 봇은 지금 노리는 대상도 넘겨 대상 나눠 갖기에 쓴다
    const dir = this.botDirector;
    dir.begin(this.map, this.time);
    const self = this.session.selfId;
    dir.see(self, this.teamOf(self), this.body.position, this.body.velocity, this.vit.alive, this.vit.shielded, this.vit.soak, false);
    for (const r of this.remotes.values()) {
      if (this.shown(r)) dir.see(r.info.id, this.teamOf(r.info.id), r.pos, r.vel, r.alive, r.shielded, r.soak * PLAYER.maxSoak, r.info.isBot);
    }
    for (const b of this.bots.values()) {
      dir.see(b.info.id, this.teamOf(b.info.id), b.body.position, b.body.velocity, b.vitality.alive, b.vitality.shielded, b.vitality.soak, true, b.brain.targetId);
    }
    // 봐주기 규칙(연속으로 젖기만 한 사람)은 점수로 판단 — 초당 2번
    if (this.matchHost && dir.scoresDue(dt)) dir.syncScores(this.matchHost.snapshot().scores);
    for (const bot of this.bots.values()) {
      if (bot.vitality.tick(dt)) this.respawnBot(bot);
      if (bot.vitality.alive) {
        const intent = bot.brain.think(dt, bot.body, bot.arsenal, dir.context(bot.info.id, bot.vitality.soak));
        const refill = this.refillRate(bot.body.position);
        bot.body.speedScale = (refill.inWater ? PLAYER.waterSpeedScale : 1) * bot.arsenal.moveScale * BOT.speedScale;
        bot.body.step(dt, intent);
        this.checkJumpPads(bot.body, dt, false);
        if (bot.body.position.y < this.map.bounds.killY) this.respawnBot(bot);
        const reqs = bot.arsenal.tick(dt, intent, refill.rate, playing, this.movementState(bot.body));
        for (const req of reqs) this.fireBot(bot, req);
      }
      bot.avatar.update(dt, {
        pos: bot.body.position, vel: bot.body.velocity, yaw: bot.body.yaw, pitch: bot.body.pitch, grounded: bot.body.grounded,
        soak: bot.vitality.soak / PLAYER.maxSoak, alive: bot.vitality.alive, shielded: bot.vitality.shielded, weapon: bot.arsenal.current,
      });
    }
  }

  private fireBot(bot: BotActor, req: FireRequest): void {
    bot.vitality.breakShield();
    const id = bot.info.id;
    this.botDirector.noteFire(id);
    bot.body.eyePosition(_v2);
    bot.body.aimDirection(_aim);
    bot.avatar.muzzleWorld(_origin);
    if (!this.map.collision.lineOfSight(_v2, _origin)) _origin.copy(_v2);
    this.waterColor(id, _color);
    const team = this.teamOf(id);
    if (req.kind === 'balloon') {
      _origin.copy(_v2).addScaledVector(_aim, 0.5);
      this.projectiles.throwBalloon(id, team, _origin, _aim, bot.body.velocity, true, _color);
      this.pendingShots.push(this.shot(id, 'balloon', req, _origin, _aim, bot.body.velocity));
      this.sfx.play('throw', { pos: _origin });
      return;
    }
    // 총구에서 봇 시선 위 조준점으로 모은다(총구가 눈보다 낮고 옆이라 나란히 쏘면 빗나감)
    botShotDirection(_v2, _aim, _origin, bot.brain.aimRange, _v);
    this.projectiles.fireGun(id, team, req.kind, _origin, _v, req.seed, req.spread, true, _color);
    this.pendingShots.push(this.shot(id, req.kind, req, _origin, _v, null));
    this.sfx.play(req.kind, { pos: _origin, volume: 0.7 });
  }

  private rebuildTargets(): void {
    const t = this.targets;
    t.length = 0;
    t.push({ id: this.session.selfId, team: this.teamOf(this.session.selfId), alive: this.vit.alive, shielded: this.vit.shielded, pos: this.body.position });
    for (const r of this.remotes.values()) {
      if (this.shown(r)) t.push({ id: r.info.id, team: this.teamOf(r.info.id), alive: r.alive, shielded: r.shielded, pos: r.pos });
    }
    for (const b of this.bots.values()) {
      t.push({ id: b.info.id, team: this.teamOf(b.info.id), alive: b.vitality.alive, shielded: b.vitality.shielded, pos: b.body.position });
    }
  }

  private sendNet(now: number): void {
    const b = this.body;
    this.session.sendState({
      t: now, px: b.position.x, py: b.position.y, pz: b.position.z,
      vx: b.velocity.x, vy: b.velocity.y, vz: b.velocity.z, yaw: b.yaw, pitch: b.pitch,
      weapon: this.arsenal.current, soak: this.vit.soak / PLAYER.maxSoak, tank: this.arsenal.tank / TANK.capacity,
      alive: this.vit.alive, grounded: b.grounded, shielded: this.vit.shielded,
    });
    if (this.matchHost && this.bots.size) this.session.sendBotStates([...this.bots.values()].map((bot) => [bot.info.id, bot.snapshot(now)]));
    if (this.pendingShots.length) {
      this.session.sendShots(this.pendingShots);
      this.pendingShots = [];
    }
    if (this.pendingHits.length) {
      this.session.sendHits(this.pendingHits);
      this.pendingHits = [];
    }
  }

  private updateCamera(dt: number): void {
    const cam = this.ctx.camera;
    this.recoil = Math.max(0, this.recoil - dt * 0.12 - this.recoil * dt * 8);
    if (this.vit.alive) {
      this.body.eyePosition(cam.position);
      cam.rotation.set(this.body.pitch + this.recoil, this.body.yaw, 0, 'YXZ');
    } else {
      // 쓰러진 자리 위로 천천히 떠오르며 내려다봄
      const k = Math.min(1, this.deathT / 0.8);
      cam.position.set(this.deathPos.x, this.deathPos.y + PLAYER.eyeHeight + k * 3.5, this.deathPos.z).addScaledVector(this.body.forward(_v), -k * 2.5);
      cam.lookAt(_v2.copy(this.deathPos).setY(this.deathPos.y + 0.5));
    }
    const speed = Math.hypot(this.body.velocity.x, this.body.velocity.z);
    this.viewmodel.setTank(this.arsenal.tank / TANK.capacity);
    this.viewmodel.reduceMotion = this.opts.profile.settings.reduceMotion;
    this.viewmodel.update(dt, speed, this.body.grounded, this.vit.alive);
    this.ctx.followShadow(this.body.position);
    this.sfx.setListener(cam.position, this.body.yaw);
    // 많이 젖으면(쓰러진 동안 포함) 소리가 물속처럼 먹먹해진다
    this.sfx.setSoak(this.vit.alive ? this.vit.soak / PLAYER.maxSoak : 1);
  }

  private scoreRows(): ScoreRow[] {
    const state = this.matchHost?.snapshot() ?? this.matchView.state;
    const scores = state?.scores ?? {};
    const hostId = this.session.hostId;
    const rows: ScoreRow[] = [];
    const add = (info: PlayerInfo, isSelf: boolean) => {
      const line = scores[info.id];
      rows.push({
        id: info.id, name: info.name, color: this.colorOf(info.id), team: this.teamOf(info.id),
        splashes: line?.splashes ?? 0, soaked: line?.soaked ?? 0, isSelf, isBot: info.isBot,
        isHost: info.id === hostId, ping: isSelf ? 0 : this.pings.get(info.id) ?? null,
      });
    };
    add(this.session.self, true);
    for (const r of this.remotes.values()) add(r.info, false);
    for (const b of this.bots.values()) add(b.info, false);
    return rows;
  }

  private updateHud(dt: number, refilling: boolean, now: number): void {
    const state = this.matchHost?.snapshot() ?? this.matchView.state;
    const self = this.session.selfId;
    const mode = this.mode();
    const scores = state?.scores ?? {};
    const myLine = scores[self];
    const leader = Math.max(0, ...Object.values(scores).map((l) => l.splashes));
    const timerMs = this.matchHost ? this.matchHost.snapshot().remainingMs : this.matchView.remainingMs(now);
    this.hud.update({
      soak: this.vit.soak / PLAYER.maxSoak,
      tank: this.arsenal.tank / TANK.capacity,
      weapon: this.arsenal.current,
      balloonReady: this.arsenal.balloonReady,
      alive: this.vit.alive,
      respawnIn: this.vit.alive ? null : Math.max(0, this.vit.respawnIn),
      soakedBy: this.vit.lastAttacker && this.vit.lastAttacker !== self ? this.nameOf(this.vit.lastAttacker) : null,
      shielded: this.vit.shielded,
      refilling,
      lowWater: this.arsenal.lowWater,
      timerMs,
      phase: state?.phase ?? null,
      mode,
      myScore: myLine?.splashes ?? 0,
      leaderScore: leader,
      teamScores: state?.teamScores ?? [0, 0],
      myTeam: this.teamOf(self),
      roomLabel: this.opts.roomLabel,
      playerCount: this.humanCount() + this.bots.size + [...this.remotes.values()].filter((r) => r.info.isBot).length,
      moveState: this.movementState(this.body),
    }, dt);
    const rows = this.scoreRows();
    const inResults = state?.phase === 'results';
    this.hud.setScoreboard(!inResults && this.input.isDown('Tab'), rows, mode);
    if (inResults && state) {
      let title = '경기 종료!';
      if (state.winner === 'team0' || state.winner === 'team1') title = `${state.winner === 'team0' ? '탠저린' : '그레이프'} 팀 승리! 🎉`;
      else if (state.winner === 'draw') title = '무승부!';
      else if (state.winner) title = `${this.nameOf(state.winner)} 우승! 🏆`;
      this.hud.showResults(true, title, rows, mode, timerMs / 1000);
    } else {
      this.hud.showResults(false, '', rows, mode, 0);
    }
  }


  // ================================================================ debug

  private installDebug(): void {
    const enabled = import.meta.env.DEV || new URLSearchParams(location.search).has('debug');
    if (!enabled) return;
    const api: DebugApi = {
      state: () => ({
        selfId: this.session.selfId,
        hostId: this.session.hostId,
        isHost: this.session.isHost,
        peers: this.session.transport.peers(),
        pos: this.body.position.toArray(),
        alive: this.vit.alive,
        soak: this.vit.soak,
        shielded: this.vit.shielded,
        tank: this.arsenal.tank,
        weapon: this.arsenal.current,
        remotes: [...this.remotes.values()].map((r) => ({ id: r.info.id, name: r.info.name, bot: r.info.isBot, hasData: r.hasData, visible: this.shown(r), pos: r.pos.toArray(), alive: r.alive, soak: r.soak, shielded: r.shielded })),
        bots: [...this.bots.values()].map((b) => ({ id: b.info.id, name: b.info.name, pos: b.body.position.toArray(), alive: b.vitality.alive, soak: b.vitality.soak })),
        match: this.matchHost?.snapshot() ?? this.matchView.state,
        /** 지금 기준 남은 경기 시간(비호스트는 받은 시각부터 흐른 시간을 뺀 값) */
        timerMs: this.matchHost ? this.matchHost.snapshot().remainingMs : this.matchView.remainingMs(performance.now()),
        droplets: this.projectiles.activeCount,
      }),
      setIntent: (i) => (this.debugIntent = i),
      aimAt: (id) => {
        const target = this.targets.find((t) => t.id === id);
        if (!target) return false;
        const eye = this.body.eyePosition(_v2);
        const d = _v.copy(target.pos).setY(target.pos.y + PLAYER.height * 0.55).sub(eye);
        this.body.yaw = Math.atan2(-d.x, -d.z);
        this.body.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
        return true;
      },
      teleport: (x, y, z) => this.body.teleport(_v.set(x, y, z), this.body.yaw),
      look: (yaw, pitch) => {
        this.body.yaw = yaw;
        this.body.pitch = pitch;
      },
    };
    (window as unknown as { __splash: DebugApi }).__splash = api;
  }
}

