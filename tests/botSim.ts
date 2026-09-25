import * as THREE from 'three';
import { BALLOON, BOT, PLAYER } from '../src/config';
import { mulberry32 } from '../src/core/rng';
import { Vitality } from '../src/game/actors';
import { BotBrain, BotDirector, BotNav, botShotDirection, refillRateAt, type BotSkill } from '../src/game/bots';
import { PlayerBody } from '../src/game/playerBody';
import { ProjectileSystem, type HitTarget } from '../src/game/projectiles';
import { pickSpawn, type SpawnThreat } from '../src/game/spawns';
import { Arsenal, type FireRequest } from '../src/game/weapons';
import type { DamageSource, PeerId, ScoreLine, WeaponId } from '../src/types';
import { isInWater, solvePadLaunch, type GameMap, type SpawnPoint } from '../src/world/map';

/**
 * 봇 헤드리스 시뮬레이션(WebGL 없음). Game.update/updateBots 와 같은 순서로
 * PlayerBody + Arsenal + Vitality + BotBrain + BotDirector + ProjectileSystem 을 고정 간격(기본 60Hz)으로 돌리고 통계를 모은다.
 * 점프대 발사·물풍선 넉백·보충 속도·부활 지점 고르기도 Game 과 같은 규칙을 쓴다(총구 위치만 아바타 대신 근사).
 *
 * "사람" 참가자는 실력을 낮춘 BotBrain 으로 흉내 낸다(isBot=false 로 등록 — 봇이 사람으로 보고 봐주기 규칙도 적용).
 * 캐주얼 플레이어의 대역일 뿐 실제 사람의 판단·조작은 아니다.
 */

export interface SimOptions {
  seed: number;
  /** 봇 수 */
  bots: number;
  seconds: number;
  hz?: number;
  /** 있으면 이 실력의 "사람" 대역을 한 명 추가(id 'human') */
  human?: Partial<BotSkill>;
  /** 봇 i 의 기본 무기 고정(없거나 짧으면 비율대로 뽑음) */
  loadouts?: readonly WeaponId[];
  /** 사람 대역의 기본 무기 고정 */
  humanLoadout?: WeaponId;
}

export interface AgentStats {
  id: PeerId;
  human: boolean;
  preferred: WeaponId;
  splashes: number;
  soaked: number;
  /** 한 번이라도 1.2 m 안에 들어간 웨이포인트(wp_) 수 */
  waypointsVisited: number;
  /** 움직이려는데 제자리인 연속 시간 최댓값(초) */
  maxStuck: number;
  /** 보충 구역에 들어가 탱크를 채운 횟수(들어갈 때 탱크 < 50) */
  refills: number;
  /** 전망대(데크) 도착 횟수: [x<0 탑, x>0 탑]. 그중 점프대로 올라간 횟수 */
  towerArrivals: [number, number];
  padLaunches: number;
  /** 총 발사 수(양동이 한 번 = 1)·명중 물방울 수 */
  shots: number;
  dropletHits: number;
  balloons: number;
  /** 물풍선 사이 최소 간격(초, 한 번 이하면 Infinity)·던질 때(비용 빼기 전) 탱크 최솟값 */
  minBalloonGap: number;
  minBalloonTank: number;
  /** 시선 회전 속도 최댓값(도/초, 부활 순간 제외) */
  maxYawRate: number;
  /** BotBrain.stats */
  retreats: number;
  stuckRecoveries: number;
}

export interface WeaponStats {
  shots: number;
  hits: number;
  splashes: number;
  avgHitDist: number;
  avgSplashDist: number;
}

