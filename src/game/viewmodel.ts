import * as THREE from 'three';
import { WATER_TINT } from '../config';
import { instantiateWeapon, type GameAssets, type WeaponParts } from '../render/assets';
import { makeDropGeometry, makeDropMaterial } from '../render/fx';
import { VIEW_FOV, type RenderContext } from '../render/renderer';
import { makeOutlineMaterial, makeTankMaterial, outlineScreenScale, setOutlineMaterial, type TankLevel } from '../render/toon';
import { WEAPON_IDS, type WeaponId } from '../types';

/** 1인칭 외곽선 두께(1080p 기준 픽셀) — 코앞에서도 가늘고 깔끔하게 */
const VIEW_OUTLINE = 1.5;

interface HandPose {
  /** 손잡이(총 원점) 기준 위치, 카메라 공간 m. 총과 같은 방향 축(+Z = 총구 쪽, +X = 총의 왼쪽, +Y = 위) */
  pos: THREE.Vector3;
  rot: THREE.Euler;
}

interface Hold {
  /** 손잡이 위치(1인칭 카메라 기준, −Z 가 앞) */
  pos: THREE.Vector3;
  /** + 면 총구가 화면 가운데(왼쪽)로 */
  yaw: number;
  /** + 면 총구가 아래로 */
  pitch: number;
  roll: number;
  /** 화면에서 보일 총 길이(카메라 공간 m). 모델 크기가 바뀌어도 구도가 유지되도록 길이로 맞춘다 */
  length: number;
  right: HandPose;
  /** 앞손(펌프·앞쪽 손잡이). pump=true 면 모델의 Pump 위치를 기준으로 */
  left: (HandPose & { pump: boolean }) | null;
  /** 발사 반동 배율(무기별 느낌) */
  kick: number;
  /** 총구 물보라 크기 */
  puff: number;
}

const deg = THREE.MathUtils.degToRad;

/** 장갑 손 크기(카메라 공간 m, 가장 긴 변) */
const HAND_SIZE = 0.095;

/** 무기별 1인칭 구도: 화면 오른쪽 아래 1/3, 총의 실루엣이 읽히고 장갑 손이 손잡이·앞손잡이를 쥔다 */
const HOLD: Record<WeaponId, Hold> = {
  pistol: {
    pos: new THREE.Vector3(0.2, -0.22, -0.38), yaw: deg(3), pitch: deg(-3), roll: deg(-4), length: 0.27,
    right: { pos: new THREE.Vector3(0, -0.01, -0.025), rot: new THREE.Euler(deg(10), 0, 0) },
    left: null,
    kick: 1.2, puff: 0.7,
  },
  soaker: {
    pos: new THREE.Vector3(0.21, -0.29, -0.4), yaw: deg(3), pitch: deg(-3), roll: deg(-4), length: 0.58,
    right: { pos: new THREE.Vector3(0, -0.01, -0.03), rot: new THREE.Euler(deg(10), 0, 0) },
    left: { pos: new THREE.Vector3(0.01, -0.02, 0), rot: new THREE.Euler(deg(-5), 0, deg(-20)), pump: true },
    kick: 0.8, puff: 1,
  },
  bucket: {
    pos: new THREE.Vector3(0.22, -0.29, -0.4), yaw: deg(3), pitch: deg(-3), roll: deg(-4), length: 0.5,
    right: { pos: new THREE.Vector3(0, -0.01, -0.03), rot: new THREE.Euler(deg(10), 0, 0) },
    left: { pos: new THREE.Vector3(0.005, -0.035, 0.22), rot: new THREE.Euler(0, 0, deg(-40)), pump: false },
    kick: 1, puff: 1.5,
  },
};

interface WeaponRig {
  parts: WeaponParts;
  /** 총 + 손을 묶는 그룹(구도·반동이 여기에, 크기 1 = 카메라 공간 m) */
  rig: THREE.Group;
  /** 모델 → 카메라 공간 배율(Hold.length / 모델 길이) */
  gunScale: number;
  /** 앞손 기준점(Pump 위치 등, rig 좌표) */
  leftBase: THREE.Vector3;
  handR: THREE.Object3D | null;
  handL: THREE.Object3D | null;
  tank: { mesh: THREE.Mesh; level: TankLevel; box: THREE.Box3; material: THREE.Material } | null;
}

/** 감쇠 스프링(고정 간격 적분) */
class Spring {
  x = 0;
  v = 0;
  step(dt: number, hz: number, zeta: number): void {
    const w = Math.PI * 2 * hz;
    let t = dt;
    while (t > 0) {
      const h = Math.min(t, 1 / 240);
      this.v += (-w * w * this.x - 2 * zeta * w * this.v) * h;
      this.x += this.v * h;
      t -= h;
    }
  }
}

