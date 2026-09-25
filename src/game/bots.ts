import * as THREE from 'three';
import { PLAYER, TANK, WEAPONS } from '../config';
import { emptyIntent, type Intent } from '../core/input';
import { mulberry32 } from '../core/rng';
import type { PeerId, TeamId, WeaponId } from '../types';
import type { GameMap, Waypoint } from '../world/map';
import type { PlayerBody } from './playerBody';
import type { Arsenal } from './weapons';

/** 봇이 보는 다른 참가자 */
export interface BotPercept {
  id: PeerId;
  team: TeamId;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  alive: boolean;
  shielded: boolean;
}

export interface BotContext {
  map: GameMap;
  others: readonly BotPercept[];
  /** 게임 시각(초) */
  time: number;
}

const BOT_NAMES = ['보글보글', '찰랑이', '퐁당이', '물방울', '첨벙이', '촉촉이', '뽀송이', '출렁이', '방울방울', '졸졸이'];

export function botName(index: number): string {
  return BOT_NAMES[index % BOT_NAMES.length];
}

const _eye = new THREE.Vector3();
const _target = new THREE.Vector3();
const _dir = new THREE.Vector3();

type Mode = 'wander' | 'engage' | 'refill';

/**
 * 봇 두뇌(호스트에서만 실행). 사람과 같은 PlayerBody·Arsenal 을 Intent 로 조종한다.
 * 판단은 5Hz, 조준·이동은 매 프레임.
 */
export class BotBrain {
  private readonly rnd: () => number;
  private mode: Mode = 'wander';
  private path: Waypoint[] = [];
  private targetId: PeerId | null = null;
  private seenAt = 0;
  private reactionUntil = 0;
  private thinkTimer = 0;
  private strafeDir = 1;
  private strafeTimer = 0;
  private aimErrYaw = 0;
  private aimErrPitch = 0;
  private trackTime = 0;
  private stuckTimer = 0;
  private lastPos = new THREE.Vector3();
  lastAttacker: PeerId | null = null;
  readonly preferred: WeaponId;

  constructor(seed: number, readonly team: () => TeamId) {
    this.rnd = mulberry32(seed);
    const r = this.rnd();
    this.preferred = r < 0.6 ? 'soaker' : r < 0.85 ? 'bucket' : 'pistol';
  }

  reset(): void {
    this.mode = 'wander';
    this.path = [];
    this.targetId = null;
    this.trackTime = 0;
  }

