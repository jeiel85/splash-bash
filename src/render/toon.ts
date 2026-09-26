import * as THREE from 'three';

/**
 * 툰 셰이딩 파이프라인.
 * Blender 에서 내보낸 GLB 의 Principled 머티리얼을 이름 규약(docs/ASSETS.md)에 따라
 * MeshToonMaterial 로 바꾸고, 캐릭터·소품에는 inverted-hull 외곽선을 붙인다.
 *
 * - 램프 3단 [0.62, 0.85, 1.0] + 드리운 그림자는 램프 가장 어두운 단보다 조금 더 어둡게(TOON_SHADOW_LEVEL).
 *   해를 등진 면에는 그림자 맵을 적용하지 않는다 → 경사면·뒷면의 그림자 여드름(줄무늬)이 생기지 않는다.
 * - 캐릭터: 림 라이트(팀 색) + 젖음(알베도 어둡게·파랗게, 물기 반짝임). 인스턴스별 유니폼(CharacterShading).
 * - 외곽선: 깊이에 비례해 밀어내 화면 두께가 거리와 무관하게 거의 일정(1080p 기준 픽셀 단위).
 * - 물: 반짝이는 물결 무늬 + 가장자리 밝게, 큰 수면은 정점 물결.
 */

export const OUTLINE_COLOR = new THREE.Color('#2B2D42');

/** 모든 툰 셰이더가 공유하는 시간(초). RenderContext.render 가 매 프레임 갱신한다. */
export const TOON_TIME = { value: 0 };

/** 외곽선 두께 단위 변환(1080p 기준 픽셀 → 뷰 공간 거리/깊이). RenderContext 가 FOV 에 맞춰 갱신한다. */
export const OUTLINE_SCREEN = { value: outlineScreenScale(78) };

/** 세로 FOV(도)에서 1080p 기준 1픽셀이 깊이 1 m 에서 차지하는 뷰 공간 길이 */
export function outlineScreenScale(fovDeg: number): number {
  return (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2)) / 1080;
}

/** 드리운 그림자 속 직사광 비율(램프 가장 어두운 단 0.62 보다 약간 어둡게 — 발밑 그림자가 읽히도록) */
const TOON_SHADOW_LEVEL = 0.5;
const RAMP = [158, 217, 255];

let gradientMap: THREE.DataTexture | null = null;

/** 3단 계조(그림자/중간/밝음) 램프. 부드러운 파스텔 느낌을 위해 그림자도 너무 어둡지 않게 둔다. */
export function getGradientMap(): THREE.DataTexture {
  if (gradientMap) return gradientMap;
  const data = new Uint8Array(RAMP.length * 4);
  RAMP.forEach((v, i) => data.set([v, v, v, 255], i * 4));
  gradientMap = new THREE.DataTexture(data, RAMP.length, 1, THREE.RGBAFormat);
  gradientMap.minFilter = THREE.NearestFilter;
  gradientMap.magFilter = THREE.NearestFilter;
  gradientMap.generateMipmaps = false;
  gradientMap.colorSpace = THREE.NoColorSpace;
  gradientMap.needsUpdate = true;
  return gradientMap;
}

// ---------------------------------------------------------------- 조명 패치(모든 툰 머티리얼)

const TOON_PARS = /* glsl */ `
varying vec3 vViewPosition;
struct ToonMaterial { vec3 diffuseColor; };
// 방향광 루프가 그림자 값을 여기에 남긴다(패치된 lights_fragment_begin)
float toonShadow = 1.0;
void RE_Direct_Toon( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
  float ramp = getGradientIrradiance( geometryNormal, directLight.direction ).r;
  float ndl = dot( geometryNormal, directLight.direction );
  // 해를 등진 면은 이미 어두운 단이므로 그림자 맵을 무시한다(여드름·줄무늬 방지)
  float sh = mix( 1.0, toonShadow, smoothstep( -0.05, 0.12, ndl ) );
  float lit = mix( min( ramp, ${TOON_SHADOW_LEVEL.toFixed(3)} ), ramp, sh );
  reflectedLight.directDiffuse += lit * directLight.color * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectDiffuse_Toon( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
  reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct RE_Direct_Toon
#define RE_IndirectDiffuse RE_IndirectDiffuse_Toon
`;

const DIR_SHADOW_FROM = 'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ]';
const DIR_SHADOW_TO = 'toonShadow = ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ]';
const DIR_INFO = 'getDirectionalLightInfo( directionalLight, directLight );';

