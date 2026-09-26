import * as THREE from 'three';
import { BALLOON, BOT, PLAYER, STREAM, TANK, WEAPONS } from '../config';
import { emptyIntent, type Intent } from '../core/input';
import { mulberry32 } from '../core/rng';
import { WEAPON_IDS, type PeerId, type ScoreLine, type TeamId, type WeaponId } from '../types';
import { makeContact } from '../world/collision';
import { isInWater, type GameMap } from '../world/map';
import type { PlayerBody } from './playerBody';
import type { Arsenal } from './weapons';

/**
 * 봇 AI(호스트 전용). docs/research/design-synthesis.md §12 를 따른다.
 *
 * - BotNav: 맵 웨이포인트 그래프 + 분수 둘레 보충 자리 + 점프대(한쪽 방향 간선). 맵마다 한 번 만든다.
 * - BotDirector: 한 판의 봇 공용 상태 — 인지 목록(재사용), 발사 "소리", 봐주기 규칙, 대상 나눠 갖기.
 * - BotBrain: 봇 하나. 5Hz 판단(인지·상태·무기·물풍선·경로 관리) + 매 프레임 조준·이동으로 Intent 를 만든다.
 *   사람과 같은 PlayerBody·Arsenal 을 쓰므로 봇이 할 수 있는 일은 사람도 할 수 있다.
 */

/** 봇이 보는 참가자 한 명. pos·vel 은 원본 벡터 참조(복사하지 않음) */
export interface BotPercept {
  id: PeerId;
  team: TeamId;
  /** 발바닥 위치 */
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  alive: boolean;
  shielded: boolean;
  /** 젖음 0..100 */
  soak: number;
  isBot: boolean;
  /** 마지막으로 쏜 게임 시각(초). 모르면 -Infinity */
  firedAt: number;
  /** 이 참가자를 노리는 봇 수 */
  claims: number;
  /** 봐주기 규칙 적용 중인 사람 */
  mercy: boolean;
}

export interface BotContext {
  map: GameMap;
  nav: BotNav;
  /** 방 안 참가자 전부(생각하는 봇 자신 포함 — selfId 로 거른다) */
  others: readonly BotPercept[];
  selfId: PeerId;
  /** 생각하는 봇의 젖음 0..100 */
  soak: number;
  /** 게임 시각(초) */
  time: number;
}

/** 봇 실력. 기본값은 BOT(config). 시뮬레이션에서 "캐주얼 사람" 대역을 만들 때 덮어쓴다 */
export interface BotSkill {
  reactionMin: number;
  reactionMax: number;
  aimSigmaStartDeg: number;
  aimSigmaEndDeg: number;
  turnRateDeg: number;
}

export type BotMode = 'wander' | 'engage' | 'refill' | 'retreat';

const BOT_NAMES = ['보글보글', '찰랑이', '퐁당이', '물방울', '첨벙이', '촉촉이', '뽀송이', '출렁이', '방울방울', '졸졸이'];

export function botName(index: number): string {
  return BOT_NAMES[index % BOT_NAMES.length];
}

const DEG = Math.PI / 180;
const DOWN = new THREE.Vector3(0, -1, 0);
/** 몸통 가운데·머리·엉덩이 높이(발 기준) — 시야선과 조준점 */
const CHEST = PLAYER.height * 0.55;
const HEAD = PLAYER.height - 0.15;
const HIP = 0.45;

const _eye = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _ra = new THREE.Vector3();
const _rb = new THREE.Vector3();
const _hit = { point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0 };
const _contact = makeContact();

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** 두 시선(yaw, pitch) 사이 각(라디안) */
function angleBetween(y1: number, p1: number, y2: number, p2: number): number {
  const c = Math.cos(p1) * Math.cos(p2) * Math.cos(y1 - y2) + Math.sin(p1) * Math.sin(p2);
  return Math.acos(Math.min(1, Math.max(-1, c)));
}

function clearIntent(it: Intent): void {
  it.moveX = 0;
  it.moveZ = 0;
  it.jump = false;
  it.jumpPressed = false;
  it.slidePressed = false;
  it.fire = false;
  it.firePressed = false;
  it.throwPressed = false;
  it.weaponSlot = null;
  it.weaponCycle = 0;
}

/**
 * 봇 물줄기 방향: 총구에서 시선 위 조준점(눈 + 시선 × aimRange)으로 모은다 — 사람의 fireLocal 이
 * 화면 중앙 조준점으로 모으는 것과 같은 방식. 조준 거리를 모르거나 총구가 조준점 너머면 시선 그대로.
 */
export function botShotDirection(eye: THREE.Vector3, aim: THREE.Vector3, origin: THREE.Vector3, aimRange: number, out: THREE.Vector3): THREE.Vector3 {
  if (aimRange < 1) return out.copy(aim);
  out.copy(eye).addScaledVector(aim, aimRange).sub(origin);
  if (out.dot(aim) <= 0 || out.lengthSq() < 0.25) return out.copy(aim);
  return out.normalize();
}

/** 이 발 위치에서의 물 보충 속도(초당). Game.refillRate 와 같은 규칙 */
export function refillRateAt(map: GameMap, feet: THREE.Vector3): number {
  _ra.copy(feet).setY(feet.y + 0.3);
  if (isInWater(map, _ra)) return TANK.poolPerSec;
  for (const f of map.fountains) {
    const dx = f.pos.x - feet.x;
    const dz = f.pos.z - feet.z;
    if (dx * dx + dz * dz <= f.radius * f.radius && Math.abs(f.pos.y - feet.y) < 2) return TANK.fountainPerSec;
  }
  return 0;
}

// ================================================================ 탄도 표

const BALLISTIC_STEP = 0.5;

interface Ballistic {
  /** 수평으로 쏜 물방울의 거리(0.5 m 간격)별 처짐(m)·비행 시간(초) */
  drop: Float32Array;
  time: Float32Array;
  /** 수명 안에 날아가는 수평 거리(m) */
  range: number;
}

const ballisticCache = new Map<WeaponId, Ballistic>();

/** 무기별 탄도 표. ProjectileSystem.stepDroplet 과 같은 적분(직진 → 공기저항·중력) */
export function ballisticOf(weapon: WeaponId): Ballistic {
  const cached = ballisticCache.get(weapon);
  if (cached) return cached;
  const def = WEAPONS[weapon];
  const n = Math.ceil((def.speed * def.life) / BALLISTIC_STEP) + 2;
  const drop = new Float32Array(n);
  const time = new Float32Array(n);
  const dt = 1 / 240;
  let x = 0;
  let y = 0;
  let vx = def.speed;
  let vy = 0;
  let age = 0;
  let filled = 0;
  while (age + dt < def.life) {
    age += dt;
    if (age > def.straightTime) {
      const k = Math.exp(-STREAM.drag * dt);
      vx *= k;
      vy = vy * k - STREAM.gravity * dt;
    }
    x += vx * dt;
    y += vy * dt;
    while (filled < n && filled * BALLISTIC_STEP <= x) {
      drop[filled] = -y;
      time[filled] = age;
      filled++;
    }
  }
  for (; filled < n; filled++) {
    drop[filled] = -y;
    time[filled] = age;
  }
  const b = { drop, time, range: x };
  ballisticCache.set(weapon, b);
  return b;
}

function lookup(table: Float32Array, d: number): number {
  const f = d / BALLISTIC_STEP;
  const i = Math.min(table.length - 2, Math.max(0, Math.floor(f)));
  const k = Math.min(1, Math.max(0, f - i));
  return table[i] + (table[i + 1] - table[i]) * k;
}

/** 봇이 쏘기 시작하는 거리(m): 물방울이 닿는 거리와 적심 감소가 끝나는 거리 중 짧은 쪽 */
export function botFireRange(weapon: WeaponId): number {
  return Math.min(ballisticOf(weapon).range - 0.5, WEAPONS[weapon].falloffFar + 1);
}

/**
 * 물풍선을 수평 거리 D(m), 높이 차 H(m)에 떨어뜨리는 낮은 탄도의 피치(라디안). 닿지 않으면 null.
 * 던지기 = 시선 × throwSpeed + 위로 throwUp, 중력 BALLOON.gravity (던지는 사람 속도는 무시)
 */
