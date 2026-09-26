import * as THREE from 'three';
import { buildMapFromScene, type GameMap } from './map';
import { makeToonMaterial, makeWaterMaterial } from '../render/toon';

/**
 * 코드로 만드는 단순 시험장. 단위 테스트(물리·봇)와 `?map=test` 개발 모드에서 쓴다.
 * 실제 플레이 맵은 Blender 로 만든 map_backyard.glb 이다.
 */
export function buildTestArena(): GameMap {
  const root = new THREE.Group();
  root.name = 'Map';
  const mat = makeToonMaterial({ color: '#8BD66B' });
  const wallMat = makeToonMaterial({ color: '#FFF6E8' });
  const crateMat = makeToonMaterial({ color: '#E8B07A' });

  const box = (name: string, w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.name = name;
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    return mesh;
  };

  box('ground', 40, 1, 40, 0, -0.5, 0, mat);
  box('wall_n', 40, 3, 1, 0, 1.5, -20.5, wallMat);
  box('wall_s', 40, 3, 1, 0, 1.5, 20.5, wallMat);
  box('wall_e', 1, 3, 40, 20.5, 1.5, 0, wallMat);
  box('wall_w', 1, 3, 40, -20.5, 1.5, 0, wallMat);
  box('crate_a', 2, 1.2, 2, 4, 0.6, -3, crateMat);
  box('crate_b', 2, 2.4, 2, -5, 1.2, 4, crateMat);
  box('platform', 6, 0.5, 6, 8, 2.25, 8, crateMat);
  // 경사로(플랫폼으로 올라가는)
  const ramp = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.3, 6), crateMat);
  ramp.name = 'ramp';
  ramp.position.set(8, 1.1, 2);
  ramp.rotation.x = Math.atan2(2.5, 6);
  root.add(ramp);

  // 얕은 수영장 수면(충돌 없음)
  const water = new THREE.Mesh(new THREE.BoxGeometry(6, 0.1, 6), makeWaterMaterial());
  water.name = 'water_pool';
  water.position.set(-8, 0.05, -8);
  root.add(water);

  const marker = (name: string, x: number, y: number, z: number, extras: Record<string, unknown> = {}, yaw = 0) => {
    const o = new THREE.Object3D();
    o.name = name;
    o.position.set(x, y, z);
    // 정면(+Z)이 yaw 방향을 보도록: yaw 는 카메라 기준(−Z 가 0)
    o.rotation.y = yaw + Math.PI;
    Object.assign(o.userData, extras);
    root.add(o);
  };
  marker('spawn_01', -15, 0, -15, { team: 0 }, Math.PI * 0.75);
  marker('spawn_02', 15, 0, 15, { team: 1 }, -Math.PI * 0.25);
  marker('spawn_03', -15, 0, 15, { team: 0 }, Math.PI * 0.25);
  marker('spawn_04', 15, 0, -15, { team: 1 }, -Math.PI * 0.75);
  marker('fountain_01', 0, 0, 12, { radius: 1.6 });
  marker('jumppad_01', -12, 0, 0, { power: 14 });
  marker('balloon_01', 0, 0, -12);
  marker('wp_01', -15, 0, -15, { links: 'wp_02,wp_04' });
  marker('wp_02', 15, 0, -15, { links: 'wp_03,wp_05' });
  marker('wp_03', 15, 0, 15, { links: 'wp_04,wp_05' });
  marker('wp_04', -15, 0, 15, { links: 'wp_05' });
  marker('wp_05', 0, 0, 0, { links: '' });
  marker('bounds', 0, 0, 0, { minX: -20, maxX: 20, minZ: -20, maxZ: 20, killY: -10 });

  return buildMapFromScene('test', root);
}
