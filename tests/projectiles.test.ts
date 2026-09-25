import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ProjectileSystem, segCapsuleDistSq, soakAt, type HitTarget } from '../src/game/projectiles';
import { pelletDirections } from '../src/game/weapons';
import { buildTestArena } from '../src/world/testArena';
import type { GameMap } from '../src/world/map';
import { PLAYER, WEAPONS } from '../src/config';
import { WEAPON_IDS, type TeamId } from '../src/types';

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const out = new THREE.Vector3();
const AXIS_LO = PLAYER.radius;
const AXIS_HI = PLAYER.height - PLAYER.radius;

describe('segCapsuleDistSq', () => {
  const feet = v(0, 0, 0);

  it('캡슐 축을 관통하는 선분은 0', () => {
    expect(segCapsuleDistSq(v(-5, 1, 0), v(5, 1, 0), feet, out)).toBeCloseTo(0, 12);
    expect(out.x).toBeCloseTo(0, 9);
  });

  it('축과 나란히 d 만큼 떨어진 선분은 d²', () => {
    expect(segCapsuleDistSq(v(0.7, -3, 0), v(0.7, 5, 0), feet, out)).toBeCloseTo(0.49, 9);
    expect(segCapsuleDistSq(v(-4, 0.9, 0.5), v(4, 0.9, 0.5), feet, out)).toBeCloseTo(0.25, 9);
  });

  it('캡슐 위를 지나는 선분은 위쪽 반구 중심까지의 거리', () => {
    const h = AXIS_HI + 1;
    expect(segCapsuleDistSq(v(-3, h, 0), v(3, h, 0), feet, out)).toBeCloseTo(1, 9);
    expect(segCapsuleDistSq(v(-3, -2, 0), v(3, -2, 0), feet, out)).toBeCloseTo((AXIS_LO + 2) ** 2, 9);
  });

  it('끝점이 캡슐 근처에서 멈추면 끝점 기준', () => {
    expect(segCapsuleDistSq(v(-5, 1, 0), v(-2, 1, 0), feet, out)).toBeCloseTo(4, 9);
    expect(out.toArray()).toEqual([-2, 1, 0]);
  });

  it('발 위치를 따라 이동', () => {
    const f = v(10, 3, -2);
    expect(segCapsuleDistSq(v(10, 3 + 1, -12), v(10, 3 + 1, 8), f, out)).toBeCloseTo(0, 9);
    expect(segCapsuleDistSq(v(0, 0, 0), v(1, 0, 0), f, out)).toBeGreaterThan(50);
  });

  it('수직으로 큰 선분(떨어지는 물방울)도 축 끝 높이를 지나면 잡는다', () => {
    expect(segCapsuleDistSq(v(0.3, 10, 0), v(0.3, -10, 0), feet, out)).toBeCloseTo(0.09, 9);
  });
});

describe('soakAt — 거리 감쇠', () => {
  it.each(WEAPON_IDS.map((w) => [w]))('%s: 가까우면 soakNear, 멀면 soakFar, 사이는 선형·단조 감소', (w) => {
    const d = WEAPONS[w];
    expect(soakAt(w, 0)).toBe(d.soakNear);
    expect(soakAt(w, d.falloffNear)).toBe(d.soakNear);
    expect(soakAt(w, d.falloffFar)).toBe(d.soakFar);
    expect(soakAt(w, d.falloffFar * 10)).toBe(d.soakFar);
    expect(soakAt(w, (d.falloffNear + d.falloffFar) / 2)).toBeCloseTo((d.soakNear + d.soakFar) / 2, 9);
    let prev = Infinity;
    for (let x = 0; x <= d.falloffFar + 1; x += 0.25) {
      const s = soakAt(w, x);
      expect(s).toBeLessThanOrEqual(prev);
      prev = s;
    }
  });
});

