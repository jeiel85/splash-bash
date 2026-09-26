import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ProjectileSystem, segCapsuleDistSq, soakAt, type HitTarget } from '../src/game/projectiles';
import { pelletDirections } from '../src/game/weapons';
import { buildTestArena } from '../src/world/testArena';
import type { GameMap } from '../src/world/map';
import { PLAYER, STREAM, WEAPONS } from '../src/config';
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

  // 회귀(gameplay-4): 예전 구현은 끝점·수평 최근접점·축 끝 높이 교차점만 봐서, 반구 구간 안쪽의 3D 최근접점을 놓쳤다(0.5 → 0.707)
  it('45° 로 내려오며 머리(위 반구)를 0.5 m 로 스치는 선분은 0.5²', () => {
    const f = v(3, 0.5, -2);
    const c = v(f.x, f.y + AXIS_HI, f.z); // 위 반구 중심
    const s = Math.SQRT1_2;
    const closest = c.clone().add(v(0.5 * s, 0.5 * s, 0));
    const dir = v(s, -s, 0);
    const p = closest.clone().addScaledVector(dir, -0.5);
    const q = closest.clone().addScaledVector(dir, 0.5);
    expect(segCapsuleDistSq(p, q, f, out)).toBeCloseTo(0.25, 12);
    expect(out.distanceTo(closest)).toBeLessThan(1e-9);
  });

  it('비스듬히 올라가며 발(아래 반구)을 0.3 m 로 스치는 선분은 0.3²', () => {
    const f = v(-1, 2, 4);
    const c = v(f.x, f.y + AXIS_LO, f.z); // 아래 반구 중심
    const n = v(0.2, -1, 0.5).normalize(); // 중심 → 최근접점(아래쪽 바깥)
    const dir = v(1, 0, 0).addScaledVector(n, -n.x).normalize(); // n 에 수직인 진행 방향
    const closest = c.clone().addScaledVector(n, 0.3);
    const p = closest.clone().addScaledVector(dir, -0.7);
    const q = closest.clone().addScaledVector(dir, 0.4);
    expect(segCapsuleDistSq(p, q, f, out)).toBeCloseTo(0.09, 12);
    expect(out.distanceTo(closest)).toBeLessThan(1e-9);
  });

  it('길이 0 선분(점)은 점과 축 사이 거리', () => {
    const p = v(0.3, AXIS_HI + 0.4, 0);
    expect(segCapsuleDistSq(p, p.clone(), feet, out)).toBeCloseTo(0.25, 12);
    expect(out.toArray()).toEqual(p.toArray());
  });

  it('무작위 선분 전수 비교: 참값(볼록 함수 삼분 탐색)과 같고 out 은 선분 위 최근접점', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const f = v(0, 0, 0);
    let worst = 0;
    for (let i = 0; i < 20000; i++) {
      f.set(rnd() * 40 - 20, rnd() * 6 - 1, rnd() * 40 - 20);
      const p = v(f.x + rnd() * 5 - 2.5, f.y + rnd() * 5 - 1.5, f.z + rnd() * 5 - 2.5);
      const dir = v(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5);
      if (dir.lengthSq() < 1e-6) continue;
      dir.normalize();
      const r = rnd();
      const len = r < 0.3 ? rnd() * 0.3 : r < 0.8 ? 0.3 + rnd() * 1.7 : 2 + rnd() * 8;
      const q = p.clone().addScaledVector(dir, len);
      const got = segCapsuleDistSq(p, q, f, out);
      const truth = truthDistSq(p, q, f);
      worst = Math.max(worst, Math.abs(Math.sqrt(got) - Math.sqrt(truth)));
      // out 은 선분 위 점이고, 그 점에서 축까지 거리²가 반환값
      expect(pointAxisDistSq(out, f)).toBeCloseTo(got, 9);
      expect(distToSegment(out, p, q)).toBeLessThan(1e-9);
    }
    expect(worst).toBeLessThan(1e-7);
  });

  it('축과 (거의) 나란한 선분도 참값과 같다', () => {
    const f = v(1, 0, 1);
    for (const eps of [0, 1e-9, 1e-7, 1e-5, 1e-3]) {
      for (const [y0, y1] of [[5, -5], [-5, 5], [0.9, -3], [3, 1.0], [-2, 0.2], [2.5, 1.3]]) {
        const p = v(f.x + 0.35, y0, f.z - 0.2);
        const q = v(f.x + 0.35 + eps * 3, y1, f.z - 0.2 + eps);
        const got = segCapsuleDistSq(p, q, f, out);
        expect(Math.abs(Math.sqrt(got) - Math.sqrt(truthDistSq(p, q, f)))).toBeLessThan(1e-5);
        expect(pointAxisDistSq(out, f)).toBeCloseTo(got, 9);
      }
    }
  });
});

