import * as THREE from 'three';
import { PLAYER } from '../config';
import type { DamageSource, PeerId, PlayerInfo, PlayerSnapshot, WeaponId } from '../types';
import { SnapshotBuffer, type InterpState } from '../net/interp';
import type { Avatar } from './avatar';
import type { BotBrain } from './bots';
import { PlayerBody } from './playerBody';
import { Arsenal } from './weapons';
import type { CollisionWorld } from '../world/collision';

/**
 * 젖음(체력)·부활·보호막 규칙. 자기 몸의 권한자(로컬 플레이어, 호스트의 봇)가 쓴다.
 */
export class Vitality {
  soak = 0;
  alive = true;
  respawnIn = 0;
  shieldIn = 0;
  private sinceHit = 99;
  lastAttacker: PeerId | null = null;
  lastSource: DamageSource = 'soaker';

  get shielded(): boolean {
    return this.alive && this.shieldIn > 0;
  }

  /** @returns 이번 피격으로 쓰러졌으면 true */
  applyHit(amount: number, shooter: PeerId, source: DamageSource): boolean {
    if (!this.alive || this.shielded || amount <= 0) return false;
    this.soak = Math.min(PLAYER.maxSoak, this.soak + amount);
    this.sinceHit = 0;
    this.lastAttacker = shooter;
    this.lastSource = source;
    if (this.soak >= PLAYER.maxSoak) {
      this.alive = false;
      this.respawnIn = PLAYER.respawnDelay;
      return true;
    }
    return false;
  }

  /** 쏘면 보호막 해제 */
  breakShield(): void {
    this.shieldIn = 0;
  }

  spawn(): void {
    this.soak = 0;
    this.alive = true;
    this.respawnIn = 0;
    this.shieldIn = PLAYER.spawnProtection;
    this.sinceHit = 99;
    this.lastAttacker = null;
  }

  /** @returns 부활 시점이 되었으면 true */
  tick(dt: number): boolean {
    if (!this.alive) {
      this.respawnIn -= dt;
      return this.respawnIn <= 0;
    }
    this.shieldIn = Math.max(0, this.shieldIn - dt);
    this.sinceHit += dt;
    if (this.sinceHit > PLAYER.regenDelay && this.soak > 0) this.soak = Math.max(0, this.soak - PLAYER.regenPerSec * dt);
    return false;
  }
}

/** 다른 사람(또는 호스트가 아닐 때의 봇) — 네트워크 스냅샷을 보간해 보여 준다 */
export class RemoteActor {
  readonly kind = 'remote' as const;
  readonly buffer = new SnapshotBuffer();
  readonly interp: InterpState = { px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, snap: null as unknown as PlayerSnapshot };
  readonly pos = new THREE.Vector3(0, -1000, 0);
  readonly vel = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  alive = false;
  shielded = false;
  grounded = true;
  soak = 0;
  weapon: WeaponId = 'soaker';
  hasData = false;
  constructor(public info: PlayerInfo, public avatar: Avatar) {}

  sample(renderT: number): void {
    if (!this.buffer.sample(renderT, this.interp)) return;
    const s = this.interp.snap;
    this.hasData = true;
    this.pos.set(this.interp.px, this.interp.py, this.interp.pz);
    this.vel.set(this.interp.vx, this.interp.vy, this.interp.vz);
    this.yaw = this.interp.yaw;
    this.pitch = this.interp.pitch;
    this.alive = s.alive;
    this.shielded = s.shielded;
    this.grounded = s.grounded;
    this.soak = s.soak;
    this.weapon = s.weapon;
  }
}

/** 호스트가 시뮬레이션하는 봇 */
export class BotActor {
  readonly kind = 'bot' as const;
  readonly body: PlayerBody;
  readonly arsenal = new Arsenal();
  readonly vitality = new Vitality();
  lastSpawn: unknown = null;
  constructor(public info: PlayerInfo, public avatar: Avatar, public brain: BotBrain, world: CollisionWorld) {
    this.body = new PlayerBody(world);
  }

  get pos(): THREE.Vector3 {
    return this.body.position;
  }

  snapshot(t: number): PlayerSnapshot {
    const b = this.body;
    return {
      t, px: b.position.x, py: b.position.y, pz: b.position.z,
      vx: b.velocity.x, vy: b.velocity.y, vz: b.velocity.z,
      yaw: b.yaw, pitch: b.pitch, weapon: this.arsenal.current,
      soak: this.vitality.soak / PLAYER.maxSoak, tank: this.arsenal.tank / 100,
      alive: this.vitality.alive, grounded: b.grounded, shielded: this.vitality.shielded,
    };
  }
}
