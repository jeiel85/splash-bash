import * as THREE from 'three';
import { BALLOON, PLAYER, STREAM, WEAPONS } from '../config';
import type { DamageSource, PeerId, TeamId, WeaponId } from '../types';
import type { CollisionWorld } from '../world/collision';
import { pelletDirections } from './weapons';

/** 투사체가 맞힐 수 있는 대상(사람·봇). pos 는 발바닥 중심 */
export interface HitTarget {
  id: PeerId;
  team: TeamId;
  alive: boolean;
  shielded: boolean;
  pos: THREE.Vector3;
}

export interface ProjectileHooks {
  /** 현재 판정 대상 목록 */
  targets(): readonly HitTarget[];
  /** 권한 있는 투사체가 대상을 맞힘(데미지 적용·전송은 호출자 몫) */
  onHit(shooter: PeerId, victim: PeerId, amount: number, source: DamageSource, dir: THREE.Vector3, point: THREE.Vector3): void;
  /** 월드 표면 충돌(시각 효과) */
  onImpact(point: THREE.Vector3, normal: THREE.Vector3, source: DamageSource, color: THREE.Color): void;
  /** 몸에 맞음(시각 효과, 권한 무관) */
  onBodySplash(point: THREE.Vector3, victim: PeerId, source: DamageSource, color: THREE.Color): void;
  /** 물풍선 폭발(시각 효과·넉백, 권한 무관) */
  onBurst(point: THREE.Vector3, shooter: PeerId, team: TeamId, color: THREE.Color): void;
}

interface Droplet {
  active: boolean;
  shooter: PeerId;
  team: TeamId;
  source: WeaponId;
  authoritative: boolean;
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  vel: THREE.Vector3;
  age: number;
  traveled: number;
  color: THREE.Color;
}

interface Balloon {
  active: boolean;
  shooter: PeerId;
  team: TeamId;
  authoritative: boolean;
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  vel: THREE.Vector3;
  age: number;
  spin: number;
  color: THREE.Color;
}

const MAX_DROPLETS = 1024;
const MAX_BALLOONS = 32;

const _dirs: THREE.Vector3[] = [];
const _seg = new THREE.Vector3();
const _hitDir = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _tmp = new THREE.Vector3();
const _closest = new THREE.Vector3();
const _center = new THREE.Vector3();
const _hit = { point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0 };

/**
 * 선분 p→q 와 캡슐 축(발 위 radius ~ height-radius 수직선) 사이 최단거리².
 * out 에는 선분 위 최근접점을 쓴다. 두 선분 최근접점 공식을 수직축에 특화해 계산한다.
 */
export function segCapsuleDistSq(p: THREE.Vector3, q: THREE.Vector3, feet: THREE.Vector3, out: THREE.Vector3): number {
  const y0 = feet.y + PLAYER.radius;
  const y1 = feet.y + PLAYER.height - PLAYER.radius;
  const dx = q.x - p.x, dy = q.y - p.y, dz = q.z - p.z;
  let best = Infinity;
  const test = (t: number) => {
    const x = p.x + dx * t, y = p.y + dy * t, z = p.z + dz * t;
    const cy = Math.min(Math.max(y, y0), y1);
    const ex = x - feet.x, ey = y - cy, ez = z - feet.z;
    const d = ex * ex + ey * ey + ez * ez;
    if (d < best) {
      best = d;
      out.set(x, y, z);
    }
  };
  test(0);
  test(1);
  const hl = dx * dx + dz * dz;
  if (hl > 1e-9) {
    const t = ((feet.x - p.x) * dx + (feet.z - p.z) * dz) / hl;
    if (t > 0 && t < 1) test(t);
  }
  // 캡슐 위·아래 끝 높이를 지나는 지점(수직 이동이 큰 경우)
  if (Math.abs(dy) > 1e-6) {
    for (const yy of [y0, y1]) {
      const t = (yy - p.y) / dy;
      if (t > 0 && t < 1) test(t);
    }
  }
  return best;
}