export function solveThrowPitch(D: number, H: number): number | null {
  const height = (th: number): number => {
    const vx = BALLOON.throwSpeed * Math.cos(th);
    const vy = BALLOON.throwSpeed * Math.sin(th) + BALLOON.throwUp;
    const t = D / vx;
    return vy * t - 0.5 * BALLOON.gravity * t * t - H;
  };
  let lo = -0.7;
  let hi = Math.PI / 4;
  if (height(hi) < 0) return null;
  if (height(lo) > 0) return lo;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (height(mid) < 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ================================================================ 길찾기 그래프

export type NavKind = 'ground' | 'patio' | 'deck' | 'pool' | 'pad' | 'fountain';

/** 걷기 판정 레이 높이(발 기준): 턱(0.35 m) 위 무릎, 가슴 */
const WALK_KNEE = 0.5;
const WALK_CHEST = 1.2;
/** 무릎 레이를 캡슐 폭만큼 양옆으로도 */
const WALK_SIDE = PLAYER.radius * 0.75;
/** 바닥 검사 간격(m)과 허용 높이 차(두 끝 높이의 선형 보간 기준) */
const FLOOR_STEP = 0.75;
const FLOOR_TOLERANCE = 0.45;
/** 곧장 걷기 판정 최대 길이(m) — 레이 수 상한 */
const WALK_MAX = 14;
/** 분수 보충 자리: 반경 안쪽으로 들인 거리(m)·자리 수·연결할 웨이포인트 거리(m) */
const FOUNTAIN_INSET = 0.2;
const FOUNTAIN_SPOTS = 2;
const LINK_RADIUS = 9;

const navCache = new WeakMap<GameMap, BotNav>();

/**
 * 봇 길찾기 그래프. 웨이포인트(wp_XX, links)에 더해
 * - 분수 둘레에서 실제로 설 수 있는 보충 자리(걸어서 닿는 웨이포인트와 양방향 연결),
 * - 점프대 노드(주변에서 걸어 들어가는 간선 + 착지 데크로 가는 한쪽 방향 간선)를 만든다.
 * 수영장 안 웨이포인트(수면 아래)는 보충 노드다.
 */
export class BotNav {
  readonly pos: THREE.Vector3[] = [];
  readonly ids: string[] = [];
  readonly kind: NavKind[] = [];
  /** 나가는 간선(방향 있음)과 비용(m) */
  readonly links: number[][] = [];
  readonly costs: number[][] = [];
  /** 배회 목표 가중치(0 이면 목표로 안 고름) */
  readonly weight: number[] = [];
  /** 물 보충 노드 */
  readonly refill: number[] = [];
  /** 전망대(데크) 노드 */
  readonly towers: number[] = [];
  private g = new Float64Array(0);
  private state = new Uint8Array(0);
  private came = new Int32Array(0);
  private readonly nearIdx = new Int32Array(4);
  private readonly nearD = new Float64Array(4);

  static for(map: GameMap): BotNav {
    let nav = navCache.get(map);
    if (!nav) {
      nav = new BotNav(map);
      navCache.set(map, nav);
    }
    return nav;
  }

  constructor(readonly map: GameMap) {
    const index = new Map<string, number>();
    for (const w of map.waypoints.values()) {
      index.set(w.id, this.pos.length);
      this.addNode(w.id, w.pos.clone(), this.kindAt(w.pos));
    }
    for (const w of map.waypoints.values()) {
      const i = index.get(w.id)!;
      for (const l of w.links) {
        const j = index.get(l);
        if (j !== undefined && j !== i) this.link(i, j, w.pos.distanceTo(this.pos[j]));
      }
    }
    const wpCount = this.pos.length;
    this.addFountainSpots(wpCount);
    this.addPads(wpCount);
    this.computeWeights();
    for (let i = 0; i < this.pos.length; i++) {
      if (this.kind[i] === 'pool' || this.kind[i] === 'fountain') this.refill.push(i);
      if (this.kind[i] === 'deck') this.towers.push(i);
    }
    const n = this.pos.length;
    this.g = new Float64Array(n);
    this.state = new Uint8Array(n);
    this.came = new Int32Array(n);
  }

  get count(): number {
    return this.pos.length;
  }

  /** 마지막 dijkstra() 기준 경로 비용 */
  cost(i: number): number {
    return this.g[i];
  }

  /**
   * a 에서 b 로 곧장 걸어갈 수 있는지(발 위치 기준): 무릎·가슴 높이가 막히지 않고, 바닥이 두 끝 높이 사이로
   * 이어지며(수영장·절벽 없음), 목표가 아닌 점프대를 밟지 않는다. 1 m 턱(파티오)·긴 경사로는 거짓 — 그래프 간선을 따른다.
   */
  canWalk(a: THREE.Vector3, b: THREE.Vector3, maxLen = WALK_MAX): boolean {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.05) return Math.abs(b.y - a.y) < FLOOR_TOLERANCE;
    if (len > maxLen) return false;
    for (const pad of this.map.jumpPads) {
      if (pad.pos.x === b.x && pad.pos.z === b.z) continue;
      if (segPointDist2(a.x, a.z, b.x, b.z, pad.pos.x, pad.pos.z) < (pad.radius + PLAYER.radius) ** 2 && Math.abs(pad.pos.y - a.y) < 1) return false;
    }
    const col = this.map.collision;
    const sx = (-dz / len) * WALK_SIDE;
    const sz = (dx / len) * WALK_SIDE;
    _ra.set(a.x, a.y + WALK_CHEST, a.z);
    _rb.set(b.x, b.y + WALK_CHEST, b.z);
    if (!col.lineOfSight(_ra, _rb)) return false;
    for (let s = -1; s <= 1; s++) {
      _ra.set(a.x + sx * s, a.y + WALK_KNEE, a.z + sz * s);
      _rb.set(b.x + sx * s, b.y + WALK_KNEE, b.z + sz * s);
      if (!col.lineOfSight(_ra, _rb)) return false;
    }
    const steps = Math.ceil(len / FLOOR_STEP);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const y = a.y + (b.y - a.y) * t;
      const floor = this.floorAt(a.x + dx * t, y + 0.6, a.z + dz * t, 0.6 + FLOOR_TOLERANCE + 0.05);
      if (Number.isNaN(floor) || Math.abs(floor - y) > FLOOR_TOLERANCE) return false;
    }
    return true;
  }

  /**
   * p 에서 가까운 노드(수직 차이는 2배로 친다). walkable 이면 가까운 4개 중 곧장 걸어갈 수 있는 첫 노드,
   * 없으면 가장 가까운 노드. exclude 노드와 점프대 노드는 뺀다.
   */
  nearest(p: THREE.Vector3, walkable: boolean, exclude = -1): number {
    const idx = this.nearIdx;
    const dist = this.nearD;
    idx.fill(-1);
    dist.fill(Infinity);
    for (let i = 0; i < this.pos.length; i++) {
      if (i === exclude || this.kind[i] === 'pad') continue;
      const q = this.pos[i];
      const dy = (q.y - p.y) * 2;
      const d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2 + dy * dy;
      if (d >= dist[3]) continue;
      let k = 3;
      while (k > 0 && dist[k - 1] > d) {
        dist[k] = dist[k - 1];
        idx[k] = idx[k - 1];
        k--;
      }
      dist[k] = d;
      idx[k] = i;
    }
    if (walkable) {
      for (let k = 0; k < 4; k++) if (idx[k] >= 0 && this.canWalk(p, this.pos[idx[k]])) return idx[k];
    }
    return idx[0];
  }

  /**
   * 최단 경로(다익스트라, 노드 80개 안팎이라 선형 탐색). out 에 start..goal 노드 번호를 채운다.
   * @param padScale 점프대 비행 간선 비용 배율(경로마다 흔들어 경사로·점프대를 번갈아 쓰게)
   */
  findPath(start: number, goal: number, out: number[], padScale = 1): boolean {
    this.run(start, goal, padScale);
    if (!Number.isFinite(this.g[goal])) return false;
    out.length = 0;
    for (let c = goal; c !== -1; c = this.came[c]) out.push(c);
    out.reverse();
    return true;
  }

  /** start 에서 모든 노드까지 비용(cost(i)로 읽음) */
  dijkstra(start: number): void {
    this.run(start, -1, 1);
  }

  private run(start: number, goal: number, padScale: number): void {
    const n = this.pos.length;
    const g = this.g;
    const state = this.state;
    g.fill(Infinity);
    state.fill(0);
    this.came.fill(-1);
    g[start] = 0;
    state[start] = 1;
    for (;;) {
      let cur = -1;
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        if (state[i] === 1 && g[i] < best) {
          best = g[i];
          cur = i;
        }
      }
      if (cur < 0 || cur === goal) return;
      state[cur] = 2;
      const ls = this.links[cur];
      const cs = this.costs[cur];
      const scale = this.kind[cur] === 'pad' ? padScale : 1;
      for (let k = 0; k < ls.length; k++) {
        const nb = ls[k];
        if (state[nb] === 2) continue;
        const t = best + cs[k] * scale;
        if (t < g[nb]) {
          g[nb] = t;
          this.came[nb] = cur;
          state[nb] = 1;
        }
      }
    }
  }

  /** (x, yTop, z) 에서 아래로 depth 안의 걸을 수 있는 바닥 높이. 없으면 NaN */
  floorAt(x: number, yTop: number, z: number, depth: number): number {
    _ra.set(x, yTop, z);
    const hit = this.map.collision.raycast(_ra, DOWN, depth, _hit);
    if (!hit || hit.normal.y < PLAYER.groundNormalY) return NaN;
    return hit.point.y;
  }

  private kindAt(p: THREE.Vector3): NavKind {
    _q.copy(p).setY(p.y + 0.3);
    if (isInWater(this.map, _q)) return 'pool';
    if (p.y >= 2.5) return 'deck';
    if (p.y >= 0.6) return 'patio';
    return 'ground';
  }

  private addNode(id: string, pos: THREE.Vector3, kind: NavKind): number {
    this.ids.push(id);
    this.pos.push(pos);
    this.kind.push(kind);
    this.links.push([]);
    this.costs.push([]);
    this.weight.push(0);
    return this.pos.length - 1;
  }

  private link(a: number, b: number, cost: number): void {
    if (this.links[a].includes(b)) return;
    this.links[a].push(b);
    this.costs[a].push(cost);
  }

  /** 캡슐이 이 발 위치에 끼지 않고 설 수 있는지 */
  private standable(p: THREE.Vector3): boolean {
    _ra.set(p.x, p.y + PLAYER.radius + 0.1, p.z);
    _rb.set(p.x, p.y + PLAYER.height - PLAYER.radius, p.z);
    this.map.collision.resolveCapsule(_ra, _rb, PLAYER.radius, _contact);
    return _contact.push.lengthSq() < 1e-4;
  }

  /** 분수마다 보충 반경 안에서 설 수 있고 웨이포인트에서 걸어 닿는 자리(서로 90° 이상 떨어지게 최대 2곳) */
  private addFountainSpots(wpCount: number): void {
    const around: number[] = [];
    this.map.fountains.forEach((f, fi) => {
      const r = Math.max(0.3, f.radius - FOUNTAIN_INSET);
      const angles: number[] = [];
      for (let k = 0; k < 12 && angles.length < FOUNTAIN_SPOTS; k++) {
        const ang = (k / 12) * Math.PI * 2;
        if (angles.some((a) => Math.abs(wrapAngle(a - ang)) < Math.PI / 2 - 1e-6)) continue;
        const x = f.pos.x + Math.cos(ang) * r;
        const z = f.pos.z + Math.sin(ang) * r;
        const y = this.floorAt(x, f.pos.y + 1.5, z, 3);
        if (Number.isNaN(y) || Math.abs(y - f.pos.y) > 0.5) continue;
        const p = new THREE.Vector3(x, y, z);
        if (!this.standable(p)) continue;
        // 가까운 웨이포인트와 잇고, 없으면(웨이포인트가 성긴 맵) 곧장 걷기 판정 최대 거리까지 넓힌다
        for (const radius of [LINK_RADIUS, WALK_MAX]) {
          around.length = 0;
          for (let i = 0; i < wpCount; i++) {
            const w = this.pos[i];
            if (Math.hypot(w.x - x, w.z - z) > radius || Math.abs(w.y - y) > 0.5) continue;
            if (this.canWalk(w, p)) around.push(i);
          }
          if (around.length) break;
        }
        if (!around.length) continue;
        const node = this.addNode(`fountain_${fi}_${k}`, p, 'fountain');
        for (const i of around) {
          const c = this.pos[i].distanceTo(p);
          this.link(i, node, c);
          this.link(node, i, c);
        }
        angles.push(ang);
      }
    });
  }

  /** 목표가 있는 점프대: 주변에서 걸어 들어가는 간선 + 착지 데크 노드로 가는 한쪽 방향 비행 간선 */
  private addPads(wpCount: number): void {
    for (const pad of this.map.jumpPads) {
      if (!pad.target) continue;
      let exit = -1;
      let best = 4 * 4;
      for (let i = 0; i < wpCount; i++) {
        const d = this.pos[i].distanceToSquared(pad.target);
        if (d < best) {
          best = d;
          exit = i;
        }
      }
      if (exit < 0) continue;
      const floor = this.floorAt(pad.pos.x, pad.pos.y + 1, pad.pos.z, 2);
      const p = new THREE.Vector3(pad.pos.x, Number.isNaN(floor) ? pad.pos.y : floor, pad.pos.z);
      const entries: number[] = [];
      for (let i = 0; i < wpCount; i++) {
        const w = this.pos[i];
        if (Math.hypot(w.x - p.x, w.z - p.z) > LINK_RADIUS || Math.abs(w.y - p.y) > 0.5) continue;
        // 점프대 자신은 canWalk 의 "밟으면 안 되는 점프대"에서 빠진다(pos 가 같은 x,z)
        _q.set(pad.pos.x, p.y, pad.pos.z);
        if (this.canWalk(w, _q)) entries.push(i);
      }
      if (!entries.length) continue;
      const node = this.addNode(`pad_to_${this.ids[exit]}`, p, 'pad');
      for (const i of entries) this.link(i, node, this.pos[i].distanceTo(p));
      this.link(node, exit, BOT.padEdgeCost);
    }
  }

  private computeWeights(): void {
    const b = this.map.bounds;
    const halfZ = Math.max(Math.abs(b.minZ), Math.abs(b.maxZ));
    for (let i = 0; i < this.pos.length; i++) {
      const p = this.pos[i];
      let w: number;
      switch (this.kind[i]) {
        case 'deck': w = BOT.wanderTower; break;
        case 'fountain': w = BOT.wanderFountain; break;
        case 'pool': w = BOT.wanderPool; break;
        case 'patio': w = BOT.wanderPatio; break;
        case 'pad': w = 0; break;
        default: {
          const lane = Math.abs(p.z) >= halfZ * BOT.laneOuterFrac || this.nearWater(p, BOT.laneMiddleDist);
          w = lane ? BOT.wanderLane : BOT.wanderOther;
        }
      }
      if (this.kind[i] === 'ground' || this.kind[i] === 'patio') {
        let degree = 0;
        for (const j of this.links[i]) if (this.kind[j] !== 'pad') degree++;
        if (degree <= 1) w *= BOT.wanderDeadEnd;
      }
      this.weight[i] = w;
    }
  }

  private nearWater(p: THREE.Vector3, dist: number): boolean {
    for (const box of this.map.water) {
      const dx = Math.max(box.min.x - p.x, 0, p.x - box.max.x);
      const dz = Math.max(box.min.z - p.z, 0, p.z - box.max.z);
      if (dx * dx + dz * dz <= dist * dist) return true;
    }
    return false;
  }
}

