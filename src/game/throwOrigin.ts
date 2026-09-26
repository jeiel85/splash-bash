import * as THREE from 'three';
import { BALLOON } from '../config';
import type { CollisionWorld, RayHit } from '../world/collision';

/** 물풍선을 손에서 놓는 곳: 눈에서 시선 방향으로 이만큼 앞(m) */
const HAND_REACH = 0.5;
const _hit: RayHit = { point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0 };

/**
 * 물풍선 시작점(던지는 쪽 — 나, 호스트의 봇 — 이 정하고 NetShot 으로 모든 피어가 그대로 쓴다).
 * 눈에서 시선 방향으로 HAND_REACH 앞이되, 그 사이에 벽이 있으면 풍선이 벽에 파묻히지 않게 벽 앞으로 당긴다(막혔으면 눈 위치).
 * 캡슐 반지름(0.4 m)보다 앞이라 벽에 붙어 던지면 시작점이 얇은 벽(0.06~0.08 m) 너머로 나갔고,
 * 풍선은 시작점에서 앞으로만 충돌을 보므로 가림막 너머 적에게 그대로 날아갔다.
 * @param out eye·aim 과 다른 벡터
 */
export function balloonThrowOrigin(world: CollisionWorld, eye: THREE.Vector3, aim: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const hit = world.raycast(eye, aim, HAND_REACH + BALLOON.radius, _hit);
  const reach = hit ? Math.max(0, Math.min(HAND_REACH, hit.distance - BALLOON.radius)) : HAND_REACH;
  return out.copy(eye).addScaledVector(aim, reach);
}
