import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  applyCharacterToon, createCharacterShading, darkShade, limitShadowCasters, makeOutlineMaterial, pruneInnerDetail, retint,
  setOutlineMaterial, skipFlatShadowCasters, toonify,
  type CharacterShading,
} from './toon';
import { buildMapFromScene, type GameMap } from '../world/map';
import type { HatId, WeaponId } from '../types';

/** 모델 파일 경로(public/assets/models). 규약은 docs/ASSETS.md */
const MODEL_DIR = `${import.meta.env.BASE_URL}assets/models/`;

/** 외곽선 두께(1080p 기준 픽셀). 거리와 무관하게 화면에서 거의 일정하다. */
export const CHARACTER_OUTLINE = 2.6;
export const PROP_OUTLINE = 1.7;
/** 맵 수면 정점 물결 높이(m) */
const MAP_WATER_WAVE = 0.03;

export interface GameAssets {
  /** 툰 변환된 템플릿(복제해서 쓴다) */
  character: THREE.Object3D;
  hats: Map<HatId, THREE.Object3D>;
  weapons: Map<WeaponId | 'balloon', THREE.Object3D>;
}

export interface CharacterParts {
  root: THREE.Object3D;
  body: THREE.Object3D | null;
  eyeL: THREE.Object3D | null;
  eyeR: THREE.Object3D | null;
  handL: THREE.Object3D | null;
  handR: THREE.Object3D | null;
  footL: THREE.Object3D | null;
  footR: THREE.Object3D | null;
  hatAnchor: THREE.Object3D;
  gunAnchor: THREE.Object3D;
  nameAnchor: THREE.Object3D;
  /** 이 인스턴스 전용 Tint 계열 머티리얼(색 바꾸기용) */
  tintMaterials: THREE.MeshToonMaterial[];
  /** 이 인스턴스의 림 라이트·젖음 유니폼(몸·손·발 머티리얼이 공유) */
  shading: CharacterShading;
  /** 이 인스턴스 전용 외곽선(캐릭터 색의 어두운 음영) */
  outline: THREE.ShaderMaterial;
  /** 이 인스턴스가 복제해 소유한 머티리얼(해제용) */
  ownedMaterials: THREE.Material[];
}

export interface WeaponParts {
  root: THREE.Object3D;
  muzzle: THREE.Object3D;
  tank: THREE.Mesh | null;
}

const loader = new GLTFLoader();

async function loadGlb(file: string): Promise<THREE.Group> {
  const gltf = await loader.loadAsync(MODEL_DIR + file);
  return gltf.scene;
}

/** 캐릭터·모자·무기 GLB 를 불러와 툰 템플릿으로 만든다. */
export async function loadAssets(onProgress?: (done: number, total: number) => void): Promise<GameAssets> {
  const files = ['character.glb', 'hats.glb', 'weapons.glb'] as const;
  let done = 0;
  const tick = <T>(p: Promise<T>) =>
    p.then((v) => {
      onProgress?.(++done, files.length);
      return v;
    });
  const [charScene, hatScene, weaponScene] = await Promise.all([
    tick(loadGlb(files[0])),
    // 모자는 꾸미기 요소라 없어도 게임은 진행한다
    tick(loadGlb(files[1]).catch((err: unknown) => {
      console.warn('[assets] hats.glb 로드 실패 — 모자 없이 진행', err);
      return new THREE.Group();
    })),
    tick(loadGlb(files[2])),
  ]);

  const character = charScene.getObjectByName('Character') ?? charScene;
  toonify(character, { outline: CHARACTER_OUTLINE });
  pruneInnerDetail(character);

  const hats = new Map<HatId, THREE.Object3D>();
  for (const child of [...hatScene.children]) {
    const id = child.name.replace(/^hat_/, '') as HatId;
    toonify(child, { outline: PROP_OUTLINE });
    limitShadowCasters(child);
    hats.set(id, child);
  }

  const weapons = new Map<WeaponId | 'balloon', THREE.Object3D>();
  for (const child of [...weaponScene.children]) {
    const id = child.name.replace(/^gun_/, '') as WeaponId | 'balloon';
    toonify(child, { outline: PROP_OUTLINE });
    limitShadowCasters(child);
    weapons.set(id, child);
  }
  return { character, hats, weapons };
}

function find(root: THREE.Object3D, name: string): THREE.Object3D | null {
  return root.getObjectByName(name) ?? null;
}

function ensureAnchor(root: THREE.Object3D, name: string, fallback: THREE.Vector3): THREE.Object3D {
  const found = find(root, name);
  if (found) return found;
  const o = new THREE.Object3D();
  o.name = name;
  o.position.copy(fallback);
  root.add(o);
  return o;
}

/** 림·젖음을 받지 않는 머티리얼(눈은 젖어도 그대로) */
const NO_CHARACTER_SHADING = new Set(['Eye', 'Pupil', 'EyeShine']);

