import * as THREE from 'three';
import { OUTLINE_SCREEN, TOON_TIME, outlineScreenScale } from './toon';

export type Quality = 'low' | 'high';

/** 조명·하늘·안개 값(게임과 dev/viewer 가 같은 값을 쓴다). 팔레트: docs/ASSETS.md */
export const LOOK = {
  skyTop: '#6EC6FF',
  skyHorizon: '#D4F1FF',
  skyBottom: '#BFE8FF',
  cloudLit: '#FFFFFF',
  cloudShade: '#D3E6F7',
  sun: { color: '#FFF4E0', intensity: 2.05 },
  /** 해 방향(타깃 기준 오프셋, 고도 ≈ 54°) */
  sunOffset: new THREE.Vector3(18, 30, 12),
  /** 땅 반사광은 채도를 낮춘 따뜻한 연두(구름·배 아래가 초록으로 물들지 않게) */
  hemi: { sky: '#CDEBFF', ground: '#D3DDB4', intensity: 1.35 },
  fog: { near: 32, far: 170 },
  exposure: 1.05,
} as const;

/** 1인칭 모델 전용 카메라의 고정 FOV(설정의 시야각과 무관하게 총 크기가 일정) */
export const VIEW_FOV = 62;

interface Tier {
  /** 픽셀 비율 상한(마지막 단계는 절댓값) */
  dpr: number;
  /** 그림자 맵 크기, 0 = 그림자 없음 */
  shadow: number;
}

/** 품질 단계. 사용자 설정이 상한(high → 0, low → 3)이고 자동 조절은 아래로만 내려간다. */
const TIERS: Tier[] = [
  { dpr: 2, shadow: 2048 },
  { dpr: 1.5, shadow: 2048 },
  { dpr: 1, shadow: 1024 },
  { dpr: 1, shadow: 0 },
  { dpr: 0.75, shadow: 0 },
];
const TIER_BOUND: Record<Quality, number> = { high: 0, low: 3 };
/** 자동 품질: 이 시간(ms) 동안의 프레임 시간 p90 이 기준을 넘으면 한 단계 내린다 */
const PROBE_MS = 5000;
const PROBE_P90_LIMIT = 20;
/** 셰이더 컴파일 등 시작 직후 튀는 프레임은 버린다 */
const PROBE_SKIP_FRAMES = 30;
const SHADOW_EXTENT = 30;

const _v = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _fwd = new THREE.Vector3();

export interface RenderStats {
  calls: number;
  triangles: number;
  tier: number;
  pixelRatio: number;
  shadowMap: number;
}

/**
 * 렌더러·씬·카메라·조명·하늘. 게임과 메뉴(캐릭터 미리보기)가 같은 컨텍스트를 공유한다.
 * 1인칭 모델은 별도 씬(viewScene)에 두고 깊이를 지운 뒤 위에 그린다 — 벽에 파묻히지 않고 FOV 설정과 무관한 크기.
 */
export class RenderContext {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  /** 1인칭 모델 전용 씬·카메라(카메라 자식으로 모델을 붙인다) */
  readonly viewScene = new THREE.Scene();
  readonly viewCamera: THREE.PerspectiveCamera;
  private readonly viewSun: THREE.DirectionalLight;
  private readonly viewHemi: THREE.HemisphereLight;
  private quality: Quality = 'high';
  private tier = 0;
  private readonly sky: THREE.Mesh;
  private readonly skyUniforms: { sunDir: { value: THREE.Vector3 }; time: { value: number } };
  private readonly autoQuality: boolean;
  private probeEnabled = false;
  private probe: { samples: Float32Array; count: number; skip: number; elapsed: number } | null = null;
  private lastFrame = 0;

  constructor(readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // 팔레트 hex 가 거의 그대로 나오면서 밝은 부분만 부드럽게 눌러 준다
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = LOOK.exposure;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // 프레임 전체(월드 + 1인칭) 통계를 보려고 수동 초기화
    this.renderer.info.autoReset = false;
    this.renderer.domElement.id = 'game-canvas';
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(78, 1, 0.05, 400);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);

