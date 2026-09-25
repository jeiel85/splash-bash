import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { loadGlbNode } from './glb';
import { CollisionWorld } from '../src/world/collision';
import { buildMapFromScene, type GameMap } from '../src/world/map';
import { PlayerBody } from '../src/game/playerBody';
import { ProjectileSystem, type HitTarget } from '../src/game/projectiles';
import { balloonThrowOrigin } from '../src/game/throwOrigin';
import { emptyIntent } from '../src/core/input';
import { BALLOON } from '../src/config';

const DT = 1 / 60;
/** yaw: 0 = −Z 를 봄, −π/2 = +X */
const YAW_POS_X = -Math.PI / 2;
/** 실제 맵에 많은 얇은 벽(0.06~0.08 m)과 같은 두께의 가림막. 중심 x = WALL_X */
const WALL_X = 1;
const WALL_T = 0.06;
const WALL_NEAR = WALL_X - WALL_T / 2;

function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d));
  m.position.set(x, y, z);
  return m;
}

/** 멈춰 섰다가 정면으로 걸어가 벽에 붙은 몸 */
function pressForward(world: CollisionWorld, feet: THREE.Vector3, yaw: number): PlayerBody {
  const b = new PlayerBody(world);
  b.teleport(feet, yaw);
  const idle = emptyIntent();
  for (let i = 0; i < 20; i++) b.step(DT, idle);
  const walk = { ...emptyIntent(), moveZ: 1 };
  for (let i = 0; i < 60; i++) b.step(DT, walk);
  return b;
}

/** 물풍선을 던져 터질 때까지 돌린다 */
function throwBalloon(world: CollisionWorld, origin: THREE.Vector3, aim: THREE.Vector3, victim: HitTarget): { hits: string[]; burst: THREE.Vector3 | null } {
  const hits: string[] = [];
  let burst: THREE.Vector3 | null = null;
  const ps = new ProjectileSystem(world, {
    targets: () => [victim],
    onHit: (_shooter, id) => hits.push(id),
    onImpact: () => undefined,
    onBodySplash: () => undefined,
    onBurst: (p) => {
      burst = p.clone();
    },
  });
  ps.throwBalloon('me', -1, origin, aim, new THREE.Vector3(), true, new THREE.Color());
  for (let i = 0; i < 240 && !burst; i++) ps.update(DT);
  ps.dispose();
  return { hits, burst };
}

describe('물풍선 시작점(balloonThrowOrigin)', () => {
  let world: CollisionWorld;
  beforeAll(() => {
    world = new CollisionWorld([box(20, 1, 20, 0, -0.5, 0), box(WALL_T, 3, 6, WALL_X, 1.5, 0)]);
  });

  it('트인 곳에서는 눈 앞 0.5 m(예전과 같음)', () => {
    const eye = new THREE.Vector3(-3, 1.42, 0);
    const aim = new THREE.Vector3(1, 0.2, 0).normalize();
    const o = balloonThrowOrigin(world, eye, aim, new THREE.Vector3());
    expect(o.distanceTo(eye.clone().addScaledVector(aim, 0.5))).toBeLessThan(1e-9);
  });

  it('회귀: 얇은 벽에 붙어 던지면 시작점이 벽 이쪽에 남고, 풍선은 벽에서 터져 벽 너머 사람은 젖지 않는다', () => {
    const body = pressForward(world, new THREE.Vector3(-1, 0.05, 0), YAW_POS_X);
    const eye = body.eyePosition(new THREE.Vector3());
    const aim = body.aimDirection(new THREE.Vector3());
    // 예전 시작점(눈 + 시선×0.5)은 캡슐 반지름(0.4 m)보다 앞이라 벽 너머 — 재현 조건 확인
    const old = eye.clone().addScaledVector(aim, 0.5);
    expect(old.x).toBeGreaterThan(WALL_X + WALL_T / 2);
    expect(world.lineOfSight(eye, old)).toBe(false);

    const o = balloonThrowOrigin(world, eye, aim, new THREE.Vector3());
    expect(world.lineOfSight(eye, o)).toBe(true);
    // 풍선이 벽에 파묻히지 않게 반지름만큼 앞
    expect(o.x).toBeLessThanOrEqual(WALL_NEAR - BALLOON.radius + 1e-6);

    const victim: HitTarget = { id: 'victim', team: -1, alive: true, shielded: false, pos: new THREE.Vector3(WALL_X + 2.4, 0, 0) };
    const { hits, burst } = throwBalloon(world, o, aim, victim);
    expect(burst).not.toBeNull();
    expect(burst!.x).toBeLessThan(WALL_NEAR);
    expect(hits).toEqual([]);
  });

  it('벽이 풍선 반지름 안쪽에 있으면 벽 앞으로 당기고, 눈 바로 앞이 막혔으면 눈 위치', () => {
    const aim = new THREE.Vector3(1, 0, 0);
    const near = balloonThrowOrigin(world, new THREE.Vector3(WALL_NEAR - 0.6, 1.42, 0), aim, new THREE.Vector3());
    expect(WALL_NEAR - near.x).toBeCloseTo(BALLOON.radius, 6);
    const eye = new THREE.Vector3(WALL_NEAR - 0.1, 1.42, 0);
    expect(balloonThrowOrigin(world, eye, aim, new THREE.Vector3()).equals(eye)).toBe(true);
  });
});

const MAP_FILE = 'public/assets/models/map_backyard.glb';

describe.runIf(existsSync(MAP_FILE))('물풍선 시작점 — map_backyard.glb', () => {
  let map: GameMap;
  beforeAll(async () => {
    const scene = await loadGlbNode(MAP_FILE);
    map = buildMapFromScene('backyard', scene.getObjectByName('Map') ?? scene);
  });

  const floorAt = (x: number, z: number): THREE.Vector3 => {
    const hit = map.collision.raycast(new THREE.Vector3(x, 8, z), new THREE.Vector3(0, -1, 0), 12);
    expect(hit).not.toBeNull();
    return hit!.point.clone();
  };

  it('회귀: 서쪽 파티오 가림막(x≈−18.43)에 붙어 +X 로 던져도 가림막 너머로 날아가지 않는다', () => {
    const feet = floorAt(-19.2, -7);
    const body = pressForward(map.collision, feet.setY(feet.y + 0.05), YAW_POS_X);
    const eye = body.eyePosition(new THREE.Vector3());
    const aim = body.aimDirection(new THREE.Vector3());
    // 재현 조건: 예전 시작점은 가림막 너머
    expect(map.collision.lineOfSight(eye, eye.clone().addScaledVector(aim, 0.5))).toBe(false);

    const o = balloonThrowOrigin(map.collision, eye, aim, new THREE.Vector3());
    expect(map.collision.lineOfSight(eye, o)).toBe(true);
    const victim: HitTarget = { id: 'victim', team: -1, alive: true, shielded: false, pos: floorAt(-15.5, -7) };
    const { hits, burst } = throwBalloon(map.collision, o, aim, victim);
    expect(burst).not.toBeNull();
    expect(burst!.x).toBeLessThan(-18.3);
    expect(hits).toEqual([]);
  });
});
