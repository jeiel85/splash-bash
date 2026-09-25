import * as THREE from 'three';
import { CollisionWorld } from './collision';
import type { TeamId } from '../types';
import { JUMPPAD } from '../config';

export interface SpawnPoint { pos: THREE.Vector3; yaw: number; team: TeamId }
export interface Fountain { pos: THREE.Vector3; radius: number }
export interface JumpPad { pos: THREE.Vector3; radius: number; power: number }
export interface Waypoint { id: string; pos: THREE.Vector3; links: string[] }
export interface MapBounds { minX: number; maxX: number; minZ: number; maxZ: number; killY: number }

/**
 * 로드된 맵. 시각 루트 + 충돌 + 게임플레이 마커(docs/ASSETS.md 의 map 규약).
 */
export interface GameMap {
  name: string;
  root: THREE.Object3D;
  collision: CollisionWorld;
  spawns: SpawnPoint[];
  fountains: Fountain[];
  jumpPads: JumpPad[];
  waypoints: Map<string, Waypoint>;
  balloonSpots: THREE.Vector3[];
  /** 수면 박스(max.y = 수면 높이) */
  water: THREE.Box3[];
  bounds: MapBounds;
}

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

/** 조상까지 포함한 이름 중 접두사가 맞는 것이 있는지(GLTFLoader 는 다중 머티리얼 메시를 그룹으로 감싼다) */
function chainHasPrefix(obj: THREE.Object3D, stop: THREE.Object3D, prefix: string): boolean {
  for (let o: THREE.Object3D | null = obj; o && o !== stop; o = o.parent) {
    if (o.name.startsWith(prefix)) return true;
  }
  return false;
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** 오브젝트의 정면(+Z)을 카메라 yaw(−Z 가 0)로 변환 */
export function yawOf(obj: THREE.Object3D): number {
  obj.getWorldQuaternion(_q);
  _v.set(0, 0, 1).applyQuaternion(_q);
  return Math.atan2(-_v.x, -_v.z);
}

/**
 * 시각 루트(툰 변환 완료)에서 충돌·마커를 추출해 GameMap 을 만든다.
 * `Invisible` 머티리얼 메시(충돌 헬퍼)는 toonify 단계에서 이미 visible=false 로 바뀌어 있어야 한다.
 */
export function buildMapFromScene(name: string, root: THREE.Object3D): GameMap {
  root.updateMatrixWorld(true);
  const colliders: THREE.Mesh[] = [];
  const spawns: SpawnPoint[] = [];
  const fountains: Fountain[] = [];
  const jumpPads: JumpPad[] = [];
  const waypoints = new Map<string, Waypoint>();
  const balloonSpots: THREE.Vector3[] = [];
  const water: THREE.Box3[] = [];
  let bounds: MapBounds | null = null;

  root.traverse((o) => {
    const n = o.name;
    const extras = o.userData ?? {};
    if ((o as THREE.Mesh).isMesh) {
      const mesh = o as THREE.Mesh;
      if (mesh.userData.isOutline) return;
      if (chainHasPrefix(mesh, root, 'water_')) {
        water.push(new THREE.Box3().setFromObject(mesh));
        return;
      }
      if (chainHasPrefix(mesh, root, 'nocol_')) return;
      colliders.push(mesh);
      return;
    }
    const pos = o.getWorldPosition(new THREE.Vector3());
    if (n.startsWith('spawn_')) {
      const t = num(extras.team, -1);
      spawns.push({ pos, yaw: yawOf(o), team: (t === 0 || t === 1 ? t : -1) as TeamId });
    } else if (n.startsWith('fountain_')) {
      fountains.push({ pos, radius: num(extras.radius, 1.6) });
    } else if (n.startsWith('jumppad_')) {
      jumpPads.push({ pos, radius: num(extras.radius, 1.1), power: num(extras.power, JUMPPAD.defaultPower) });
    } else if (n.startsWith('wp_')) {
      const links = String(extras.links ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      waypoints.set(n, { id: n, pos, links });
    } else if (n.startsWith('balloon_')) {
      balloonSpots.push(pos);
    } else if (n === 'bounds') {
      bounds = {
        minX: num(extras.minX, -30), maxX: num(extras.maxX, 30),
        minZ: num(extras.minZ, -30), maxZ: num(extras.maxZ, 30),
        killY: num(extras.killY, -10),
      };
    }
  });

  // 링크는 양방향으로 정규화
  for (const wp of waypoints.values()) {
    for (const l of wp.links) {
      const other = waypoints.get(l);
      if (other && !other.links.includes(wp.id)) other.links.push(wp.id);
    }
  }

  if (!spawns.length) throw new Error(`맵 ${name}: spawn_ 마커가 없습니다`);
  const collision = new CollisionWorld(colliders);
  if (!bounds) {
    const box = new THREE.Box3().setFromObject(root);
    bounds = { minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z, killY: box.min.y - 10 };
  }
  return { name, root, collision, spawns, fountains, jumpPads, waypoints, balloonSpots, water, bounds };
}

/** 점이 수면 박스 안(수면 아래)인지 */
export function isInWater(map: GameMap, p: THREE.Vector3): boolean {
  for (const b of map.water) {
    if (p.x >= b.min.x && p.x <= b.max.x && p.z >= b.min.z && p.z <= b.max.z && p.y <= b.max.y && p.y >= b.min.y - 1.5) return true;
  }
  return false;
}