/** 선분 (ax,az)-(bx,bz) 와 점 (px,pz) 사이 수평 거리² */
function segPointDist2(ax: number, az: number, bx: number, bz: number, px: number, pz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 1e-9 ? Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  const x = ax + dx * t - px;
  const z = az + dz * t - pz;
  return x * x + z * z;
}

// ================================================================ 한 판의 봇 공용 상태

interface MercyLine {
  splashes: number;
  soaked: number;
  /** 마지막으로 점수를 냈을 때의 soaked */
  base: number;
}

/** 점수로 봐주기 규칙을 다시 보는 간격(초) */
const SCORE_SYNC_INTERVAL = 0.5;
/** 이보다 오래된 발사 기록은 지운다(초) */
const FIRE_FORGET = 10;

/**
 * 호스트의 봇 공용 상태(Game 하나에 하나). 매 프레임 begin → see(참가자마다) → context(봇마다) 순서로 쓴다.
 * 인지 목록 객체는 풀에서 재사용해 프레임마다 할당하지 않는다.
 */
export class BotDirector {
  private readonly pool: BotPercept[] = [];
  private readonly list: BotPercept[] = [];
  private readonly claimOf: Array<PeerId | null> = [];
  private readonly firedAt = new Map<PeerId, number>();
  private readonly streaks = new Map<PeerId, MercyLine>();
  private ctx: BotContext | null = null;
  private claimsReady = false;
  private scoreClock = 0;
  private time = 0;

  begin(map: GameMap, time: number): void {
    if (!this.ctx || this.ctx.map !== map) this.ctx = { map, nav: BotNav.for(map), others: this.list, selfId: '', soak: 0, time };
    this.time = time;
    this.ctx.time = time;
    this.list.length = 0;
    this.claimOf.length = 0;
    this.claimsReady = false;
  }

  /**
   * 참가자 한 명 등록. pos·vel 은 참조로 들고 있으니 이번 프레임 동안 살아 있는 벡터를 넘긴다.
   * @param target 봇이면 지금 노리는 대상(대상 나눠 갖기용)
   */
  see(id: PeerId, team: TeamId, pos: THREE.Vector3, vel: THREE.Vector3, alive: boolean, shielded: boolean, soak: number, isBot: boolean, target: PeerId | null = null): void {
    const i = this.list.length;
    const p = this.pool[i] ?? (this.pool[i] = {
      id: '', team: -1, pos, vel, alive: false, shielded: false, soak: 0, isBot: false, firedAt: -Infinity, claims: 0, mercy: false,
    });
    p.id = id;
    p.team = team;
    p.pos = pos;
    p.vel = vel;
    p.alive = alive;
    p.shielded = shielded;
    p.soak = soak;
    p.isBot = isBot;
    p.firedAt = this.firedAt.get(id) ?? -Infinity;
    p.claims = 0;
    const s = this.streaks.get(id);
    p.mercy = !isBot && s !== undefined && s.soaked - s.base >= BOT.mercyStreak;
    this.list.push(p);
    this.claimOf.push(target);
  }

  /** 누군가 쐈다(듣기) */
  noteFire(id: PeerId): void {
    this.firedAt.set(id, this.time);
  }

  /** 점수를 넘겨 봐주기 규칙을 갱신할 때인지(초당 2번) */
  scoresDue(dt: number): boolean {
    this.scoreClock -= dt;
    if (this.scoreClock > 0) return false;
    this.scoreClock = SCORE_SYNC_INTERVAL;
    return true;
  }

