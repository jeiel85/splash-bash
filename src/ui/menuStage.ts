import * as THREE from 'three';
import { PLAYER_COLORS } from '../config';
import { Avatar } from '../game/avatar';
import type { GameAssets } from '../render/assets';
import type { RenderContext } from '../render/renderer';
import { isInWater, type GameMap } from '../world/map';
import type { Profile } from './profile';

/** 캐릭터를 놓을 화면 영역: 중심(NDC −1..1)과 화면 높이 대비 캐릭터 높이(0..1) */
export interface StageFrame { x: number; y: number; h: number }

/** 메뉴 촬영 자리: 캐릭터 위치, 캐릭터→카메라 수평 방향, 벽에 막히지 않는 최대 카메라 거리 */
export interface MenuShot { spot: THREE.Vector3; toCam: THREE.Vector3; maxDist: number }

/** 이름표까지 포함한 캐릭터 높이(m)와 화면에 맞출 중심 높이 */
const CHAR_H = 2.15;
const CHAR_CENTER = 1.02;
/** 인물 사진처럼 좁은 화각(설정의 게임 FOV 와 별개) */
const MENU_FOV = 38;
const MAX_FOV = 70;
const CAM_DISTS = [2.4, 3.2, 4, 4.8, 5.6, 6.4, 7.2];
const MIN_DIST = 3.2;
const HOP_TIME = 0.42;
const HOP_HEIGHT = 0.35;

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const PROBES = [
  new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
];
const _o = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _cam = new THREE.Vector3();
const _vel = new THREE.Vector3();

function cameraHeight(dist: number): number {
  return 1.2 + dist * 0.07;
}

/** (x,z) 아래 바닥 높이. 평평한 바닥이 아니면 null */
function groundAt(map: GameMap, x: number, z: number, fromY: number): number | null {
  const hit = map.collision.raycast(_o.set(x, fromY, z), DOWN, 14);
  if (!hit || hit.normal.y < 0.85) return null;
  return hit.point.y;
}

/** 캐릭터가 서 있을 자리가 비어 있는지(몸통 높이에서 사방 0.5 m) */
function spotFree(map: GameMap, spot: THREE.Vector3): boolean {
  for (const h of [0.4, 1.2]) {
    _a.set(spot.x, spot.y + h, spot.z);
    for (let i = 0; i < 4; i++) if (map.collision.raycast(_a, PROBES[i], 0.5)) return false;
  }
  _a.set(spot.x, spot.y + 0.3, spot.z);
  return !map.collision.raycast(_a, UP, 1.9);
}

/** 카메라 자리가 벽 속이 아니고 캐릭터가 가려지지 않는지 */
function cameraOk(map: GameMap, spot: THREE.Vector3, cam: THREE.Vector3): boolean {
  for (const h of [0.5, CHAR_CENTER, 1.8]) {
    if (!map.collision.lineOfSight(_a.set(spot.x, spot.y + h, spot.z), cam)) return false;
  }
  for (const d of PROBES) if (map.collision.raycast(cam, d, 0.45)) return false;
  // 카메라 아래에 바닥이 있어야(맵 밖 허공 방지)
  return !!map.collision.raycast(cam, DOWN, 12);
}

/**
 * 화면에 크게 걸리는 가까운 물체(바닥 제외): 실제 시야(세로 38°, 16:9) 안을 격자로 쏘아
 * NEAR_CLUTTER 보다 가까이 맞은 정도를 더한다(0 = 트임). 가운데 열은 캐릭터 자리라 뺀다.
 */