/** 점에서 캡슐 축 선분까지 거리² */
function pointAxisDistSq(pt: THREE.Vector3, feet: THREE.Vector3): number {
  const cy = Math.min(Math.max(pt.y, feet.y + AXIS_LO), feet.y + AXIS_HI);
  return (pt.x - feet.x) ** 2 + (pt.y - cy) ** 2 + (pt.z - feet.z) ** 2;
}

/**
 * 참값: 선분 위 매개변수 t 에 대한 "축까지 거리²" 는 볼록 함수(볼록 집합까지 거리 ∘ 아핀 사상)라
 * 삼분 탐색으로 최솟값을 정확히 구할 수 있다(표본 추출과 달리 구간 사이 극소를 놓치지 않음).
 */
function truthDistSq(p: THREE.Vector3, q: THREE.Vector3, feet: THREE.Vector3): number {
  const pt = new THREE.Vector3();
  const f = (t: number) => pointAxisDistSq(pt.lerpVectors(p, q, t), feet);
  let lo = 0, hi = 1;
  for (let i = 0; i < 200; i++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (f(m1) <= f(m2)) hi = m2;
    else lo = m1;
  }
  return Math.min(f(0), f(1), f((lo + hi) / 2));
}

/** 점에서 선분까지 거리 */
function distToSegment(pt: THREE.Vector3, p: THREE.Vector3, q: THREE.Vector3): number {
  return new THREE.Line3(p, q).closestPointToPoint(pt, true, new THREE.Vector3()).distanceTo(pt);
}

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

  it('위에서 45° 로 내려 쏜 물줄기가 머리를 판정 반경 안에서 스치면 맞고, 밖이면 빗맞는다', () => {
    // 권총은 직진 구간에서 한 프레임(1/60초)에 1 m 를 난다. 그 1 m 한가운데가 위 반구 중심에서 gap 만큼 떨어지도록 쏜다
    const reach = STREAM.hitRadius + PLAYER.radius;
    for (const [gap, expected] of [[reach - 0.05, ['b']], [reach + 0.05, []]] as const) {
      const { sys, hits, step } = setup([target('b')]);
      const top = v(0, AXIS_HI, -5);
      const s = Math.SQRT1_2;
      const dir = v(s, -s, 0);
      const mid = top.clone().add(v(gap * s, gap * s, 0));
      const from = mid.clone().addScaledVector(dir, -WEAPONS.pistol.speed / 60 / 2);
      sys.fireGun('a', -1, 'pistol', from, dir, 1, 0, true, color);
      step(0.5);
      expect(hits.map((h) => h.victim)).toEqual(expected);
    }
  });

  it('지연 보정(advance)만큼 앞서 출발해도 같은 대상을 맞힌다', () => {
    const { sys, hits, step } = setup([target('b')]);
    sys.fireGun('a', -1, 'soaker', origin(), aim(), 3, 0, true, color, 0.05);
    step(0.5);
    expect(hits.map((h) => h.victim)).toEqual(['b']);
  });
});

/**
 * 회귀(gameplay-5): 원격 발사 지연 보정(advance)을 한 번의 큰 오일러 스텝으로 적분하면
 * 양동이(직진 0.1초)는 공기저항·중력이 한꺼번에 걸려 발밑에 떨어지고, 물풍선은 0.5 m 넘게 짧게 터졌다.
 * 보정은 평소 프레임과 같은 간격으로 나눠 적분해야 하므로 "k/60 초 앞서 출발 = 처음부터 k 프레임 더 진행" 이어야 한다.
 */