  /** 경기 점수로 연속 쓰러짐(점수 없이)을 센다. 새 경기(점수 감소)면 초기화 */
  syncScores(scores: Readonly<Record<PeerId, ScoreLine>>): void {
    for (const id in scores) {
      const l = scores[id];
      const s = this.streaks.get(id);
      if (!s) {
        this.streaks.set(id, { splashes: l.splashes, soaked: l.soaked, base: l.soaked });
        continue;
      }
      if (l.splashes !== s.splashes || l.soaked < s.soaked) s.base = l.soaked;
      s.splashes = l.splashes;
      s.soaked = l.soaked;
    }
    for (const id of this.streaks.keys()) if (!(id in scores)) this.streaks.delete(id);
    for (const [id, t] of this.firedAt) if (this.time - t > FIRE_FORGET) this.firedAt.delete(id);
  }

  /** 이번 프레임 인지 목록 기준으로 이 사람에게 봐주기 규칙이 켜져 있는지(디버그·시뮬레이션용) */
  mercyOn(id: PeerId): boolean {
    for (let i = 0; i < this.list.length; i++) if (this.list[i].id === id) return this.list[i].mercy;
    return false;
  }

  /** 봇 하나가 생각할 때 넘길 문맥(재사용 객체) */
  context(selfId: PeerId, soak: number): BotContext {
    const ctx = this.ctx;
    if (!ctx) throw new Error('BotDirector.begin 먼저');
    if (!this.claimsReady) {
      for (let i = 0; i < this.list.length; i++) {
        const t = this.claimOf[i];
        if (!t) continue;
        for (let j = 0; j < this.list.length; j++) {
          if (this.list[j].id === t) {
            this.list[j].claims++;
            break;
          }
        }
      }
      this.claimsReady = true;
    }
    ctx.selfId = selfId;
    ctx.soak = soak;
    return ctx;
  }
}

// ================================================================ 봇 두뇌

const STEER_DONE = 0;
const STEER_MOVE = 1;
/** 점프대 비행 중 — 입력을 놓아야 목표 데크에 떨어진다 */
const STEER_FLIGHT = 2;

/** 무기 바꾸기 거리 여유(m) — 경계에서 왔다 갔다 하지 않게 */
const SWITCH_MARGIN = 0.75;
/** 경로 재계산 최소 간격(초) */
const PLAN_COOLDOWN = 0.2;
/** 쫓는 목표가 이만큼(m) 움직이면 경로를 다시 짠다 */
const REPLAN_MOVE = 3;
/** 다가갈 때 곧장 걸어가 보는 최대 거리(m) */
const DIRECT_APPROACH_MAX = 12;
/** 조준·추적: 시야를 이만큼(초) 넘게 놓치면 추적 시간(오차 감소)을 처음부터 */
const TRACK_BREAK = 0.3;
/** 들은 곳을 바라보는 시간(초)·그쪽으로 가 보는 시간(초) */
const LOOK_TIME = 1.2;
const INVESTIGATE_TIME = 4;

/**
 * 봇 두뇌(호스트에서만 실행). 사람과 같은 PlayerBody·Arsenal 을 Intent 로 조종한다.
 * 판단(decide)은 5Hz, 조준·이동은 매 프레임. 프레임 경로에서는 할당하지 않는다.
 */
export class BotBrain {
  private readonly rnd: () => number;
  private readonly skill: BotSkill;
  private readonly intent: Intent = emptyIntent();
  private nav: BotNav | null = null;
  private _mode: BotMode = 'wander';
  readonly preferred: WeaponId;
  /** 소커 봇이 가까우면 양동이로 바꾸는지 */
  private readonly adaptive: boolean;
  /** Game 이 피격 때 알려 준다 */
  lastAttacker: PeerId | null = null;

  // 대상
  private _targetId: PeerId | null = null;
  private lastTargetId: PeerId | null = null;
  private visible = false;
  private acquiredAt = 0;
  private reactionAt = 0;
  private trackStart = 0;
  private lastSeenAt = -Infinity;
  private readonly lastKnown = new THREE.Vector3();
  private hitAt = -Infinity;
  private lastSoak = 0;
  private lookUntil = 0;
  private readonly lookPos = new THREE.Vector3();
  private investigateUntil = 0;
  private readonly investigatePos = new THREE.Vector3();

  // 조준
  private errYaw = 0;
  private errPitch = 0;
  private errGoalYaw = 0;
  private errGoalPitch = 0;
  private errTimer = 0;
  private clickAt = 0;
  /** 지금 조준 중인 대상까지 거리(m) — Game.fireBot 이 물줄기를 조준점으로 모을 때 쓴다 */
  aimRange = 0;

  // 이동
  private readonly path: number[] = [];
  private pathIdx = 0;
  private goal = -1;
  private readonly goalRef = new THREE.Vector3();
  private planAt = -Infinity;
  private lingerUntil = 0;
  private directOk = false;
  private wx = 0;
  private wz = 0;
  private wantJump = false;
  private strafeDir = 1;
  private strafeUntil = 0;
  private strafeBlocked = 0;
  private scanDir = 1;
  private scanFlipAt = 0;
  private wasFlying = false;

  // 끼임
  private readonly progressRef = new THREE.Vector3();
  private progressTimer = 0;
  private stuckTime = 0;
  private stuckStage = 0;
  private wiggleUntil = 0;
  private wiggleDir = 1;
  private blockedNode = -1;
  private blockedUntil = 0;

  // 무기·물풍선·후퇴
  private pendingSlot = -1;
  private lastSwitchAt = -Infinity;
  private balloonReadyAt = 0;
  private throwing = false;
  private throwYaw = 0;
  private throwPitch = 0;
  private throwUntil = 0;
  private retreatUntil = 0;
  private retreatReadyAt = 0;

  private thinkTimer: number;

  /** 시뮬레이션·디버그용 통계 */
  readonly stats = { refillTrips: 0, retreats: 0, balloonsPlanned: 0, stuckRecoveries: 0, plans: 0 };
  /** 이번 프레임에 움직이려 했는지(끼임 측정용) */
  wantsMove = false;

  /**
   * @param skill 실력 덮어쓰기(기본 BOT) — 시뮬레이션의 "캐주얼 사람" 대역 등
   * @param loadout 기본 무기 고정(없으면 BOT.loadout* 비율로 뽑는다) — 무기별 밸런스 점검용
   */
  constructor(seed: number, readonly team: () => TeamId, skill: Partial<BotSkill> = {}, loadout?: WeaponId) {
    this.rnd = mulberry32(seed);
    this.skill = {
      reactionMin: BOT.reactionMin,
      reactionMax: BOT.reactionMax,
      aimSigmaStartDeg: BOT.aimSigmaStartDeg,
      aimSigmaEndDeg: BOT.aimSigmaEndDeg,
      turnRateDeg: BOT.turnRateDeg,
      ...skill,
    };
    const r = this.rnd();
    this.preferred = loadout ?? (r < BOT.loadoutSoaker ? 'soaker' : r < BOT.loadoutSoaker + BOT.loadoutBucket ? 'bucket' : 'pistol');
    this.adaptive = this.rnd() < BOT.adaptiveShare;
    // 5Hz 판단을 봇마다 다른 위상에서 시작
    this.thinkTimer = this.rnd() * BOT.thinkInterval;
  }

  get mode(): BotMode {
    return this._mode;
  }

  /** 지금 노리는 대상 */
  get targetId(): PeerId | null {
    return this._targetId;
  }

  /** 부활 */
  reset(): void {
    this._mode = 'wander';
    this.path.length = 0;
    this.pathIdx = 0;
    this.goal = -1;
    this._targetId = null;
    this.lastTargetId = null;
    this.visible = false;
    this.lastSeenAt = -Infinity;
    this.hitAt = -Infinity;
    this.lastSoak = 0;
    this.lastAttacker = null;
    this.lingerUntil = 0;
    this.lookUntil = 0;
    this.investigateUntil = 0;
    this.throwing = false;
    this.retreatUntil = 0;
    this.stuckTime = 0;
    this.stuckStage = 0;
    this.progressTimer = 0;
    this.wasFlying = false;
    this.pendingSlot = -1;
    this.aimRange = 0;
  }

  think(dt: number, body: PlayerBody, arsenal: Arsenal, ctx: BotContext): Intent {
    const it = this.intent;
    clearIntent(it);
    this.nav = ctx.nav;
    const t = ctx.time;
    // 젖음이 늘었으면 맞은 것(누가 쐈는지는 Game 이 lastAttacker 로 알려 준다)
    if (ctx.soak > this.lastSoak + 0.01) this.hitAt = t;
    this.lastSoak = ctx.soak;
    // 점프대 비행이 끝났는데 다음 노드가 근처가 아니면(경로 밖 점프대를 밟음) 경로를 다시 잡는다
    if (this.wasFlying && !body.padFlight && body.grounded) {
      const node = this.path[this.pathIdx];
      if (node === undefined || this.nav.pos[node].distanceTo(body.position) > 6) this.clearPath();
    }
    this.wasFlying = body.padFlight;

    this.thinkTimer -= dt;
    if (this.thinkTimer <= 0) {
      this.thinkTimer += BOT.thinkInterval;
      if (this.thinkTimer <= 0) this.thinkTimer = BOT.thinkInterval;
      this.decide(body, arsenal, ctx);
    }
    // 대상이 쓰러졌거나 나갔으면 놓는다(다음 판단에서 새 대상·상태를 고른다)
    const target = this.findTarget(ctx);
    if (!target && this._targetId) {
      this.dropTarget(t);
      if (this._mode === 'engage' || this._mode === 'retreat') this.enterMode('wander', t);
    }

    if (this.pendingSlot >= 0) {
      if (WEAPON_IDS[this.pendingSlot] !== arsenal.current) it.weaponSlot = this.pendingSlot;
      this.pendingSlot = -1;
    }

    switch (this._mode) {
      case 'engage':
        if (target) this.engage(dt, body, arsenal, target, ctx, it);
        break;
      case 'refill':
        this.refill(dt, body, ctx, it);
        break;
      case 'retreat':
        this.retreat(dt, body, target, it);
        break;
      default:
        this.wander(dt, body, ctx, it);
    }
    this.trackStuck(dt, body, it, t);
    return it;
  }

