import * as THREE from 'three';
import { PLAYER } from '../config';
import type { TeamId } from '../types';
import type { GameMap, SpawnPoint } from '../world/map';

export interface SpawnThreat {
  pos: THREE.Vector3;
  team: TeamId;
  alive: boolean;
}

const _eyeA = new THREE.Vector3();
const _eyeB = new THREE.Vector3();

/**
 * 스폰 지점 점수화 [Halo 3]: 적에게 보이는 곳·가까운 곳을 피하고, 팀전이면 자기 진영을 쓴다.
 * 상위 3곳 중 무작위, 직전에 쓴 곳은 가능하면 피한다.
 */
export function pickSpawn(map: GameMap, team: TeamId, enemies: readonly SpawnThreat[], avoid?: SpawnPoint | null, rnd: () => number = Math.random): SpawnPoint {
  let candidates = map.spawns;
  if (team === 0 || team === 1) {
    const own = map.spawns.filter((s) => s.team === team);
    if (own.length) candidates = own;
  }
  const scored = candidates.map((s) => {
    let score = 1000;
    _eyeA.copy(s.pos).setY(s.pos.y + PLAYER.eyeHeight);
    for (const e of enemies) {
      if (!e.alive) continue;
      const d = e.pos.distanceTo(s.pos);
      if (d > 20) continue;
      _eyeB.copy(e.pos).setY(e.pos.y + PLAYER.eyeHeight);
      if (map.collision.lineOfSight(_eyeA, _eyeB)) score -= 500;
      else if (d < 10) score -= 250;
    }
    if (s === avoid) score -= 300;
    return { s, score: score + rnd() * 50 };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, Math.min(3, scored.length));
  return top[Math.floor(rnd() * top.length)].s;
}