describe('pelletDirections — 시드 결정성(원격 재현)', () => {
  const aim = v(0.3, 0.2, -1).normalize();

  it.each(WEAPON_IDS.map((w) => [w]))('%s: 같은 시드 → 같은 방향, 다른 시드 → 다른 방향', (w) => {
    const def = WEAPONS[w];
    const a = pelletDirections(def, aim, 12345, 1.7).map((d) => d.toArray());
    const b = pelletDirections(def, aim.clone(), 12345, 1.7).map((d) => d.toArray());
    expect(a).toEqual(b);
    const c = pelletDirections(def, aim, 54321, 1.7).map((d) => d.toArray());
    expect(c).not.toEqual(a);
    expect(a).toHaveLength(def.pattern ? 1 + def.pattern.reduce((n, r) => n + r.count, 0) : def.pellets);
  });

  it.each(WEAPON_IDS.map((w) => [w]))('%s: 모든 탄은 단위 벡터이고 퍼짐 원뿔 안', (w) => {
    const def = WEAPONS[w];
    const scale = 2;
    const maxDeg = def.pattern ? Math.max(...def.pattern.map((r) => r.deg)) * scale : def.spreadDeg * scale;
    for (let seed = 1; seed < 200; seed += 7) {
      for (const d of pelletDirections(def, aim, seed, scale)) {
        expect(d.length()).toBeCloseTo(1, 9);
        expect(THREE.MathUtils.radToDeg(d.angleTo(aim))).toBeLessThanOrEqual(maxDeg + 1e-6);
      }
    }
  });

  it('양동이는 가운데 1발 + 고정 링(시드는 회전만)', () => {
    const def = WEAPONS.bucket;
    const dirs = pelletDirections(def, aim, 99, 1);
    expect(dirs[0].angleTo(aim)).toBeLessThan(1e-9);
    const ring = def.pattern!;
    let i = 1;
    for (const r of ring) {
      for (let k = 0; k < r.count; k++, i++) expect(THREE.MathUtils.radToDeg(dirs[i].angleTo(aim))).toBeCloseTo(r.deg, 6);
    }
  });

  it('시선이 거의 수직이어도 NaN 이 없다', () => {
    for (const a of [v(0, 1, 0), v(0, -1, 0), v(1e-9, 1, 0).normalize()]) {
      for (const d of pelletDirections(WEAPONS.soaker, a, 5, 1)) expect(Number.isFinite(d.x + d.y + d.z)).toBe(true);
    }
  });
});

describe('ProjectileSystem — 쏜 사람 판정(권한)', () => {
  let map: GameMap;
  beforeAll(() => {
    map = buildTestArena();
  });

  function setup(targets: HitTarget[]) {
    const hits: Array<{ shooter: string; victim: string; amount: number }> = [];
    const bodySplashes: string[] = [];
    const sys = new ProjectileSystem(map.collision, {
      targets: () => targets,
      onHit: (shooter, victim, amount) => hits.push({ shooter, victim, amount }),
      onImpact: () => undefined,
      onBodySplash: (_p, victim) => bodySplashes.push(victim),
      onBurst: () => undefined,
    });
    const step = (seconds: number) => {
      for (let t = 0; t < seconds; t += 1 / 60) sys.update(1 / 60);
    };
    return { sys, hits, bodySplashes, step };
  }

  const target = (id: string, team: TeamId = -1, extra: Partial<HitTarget> = {}): HitTarget => ({
    id, team, alive: true, shielded: false, pos: v(0, 0, -5), ...extra,
  });
  const origin = () => v(0, 1.2, 0);
  const aim = () => v(0, -0.05, -1).normalize();
  const color = new THREE.Color();

  it('권한 있는 발사는 가까운 거리 적심으로 명중을 보고한다', () => {
    const { sys, hits, step } = setup([target('b')]);
    sys.fireGun('a', -1, 'pistol', origin(), aim(), 1, 0, true, color);
    step(0.5);
    expect(hits).toEqual([{ shooter: 'a', victim: 'b', amount: WEAPONS.pistol.soakNear }]);
    expect(sys.activeCount).toBe(0);
  });

  it('권한 없는(원격 재현) 발사는 효과만 내고 명중은 보고하지 않는다', () => {
    const { sys, hits, bodySplashes, step } = setup([target('b')]);
    sys.fireGun('a', -1, 'pistol', origin(), aim(), 1, 0, false, color);
    step(0.5);
    expect(hits).toEqual([]);
    expect(bodySplashes).toEqual(['b']);
  });

  it('보호막·쓰러진 대상·같은 팀·쏜 사람 자신은 적시지 않는다', () => {
    for (const t of [target('b', -1, { shielded: true }), target('b', -1, { alive: false }), target('b', 0), target('a')]) {
      const { sys, hits, step } = setup([t]);
      sys.fireGun('a', 0, 'pistol', origin(), aim(), 1, 0, true, color);
      step(0.5);
      expect(hits).toEqual([]);
    }
  });

  it('벽 뒤의 대상은 맞지 않는다', () => {
    // 상자 crate_b(−5, 1.2, 4) 뒤에 선 대상을 반대편에서 쏨
    const { sys, hits, step } = setup([target('b', -1, { pos: v(-5, 0, 7) })]);
    sys.fireGun('a', -1, 'pistol', v(-5, 1, 1), v(0, 0, 1), 1, 0, true, color);
    step(0.5);
    expect(hits).toEqual([]);
  });

  it('지연 보정(advance)만큼 앞서 출발해도 같은 대상을 맞힌다', () => {
    const { sys, hits, step } = setup([target('b')]);
    sys.fireGun('a', -1, 'soaker', origin(), aim(), 3, 0, true, color, 0.05);
    step(0.5);
    expect(hits.map((h) => h.victim)).toEqual(['b']);
  });
});
