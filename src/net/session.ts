import { Emitter } from '../core/events';
import { NET } from '../config';
import type { MatchState, PeerId, PlayerInfo, PlayerSnapshot } from '../types';
import { ClockOffset } from './interp';
import {
  MSG, decodeBotStates, decodeHello, decodeHits, decodeInfos, decodeMatch, decodeShots, decodeSnapshot, decodeSplash,
  encodeBotStates, encodeHits, encodeInfo, encodeMatch, encodeShots, encodeSnapshot, encodeSplash,
  type MsgType, type NetHit, type NetShot, type NetSplash,
} from './protocol';
import type { Transport } from './transport';

export interface SessionEvents {
  /** 사람 플레이어가 새로 보이거나 정보가 바뀜 */
  playerInfo: (info: PlayerInfo) => void;
  playerLeft: (id: PeerId) => void;
  /** 호스트가 알려 준 봇 목록(전체 교체) */
  botInfos: (infos: PlayerInfo[]) => void;
  snapshot: (id: PeerId, snap: PlayerSnapshot, localT: number) => void;
  shots: (shots: NetShot[], from: PeerId) => void;
  hits: (hits: NetHit[], from: PeerId) => void;
  splash: (ev: NetSplash, from: PeerId) => void;
  match: (m: MatchState, from: PeerId, localT: number) => void;
  hostChanged: (hostId: PeerId, isSelf: boolean) => void;
  error: (message: string) => void;
}

/**
 * 방 세션: 참가자 정보, 호스트 선출, 메시지 인코딩/디코딩, 피어별 시계 보정.
 *
 * 권한 모델(P2P, 서버 없음):
 * - 각 사람은 자기 이동·젖음·쓰러짐의 권한자다(쏜 사람 쪽 명중 판정).
 * - 호스트(가장 먼저 들어온 사람)는 경기 시간·점수·봇을 맡는다. 호스트가 나가면 다음 사람이 이어받는다.
 *
 * 수신 규칙:
 * - hello 를 보내지 않은(아직 모르는) 피어의 다른 메시지는 버린다.
 * - 전송 계층이 떠났다고 알린 피어의 늦은 메시지(hello 포함)는 버린다.
 * - 봇 관련(bots·binfo·봇 명의 발사·명중·쓰러짐)과 경기 상태는 현재 호스트만 보낼 수 있고,
 *   봇 id 는 사람 id 와 겹칠 수 없다.
 *
 * 호스트 장애: 전송 계층은 탭이 강제로 닫힌 경우 연결 끊김을 10초 넘게 늦게 알린다. 그래서 NET.hostSilenceMs 동안
 * 아무 말이 없는 사람은 호스트 후보에서 잠시 빼고(모두 같은 규칙) 다음 사람을 뽑는다. 다시 말하면 후보로 되돌린다.
 */
export class Session extends Emitter<SessionEvents> {
  readonly selfId: PeerId;
  private readonly infos = new Map<PeerId, PlayerInfo>();
  private readonly clocks = new Map<PeerId, ClockOffset>();
  /** 전송 계층에 연결된 피어(hello 전 포함) */
  private readonly live = new Set<PeerId>();
  /** 피어별 마지막 수신 시각(performance.now) */
  private readonly lastHeard = new Map<PeerId, number>();
  /** 오래 말이 없어 호스트 후보에서 뺀 피어 */
  private readonly silent = new Set<PeerId>();
  private nextSilenceCheck = 0;
  private lastUpdate = -1;
  private _hostId: PeerId;
  private closed = false;

  constructor(readonly transport: Transport, private selfInfo: PlayerInfo) {
    super();
    this.selfId = transport.selfId;
    this.selfInfo = { ...selfInfo, id: this.selfId };
    this.infos.set(this.selfId, this.selfInfo);
    this._hostId = this.selfId;
    const now = performance.now();
    for (const id of transport.peers()) {
      this.live.add(id);
      this.lastHeard.set(id, now);
    }

    transport.onPeerJoin = (id) => {
      this.live.add(id);
      this.lastHeard.set(id, performance.now());
      this.sendHello(id);
    };
    transport.onPeerLeave = (id) => {
      this.live.delete(id);
      this.lastHeard.delete(id);
      this.silent.delete(id);
      this.clocks.delete(id);
      if (this.infos.delete(id)) this.emit('playerLeft', id);
      this.electHost();
    };
    transport.onError = (msg) => this.emit('error', msg);
    transport.onMessage = (type, data, from) => {
      if (this.closed) return;
      try {
        this.handle(type, data, from);
      } catch (err) {
        // 잘못된 메시지 하나가 게임 루프를 죽이지 않도록 격리
        console.warn(`[net] ${type} from ${from} 처리 실패`, err);
      }
    };
    // 방 탐색 중(세션 생성 전)에 연결된 피어는 onPeerJoin 이 이미 지나갔고, 그들이 보낸 hello 도 받을 곳이 없어 사라졌다.
    // 지금 모두에게 hello 를 보내면 처음 보는 쪽이 hello 로 답한다.
    this.sendHello();
  }

