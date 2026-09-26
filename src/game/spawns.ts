import * as THREE from 'three';
import { PLAYER } from '../config';
import type { GameMode, TeamId } from '../types';
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

/** 팀 스폰 지점에서 이 수평 거리(m) 안이면 그 팀 진영 */
const BASE_RADIUS = 6;
/** 스폰한 뒤 이 시간(초) 안에 팀이 정해지거나 바뀌면 어디에 있든 우리 진영으로 다시 스폰한다 */
export const TEAM_RESPAWN_WINDOW_SEC = 3;

/**
 * 팀전에서 pos 가 상대 팀 진영인지: 가장 가까운 상대 팀 스폰이 BASE_RADIUS 안이고 우리 팀 스폰보다 가깝다.
 * 팀이 없거나 맵에 상대 팀 스폰이 없으면 false
 */
export function inEnemyBase(map: GameMap, team: TeamId, pos: THREE.Vector3): boolean {
  if (team !== 0 && team !== 1) return false;
  let own = Infinity;
  let enemy = Infinity;
  for (const s of map.spawns) {
    if (s.team !== 0 && s.team !== 1) continue;
    const dx = s.pos.x - pos.x;
    const dz = s.pos.z - pos.z;
    const d2 = dx * dx + dz * dz;
    if (s.team === team) own = Math.min(own, d2);
    else enemy = Math.min(enemy, d2);
  }
  return enemy <= BASE_RADIUS * BASE_RADIUS && enemy < own;
}

/**
 * 팀전에서 스폰에 쓴 팀과 지금 팀이 다를 때 우리 진영으로 다시 스폰해야 하는지.
 * 손님은 진짜 호스트의 경기 상태를 받기 전에 임시 팀(자기 프로필 모드로 만든 임시 경기)으로 먼저 스폰하고,
 * 호스트가 바뀌어 팀을 새로 받는 경우도 있다. 막 스폰했거나(TEAM_RESPAWN_WINDOW_SEC 안) 상대 진영에 서 있으면 옮긴다 —
 * 한참 싸우던 사람을 멀리서 끌어오지는 않는다.
 */
export function needsTeamRespawn(map: GameMap, mode: GameMode, team: TeamId, spawnTeam: TeamId, sinceSpawnSec: number, pos: THREE.Vector3): boolean {
  if (mode !== 'tdm' || (team !== 0 && team !== 1) || team === spawnTeam) return false;
  return sinceSpawnSec < TEAM_RESPAWN_WINDOW_SEC || inEnemyBase(map, team, pos);
}