/**
 * 캐릭터 인스턴스: 색·모자 적용. 몸·손·발 툰 머티리얼은 인스턴스마다 복제해 림 라이트·젖음 유니폼을 따로 갖고,
 * 외곽선은 캐릭터 색의 어두운 음영으로 칠한다.
 */
export function instantiateCharacter(assets: GameAssets, color: THREE.ColorRepresentation, hat: HatId): CharacterParts {
  const root = assets.character.clone(true);
  const tintMaterials: THREE.MeshToonMaterial[] = [];
  const shading = createCharacterShading(color);
  const cloned = new Map<THREE.Material, THREE.Material>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || mesh.userData.isOutline) return;
    const cloneMat = (m: THREE.Material) => {
      if (!(m as THREE.MeshToonMaterial).isMeshToonMaterial || NO_CHARACTER_SHADING.has(m.name)) return m;
      let c = cloned.get(m) as THREE.MeshToonMaterial | undefined;
      if (!c) {
        c = m.clone() as THREE.MeshToonMaterial;
        applyCharacterToon(c, shading);
        cloned.set(m, c);
        if (m.name.startsWith('Tint')) tintMaterials.push(c);
      }
      return c;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(cloneMat) : cloneMat(mesh.material);
  });
  retint(root, color);
  const outline = makeOutlineMaterial(CHARACTER_OUTLINE, { color: darkShade(color) });
  setOutlineMaterial(root, outline);
  const parts: CharacterParts = {
    root,
    body: find(root, 'Body'),
    eyeL: find(root, 'EyeL'),
    eyeR: find(root, 'EyeR'),
    handL: find(root, 'HandL'),
    handR: find(root, 'HandR'),
    footL: find(root, 'FootL'),
    footR: find(root, 'FootR'),
    hatAnchor: ensureAnchor(root, 'HatAnchor', new THREE.Vector3(0, 1.5, 0)),
    gunAnchor: ensureAnchor(root, 'GunAnchor', new THREE.Vector3(0.35, 0.8, 0.25)),
    nameAnchor: ensureAnchor(root, 'NameAnchor', new THREE.Vector3(0, 2.0, 0)),
    tintMaterials,
    shading,
    outline,
    ownedMaterials: [...cloned.values()],
  };
  setHat(parts, assets, hat);
  return parts;
}

/** instantiateCharacter 가 복제한 머티리얼·외곽선을 해제한다(지오메트리는 템플릿과 공유하므로 두지 않음) */
export function disposeCharacter(parts: CharacterParts): void {
  parts.ownedMaterials.forEach((m) => m.dispose());
  parts.outline.dispose();
}

export function setHat(parts: CharacterParts, assets: GameAssets, hat: HatId): void {
  for (const c of [...parts.hatAnchor.children]) if (c.userData.isHat) parts.hatAnchor.remove(c);
  if (hat === 'none') return;
  const tpl = assets.hats.get(hat);
  if (!tpl) return;
  const h = tpl.clone(true);
  h.position.set(0, 0, 0);
  h.rotation.set(0, 0, 0);
  h.userData.isHat = true;
  parts.hatAnchor.add(h);
}

export function instantiateWeapon(assets: GameAssets, id: WeaponId | 'balloon'): WeaponParts {
  const tpl = assets.weapons.get(id);
  if (!tpl) throw new Error(`무기 모델 없음: ${id}`);
  const root = tpl.clone(true);
  root.position.set(0, 0, 0);
  root.rotation.set(0, 0, 0);
  let muzzle: THREE.Object3D | null = null;
  let tank: THREE.Mesh | null = null;
  root.traverse((o) => {
    if (!muzzle && (o.name === 'Muzzle' || o.name.endsWith('Muzzle'))) muzzle = o;
    if (!tank && (o as THREE.Mesh).isMesh && o.name.includes('Tank')) tank = o as THREE.Mesh;
  });
  if (!muzzle) {
    const box = new THREE.Box3().setFromObject(root);
    const m = new THREE.Object3D();
    m.name = 'Muzzle';
    m.position.set(0, (box.min.y + box.max.y) / 2, box.max.z);
    root.add(m);
    muzzle = m;
  }
  return { root, muzzle, tank };
}

/** 맵 GLB 로드 → 툰 변환 → 충돌·마커 추출 */
export async function loadMap(name: string): Promise<GameMap> {
  const scene = await loadGlb(`map_${name}.glb`);
  const root = scene.getObjectByName('Map') ?? scene;
  toonify(root, { outline: 0, castShadow: true, receiveShadow: true, waterWave: MAP_WATER_WAVE });
  skipFlatShadowCasters(root);
  return buildMapFromScene(name, root);
}

/** 모델의 월드 크기 */
export function sizeOf(o: THREE.Object3D): THREE.Vector3 {
  return new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3());
}