  get hostId(): PeerId {
    return this._hostId;
  }

  get isHost(): boolean {
    return this._hostId === this.selfId;
  }

  get online(): boolean {
    return this.transport.online;
  }

  get self(): PlayerInfo {
    return this.selfInfo;
  }

  players(): PlayerInfo[] {
    return [...this.infos.values()];
  }

  info(id: PeerId): PlayerInfo | undefined {
    return this.infos.get(id);
  }

  /**
   * NET.hostSilenceMs 넘게 아무 말이 없는 사람인지. 탭이 강제로 닫히면 전송 계층이 떠남을 10초 넘게 늦게 알리므로,
   * 게임은 그동안 이 사람을 보이지 않게·맞지 않게 둔다(멈춘 유령에게 명중 표시가 뜨지 않도록). 다시 말하면 false.
   */
  isSilent(id: PeerId): boolean {
    return this.silent.has(id);
  }

  peerCount(): number {
    return this.transport.peers().length;
  }

  clock(id: PeerId): ClockOffset {
    let c = this.clocks.get(id);
    if (!c) this.clocks.set(id, (c = new ClockOffset()));
    return c;
  }

  updateSelf(patch: Partial<Pick<PlayerInfo, 'name' | 'cosmetics'>>): void {
    this.selfInfo = { ...this.selfInfo, ...patch };
    this.infos.set(this.selfId, this.selfInfo);
    this.sendHello();
  }

  // ---------------------------------------------------------------- send

  sendHello(target?: PeerId): void {
    this.transport.send(MSG.hello, { v: NET.protocol, info: encodeInfo(this.selfInfo) }, target);
  }

  sendState(s: PlayerSnapshot): void {
    this.transport.send(MSG.state, encodeSnapshot(s));
  }

  sendBotStates(list: Array<[PeerId, PlayerSnapshot]>): void {
    if (list.length) this.transport.send(MSG.bots, encodeBotStates(list));
  }

  sendBotInfos(infos: PlayerInfo[], target?: PeerId): void {
    this.transport.send(MSG.botInfo, infos.map(encodeInfo), target);
  }

  sendShots(shots: NetShot[]): void {
    if (shots.length) this.transport.send(MSG.fire, encodeShots(shots));
  }

  sendHits(hits: NetHit[]): void {
    if (hits.length) this.transport.send(MSG.hit, encodeHits(hits));
  }

  sendSplash(ev: NetSplash): void {
    this.transport.send(MSG.splash, encodeSplash(ev));
  }

  sendMatch(m: MatchState, target?: PeerId): void {
    this.transport.send(MSG.match, encodeMatch(m), target);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clear();
    await this.transport.leave();
  }

  /**
   * 매 프레임 호출. 오래 말이 없는 사람(특히 호스트)을 호스트 후보에서 빼고 다시 뽑는다.
   * @param now performance.now()
   */
  update(now: number): void {
    if (this.closed) return;
    // 내 쪽 루프가 멈췄다 깨어났으면(탭 얼림 등) 그동안 못 들은 것은 상대 탓이 아니다
    if (this.lastUpdate >= 0 && now - this.lastUpdate > 1500) {
      for (const id of this.lastHeard.keys()) this.lastHeard.set(id, now);
    }
    this.lastUpdate = now;
    if (now < this.nextSilenceCheck) return;
    this.nextSilenceCheck = now + 250;
    let changed = false;
    for (const id of this.infos.keys()) {
      if (id === this.selfId || this.silent.has(id)) continue;
      if (now - (this.lastHeard.get(id) ?? now) > NET.hostSilenceMs) {
        this.silent.add(id);
        changed = true;
        if (id === this._hostId) console.warn(`[net] 호스트 ${id} 가 ${NET.hostSilenceMs}ms 동안 응답 없음 — 호스트를 다시 뽑아요`);
      }
    }
    if (changed) this.electHost();
  }

  // ---------------------------------------------------------------- receive

  /** from 이 호스트일 때, id 가 호스트가 대신 말할 수 있는 봇인지(사람 id 는 사칭 불가) */
  private isHostBot(from: PeerId, id: PeerId): boolean {
    return from === this._hostId && !this.infos.has(id);
  }

