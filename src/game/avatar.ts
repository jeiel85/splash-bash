import * as THREE from 'three';
import {
  disposeCharacter, instantiateCharacter, instantiateWeapon, setHat, type CharacterParts, type GameAssets, type WeaponParts,
} from '../render/assets';
import { NamePlate, SoakBar } from '../render/billboard';
import { TOON_TIME, darkShade, retint, setRimColor } from '../render/toon';
import type { HatId, WeaponId } from '../types';

export interface AvatarPose {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  pitch: number;
  grounded: boolean;
  /** 0..1 */
  soak: number;
  alive: boolean;
  shielded: boolean;
  weapon: WeaponId;
}

/** 아바타가 월드에 남기는 효과(게임의 Fx 가 구현). 메뉴 미리보기처럼 없으면 효과 없이 동작한다. */
export interface AvatarEffects {
  drip(point: THREE.Vector3): void;
  splashOut(center: THREE.Vector3, color: THREE.ColorRepresentation, feetY?: number): void;
}

/** 감쇠 스프링(작은 고정 간격으로 적분해 큰 dt 에도 안정) */
class Spring {
  x = 0;
  v = 0;
  step(dt: number, target: number, hz: number, zeta: number): void {
    const w = Math.PI * 2 * hz;
    let t = dt;
    while (t > 0) {
      const h = Math.min(t, 1 / 240);
      this.v += (-w * w * (this.x - target) - 2 * zeta * w * this.v) * h;
      this.x += this.v * h;
      t -= h;
    }
  }
}

/** 피격 스쿼시: Y 0.85 로 60ms 누른 뒤 9Hz·감쇠비 0.45 스프링 [design-synthesis §9] */
const HIT_SQUASH = -0.15;
const HIT_HOLD = 0.06;
/** 머리 위 젖음 막대가 보이는 시간(마지막 피격 후) */
const SOAK_BAR_SEC = 2.5;
/** 흠뻑 펑: 1.0 → 1.25 로 부푸는 시간 */
const POP_SWELL_SEC = 0.12;
/** 젖음 단계별 물 떨어짐(초당 방울 수): 25% / 50% / 75% */
const DRIP_RATES = [2.5, 6, 11];

const _v = new THREE.Vector3();
const _local = new THREE.Vector3();
const _drip = new THREE.Vector3();

let bubbleGeo: THREE.SphereGeometry | null = null;

function makeBubbleMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'ShieldBubble',
    transparent: true,
    depthWrite: false,
    uniforms: { uTime: TOON_TIME, uAlpha: { value: 1 } },
    vertexShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        // 말랑하게 일렁이는 비눗방울
        vec3 p = position + normal * ( sin( position.y * 7.0 + uTime * 5.0 ) * 0.018 + sin( position.x * 9.0 - uTime * 4.0 ) * 0.012 );
        vec4 mv = modelViewMatrix * vec4( p, 1.0 );
        vN = normalize( normalMatrix * normal );
        vV = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uAlpha;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vec3 n = normalize( vN );
        float fres = pow( 1.0 - abs( dot( n, normalize( vV ) ) ), 2.0 );
        // 무지갯빛(가장자리로 갈수록 색이 돈다)
        vec3 irid = 0.5 + 0.5 * cos( 6.2831 * ( fres * 1.4 + uTime * 0.3 + vec3( 0.0, 0.33, 0.67 ) ) );
        vec3 col = mix( vec3( 0.86, 0.97, 1.0 ), irid, 0.4 );
        float spot = smoothstep( 0.93, 0.96, dot( n, normalize( vec3( -0.45, 0.55, 0.7 ) ) ) );
        float alpha = ( 0.05 + 0.6 * fres ) * uAlpha + spot * 0.8 * uAlpha;
        gl_FragColor = vec4( mix( col, vec3( 1.0 ), spot ), alpha );
        #include <colorspace_fragment>
      }
    `,
  });
}

/**
 * 3인칭 캐릭터(원격 플레이어·봇). 콩 모양 몸통을 절차적으로 움직인다:
 * 걷기 통통 튀기, 발·손 흔들기, 점프 늘어남·착지 눌림·피격 눌림(스프링), 맞은 쪽 반대로 휘청,
 * 젖으면 어둡고 파래지며 물이 떨어짐, 맞은 뒤 머리 위 젖음 막대, 무적이면 무지갯빛 비눗방울,
 * 흠뻑 젖으면 부풀었다 펑!(쏜 사람 색 색종이).
 */
export class Avatar {
  readonly root = new THREE.Group();
  /** 물 떨어짐·펑 효과를 받을 곳(게임이 연결) */
  effects: AvatarEffects | null = null;
  private readonly parts: CharacterParts;
  private weapon: WeaponParts | null = null;
  private weaponId: WeaponId | null = null;
  private readonly rest = new Map<THREE.Object3D, { pos: THREE.Vector3; rot: THREE.Euler; scale: THREE.Vector3 }>();
  private readonly nameplate: NamePlate;
  private readonly soakBar: SoakBar;
  private readonly bubble: THREE.Mesh;
  private readonly bubbleMat: THREE.ShaderMaterial;
  private readonly color = new THREE.Color();
  private phase = 0;
  /** 몸 세로 배율 변위(부피 보존: 가로 = 1/√(1+x)) */
  private readonly squash = new Spring();
  private squashHold = 0;
  /** 맞은 반대쪽으로 휘청(앞뒤·좌우 기울기, 라디안) */
  private readonly tiltX = new Spring();
  private readonly tiltZ = new Spring();
  private wasGrounded = true;
  private airMinVy = 0;
  private sinceHit = 99;
  private wetShown = 0;
  private dripAcc = 0;
  private shieldShown = 0;
  private shieldPop = 1;
  private pop: { t: number; color: THREE.Color } | null = null;
  /** 펑 한 뒤 부활할 때까지 숨김 */
  private popped = false;
  private poppedFor = 0;
  private sawDead = false;

  constructor(private readonly assets: GameAssets, name: string, color: THREE.ColorRepresentation, hat: HatId, nameColor = '#ffffff') {
    this.color.set(color);
    this.parts = instantiateCharacter(assets, color, hat);
    this.root.add(this.parts.root);
    for (const o of [this.parts.body, this.parts.handL, this.parts.handR, this.parts.footL, this.parts.footR]) {
      if (o) this.rest.set(o, { pos: o.position.clone(), rot: o.rotation.clone(), scale: o.scale.clone() });
    }
    this.nameplate = new NamePlate(name, nameColor);
    this.parts.nameAnchor.add(this.nameplate.mesh);
    this.soakBar = new SoakBar(0.27);
    this.parts.nameAnchor.add(this.soakBar.mesh);

    bubbleGeo ??= new THREE.SphereGeometry(1.05, 32, 20);
    this.bubbleMat = makeBubbleMaterial();
    this.bubble = new THREE.Mesh(bubbleGeo, this.bubbleMat);
    this.bubble.name = 'shield';
    this.bubble.position.y = 0.85;
    this.bubble.scale.set(0.75, 0.95, 0.75);
    this.bubble.visible = false;
    this.bubble.renderOrder = 5;
    this.root.add(this.bubble);
    // 그림자 여부는 템플릿(툰 변환·안쪽 부품 정리)에서 정해진 대로 둔다
  }

  setIdentity(name: string, color: THREE.ColorRepresentation, hat: HatId, nameColor = '#ffffff'): void {
    this.color.set(color);
    retint(this.parts.root, color);
    setRimColor(this.parts.shading, color);
    darkShade(color, this.parts.outline.uniforms.uColor.value as THREE.Color);
    setHat(this.parts, this.assets, hat);
    this.nameplate.set(name, nameColor);
  }

  setWeapon(id: WeaponId): void {
    if (id === this.weaponId) return;
    if (this.weapon) this.parts.gunAnchor.remove(this.weapon.root);
    this.weapon = instantiateWeapon(this.assets, id);
    this.parts.gunAnchor.add(this.weapon.root);
    this.weaponId = id;
  }

  /** 총구 월드 위치(원격 발사 이펙트 시작점) */
  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    if (this.weapon) return this.weapon.muzzle.getWorldPosition(out);
    return this.parts.gunAnchor.getWorldPosition(out);
  }

  get headWorldY(): number {
    return this.parts.nameAnchor.getWorldPosition(_v).y;
  }

  /** 물에 맞음(권한과 무관한 시각 반응). point 는 맞은 지점(월드) — 반대쪽으로 휘청인다 */
  hit(point?: THREE.Vector3): void {
    if (!this.root.visible || this.pop) return;
    this.sinceHit = 0;
    // 연사에 맞을 때 매번 새로 누르면 떨리므로 누르고 있는 동안은 유지
    if (this.squashHold <= 0) {
      this.squash.x = HIT_SQUASH;
      this.squash.v = 0;
      this.squashHold = HIT_HOLD;
    }
    if (point) {
      this.root.updateMatrixWorld();
      _local.copy(point);
      this.root.worldToLocal(_local);
      _local.y = 0;
      if (_local.lengthSq() > 1e-4) {
        _local.normalize();
        // 앞(+Z)에서 맞으면 뒤로, 옆에서 맞으면 반대 옆으로
        this.tiltX.v -= _local.z * 2.2;
        this.tiltZ.v += _local.x * 2.2;
      }
    }
  }

  /** 흠뻑 젖음: 쏜 사람 색으로 부풀었다가 펑! 이후 부활할 때까지 숨는다 */
  splashOut(killerColor: THREE.ColorRepresentation): void {
    if (this.pop || this.popped || !this.root.visible) return;
    this.pop = { t: 0, color: new THREE.Color(killerColor) };
  }

  update(dt: number, pose: AvatarPose): void {
    // 부활 감지: 쓰러진 상태를 본 뒤 다시 살아나면 숨김 해제(4초 안전장치)
    if (!pose.alive) this.sawDead = true;
    if (this.popped) {
      this.poppedFor += dt;
      if (pose.alive && (this.sawDead || this.poppedFor > 4)) this.popped = false;
    }
    if (pose.alive && !this.popped) this.sawDead = false;
    const visible = this.pop !== null || (pose.alive && !this.popped);
    this.root.visible = visible;
    if (!visible) return;

    this.setWeapon(pose.weapon);
    this.root.position.copy(pose.pos);
    this.root.rotation.y = pose.yaw + Math.PI; // 모델 정면 +Z ↔ 카메라 정면 −Z

    const speed = Math.hypot(pose.vel.x, pose.vel.z);
    const moving = pose.grounded && speed > 0.5;
    this.phase += dt * (moving ? 2.2 + speed * 1.35 : 1.6);

    // ---- 몸 스프링: 점프 늘어남 / 착지 눌림 / 피격 눌림
    if (!pose.grounded) this.airMinVy = Math.min(this.airMinVy, pose.vel.y);
    if (pose.grounded && !this.wasGrounded) {
      this.squash.x = Math.min(this.squash.x, -Math.min(0.28, 0.07 + Math.abs(this.airMinVy) * 0.02));
      this.squash.v = 0;
      this.airMinVy = 0;
    }
    this.wasGrounded = pose.grounded;
    const stretchTarget = pose.grounded ? 0 : THREE.MathUtils.clamp(pose.vel.y * 0.022, -0.1, 0.14);
    if (this.squashHold > 0) this.squashHold -= dt;
    else this.squash.step(dt, stretchTarget, 9, 0.45);
    this.tiltX.step(dt, 0, 5, 0.4);
    this.tiltZ.step(dt, 0, 5, 0.4);

    let swell = 1;
    if (this.pop) {
      this.pop.t += dt;
      const k = Math.min(1, this.pop.t / POP_SWELL_SEC);
      swell = 1 + 0.25 * (1 - (1 - k) * (1 - k)) + Math.sin(this.pop.t * 90) * 0.02 * k;
      if (this.pop.t >= POP_SWELL_SEC) {
        this.burst(pose, this.pop.color);
        return;
      }
    }

    const walk = moving ? Math.min(speed / 6.8, 1) : 0;
    const bob = moving ? Math.abs(Math.sin(this.phase)) * 0.08 * walk : Math.sin(this.phase) * 0.012;
    const sy = 1 + this.squash.x;
    const sxz = 1 / Math.sqrt(Math.max(0.5, sy));

    const body = this.parts.body;
    if (body) {
      const r = this.rest.get(body)!;
      body.position.set(r.pos.x, r.pos.y + bob, r.pos.z);
      body.scale.set(r.scale.x * sxz * swell, r.scale.y * sy * swell, r.scale.z * sxz * swell);
      body.rotation.set(
        r.rot.x + (moving ? 0.08 * walk : 0) - pose.pitch * 0.15 + this.tiltX.x,
        r.rot.y,
        r.rot.z + Math.sin(this.phase) * 0.05 * walk + this.tiltZ.x,
      );
    }
    const swing = Math.sin(this.phase) * 0.22 * walk;
    this.moveFoot(this.parts.footL, 1, moving, walk, swing, pose.grounded);
    this.moveFoot(this.parts.footR, -1, moving, walk, swing, pose.grounded);
    this.moveHand(this.parts.handL, 1, bob, swing, sy, swell);
    this.moveHand(this.parts.handR, -1, bob, swing, sy, swell);
    // 총은 조준 피치를 따라 기울인다
    this.parts.gunAnchor.rotation.x = -pose.pitch * 0.8;

    // ---- 젖음: 셰이더(어둡고 파랗게·물기 반짝임) + 단계별 물 떨어짐
    const soak = THREE.MathUtils.clamp(pose.soak, 0, 1);
    this.wetShown += (soak - this.wetShown) * (1 - Math.exp(-dt * 8));
    this.parts.shading.wet.value = this.wetShown;
    const tier = soak >= 0.75 ? 2 : soak >= 0.5 ? 1 : soak >= 0.25 ? 0 : -1;
    if (tier >= 0 && this.effects) {
      this.dripAcc += dt * DRIP_RATES[tier];
      while (this.dripAcc >= 1) {
        this.dripAcc -= 1;
        const a = Math.random() * Math.PI * 2;
        const h = 0.35 + Math.random() * 0.95;
        const rad = 0.3 * (1 - Math.abs(h - 0.8) * 0.35);
        this.effects.drip(_drip.set(pose.pos.x + Math.sin(a) * rad, pose.pos.y + h, pose.pos.z + Math.cos(a) * rad));
      }
    } else {
      this.dripAcc = 0;
    }

    // ---- 머리 위 젖음 막대(맞은 뒤 2.5초, 마지막 0.4초 동안 흐려짐)
    this.sinceHit += dt;
    const barAlpha = this.sinceHit < SOAK_BAR_SEC ? Math.min(1, (SOAK_BAR_SEC - this.sinceHit) / 0.4) : 0;
    this.soakBar.set(this.wetShown, barAlpha);

    // ---- 무적 비눗방울: 무지갯빛 일렁임, 끝날 때 톡 부풀며 사라짐
    if (pose.shielded) {
      this.shieldShown = 1;
      this.shieldPop = 0;
    } else if (this.shieldShown > 0) {
      this.shieldPop += dt / 0.18;
      this.shieldShown = Math.max(0, 1 - this.shieldPop);
    }
    this.bubble.visible = this.shieldShown > 0;
    if (this.bubble.visible) {
      const s = (1 + Math.sin(this.phase * 3) * 0.025) * (1 + this.shieldPop * 0.2);
      this.bubble.scale.set(0.75 * s, 0.95 * s, 0.75 * s);
      this.bubbleMat.uniforms.uAlpha.value = this.shieldShown;
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    disposeCharacter(this.parts);
    this.nameplate.dispose();
    this.soakBar.dispose();
    this.bubbleMat.dispose();
  }

  private burst(pose: AvatarPose, color: THREE.Color): void {
    this.pop = null;
    this.popped = true;
    this.poppedFor = 0;
    this.root.visible = false;
    this.effects?.splashOut(_v.set(pose.pos.x, pose.pos.y + 0.8, pose.pos.z), color, pose.pos.y);
    // 부활 뒤 깨끗한 상태로
    this.squash.x = this.squash.v = 0;
    this.tiltX.x = this.tiltX.v = this.tiltZ.x = this.tiltZ.v = 0;
    this.sinceHit = 99;
    this.wetShown = 0;
    this.parts.shading.wet.value = 0;
    this.soakBar.set(0, 0);
  }

  private moveFoot(foot: THREE.Object3D | null, sign: number, moving: boolean, walk: number, swing: number, grounded: boolean): void {
    if (!foot) return;
    const r = this.rest.get(foot)!;
    const lift = moving ? Math.max(0, Math.sin(this.phase + (sign > 0 ? 0 : Math.PI))) * 0.12 * walk : 0;
    foot.position.set(r.pos.x, r.pos.y + lift + (!grounded ? 0.08 : 0), r.pos.z + swing * sign);
  }

  private moveHand(hand: THREE.Object3D | null, sign: number, bob: number, swing: number, sy: number, swell: number): void {
    if (!hand) return;
    const r = this.rest.get(hand)!;
    // 몸이 눌리면 손도 같이 내려오고, 부풀면 바깥으로 밀린다
    hand.position.set(
      r.pos.x * swell,
      r.pos.y * sy * swell + bob + Math.sin(this.phase * 2 + sign) * 0.015,
      r.pos.z - swing * sign * 0.5,
    );
  }
}