export interface SimResult {
  seconds: number;
  agents: AgentStats[];
  splashes: number;
  splashesPerMin: number;
  /** 부활 → 쓰러짐 평균(초) */
  avgLife: number;
  /** 그 목숨에서 처음 맞은 때 → 쓰러짐 평균(초) */
  avgFight: number;
  /** 부활한 뒤 3초 안에 맞은 목숨 비율(부활 지점이 적 시야에 노출되는지) */
  spawnHitShare: number;
  /** 적심 원천별: 쏜 횟수, 명중 물방울 수, 쓰러뜨림, 명중·쓰러뜨림 때 거리 평균 */
  weapons: Record<DamageSource, WeaponStats>;
  /** 교전 중 들고 있던 무기 시간 비율(봇) */
  engagedWeaponShare: Record<WeaponId, number>;
  /** 봇 한 명 think() 평균·p99·최대(µs) */
  thinkAvgUs: number;
  thinkP99Us: number;
  thinkMaxUs: number;
  /** 봇 모드 비율(살아 있는 시간 기준) */
  modeShare: Record<string, number>;
  /** 사람 대역이 있을 때 */
  human?: {
    /** 봇 3명 이상이 동시에 노린 시간 비율, 최대 동시 수, 부활 3초 안 최대 동시 수, 부활 5초 안에 쓰러진 횟수 */
    dogpile3Share: number;
    maxClaims: number;
    spawnMaxClaims: number;
    spawnDeaths: number;
    /** 봇 교전 시간 중 사람을 노린 비율(공평한 몫 = 1 / 봇이 볼 수 있는 적 수) */
    attentionShare: number;
    /** 봐주기 규칙이 켜져 있던 시간(초) */
    mercyTime: number;
    /** 순위(쓰러뜨림 기준, 1 = 1등, 동점은 사람에게 유리하게) */
    rank: number;
  };
}

interface Agent {
  id: PeerId;
  human: boolean;
  body: PlayerBody;
  arsenal: Arsenal;
  vit: Vitality;
  brain: BotBrain;
  target: HitTarget;
  lastSpawn: SpawnPoint | null;
  lifeStart: number;
  firstHitAt: number;
  visited: Uint8Array;
  justSpawned: boolean;
  prevYaw: number;
  maxYawRate: number;
  // 끼임 측정
  sampleT: number;
  samplePos: THREE.Vector3;
  wantFrames: number;
  frames: number;
  stuckRun: number;
  maxStuck: number;
  // 보충·전망대
  inRefill: boolean;
  refills: number;
  onTower: number;
  towerArrivals: [number, number];
  padLaunches: number;
  shots: number;
  dropletHits: number;
  balloons: number;
  lastBalloonAt: number;
  minBalloonGap: number;
  minBalloonTank: number;
}

/** 총구 근사(발 기준, 캐릭터 로컬): 오른쪽·높이·앞 — 아바타 GunAnchor(0.35, 0.8, 0.25) + 총 길이 */
const MUZZLE_RIGHT = 0.35;
const MUZZLE_UP = 0.95;
const MUZZLE_FWD = 0.55;
/** 끼임 측정 간격(초)·최소 이동(m)·"움직이려 함" 프레임 비율 */
const STUCK_SAMPLE = 0.5;
const STUCK_MOVE = 0.4;
const STUCK_WANT = 0.8;
/** 웨이포인트 방문 판정 반경(m) */
const VISIT_RADIUS = 1.2;
const HUMAN_ID = 'human';

const _eye = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _v = new THREE.Vector3();
const _color = new THREE.Color('#bff3ff');

export function runBotSim(map: GameMap, opts: SimOptions): SimResult {
  // Arsenal 의 발사 시드 생성기 등 Math.random 을 쓰는 곳까지 재현 가능하게
  const realRandom = Math.random;
  Math.random = mulberry32(opts.seed ^ 0x9e3779b9);
  try {
    return simulate(map, opts);
  } finally {
    Math.random = realRandom;
  }
}

