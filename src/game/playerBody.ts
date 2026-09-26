import * as THREE from 'three';
import { PLAYER, SLIDE } from '../config';
import type { Intent } from '../core/input';
import { makeContact, type CollisionWorld } from '../world/collision';

const MAX_SUBSTEP = 1 / 120;
const DOWN = new THREE.Vector3(0, -1, 0);

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _contact = makeContact();

/**
 * 캡슐 플레이어 물리. 로컬 플레이어와 봇(호스트)이 같은 코드를 쓴다.
 * position 은 발바닥 중심(캡슐 맨 아래).
 */
export class PlayerBody {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  grounded = false;
  /** 이번 스텝에 착지했을 때의 낙하 속도. 착지 없으면 0 */
  landedSpeed = 0;
  /** 이번 스텝에 점프했는지 */
  jumped = false;
  /** 이번 스텝에 슬라이드를 시작했는지 */
  slideStarted = false;
  /** 외부 이동 속도 배율(물속·사격 중) */
  speedScale = 1;
  /** 점프대 비행 중(공중 제어 약화) */
  padFlight = false;
  private coyote = 0;
  private jumpBuffer = 0;
  private slideTime = 0;
  private slideCooldown = 0;
  private slideDir = new THREE.Vector3();
  private slideSpeed = 0;
  /** 눈높이(슬라이드 시 부드럽게 낮아짐) */
  eyeHeight: number = PLAYER.eyeHeight;

  constructor(private readonly world: CollisionWorld) {}

  get sliding(): boolean {
    return this.slideTime > 0;
  }

  teleport(pos: THREE.Vector3, yaw: number): void {
    this.position.copy(pos);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.grounded = false;
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.slideTime = 0;
    this.padFlight = false;
    this.eyeHeight = PLAYER.eyeHeight;
  }

  /** 외부 충격(점프대, 물풍선 넉백) */
  launch(vy: number, horizontal?: THREE.Vector3, padFlight = false): void {
    if (vy > 0) this.velocity.y = Math.max(this.velocity.y, vy);
    if (horizontal) this.velocity.add(horizontal);
    this.grounded = false;
    this.coyote = 0;
    this.slideTime = 0;
    this.padFlight = padFlight;
  }

  forward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  /** 시선 방향(피치 포함) */
  aimDirection(out: THREE.Vector3): THREE.Vector3 {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  eyePosition(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.position).setY(this.position.y + this.eyeHeight);
  }

  step(dt: number, intent: Intent): void {
    this.landedSpeed = 0;
    this.jumped = false;
    this.slideStarted = false;
    this.slideCooldown = Math.max(0, this.slideCooldown - dt);
    if (intent.jumpPressed) this.jumpBuffer = PLAYER.jumpBuffer;
    else this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);

    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    let mx = intent.moveX;
    let mz = intent.moveZ;
    const len = Math.hypot(mx, mz);
    if (len > 1) { mx /= len; mz /= len; }
    const hasInput = len > 0.01;
    const back = mz < -0.1 ? PLAYER.backpedalScale : 1;
    // forward = (-sin, 0, -cos), right = (cos, 0, -sin)
    _wish.set(-sin * mz + cos * mx, 0, -cos * mz - sin * mx).multiplyScalar(PLAYER.walkSpeed * this.speedScale * back);

    // 슬라이드 시작. 바닥 판정은 코요테 타임만큼 너그럽게(작은 턱·경사 꼭대기에서 한 프레임 뜬 순간에 누른 입력도 받는다)
    const hSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    const footing = this.grounded || this.coyote > 0;
    if (intent.slidePressed && footing && this.slideTime <= 0 && this.slideCooldown <= 0 && hSpeed >= SLIDE.minSpeed && this.speedScale >= 1) {
      this.slideTime = SLIDE.duration;
      this.slideSpeed = Math.min(SLIDE.maxSpeed, Math.max(hSpeed * SLIDE.boost, SLIDE.minSlideSpeed));
      this.slideDir.set(this.velocity.x / hSpeed, 0, this.velocity.z / hSpeed);
      this.slideStarted = true;
    }

