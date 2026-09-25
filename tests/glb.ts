import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/** Node 에서 GLB 파일을 파싱한다(텍스처 없는 에셋 전용). */
export function loadGlbNode(path: string): Promise<THREE.Group> {
  const buf = readFileSync(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(ab, '', (gltf) => resolve(gltf.scene), reject);
  });
}