    const horizon = new THREE.Color(LOOK.skyHorizon);
    this.scene.fog = new THREE.Fog(horizon, LOOK.fog.near, LOOK.fog.far);
    this.scene.background = horizon.clone();

    this.hemi = new THREE.HemisphereLight(LOOK.hemi.sky, LOOK.hemi.ground, LOOK.hemi.intensity);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(LOOK.sun.color, LOOK.sun.intensity);
    this.sun.position.copy(LOOK.sunOffset);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004;
    const s = this.sun.shadow.camera;
    s.left = -SHADOW_EXTENT; s.right = SHADOW_EXTENT; s.top = SHADOW_EXTENT; s.bottom = -SHADOW_EXTENT; s.near = 1; s.far = 90;
    this.scene.add(this.sun, this.sun.target);

    this.skyUniforms = { sunDir: { value: LOOK.sunOffset.clone().normalize() }, time: TOON_TIME };
    this.sky = this.makeSky();
    this.scene.add(this.sky);

    // 1인칭 모델 씬: 월드와 같은 방향의 해·하늘빛(그림자·안개 없음)
    this.viewCamera = new THREE.PerspectiveCamera(VIEW_FOV, 1, 0.01, 10);
    this.viewCamera.rotation.order = 'YXZ';
    this.viewHemi = new THREE.HemisphereLight(LOOK.hemi.sky, LOOK.hemi.ground, LOOK.hemi.intensity);
    this.viewSun = new THREE.DirectionalLight(LOOK.sun.color, LOOK.sun.intensity);
    this.viewSun.position.copy(LOOK.sunOffset);
    this.viewScene.add(this.viewCamera, this.viewHemi, this.viewSun, this.viewSun.target);