    if (this.slideTime > 0) {
      this.slideTime -= dt;
      this.slideSpeed = Math.max(0, this.slideSpeed - SLIDE.decel * dt);
      // 제한된 조향: 원하는 방향 쪽으로 최대 steer*dt 만큼 회전
      if (hasInput) {
        const target = Math.atan2(_wish.x, _wish.z);
        const cur = Math.atan2(this.slideDir.x, this.slideDir.z);
        let d = target - cur;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        const a = cur + THREE.MathUtils.clamp(d, -SLIDE.steer * dt, SLIDE.steer * dt);
        this.slideDir.set(Math.sin(a), 0, Math.cos(a));
      }
      this.velocity.x = this.slideDir.x * this.slideSpeed;
      this.velocity.z = this.slideDir.z * this.slideSpeed;
      // 한 프레임 바닥을 놓친 것(턱·경사 꼭대기)으로는 끊지 않고, 코요테 타임보다 오래 떠 있을 때만 끝낸다(수평 관성은 유지)
      if (this.slideTime <= 0 || !footing) {
        this.slideTime = 0;
        this.slideCooldown = SLIDE.cooldown;
      }
    } else if (this.grounded || hasInput) {
      const accel = this.grounded ? (hasInput ? PLAYER.groundAccel : PLAYER.groundDecel) : PLAYER.airAccel * (this.padFlight ? 0.33 : 1);
      const dx = _wish.x - this.velocity.x;
      const dz = _wish.z - this.velocity.z;
      const d = Math.hypot(dx, dz);
      const maxDelta = accel * dt;
      if (!this.grounded) {
        // 공중: 입력으로 walkSpeed 를 넘기지 않되 기존 관성은 유지
        const before = Math.hypot(this.velocity.x, this.velocity.z);
        const step = Math.min(maxDelta, d);
        if (d > 1e-6) {
          this.velocity.x += (dx / d) * step;
          this.velocity.z += (dz / d) * step;
        }
        const after = Math.hypot(this.velocity.x, this.velocity.z);
        const cap = Math.max(before, PLAYER.walkSpeed * this.speedScale);
        if (after > cap) {
          this.velocity.x *= cap / after;
          this.velocity.z *= cap / after;
        }
      } else if (d <= maxDelta) {
        this.velocity.x = _wish.x;
        this.velocity.z = _wish.z;
      } else {
        this.velocity.x += (dx / d) * maxDelta;
        this.velocity.z += (dz / d) * maxDelta;
      }
    }

    // 점프(버퍼 + 코요테 타임). 슬라이드 중 점프는 수평 속도 유지(슬라이드 홉)
    if (this.jumpBuffer > 0 && (this.grounded || this.coyote > 0)) {
      this.velocity.y = PLAYER.jumpVelocity * (this.speedScale < 1 ? 0.9 : 1);
      this.grounded = false;
      this.coyote = 0;
      this.jumpBuffer = 0;
      this.jumped = true;
      if (this.slideTime > 0) {
        this.slideTime = 0;
        this.slideCooldown = SLIDE.cooldown;
      }
    } else if (intent.jump && this.grounded && !this.jumped) {
      // 누르고 있으면 착지 때마다 다시 뜀(캐주얼 친화)
      this.jumpBuffer = PLAYER.jumpBuffer;
    }

    // 서브스텝 적분 + 충돌
    const steps = Math.max(1, Math.ceil(dt / MAX_SUBSTEP));
    const h = dt / steps;
    let groundedNow = false;
    for (let i = 0; i < steps; i++) {
      this.velocity.y = Math.max(-PLAYER.terminalFall, this.velocity.y - PLAYER.gravity * h);
      const fallSpeed = -this.velocity.y;
      this.position.addScaledVector(this.velocity, h);
      _a.copy(this.position).setY(this.position.y + PLAYER.radius);
      _b.copy(this.position).setY(this.position.y + PLAYER.height - PLAYER.radius);
      const c = this.world.resolveCapsule(_a, _b, PLAYER.radius, _contact);
      if (c.normals.length) {
        this.position.set(_a.x, _a.y - PLAYER.radius, _a.z);
        if (c.maxNormalY >= PLAYER.groundNormalY) {
          if (!this.grounded && fallSpeed > 1) this.landedSpeed = Math.max(this.landedSpeed, fallSpeed);
          groundedNow = true;
          if (this.velocity.y < 0) this.velocity.y = 0;
        }
        for (const n of c.normals) {
          if (n.y >= PLAYER.groundNormalY) continue;
          const into = this.velocity.dot(n);
          if (into < 0) this.velocity.addScaledVector(n, -into);
        }
        if (c.minNormalY < -0.5 && this.velocity.y > 0) this.velocity.y = 0;
      }
    }

    // 내리막·작은 단차에서 바닥에 붙이기
    if (!groundedNow && this.grounded && this.velocity.y <= 0) {
      _a.copy(this.position).setY(this.position.y + 0.05);
      const hit = this.world.raycast(_a, DOWN, 0.45);
      if (hit && hit.normal.y >= PLAYER.groundNormalY) {
        this.position.y = hit.point.y;
        groundedNow = true;
        this.velocity.y = 0;
      }
    }

    if (groundedNow) {
      this.coyote = PLAYER.coyoteTime;
      this.padFlight = false;
    } else {
      this.coyote = Math.max(0, this.coyote - dt);
    }
    this.grounded = groundedNow;

    const targetEye = this.slideTime > 0 ? PLAYER.slideEyeHeight : PLAYER.eyeHeight;
    this.eyeHeight += (targetEye - this.eyeHeight) * Math.min(1, dt * 18);
  }
}