function simulate(map: GameMap, opts: SimOptions): SimResult {
  const hz = opts.hz ?? 60;
  const dt = 1 / hz;
  const rnd = mulberry32(opts.seed);
  const nav = BotNav.for(map);
  const director = new BotDirector();
  const agents: Agent[] = [];
  const byId = new Map<PeerId, Agent>();
  const scores: Record<PeerId, ScoreLine> = {};
  const targets: HitTarget[] = [];
  let time = 0;

  const wpNodes: number[] = [];
  for (let i = 0; i < nav.count; i++) if (nav.ids[i].startsWith('wp_')) wpNodes.push(i);

  const sources: DamageSource[] = ['pistol', 'soaker', 'bucket', 'balloon'];
  const weapons = {} as Record<DamageSource, WeaponStats>;
  const hitDist = {} as Record<DamageSource, number>;
  const splashDist = {} as Record<DamageSource, number>;
  for (const k of sources) {
    weapons[k] = { shots: 0, hits: 0, splashes: 0, avgHitDist: 0, avgSplashDist: 0 };
    hitDist[k] = 0;
    splashDist[k] = 0;
  }
  const engagedTime: Record<WeaponId, number> = { pistol: 0, soaker: 0, bucket: 0 };
  const modeTime: Record<string, number> = {};
  let splashes = 0;
  let lifeSum = 0;
  let fightSum = 0;
  let humanSpawnDeaths = 0;
  let lives = 0;
  let spawnHits = 0;

  const makeAgent = (id: PeerId, human: boolean, skill: Partial<BotSkill>, loadout?: WeaponId): Agent => {
    const body = new PlayerBody(map.collision);
    const a: Agent = {
      id, human, body, arsenal: new Arsenal(), vit: new Vitality(),
      brain: new BotBrain((rnd() * 0xffffffff) >>> 0, () => -1, skill, loadout),
      target: { id, team: -1, alive: true, shielded: false, pos: body.position },
      lastSpawn: null, lifeStart: 0, firstHitAt: -1, visited: new Uint8Array(nav.count),
      justSpawned: true, prevYaw: 0, maxYawRate: 0,
      sampleT: 0, samplePos: new THREE.Vector3(), wantFrames: 0, frames: 0, stuckRun: 0, maxStuck: 0,
      inRefill: false, refills: 0, onTower: -1, towerArrivals: [0, 0], padLaunches: 0, shots: 0, dropletHits: 0, balloons: 0,
      lastBalloonAt: -Infinity, minBalloonGap: Infinity, minBalloonTank: Infinity,
    };
    agents.push(a);
    byId.set(id, a);
    targets.push(a.target);
    scores[id] = { splashes: 0, soaked: 0, team: -1 };
    return a;
  };

  const respawn = (a: Agent) => {
    const threats: SpawnThreat[] = [];
    for (const o of agents) if (o !== a) threats.push({ pos: o.body.position, team: -1, alive: o.vit.alive });
    const sp = pickSpawn(map, -1, threats, a.lastSpawn, rnd);
    a.lastSpawn = sp;
    a.body.teleport(sp.pos, sp.yaw);
    a.vit.spawn();
    a.arsenal.reset();
    a.brain.reset();
    a.lifeStart = time;
    a.firstHitAt = -1;
    lives++;
    a.samplePos.copy(sp.pos);
    a.sampleT = 0;
    a.wantFrames = 0;
    a.frames = 0;
    a.stuckRun = 0;
    a.onTower = -1;
    a.inRefill = false;
    a.justSpawned = true;
  };

  const projectiles = new ProjectileSystem(map.collision, {
    targets: () => targets,
    onHit: (shooter, victim, amount, source) => {
      const v = byId.get(victim);
      const s = byId.get(shooter);
      if (!v || !v.vit.alive) return;
      // Game.applyBotHit 과 같이 맞힌 사람을 알려 준다
      v.brain.lastAttacker = shooter;
      if (v.firstHitAt < 0) {
        v.firstHitAt = time;
        if (time - v.lifeStart < 3) spawnHits++;
      }
      const d = s ? s.body.position.distanceTo(v.body.position) : 0;
      weapons[source].hits++;
      hitDist[source] += d;
      if (s) s.dropletHits++;
      if (v.vit.applyHit(amount, shooter, source)) {
        splashes++;
        weapons[source].splashes++;
        splashDist[source] += d;
        lifeSum += time - v.lifeStart;
        fightSum += time - v.firstHitAt;
        scores[victim].soaked++;
        if (shooter !== victim && scores[shooter]) scores[shooter].splashes++;
        if (v.human && time - v.lifeStart < 5) humanSpawnDeaths++;
      }
    },
    onImpact: () => undefined,
    onBodySplash: () => undefined,
    onBurst: (point) => {
      // Game.onBurst 와 같은 넉백
      for (const a of agents) {
        if (!a.vit.alive) continue;
        _v.copy(a.body.position).setY(a.body.position.y + PLAYER.height * 0.5).sub(point);
        const d = _v.length();
        if (d > BALLOON.blastRadius) continue;
        _v.y = 0;
        if (_v.lengthSq() < 1e-4) _v.set(0, 0, 1);
        _v.normalize().multiplyScalar(BALLOON.knockback * (1 - (d / BALLOON.blastRadius) * 0.5));
        a.body.launch(BALLOON.knockUp, _v);
      }
    },
  });

  const fire = (a: Agent, req: FireRequest) => {
    a.vit.breakShield();
    director.noteFire(a.id);
    a.body.eyePosition(_eye);
    a.body.aimDirection(_aim);
    const s = Math.sin(a.body.yaw);
    const c = Math.cos(a.body.yaw);
    _origin.copy(a.body.position);
    _origin.x += c * MUZZLE_RIGHT - s * MUZZLE_FWD;
    _origin.z += -s * MUZZLE_RIGHT - c * MUZZLE_FWD;
    _origin.y += MUZZLE_UP;
    if (!map.collision.lineOfSight(_eye, _origin)) _origin.copy(_eye);
    weapons[req.kind].shots++;
    if (req.kind === 'balloon') {
      a.balloons++;
      a.minBalloonGap = Math.min(a.minBalloonGap, time - a.lastBalloonAt);
      a.minBalloonTank = Math.min(a.minBalloonTank, a.arsenal.tank + BALLOON.cost);
      a.lastBalloonAt = time;
      _origin.copy(_eye).addScaledVector(_aim, 0.5);
      projectiles.throwBalloon(a.id, -1, _origin, _aim, a.body.velocity, true, _color);
      return;
    }
    a.shots++;
    botShotDirection(_eye, _aim, _origin, a.brain.aimRange, _dir);
    projectiles.fireGun(a.id, -1, req.kind, _origin, _dir, req.seed, req.spread, true, _color);
  };

  const checkPads = (a: Agent) => {
    const body = a.body;
    for (const pad of map.jumpPads) {
      const dx = pad.pos.x - body.position.x;
      const dz = pad.pos.z - body.position.z;
      if (dx * dx + dz * dz <= pad.radius * pad.radius && Math.abs(body.position.y - pad.pos.y) < 0.6 && body.velocity.y <= 0.5) {
        const v = solvePadLaunch(pad, body.position, PLAYER.gravity);
        body.velocity.x = 0;
        body.velocity.z = 0;
        body.launch(v.vy, _v.set(v.vx, 0, v.vz), true);
        a.padLaunches++;
        return;
      }
    }
  };

  const track = (a: Agent, rate: number) => {
    const b = a.body;
    // 방문한 웨이포인트
    for (let k = 0; k < wpNodes.length; k++) {
      const p = nav.pos[wpNodes[k]];
      const dx = p.x - b.position.x;
      const dz = p.z - b.position.z;
      if (dx * dx + dz * dz < VISIT_RADIUS * VISIT_RADIUS && Math.abs(p.y - b.position.y) < 1) a.visited[wpNodes[k]] = 1;
    }
    // 시선 회전 속도(부활 순간은 순간이동이라 뺀다)
    if (!a.justSpawned) {
      let d = Math.abs(b.yaw - a.prevYaw);
      if (d > Math.PI) d = Math.PI * 2 - d;
      a.maxYawRate = Math.max(a.maxYawRate, (d / dt) * (180 / Math.PI));
    }
    a.prevYaw = b.yaw;
    a.justSpawned = false;
    // 끼임: 움직이려는(프레임 80% 이상) 0.5초 구간에서 0.4 m 도 못 갔으면 누적
    a.frames++;
    if (a.brain.wantsMove) a.wantFrames++;
    a.sampleT += dt;
    if (a.sampleT >= STUCK_SAMPLE - 1e-9) {
      const moved = Math.hypot(b.position.x - a.samplePos.x, b.position.z - a.samplePos.z);
      if (a.wantFrames >= a.frames * STUCK_WANT && moved < STUCK_MOVE) {
        a.stuckRun += a.sampleT;
        if (a.stuckRun > a.maxStuck) a.maxStuck = a.stuckRun;
      } else {
        a.stuckRun = 0;
      }
      a.sampleT = 0;
      a.frames = 0;
      a.wantFrames = 0;
      a.samplePos.copy(b.position);
    }
    // 보충
    const refilling = rate > 0;
    if (refilling && !a.inRefill && a.arsenal.tank < 50) a.refills++;
    a.inRefill = refilling;
    // 전망대
    let tower = -1;
    if (b.grounded && b.position.y > 2.5) {
      for (const n of nav.towers) {
        if (nav.pos[n].distanceToSquared(b.position) < 36) {
          tower = nav.pos[n].x < 0 ? 0 : 1;
          break;
        }
      }
    }
    if (tower >= 0 && a.onTower !== tower) a.towerArrivals[tower]++;
    a.onTower = tower;
    // 모드·무기(봇만)
    if (!a.human) {
      const m = a.brain.mode;
      modeTime[m] = (modeTime[m] ?? 0) + dt;
      if (m === 'engage') engagedTime[a.arsenal.current] += dt;
    }
  };

  for (let i = 0; i < opts.bots; i++) makeAgent(`bot-${i}`, false, {}, opts.loadouts?.[i]);
  const human = opts.human ? makeAgent(HUMAN_ID, true, opts.human, opts.humanLoadout) : null;
  for (const a of agents) respawn(a);

  let humanDogpile = 0;
  let humanMaxClaims = 0;
  let humanSpawnMaxClaims = 0;
  let humanMercy = 0;
  let humanAlive = 0;
  let botEngageTime = 0;
  let botEngageHuman = 0;
  const thinkUs: number[] = [];
  const frames = Math.round(opts.seconds * hz);
  for (let f = 0; f < frames; f++) {
    time += dt;
    // Game.updateBots 순서: 인지 목록 → 점수(봐주기) → 봇마다 부활·판단·이동·점프대·사격
    director.begin(map, time);
    for (const a of agents) {
      director.see(a.id, -1, a.body.position, a.body.velocity, a.vit.alive, a.vit.shielded, a.vit.soak, !a.human, a.human ? null : a.brain.targetId);
    }
    if (director.scoresDue(dt)) director.syncScores(scores);

    for (const a of agents) {
      if (a.vit.tick(dt)) respawn(a);
      if (!a.vit.alive) continue;
      const ctx = director.context(a.id, a.vit.soak);
      const t0 = performance.now();
      const intent = a.brain.think(dt, a.body, a.arsenal, ctx);
      if (!a.human) thinkUs.push((performance.now() - t0) * 1000);
      _v.copy(a.body.position).setY(a.body.position.y + 0.3);
      const inWater = isInWater(map, _v);
      const rate = refillRateAt(map, a.body.position);
      a.body.speedScale = (inWater ? PLAYER.waterSpeedScale : 1) * a.arsenal.moveScale * BOT.speedScale;
      a.body.step(dt, intent);
      checkPads(a);
      if (a.body.position.y < map.bounds.killY) {
        respawn(a);
        continue;
      }
      const state = !a.body.grounded ? 'air' : Math.hypot(a.body.velocity.x, a.body.velocity.z) > 1 ? 'moving' : 'still';
      const reqs = a.arsenal.tick(dt, intent, rate, true, state);
      for (const req of reqs) fire(a, req);
      track(a, rate);
    }
    for (const a of agents) {
      a.target.alive = a.vit.alive;
      a.target.shielded = a.vit.shielded;
    }
    projectiles.update(dt);

    for (const a of agents) {
      if (a.human || !a.vit.alive || a.brain.mode !== 'engage') continue;
      botEngageTime += dt;
      if (human && a.brain.targetId === human.id) botEngageHuman += dt;
    }
    if (human && human.vit.alive) {
      let claims = 0;
      for (const a of agents) if (!a.human && a.vit.alive && a.brain.mode === 'engage' && a.brain.targetId === human.id) claims++;
      humanAlive += dt;
      if (claims >= 3) humanDogpile += dt;
      humanMaxClaims = Math.max(humanMaxClaims, claims);
      if (time - human.lifeStart < 3) humanSpawnMaxClaims = Math.max(humanSpawnMaxClaims, claims);
      if (director.mercyOn(human.id)) humanMercy += dt;
    }
  }

  for (const k of sources) {
    const w = weapons[k];
    w.avgHitDist = w.hits ? hitDist[k] / w.hits : 0;
    w.avgSplashDist = w.splashes ? splashDist[k] / w.splashes : 0;
  }
  const engagedTotal = engagedTime.pistol + engagedTime.soaker + engagedTime.bucket || 1;
  const modeTotal = Object.values(modeTime).reduce((s, x) => s + x, 0) || 1;
  const modeShare: Record<string, number> = {};
  for (const [m, x] of Object.entries(modeTime)) modeShare[m] = x / modeTotal;
  thinkUs.sort((a, b) => a - b);
  const thinkAvg = thinkUs.reduce((s, x) => s + x, 0) / Math.max(1, thinkUs.length);
  let rank = 1;
  if (human) for (const a of agents) if (a !== human && scores[a.id].splashes > scores[human.id].splashes) rank++;
  return {
    seconds: opts.seconds,
    agents: agents.map((a) => ({
      id: a.id, human: a.human, preferred: a.brain.preferred,
      splashes: scores[a.id].splashes, soaked: scores[a.id].soaked,
      waypointsVisited: wpNodes.reduce((s, n) => s + a.visited[n], 0),
      maxStuck: a.maxStuck, refills: a.refills, towerArrivals: a.towerArrivals, padLaunches: a.padLaunches,
      shots: a.shots, dropletHits: a.dropletHits, balloons: a.balloons, minBalloonGap: a.minBalloonGap, minBalloonTank: a.minBalloonTank,
      maxYawRate: a.maxYawRate, retreats: a.brain.stats.retreats, stuckRecoveries: a.brain.stats.stuckRecoveries,
    })),
    splashes,
    splashesPerMin: splashes / (opts.seconds / 60),
    avgLife: splashes ? lifeSum / splashes : 0,
    avgFight: splashes ? fightSum / splashes : 0,
    spawnHitShare: lives ? spawnHits / lives : 0,
    weapons,
    engagedWeaponShare: { pistol: engagedTime.pistol / engagedTotal, soaker: engagedTime.soaker / engagedTotal, bucket: engagedTime.bucket / engagedTotal },
    thinkAvgUs: thinkAvg,
    thinkP99Us: thinkUs.length ? thinkUs[Math.floor(thinkUs.length * 0.99)] : 0,
    thinkMaxUs: thinkUs.length ? thinkUs[thinkUs.length - 1] : 0,
    modeShare,
    human: human ? {
      dogpile3Share: humanAlive ? humanDogpile / humanAlive : 0,
      maxClaims: humanMaxClaims,
      spawnMaxClaims: humanSpawnMaxClaims,
      spawnDeaths: humanSpawnDeaths,
      attentionShare: botEngageTime ? botEngageHuman / botEngageTime : 0,
      mercyTime: humanMercy,
      rank,
    } : undefined,
  };
}