const FAN_YAW = [-0.5, -0.3, 0.3, 0.5];
const FAN_PITCH = [0.12, -0.08, -0.28];
const NEAR_CLUTTER = 6;
function clutter(map: GameMap, spot: THREE.Vector3, toCam: THREE.Vector3, dist: number): number {
  _cam.copy(spot).addScaledVector(toCam, dist);
  _cam.y = spot.y + cameraHeight(dist);
  _b.set(spot.x, spot.y + CHAR_CENTER, spot.z).sub(_cam);
  const yaw0 = Math.atan2(-_b.x, -_b.z);
  const pitch0 = Math.atan2(_b.y, Math.hypot(_b.x, _b.z));
  let n = 0;
  for (const dy of FAN_YAW) {
    for (const dp of FAN_PITCH) {
      const yaw = yaw0 + dy;
      const pitch = pitch0 + dp;
      _a.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
      const hit = map.collision.raycast(_cam, _a, NEAR_CLUTTER);
      if (hit && hit.normal.y < 0.7) n += 1 - hit.distance / NEAR_CLUTTER;
    }
  }
  return n;
}

/** 이 방향으로 카메라를 얼마나 멀리 뺄 수 있는지(0 이면 불가) */
function maxCameraDist(map: GameMap, spot: THREE.Vector3, toCam: THREE.Vector3): number {
  let best = 0;
  for (const d of CAM_DISTS) {
    _cam.copy(spot).addScaledVector(toCam, d);
    _cam.y = spot.y + cameraHeight(d);
    // 좌우로 조금 흔들려도 괜찮은지 함께 본다
    if (!cameraOk(map, spot, _cam)) break;
    best = d;
  }
  return best;
}

/**
 * 메뉴 촬영 자리 고르기. 수영장이 있으면 수영장 가장자리에 캐릭터를 세우고, 카메라는 바깥쪽에서
 * 수영장을 등진 캐릭터를 바라본다(뒤로 수영장이 보이게). 해를 등진 역광을 피하려고 해 쪽 방향을 선호한다.
 * 없으면 스폰 지점 앞에서 가장 트인 방향을 쓴다.
 */
export function pickMenuShot(map: GameMap, sunDir: THREE.Vector3): MenuShot {
  let best: MenuShot | null = null;
  let bestScore = -Infinity;
  const consider = (spot: THREE.Vector3, toCam: THREE.Vector3, bonus: number) => {
    if (!spotFree(map, spot)) return;
    const maxDist = maxCameraDist(map, spot, toCam);
    if (maxDist < MIN_DIST) return;
    // 보통 쓰는 거리(약 5 m)에서 화면 가장자리가 가까운 물체로 막히면 감점
    const near = clutter(map, spot, toCam, Math.min(maxDist, 5.2));
    const score = bonus + toCam.dot(sunDir) * 1.5 + maxDist / CAM_DISTS[CAM_DISTS.length - 1] - near * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = { spot: spot.clone(), toCam: toCam.clone(), maxDist };
    }
  };

  const pool = map.water.reduce<THREE.Box3 | null>((acc, b) => {
    const area = (b.max.x - b.min.x) * (b.max.z - b.min.z);
    return !acc || area > (acc.max.x - acc.min.x) * (acc.max.z - acc.min.z) ? b : acc;
  }, null);
  if (pool) {
    const cx = (pool.min.x + pool.max.x) / 2;
    const cz = (pool.min.z + pool.max.z) / 2;
    const hx = (pool.max.x - pool.min.x) / 2;
    const hz = (pool.max.z - pool.min.z) / 2;
    const surface = pool.max.y;
    const poolCenter = new THREE.Vector3(cx, surface + 0.3, cz);
    const u = new THREE.Vector3();
    const spot = new THREE.Vector3();
    const steps = 24;
    for (let k = 0; k < steps; k++) {
      const th = (k / steps) * Math.PI * 2;
      u.set(Math.cos(th), 0, Math.sin(th));
      const rx = Math.abs(u.x) > 1e-3 ? hx / Math.abs(u.x) : Infinity;
      const rz = Math.abs(u.z) > 1e-3 ? hz / Math.abs(u.z) : Infinity;
      const edge = Math.min(rx, rz);
      for (const margin of [1.2, 1.9, 2.7]) {
        const x = cx + u.x * (edge + margin);
        const z = cz + u.z * (edge + margin);
        const gy = groundAt(map, x, z, surface + 6);
        if (gy === null || gy < surface - 0.2 || gy > surface + 2.5) continue;
        spot.set(x, gy, z);
        if (isInWater(map, _b.set(x, gy + 0.3, z))) continue;
        // 카메라에서 수영장이 보이면 가산점
        _cam.copy(spot).addScaledVector(u, 4);
        _cam.y = gy + cameraHeight(4);
        const poolVisible = map.collision.lineOfSight(_cam, poolCenter);
        consider(spot, u, (poolVisible ? 1.2 : 0) - margin * 0.1);
      }
    }
  }
  if (!best) {
    for (const sp of map.spawns) {
      const fwd = new THREE.Vector3(-Math.sin(sp.yaw), 0, -Math.cos(sp.yaw));
      for (const turn of [0, 0.5, -0.5, 1, -1]) {
        consider(sp.pos, fwd.clone().applyAxisAngle(UP, turn), -Math.abs(turn) * 0.3);
      }
    }
  }
  if (best) return best;
  // 마지막 수단: 첫 스폰 앞 짧은 거리(맵이 비정상적으로 좁을 때)
  const sp = map.spawns[0];
  console.warn('[menuStage] 트인 촬영 자리를 찾지 못해 첫 스폰을 씁니다');
  return { spot: sp.pos.clone(), toCam: new THREE.Vector3(-Math.sin(sp.yaw), 0, -Math.cos(sp.yaw)), maxDist: CAM_DISTS[0] };
}

