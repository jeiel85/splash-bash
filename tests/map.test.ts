import { describe, expect, it, beforeAll, vi } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { loadGlbNode } from './glb';
import { buildMapFromScene, solvePadLaunch, type GameMap } from '../src/world/map';
import { buildTestArena } from '../src/world/testArena';
import { PlayerBody } from '../src/game/playerBody';
import { emptyIntent } from '../src/core/input';
import { PLAYER } from '../src/config';

const FILE = 'public/assets/models/map_backyard.glb';

function settle(map: GameMap, pos: THREE.Vector3, seconds = 1.5): PlayerBody {
  const body = new PlayerBody(map.collision);
  body.teleport(pos.clone().setY(pos.y + 0.05), 0);
  const intent = emptyIntent();
  for (let t = 0; t < seconds; t += 1 / 60) body.step(1 / 60, intent);
  return body;
}

describe.runIf(existsSync(FILE))('map_backyard.glb 게임플레이 검증', () => {
  let map: GameMap;
  let root: THREE.Object3D;

  beforeAll(async () => {
    const scene = await loadGlbNode(FILE);
    root = scene.getObjectByName('Map') ?? scene;
    map = buildMapFromScene('backyard', root);
  });

  it('폴리곤 예산 ≤ 150k', () => {
    let tris = 0;
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) tris += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
    });
    expect(tris).toBeLessThanOrEqual(150_000);
  });

  it('스폰: 12곳 이상, 팀별 4곳 이상, 경계 안', () => {
    expect(map.spawns.length).toBeGreaterThanOrEqual(12);
    expect(map.spawns.filter((s) => s.team === 0).length).toBeGreaterThanOrEqual(4);
    expect(map.spawns.filter((s) => s.team === 1).length).toBeGreaterThanOrEqual(4);
    const b = map.bounds;
    for (const s of map.spawns) {
      expect(s.pos.x).toBeGreaterThan(b.minX);
      expect(s.pos.x).toBeLessThan(b.maxX);
      expect(s.pos.z).toBeGreaterThan(b.minZ);
      expect(s.pos.z).toBeLessThan(b.maxZ);
    }
  });

  it('모든 스폰에서 캐릭터가 바닥에 제대로 선다(벽·지형에 끼지 않음)', () => {
    for (const s of map.spawns) {
      const body = settle(map, s.pos);
      expect(body.grounded, `spawn ${s.pos.toArray()} grounded`).toBe(true);
      const drift = Math.hypot(body.position.x - s.pos.x, body.position.z - s.pos.z);
      expect(drift, `spawn ${s.pos.toArray()} pushed out`).toBeLessThan(0.3);
      expect(Math.abs(body.position.y - s.pos.y), `spawn ${s.pos.toArray()} height`).toBeLessThan(0.3);
    }
  });

  it('분수 2개 이상, 수영장 수면 존재', () => {
    expect(map.fountains.length).toBeGreaterThanOrEqual(2);
    expect(map.water.length).toBeGreaterThanOrEqual(1);
    for (const f of map.fountains) {
      // 분수 보충 반경 안에 설 수 있는 자리가 있어야 한다
      const probe = f.pos.clone().add(new THREE.Vector3(f.radius * 0.8, 0.3, 0));
      const body = settle(map, probe);
      expect(Math.hypot(body.position.x - f.pos.x, body.position.z - f.pos.z)).toBeLessThanOrEqual(f.radius + 0.1);
    }
  });

  it('점프대: 2개 이상, 목표 지점에 착지', () => {
    expect(map.jumpPads.length).toBeGreaterThanOrEqual(2);
    for (const pad of map.jumpPads) {
      expect(pad.target, 'pad target').toBeTruthy();
      const body = settle(map, pad.pos, 0.5);
      const v = solvePadLaunch(pad, body.position, PLAYER.gravity);
      body.velocity.set(0, 0, 0);
      body.launch(v.vy, new THREE.Vector3(v.vx, 0, v.vz), true);
      const intent = emptyIntent();
      let landed = false;
      for (let t = 0; t < 4; t += 1 / 60) {
        body.step(1 / 60, intent);
        if (t > 0.2 && body.grounded) {
          landed = true;
          break;
        }
      }
      expect(landed, 'pad landed').toBe(true);
      const miss = Math.hypot(body.position.x - pad.target!.x, body.position.z - pad.target!.z);
      expect(miss, `pad ${pad.pos.toArray()} → ${pad.target!.toArray()} miss`).toBeLessThan(1.5);
    }
  });

  it('봇 웨이포인트: 20개 이상, 하나로 연결, 모두 걸을 수 있는 바닥 위', () => {
    const wps = [...map.waypoints.values()];
    expect(wps.length).toBeGreaterThanOrEqual(20);
    const seen = new Set<string>([wps[0].id]);
    const queue = [wps[0].id];
    while (queue.length) {
      const id = queue.shift()!;
      for (const l of map.waypoints.get(id)!.links) {
        expect(map.waypoints.has(l), `${id} → ${l} exists`).toBe(true);
        if (!seen.has(l)) {
          seen.add(l);
          queue.push(l);
        }
      }
    }
    expect(seen.size, 'connected').toBe(wps.length);
    const down = new THREE.Vector3(0, -1, 0);
    for (const w of wps) {
      const hit = map.collision.raycast(w.pos.clone().setY(w.pos.y + 0.5), down, 1.5);
      expect(hit, `${w.id} ground`).toBeTruthy();
      expect(hit!.normal.y, `${w.id} walkable`).toBeGreaterThanOrEqual(PLAYER.groundNormalY);
    }
  });

  it('경계: 맵 밖으로 걸어 나갈 수 없다', () => {
    const b = map.bounds;
    const start = map.spawns[0].pos;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const body = settle(map, start, 0.3);
      body.yaw = Math.atan2(-dx, -dz);
      const intent = { ...emptyIntent(), moveZ: 1, jump: true };
      for (let t = 0; t < 20; t += 1 / 60) body.step(1 / 60, intent);
      expect(body.position.x, 'x in bounds').toBeGreaterThan(b.minX - 1);
      expect(body.position.x).toBeLessThan(b.maxX + 1);
      expect(body.position.z, 'z in bounds').toBeGreaterThan(b.minZ - 1);
      expect(body.position.z).toBeLessThan(b.maxZ + 1);
      expect(body.position.y).toBeGreaterThan(b.killY);
    }
  });
});

