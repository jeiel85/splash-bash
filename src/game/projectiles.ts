import * as THREE from 'three';
import { BALLOON, PLAYER, STREAM, WEAPONS } from '../config';
import type { DamageSource, PeerId, TeamId, WeaponId } from '../types';
import type { CollisionWorld } from '../world/collision';
import { makeDropGeometry, makeDropMaterial } from '../render/fx';
import { PROP_OUTLINE } from '../render/assets';
import { applyBaseToon, ensureOutlineNormals, getGradientMap, makeOutlineMaterial } from '../render/toon';
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
  /** 뒤 방울 출렁임 위상(시각 전용) */
  wobble: number;
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
/**
 * 물방울 하나를 머리 + 뒤따르는 작은 방울들로 그린다. 판정은 머리 하나지만 화면에서는 방울이 줄줄이 이어져
 * 물줄기로 읽힌다(레이저 같은 긴 막대가 아니라 출렁이는 물). delay: 머리보다 이만큼(초) 뒤처진 자리, size: 머리 대비 크기
 */
const BLOBS = [
  { delay: 0, size: 1 },
  { delay: 0.01, size: 0.86 },
  { delay: 0.021, size: 0.74 },
  { delay: 0.033, size: 0.64 },
  { delay: 0.046, size: 0.54 },
  { delay: 0.06, size: 0.44 },
] as const;
/** 방울마다 꼬리 길이 = 속도 × 이 시간(초), 상한(m) */
const TAIL_TIME = 0.008;
const TAIL_MAX = 0.32;
/** 뒤 방울이 옆으로 출렁이는 폭(방울 반지름 배수) */
const WOBBLE = 0.45;

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
const _col = new THREE.Color();
const _side = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _x = new THREE.Vector3(1, 0, 0);
const _hsl = { h: 0, s: 0, l: 0 };

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
  private activeDroplets = 0;
  private readonly sharedBalloonGeometry: boolean;
  readonly dropletMesh: THREE.InstancedMesh;
  readonly balloonMesh: THREE.InstancedMesh;
  private readonly dropletTail: THREE.InstancedBufferAttribute;
  private readonly balloonOutline: THREE.InstancedMesh;

  constructor(
    private readonly world: CollisionWorld,
    private readonly hooks: ProjectileHooks,
    balloonGeometry?: THREE.BufferGeometry,
    balloonMaterial?: THREE.Material,
  ) {
    for (let i = 0; i < MAX_DROPLETS; i++) {
      this.droplets.push({
        active: false, shooter: '', team: -1, source: 'pistol', authoritative: false,
        pos: new THREE.Vector3(), prev: new THREE.Vector3(), vel: new THREE.Vector3(), age: 0, traveled: 0, color: new THREE.Color(), wobble: 0,
      });
    }
    for (let i = 0; i < MAX_BALLOONS; i++) {
      this.balloons.push({
        active: false, shooter: '', team: -1, authoritative: false,
        pos: new THREE.Vector3(), prev: new THREE.Vector3(), vel: new THREE.Vector3(), age: 0, spin: 0, color: new THREE.Color(),
      });
    }
    // 물줄기: 꼬리 달린 물방울(인스턴싱 1 드로우콜). 꼬리 길이는 인스턴스 속성 aTail
    const cap = MAX_DROPLETS * BLOBS.length;
    this.dropletMesh = new THREE.InstancedMesh(makeDropGeometry(2), makeDropMaterial(), cap);
    this.dropletMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.dropletMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.dropletTail = new THREE.InstancedBufferAttribute(new Float32Array(cap).fill(1), 1);
    this.dropletTail.setUsage(THREE.DynamicDrawUsage);
    this.dropletMesh.geometry.setAttribute('aTail', this.dropletTail);
    this.dropletMesh.name = 'droplets';
    this.dropletMesh.frustumCulled = false;
    this.dropletMesh.count = 0;
    this.dropletMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    // 물풍선: 템플릿 머티리얼을 흰색으로 복제해 던진 사람 색(인스턴스 색)으로 칠하고, 같은 행렬로 외곽선도 그린다
    this.sharedBalloonGeometry = balloonGeometry !== undefined;
    const geo = balloonGeometry ?? new THREE.SphereGeometry(BALLOON.radius, 16, 12);
    let mat: THREE.Material;
    if (balloonMaterial && (balloonMaterial as THREE.MeshToonMaterial).isMeshToonMaterial) {
      const m = (balloonMaterial as THREE.MeshToonMaterial).clone();
      m.color.set(0xffffff);
      applyBaseToon(m);
      mat = m;
    } else {
      const m = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: getGradientMap() });
      applyBaseToon(m);
      mat = m;
    }
    this.balloonMesh = new THREE.InstancedMesh(geo, mat, MAX_BALLOONS);
    this.balloonMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BALLOONS * 3), 3);
    this.balloonMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.balloonMesh.name = 'balloons';
    this.balloonMesh.frustumCulled = false;
    this.balloonMesh.count = 0;
    this.balloonMesh.castShadow = true;
    this.balloonMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    ensureOutlineNormals(geo);
    this.balloonOutline = new THREE.InstancedMesh(geo, makeOutlineMaterial(PROP_OUTLINE), MAX_BALLOONS);
    this.balloonOutline.instanceMatrix = this.balloonMesh.instanceMatrix;
    this.balloonOutline.frustumCulled = false;
    this.balloonOutline.count = 0;
    this.balloonOutline.userData.isOutline = true;
    this.balloonMesh.add(this.balloonOutline);
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
    for (let i = 0; i < _dirs.length; i++) {
      const dir = _dirs[i];
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
      d.wobble = ((seed + i * 97) % 628) / 100;
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
    let active = 0;
    for (const d of this.droplets) {
      if (!d.active) continue;
      this.stepDroplet(d, dt);
      if (!d.active) continue;
      active++;
      const speed = d.vel.length();
      _tmp.copy(d.vel).divideScalar(speed || 1);
      _q.setFromUnitVectors(_z, _tmp);
      const r = WEAPONS[d.source].visualRadius;
      // 출렁임 방향: 진행 방향에 수직(거의 수직으로 날면 x 축 기준)
      _side.crossVectors(_tmp, Math.abs(_tmp.y) > 0.95 ? _x : _up).normalize();
      for (let k = 0; k < BLOBS.length; k++) {
        const blob = BLOBS[k];
        const back = speed * blob.delay;
        // 총구 뒤로는 그리지 않는다
        if (back > 0 && back > d.traveled) break;
        const rb = r * blob.size;
        const tail = Math.min(speed * TAIL_TIME, TAIL_MAX, Math.max(0, d.traveled - back));
        const wob = k === 0 ? 0 : Math.sin(d.age * 38 + k * 1.9 + d.wobble) * r * WOBBLE;
        _center.copy(d.pos).addScaledVector(_tmp, -back).addScaledVector(_side, wob);
        _s.setScalar(rb);
        _m.compose(_center, _q, _s);
        this.dropletMesh.setMatrixAt(n, _m);
        this.dropletMesh.setColorAt(n, d.color);
        this.dropletTail.setX(n, 1 + tail / rb);
        n++;
      }
    }
    this.dropletMesh.count = n;
    this.activeDroplets = active;
    if (n > 0) {
      this.dropletMesh.instanceMatrix.needsUpdate = true;
      this.dropletTail.needsUpdate = true;
      if (this.dropletMesh.instanceColor) this.dropletMesh.instanceColor.needsUpdate = true;
    }

    let m = 0;
    for (const b of this.balloons) {
      if (!b.active) continue;
      this.stepBalloon(b, dt);
      if (!b.active) continue;
      b.spin += dt * 8;
      _q.setFromAxisAngle(_tmp.set(1, 0, 0.3).normalize(), b.spin);
      // 말랑하게 출렁이는 물풍선
      const wob = Math.sin(b.age * 22) * 0.07;
      _s.set(1 + wob, 1 - wob, 1 + wob * 0.5);
      _m.compose(b.pos, _q, _s);
      this.balloonMesh.setMatrixAt(m, _m);
      // 물줄기 색(물빛에 섞인 색)을 풍선답게 진하게
      _col.copy(b.color).getHSL(_hsl);
      _col.setHSL(_hsl.h, Math.max(_hsl.s, 0.75), 0.64);
      this.balloonMesh.setColorAt(m, _col);
      m++;
    }
    this.balloonMesh.count = m;
    this.balloonOutline.count = m;
    if (m > 0) {
      this.balloonMesh.instanceMatrix.needsUpdate = true;
      if (this.balloonMesh.instanceColor) this.balloonMesh.instanceColor.needsUpdate = true;
    }
  }

  clear(): void {
    this.droplets.forEach((d) => (d.active = false));
    this.balloons.forEach((b) => (b.active = false));
    this.activeDroplets = 0;
    this.dropletMesh.count = 0;
    this.balloonMesh.count = 0;
    this.balloonOutline.count = 0;
  }

  /**
   * 씬에서 빼고 이 시스템이 만든 GPU 자원을 해제한다.
   * 물풍선 지오메트리는 무기 템플릿과 공유하므로(생성자 인자) 해제하지 않는다.
   */
  dispose(): void {
    this.clear();
    this.dropletMesh.removeFromParent();
    this.balloonMesh.removeFromParent();
    this.dropletMesh.geometry.dispose();
    (this.dropletMesh.material as THREE.Material).dispose();
    (this.balloonMesh.material as THREE.Material).dispose();
    (this.balloonOutline.material as THREE.Material).dispose();
    if (!this.sharedBalloonGeometry) this.balloonMesh.geometry.dispose();
    this.dropletMesh.dispose();
    this.balloonMesh.dispose();
  }

  /** 날고 있는 물방울 수(그리기용 방울 수가 아니라 판정 단위) */
  get activeCount(): number {
    return this.activeDroplets;
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