let lightsChunk: string | null | undefined;

/** 방향광 그림자를 색에 곱하는 대신 toonShadow 로 넘기는 lights_fragment_begin. three.js 가 바뀌어 패치할 수 없으면 null */
function toonLightsBegin(): string | null {
  if (lightsChunk !== undefined) return lightsChunk;
  const src = THREE.ShaderChunk.lights_fragment_begin;
  if (!src.includes(DIR_SHADOW_FROM) || !src.includes(DIR_INFO)) {
    console.warn('[toon] three.js 조명 청크 구조가 달라 그림자 램프 패치를 건너뜁니다(기본 툰 그림자 사용)');
    lightsChunk = null;
    return null;
  }
  lightsChunk = src.replace(DIR_INFO, `${DIR_INFO}\n\t\ttoonShadow = 1.0;`).replace(DIR_SHADOW_FROM, DIR_SHADOW_TO);
  return lightsChunk;
}

function patchLighting(shader: THREE.WebGLProgramParametersWithUniforms): void {
  const begin = toonLightsBegin();
  if (!begin) return;
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <lights_toon_pars_fragment>', TOON_PARS)
    .replace('#include <lights_fragment_begin>', begin);
}

/** 맵·소품용 기본 툰 머티리얼(그림자 램프 패치) */
export function makeToonMaterial(params: THREE.MeshToonMaterialParameters): THREE.MeshToonMaterial {
  const mat = new THREE.MeshToonMaterial({ gradientMap: getGradientMap(), ...params });
  applyBaseToon(mat);
  return mat;
}

/** 이미 만들어진(또는 clone 된) 툰 머티리얼에 기본 조명 패치를 건다. clone 은 onBeforeCompile 을 복사하지 않는다. */
export function applyBaseToon(mat: THREE.MeshToonMaterial): void {
  mat.onBeforeCompile = (shader) => patchLighting(shader);
  mat.customProgramCacheKey = () => 'toon-base-v1';
}

// ---------------------------------------------------------------- 캐릭터(림 라이트·젖음)

/** 캐릭터 인스턴스 하나가 공유하는 셰이더 유니폼 */
export interface CharacterShading {
  rimColor: { value: THREE.Color };
  rimStrength: { value: number };
  /** 0..1 젖은 정도 */
  wet: { value: number };
}

export function createCharacterShading(color: THREE.ColorRepresentation): CharacterShading {
  const s: CharacterShading = { rimColor: { value: new THREE.Color() }, rimStrength: { value: 0.55 }, wet: { value: 0 } };
  setRimColor(s, color);
  return s;
}

const WHITE = new THREE.Color(0xffffff);

/** 림 색 = 캐릭터 색을 흰색 쪽으로 55% 보간(팀 색이 살짝 비치는 밝은 테두리) */
export function setRimColor(s: CharacterShading, color: THREE.ColorRepresentation): void {
  s.rimColor.value.set(color).lerp(WHITE, 0.55);
}

const CHAR_UNIFORMS = /* glsl */ `
uniform vec3 uRimColor;
uniform float uRimStrength;
uniform float uWet;
`;

const CHAR_WET_ALBEDO = /* glsl */ `
  // 젖을수록 어둡고 파랗게(흰 장갑·배도 물빛이 돈다)
  diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.6, 0.74, 0.98 ), uWet );
`;

const CHAR_RIM = /* glsl */ `
  #if NUM_DIR_LIGHTS > 0
  {
    vec3 sunDir = directionalLights[ 0 ].direction;
    float ndv = saturate( dot( geometryNormal, geometryViewDir ) );
    float ndl = dot( geometryNormal, sunDir );
    // 햇빛 쪽 가장자리에 또렷한 림(그늘 쪽에도 조금 번지게)
    float rimMask = ( 1.0 - ndv ) * pow( saturate( ndl * 0.5 + 0.5 ), 0.6 );
    float rim = smoothstep( 0.5, 0.56, rimMask );
    totalEmissiveRadiance += uRimColor * ( rim * uRimStrength );
    // 물기 반짝임: 젖을수록 넓어지는 툰 하이라이트 띠
    vec3 halfDir = normalize( sunDir + geometryViewDir );
    float spec = saturate( dot( geometryNormal, halfDir ) );
    float band = smoothstep( 0.955 - 0.05 * uWet, 0.97 - 0.05 * uWet, spec ) * uWet;
    totalEmissiveRadiance += vec3( 0.6 * band );
  }
  #endif
`;

