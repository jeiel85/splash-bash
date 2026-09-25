import * as THREE from 'three';
import { instantiateCharacter, instantiateWeapon, setHat, type CharacterParts, type GameAssets, type WeaponParts } from '../render/assets';
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

const WET_COLOR = new THREE.Color('#3FA9F5');

/**
 * 3인칭 캐릭터(원격 플레이어·봇). 콩 모양 몸통을 절차적으로 움직인다:
 * 걷기 통통 튀기, 발·손 흔들기, 점프 스트레치, 젖으면 파랗게, 무적이면 비눗방울.
 */
export class Avatar {
  readonly root = new THREE.Group();
  private readonly parts: CharacterParts;
  private weapon: WeaponParts | null = null;
  private weaponId: WeaponId | null = null;
  private readonly baseColors: THREE.Color[];
  private readonly rest = new Map<THREE.Object3D, { pos: THREE.Vector3; rot: THREE.Euler; scale: THREE.Vector3 }>();
  private phase = 0;
  private squash = 0;
  private wasGrounded = true;
  private readonly nameSprite: THREE.Sprite;
  private readonly bubble: THREE.Mesh;
  private color = new THREE.Color();

  constructor(private readonly assets: GameAssets, name: string, color: THREE.ColorRepresentation, hat: HatId, nameColor = '#ffffff') {
    this.color.set(color);
    this.parts = instantiateCharacter(assets, color, hat);
    this.root.add(this.parts.root);
    this.baseColors = this.parts.tintMaterials.map((m) => m.color.clone());
    for (const o of [this.parts.body, this.parts.handL, this.parts.handR, this.parts.footL, this.parts.footR, this.parts.eyeL, this.parts.eyeR]) {
      if (o) this.rest.set(o, { pos: o.position.clone(), rot: o.rotation.clone(), scale: o.scale.clone() });
    }
    this.nameSprite = makeNameSprite(name, nameColor);
    this.parts.nameAnchor.add(this.nameSprite);
    this.bubble = new THREE.Mesh(
      new THREE.SphereGeometry(1.05, 24, 16),
      new THREE.MeshBasicMaterial({ color: '#BFF3FF', transparent: true, opacity: 0.22, depthWrite: false }),
    );
    this.bubble.position.y = 0.85;
    this.bubble.scale.set(0.75, 0.95, 0.75);
    this.bubble.visible = false;
    this.root.add(this.bubble);
    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && !o.userData.isOutline) o.castShadow = true;
    });
  }

  setIdentity(name: string, color: THREE.ColorRepresentation, hat: HatId, nameColor = '#ffffff'): void {
    this.color.set(color);
    this.parts.tintMaterials.forEach((m, i) => {
      const n = m.name;
      const c = new THREE.Color(color);
      if (n === 'TintDark') c.multiplyScalar(0.72);
      if (n === 'TintLight') c.lerp(new THREE.Color(0xffffff), 0.35);
      this.baseColors[i].copy(c);
    });
    setHat(this.parts, this.assets, hat);
    const sprite = makeNameSprite(name, nameColor);
    this.nameSprite.material.map?.dispose();
    this.nameSprite.material.dispose();
    this.nameSprite.material = sprite.material;
    this.nameSprite.scale.copy(sprite.scale);
  }

  setWeapon(id: WeaponId): void {
    if (id === this.weaponId) return;
    if (this.weapon) this.parts.gunAnchor.remove(this.weapon.root);
    this.weapon = instantiateWeapon(this.assets, id);
    this.weapon.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && !o.userData.isOutline) o.castShadow = true;
    });
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

  update(dt: number, pose: AvatarPose): void {
    this.root.visible = pose.alive;
    if (!pose.alive) return;
    this.setWeapon(pose.weapon);
    this.root.position.copy(pose.pos);
    this.root.rotation.y = pose.yaw + Math.PI; // 모델 정면 +Z ↔ 카메라 정면 −Z

    const speed = Math.hypot(pose.vel.x, pose.vel.z);
    const moving = pose.grounded && speed > 0.5;
    this.phase += dt * (moving ? 2.2 + speed * 1.35 : 1.6);

    // 착지 스쿼시
    if (pose.grounded && !this.wasGrounded) this.squash = Math.min(1, 0.4 + Math.abs(pose.vel.y) * 0.06);
    this.wasGrounded = pose.grounded;
    this.squash = Math.max(0, this.squash - dt * 4);

    const walk = moving ? Math.min(speed / 6.8, 1) : 0;
    const bob = moving ? Math.abs(Math.sin(this.phase)) * 0.08 * walk : Math.sin(this.phase) * 0.012;
    const stretch = !pose.grounded ? THREE.MathUtils.clamp(pose.vel.y * 0.02, -0.08, 0.12) : 0;
    const sq = this.squash * 0.18;

    const body = this.parts.body;
    if (body) {
      const r = this.rest.get(body)!;
      body.position.set(r.pos.x, r.pos.y + bob, r.pos.z);
      body.scale.set(r.scale.x * (1 + sq - stretch * 0.5), r.scale.y * (1 - sq + stretch), r.scale.z * (1 + sq - stretch * 0.5));
      body.rotation.set(r.rot.x + (moving ? 0.08 * walk : 0) - pose.pitch * 0.15, r.rot.y, r.rot.z + Math.sin(this.phase) * 0.05 * walk);
    }
    for (const eye of [this.parts.eyeL, this.parts.eyeR]) {
      if (!eye) continue;
      const r = this.rest.get(eye)!;
      eye.position.set(r.pos.x, r.pos.y + bob * 1.05, r.pos.z);
    }
    const swing = Math.sin(this.phase) * 0.22 * walk;
    const feet: Array<[THREE.Object3D | null, number]> = [[this.parts.footL, 1], [this.parts.footR, -1]];
    for (const [foot, sign] of feet) {
      if (!foot) continue;
      const r = this.rest.get(foot)!;
      const lift = moving ? Math.max(0, Math.sin(this.phase + (sign > 0 ? 0 : Math.PI))) * 0.12 * walk : 0;
      foot.position.set(r.pos.x, r.pos.y + lift + (!pose.grounded ? 0.08 : 0), r.pos.z + swing * sign);
    }
    const hands: Array<[THREE.Object3D | null, number]> = [[this.parts.handL, 1], [this.parts.handR, -1]];
    for (const [hand, sign] of hands) {
      if (!hand) continue;
      const r = this.rest.get(hand)!;
      hand.position.set(r.pos.x, r.pos.y + bob + Math.sin(this.phase * 2 + sign) * 0.015, r.pos.z - swing * sign * 0.5);
    }
    // 총은 조준 피치를 따라 기울인다
    this.parts.gunAnchor.rotation.x = -pose.pitch * 0.8;

    // 젖을수록 파랗게
    const wet = THREE.MathUtils.clamp(pose.soak, 0, 1) * 0.6;
    this.parts.tintMaterials.forEach((m, i) => m.color.copy(this.baseColors[i]).lerp(WET_COLOR, wet));

    this.bubble.visible = pose.shielded;
    if (pose.shielded) {
      const s = 1 + Math.sin(this.phase * 3) * 0.03;
      this.bubble.scale.set(0.75 * s, 0.95 * s, 0.75 * s);
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    this.parts.tintMaterials.forEach((m) => m.dispose());
    this.nameSprite.material.map?.dispose();
    this.nameSprite.material.dispose();
    (this.bubble.material as THREE.Material).dispose();
    this.bubble.geometry.dispose();
  }
}

const _v = new THREE.Vector3();

function makeNameSprite(name: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = '600 44px Jua, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(name).width) + 40;
  canvas.width = w;
  canvas.height = 64;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(43,45,66,0.85)';
  ctx.strokeText(name, w / 2, 34);
  ctx.fillStyle = color;
  ctx.fillText(name, w / 2, 34);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  const h = 0.32;
  sprite.scale.set((w / 64) * h, h, 1);
  sprite.renderOrder = 10;
  return sprite;
}