/** 이동 거리에 따른 적심 감소 */
export function soakAt(weapon: WeaponId, traveled: number): number {
  const d = WEAPONS[weapon];
  if (traveled <= d.falloffNear) return d.soakNear;
  if (traveled >= d.falloffFar) return d.soakFar;
  const k = (traveled - d.falloffNear) / (d.falloffFar - d.falloffNear);
  return d.soakNear + (d.soakFar - d.soakNear) * k;
}

/**
 * 물방울·물풍선 시뮬레이션. 모든 발사(내 것·원격·봇)를 같은 규칙으로 날린다.
 * authoritative=true 인 투사체만 onHit 으로 적심을 보고한다(쏜 사람 쪽 판정).
 * 탄도: straightTime 동안 직진 → 이후 공기저항(drag) + 중력으로 처짐. [스플래툰]
 */
export class ProjectileSystem {
  private readonly droplets: Droplet[] = [];
  private readonly balloons: Balloon[] = [];
  private cursor = 0;
  readonly dropletMesh: THREE.InstancedMesh;
  readonly balloonMesh: THREE.InstancedMesh;

  constructor(
    private readonly world: CollisionWorld,
    private readonly hooks: ProjectileHooks,
    balloonGeometry?: THREE.BufferGeometry,
    balloonMaterial?: THREE.Material,
  ) {
    for (let i = 0; i < MAX_DROPLETS; i++) {
      this.droplets.push({
        active: false, shooter: '', team: -1, source: 'pistol', authoritative: false,
        pos: new THREE.Vector3(), prev: new THREE.Vector3(), vel: new THREE.Vector3(), age: 0, traveled: 0, color: new THREE.Color(),
      });
    }
    for (let i = 0; i < MAX_BALLOONS; i++) {
      this.balloons.push({
        active: false, shooter: '', team: -1, authoritative: false,
        pos: new THREE.Vector3(), prev: new THREE.Vector3(), vel: new THREE.Vector3(), age: 0, spin: 0, color: new THREE.Color(),
      });
    }
    const dropMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 });
    this.dropletMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 2), dropMat, MAX_DROPLETS);
    this.dropletMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DROPLETS * 3), 3);
    this.dropletMesh.name = 'droplets';
    this.dropletMesh.frustumCulled = false;
    this.dropletMesh.count = 0;
    this.dropletMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    this.balloonMesh = new THREE.InstancedMesh(
      balloonGeometry ?? new THREE.SphereGeometry(BALLOON.radius, 16, 12),
      balloonMaterial ?? new THREE.MeshToonMaterial({ color: '#FF8AD8' }),
      MAX_BALLOONS,
    );
    this.balloonMesh.name = 'balloons';
    this.balloonMesh.frustumCulled = false;
    this.balloonMesh.count = 0;
    this.balloonMesh.castShadow = true;
    this.balloonMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }

  addTo(scene: THREE.Object3D): void {
    scene.add(this.dropletMesh, this.balloonMesh);
  }

  /**
   * 총 발사. origin 은 총구, aim 은 조준 방향(정규화).
   * @param advance 네트워크 지연 보정 — 이만큼(초) 이미 날아간 상태로 시작
   */
  fireGun(shooter: PeerId, team: TeamId, weapon: WeaponId, origin: THREE.Vector3, aim: THREE.Vector3, seed: number, spread: number,
    authoritative: boolean, color: THREE.Color, advance = 0): void {
    const def = WEAPONS[weapon];
    pelletDirections(def, aim, seed, spread, _dirs);
    for (const dir of _dirs) {
      const d = this.alloc();
      d.active = true;
      d.shooter = shooter;
      d.team = team;
      d.source = weapon;
      d.authoritative = authoritative;
      d.pos.copy(origin);
      d.prev.copy(origin);
      d.vel.copy(dir).multiplyScalar(def.speed);
      d.age = 0;
      d.traveled = 0;
      d.color.copy(color);
      if (advance > 0) this.stepDroplet(d, Math.min(advance, 0.2));
    }
  }

  throwBalloon(shooter: PeerId, team: TeamId, origin: THREE.Vector3, aim: THREE.Vector3, inherit: THREE.Vector3,
    authoritative: boolean, color: THREE.Color, advance = 0): void {
    const b = this.balloons.find((x) => !x.active) ?? this.balloons[0];
    b.active = true;
    b.shooter = shooter;
    b.team = team;
    b.authoritative = authoritative;
    b.pos.copy(origin);
    b.prev.copy(origin);
    b.vel.copy(aim).multiplyScalar(BALLOON.throwSpeed).addScaledVector(inherit, BALLOON.inheritVelocity);
    b.vel.y += BALLOON.throwUp;
    b.age = 0;
    b.spin = 0;
    b.color.copy(color);
    if (advance > 0) this.stepBalloon(b, Math.min(advance, 0.2));
  }

  update(dt: number): void {
    let n = 0;
    for (const d of this.droplets) {
      if (!d.active) continue;
      this.stepDroplet(d, dt);
      if (!d.active) continue;
      const speed = d.vel.length();
      _q.setFromUnitVectors(_z, _tmp.copy(d.vel).divideScalar(speed || 1));
      const r = WEAPONS[d.source].visualRadius;
      const stretch = 1 + Math.min(speed * 0.05, 2.5);
      _s.set(r, r, r * stretch);
      _m.compose(d.pos, _q, _s);
      this.dropletMesh.setMatrixAt(n, _m);
      this.dropletMesh.setColorAt(n, d.color);
      n++;
    }
    this.dropletMesh.count = n;
    this.dropletMesh.instanceMatrix.needsUpdate = true;
    if (this.dropletMesh.instanceColor) this.dropletMesh.instanceColor.needsUpdate = true;

    let m = 0;
    for (const b of this.balloons) {
      if (!b.active) continue;
      this.stepBalloon(b, dt);
      if (!b.active) continue;
      b.spin += dt * 8;
      _q.setFromAxisAngle(_tmp.set(1, 0, 0.3).normalize(), b.spin);
      _s.set(1, 1, 1);
      _m.compose(b.pos, _q, _s);
      this.balloonMesh.setMatrixAt(m++, _m);
    }
    this.balloonMesh.count = m;
    this.balloonMesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    this.droplets.forEach((d) => (d.active = false));
    this.balloons.forEach((b) => (b.active = false));
  }

  get activeCount(): number {
    return this.dropletMesh.count;
  }

  private alloc(): Droplet {
    for (let i = 0; i < MAX_DROPLETS; i++) {
      const idx = (this.cursor + i) % MAX_DROPLETS;
      if (!this.droplets[idx].active) {
        this.cursor = (idx + 1) % MAX_DROPLETS;
        return this.droplets[idx];
      }
    }
    const d = this.droplets[this.cursor];
    this.cursor = (this.cursor + 1) % MAX_DROPLETS;
    return d;
  }

  private stepDroplet(d: Droplet, dt: number): void {
    const def = WEAPONS[d.source];
    d.age += dt;
    if (d.age >= def.life) {
      d.active = false;
      return;
    }
    d.prev.copy(d.pos);
    if (d.age > def.straightTime) {
      d.vel.multiplyScalar(Math.exp(-STREAM.drag * dt));
      d.vel.y -= STREAM.gravity * dt;
    }
    d.pos.addScaledVector(d.vel, dt);
    _seg.subVectors(d.pos, d.prev);
    const len = _seg.length();
    if (len < 1e-6) return;
    _seg.divideScalar(len);

    const wh = this.world.raycast(d.prev, _seg, len, _hit);
    const worldDist = wh ? wh.distance : Infinity;

    const reach = STREAM.hitRadius + PLAYER.radius;
    let best: HitTarget | null = null;
    let bestAlong = Infinity;
    for (const t of this.hooks.targets()) {
      if (!t.alive || t.id === d.shooter) continue;
      if (d.team !== -1 && t.team === d.team) continue; // 같은 팀은 통과
      if (segCapsuleDistSq(d.prev, d.pos, t.pos, _closest) <= reach * reach) {
        const along = _closest.distanceTo(d.prev);
        if (along < bestAlong && along <= worldDist) {
          bestAlong = along;
          best = t;
        }
      }
    }
    if (best) {
      const point = _tmp.copy(d.prev).addScaledVector(_seg, bestAlong);
      this.hooks.onBodySplash(point, best.id, d.source, d.color);
      if (d.authoritative && !best.shielded) {
        _hitDir.copy(_seg);
        this.hooks.onHit(d.shooter, best.id, soakAt(d.source, d.traveled + bestAlong), d.source, _hitDir, point);
      }
      d.active = false;
      return;
    }
    if (wh) {
      this.hooks.onImpact(wh.point, wh.normal, d.source, d.color);
      d.active = false;
      return;
    }
    d.traveled += len;
  }

  private stepBalloon(b: Balloon, dt: number): void {
    b.age += dt;
    b.prev.copy(b.pos);
    b.vel.y -= BALLOON.gravity * dt;
    b.pos.addScaledVector(b.vel, dt);
    _seg.subVectors(b.pos, b.prev);
    const len = _seg.length();
    let burstAt: THREE.Vector3 | null = null;
    let direct: HitTarget | null = null;
    if (len > 1e-6) {
      _seg.divideScalar(len);
      const wh = this.world.raycast(b.prev, _seg, len + BALLOON.radius, _hit);
      const worldDist = wh ? wh.distance : Infinity;
      const reach = BALLOON.radius + PLAYER.radius;
      let bestAlong = Infinity;
      for (const t of this.hooks.targets()) {
        if (!t.alive || t.id === b.shooter) continue;
        if (b.team !== -1 && t.team === b.team) continue;
        if (segCapsuleDistSq(b.prev, b.pos, t.pos, _closest) <= reach * reach) {
          const along = _closest.distanceTo(b.prev);
          if (along < bestAlong && along <= worldDist) {
            bestAlong = along;
            direct = t;
          }
        }
      }
      if (direct) burstAt = _tmp.copy(b.prev).addScaledVector(_seg, bestAlong);
      else if (wh) burstAt = _tmp.copy(wh.point).addScaledVector(wh.normal, 0.1);
    }
    if (!burstAt && b.age >= BALLOON.fuse) burstAt = _tmp.copy(b.pos);
    if (burstAt) {
      b.active = false;
      this.burst(b, burstAt.clone(), direct);
    }
  }

  private burst(b: Balloon, at: THREE.Vector3, direct: HitTarget | null): void {
    this.hooks.onBurst(at, b.shooter, b.team, b.color);
    if (!b.authoritative) return;
    for (const t of this.hooks.targets()) {
      if (!t.alive || t.shielded || t.id === b.shooter) continue;
      if (b.team !== -1 && t.team === b.team) continue;
      _center.copy(t.pos).setY(t.pos.y + PLAYER.height * 0.5);
      _hitDir.subVectors(_center, at);
      const dist = Math.max(0, _hitDir.length() - PLAYER.radius);
      _hitDir.normalize();
      if (t === direct) {
        this.hooks.onHit(b.shooter, t.id, BALLOON.directSoak, 'balloon', _hitDir, _center);
        continue;
      }
      if (dist > BALLOON.blastRadius) continue;
      if (!this.world.lineOfSight(at, _center)) continue;
      const k = THREE.MathUtils.clamp((dist - 1) / (BALLOON.blastRadius - 1), 0, 1);
      const amount = BALLOON.blastNear + (BALLOON.blastFar - BALLOON.blastNear) * k;
      this.hooks.onHit(b.shooter, t.id, Math.round(amount), 'balloon', _hitDir, _center);
    }
  }
}