const MAX_PUFF_DROPS = 32;
const PUFF_LIFE = 0.07;

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _n = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _c = new THREE.Color();

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}

/**
 * 1인칭 무기 모델. RenderContext.viewScene 의 전용 카메라에 붙어 월드 위에 따로 그려진다(벽에 안 묻힘, FOV 설정과 무관한 크기).
 * 장갑 손 + 총 구도, 발사 시 Z 스쿼시(0.92→1, 80ms)·반동·총구 물보라, 숨쉬기·걷기 흔들림·착지 출렁임,
 * 마우스 지연 흔들림, 교체 애니메이션, 탱크 물 높이(실제 탱크 잔량을 따라가며 출렁임).
 */
export class ViewModel {
  readonly group = new THREE.Group();
  /** 움직임 줄이기(흔들림·숨쉬기 최소화) */
  reduceMotion = false;
  private readonly weapons = new Map<WeaponId, WeaponRig>();
  private readonly handTplR: THREE.Object3D | null;
  private readonly handTplL: THREE.Object3D | null;
  private readonly outline: THREE.ShaderMaterial;
  private current: WeaponId | null = null;
  private time = 0;
  private bobPhase = 0;
  private walkAmt = 0;
  private switchT = 1;
  private fireT = 1;
  private readonly kickBack = new Spring();
  private readonly kickPitch = new Spring();
  private readonly land = new Spring();
  private wasGrounded = true;
  private readonly sway = new THREE.Vector2();
  private tank = 1;
  private tankShown = 1;
  private readonly slosh = new Spring();
  // 총구 물보라: 반짝 별 모양(3프레임) + 작은 물방울
  private readonly puff: THREE.Mesh;
  private readonly puffMat: THREE.ShaderMaterial;
  private puffT = 1;
  private readonly drops: THREE.InstancedMesh;
  private readonly dropTail: THREE.InstancedBufferAttribute;
  private readonly dropState: Array<{ life: number; pos: THREE.Vector3; vel: THREE.Vector3; size: number }> = [];
  private dropCursor = 0;
  private readonly waterColor = new THREE.Color();

