import * as THREE from 'three';

/**
 * 툰 셰이딩 파이프라인.
 * Blender 에서 내보낸 GLB 의 Principled 머티리얼을 이름 규약(docs/ASSETS.md)에 따라
 * MeshToonMaterial 로 바꾸고, 캐릭터·소품에는 inverted-hull 외곽선을 붙인다.
 */

export const OUTLINE_COLOR = new THREE.Color('#2B2D42');

let gradientMap: THREE.DataTexture | null = null;

/** 3단 계조(그림자/중간/밝음) 램프. 부드러운 파스텔 느낌을 위해 그림자도 너무 어둡지 않게 둔다. */
export function getGradientMap(): THREE.DataTexture {
  if (gradientMap) return gradientMap;
  const steps = [150, 210, 255];
  const data = new Uint8Array(steps.length * 4);
  steps.forEach((v, i) => data.set([v, v, v, 255], i * 4));
  gradientMap = new THREE.DataTexture(data, steps.length, 1, THREE.RGBAFormat);
  gradientMap.minFilter = THREE.NearestFilter;
  gradientMap.magFilter = THREE.NearestFilter;
  gradientMap.generateMipmaps = false;
  gradientMap.needsUpdate = true;
  return gradientMap;
}

export interface ToonifyOptions {
  /** `Tint`/`TintDark`/`TintLight` 머티리얼에 적용할 플레이어 색 */
  tint?: THREE.ColorRepresentation;
  /** 외곽선 두께(m). 0 이면 외곽선 없음 */
  outline?: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

const WATER_COLOR = new THREE.Color('#4FD1E8');

function baseColorOf(mat: THREE.Material): THREE.Color {
  const c = (mat as THREE.MeshStandardMaterial).color;
  return c ? c.clone() : new THREE.Color(0xffffff);
}

/** 이름 규약에 따라 원본 머티리얼 하나를 런타임 머티리얼로 변환한다. */
export function convertMaterial(src: THREE.Material, tint?: THREE.Color): THREE.Material | null {
  const name = src.name;
  const gm = getGradientMap();
  switch (name) {
    case 'Invisible':
      return null;
    case 'Water':
      return new THREE.MeshToonMaterial({
        name,
        color: WATER_COLOR,
        gradientMap: gm,
        transparent: true,
        opacity: 0.72,
        emissive: new THREE.Color('#1B6F9A'),
        emissiveIntensity: 0.25,
      });
    case 'EyeShine':
      return new THREE.MeshBasicMaterial({ name, color: 0xffffff });
    case 'Pupil':
      return new THREE.MeshBasicMaterial({ name, color: baseColorOf(src) });
    case 'Eye':
      return new THREE.MeshToonMaterial({ name, color: 0xffffff, gradientMap: gm, emissive: 0x404040 });
    case 'Tint':
    case 'TintDark':
    case 'TintLight': {
      const c = tint ? tint.clone() : baseColorOf(src);
      if (name === 'TintDark') c.multiplyScalar(0.72);
      if (name === 'TintLight') c.lerp(new THREE.Color(0xffffff), 0.35);
      return new THREE.MeshToonMaterial({ name, color: c, gradientMap: gm });
    }
    default:
      return new THREE.MeshToonMaterial({ name, color: baseColorOf(src), gradientMap: gm });
  }
}

const NO_OUTLINE = new Set(['Eye', 'Pupil', 'EyeShine', 'Water']);

/**
 * GLB 루트를 툰 머티리얼로 변환한다. 원본 머티리얼은 폐기된다.
 * `Invisible` 머티리얼 메시는 visible=false 로 남겨 둔다(충돌 전용).
 */
export function toonify(root: THREE.Object3D, opts: ToonifyOptions = {}): void {
  const tint = opts.tint !== undefined ? new THREE.Color(opts.tint) : undefined;
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
  });
  for (const mesh of meshes) {
    const srcMats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const converted = srcMats.map((m) => convertMaterial(m, tint));
    srcMats.forEach((m) => m.dispose());
    if (converted.every((m) => m === null)) {
      mesh.visible = false;
      mesh.material = new THREE.MeshBasicMaterial({ visible: false });
      continue;
    }
    const mats = converted.map((m) => m ?? new THREE.MeshBasicMaterial({ visible: false }));
    mesh.material = Array.isArray(mesh.material) ? mats : mats[0];
    const isWater = srcMats.some((m) => m.name === 'Water');
    mesh.castShadow = (opts.castShadow ?? true) && !isWater;
    mesh.receiveShadow = opts.receiveShadow ?? true;
    const outlineable = srcMats.every((m) => !NO_OUTLINE.has(m.name));
    if (opts.outline && opts.outline > 0 && outlineable) addOutline(mesh, opts.outline);
  }
}

/** 플레이어 색을 다시 칠한다(`Tint*` 머티리얼만). toonify 이후 호출. */
export function retint(root: THREE.Object3D, color: THREE.ColorRepresentation): void {
  const base = new THREE.Color(color);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const tm = m as THREE.MeshToonMaterial;
      if (!tm.color) continue;
      if (m.name === 'Tint') tm.color.copy(base);
      else if (m.name === 'TintDark') tm.color.copy(base).multiplyScalar(0.72);
      else if (m.name === 'TintLight') tm.color.copy(base).lerp(new THREE.Color(0xffffff), 0.35);
    }
  });
}

const outlineMaterials = new Map<number, THREE.ShaderMaterial>();

function getOutlineMaterial(thickness: number): THREE.ShaderMaterial {
  const key = Math.round(thickness * 10000);
  let mat = outlineMaterials.get(key);
  if (mat) return mat;
  mat = new THREE.ShaderMaterial({
    name: 'Outline',
    side: THREE.BackSide,
    uniforms: {
      uColor: { value: OUTLINE_COLOR },
      uThickness: { value: thickness },
    },
    vertexShader: /* glsl */ `
      uniform float uThickness;
      #include <common>
      #include <skinning_pars_vertex>
      void main() {
        vec3 transformed = position + normalize(normal) * uThickness;
        vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      void main() { gl_FragColor = vec4(uColor, 1.0); }
    `,
  });
  outlineMaterials.set(key, mat);
  return mat;
}

/**
 * inverted-hull 외곽선. 메시의 자식으로 같은 지오메트리를 BackSide 로 한 번 더 그린다.
 * 월드 스케일이 1 이 아닌 부모 아래에서는 두께가 그만큼 스케일된다.
 */
export function addOutline(mesh: THREE.Mesh, thickness: number): THREE.Mesh {
  const hull = new THREE.Mesh(mesh.geometry, getOutlineMaterial(thickness));
  hull.name = `${mesh.name}__outline`;
  hull.castShadow = false;
  hull.receiveShadow = false;
  hull.userData.isOutline = true;
  hull.raycast = () => {};
  mesh.add(hull);
  return hull;
}
