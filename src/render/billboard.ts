import * as THREE from 'three';

/**
 * 화면을 향하는 머리 위 표시(이름표·젖음 막대). 정점 셰이더에서 카메라를 향하게 펴므로 CPU 비용이 없다.
 * - near 거리까지는 월드 크기(m), 그보다 멀면 화면 크기가 일정해 멀리서도 읽힌다.
 * - fadeNear~fadeFar 사이에서 흐려지고 그 너머는 안 보인다.
 * - 깊이 테스트를 하므로 벽 뒤 캐릭터의 표시는 가려진다(벽 너머 정보 노출 없음).
 */

const VERT = /* glsl */ `
uniform vec2 uSize;
uniform float uLift;
uniform float uNear;
uniform vec2 uFade;
varying vec2 vUv;
varying float vFade;
void main() {
  vec4 mv = modelViewMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
  float depth = max( -mv.z, 0.001 );
  float k = max( 1.0, depth / uNear );
  mv.xy += ( position.xy * uSize + vec2( 0.0, uLift ) ) * k;
  vFade = 1.0 - smoothstep( uFade.x, uFade.y, depth );
  vUv = uv;
  gl_Position = projectionMatrix * mv;
}
`;

let quad: THREE.PlaneGeometry | null = null;

/** 가운데가 원점인 1×1 사각형(모든 표시가 공유) */
function unitQuad(): THREE.PlaneGeometry {
  quad ??= new THREE.PlaneGeometry(1, 1);
  return quad;
}

interface BillboardLayout {
  /** 월드 크기(m) */
  width: number;
  height: number;
  /** 앵커 위로 올리는 거리(m, 크기와 함께 늘어남) */
  lift: number;
  near: number;
  fadeNear: number;
  fadeFar: number;
}

function layoutUniforms(l: BillboardLayout): Record<string, THREE.IUniform> {
  return {
    uSize: { value: new THREE.Vector2(l.width, l.height) },
    uLift: { value: l.lift },
    uNear: { value: l.near },
    uFade: { value: new THREE.Vector2(l.fadeNear, l.fadeFar) },
  };
}

function makeMesh(mat: THREE.ShaderMaterial, name: string): THREE.Mesh {
  const mesh = new THREE.Mesh(unitQuad(), mat);
  mesh.name = name;
  // 정점 셰이더가 크기를 바꾸므로 경계 구로 컬링하지 않는다
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.raycast = () => {};
  return mesh;
}

// ---------------------------------------------------------------- 이름표

const NAME_FONT_PX = 44;
const NAME_FONT = `${NAME_FONT_PX}px Jua, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;
const NAME_HEIGHT = 0.34;
const NAME_CANVAS_H = 68;
/** 캔버스 좌우 여백(px, 외곽선 두께 포함) */
const NAME_PAD = 44;

/**
 * 이름표 글자 폭 상한(px, 44px 글꼴 기준). 한글 14자(≈ 512px)는 그대로 들어가고, 월드 폭은 ≈ 3 m 를 넘지 않는다.
 * 닉네임은 UTF-16 14칸만 제한하므로 아주 넓은 글자(﷽ 등)로 21 m 띠·4000px 텍스처를 만들 수 있었다.
 */
export const NAME_MAX_TEXT_PX = 560;
/** 가로로 좁혀 맞추는 한도. 이보다 더 좁혀야 하면 못 읽으므로 뒤를 말줄임한다 */
const NAME_MIN_SQUEEZE = 0.6;

export interface NameFit {
  /** 그릴 글자(넘치면 말줄임) */
  text: string;
  /** 그릴 폭(px, 상한 이하). 실제 글자가 더 넓으면 fillText 의 maxWidth 로 가로로 좁혀 그린다 */
  width: number;
}

function graphemes(text: string): string[] {
  const Seg = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  // 글자 단위(자모 조합·이모지 ZWJ 를 가르지 않게). 없으면 코드 포인트 단위(서로게이트 쌍은 지킨다)
  return Seg ? Array.from(new Seg(undefined, { granularity: 'grapheme' }).segment(text), (s) => s.segment) : Array.from(text);
}

/**
 * 이름표에 그릴 글자와 폭. 상한까지는 그대로, 조금 넘으면 가로로 좁히고(최대 NAME_MIN_SQUEEZE),
 * 그래도 넘으면 뒤를 "…" 로 줄인다. 이름을 바꿀 때만 불리므로 할당은 괜찮다.
 */
export function fitNameText(text: string, measure: (s: string) => number, maxPx = NAME_MAX_TEXT_PX): NameFit {
  const squeezeLimit = maxPx / NAME_MIN_SQUEEZE;
  let t = text;
  let w = measure(t);
  if (w > squeezeLimit) {
    const g = graphemes(text);
    for (let n = g.length - 1; n >= 1; n--) {
      t = `${g.slice(0, n).join('')}…`;
      w = measure(t);
      if (w <= squeezeLimit) break;
    }
  }
  return { text: t, width: Math.min(w, maxPx) };
}

/** 닉네임 이름표. 글꼴(Jua)이 아직 안 불러와졌으면 불러온 뒤 한 번 다시 그린다. */
export class NamePlate {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly canvas = document.createElement('canvas');
  private readonly texture: THREE.CanvasTexture;
  private text = '';
  private color = '#ffffff';
  private disposed = false;

  constructor(text: string, color: string) {
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.anisotropy = 4;
    this.material = new THREE.ShaderMaterial({
      name: 'NamePlate',
      transparent: true,
      depthWrite: false,
      uniforms: { ...layoutUniforms({ width: 1, height: NAME_HEIGHT, lift: 0, near: 9, fadeNear: 30, fadeFar: 40 }), map: { value: this.texture }, uOpacity: { value: 1 } },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        uniform float uOpacity;
        varying vec2 vUv;
        varying float vFade;
        void main() {
          vec4 c = texture2D( map, vUv );
          float a = c.a * vFade * uOpacity;
          if ( a < 0.01 ) discard;
          gl_FragColor = vec4( c.rgb, a );
          #include <colorspace_fragment>
        }
      `,
    });
    this.mesh = makeMesh(this.material, 'nameplate');
    this.set(text, color);
  }

  set(text: string, color: string): void {
    this.text = text;
    this.color = color;
    this.draw();
    if (typeof document !== 'undefined' && document.fonts && !document.fonts.check(NAME_FONT, text)) {
      document.fonts.load(NAME_FONT, text).then(
        () => {
          if (!this.disposed && this.text === text) this.draw();
        },
        (err: unknown) => console.warn('[nameplate] 글꼴을 불러오지 못해 기본 글꼴로 표시합니다', err),
      );
    }
  }

  set opacity(v: number) {
    this.material.uniforms.uOpacity.value = v;
  }

  dispose(): void {
    this.disposed = true;
    this.texture.dispose();
    this.material.dispose();
  }

  private draw(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D 캔버스를 만들 수 없습니다');
    ctx.font = NAME_FONT;
    const fit = fitNameText(this.text, (s) => ctx.measureText(s).width);
    const w = Math.ceil(fit.width) + NAME_PAD;
    const h = NAME_CANVAS_H;
    this.canvas.width = w;
    this.canvas.height = h;
    ctx.font = NAME_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 10;
    ctx.strokeStyle = 'rgba(43,45,66,0.9)';
    // maxWidth: 상한보다 넓은 글자는 브라우저가 가로로 좁혀 그린다(캔버스·월드 폭이 상한을 넘지 않게)
    ctx.strokeText(fit.text, w / 2, h / 2 + 2, fit.width);
    ctx.fillStyle = this.color;
    ctx.fillText(fit.text, w / 2, h / 2 + 2, fit.width);
    this.texture.dispose();
    this.texture.needsUpdate = true;
    (this.material.uniforms.uSize.value as THREE.Vector2).set((w / h) * NAME_HEIGHT, NAME_HEIGHT);
  }
}

