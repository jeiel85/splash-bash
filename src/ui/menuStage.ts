import * as THREE from 'three';
import { PLAYER_COLORS } from '../config';
import { Avatar } from '../game/avatar';
import type { GameAssets } from '../render/assets';
import type { RenderContext } from '../render/renderer';
import type { GameMap } from '../world/map';
import type { Profile } from './profile';

const _v = new THREE.Vector3();

/**
 * 메인 메뉴 배경: 실제 맵 위에 내 캐릭터를 세워 두고 카메라가 천천히 돈다.
 * 꾸미기(색·모자)를 바꾸면 즉시 반영된다.
 */
export class MenuStage {
  private readonly avatar: Avatar;
  private t = 0;
  private active = false;
  private readonly spot: THREE.Vector3;
  private readonly look = new THREE.Vector3();

  constructor(private readonly ctx: RenderContext, assets: GameAssets, private readonly map: GameMap, profile: Profile) {
    const c = PLAYER_COLORS[profile.cosmetics.color];
    this.avatar = new Avatar(assets, profile.name, c, profile.cosmetics.hat);
    const sp = map.spawns[0];
    this.spot = sp.pos.clone();
    this.avatar.root.visible = false;
  }

  setProfile(p: Profile): void {
    this.avatar.setIdentity(p.name, PLAYER_COLORS[p.cosmetics.color], p.cosmetics.hat);
  }

  enter(): void {
    if (this.active) return;
    this.active = true;
    this.ctx.scene.add(this.map.root, this.avatar.root);
    this.avatar.root.visible = true;
    this.ctx.camera.rotation.set(0, 0, 0);
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
    const yaw = Math.sin(this.t * 0.35) * 0.6;
    this.avatar.update(dt, {
      pos: this.spot, vel: _v.set(0, 0, 0), yaw: yaw + Math.PI, pitch: 0, grounded: true,
      soak: 0, alive: true, shielded: false, weapon: 'soaker',
    });
    // 캐릭터가 화면 왼쪽에 오도록 카메라를 오른쪽 앞에 둔다
    const cam = this.ctx.camera;
    const ang = 0.35;
    cam.position.set(this.spot.x + Math.sin(ang) * 4.2, this.spot.y + 1.6, this.spot.z + Math.cos(ang) * 4.2);
    this.look.set(this.spot.x + 1.2, this.spot.y + 1.0, this.spot.z);
    cam.lookAt(this.look);
    this.ctx.followShadow(this.spot);
  }
}