  constructor(private readonly assets: GameAssets, private readonly ctx: RenderContext, color: THREE.ColorRepresentation) {
    ctx.viewCamera.add(this.group);
    this.handTplR = assets.character.getObjectByName('HandR') ?? null;
    this.handTplL = assets.character.getObjectByName('HandL') ?? null;
    this.outline = makeOutlineMaterial(VIEW_OUTLINE, { screen: { value: outlineScreenScale(VIEW_FOV) } });

    this.puffMat = new THREE.ShaderMaterial({
      name: 'MuzzlePuff',
      transparent: true,
      depthWrite: false,
      depthTest: false,
      uniforms: { uColor: { value: new THREE.Color() }, uT: { value: 1 }, uSeed: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uT;
        uniform float uSeed;
        varying vec2 vUv;
        void main() {
          float r = length( vUv );
          float a = atan( vUv.y, vUv.x );
          // 뾰족뾰족한 물보라 별(물방울 끝이 둥근)
          float spikes = 0.55 + 0.35 * pow( abs( sin( a * 3.5 + uSeed ) ), 3.0 ) + 0.1 * sin( a * 11.0 - uSeed * 2.0 );
          float grow = mix( 0.55, 1.0, uT );
          float shape = smoothstep( spikes * grow, spikes * grow - 0.08, r );
          float core = smoothstep( 0.42 * grow, 0.3 * grow, r );
          vec3 c = mix( uColor, vec3( 1.0 ), core * 0.8 + 0.2 );
          float alpha = shape * ( 1.0 - uT * uT );
          if ( alpha < 0.01 ) discard;
          gl_FragColor = vec4( c, alpha );
          #include <colorspace_fragment>
        }
      `,
    });
    this.puff = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.puffMat);
    this.puff.name = 'muzzle-puff';
    this.puff.visible = false;
    this.puff.renderOrder = 20;
    this.puff.frustumCulled = false;
    this.group.add(this.puff);

    this.drops = new THREE.InstancedMesh(makeDropGeometry(1), makeDropMaterial(), MAX_PUFF_DROPS);
    this.drops.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PUFF_DROPS * 3), 3);
    this.dropTail = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PUFF_DROPS).fill(1), 1);
    this.drops.geometry.setAttribute('aTail', this.dropTail);
    this.drops.count = 0;
    this.drops.frustumCulled = false;
    this.drops.renderOrder = 19;
    for (let i = 0; i < MAX_PUFF_DROPS; i++) this.dropState.push({ life: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(), size: 0.01 });
    this.group.add(this.drops);

    this.setColor(color);
    // 세 무기를 미리 만들어 두고 셰이더를 한 번에 컴파일(첫 교체·첫 발사 때 끊김 방지)
    for (const id of WEAPON_IDS) {
      const w = this.buildRig(id);
      w.rig.visible = false;
      this.weapons.set(id, w);
    }
    this.puff.visible = true;
    for (const w of this.weapons.values()) w.rig.visible = true;
    ctx.renderer.compile(ctx.viewScene, ctx.viewCamera);
    for (const w of this.weapons.values()) w.rig.visible = false;
    this.puff.visible = false;
  }

  setColor(color: THREE.ColorRepresentation): void {
    this.waterColor.set(WATER_TINT.base).lerp(_c.set(color), WATER_TINT.mix);
    (this.puffMat.uniforms.uColor.value as THREE.Color).copy(this.waterColor);
  }

  /** 탱크 잔량 0..1 (탱크 물 높이 표시) */
  setTank(frac: number): void {
    this.tank = THREE.MathUtils.clamp(frac, 0, 1);
  }

  setWeapon(id: WeaponId): void {
    if (id === this.current) return;
    if (this.current) this.weapons.get(this.current)!.rig.visible = false;
    let w = this.weapons.get(id);
    if (!w) {
      w = this.buildRig(id);
      this.weapons.set(id, w);
    }
    w.rig.visible = true;
    const first = this.current === null;
    this.current = id;
    this.switchT = first ? 1 : 0;
  }

  /** 발사: 반동(뒤로·위로 튐)·Z 스쿼시·총구 물보라. amount = 카메라 반동(라디안) */
  kick(amount: number): void {
    if (!this.current) return;
    const hold = HOLD[this.current];
    this.kickBack.v += (0.9 + amount * 40) * hold.kick;
    this.kickPitch.v += (4 + amount * 260) * hold.kick;
    this.fireT = 0;
    this.puffT = 0;
    this.puffMat.uniforms.uSeed.value = Math.random() * 6.28;
    this.spawnPuffDrops(hold.puff);
    this.slosh.v += 0.8;
  }

  /** 마우스 이동량(라디안)으로 무기가 살짝 늦게 따라오는 느낌 */
  addSway(dYaw: number, dPitch: number): void {
    this.sway.x = THREE.MathUtils.clamp(this.sway.x + dYaw * 0.6, -0.08, 0.08);
    this.sway.y = THREE.MathUtils.clamp(this.sway.y + dPitch * 0.6, -0.08, 0.08);
    this.slosh.v += dYaw * 6;
  }

  /** 화면에 그려진 총구가 보이는 월드 위치(물줄기 시작점) */
  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    const w = this.current ? this.weapons.get(this.current) : null;
    if (!w) return out.set(0, 0, 0);
    this.ctx.syncViewCamera();
    w.parts.muzzle.updateWorldMatrix(true, false);
    w.parts.muzzle.getWorldPosition(_p);
    return this.ctx.viewToWorld(_p, out);
  }

  update(dt: number, speed: number, grounded: boolean, visible: boolean): void {
    this.group.visible = visible && this.current !== null;
    if (!this.current) return;
    const hold = HOLD[this.current];
    const w = this.weapons.get(this.current)!;
    const motion = this.reduceMotion ? 0.25 : 1;
    this.time += dt;

    // ---- 걷기 흔들림(발걸음마다 살짝 내려앉는 8자) / 숨쉬기
    const moving = grounded && speed > 0.5;
    this.walkAmt += ((moving ? Math.min(speed / 6, 1.2) : 0) - this.walkAmt) * (1 - Math.exp(-dt * 10));
    this.bobPhase += dt * (moving ? 1.8 + speed * 1.1 : 0);
    const bobX = Math.sin(this.bobPhase) * 0.011 * this.walkAmt * motion;
    const bobY = -Math.abs(Math.cos(this.bobPhase)) * 0.013 * this.walkAmt * motion;
    const breath = Math.sin(this.time * 1.7) * 0.0035 * motion;

    // ---- 착지 출렁임
    if (grounded && !this.wasGrounded) this.land.v -= 0.6;
    this.wasGrounded = grounded;
    this.land.step(dt, 7, 0.5);
    const airLift = grounded ? 0 : 0.012;

    // ---- 반동(빠르게 튀고 ~120ms 에 돌아옴), 발사 스쿼시
    this.kickBack.step(dt, 11, 0.75);
    this.kickPitch.step(dt, 11, 0.75);
    this.fireT = Math.min(1, this.fireT + dt / 0.08);
    const squash = 0.92 + 0.08 * this.fireT;

    // ---- 마우스 흔들림(지연 후 제자리로)
    this.sway.multiplyScalar(Math.exp(-dt * 10));

    // ---- 무기 교체: 아래에서 톡 튀어 올라옴(easeOutBack)
    this.switchT = Math.min(1, this.switchT + dt / 0.28);
    const up = easeOutBack(this.switchT);
    const drop = (1 - up) * 0.28;

    // 회전 부호(YXZ, y = π 로 뒤집힌 총): rotation.x + → 총구 아래, rotation.y + → 총구 왼쪽
    // 시선을 돌리면 총이 한 박자 늦게 따라온다(왼쪽으로 돌면 총은 오른쪽에 남음)
    const rig = w.rig;
    rig.position.set(
      hold.pos.x + bobX + this.sway.x * 0.35,
      hold.pos.y + bobY + breath + this.land.x * 0.06 + airLift - drop - this.sway.y * 0.35,
      hold.pos.z + this.kickBack.x * 0.035,
    );
    rig.rotation.set(
      hold.pitch - this.kickPitch.x * 0.02 - breath * 0.8 + (1 - up) * 0.9 - this.land.x * 0.05 + this.sway.y * 0.6,
      Math.PI + hold.yaw - this.sway.x * 0.8,
      hold.roll + Math.sin(this.bobPhase) * 0.02 * this.walkAmt * motion - (1 - up) * 0.4,
      'YXZ',
    );
    this.poseHand(w.handR, hold.right, null);
    if (hold.left) this.poseHand(w.handL, hold.left, w.leftBase);
    // Z 로 눌리고 그만큼 옆으로 살짝 부푼다
    const bulge = 1 / Math.sqrt(squash);
    w.parts.root.scale.set(bulge * w.gunScale, bulge * w.gunScale, squash * w.gunScale);

    // ---- 탱크 물 높이: 잔량을 부드럽게 따라가고, 발사·회전에 출렁
    this.tankShown += (this.tank - this.tankShown) * (1 - Math.exp(-dt * 10));
    this.slosh.step(dt, 3.2, 0.25);
    this.updateTank(w);

    this.updatePuff(dt, w);
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const w of this.weapons.values()) {
      if (w.tank) w.tank.material.dispose();
    }
    this.weapons.clear();
    this.outline.dispose();
    this.puffMat.dispose();
    this.puff.geometry.dispose();
    this.drops.geometry.dispose();
    (this.drops.material as THREE.Material).dispose();
    this.drops.dispose();
  }

  // ----------------------------------------------------------------

  private buildRig(id: WeaponId): WeaponRig {
    const hold = HOLD[id];
    const parts = instantiateWeapon(this.assets, id);
    const box = new THREE.Box3().setFromObject(parts.root);
    const gunScale = hold.length / Math.max(0.05, box.max.z - box.min.z);
    const rig = new THREE.Group();
    rig.name = `vm-${id}`;
    rig.add(parts.root);
    const leftBase = new THREE.Vector3();
    const pump = parts.root.getObjectByName(`gun_${id}_Pump`) ?? parts.root.getObjectByName('Pump');
    if (hold.left?.pump && pump) {
      parts.root.updateMatrixWorld(true);
      pump.getWorldPosition(leftBase).multiplyScalar(gunScale);
    }
    const handR = this.makeHand(this.handTplR);
    const handL = hold.left ? this.makeHand(this.handTplL) : null;
    if (handR) rig.add(handR);
    if (handL) rig.add(handL);
    let tank: WeaponRig['tank'] = null;
    if (parts.tank) {
      const { material, level } = makeTankMaterial();
      parts.tank.material = material;
      parts.tank.geometry.computeBoundingBox();
      tank = { mesh: parts.tank, level, box: parts.tank.geometry.boundingBox!.clone(), material };
    }
    setOutlineMaterial(rig, this.outline);
    rig.traverse((o) => {
      o.castShadow = false;
      o.receiveShadow = false;
    });
    this.group.add(rig);
    return { parts, rig, gunScale, leftBase, handR, handL, tank };
  }

  private makeHand(tpl: THREE.Object3D | null): THREE.Object3D | null {
    if (!tpl) return null;
    const hand = tpl.clone(true);
    // 3인칭용 총 앵커는 1인칭에서 쓰지 않는다
    for (const c of [...hand.children]) if (!c.userData.isOutline) hand.remove(c);
    hand.position.set(0, 0, 0);
    hand.rotation.set(0, 0, 0);
    const size = new THREE.Box3().setFromObject(hand).getSize(new THREE.Vector3());
    hand.userData.fpScale = HAND_SIZE / Math.max(0.02, size.x, size.y, size.z);
    hand.scale.setScalar(hand.userData.fpScale as number);
    return hand;
  }

  private poseHand(hand: THREE.Object3D | null, pose: HandPose, base: THREE.Vector3 | null): void {
    if (!hand) return;
    hand.position.copy(pose.pos);
    if (base) hand.position.add(base);
    hand.rotation.copy(pose.rot);
  }

  /** 탱크 로컬 좌표에서 "월드 위쪽(+출렁임)" 법선의 물 높이 평면을 계산해 셰이더에 넘긴다 */
  private updateTank(w: WeaponRig): void {
    const t = w.tank;
    if (!t) return;
    t.mesh.updateWorldMatrix(true, false);
    t.mesh.getWorldQuaternion(_q);
    _qi.copy(_q).invert();
    // 월드 위쪽을 카메라 오른쪽으로 조금 기울여 출렁임
    _n.set(1, 0, 0).applyQuaternion(this.ctx.viewCamera.quaternion).multiplyScalar(THREE.MathUtils.clamp(this.slosh.x, -0.5, 0.5) * 0.35);
    _n.y += 1;
    _n.normalize().applyQuaternion(_qi);
    const size = t.box.getSize(_s);
    const extent = Math.abs(_n.x) * size.x + Math.abs(_n.y) * size.y + Math.abs(_n.z) * size.z;
    t.box.getCenter(_p);
    t.level.normal.value.copy(_n);
    // 비었을 때는 아예 물이 없고, 가득 차면 수면 선이 보이지 않게 꼭대기 위로
    const frac = this.tankShown <= 0.005 ? -0.1 : this.tankShown >= 0.995 ? 1.1 : this.tankShown;
    t.level.offset.value = _p.dot(_n) + (frac - 0.5) * extent;
  }

  private spawnPuffDrops(scale: number): void {
    const w = this.current ? this.weapons.get(this.current) : null;
    if (!w) return;
    this.muzzleLocal(w, _p);
    const n = Math.round(5 * scale);
    for (let i = 0; i < n; i++) {
      const d = this.dropState[this.dropCursor];
      this.dropCursor = (this.dropCursor + 1) % MAX_PUFF_DROPS;
      d.pos.copy(_p);
      d.vel.set((Math.random() - 0.5) * 0.9, (Math.random() - 0.3) * 0.8, -1.2 - Math.random() * 1.2).multiplyScalar(scale);
      d.size = (0.005 + Math.random() * 0.006) * scale;
      d.life = 0.12 + Math.random() * 0.08;
    }
  }

  /** 총구 위치(1인칭 카메라 로컬 = group 좌표) */
  private muzzleLocal(w: WeaponRig, out: THREE.Vector3): THREE.Vector3 {
    w.parts.muzzle.updateWorldMatrix(true, false);
    w.parts.muzzle.getWorldPosition(out);
    return this.group.worldToLocal(out);
  }

  private updatePuff(dt: number, w: WeaponRig): void {
    this.puffT = Math.min(1, this.puffT + dt / PUFF_LIFE);
    this.puff.visible = this.puffT < 1;
    if (this.puff.visible) {
      const hold = HOLD[this.current!];
      this.muzzleLocal(w, this.puff.position);
      this.puff.position.z -= 0.012;
      this.puff.scale.setScalar(0.05 * hold.puff * (0.7 + this.puffT * 0.6));
      this.puff.rotation.set(0, 0, this.puffMat.uniforms.uSeed.value);
      this.puffMat.uniforms.uT.value = this.puffT;
    }
    let n = 0;
    for (const d of this.dropState) {
      if (d.life <= 0) continue;
      d.life -= dt;
      if (d.life <= 0) continue;
      d.vel.y -= 3 * dt;
      d.pos.addScaledVector(d.vel, dt);
      const speed = d.vel.length();
      _q.setFromUnitVectors(_z, _n.copy(d.vel).divideScalar(speed || 1));
      _m.compose(d.pos, _q, _s.setScalar(d.size));
      this.drops.setMatrixAt(n, _m);
      this.drops.setColorAt(n, this.waterColor);
      this.dropTail.setX(n, 1 + Math.min(speed * 1.5, 3));
      n++;
    }
    this.drops.count = n;
    if (n > 0) {
      this.drops.instanceMatrix.needsUpdate = true;
      this.dropTail.needsUpdate = true;
      if (this.drops.instanceColor) this.drops.instanceColor.needsUpdate = true;
    }
  }
}