// ---------------------------------------------------------------- 젖음 막대

/** 머리 위 젖음 막대(맞은 뒤 잠깐 보인다). 둥근 알약 모양을 셰이더로 그린다. */
export class SoakBar {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;

  constructor(lift: number) {
    this.material = new THREE.ShaderMaterial({
      name: 'SoakBar',
      transparent: true,
      depthWrite: false,
      uniforms: {
        ...layoutUniforms({ width: 0.64, height: 0.12, lift, near: 9, fadeNear: 30, fadeFar: 40 }),
        uFill: { value: 0 },
        uOpacity: { value: 0 },
        uInk: { value: new THREE.Color('#2B2D42') },
        uBack: { value: new THREE.Color('#F4FBFF') },
        uWater: { value: new THREE.Color('#4FD1E8') },
        uDeep: { value: new THREE.Color('#2B7FE0') },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        uniform float uFill;
        uniform float uOpacity;
        uniform vec3 uInk;
        uniform vec3 uBack;
        uniform vec3 uWater;
        uniform vec3 uDeep;
        uniform vec2 uSize;
        varying vec2 vUv;
        varying float vFade;
        float pill( vec2 p, vec2 hs ) {
          float r = hs.y;
          vec2 q = abs( p ) - vec2( hs.x - r, 0.0 );
          return length( max( q, 0.0 ) ) - r;
        }
        void main() {
          vec2 p = ( vUv - 0.5 ) * uSize;
          vec2 hs = uSize * 0.5;
          float outer = pill( p, hs );
          float inner = pill( p, hs - 0.018 );
          if ( outer > 0.0 ) discard;
          float fillX = mix( -hs.x, hs.x, uFill );
          vec3 water = mix( uWater, uDeep, smoothstep( 0.6, 0.95, uFill ) );
          // 물 표면이 살짝 물결치게
          float wave = sin( p.y * 60.0 + uFill * 30.0 ) * 0.006;
          vec3 c = p.x + wave < fillX ? water : uBack;
          // 물 윗부분 하이라이트
          c = mix( c, vec3( 1.0 ), step( 0.0, p.y - hs.y * 0.25 ) * step( p.x + wave, fillX ) * 0.35 );
          c = mix( uInk, c, step( inner, 0.0 ) );
          gl_FragColor = vec4( c, uOpacity * vFade );
          #include <colorspace_fragment>
        }
      `,
    });
    this.mesh = makeMesh(this.material, 'soakbar');
    this.mesh.renderOrder = 11;
    this.mesh.visible = false;
  }

  /** @param fill 0..1, @param opacity 0 이면 숨김 */
  set(fill: number, opacity: number): void {
    this.material.uniforms.uFill.value = THREE.MathUtils.clamp(fill, 0, 1);
    this.material.uniforms.uOpacity.value = opacity;
    this.mesh.visible = opacity > 0.01;
  }

  dispose(): void {
    this.material.dispose();
  }
}