  // ------------------------------------------------------------ 판단(5Hz)

  private decide(body: PlayerBody, arsenal: Arsenal, ctx: BotContext): void {
    const t = ctx.time;
    const nav = ctx.nav;
    this.perceive(body, ctx);
    const target = this.findTarget(ctx);
    const dist = target ? target.pos.distanceTo(body.position) : Infinity;

    // 상태
    let next: BotMode;
    if (this._mode === 'retreat' && t < this.retreatUntil && target && dist > 4 && ctx.soak > BOT.retreatTargetSoak) {
      next = 'retreat';
    } else if (target && this.visible && this._mode !== 'retreat' && ctx.soak >= BOT.retreatSoak && target.soak <= BOT.retreatTargetSoak
      && t >= this.retreatReadyAt && this.planRetreat(body, target, t)) {
      next = 'retreat';
    } else {
      const needWater = nav.refill.length > 0 && (arsenal.tank < BOT.refillBelow || (this._mode === 'refill' && arsenal.tank < BOT.refillUntil));
      if (needWater && !(target && this.visible && dist < BOT.refillAbortDist)) next = 'refill';
      else if (target) next = 'engage';
      else next = 'wander';
    }
    if (next !== this._mode) this.enterMode(next, t);

    // 무기(선호 무기 + 거리)
    const want = this.chooseWeapon(arsenal.current, target && this.visible ? dist : Infinity);
    if (want !== arsenal.current && t - this.lastSwitchAt >= BOT.switchHold) {
      this.pendingSlot = WEAPON_IDS.indexOf(want);
      this.lastSwitchAt = t;
    }

    if (this._mode === 'engage' && target) {
      this.considerBalloon(body, arsenal, target, dist, ctx);
      this.upkeepEngagePath(body, target, dist, arsenal.current, t);
    }
    this.cutCorner(body);
    this.handleStuck(t);
  }

  /** 시야(원뿔 + 시야선)와 듣기로 대상을 고른다. 다른 봇이 이미 둘 붙은 대상은 다른 대상이 있으면 피한다 */
  private perceive(body: PlayerBody, ctx: BotContext): void {
    const t = ctx.time;
    const col = ctx.map.collision;
    const myTeam = this.team();
    body.eyePosition(_eye);
    const fwdX = -Math.sin(body.yaw);
    const fwdZ = -Math.cos(body.yaw);
    const cosHalf = Math.cos(BOT.fovDeg * 0.5 * DEG);
    let best: BotPercept | null = null;
    let bestScore = Infinity;
    let open: BotPercept | null = null;
    let openScore = Infinity;
    let cur: BotPercept | null = null;
    let curScore = Infinity;
    let heard: BotPercept | null = null;
    let heardD = Infinity;
    const others = ctx.others;
    for (let i = 0; i < others.length; i++) {
      const o = others[i];
      if (o.id === ctx.selfId || !o.alive || (myTeam !== -1 && o.team === myTeam)) continue;
      const dx = o.pos.x - _eye.x;
      const dz = o.pos.z - _eye.z;
      const dy = o.pos.y + CHEST - _eye.y;
      const hd = Math.sqrt(dx * dx + dz * dz);
      const d = Math.sqrt(hd * hd + dy * dy);
      if (d > BOT.sightRange) continue;
      const inCone = hd < 0.5 || (dx * fwdX + dz * fwdZ) / hd >= cosHalf;
      const heardShot = t - o.firedAt <= BOT.hearMemory && d <= BOT.hearRange;
      const heardHit = o.id === this.lastAttacker && t - this.hitAt <= BOT.hitMemory;
      // 쫓던 대상은 고개를 돌려서라도 본다(잠깐 시야 밖으로 나가도 놓치지 않음)
      const tracking = o.id === this._targetId && t - this.lastSeenAt <= BOT.targetMemory;
      if (!inCone && !heardShot && !heardHit && !tracking) continue;
      if (!visibleFrom(col, _eye, o.pos)) {
        if ((heardShot || heardHit) && d < heardD) {
          heard = o;
          heardD = d;
        }
        continue;
      }
      const claims = o.claims - (o.id === this._targetId ? 1 : 0);
      let score = d + claims * BOT.scorePerClaim;
      if (heardHit) score -= BOT.scoreAttacker;
      if (o.shielded) score += BOT.scoreShielded;
      if (o.id === this._targetId) {
        score -= BOT.scoreCurrent;
        cur = o;
        curScore = score;
      }
      if (score < bestScore) {
        bestScore = score;
        best = o;
      }
      if (claims < BOT.maxPerTarget && score < openScore) {
        openScore = score;
        open = o;
      }
    }
    const pick = open ?? best;
    const pickScore = open ? openScore : bestScore;

    if (this._targetId) {
      const alive = this.findTarget(ctx) !== null;
      const remembered = alive && (cur !== null || t - this.lastSeenAt <= BOT.targetMemory);
      if (!remembered) {
        this.dropTarget(t);
        if (pick) this.acquire(pick, t);
      } else if (pick && pick !== cur) {
        const held = t - this.acquiredAt;
        const attacker = pick.id === this.lastAttacker && t - this.hitAt <= BOT.hitMemory && held >= 0.5;
        const better = held >= BOT.retargetHold && (!cur || pickScore < curScore - BOT.retargetMargin);
        if (attacker || better) this.acquire(pick, t);
      }
    } else if (pick) {
      this.acquire(pick, t);
    }

    const target = this.findTarget(ctx);
    const seen = target !== null && (target === cur || target === pick);
    if (seen && target) {
      if (!this.visible && t - this.lastSeenAt > TRACK_BREAK) this.trackStart = t;
      this.lastSeenAt = t;
      this.lastKnown.copy(target.pos);
    }
    this.visible = seen;

    // 안 보이는 곳에서 쏘거나 맞히면 그쪽을 돌아보고, 대상이 없으면 가 본다
    if (heard && !target) {
      this.lookPos.copy(heard.pos);
      this.lookUntil = t + LOOK_TIME;
      this.investigatePos.copy(heard.pos);
      if (this.investigateUntil < t) this.goal = -1;
      this.investigateUntil = t + INVESTIGATE_TIME;
    }
  }

  private acquire(o: BotPercept, t: number): void {
    const reacquire = o.id === this.lastTargetId && t - this.lastSeenAt <= BOT.targetMemory * 2;
    this._targetId = o.id;
    this.acquiredAt = t;
    this.trackStart = t;
    this.reactionAt = t + (reacquire ? BOT.reacquireDelay : this.skill.reactionMin + this.rnd() * (this.skill.reactionMax - this.skill.reactionMin));
    const sigma = this.skill.aimSigmaStartDeg * DEG;
    this.errYaw = this.errGoalYaw = this.gauss() * sigma;
    this.errPitch = this.errGoalPitch = this.gauss() * sigma * BOT.aimPitchScale;
    this.errTimer = BOT.aimJitterMin + this.rnd() * (BOT.aimJitterMax - BOT.aimJitterMin);
    this.lastSeenAt = t;
    this.lastKnown.copy(o.pos);
    this.visible = true;
    this.throwing = false;
    // 교전 경로는 대상 기준이라 새로 짠다. 보충·후퇴 경로는 대상과 무관하니 유지(배회는 곧 교전으로 바뀌며 지워진다)
    if (this._mode === 'engage') this.clearPath();
  }

  private dropTarget(t: number): void {
    this.lastTargetId = this._targetId;
    this._targetId = null;
    this.visible = false;
    this.throwing = false;
    if (this.rnd() < BOT.investigateChance) {
      this.investigatePos.copy(this.lastKnown);
      this.investigateUntil = t + INVESTIGATE_TIME;
    }
  }

  private findTarget(ctx: BotContext): BotPercept | null {
    const id = this._targetId;
    if (!id) return null;
    const others = ctx.others;
    for (let i = 0; i < others.length; i++) {
      const o = others[i];
      if (o.id === id) return o.alive ? o : null;
    }
    return null;
  }

  private enterMode(m: BotMode, t: number): void {
    const prev = this._mode;
    this._mode = m;
    if (m === 'retreat') {
      // 경로는 planRetreat 가 이미 잡았다
      this.retreatUntil = t + BOT.retreatTime;
      this.retreatReadyAt = t + BOT.retreatTime + BOT.retreatCooldown;
      this.stats.retreats++;
      return;
    }
    if (m === 'refill' && prev !== 'refill') this.stats.refillTrips++;
    this.clearPath();
    this.lingerUntil = 0;
  }

