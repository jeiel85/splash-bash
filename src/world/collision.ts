import * as THREE from 'three';
import { MeshBVH, type ExtendedTriangle } from 'three-mesh-bvh';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export interface RayHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
}

export interface CapsuleContact {
  /** 캡슐을 밀어낸 총 변위 */
  push: THREE.Vector3;
  /** 접촉면 방향 중 가장 위를 향한 y 성분(바닥 판정). 접촉 없으면 -Infinity */
  maxNormalY: number;
  /** 접촉면 방향 중 가장 아래를 향한 y 성분(천장 판정). 접촉 없으면 +Infinity */
  minNormalY: number;
  /** 접촉 방향 목록(속도 투영용, 재사용 버퍼 — 다음 호출 전까지만 유효) */
  normals: THREE.Vector3[];
}

const _box = new THREE.Box3();
const _seg = new THREE.Line3();
const _triPoint = new THREE.Vector3();
const _capPoint = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _ray = new THREE.Ray();

/**
 * 정적 월드 충돌. 맵의 충돌 메시를 월드 좌표 하나의 지오메트리로 합쳐 BVH 를 만든다.
 * - 캡슐(플레이어) 밀어내기: shapecast + closestPointToSegment
 * - 레이캐스트(물방울·시야 판정): raycastFirst
 */
export class CollisionWorld {
  readonly bvh: MeshBVH;
  readonly geometry: THREE.BufferGeometry;
  private readonly normalPool: THREE.Vector3[] = [];

  constructor(meshes: THREE.Mesh[]) {
    const parts: THREE.BufferGeometry[] = [];
    for (const mesh of meshes) {
      mesh.updateWorldMatrix(true, false);
      const src = mesh.geometry;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', src.getAttribute('position').clone());
      if (src.index) g.setIndex(src.index.clone());
      g.applyMatrix4(mesh.matrixWorld);
      parts.push(g.index ? g : g.toNonIndexed());
    }
    const indexed = parts.map((g) => {
      if (g.index) return g;
      const count = g.getAttribute('position').count;
      const idx = new (count > 65535 ? Uint32Array : Uint16Array)(count);
      for (let i = 0; i < count; i++) idx[i] = i;
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      return g;
    });
    const merged = indexed.length ? mergeGeometries(indexed, false) : new THREE.BoxGeometry(0, 0, 0);
    if (!merged) throw new Error('충돌 지오메트리 병합 실패');
    parts.forEach((g) => g.dispose());
    this.geometry = merged;
    this.bvh = new MeshBVH(merged);
  }

  /**
   * 캡슐(두 구 중심 a→b, 반지름 r)을 월드 밖으로 밀어낸다. a, b 는 제자리에서 수정된다.
   */
  resolveCapsule(a: THREE.Vector3, b: THREE.Vector3, radius: number, out: CapsuleContact): CapsuleContact {
    out.push.set(0, 0, 0);
    out.maxNormalY = -Infinity;
    out.minNormalY = Infinity;
    out.normals.length = 0;
    _seg.start.copy(a);
    _seg.end.copy(b);
    // 겹침이 깊을 때를 대비해 두 번 반복
    for (let iter = 0; iter < 2; iter++) {
      let moved = false;
      _box.makeEmpty();
      _box.expandByPoint(_seg.start);
      _box.expandByPoint(_seg.end);
      _box.min.addScalar(-radius);
      _box.max.addScalar(radius);
      this.bvh.shapecast({
        intersectsBounds: (box) => box.intersectsBox(_box),
        intersectsTriangle: (tri: ExtendedTriangle) => {
          const dist = tri.closestPointToSegment(_seg, _triPoint, _capPoint);
          if (dist >= radius) return false;
          const depth = radius - dist;
          if (dist > 1e-6) {
            _dir.subVectors(_capPoint, _triPoint).divideScalar(dist);
          } else {
            tri.getNormal(_dir);
          }
          _seg.start.addScaledVector(_dir, depth);
          _seg.end.addScaledVector(_dir, depth);
          out.push.addScaledVector(_dir, depth);
          if (_dir.y > out.maxNormalY) out.maxNormalY = _dir.y;
          if (_dir.y < out.minNormalY) out.minNormalY = _dir.y;
          if (out.normals.length < 8) {
            const n = this.normalPool[out.normals.length] ?? (this.normalPool[out.normals.length] = new THREE.Vector3());
            out.normals.push(n.copy(_dir));
          }
          moved = true;
          return false;
        },
      });
      if (!moved) break;
    }
    a.copy(_seg.start);
    b.copy(_seg.end);
    return out;
  }

  /** origin 에서 dir(정규화) 방향으로 far 까지 첫 충돌. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, far: number, out?: RayHit): RayHit | null {
    _ray.origin.copy(origin);
    _ray.direction.copy(dir);
    const hit = this.bvh.raycastFirst(_ray, THREE.DoubleSide, 0, far);
    if (!hit) return null;
    const res = out ?? { point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0 };
    res.point.copy(hit.point);
    res.distance = hit.distance;
    if (hit.face) {
      res.normal.copy(hit.face.normal);
      // 뒷면을 맞췄으면 법선을 레이 쪽으로 뒤집는다
      if (res.normal.dot(dir) > 0) res.normal.negate();
    } else {
      res.normal.copy(dir).negate();
    }
    return res;
  }

  /** 두 점 사이 시야가 뚫려 있는지 */
  lineOfSight(from: THREE.Vector3, to: THREE.Vector3): boolean {
    _dir.subVectors(to, from);
    const len = _dir.length();
    if (len < 1e-4) return true;
    _dir.divideScalar(len);
    _ray.origin.copy(from);
    _ray.direction.copy(_dir);
    return this.bvh.raycastFirst(_ray, THREE.DoubleSide, 0, len - 0.05) === null;
  }

  dispose(): void {
    this.geometry.dispose();
  }
}

export function makeContact(): CapsuleContact {
  return { push: new THREE.Vector3(), maxNormalY: -Infinity, minNormalY: Infinity, normals: [] };
}