/** 캐릭터 머티리얼(몸·손·발)에 림 라이트·젖음을 건다. 유니폼은 인스턴스(아바타)마다 공유 객체를 넘긴다. */
export function applyCharacterToon(mat: THREE.MeshToonMaterial, s: CharacterShading): void {
  mat.onBeforeCompile = (shader) => {
    patchLighting(shader);
    shader.uniforms.uRimColor = s.rimColor;
    shader.uniforms.uRimStrength = s.rimStrength;
    shader.uniforms.uWet = s.wet;
    shader.fragmentShader = CHAR_UNIFORMS + shader.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>\n${CHAR_WET_ALBEDO}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${CHAR_RIM}`);
  };
  mat.customProgramCacheKey = () => 'toon-char-v1';
}

// ---------------------------------------------------------------- 물

const WATER_COLOR = new THREE.Color('#4FD1E8');
const WATER_EDGE = new THREE.Color('#D4F6FF');

const NOISE_GLSL = /* glsl */ `
float toonHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float toonNoise( vec2 p ) {
  vec2 i = floor( p ); vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( toonHash( i ), toonHash( i + vec2( 1.0, 0.0 ) ), u.x ), mix( toonHash( i + vec2( 0.0, 1.0 ) ), toonHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
`;

/**
 * 반투명 툰 물(수영장 수면·총 탱크). 월드 좌표로 흐르는 반짝임 무늬 + 가장자리 밝게.
 * @param waveAmp 정점 물결 높이(m). 큰 수면만(세분된 메시에서 보인다), 작은 탱크는 0
 */
export function makeWaterMaterial(waveAmp = 0): THREE.MeshToonMaterial {
  const mat = new THREE.MeshToonMaterial({
    name: 'Water',
    color: WATER_COLOR,
    gradientMap: getGradientMap(),
    transparent: true,
    opacity: 0.78,
    emissive: new THREE.Color('#1B6F9A'),
    emissiveIntensity: 0.22,
  });
  const amp = { value: waveAmp };
  const edge = { value: WATER_EDGE };
  mat.onBeforeCompile = (shader) => {
    patchLighting(shader);
    shader.uniforms.uTime = TOON_TIME;
    shader.uniforms.uWaveAmp = amp;
    shader.uniforms.uEdgeColor = edge;
    shader.vertexShader = 'uniform float uTime;\nuniform float uWaveAmp;\nvarying vec3 vWaterWorld;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      /* glsl */ `#include <begin_vertex>
      vec4 waterWorld = modelMatrix * vec4( transformed, 1.0 );
      transformed.y += ( sin( waterWorld.x * 0.9 + uTime * 1.4 ) + sin( waterWorld.z * 1.3 - uTime * 1.1 ) ) * 0.5 * uWaveAmp;
      vWaterWorld = waterWorld.xyz;`,
    );
    shader.fragmentShader = 'uniform float uTime;\nuniform vec3 uEdgeColor;\nvarying vec3 vWaterWorld;\n' + NOISE_GLSL + shader.fragmentShader
      .replace('#include <color_fragment>', /* glsl */ `#include <color_fragment>
      {
        float fres = pow( 1.0 - saturate( abs( dot( normalize( vNormal ), normalize( vViewPosition ) ) ) ), 3.0 );
        diffuseColor.rgb = mix( diffuseColor.rgb, uEdgeColor, fres * 0.6 );
        diffuseColor.a = mix( diffuseColor.a, 0.95, fres * 0.5 );
      }`)
      .replace('#include <lights_fragment_end>', /* glsl */ `#include <lights_fragment_end>
      {
        // 두 겹의 흐르는 잡음이 겹치는 좁은 띠만 반짝임(카우스틱 느낌의 툰 하이라이트)
        vec2 p = vWaterWorld.xz;
        float a = toonNoise( p * 1.6 + vec2( uTime * 0.35, uTime * 0.21 ) );
        float b = toonNoise( p * 2.3 - vec2( uTime * 0.27, uTime * 0.4 ) + 7.3 );
        float s = 1.0 - abs( a - b ) * 7.0;
        totalEmissiveRadiance += vec3( 0.55 ) * smoothstep( 0.55, 0.75, s );
      }`);
  };
  mat.customProgramCacheKey = () => 'toon-water-v1';
  return mat;
}

/** 1인칭 총 탱크의 물 높이 평면(탱크 메시 로컬 좌표): dot(p, n) > d 이면 빈 부분 */
export interface TankLevel {
  normal: { value: THREE.Vector3 };
  offset: { value: number };
}

/**
 * 1인칭 탱크: 물 높이 아래는 물, 위는 옅은 빈 유리. 수면에 밝은 선.
 * 양면으로 그려 뒤쪽 벽의 물이 비쳐 부피감이 생긴다.
 */
export function makeTankMaterial(): { material: THREE.MeshToonMaterial; level: TankLevel } {
  const mat = new THREE.MeshToonMaterial({
    name: 'Water',
    color: WATER_COLOR,
    gradientMap: getGradientMap(),
    transparent: true,
    opacity: 0.88,
    emissive: new THREE.Color('#1B6F9A'),
    emissiveIntensity: 0.3,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const level: TankLevel = { normal: { value: new THREE.Vector3(0, 1, 0) }, offset: { value: 1e3 } };
  mat.onBeforeCompile = (shader) => {
    patchLighting(shader);
    shader.uniforms.uLevelN = level.normal;
    shader.uniforms.uLevelD = level.offset;
    shader.uniforms.uTime = TOON_TIME;
    shader.vertexShader = 'varying vec3 vTankLocal;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\nvTankLocal = transformed;',
    );
    shader.fragmentShader = 'uniform vec3 uLevelN;\nuniform float uLevelD;\nuniform float uTime;\nvarying vec3 vTankLocal;\n' + shader.fragmentShader
      .replace('#include <color_fragment>', /* glsl */ `#include <color_fragment>
      float tankH = dot( vTankLocal, uLevelN ) - uLevelD;
      // 수면이 살짝 출렁이도록
      tankH += sin( vTankLocal.x * 140.0 + uTime * 6.0 ) * 0.0015;
      float emptyPart = step( 0.0, tankH );
      // 빈 부분은 옅은 유리(가장자리가 밝게 보여 탱크 모양이 남는다)
      float glassRim = pow( 1.0 - saturate( abs( dot( normalize( vNormal ), normalize( vViewPosition ) ) ) ), 2.0 );
      diffuseColor = mix( diffuseColor, vec4( 0.92, 0.98, 1.0, 0.22 + 0.5 * glassRim ), emptyPart );`)
      .replace('#include <lights_fragment_end>', /* glsl */ `#include <lights_fragment_end>
      // 수면 경계의 밝은 선(물 높이가 한눈에 보이게)
      totalEmissiveRadiance += vec3( 0.8 ) * ( 1.0 - smoothstep( 0.0, 0.004, abs( tankH ) ) );`);
  };
  mat.customProgramCacheKey = () => 'toon-tank-v1';
  return { material: mat, level };
}

// ---------------------------------------------------------------- GLB 머티리얼 변환

export interface ToonifyOptions {
  /** `Tint`/`TintDark`/`TintLight` 머티리얼에 적용할 플레이어 색 */
  tint?: THREE.ColorRepresentation;
  /** 외곽선 두께(1080p 기준 픽셀). 0 이면 외곽선 없음 */
  outline?: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** `Water` 머티리얼 정점 물결 높이(m) — 맵 수면용 */
  waterWave?: number;
}

function baseColorOf(mat: THREE.Material): THREE.Color {
  const c = (mat as THREE.MeshStandardMaterial).color;
  return c ? c.clone() : new THREE.Color(0xffffff);
}

/** 플레이어 색에서 `TintDark`/`TintLight` 색을 만든다 */
export function tintShade(name: string, color: THREE.ColorRepresentation, out = new THREE.Color()): THREE.Color {
  out.set(color);
  if (name === 'TintDark') out.multiplyScalar(0.72);
  else if (name === 'TintLight') out.lerp(WHITE, 0.35);
  return out;
}

/** 이름 규약에 따라 원본 머티리얼 하나를 런타임 머티리얼로 변환한다. */
export function convertMaterial(src: THREE.Material, tint?: THREE.Color, waterWave = 0): THREE.Material | null {
  const name = src.name;
  switch (name) {
    case 'Invisible':
      return null;
    case 'Water':
      return makeWaterMaterial(waterWave);
    case 'EyeShine':
      return new THREE.MeshBasicMaterial({ name, color: 0xffffff });
    case 'Pupil':
      return new THREE.MeshBasicMaterial({ name, color: baseColorOf(src) });
    case 'Eye':
      return makeToonMaterial({ name, color: 0xffffff, emissive: 0x404040 });
    case 'Tint':
    case 'TintDark':
    case 'TintLight':
      return makeToonMaterial({ name, color: tintShade(name, tint ?? baseColorOf(src)) });
    default:
      return makeToonMaterial({ name, color: baseColorOf(src) });
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
    const converted = srcMats.map((m) => convertMaterial(m, tint, opts.waterWave ?? 0));
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
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const tm = m as THREE.MeshToonMaterial;
      if (tm.color && m.name.startsWith('Tint')) tintShade(m.name, color, tm.color);
    }
  });
}

// ---------------------------------------------------------------- 외곽선

export interface OutlineOptions {
  color?: THREE.ColorRepresentation;
  /** 두께 단위 변환 유니폼(기본: 월드 카메라 FOV 기준 OUTLINE_SCREEN). 다른 카메라로 그리는 1인칭 모델용 */
  screen?: { value: number };
  /** 이 깊이(m)를 넘으면 월드 두께를 고정해 멀리서는 가늘어진다 */
  maxDepth?: number;
}

const OUTLINE_VERT = /* glsl */ `
uniform float uThickness;
uniform float uScreen;
uniform float uMaxDepth;
attribute vec3 outlineNormal;
#include <common>
#include <fog_pars_vertex>
void main() {
  #ifdef USE_INSTANCING
    vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4( position, 1.0 );
    vec3 n = normalize( normalMatrix * mat3( instanceMatrix ) * outlineNormal );
  #else
    vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
    vec3 n = normalize( normalMatrix * outlineNormal );
  #endif
  float depth = clamp( -mvPosition.z, 0.0, uMaxDepth );
  mvPosition.xyz += n * ( uThickness * uScreen * depth );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const OUTLINE_FRAG = /* glsl */ `
uniform vec3 uColor;
#include <common>
#include <fog_pars_fragment>
void main() {
  gl_FragColor = vec4( uColor, 1.0 );
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/** 새 외곽선 머티리얼(인스턴스 전용 색 등). 공유해도 되면 getOutlineMaterial 을 쓴다. */
export function makeOutlineMaterial(px: number, opts: OutlineOptions = {}): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    name: 'Outline',
    side: THREE.BackSide,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uColor: { value: new THREE.Color(opts.color ?? OUTLINE_COLOR) },
      uThickness: { value: px },
      uMaxDepth: { value: opts.maxDepth ?? 28 },
    }]) as Record<string, THREE.IUniform>,
    vertexShader: OUTLINE_VERT,
    fragmentShader: OUTLINE_FRAG,
  });
  // merge 는 값을 복사하므로 두께 단위 유니폼은 공유 객체를 직접 연결한다(FOV 변경이 모두에 반영)
  mat.uniforms.uScreen = opts.screen ?? OUTLINE_SCREEN;
  return mat;
}

const outlineMaterials = new Map<number, THREE.ShaderMaterial>();

/** 두께별 공유 외곽선 머티리얼(기본 잉크색) */
export function getOutlineMaterial(px: number): THREE.ShaderMaterial {
  const key = Math.round(px * 100);
  let mat = outlineMaterials.get(key);
  if (!mat) {
    mat = makeOutlineMaterial(px);
    outlineMaterials.set(key, mat);
  }
  return mat;
}

/** 캐릭터 색의 아주 어두운 음영(외곽선용) */
export function darkShade(color: THREE.ColorRepresentation, out = new THREE.Color()): THREE.Color {
  const hsl = { h: 0, s: 0, l: 0 };
  out.set(color).getHSL(hsl, THREE.SRGBColorSpace);
  return out.setHSL(hsl.h, Math.min(1, hsl.s * 0.85), 0.17, THREE.SRGBColorSpace);
}

/**
 * 외곽선용 부드러운 법선(같은 위치의 분리된 정점 법선 평균). 모서리에서 헐이 갈라지지 않게 한다.
 * 지오메트리당 한 번 계산해 `outlineNormal` 속성으로 둔다(복제본은 지오메트리를 공유).
 */
export function ensureOutlineNormals(geo: THREE.BufferGeometry): void {
  if (geo.getAttribute('outlineNormal')) return;
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  const n = pos.count;
  const groupOf = new Int32Array(n);
  const keys = new Map<string, number>();
  const sums: number[] = [];
  const q = 1e4;
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(pos.getX(i) * q)},${Math.round(pos.getY(i) * q)},${Math.round(pos.getZ(i) * q)}`;
    let g = keys.get(key);
    if (g === undefined) {
      g = sums.length / 3;
      keys.set(key, g);
      sums.push(0, 0, 0);
    }
    groupOf[i] = g;
    sums[g * 3] += nor.getX(i);
    sums[g * 3 + 1] += nor.getY(i);
    sums[g * 3 + 2] += nor.getZ(i);
  }
  const out = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const g = groupOf[i];
    v.set(sums[g * 3], sums[g * 3 + 1], sums[g * 3 + 2]);
    if (v.lengthSq() < 1e-12) v.set(nor.getX(i), nor.getY(i), nor.getZ(i));
    v.normalize();
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
  }
  geo.setAttribute('outlineNormal', new THREE.BufferAttribute(out, 3));
}

/**
 * inverted-hull 외곽선. 메시의 자식으로 같은 지오메트리를 BackSide 로 한 번 더 그린다.
 * 두께는 깊이에 비례해 밀어내므로 화면에서 거의 일정하다(부모 스케일과 무관).
 */
export function addOutline(mesh: THREE.Mesh, px: number, material?: THREE.ShaderMaterial): THREE.Mesh {
  ensureOutlineNormals(mesh.geometry);
  const hull = new THREE.Mesh(mesh.geometry, material ?? getOutlineMaterial(px));
  hull.name = `${mesh.name}__outline`;
  hull.castShadow = false;
  hull.receiveShadow = false;
  hull.userData.isOutline = true;
  hull.raycast = () => {};
  mesh.add(hull);
  return hull;
}

/** root 아래 모든 외곽선 헐의 머티리얼을 바꾼다 */
export function setOutlineMaterial(root: THREE.Object3D, material: THREE.ShaderMaterial): void {
  root.traverse((o) => {
    if (o.userData.isOutline) (o as THREE.Mesh).material = material;
  });
}

/**
 * 다른 메시 안에 쏙 들어가는 작은 부품(배 무늬·볼·눈 등)은 외곽선·그림자를 끈다.
 * 실루엣은 바깥 메시가 만들므로 보이는 차이는 거의 없고, 캐릭터당 드로우콜이 줄어든다(템플릿에 한 번 적용).
 * @param margin 바깥 메시 경계를 이만큼(m) 넓혀서 포함 여부를 본다(표면에 붙은 부품 허용)
 */
export function pruneInnerDetail(root: THREE.Object3D, margin = 0.05): void {
  root.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !m.userData.isOutline && m.visible) meshes.push(m);
  });
  const boxes = meshes.map((m) => new THREE.Box3().setFromBufferAttribute(m.geometry.getAttribute('position') as THREE.BufferAttribute).applyMatrix4(m.matrixWorld));
  const vol = (b: THREE.Box3) => {
    const s = b.getSize(new THREE.Vector3());
    return s.x * s.y * s.z;
  };
  const grown = boxes.map((b) => b.clone().expandByScalar(margin));
  meshes.forEach((m, i) => {
    const inside = boxes.some((_, j) => j !== i && vol(boxes[j]) > vol(boxes[i]) * 2 && grown[j].containsBox(boxes[i]));
    if (!inside) return;
    m.castShadow = false;
    for (const c of [...m.children]) if (c.userData.isOutline) m.remove(c);
  });
}

/** 소품(모자·총)은 가장 큰 부품 하나만 그림자를 드리운다(작은 장식 그림자는 안 보이고 그림자 패스 드로우콜만 늘린다) */
export function limitShadowCasters(root: THREE.Object3D): void {
  let best: THREE.Mesh | null = null;
  let bestVol = -1;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || m.userData.isOutline) return;
    if (m.castShadow) {
      m.geometry.computeBoundingBox();
      const s = m.geometry.boundingBox!.getSize(new THREE.Vector3());
      const v = s.x * s.y * s.z;
      if (v > bestVol) {
        bestVol = v;
        best = m;
      }
    }
    m.castShadow = false;
  });
  if (best) (best as THREE.Mesh).castShadow = true;
}

/** 맵: 땅에 깔린 납작한 층(바닥·잔디·타일 등)은 아래에 받을 것이 없으므로 그림자를 드리우지 않는다 */
export function skipFlatShadowCasters(root: THREE.Object3D, maxHeight = 0.06, maxBaseY = 0.4): void {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.castShadow) return;
    box.setFromObject(m);
    if (box.max.y - box.min.y <= maxHeight && box.max.y <= maxBaseY) m.castShadow = false;
  });
}