  private chooseWeapon(current: WeaponId, d: number): WeaponId {
    if (!Number.isFinite(d)) return this.preferred;
    // 지금 무기 쪽으로 여유를 둬 경계에서 왔다 갔다 하지 않게
    const m = (w: WeaponId) => (current === w ? SWITCH_MARGIN : -SWITCH_MARGIN);
    switch (this.preferred) {
      case 'bucket':
        return d <= BOT.bucketOut + m('bucket') ? 'bucket' : 'soaker';
      case 'pistol':
        return d < BOT.pistolToSoaker + m('soaker') ? 'soaker' : 'pistol';
      default:
        if (this.adaptive && d < BOT.soakerToBucket + m('bucket')) return 'bucket';
        if (d > BOT.soakerToPistol - m('pistol')) return 'pistol';
        return 'soaker';
    }
  }

  /** 대상이 낮은 엄폐물 뒤(엉덩이 가림, 머리 보임)이거나 다른 적과 뭉쳐 있으면 물풍선 */
  private considerBalloon(body: PlayerBody, arsenal: Arsenal, target: BotPercept, dist: number, ctx: BotContext): void {
    const t = ctx.time;
    if (this.throwing || t < this.balloonReadyAt || !arsenal.balloonReady || arsenal.tank < BOT.balloonTank) return;
    if (dist < BOT.balloonMin || dist > BOT.balloonMax || target.shielded || t - this.lastSeenAt > 0.5) return;
    let clustered = false;
    const myTeam = this.team();
    for (const o of ctx.others) {
      if (o === target || o.id === ctx.selfId || !o.alive || (myTeam !== -1 && o.team === myTeam)) continue;
      if (o.pos.distanceToSquared(target.pos) <= BOT.clusterRadius ** 2) {
        clustered = true;
        break;
      }
    }
    let lowCover = false;
    if (!clustered) {
      const col = ctx.map.collision;
      body.eyePosition(_eye);
      _p.copy(target.pos).setY(target.pos.y + HIP);
      _q.copy(target.pos).setY(target.pos.y + HEAD);
      lowCover = !col.lineOfSight(_eye, _p) && col.lineOfSight(_eye, _q);
    }
    if (!clustered && !lowCover) return;
    // 조준점: 몸통 + 대상 속도 × 비행 시간의 절반(두 번 풀어 비행 시간을 맞춘다)
    body.eyePosition(_eye);
    let pitch: number | null = null;
    let flight = 0;
    for (let k = 0; k < 2; k++) {
      _p.copy(target.pos).addScaledVector(target.vel, flight * 0.5).setY(target.pos.y + CHEST * 0.8);
      const D = Math.hypot(_p.x - _eye.x, _p.z - _eye.z);
      pitch = solveThrowPitch(D, _p.y - _eye.y);
      if (pitch === null) return;
      flight = D / (BALLOON.throwSpeed * Math.cos(pitch));
    }
    const sigma = this.aimSigma(target, 0) * 0.5;
    this.throwYaw = Math.atan2(-(_p.x - _eye.x), -(_p.z - _eye.z)) + this.gauss() * sigma;
    this.throwPitch = pitch! + this.gauss() * sigma * BOT.aimPitchScale;
    this.throwing = true;
    this.throwUntil = t + BOT.throwWindow;
    this.stats.balloonsPlanned++;
  }

  /** 교전 이동 경로: 안 보이면 마지막으로 본 곳으로, 멀면 대상 쪽으로 */
  private upkeepEngagePath(body: PlayerBody, target: BotPercept, dist: number, weapon: WeaponId, t: number): void {
    const nav = this.nav!;
    this.directOk = false;
    if (!this.visible) {
      if (this.goal < 0 || this.goalRef.distanceToSquared(this.lastKnown) > REPLAN_MOVE * REPLAN_MOVE) {
        this.planTo(body, nav.nearest(this.lastKnown, false), t);
        this.goalRef.copy(this.lastKnown);
      }
      return;
    }
    if (dist <= BOT.preferredRange[weapon] + BOT.rangeSlack) return;
    this.directOk = dist <= DIRECT_APPROACH_MAX && nav.canWalk(body.position, target.pos, DIRECT_APPROACH_MAX);
    if (!this.directOk && (this.goal < 0 || this.goalRef.distanceToSquared(target.pos) > REPLAN_MOVE * REPLAN_MOVE)) {
      this.planTo(body, nav.nearest(target.pos, false), t);
      this.goalRef.copy(target.pos);
    }
  }

  /** 지금 노드 근처이고 다음 노드로 곧장 걸어갈 수 있으면 건너뛴다 */
  private cutCorner(body: PlayerBody): void {
    const nav = this.nav!;
    if (!body.grounded || this.pathIdx >= this.path.length - 1) return;
    const cur = this.path[this.pathIdx];
    const kind = nav.kind[cur];
    if (kind === 'pad' || kind === 'deck' || kind === 'fountain') return;
    const p = nav.pos[cur];
    if (Math.hypot(p.x - body.position.x, p.z - body.position.z) > BOT.cornerCutDist) return;
    if (nav.canWalk(body.position, nav.pos[this.path[this.pathIdx + 1]])) this.pathIdx++;
  }

  /** 끼임 단계별 회복: 점프(프레임) → 막힌 노드 빼고 경로 재계산 → 다른 목표 */
  private handleStuck(t: number): void {
    if (this.stuckTime >= BOT.stuckNewGoal && this.stuckStage < 2) {
      this.stuckStage = 2;
      this.stats.stuckRecoveries++;
      this.blockCurrentNode(t);
      this.clearPath();
      this.lingerUntil = 0;
      this.strafeDir = -this.strafeDir;
      this.investigateUntil = 0;
    } else if (this.stuckTime >= BOT.stuckReplan && this.stuckStage < 1) {
      this.stuckStage = 1;
      this.stats.stuckRecoveries++;
      this.blockCurrentNode(t);
      const goal = this.goal;
      this.clearPath();
      this.goal = goal;
      this.strafeDir = -this.strafeDir;
    }
  }

  private blockCurrentNode(t: number): void {
    const node = this.path[this.pathIdx];
    if (node === undefined) return;
    this.blockedNode = node;
    this.blockedUntil = t + BOT.blockedNodeTime;
  }

  /** 대상에게서 안 보이는 가까운 노드로 물러날 경로. 없으면 false */
  private planRetreat(body: PlayerBody, target: BotPercept, t: number): boolean {
    const nav = this.nav!;
    const col = nav.map.collision;
    const idx: number[] = this.coverIdx;
    const dist: number[] = this.coverD;
    idx.length = 0;
    dist.length = 0;
    const r2 = BOT.coverRadius * BOT.coverRadius;
    for (let i = 0; i < nav.count; i++) {
      const k = nav.kind[i];
      if (k === 'pad' || k === 'pool') continue;
      const p = nav.pos[i];
      const d = (p.x - body.position.x) ** 2 + (p.z - body.position.z) ** 2;
      if (d > r2 || p.distanceToSquared(target.pos) < 25) continue;
      let j = idx.length;
      if (j >= BOT.coverCandidates && d >= dist[j - 1]) continue;
      if (j >= BOT.coverCandidates) j--;
      while (j > 0 && dist[j - 1] > d) {
        dist[j] = dist[j - 1];
        idx[j] = idx[j - 1];
        j--;
      }
      dist[j] = d;
      idx[j] = i;
    }
    _q.copy(target.pos).setY(target.pos.y + PLAYER.eyeHeight);
    for (let k = 0; k < idx.length; k++) {
      const p = nav.pos[idx[k]];
      _p.set(p.x, p.y + PLAYER.eyeHeight, p.z);
      if (col.lineOfSight(_p, _q)) continue;
      if (this.planTo(body, idx[k], t)) return true;
    }
    return false;
  }

  private readonly coverIdx: number[] = [];
  private readonly coverD: number[] = [];

  // ------------------------------------------------------------ 매 프레임

