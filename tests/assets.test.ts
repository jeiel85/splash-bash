import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { loadGlbNode } from './glb';

const MODELS = 'public/assets/models';

function tris(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) n += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
  });
  return n;
}

describe('character.glb 규약', () => {
  it('노드·앵커·크기', async () => {
    const scene = await loadGlbNode(`${MODELS}/character.glb`);
    const root = scene.getObjectByName('Character');
    expect(root).toBeTruthy();
    for (const n of ['Body', 'EyeL', 'EyeR', 'HandL', 'HandR', 'FootL', 'FootR', 'HatAnchor', 'GunAnchor', 'NameAnchor']) {
      expect(scene.getObjectByName(n), n).toBeTruthy();
    }
    const box = new THREE.Box3().setFromObject(root!);
    expect(box.min.y).toBeGreaterThan(-0.05);
    expect(box.max.y).toBeLessThan(1.75);
    expect(box.max.y).toBeGreaterThan(1.4);
    expect(tris(root!)).toBeLessThanOrEqual(6000);
    const mats = new Set<string>();
    root!.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => mats.add(x.name));
    });
    expect(mats.has('Tint')).toBe(true);
  });
});

describe('weapons.glb 규약', () => {
  it('총 3종 + 물풍선, 총구', async () => {
    const scene = await loadGlbNode(`${MODELS}/weapons.glb`);
    for (const id of ['gun_pistol', 'gun_soaker', 'gun_bucket', 'balloon']) {
      const node = scene.getObjectByName(id);
      expect(node, id).toBeTruthy();
      if (id.startsWith('gun_')) {
        let muzzle: THREE.Object3D | null = null;
        node!.traverse((o) => {
          if (o.name === 'Muzzle' || o.name.endsWith('Muzzle')) muzzle = o;
        });
        expect(muzzle, `${id} Muzzle`).toBeTruthy();
        expect(tris(node!), `${id} tris`).toBeLessThanOrEqual(3000);
      }
    }
  });
});

describe.runIf(existsSync(`${MODELS}/hats.glb`))('hats.glb 규약', () => {
  it('모자 6종', async () => {
    const scene = await loadGlbNode(`${MODELS}/hats.glb`);
    for (const id of ['cap', 'duck', 'flower', 'crown', 'frog', 'bucket']) {
      const node = scene.getObjectByName(`hat_${id}`);
      expect(node, id).toBeTruthy();
      expect(tris(node!), `${id} tris`).toBeLessThanOrEqual(1500);
    }
  });
});
