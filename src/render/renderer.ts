import * as THREE from 'three';

export type Quality = 'low' | 'high';

const SKY_TOP = new THREE.Color('#6EC6FF');
const SKY_HORIZON = new THREE.Color('#D4F1FF');
const SKY_BOTTOM = new THREE.Color('#BFE8FF');

/**
 * 렌더러·씬·카메라·조명·하늘. 게임과 메뉴(캐릭터 미리보기)가 같은 컨텍스트를 공유한다.
 */
export class RenderContext {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  private quality: Quality = 'high';
  private readonly sky: THREE.Mesh;

  constructor(readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.domElement.id = 'game-canvas';
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(78, 1, 0.05, 400);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);

    this.scene.fog = new THREE.Fog(SKY_HORIZON, 45, 140);
    this.scene.background = SKY_HORIZON.clone();

    this.hemi = new THREE.HemisphereLight('#EAF8FF', '#9ED68A', 1.35);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight('#FFF4E0', 2.1);
    this.sun.position.set(18, 30, 12);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    const s = this.sun.shadow.camera;
    s.left = -36; s.right = 36; s.top = 36; s.bottom = -36; s.near = 1; s.far = 90;
    this.scene.add(this.sun, this.sun.target);

    this.sky = this.makeSky();
    this.scene.add(this.sky);

    this.setQuality('high');
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  setQuality(q: Quality): void {
    this.quality = q;
    const dpr = Math.min(devicePixelRatio, q === 'high' ? 2 : 1);
    this.renderer.setPixelRatio(dpr);
    this.renderer.shadowMap.enabled = q === 'high';
    this.sun.castShadow = q === 'high';
    this.sun.shadow.mapSize.setScalar(q === 'high' ? 2048 : 512);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    this.resize();
  }

  getQuality(): Quality {
    return this.quality;
  }

  setFov(fov: number): void {
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  resize(): void {
    const w = this.container.clientWidth || innerWidth;
    const h = this.container.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** 그림자 카메라가 target 주변을 따라가게 한다(큰 맵에서 그림자 해상도 확보) */
  followShadow(target: THREE.Vector3): void {
    const snap = 2;
    const x = Math.round(target.x / snap) * snap;
    const z = Math.round(target.z / snap) * snap;
    this.sun.target.position.set(x, 0, z);
    this.sun.position.set(x + 18, 30, z + 12);
    this.sky.position.copy(this.camera.position);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  private makeSky(): THREE.Mesh {
    const geo = new THREE.SphereGeometry(300, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: SKY_TOP },
        horizon: { value: SKY_HORIZON },
        bottom: { value: SKY_BOTTOM },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom;
        varying vec3 vDir;
        void main() {
          float h = vDir.y;
          vec3 c = h > 0.0 ? mix(horizon, top, pow(smoothstep(0.0, 0.7, h), 0.8)) : mix(horizon, bottom, smoothstep(0.0, -0.3, h));
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }
      `,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'sky';
    mesh.renderOrder = -1;
    mesh.frustumCulled = false;
    return mesh;
  }
}