/** 사람이 읽는 요약(보고용) */
export function formatSim(label: string, r: SimResult): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const perMin = (n: number) => (n / (r.seconds / 60)).toFixed(1);
  const w = r.weapons;
  const lines = [
    `[${label}] ${r.seconds}s  splashes ${r.splashes} (${r.splashesPerMin.toFixed(1)}/min)  avgLife ${r.avgLife.toFixed(1)}s  avgFight ${r.avgFight.toFixed(2)}s  hit<3s after spawn ${pct(r.spawnHitShare)}`
      + `  think avg ${r.thinkAvgUs.toFixed(1)}µs p99 ${r.thinkP99Us.toFixed(0)}µs max ${r.thinkMaxUs.toFixed(0)}µs`,
    `  by source: ` + (['pistol', 'soaker', 'bucket', 'balloon'] as const).map((k) =>
      `${k} ${w[k].shots} shots/${w[k].hits} hits/${w[k].splashes} K (${perMin(w[k].splashes)}/min, hit ${w[k].avgHitDist.toFixed(1)}m, K ${w[k].avgSplashDist.toFixed(1)}m)`).join(' | '),
    `  engaged weapon: pistol ${pct(r.engagedWeaponShare.pistol)} soaker ${pct(r.engagedWeaponShare.soaker)} bucket ${pct(r.engagedWeaponShare.bucket)}`
      + `  modes: ` + Object.entries(r.modeShare).map(([m, x]) => `${m} ${pct(x)}`).join(' '),
  ];
  for (const a of r.agents) {
    lines.push(`  ${a.id.padEnd(6)} ${a.preferred.padEnd(6)} K ${String(a.splashes).padStart(2)} D ${String(a.soaked).padStart(2)}  wp ${String(a.waypointsVisited).padStart(2)}`
      + `  stuckMax ${a.maxStuck.toFixed(1)}s  refills ${a.refills}  towers ${a.towerArrivals.join('/')} pads ${a.padLaunches}  shots ${a.shots} balloons ${a.balloons}`
      + `  yaw≤${a.maxYawRate.toFixed(0)}°/s retreats ${a.retreats} unstuck ${a.stuckRecoveries}`);
  }
  if (r.human) {
    const h = r.human;
    lines.push(`  human: rank ${h.rank}  attention ${pct(h.attentionShare)}  dogpile(≥3) ${pct(h.dogpile3Share)}  maxClaims ${h.maxClaims}  spawnMaxClaims ${h.spawnMaxClaims}`
      + `  spawnDeaths ${h.spawnDeaths}  mercy ${h.mercyTime.toFixed(0)}s`);
  }
  return lines.join('\n');
}