describe('ProjectileSystem — 지연 보정(advance)은 평소 프레임과 같은 궤적', () => {
  const DT = 1 / 60;
  let map: GameMap;
  beforeAll(() => {
    map = buildTestArena();
  });

  function make(targets: HitTarget[] = []) {
    const impacts: THREE.Vector3[] = [];
    const bursts: THREE.Vector3[] = [];
    let splashes = 0;
    const sys = new ProjectileSystem(map.collision, {
      targets: () => targets,
      onHit: () => undefined,
      onImpact: (p) => impacts.push(p.clone()),
      onBodySplash: () => splashes++,
      onBurst: (p) => bursts.push(p.clone()),
    });
    return { sys, impacts, bursts, splashes: () => splashes };
  }

  /** 물방울 인스턴스 행렬(머리+뒤 방울: 위치·진행 방향·출렁임)이 같은지 */
  function expectSameDroplets(a: ProjectileSystem, b: ProjectileSystem) {
    expect(a.dropletMesh.count).toBe(b.dropletMesh.count);
    expect(a.dropletMesh.count).toBeGreaterThan(0);
    const ma = a.dropletMesh.instanceMatrix.array, mb = b.dropletMesh.instanceMatrix.array;
    let worst = 0;
    for (let i = 0; i < a.dropletMesh.count * 16; i++) worst = Math.max(worst, Math.abs(ma[i] - mb[i]));
    expect(worst).toBeLessThan(1e-5);
  }

  /** 월드 충돌 지점 목록이 같은지(순서 무관) */
  function expectSamePoints(a: THREE.Vector3[], b: THREE.Vector3[], tol: number) {
    expect(a.length).toBe(b.length);
    const key = (p: THREE.Vector3) => p.x * 1e3 + p.z;
    const sa = [...a].sort((x, y) => key(x) - key(y)), sb = [...b].sort((x, y) => key(x) - key(y));
    for (let i = 0; i < sa.length; i++) expect(sa[i].distanceTo(sb[i])).toBeLessThan(tol);
  }

  const color = new THREE.Color();
  const from = () => v(0, 1.0, 15);
  const aimAt = (pitch: number) => v(0, Math.sin(pitch), -Math.cos(pitch));

  it.each(WEAPON_IDS.map((w) => [w]))('%s: k/60 초 앞서 쏜 물줄기 = 처음부터 k 프레임 더 날린 물줄기(비행 중·착탄 지점)', (w) => {
    for (const k of [1, 3, 6, 12]) {
      for (const pitch of [-0.06, 0.25]) {
        const adv = make(), ref = make();
        adv.sys.fireGun('a', -1, w, from(), aimAt(pitch), 123, 1, false, color, k / 60);
        ref.sys.fireGun('a', -1, w, from(), aimAt(pitch), 123, 1, false, color);
        for (let i = 0; i < k; i++) ref.sys.update(DT);
        // 비행 중: 한 프레임 더 진행한 뒤 그려질 방울 행렬 비교
        adv.sys.update(DT);
        ref.sys.update(DT);
        expectSameDroplets(adv.sys, ref.sys);
        for (let i = 0; i < 60; i++) {
          adv.sys.update(DT);
          ref.sys.update(DT);
        }
        expectSamePoints(adv.impacts, ref.impacts, 1e-9);
        if (pitch < 0) expect(ref.impacts.length).toBeGreaterThan(0); // 조금 내려 쏘면 바닥에 떨어진다
      }
    }
  });

  it('양동이: 지연 보정 0.2초(직진 시간 0.1초를 넘김)여도 3.5 m 앞 대상 몸에 보정 없을 때만큼 맞는다', () => {
    const counts = [0, 0.1, 0.2].map((a) => {
      const t: HitTarget = { id: 't', team: -1, alive: true, shielded: false, pos: v(0, 0, 15 - 3.5) };
      const m = make([t]);
      m.sys.fireGun('a', -1, 'bucket', from(), v(0, 0, -1), 123, 1, false, color, a);
      for (let i = 0; i < 60; i++) m.sys.update(DT);
      return m.splashes();
    });
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts).toEqual([counts[0], counts[0], counts[0]]);
  });

  it('물풍선: k/60 초 앞서 던진 풍선은 처음부터 던진 풍선과 같은 궤적·같은 자리에서 터진다', () => {
    for (const pitch of [-0.1, 0.1, 0.3, 0.6]) {
      for (const k of [1, 3, 6, 12]) {
        const adv = make(), ref = make();
        adv.sys.throwBalloon('a', -1, v(0, 1.42, 15), aimAt(pitch), v(0, 0, 0), false, color, k / 60);
        ref.sys.throwBalloon('a', -1, v(0, 1.42, 15), aimAt(pitch), v(0, 0, 0), false, color);
        for (let i = 0; i < k; i++) ref.sys.update(DT);
        adv.sys.update(DT);
        ref.sys.update(DT);
        // 비행 중 위치(행렬의 이동 성분. 회전은 그리기용 spin 이라 보정하지 않는다)
        expect(adv.sys.balloonMesh.count).toBe(1);
        const ea = adv.sys.balloonMesh.instanceMatrix.array, eb = ref.sys.balloonMesh.instanceMatrix.array;
        for (const i of [12, 13, 14]) expect(Math.abs(ea[i] - eb[i])).toBeLessThan(1e-5);
        for (let i = 0; i < 300; i++) {
          adv.sys.update(DT);
          ref.sys.update(DT);
        }
        expect(adv.bursts).toHaveLength(1);
        expect(ref.bursts).toHaveLength(1);
        expect(adv.bursts[0].distanceTo(ref.bursts[0])).toBeLessThan(1e-9);
      }
    }
  });

  it('프레임 간격으로 나눠떨어지지 않는 보정·상한 초과 보정도 궤적이 거의 같다', () => {
    for (const pitch of [-0.1, 0.3, 0.6]) {
      const burstOf = (a: number) => {
        const m = make();
        m.sys.throwBalloon('a', -1, v(0, 1.42, 15), aimAt(pitch), v(0, 0, 0), false, color, a);
        for (let i = 0; i < 300; i++) m.sys.update(DT);
        expect(m.bursts).toHaveLength(1);
        return m.bursts[0];
      };
      const base = burstOf(0);
      for (const a of [0.013, 0.07, 0.13, 0.19]) expect(burstOf(a).distanceTo(base)).toBeLessThan(0.05);
      // 상한(0.2초)을 넘는 보정은 0.2초로 자른다
      expect(burstOf(0.5).distanceTo(burstOf(0.2))).toBeLessThan(1e-9);
    }
  });
});
