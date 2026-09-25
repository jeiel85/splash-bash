/**
 * 개발용 GLB 뷰어 — 게임과 같은 툰 파이프라인으로 에셋을 확인한다.
 *   /dev/viewer.html?file=character.glb[&node=gun_pistol][&tint=%23FF6F7D][&outline=2.6][&yaw=30][&pitch=15][&dist=3]
 * outline 은 외곽선 두께(1080p 기준 픽셀, 게임의 CHARACTER_OUTLINE 2.6 / PROP_OUTLINE 1.7). 조명·톤매핑은 게임(LOOK)과 같다.
 * node 를 생략하면 루트의 모든 자식을 한 줄로 나란히 배치한다(무기·모자 모음 파일용).
 * 로딩이 끝나면 window.__ready = true (Playwright 스크린샷 동기화용).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OUTLINE_SCREEN, TOON_TIME, makeToonMaterial, outlineScreenScale, toonify } from '../src/render/toon';
import { LOOK } from '../src/render/renderer';

declare global {
  interface Window { __ready?: boolean; __error?: string }
}

const q = new URLSearchParams(location.search);
const file = q.get('file') ?? 'character.glb';
const nodeName = q.get('node');
const tint = q.get('tint') ?? '#FF6F7D';
const outline = Number(q.get('outline') ?? '2.6');
const info = document.getElementById('info')!;

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = LOOK.exposure;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(LOOK.skyHorizon);
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.05, 500);
OUTLINE_SCREEN.value = outlineScreenScale(camera.fov);
const controls = new OrbitControls(camera, renderer.domElement);

scene.add(new THREE.HemisphereLight(LOOK.hemi.sky, LOOK.hemi.ground, LOOK.hemi.intensity));
const sun = new THREE.DirectionalLight(LOOK.sun.color, LOOK.sun.intensity);
sun.position.copy(LOOK.sunOffset).normalize().multiplyScalar(12);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -8; sun.shadow.camera.right = 8;
sun.shadow.camera.top = 8; sun.shadow.camera.bottom = -8;
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(40, 48),
  makeToonMaterial({ color: '#8BD66B' }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

new GLTFLoader().load(
  `${import.meta.env.BASE_URL}assets/models/${file}`,
  (gltf) => {
    const root = gltf.scene;
    let subject: THREE.Object3D;
    if (nodeName) {
      const n = root.getObjectByName(nodeName);
      if (!n) throw new Error(`node not found: ${nodeName}`);
      n.removeFromParent();
      n.position.set(0, 0, 0);
      subject = n;
    } else if (root.children.length === 1) {
      subject = root;
    } else {
      // 여러 개면 가로로 나란히
      const group = new THREE.Group();
      let x = 0;
      for (const child of [...root.children]) {
        const box = new THREE.Box3().setFromObject(child);
        const w = Math.max(box.max.x - box.min.x, 0.2);
        child.removeFromParent();
        child.position.set(x + w / 2 - (box.min.x + box.max.x) / 2 + child.position.x, child.position.y, child.position.z);
        group.add(child);
        x += w + 0.25;
      }
      group.position.x = -x / 2;
      subject = group;
    }
    toonify(subject, { tint, outline });
    scene.add(subject);

    const box = new THREE.Box3().setFromObject(subject);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    // 바닥에 올려놓기
    if (box.min.y < 0 || nodeName) subject.position.y -= box.min.y;
    center.y -= box.min.y < 0 || nodeName ? box.min.y : 0;
    const radius = Math.max(size.x, size.y, size.z) * 0.6 + 0.1;
    const dist = Number(q.get('dist') ?? radius * 3.2);
    const yaw = THREE.MathUtils.degToRad(Number(q.get('yaw') ?? '25'));
    const pitch = THREE.MathUtils.degToRad(Number(q.get('pitch') ?? '12'));
    camera.position.set(
      center.x + Math.sin(yaw) * Math.cos(pitch) * dist,
      center.y + Math.sin(pitch) * dist,
      center.z + Math.cos(yaw) * Math.cos(pitch) * dist,
    );
    controls.target.copy(center);
    controls.update();

    let tris = 0;
    subject.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !m.userData.isOutline) {
        const g = m.geometry;
        tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
      }
    });
    info.textContent = `${file}${nodeName ? ' / ' + nodeName : ''} — ${Math.round(tris)} tris, size ${size.x.toFixed(2)}×${size.y.toFixed(2)}×${size.z.toFixed(2)} m`;
    window.__ready = true;
  },
  undefined,
  (err) => {
    info.textContent = `load error: ${String(err)}`;
    window.__error = String(err);
    window.__ready = true;
  },
);

renderer.setAnimationLoop((t) => {
  TOON_TIME.value = t / 1000;
  controls.update();
  renderer.render(scene, camera);
});