/**
 * 메인 메뉴 배경: 실제 맵의 트인 자리(수영장 가장자리)에 내 캐릭터를 세우고, 메뉴 레이아웃의 빈 칸에 맞춰 카메라를 둔다.
 * 꾸미기(색·모자)를 바꾸면 즉시 반영되고 캐릭터가 통 튀어 오른다.
 */
export class MenuStage {
  private readonly avatar: Avatar;
  private readonly shot: MenuShot;
  private readonly look = new THREE.Vector3();
  private t = 0;
  private active = false;
  private hopT = HOP_TIME;
  private spinT = 1;
  private hat: string;
  private color: number;
  private reduceMotion = false;
  private frame: StageFrame = { x: -0.1, y: 0, h: 0.5 };

  constructor(private readonly ctx: RenderContext, assets: GameAssets, private readonly map: GameMap, profile: Profile) {
    this.avatar = new Avatar(assets, profile.name, PLAYER_COLORS[profile.cosmetics.color], profile.cosmetics.hat);
    this.avatar.root.visible = false;
    this.hat = profile.cosmetics.hat;
    this.color = profile.cosmetics.color;
    const sun = _a.copy(ctx.sun.position).sub(ctx.sun.target.position).setY(0);
    if (sun.lengthSq() < 1e-6) sun.set(1, 0, 0);
    this.shot = pickMenuShot(map, sun.normalize().clone());
  }

  /** 꾸미기 반영(미리보기 포함). 색·모자가 바뀌었으면 통 튀어 오른다 */
  setProfile(p: Profile): void {
    const hatChanged = p.cosmetics.hat !== this.hat;
    const colorChanged = p.cosmetics.color !== this.color;
    this.avatar.setIdentity(p.name, PLAYER_COLORS[p.cosmetics.color], p.cosmetics.hat);
    this.hat = p.cosmetics.hat;
    this.color = p.cosmetics.color;
    if ((hatChanged || colorChanged) && !this.reduceMotion) {
      this.hopT = 0;
      if (hatChanged) this.spinT = 0;
    }
  }

  setReduceMotion(v: boolean): void {
    this.reduceMotion = v;
  }

  /** 메뉴 레이아웃의 캐릭터 칸(화면 좌표)에 맞춘다 */
  setFrame(f: StageFrame): void {
    this.frame = f;
  }

