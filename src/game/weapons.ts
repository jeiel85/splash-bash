import * as THREE from 'three';
import { BALLOON, TANK, WEAPONS, type WeaponDef } from '../config';
import type { Intent } from '../core/input';
import { mulberry32 } from '../core/rng';
import { WEAPON_IDS, type WeaponId } from '../types';

export type FireKind = WeaponId | 'balloon';

export interface FireRequest {
  kind: FireKind;
  seed: number;
  /** 퍼짐 배율(이동·공중 상태 반영). 원격 재현을 위해 함께 전송 */
  spread: number;
}

const _x = new THREE.Vector3(1, 0, 0);
const _y = new THREE.Vector3(0, 1, 0);
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();

/**
 * 탄 방향을 시드로 결정 — 원격 클라이언트도 같은 방향을 재현한다.
 * pattern 이 있으면(양동이) 가운데 1발 + 고정 링을 시드 각도만큼 회전, 없으면 원뿔 안 균일 분포.
 */
export function pelletDirections(def: WeaponDef, aim: THREE.Vector3, seed: number, spreadScale: number, out: THREE.Vector3[] = []): THREE.Vector3[] {
  const rnd = mulberry32(seed);
  const up = Math.abs(aim.y) > 0.99 ? _x : _y;
  _right.crossVectors(aim, up).normalize();
  _up.crossVectors(_right, aim).normalize();
  out.length = 0;
  const push = (angleRad: number, around: number) => {
    const t = Math.tan(angleRad);
    out.push(new THREE.Vector3().copy(aim).addScaledVector(_right, t * Math.cos(around)).addScaledVector(_up, t * Math.sin(around)).normalize());
  };
  if (def.pattern) {
    const rot = rnd() * Math.PI * 2;
    push(0, 0);
    for (const ring of def.pattern) {
      for (let i = 0; i < ring.count; i++) push(THREE.MathUtils.degToRad(ring.deg * spreadScale), rot + (i / ring.count) * Math.PI * 2);
    }
    return out;
  }
  const spread = THREE.MathUtils.degToRad(def.spreadDeg * spreadScale);
  for (let i = 0; i < def.pellets; i++) push(spread * Math.sqrt(rnd()), rnd() * Math.PI * 2);
  return out;
}

/**
 * 플레이어 한 명의 무기 상태(탱크 물, 쿨다운). 로컬 플레이어와 봇이 같은 규칙을 쓴다.
 * 물풍선도 탱크 물을 쓴다.
 */
export class Arsenal {
  current: WeaponId = 'soaker';
  tank: number = TANK.capacity;
  private cooldown = 0;
  private throwCooldown = 0;
  private sinceFire = 99;
  /** 물이 부족해 발사 못 했음(이번 tick) — UI·효과음 */
  dryFire = false;
  /** 방금 무기를 바꿨음(이번 tick) */
  switched = false;
  private readonly seedGen = mulberry32((Math.random() * 1e9) | 0);

  reset(): void {
    this.tank = TANK.capacity;
    this.cooldown = 0;
    this.throwCooldown = 0;
    this.sinceFire = 99;
  }

  get def(): WeaponDef {
    return WEAPONS[this.current];
  }

  get balloonReady(): boolean {
    return this.tank >= BALLOON.cost && this.throwCooldown <= 0;
  }

  /** 사격 직후 이동 속도 배율 */
  get moveScale(): number {
    return this.sinceFire < 0.3 ? this.def.moveScaleFiring : 1;
  }

  get lowWater(): boolean {
    return this.tank <= TANK.lowThreshold;
  }

  select(id: WeaponId): void {
    if (id === this.current) return;
    this.current = id;
    this.switched = true;
    this.cooldown = Math.max(this.cooldown, 0.25);
  }

  /**
   * @param refillRate 분수·수영장 보충 속도(초당). 0 이면 자연 회복만.
   * @param spreadScale 이동·공중 상태에 따른 퍼짐 배율(무기 def 의 spreadMoving/spreadAir 중 하나 또는 1)
   */
  tick(dt: number, intent: Intent, refillRate: number, canFire: boolean, state: 'still' | 'moving' | 'air'): FireRequest[] {
    this.dryFire = false;
    this.switched = false;
    const out: FireRequest[] = [];

    if (intent.weaponSlot !== null && WEAPON_IDS[intent.weaponSlot]) this.select(WEAPON_IDS[intent.weaponSlot]);
    if (intent.weaponCycle !== 0) {
      const i = WEAPON_IDS.indexOf(this.current);
      const n = WEAPON_IDS.length;
      this.select(WEAPON_IDS[(i + intent.weaponCycle + n) % n]);
    }

    this.cooldown -= dt;
    this.throwCooldown -= dt;
    this.sinceFire += dt;

    const def = this.def;
    const spread = state === 'air' ? def.spreadAir : state === 'moving' ? def.spreadMoving : 1;
    // 반자동: 새로 누르면 즉시, 누르고 있으면 간격보다 조금 느리게
    const wantsFire = def.automatic ? intent.fire : intent.firePressed || (intent.fire && this.cooldown <= -0.1);
    if (canFire && wantsFire && this.cooldown <= 0) {
      if (this.tank >= def.cost) {
        this.tank -= def.cost;
        this.cooldown = def.interval;
        this.sinceFire = 0;
        out.push({ kind: def.id, seed: this.nextSeed(), spread });
      } else if (intent.firePressed || def.automatic) {
        this.dryFire = true;
        this.cooldown = 0.3;
      }
    }

    if (canFire && intent.throwPressed) {
      if (this.balloonReady) {
        this.tank -= BALLOON.cost;
        this.throwCooldown = BALLOON.cooldown;
        this.sinceFire = 0;
        out.push({ kind: 'balloon', seed: this.nextSeed(), spread: 1 });
      } else if (this.throwCooldown <= 0) {
        this.dryFire = true;
      }
    }

    if (refillRate > 0) {
      this.tank = Math.min(TANK.capacity, this.tank + refillRate * dt);
    } else if (this.sinceFire > TANK.regenDelay) {
      this.tank = Math.min(TANK.capacity, this.tank + TANK.regenPerSec * dt);
    }
    return out;
  }

  private nextSeed(): number {
    return (this.seedGen() * 0xffffffff) >>> 0;
  }
}