  private engage(dt: number, body: PlayerBody, arsenal: Arsenal, target: BotPercept, ctx: BotContext, it: Intent): void {
    const t = ctx.time;
    const weapon = arsenal.current;
    const dx = target.pos.x - body.position.x;
    const dz = target.pos.z - body.position.z;
    const hd = Math.hypot(dx, dz);

    if (this.throwing) {
      this.turnTo(body, this.throwYaw, this.throwPitch, dt);
      if (angleBetween(body.yaw, body.pitch, this.throwYaw, this.throwPitch) < BOT.throwToleranceDeg * DEG) {
        it.throwPressed = true;
        this.throwing = false;
        this.balloonReadyAt = t + BOT.balloonCooldown;
      } else if (t > this.throwUntil) {
        this.throwing = false;
        this.balloonReadyAt = t + 1;
      }
    } else if (this.visible) {
      const err = this.aimAt(dt, body, target, weapon, t);
      const def = WEAPONS[weapon];
      const dist = body.position.distanceTo(target.pos);
      const cone = Math.max(BOT.fireConeDeg * DEG, Math.atan2(BOT.bodyRadius, Math.max(0.1, dist)));
      if (t >= this.reactionAt && err < cone && dist <= botFireRange(weapon) && !target.shielded && arsenal.tank >= def.cost) {
        if (def.automatic) {
          it.fire = true;
        } else if (t >= this.clickAt) {
          it.fire = true;
          it.firePressed = true;
          this.clickAt = t + def.interval + BOT.clickSlackMin + this.rnd() * (BOT.clickSlackMax - BOT.clickSlackMin);
        }
      }
    } else {
      // 안 보이면 마지막으로 본 곳을 겨누고 간다
      _p.copy(this.lastKnown).setY(this.lastKnown.y + CHEST);
      this.lookAt(body, _p, dt);
    }

    // 이동
    if (!this.visible) {
      if (this.steerPath(body, ctx) === STEER_MOVE) this.applyMove(body, it, this.wx, this.wz);
      return;
    }
    const ux = hd > 1e-3 ? dx / hd : 0;
    const uz = hd > 1e-3 ? dz / hd : 0;
    const pref = BOT.preferredRange[weapon];
    this.strafe(dt, body, t);
    let mx = -uz * this.strafeDir;
    let mz = ux * this.strafeDir;
    if (hd > pref + BOT.rangeSlack) {
      let ax = ux;
      let az = uz;
      if (!this.directOk) {
        const s = this.steerPath(body, ctx);
        if (s === STEER_FLIGHT) return;
        if (s === STEER_MOVE) {
          ax = this.wx;
          az = this.wz;
        }
      }
      mx = mx * 0.35 + ax;
      mz = mz * 0.35 + az;
    } else if (hd < pref - BOT.rangeSlack) {
      mx = mx * 0.8 - ux;
      mz = mz * 0.8 - uz;
    }
    this.applyMove(body, it, mx, mz);
    if (body.grounded && this.rnd() < BOT.jumpPerSec * dt) {
      it.jump = true;
      it.jumpPressed = true;
    }
    if (this.wantJump) {
      it.jump = true;
      it.jumpPressed = true;
    }
  }

  /** 좌우 무빙 방향: 0.6~1.2초마다 바꾸고, 막히면 바로 뒤집는다 */
  private strafe(dt: number, body: PlayerBody, t: number): void {
    if (t >= this.strafeUntil) {
      this.strafeUntil = t + BOT.strafeMin + this.rnd() * (BOT.strafeMax - BOT.strafeMin);
      this.strafeDir = this.rnd() < 0.5 ? -1 : 1;
    }
    if (body.grounded && Math.hypot(body.velocity.x, body.velocity.z) < 1) {
      this.strafeBlocked += dt;
      if (this.strafeBlocked > 0.3) {
        this.strafeBlocked = 0;
        this.strafeDir = -this.strafeDir;
        this.strafeUntil = t + BOT.strafeMin;
      }
    } else {
      this.strafeBlocked = 0;
    }
  }

  /**
   * 대상 조준: 몸통 가운데 + 대상 속도 × 비행 시간 × 0.5 + 물줄기 처짐 보정, 가우시안 오차(추적할수록 감소,
   * 옆걸음·봐주기로 증가)를 천천히 떠돌게 더하고 회전 한계로 돌린다.
   * @returns 지금 시선과 참 조준 방향 사이 각(라디안)
   */
  private aimAt(dt: number, body: PlayerBody, target: BotPercept, weapon: WeaponId, t: number): number {
    body.eyePosition(_eye);
    const bal = ballisticOf(weapon);
    const hd0 = Math.hypot(target.pos.x - _eye.x, target.pos.z - _eye.z);
    const flight = lookup(bal.time, hd0);
    _p.copy(target.pos).addScaledVector(target.vel, flight * 0.5);
    _p.y += CHEST + lookup(bal.drop, hd0);
    const ax = _p.x - _eye.x;
    const ay = _p.y - _eye.y;
    const az = _p.z - _eye.z;
    const trueYaw = Math.atan2(-ax, -az);
    const truePitch = Math.atan2(ay, Math.hypot(ax, az));
    const sigma = this.aimSigma(target, Math.min(1, (t - this.trackStart) / BOT.aimTrackTime));
    this.errTimer -= dt;
    if (this.errTimer <= 0) {
      this.errTimer = BOT.aimJitterMin + this.rnd() * (BOT.aimJitterMax - BOT.aimJitterMin);
      this.errGoalYaw = this.gauss() * sigma;
      this.errGoalPitch = this.gauss() * sigma * BOT.aimPitchScale;
    }
    const k = 1 - Math.exp(-BOT.aimJitterFollow * dt);
    this.errYaw += (this.errGoalYaw - this.errYaw) * k;
    this.errPitch += (this.errGoalPitch - this.errPitch) * k;
    this.turnTo(body, trueYaw + this.errYaw, truePitch + this.errPitch, dt);
    this.aimRange = Math.sqrt(ax * ax + ay * ay + az * az);
    return angleBetween(body.yaw, body.pitch, trueYaw, truePitch);
  }

  /** 조준 오차 σ(라디안). track: 0(방금 잡음)..1(aimTrackTime 넘게 추적) */
  private aimSigma(target: BotPercept, track: number): number {
    const dx = target.pos.x - _eye.x;
    const dz = target.pos.z - _eye.z;
    const hd = Math.hypot(dx, dz);
    // 시선에 수직인 대상 속도(옆걸음)
    const lateral = hd > 1e-3 ? Math.abs((target.vel.x * -dz + target.vel.z * dx) / hd) : 0;
    const s = this.skill;
    return (s.aimSigmaStartDeg + (s.aimSigmaEndDeg - s.aimSigmaStartDeg) * track
      + BOT.aimSigmaPerLateralDeg * lateral + (target.mercy ? BOT.mercySigmaDeg : 0)) * DEG;
  }

  private refill(dt: number, body: PlayerBody, ctx: BotContext, it: Intent): void {
    const t = ctx.time;
    if (refillRateAt(ctx.map, body.position) > 0) {
      // 보충 중: 멈춰서 둘러본다(Decide 가 가득 차면·적이 가까우면 상태를 바꾼다)
      this.idleLook(dt, body, t);
      return;
    }
    if (this.pathIdx >= this.path.length && t - this.planAt >= PLAN_COOLDOWN) this.planRefill(body, t);
    const s = this.steerPath(body, ctx);
    if (s === STEER_MOVE) {
      this.applyMove(body, it, this.wx, this.wz);
      this.faceMove(body, dt, t);
      if (this.wantJump) {
        it.jump = true;
        it.jumpPressed = true;
      }
    } else if (s === STEER_DONE) {
      this.idleLook(dt, body, t);
    }
  }

  private retreat(dt: number, body: PlayerBody, target: BotPercept | null, it: Intent): void {
    const s = this.steerPath(body, null);
    if (s === STEER_MOVE) {
      this.applyMove(body, it, this.wx, this.wz);
      this.faceDir(body, this.wx, this.wz, dt);
      if (this.wantJump) {
        it.jump = true;
        it.jumpPressed = true;
      }
    } else if (s === STEER_DONE && target) {
      // 엄폐 도착: 대상 쪽을 보며 기다린다(마르는 중)
      _p.copy(this.lastKnown).setY(this.lastKnown.y + CHEST);
      this.lookAt(body, _p, dt);
    }
  }

  private wander(dt: number, body: PlayerBody, ctx: BotContext, it: Intent): void {
    const t = ctx.time;
    if (t < this.lingerUntil) {
      this.idleLook(dt, body, t);
      return;
    }
    if (this.pathIdx >= this.path.length && t - this.planAt >= PLAN_COOLDOWN) {
      if (this.goal >= 0 && this.path.length > 0) {
        // 목표 도착: 잠깐 머문다(전망대는 오래)
        const tower = this.nav!.kind[this.goal] === 'deck';
        this.lingerUntil = t + (tower
          ? BOT.towerLingerMin + this.rnd() * (BOT.towerLingerMax - BOT.towerLingerMin)
          : BOT.lingerMin + this.rnd() * (BOT.lingerMax - BOT.lingerMin));
        this.clearPath();
        return;
      }
      this.planWander(body, t);
    }
    const s = this.steerPath(body, ctx);
    if (s === STEER_MOVE) {
      this.applyMove(body, it, this.wx, this.wz);
      this.faceMove(body, dt, t);
      if (this.wantJump) {
        it.jump = true;
        it.jumpPressed = true;
      }
    } else if (s === STEER_DONE) {
      this.idleLook(dt, body, t);
    }
  }

  // ------------------------------------------------------------ 경로

  private clearPath(): void {
    this.path.length = 0;
    this.pathIdx = 0;
    this.goal = -1;
  }

  private planTo(body: PlayerBody, goal: number, t: number): boolean {
    const nav = this.nav!;
    this.planAt = t;
    this.stats.plans++;
    if (goal < 0) return false;
    const start = nav.nearest(body.position, true, t < this.blockedUntil ? this.blockedNode : -1);
    if (start < 0) return false;
    const padScale = BOT.padCostJitterMin + this.rnd() * (BOT.padCostJitterMax - BOT.padCostJitterMin);
    if (!nav.findPath(start, goal, this.path, padScale)) {
      this.clearPath();
      return false;
    }
    this.pathIdx = 0;
    this.goal = goal;
    // 시작 노드는 다음 노드로 곧장 걸어갈 수 있을 때만 건너뛴다(벽 너머 다음 노드로 직행 금지)
    if (this.path.length > 1 && body.grounded && nav.canWalk(body.position, nav.pos[this.path[1]])) this.pathIdx = 1;
    return true;
  }