  think(dt: number, body: PlayerBody, arsenal: Arsenal, ctx: BotContext): Intent {
    const intent = emptyIntent();
    this.thinkTimer -= dt;
    if (this.thinkTimer <= 0) {
      this.thinkTimer = 0.2 + this.rnd() * 0.05;
      this.decide(body, arsenal, ctx);
    }
    const target = this.targetId ? ctx.others.find((o) => o.id === this.targetId && o.alive) : undefined;
    if (!target && this.mode === 'engage') this.mode = 'wander';

    // 무기 선택
    const slot = (['pistol', 'soaker', 'bucket'] as const).indexOf(this.pickWeapon(body, target));
    if (arsenal.current !== ['pistol', 'soaker', 'bucket'][slot]) intent.weaponSlot = slot;

    if (this.mode === 'engage' && target) {
      this.engage(dt, body, arsenal, target, intent, ctx);
    } else {
      this.followPath(dt, body, intent, ctx);
      this.trackTime = 0;
    }

    // 끼임 감지 → 점프 + 경로 재계산
    if (body.position.distanceToSquared(this.lastPos) < 0.02 * dt * 60 && (intent.moveZ !== 0 || intent.moveX !== 0)) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 0.6) {
        intent.jump = true;
        intent.jumpPressed = true;
        if (this.stuckTimer > 1.5) {
          this.path = [];
          this.stuckTimer = 0;
        }
      }
    } else {
      this.stuckTimer = 0;
    }
    this.lastPos.copy(body.position);
    return intent;
  }

  private decide(body: PlayerBody, arsenal: Arsenal, ctx: BotContext): void {
    body.eyePosition(_eye);
    const myTeam = this.team();
    let best: BotPercept | null = null;
    let bestScore = Infinity;
    for (const o of ctx.others) {
      if (!o.alive || (myTeam !== -1 && o.team === myTeam)) continue;
      const d = o.pos.distanceTo(body.position);
      if (d > 30) continue;
      _target.copy(o.pos).setY(o.pos.y + PLAYER.height * 0.6);
      _dir.subVectors(_target, _eye).normalize();
      const fwd = body.aimDirection(new THREE.Vector3());
      const inCone = fwd.dot(_dir) > Math.cos(THREE.MathUtils.degToRad(55));
      const heard = o.id === this.lastAttacker || d < 12;
      if (!inCone && !heard) continue;
      if (!ctx.map.collision.lineOfSight(_eye, _target)) continue;
      const score = d - (o.id === this.lastAttacker ? 8 : 0) - (o.id === this.targetId ? 5 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = o;
      }
    }
    if (best && best.id !== this.targetId) {
      this.targetId = best.id;
      this.reactionUntil = ctx.time + 0.4 + this.rnd() * 0.3;
      this.aimErrYaw = this.gauss() * THREE.MathUtils.degToRad(4);
      this.aimErrPitch = this.gauss() * THREE.MathUtils.degToRad(3);
    }
    if (best) this.seenAt = ctx.time;
    else if (ctx.time - this.seenAt > 1.5) this.targetId = null;

    if (arsenal.tank < 25 && ctx.map.fountains.length + ctx.map.water.length > 0) {
      if (this.mode !== 'refill') this.path = [];
      this.mode = 'refill';
    } else if (this.mode === 'refill' && arsenal.tank < 90) {
      // 보충 계속(가까운 적이 있으면 싸움)
      if (best && best.pos.distanceTo(body.position) < 8) this.mode = 'engage';
    } else if (this.targetId) {
      this.mode = 'engage';
    } else {
      this.mode = 'wander';
    }
  }

  private pickWeapon(body: PlayerBody, target: BotPercept | undefined): WeaponId {
    if (!target) return this.preferred;
    const d = target.pos.distanceTo(body.position);
    if (d < 5) return this.preferred === 'pistol' ? 'pistol' : 'bucket';
    if (d > 16) return 'pistol';
    return this.preferred === 'bucket' ? 'soaker' : this.preferred;
  }

  private engage(dt: number, body: PlayerBody, arsenal: Arsenal, target: BotPercept, intent: Intent, ctx: BotContext): void {
    this.trackTime += dt;
    body.eyePosition(_eye);
    const def = WEAPONS[arsenal.current];
    const dist = target.pos.distanceTo(body.position);
    const flight = dist / def.speed;
    _target.copy(target.pos).addScaledVector(target.vel, flight * 0.5).setY(target.pos.y + PLAYER.height * 0.55);
    // 물줄기 처짐 보정(거리 비례로 약간 위를 조준)
    _target.y += Math.max(0, dist - def.speed * def.straightTime) * 0.06;
    _dir.subVectors(_target, _eye);
    const desiredYaw = Math.atan2(-_dir.x, -_dir.z);
    const desiredPitch = Math.atan2(_dir.y, Math.hypot(_dir.x, _dir.z));
    // 추적할수록 오차 감소, 대상이 옆으로 빠르면 오차 증가
    const decay = Math.max(0.5, 1 - this.trackTime / 1.5);
    const lateral = Math.abs(target.vel.x * Math.cos(desiredYaw) - target.vel.z * Math.sin(desiredYaw));
    const errScale = decay + lateral * 0.25;
    const yawGoal = desiredYaw + this.aimErrYaw * errScale;
    const pitchGoal = desiredPitch + this.aimErrPitch * errScale;
    const maxTurn = THREE.MathUtils.degToRad(200) * dt;
    let dy = yawGoal - body.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    body.yaw += THREE.MathUtils.clamp(dy, -maxTurn, maxTurn);
    body.pitch += THREE.MathUtils.clamp(pitchGoal - body.pitch, -maxTurn, maxTurn);
    body.pitch = THREE.MathUtils.clamp(body.pitch, -1.3, 1.3);

    const aimedWell = Math.abs(dy) < THREE.MathUtils.degToRad(6);
    const inRange = dist < def.falloffFar + 2;
    if (ctx.time > this.reactionUntil && aimedWell && inRange && !target.shielded && arsenal.tank > def.cost) {
      intent.fire = true;
      intent.firePressed = true;
    }
    // 물풍선: 5~12 m, 물 넉넉할 때 가끔
    if (dist > 5 && dist < 12 && arsenal.tank > TANK.capacity * 0.6 && this.rnd() < dt * 0.15) intent.throwPressed = true;

    // 선호 거리 유지 + 좌우 무빙
    const pref = arsenal.current === 'bucket' ? 3 : arsenal.current === 'pistol' ? 14 : 8;
    intent.moveZ = dist > pref + 2 ? 1 : dist < pref - 2 ? -0.6 : 0;
    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      this.strafeTimer = 0.6 + this.rnd() * 0.6;
      this.strafeDir = this.rnd() < 0.5 ? -1 : 1;
    }
    intent.moveX = this.strafeDir * 0.9;
    if (this.rnd() < dt * 0.1) {
      intent.jump = true;
      intent.jumpPressed = true;
    }
  }

  private followPath(dt: number, body: PlayerBody, intent: Intent, ctx: BotContext): void {
    if (!this.path.length) this.path = this.planPath(body.position, ctx);
    const next = this.path[0];
    if (!next) return;
    _dir.subVectors(next.pos, body.position);
    _dir.y = 0;
    const d = _dir.length();
    if (d < 1.2) {
      this.path.shift();
      return;
    }
    const desiredYaw = Math.atan2(-_dir.x, -_dir.z);
    let dy = desiredYaw - body.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    const maxTurn = THREE.MathUtils.degToRad(240) * dt;
    body.yaw += THREE.MathUtils.clamp(dy, -maxTurn, maxTurn);
    body.pitch *= 0.9;
    intent.moveZ = Math.abs(dy) < 1.2 ? 0.9 : 0.3;
    // 목표가 높은 곳이면 점프
    if (next.pos.y > body.position.y + 0.6 && d < 3) {
      intent.jump = true;
      intent.jumpPressed = true;
    }
  }

  private planPath(from: THREE.Vector3, ctx: BotContext): Waypoint[] {
    const wps = [...ctx.map.waypoints.values()];
    if (!wps.length) return [];
    const start = nearest(wps, from);
    let goal: Waypoint;
    if (this.mode === 'refill') {
      const refills = [...ctx.map.fountains.map((f) => f.pos), ...ctx.map.water.map((b) => b.getCenter(new THREE.Vector3()))];
      const spot = refills.reduce((a, b) => (a.distanceToSquared(from) < b.distanceToSquared(from) ? a : b));
      goal = nearest(wps, spot);
      const path = astar(ctx.map.waypoints, start, goal);
      return [...path, { id: '_refill', pos: spot.clone(), links: [] }];
    }
    goal = wps[Math.floor(this.rnd() * wps.length)];
    return astar(ctx.map.waypoints, start, goal);
  }

  private gauss(): number {
    const u = Math.max(1e-6, this.rnd());
    const v = this.rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

function nearest(wps: Waypoint[], p: THREE.Vector3): Waypoint {
  let best = wps[0];
  let bd = Infinity;
  for (const w of wps) {
    const d = w.pos.distanceToSquared(p);
    if (d < bd) {
      bd = d;
      best = w;
    }
  }
  return best;
}

/** 웨이포인트 A* (간선 비용 = 거리) */
export function astar(graph: Map<string, Waypoint>, start: Waypoint, goal: Waypoint): Waypoint[] {
  const open = new Set<string>([start.id]);
  const came = new Map<string, string>();
  const g = new Map<string, number>([[start.id, 0]]);
  const f = new Map<string, number>([[start.id, start.pos.distanceTo(goal.pos)]]);
  while (open.size) {
    let cur = '';
    let cf = Infinity;
    for (const id of open) {
      const v = f.get(id) ?? Infinity;
      if (v < cf) {
        cf = v;
        cur = id;
      }
    }
    if (cur === goal.id) {
      const path: Waypoint[] = [];
      for (let c: string | undefined = cur; c; c = came.get(c)) path.unshift(graph.get(c)!);
      return path.slice(1);
    }
    open.delete(cur);
    const node = graph.get(cur)!;
    for (const nid of node.links) {
      const n = graph.get(nid);
      if (!n) continue;
      const tentative = (g.get(cur) ?? Infinity) + node.pos.distanceTo(n.pos);
      if (tentative < (g.get(nid) ?? Infinity)) {
        came.set(nid, cur);
        g.set(nid, tentative);
        f.set(nid, tentative + n.pos.distanceTo(goal.pos));
        open.add(nid);
      }
    }
  }
  return [goal];
}
