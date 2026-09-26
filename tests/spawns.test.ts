import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildTestArena } from '../src/world/testArena';
import type { GameMap } from '../src/world/map';
import { TEAM_RESPAWN_WINDOW_SEC, inEnemyBase, needsTeamRespawn, pickSpawn } from '../src/game/spawns';
import { mulberry32 } from '../src/core/rng';

// 시험장 팀 스폰: 0팀 (−15, ±15), 1팀 (15, ±15)
let map: GameMap;
beforeAll(() => {
  map = buildTestArena();
});

const at = (x: number, z: number) => new THREE.Vector3(x, 0, z);

describe('inEnemyBase', () => {
  it('상대 팀 스폰 근처이고 우리 스폰보다 가까우면 상대 진영', () => {
    expect(inEnemyBase(map, 0, at(15, 14))).toBe(true);
    expect(inEnemyBase(map, 1, at(-13, -16))).toBe(true);
    expect(inEnemyBase(map, 0, at(-15, 15))).toBe(false); // 우리 진영
    expect(inEnemyBase(map, 0, at(0, 0))).toBe(false); // 한가운데
    expect(inEnemyBase(map, 0, at(15, 0))).toBe(false); // 상대 스폰에서 멂
  });

  it('팀이 없으면(개인전·미정) 진영도 없다', () => {
    expect(inEnemyBase(map, -1, at(15, 15))).toBe(false);
  });
});

describe('needsTeamRespawn — 팀이 스폰 뒤에 정해지거나 바뀐 손님', () => {
  it('회귀: 임시 팀(0)으로 막 스폰했는데 진짜 팀이 1이면 우리 진영으로 다시 스폰', () => {
    const rnd = mulberry32(3);
    const first = pickSpawn(map, 0, [], null, rnd); // 임시 호스트 시절 0팀 진영
    expect(first.team).toBe(0);
    expect(needsTeamRespawn(map, 'tdm', 1, 0, 0.2, first.pos)).toBe(true);
    // 다시 스폰하면 1팀 진영이고 더는 옮길 이유가 없다
    const again = pickSpawn(map, 1, [], first, rnd);
    expect(again.team).toBe(1);
    expect(inEnemyBase(map, 1, again.pos)).toBe(false);
    expect(needsTeamRespawn(map, 'tdm', 1, 1, 0, again.pos)).toBe(false);
  });

  it('개인전 프로필로 들어와(팀 없음) 팀전 방의 팀을 받아도 막 스폰했으면 옮긴다', () => {
    expect(needsTeamRespawn(map, 'tdm', 0, -1, 1, at(0, 0))).toBe(true);
  });

  it(`스폰한 지 ${TEAM_RESPAWN_WINDOW_SEC}초가 지났으면 상대 진영에 서 있을 때만 옮긴다(싸우던 사람을 끌어오지 않음)`, () => {
    const late = TEAM_RESPAWN_WINDOW_SEC + 5;
    expect(needsTeamRespawn(map, 'tdm', 1, 0, late, at(0, 0))).toBe(false);
    expect(needsTeamRespawn(map, 'tdm', 1, 0, late, at(-15, -14))).toBe(true);
  });

  it('팀이 같거나, 개인전이거나, 아직 팀이 없으면 옮기지 않는다', () => {
    expect(needsTeamRespawn(map, 'tdm', 0, 0, 0, at(15, 15))).toBe(false);
    expect(needsTeamRespawn(map, 'ffa', -1, 0, 0, at(-15, 15))).toBe(false);
    expect(needsTeamRespawn(map, 'tdm', -1, 0, 0, at(15, 15))).toBe(false);
  });
});