    this.autoQuality = new URLSearchParams(location.search).get('autoquality') !== '0';
    this.setQuality('high');
    this.resize();
    addEventListener('resize', () => this.resize());
    if (import.meta.env.DEV) (window as unknown as { __render?: RenderContext }).__render = this;
  }

  setQuality(q: Quality): void {
    this.quality = q;
    this.applyTier(TIER_BOUND[q]);
    if (this.probeEnabled) this.startProbe();
  }

  getQuality(): Quality {
    return this.quality;
  }

  /**
   * 게임 시작 시 호출: 처음 약 5초의 프레임 시간을 재서 p90 이 20ms 를 넘으면 품질을 한 단계씩 내린다.
   * 사용자 품질 설정이 상한이다. `?autoquality=0` 이면 끈다(스크린샷·성능 비교용).
   */
  beginQualityProbe(): void {
    if (!this.autoQuality || this.probeEnabled) return;
    this.probeEnabled = true;
    this.startProbe();
  }

  setFov(fov: number): void {
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
    OUTLINE_SCREEN.value = outlineScreenScale(fov);
  }

  resize(): void {
    const w = this.container.clientWidth || innerWidth;
    const h = this.container.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewCamera.aspect = w / h;
    this.viewCamera.updateProjectionMatrix();
    OUTLINE_SCREEN.value = outlineScreenScale(this.camera.fov);
  }

  /**
   * 그림자 카메라가 target 주변(시선 쪽으로 조금 앞)을 따라가게 한다.
   * 그림자 맵 텍셀 단위로 맞춰 움직여 걸을 때 그림자 가장자리가 반짝이지 않는다.
   */
  followShadow(target: THREE.Vector3): void {
    this.camera.getWorldDirection(_fwd).setY(0);
    if (_fwd.lengthSq() > 1e-6) _fwd.normalize().multiplyScalar(SHADOW_EXTENT * 0.3);
    _v.copy(target).add(_fwd).setY(0);
    const size = this.sun.shadow.mapSize.x || 1024;
    const texel = (2 * SHADOW_EXTENT) / size;
    // 그림자 카메라 기저(lookAt 과 같은 규칙): z = 해 방향, x = up × z, y = z × x
    _z.copy(LOOK.sunOffset).normalize();
    _x.set(0, 1, 0).cross(_z).normalize();
    _y.crossVectors(_z, _x);
    const a = Math.round(_v.dot(_x) / texel) * texel;
    const b = Math.round(_v.dot(_y) / texel) * texel;
    const c = _v.dot(_z);
    this.sun.target.position.set(0, 0, 0).addScaledVector(_x, a).addScaledVector(_y, b).addScaledVector(_z, c);
    this.sun.position.copy(this.sun.target.position).add(LOOK.sunOffset);
  }

  /**
   * 1인칭 씬의 점(월드 좌표계로 본 위치)을 월드 카메라 화면에서 같은 자리·같은 깊이에 보이는 월드 점으로 바꾼다.
   * 두 카메라의 FOV 가 달라도 물줄기가 화면에 그려진 총구에서 나오게 한다.
   */
  viewToWorld(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    this.syncViewCamera();
    out.copy(p).applyMatrix4(this.viewCamera.matrixWorldInverse);
    const k = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) / Math.tan(THREE.MathUtils.degToRad(this.viewCamera.fov) / 2);
    out.x *= k;
    out.y *= k;
    return out.applyMatrix4(this.camera.matrixWorld);
  }

  /** 1인칭 카메라를 월드 카메라와 같은 위치·방향으로 */
  syncViewCamera(): void {
    this.camera.updateMatrixWorld();
    this.viewCamera.position.copy(this.camera.position);
    this.viewCamera.quaternion.copy(this.camera.quaternion);
    this.viewCamera.updateMatrixWorld(true);
  }

  render(): void {
    const now = performance.now();
    if (this.lastFrame > 0) this.sampleFrame(now - this.lastFrame);
    this.lastFrame = now;
    TOON_TIME.value = now / 1000;
    this.renderer.info.reset();
    this.sky.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);

    if (this.hasViewContent()) {
      this.syncViewCamera();
      this.viewSun.color.copy(this.sun.color);
      this.viewSun.intensity = this.sun.intensity;
      this.viewHemi.intensity = this.hemi.intensity;
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.viewScene, this.viewCamera);
      this.renderer.autoClear = true;
    }
  }

  private hasViewContent(): boolean {
    for (const c of this.viewCamera.children) if (c.visible) return true;
    return false;
  }

  stats(): RenderStats {
    return {
      calls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      tier: this.tier,
      pixelRatio: this.renderer.getPixelRatio(),
      shadowMap: this.sun.castShadow ? this.sun.shadow.mapSize.x : 0,
    };
  }

  // ---------------------------------------------------------------- 품질

  private applyTier(index: number): void {
    this.tier = index;
    const t = TIERS[index];
    const dpr = index === TIERS.length - 1 ? t.dpr : Math.min(devicePixelRatio, t.dpr);
    this.renderer.setPixelRatio(dpr);
    const shadows = t.shadow > 0;
    this.renderer.shadowMap.enabled = shadows;
    this.sun.castShadow = shadows;
    if (shadows && this.sun.shadow.mapSize.x !== t.shadow) {
      this.sun.shadow.mapSize.setScalar(t.shadow);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    // 텍셀 1.5개 정도 법선 방향으로 밀어 경사면 여드름을 막는다
    this.sun.shadow.normalBias = ((2 * SHADOW_EXTENT) / (t.shadow || 1024)) * 1.5;
    this.resize();
  }

  /** 지금 단계보다 실제로 가벼워지는 다음 단계(같은 결과가 나오는 단계는 건너뜀) */
  private nextTier(): number | null {
    const cur = this.effective(this.tier);
    for (let i = this.tier + 1; i < TIERS.length; i++) {
      const e = this.effective(i);
      if (e.dpr < cur.dpr || e.shadow < cur.shadow) return i;
    }
    return null;
  }

  private effective(i: number): { dpr: number; shadow: number } {
    const t = TIERS[i];
    return { dpr: i === TIERS.length - 1 ? t.dpr : Math.min(devicePixelRatio, t.dpr), shadow: t.shadow };
  }

  private startProbe(): void {
    this.probe = { samples: new Float32Array(1200), count: 0, skip: PROBE_SKIP_FRAMES, elapsed: 0 };
  }

  private sampleFrame(dtMs: number): void {
    const p = this.probe;
    // 탭 전환·중단점 등으로 멈춘 프레임은 성능과 무관하다
    if (!p || dtMs > 250 || document.hidden) return;
    if (p.skip > 0) {
      p.skip--;
      return;
    }
    if (p.count < p.samples.length) p.samples[p.count++] = dtMs;
    p.elapsed += dtMs;
    if (p.elapsed < PROBE_MS) return;
    const sorted = p.samples.slice(0, p.count).sort();
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    const next = p90 > PROBE_P90_LIMIT ? this.nextTier() : null;
    if (next === null) {
      this.probe = null;
      return;
    }
    console.info(`[render] 프레임 시간 p90 ${p90.toFixed(1)}ms > ${PROBE_P90_LIMIT}ms — 품질 단계 ${this.tier} → ${next}`);
    this.applyTier(next);
    this.startProbe();
  }

  // ---------------------------------------------------------------- 하늘

  private makeSky(): THREE.Mesh {
    const geo = new THREE.SphereGeometry(300, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color(LOOK.skyTop) },
        horizon: { value: new THREE.Color(LOOK.skyHorizon) },
        bottom: { value: new THREE.Color(LOOK.skyBottom) },
        cloudLit: { value: new THREE.Color(LOOK.cloudLit) },
        cloudShade: { value: new THREE.Color(LOOK.cloudShade) },
        sunDir: this.skyUniforms.sunDir,
        time: this.skyUniforms.time,
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom;
        uniform vec3 cloudLit; uniform vec3 cloudShade;
        uniform vec3 sunDir; uniform float time;
        varying vec3 vDir;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
        }
        float fbm(vec2 p) {
          float v = 0.0; float a = 0.55;
          for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.07 + vec2(3.1, 1.7); a *= 0.45; }
          return v;
        }
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 c = h > 0.0 ? mix(horizon, top, pow(smoothstep(0.0, 0.7, h), 0.8)) : mix(horizon, bottom, smoothstep(0.0, -0.3, h));
          // 해: 작은 원반 + 넓은 번짐
          float sd = max(dot(d, sunDir), 0.0);
          c += vec3(1.0, 0.95, 0.82) * (smoothstep(0.9993, 0.9996, sd) * 0.9 + pow(sd, 24.0) * 0.18);
          if (h > 0.0) {
            // 평평한 구름층에 투영한 좌표(지평선으로 갈수록 촘촘), 천천히 흐른다
            vec2 uv = d.xz / (h + 0.25) * 2.1 + vec2(time * 0.018, time * 0.007);
            // 뭉게구름: 큰 덩어리(저주파)에 몽글몽글한 가장자리(고주파)
            float n = fbm(uv) + 0.12 * noise(uv * 6.0 + 3.7);
            float cover = smoothstep(0.62, 0.67, n);
            // 해 반대쪽으로 옮긴 표본보다 얇으면 밝은 윗면, 두꺼우면 푸른 아랫면(2단 툰)
            float n2 = fbm(uv + sunDir.xz * 0.14) + 0.12 * noise((uv + sunDir.xz * 0.14) * 6.0 + 3.7);
            float shade = smoothstep(0.0, 0.03, n2 - n + 0.01);
            vec3 cloud = mix(cloudLit, cloudShade, shade);
            c = mix(c, cloud, cover * smoothstep(0.03, 0.2, h) * 0.95);
          }
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }
      `,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'sky';
    // 불투명 물체를 다 그린 뒤 가려지지 않은 하늘 픽셀만 칠한다(채움 비용 절약)
    mesh.renderOrder = 1000;
    mesh.frustumCulled = false;
    return mesh;
  }
}