  private planWander(body: PlayerBody, t: number): void {
    const nav = this.nav!;
    let goal = -1;
    if (t < this.investigateUntil) {
      goal = nav.nearest(this.investigatePos, false);
      this.investigateUntil = 0;
      if (goal >= 0 && nav.pos[goal].distanceToSquared(body.position) < 4) goal = -1;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      if (goal < 0) goal = this.pickWanderGoal(body);
      if (this.planTo(body, goal, t)) return;
      goal = -1;
    }
  }

  /** 배회 목표: 레인·분수·전망대 쪽으로 가중, 너무 가까운 곳·직전 목표 제외 */
  private pickWanderGoal(body: PlayerBody): number {
    const nav = this.nav!;
    const min2 = BOT.wanderMinDist * BOT.wanderMinDist;
    let total = 0;
    for (let i = 0; i < nav.count; i++) total += this.goalWeight(i, body, min2);
    if (total <= 0) return Math.floor(this.rnd() * nav.count);
    let r = this.rnd() * total;
    for (let i = 0; i < nav.count; i++) {
      r -= this.goalWeight(i, body, min2);
      if (r <= 0) return i;
    }
    return nav.count - 1;
  }

  private goalWeight(i: number, body: PlayerBody, min2: number): number {
    const nav = this.nav!;
    if (i === this.goal || i === this.lastGoal) return 0;
    const p = nav.pos[i];
    if ((p.x - body.position.x) ** 2 + (p.z - body.position.z) ** 2 < min2) return 0;
    return nav.weight[i];
  }

  private lastGoal = -1;

  private planRefill(body: PlayerBody, t: number): void {
    const nav = this.nav!;
    const start = nav.nearest(body.position, false);
    if (start < 0) return;
    nav.dijkstra(start);
    let best = -1;
    let bestCost = Infinity;
    for (const r of nav.refill) {
      const c = nav.cost(r) + (nav.kind[r] === 'pool' ? BOT.poolRefillPenalty : 0);
      if (c < bestCost) {
        bestCost = c;
        best = r;
      }
    }
    this.planTo(body, best, t);
  }

  /**
   * 경로 따라가기. 이동할 월드 방향을 wx, wz 에 쓴다.
   * 점프대 노드는 밟아서 발사되면 지나간 것으로 보고, 비행 중에는 입력을 놓는다(목표 데크에 떨어지게).
   */
  private steerPath(body: PlayerBody, ctx: BotContext | null): number {
    const nav = this.nav!;
    this.wantJump = false;
    if (body.padFlight) {
      if (this.pathIdx < this.path.length && nav.kind[this.path[this.pathIdx]] === 'pad') this.pathIdx++;
      if (Math.hypot(body.velocity.x, body.velocity.z) > 1) return STEER_FLIGHT;
    }
    while (this.pathIdx < this.path.length) {
      const node = this.path[this.pathIdx];
      const p = nav.pos[node];
      const kind = nav.kind[node];
      const dx = p.x - body.position.x;
      const dz = p.z - body.position.z;
      const dh = Math.hypot(dx, dz);
      const dy = p.y - body.position.y;
      let arrived: boolean;
      if (kind === 'pad') arrived = false;
      else if (kind === 'fountain') arrived = dh < 0.5 || (ctx !== null && dh < 1 && refillRateAt(ctx.map, body.position) > 0);
      else arrived = dh < BOT.arriveRadius && Math.abs(dy) < 1.6;
      if (arrived) {
        if (this.pathIdx === this.path.length - 1) this.lastGoal = node;
        this.pathIdx++;
        continue;
      }
      this.wx = dx / dh;
      this.wz = dz / dh;
      this.wantJump = body.grounded && kind !== 'pad' && dy > BOT.jumpUpHeight && dh < BOT.jumpUpDist;
      return STEER_MOVE;
    }
    return STEER_DONE;
  }

  // ------------------------------------------------------------ 끼임

  /** 0.5초마다 이동량을 보고 끼인 시간을 잰다. 끼이면 점프하며 옆으로 비킨다(재계산·목표 변경은 decide) */
  private trackStuck(dt: number, body: PlayerBody, it: Intent, t: number): void {
    const wants = Math.abs(it.moveX) + Math.abs(it.moveZ) > 0.3 && !body.padFlight;
    this.wantsMove = wants;
    if (!wants) {
      this.stuckTime = 0;
      this.stuckStage = 0;
      this.progressTimer = 0;
      this.progressRef.copy(body.position);
      return;
    }
    this.progressTimer += dt;
    if (this.progressTimer >= 0.5) {
      const moved = Math.hypot(body.position.x - this.progressRef.x, body.position.z - this.progressRef.z);
      this.progressRef.copy(body.position);
      this.progressTimer = 0;
      if (moved < BOT.stuckMove) {
        this.stuckTime += 0.5;
        if (this.stuckTime >= BOT.stuckJump) {
          it.jump = true;
          it.jumpPressed = true;
          this.wiggleUntil = t + 0.35;
          this.wiggleDir = this.rnd() < 0.5 ? -1 : 1;
        }
        if (this.stuckTime > BOT.stuckNewGoal + 1) {
          // 목표를 바꿔도 못 벗어나면 처음 단계부터 다시
          this.stuckTime = BOT.stuckReplan;
          this.stuckStage = 0;
        }
      } else {
        this.stuckTime = 0;
        this.stuckStage = 0;
      }
    }
    if (t < this.wiggleUntil) {
      it.moveX = this.wiggleDir;
      it.moveZ = Math.max(it.moveZ, 0.3);
    }
  }

  // ------------------------------------------------------------ 시선·이동 도구

  /** 월드 방향(dx, dz)을 지금 시선 기준 입력으로. 시선과 무관하게 그 방향으로 걷는다 */
  private applyMove(body: PlayerBody, it: Intent, dx: number, dz: number): void {
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return;
    dx /= len;
    dz /= len;
    const s = Math.sin(body.yaw);
    const c = Math.cos(body.yaw);
    // forward = (−sin, −cos), right = (cos, −sin)
    it.moveZ = -s * dx - c * dz;
    it.moveX = c * dx - s * dz;
  }

  private turnTo(body: PlayerBody, yaw: number, pitch: number, dt: number): void {
    const max = this.skill.turnRateDeg * DEG * dt;
    const dy = wrapAngle(yaw - body.yaw);
    body.yaw = wrapAngle(body.yaw + Math.min(max, Math.max(-max, dy)));
    body.pitch += Math.min(max, Math.max(-max, pitch - body.pitch));
    body.pitch = Math.min(1.3, Math.max(-1.3, body.pitch));
  }

  private lookAt(body: PlayerBody, p: THREE.Vector3, dt: number): void {
    body.eyePosition(_eye);
    const dx = p.x - _eye.x;
    const dz = p.z - _eye.z;
    this.turnTo(body, Math.atan2(-dx, -dz), Math.atan2(p.y - _eye.y, Math.hypot(dx, dz)), dt);
  }

  private faceDir(body: PlayerBody, dx: number, dz: number, dt: number): void {
    this.turnTo(body, Math.atan2(-dx, -dz), 0, dt);
  }

  /** 걸으며 보는 곳: 소리가 난 쪽을 잠깐 돌아보고, 아니면 가는 방향 */
  private faceMove(body: PlayerBody, dt: number, t: number): void {
    if (t < this.lookUntil) {
      _q.copy(this.lookPos).setY(this.lookPos.y + CHEST);
      this.lookAt(body, _q, dt);
    } else {
      this.faceDir(body, this.wx, this.wz, dt);
    }
  }

  /** 서 있을 때: 소리가 난 쪽, 아니면 천천히 둘러본다 */
  private idleLook(dt: number, body: PlayerBody, t: number): void {
    if (t < this.lookUntil) {
      _q.copy(this.lookPos).setY(this.lookPos.y + CHEST);
      this.lookAt(body, _q, dt);
      return;
    }
    if (t >= this.scanFlipAt) {
      this.scanFlipAt = t + 1.5 + this.rnd() * 1.5;
      this.scanDir = this.rnd() < 0.5 ? -1 : 1;
    }
    body.yaw = wrapAngle(body.yaw + this.scanDir * BOT.scanRateDeg * DEG * dt);
    body.pitch *= Math.max(0, 1 - dt * 4);
  }

  private gauss(): number {
    const u = Math.max(1e-9, this.rnd());
    const v = this.rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

/** 눈에서 대상의 머리나 몸통이 보이는지(레이 최대 2개) */
function visibleFrom(col: GameMap['collision'], eye: THREE.Vector3, feet: THREE.Vector3): boolean {
  _q.copy(feet).setY(feet.y + HEAD);
  if (col.lineOfSight(eye, _q)) return true;
  _q.copy(feet).setY(feet.y + CHEST);
  return col.lineOfSight(eye, _q);
}