describe('정적 맵 행렬 고정(저사양 CPU 최적화)', () => {
  it('맵의 모든 노드는 행렬 자동 갱신이 꺼지고, 씬(자동 갱신 끔)에 붙이면 월드 행렬은 한 번 맞춰진 뒤 매 프레임 다시 계산하지 않는다', () => {
    const map = buildTestArena();
    let nodes = 0;
    map.root.traverse((o) => {
      nodes++;
      expect(o.matrixAutoUpdate, o.name).toBe(false);
    });
    expect(nodes).toBeGreaterThan(10);
    const platform = map.root.getObjectByName('platform')!;
    const at = new THREE.Vector3().setFromMatrixPosition(platform.matrixWorld);
    expect(at.toArray()).toEqual([8, 2.25, 8]);

    // RenderContext 와 같은 설정(자동 갱신 끈 씬)에 붙이면 첫 갱신에서 씬 기준으로 맞춰진다
    const scene = new THREE.Scene();
    scene.matrixAutoUpdate = false;
    scene.add(map.root);
    expect(map.root.matrixWorldNeedsUpdate).toBe(true);
    scene.updateMatrixWorld();
    expect(map.root.matrixWorldNeedsUpdate).toBe(false);
    expect(new THREE.Vector3().setFromMatrixPosition(platform.matrixWorld).toArray()).toEqual([8, 2.25, 8]);

    // 이후 프레임: 정적 노드는 다시 계산하지 않고(값을 바꿔도 행렬 그대로), 움직이는 오브젝트는 계속 갱신된다
    const spy = vi.spyOn(platform.matrixWorld, 'multiplyMatrices');
    const mover = new THREE.Object3D();
    scene.add(mover);
    platform.position.x = 100;
    mover.position.x = 3;
    scene.updateMatrixWorld();
    scene.updateMatrixWorld();
    expect(spy).not.toHaveBeenCalled();
    expect(new THREE.Vector3().setFromMatrixPosition(platform.matrixWorld).x).toBe(8);
    expect(new THREE.Vector3().setFromMatrixPosition(mover.matrixWorld).x).toBe(3);
  });
});
