import * as THREE from 'three';
import { instantiateWeapon, type GameAssets, type WeaponParts } from '../render/assets';
import type { WeaponId } from '../types';
import { retint } from '../render/toon';

/** 무기별 1인칭 위치(카메라 기준) */
const HOLD: Record<WeaponId, { pos: THREE.Vector3; scale: number }> = {
  pistol: { pos: new THREE.Vector3(0.2, -0.2, -0.42), scale: 0.62 },
  soaker: { pos: new THREE.Vector3(0.22, -0.24, -0.5), scale: 0.5 },
  bucket: { pos: new THREE.Vector3(0.22, -0.23, -0.48), scale: 0.52 },
};

/**
 * 1인칭 무기 모델(카메라에 붙음). 걷기 흔들림, 반동, 무기 교체 애니메이션.
 */
export class ViewModel {
  readonly group = new THREE.Group();
  private readonly weapons = new Map<WeaponId, WeaponParts>();
  private readonly hand: THREE.Object3D | null;
  private current: WeaponId | null = null;
  private bobPhase = 0;
  private recoil = 0;
  private switchT = 1;
  private readonly sway = new THREE.Vector2();

  constructor(private readonly assets: GameAssets, camera: THREE.Camera, color: THREE.ColorRepresentation) {
    camera.add(this.group);
    const handTpl = assets.character.getObjectByName('HandR');
    if (handTpl) {
      this.hand = handTpl.clone(true);
      this.hand.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && !m.userData.isOutline && !Array.isArray(m.material) && m.material.name.startsWith('Tint')) m.material = m.material.clone();
      });
      retint(this.hand, color);
      this.hand.position.set(0, 0, 0);
      this.group.add(this.hand);
    } else {
      this.hand = null;
    }
    this.group.traverse((o) => {
      o.castShadow = false;
      o.receiveShadow = false;
    });
  }

  setColor(color: THREE.ColorRepresentation): void {
    if (this.hand) retint(this.hand, color);
  }

  setWeapon(id: WeaponId): void {
    if (id === this.current) return;
    if (this.current) this.weapons.get(this.current)!.root.visible = false;
    let w = this.weapons.get(id);
    if (!w) {
      w = instantiateWeapon(this.assets, id);
      w.root.traverse((o) => {
        o.castShadow = false;
        // 1인칭 모델은 벽을 뚫고 보이지 않도록 항상 위에 그린다
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.renderOrder = 50;
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          mats.forEach((mat) => (mat.depthTest = true));
        }
      });
      // 모델 정면(+Z)이 카메라 정면(−Z)을 보도록
      w.root.rotation.y = Math.PI;
      this.group.add(w.root);
      this.weapons.set(id, w);
    }
    w.root.visible = true;
    this.current = id;
    this.switchT = 0;
  }

  kick(amount: number): void {
    this.recoil = Math.min(1, this.recoil + amount * 12);
  }

  /** 마우스 이동량(라디안)으로 무기가 살짝 늦게 따라오는 느낌 */
  addSway(dYaw: number, dPitch: number): void {
    this.sway.x = THREE.MathUtils.clamp(this.sway.x + dYaw * 0.6, -0.08, 0.08);
    this.sway.y = THREE.MathUtils.clamp(this.sway.y + dPitch * 0.6, -0.08, 0.08);
  }

  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    const w = this.current ? this.weapons.get(this.current) : null;
    if (!w) return out.set(0, 0, 0);
    this.group.updateWorldMatrix(true, true);
    return w.muzzle.getWorldPosition(out);
  }

  update(dt: number, speed: number, grounded: boolean, visible: boolean): void {
    this.group.visible = visible && this.current !== null;
    if (!this.current) return;
    const hold = HOLD[this.current];
    const w = this.weapons.get(this.current)!;
    const moving = grounded && speed > 0.5;
    this.bobPhase += dt * (moving ? 9 : 2);
    const bobAmt = moving ? 0.018 : 0.004;
    this.recoil = Math.max(0, this.recoil - dt * 7);
    this.switchT = Math.min(1, this.switchT + dt * 4);
    this.sway.multiplyScalar(Math.exp(-dt * 10));

    const drop = (1 - easeOut(this.switchT)) * 0.35;
    w.root.scale.setScalar(hold.scale);
    w.root.position.set(
      hold.pos.x + Math.cos(this.bobPhase) * bobAmt - this.sway.x,
      hold.pos.y + Math.abs(Math.sin(this.bobPhase)) * bobAmt - drop + this.sway.y,
      hold.pos.z + this.recoil * 0.08,
    );
    w.root.rotation.set(this.recoil * 0.25 - drop, Math.PI, 0);
    if (this.hand) {
      this.hand.position.set(w.root.position.x + 0.01, w.root.position.y - 0.02, w.root.position.z + 0.06);
      this.hand.scale.setScalar(0.85);
    }
  }
}

function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}