  private handle(type: MsgType, data: unknown, from: PeerId): void {
    // 이미 떠난 피어의 늦은 메시지
    if (!this.live.has(from) || from === this.selfId) return;
    this.lastHeard.set(from, performance.now());
    // 말이 없어 후보에서 뺐던 사람이 돌아옴
    if (this.silent.delete(from)) this.electHost();
    if (type === MSG.hello) {
      this.handleHello(data, from);
      return;
    }
    // hello 전의 메시지는 누구인지(호스트 선출·권한 판단) 모르므로 버린다
    if (!this.infos.has(from)) return;
    const now = performance.now();
    switch (type) {
      case MSG.state: {
        const snap = decodeSnapshot(data);
        if (!snap) return;
        const clock = this.clock(from);
        clock.sample(snap.t, now);
        this.emit('snapshot', from, snap, clock.toLocal(snap.t));
        return;
      }
      case MSG.bots: {
        if (from !== this._hostId) return;
        const clock = this.clock(from);
        for (const [id, snap] of decodeBotStates(data)) {
          if (!this.isHostBot(from, id)) continue;
          clock.sample(snap.t, now);
          this.emit('snapshot', id, snap, clock.toLocal(snap.t));
        }
        return;
      }
      case MSG.botInfo: {
        if (from !== this._hostId) return;
        const bots = decodeInfos(data).filter((i) => this.isHostBot(from, i.id)).map((i) => ({ ...i, isBot: true }));
        this.emit('botInfos', bots);
        return;
      }
      case MSG.fire: {
        // 사람은 자기 발사만, 호스트는 봇 발사도 보낼 수 있다
        const shots = decodeShots(data).filter((s) => s.shooter === from || this.isHostBot(from, s.shooter));
        if (shots.length) this.emit('shots', shots, from);
        return;
      }
      case MSG.hit: {
        const hits = decodeHits(data).filter((h) => h.shooter === from || this.isHostBot(from, h.shooter));
        if (hits.length) this.emit('hits', hits, from);
        return;
      }
      case MSG.splash: {
        const ev = decodeSplash(data);
        // 쓰러짐은 피해자 권한자(본인, 봇이면 호스트)만 알릴 수 있다
        if (ev && (ev.victim === from || this.isHostBot(from, ev.victim))) this.emit('splash', ev, from);
        return;
      }
      case MSG.match: {
        if (from !== this._hostId) return;
        const m = decodeMatch(data);
        // hostId 는 보낸 사람으로 고정(다른 사람 명의 사칭 방지)
        if (m) this.emit('match', { ...m, hostId: from }, from, now);
        return;
      }
    }
  }

  private handleHello(data: unknown, from: PeerId): void {
    const hello = decodeHello(data);
    if (!hello || hello.v !== NET.protocol || hello.info.isBot) return;
    // 보낸 사람 id 는 전송 계층이 보증하는 값을 쓴다(사칭 방지)
    const info: PlayerInfo = { ...hello.info, id: from };
    const prev = this.infos.get(from);
    const isNew = !prev;
    // 답장 hello 등 내용이 같은 hello 는 무시(게임 쪽 아바타 갱신·경기 상태 재전송 낭비 방지)
    if (prev && prev.name === info.name && prev.joinedAt === info.joinedAt
      && prev.cosmetics.color === info.cosmetics.color && prev.cosmetics.hat === info.cosmetics.hat) return;
    this.infos.set(from, info);
    // 순서가 중요하다: 처음 보는 피어에게는 내 hello 를 먼저 보낸다. 이어서 playerInfo 처리(호스트면 경기 상태·봇 목록 전송)가
    // 보내는 메시지가 hello 보다 먼저 도착하면, 받는 쪽은 아직 나를 모르므로(호스트로 인정 못 함) 버린다.
    if (isNew) this.sendHello(from);
    this.electHost();
    this.emit('playerInfo', info);
  }

  /**
   * 호스트 = (joinedAt, id) 가 가장 작은 사람(오래 말이 없는 사람 제외). 모든 피어가 같은 정보로 같은 결론을 낸다.
   * joinedAt 은 각자의 벽시계라서 시계가 크게 틀린 사람이 새로 들어오면 호스트를 가져갈 수 있다(알려진 한계).
   */
  private electHost(): void {
    let best: PlayerInfo | null = null;
    for (const info of this.infos.values()) {
      if (info.isBot || this.silent.has(info.id)) continue;
      if (!best || info.joinedAt < best.joinedAt || (info.joinedAt === best.joinedAt && info.id < best.id)) best = info;
    }
    const next = best?.id ?? this.selfId;
    if (next !== this._hostId) {
      this._hostId = next;
      this.emit('hostChanged', next, next === this.selfId);
    }
  }
}