  enter(): void {
    if (this.active) return;
    this.active = true;
    this.ctx.scene.add(this.map.root, this.avatar.root);
    this.avatar.root.visible = true;
    this.hopT = HOP_TIME;
    this.spinT = 1;
  }

  exit(): void {
    if (!this.active) return;
    this.active = false;
    this.ctx.scene.remove(this.avatar.root);
    // 맵 루트는 게임이 다시 추가한다
    this.ctx.scene.remove(this.map.root);
  }

  update(dt: number): void {
    if (!this.active) return;
    this.t += dt;
    const cam = this.ctx.camera;
    const { spot, toCam, maxDist } = this.shot;
    const f = this.frame;

    // 캐릭터가 칸 높이를 채우도록 거리 계산. 벽 때문에 못 물러나면 화각을 넓혀 맞춘다
    let vHalf = Math.tan(THREE.MathUtils.degToRad(MENU_FOV / 2));
    const h = THREE.MathUtils.clamp(f.h, 0.2, 0.8);
    let dist = CHAR_H / (h * 2 * vHalf);
    if (dist > maxDist) {
      dist = maxDist;
      vHalf = Math.min(Math.tan(THREE.MathUtils.degToRad(MAX_FOV / 2)), CHAR_H / (h * 2 * dist));
    }
    dist = Math.max(dist, CAM_DISTS[0]);
    const fov = THREE.MathUtils.radToDeg(Math.atan(vHalf) * 2);
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }

    // 아주 느린 호흡(움직임 줄이기면 멈춤)
    const drift = this.reduceMotion ? 0 : Math.sin(this.t * 0.4) * 0.12;
    cam.position.copy(spot).addScaledVector(toCam, dist);
    cam.position.x += -toCam.z * drift;
    cam.position.z += toCam.x * drift;
    cam.position.y = spot.y + cameraHeight(dist) + (this.reduceMotion ? 0 : Math.sin(this.t * 0.27) * 0.04);

    // 캐릭터 중심이 화면의 (f.x, f.y) 에 오도록 시선 각도를 비튼다
    this.look.set(spot.x, spot.y + CHAR_CENTER, spot.z).sub(cam.position);
    const yaw = Math.atan2(-this.look.x, -this.look.z);
    const pitch = Math.atan2(this.look.y, Math.hypot(this.look.x, this.look.z));
    const hHalf = vHalf * cam.aspect;
    const a = Math.atan(THREE.MathUtils.clamp(f.x, -0.9, 0.9) * hHalf);
    const b = Math.atan(THREE.MathUtils.clamp(f.y, -0.9, 0.9) * vHalf);
    cam.rotation.set(pitch - b, yaw + a, 0, 'YXZ');

    // 캐릭터: 카메라를 보되 화면 가운데 쪽으로 살짝 몸을 돌린 3/4 자세
    const faceCam = Math.atan2(toCam.x, toCam.z) - Math.PI;
    let turn = -a * 0.9 + 0.2 + (this.reduceMotion ? 0 : Math.sin(this.t * 0.55) * 0.12);
    if (this.spinT < 1) {
      this.spinT = Math.min(1, this.spinT + dt / 0.5);
      const e = 1 - Math.pow(1 - this.spinT, 3);
      turn += e * Math.PI * 2;
    }
    let hop = 0;
    let vy = 0;
    let grounded = true;
    if (this.hopT < HOP_TIME) {
      this.hopT += dt;
      const k = Math.min(1, this.hopT / HOP_TIME);
      hop = 4 * HOP_HEIGHT * k * (1 - k);
      vy = (4 * HOP_HEIGHT * (1 - 2 * k)) / HOP_TIME;
      grounded = k >= 1;
      if (grounded) vy = -6;
    }
    _b.copy(spot);
    _b.y += hop;
    this.avatar.update(dt, {
      pos: _b, vel: _vel.set(0, vy, 0), yaw: faceCam + turn, pitch: 0, grounded,
      soak: 0, alive: true, shielded: false, weapon: 'soaker',
    });
    this.ctx.followShadow(spot);
  }
}

