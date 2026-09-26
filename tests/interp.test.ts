import { describe, expect, it } from 'vitest';
import { ClockOffset, SnapshotBuffer, lerpAngle, type InterpState } from '../src/net/interp';
import type { PlayerSnapshot } from '../src/types';

function snap(p: Partial<PlayerSnapshot> = {}): PlayerSnapshot {
  return {
    t: 0, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, weapon: 'soaker',
    soak: 0, tank: 1, alive: true, grounded: true, shielded: false, ...p,
  };
}

const out = (): InterpState => ({ px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, snap: snap() });

describe('ClockOffset', () => {
  it('첫 표본으로 준비되고, 보낸 쪽 시각을 내 시각으로 바꾼다', () => {
    const c = new ClockOffset();
    expect(c.ready).toBe(false);
    expect(c.toLocal(500)).toBe(500);
    c.sample(1000, 5000);
    expect(c.ready).toBe(true);
    expect(c.toLocal(1000)).toBe(5000);
    expect(c.toLocal(1100)).toBe(5100);
  });

  it('더 빨리 도착한 표본(작은 오프셋)은 즉시, 늦은 표본은 2%씩 천천히 반영(지터에 둔감)', () => {
    const c = new ClockOffset();
    c.sample(1000, 5000); // offset 4000
    c.sample(1050, 5040); // offset 3990 → 즉시
    expect(c.toLocal(0)).toBe(3990);
    c.sample(1100, 5190); // offset 4090 → 3990 + 100*0.02
    expect(c.toLocal(0)).toBeCloseTo(3992, 9);
    // 지연이 계속 늘면(보낸 쪽 시계가 느리게 감 등) 결국 따라간다
    for (let i = 0; i < 400; i++) c.sample(2000 + i, 6090 + i);
    expect(c.toLocal(0)).toBeGreaterThan(4085);
    expect(c.toLocal(0)).toBeLessThanOrEqual(4090);
  });
});

describe('lerpAngle', () => {
  it('짧은 쪽으로 돈다(±π 경계)', () => {
    expect(lerpAngle(3, -3, 0.5)).toBeCloseTo(Math.PI, 3);
    expect(lerpAngle(-3, 3, 0.5)).toBeCloseTo(-Math.PI, 3);
    expect(lerpAngle(0, 1, 0.25)).toBeCloseTo(0.25, 12);
  });

  it('거대한 값도 반복 없이 즉시 계산(악의적 yaw 로 멈추지 않음)', () => {
    const t0 = performance.now();
    const v = lerpAngle(0, 1e15, 0.5);
    expect(Number.isFinite(v)).toBe(true);
    expect(Math.abs(v)).toBeLessThanOrEqual(Math.PI / 2 + 1e-9);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});

describe('SnapshotBuffer', () => {
  it('비어 있으면 false', () => {
    expect(new SnapshotBuffer().sample(100, out())).toBe(false);
    expect(new SnapshotBuffer().latest).toBeNull();
  });

  it('두 스냅샷 사이를 선형 보간(위치·속도·시선)', () => {
    const b = new SnapshotBuffer();
    b.push(1000, snap({ px: 0, pz: 10, vx: 2, yaw: 0, pitch: 0 }));
    b.push(1100, snap({ px: 1, pz: 20, vx: 4, yaw: 1, pitch: 0.5 }));
    const o = out();
    expect(b.sample(1025, o)).toBe(true);
    expect(o.px).toBeCloseTo(0.25, 9);
    expect(o.pz).toBeCloseTo(12.5, 9);
    expect(o.vx).toBeCloseTo(2.5, 9);
    expect(o.yaw).toBeCloseTo(0.25, 9);
    expect(o.pitch).toBeCloseTo(0.125, 9);
    // 가까운 쪽 스냅샷의 이산 상태(무기·젖음 등)
    expect(o.snap.vx).toBe(2);
    b.sample(1080, o);
    expect(o.snap.vx).toBe(4);
  });

  it('시선 보간은 ±π 경계를 짧은 쪽으로', () => {
    const b = new SnapshotBuffer();
    b.push(0, snap({ yaw: 3 }));
    b.push(100, snap({ yaw: -3 }));
    const o = out();
    b.sample(50, o);
    expect(Math.abs(o.yaw)).toBeCloseTo(Math.PI, 3);
  });

  it('첫 스냅샷보다 이른 시각은 첫 스냅샷 그대로(외삽 없음)', () => {
    const b = new SnapshotBuffer();
    b.push(1000, snap({ px: 5, vx: 10 }));
    b.push(1100, snap({ px: 6, vx: 10 }));
    const o = out();
    b.sample(900, o);
    expect(o.px).toBe(5);
  });

  it('마지막 이후는 속도로 외삽, 최대 200ms', () => {
    const b = new SnapshotBuffer();
    b.push(1000, snap({ px: 0 }));
    b.push(1100, snap({ px: 1, vx: 10, vz: -5, vy: 3, grounded: false }));
    const o = out();
    b.sample(1150, o);
    expect(o.px).toBeCloseTo(1.5, 9);
    expect(o.pz).toBeCloseTo(-0.25, 9);
    expect(o.py).toBeCloseTo(0.15, 9);
    b.sample(5000, o);
    expect(o.px).toBeCloseTo(3, 9);
  });

  it('바닥에 선 스냅샷은 수직 외삽하지 않는다', () => {
    const b = new SnapshotBuffer();
    b.push(1000, snap({ py: 2, vy: -5, grounded: true }));
    const o = out();
    b.sample(1100, o);
    expect(o.py).toBe(2);
  });

  it('하나뿐이면 그 스냅샷에서 외삽(최대 200ms)', () => {
    const b = new SnapshotBuffer();
    b.push(1000, snap({ px: 1, vx: 1 }));
    const o = out();
    b.sample(1100, o);
    expect(o.px).toBeCloseTo(1.1, 9);
    b.sample(9000, o);
    expect(o.px).toBeCloseTo(1.2, 9);
  });

  it('쓰러짐/부활 경계는 보간하지 않고 뒤 스냅샷으로 끊어 보인다(부활 순간이동이 미끄러지지 않게)', () => {
    const b = new SnapshotBuffer();
    b.push(1000, snap({ px: 0, alive: false }));
    b.push(1100, snap({ px: 50, alive: true }));
    const o = out();
    b.sample(1010, o);
    expect(o.px).toBe(50);
    expect(o.snap.alive).toBe(true);
  });

  it('순서가 뒤바뀌거나 중복된 스냅샷은 버린다', () => {
    const b = new SnapshotBuffer();
    b.push(1000, snap({ px: 1 }));
    b.push(1100, snap({ px: 2 }));
    b.push(1050, snap({ px: 99 }));
    b.push(1100, snap({ px: 98 }));
    expect(b.latest?.px).toBe(2);
    const o = out();
    b.sample(1050, o);
    expect(o.px).toBeCloseTo(1.5, 9);
  });

  it('최근 32개만 보관', () => {
    const b = new SnapshotBuffer();
    for (let i = 0; i < 40; i++) b.push(i * 50, snap({ px: i }));
    const o = out();
    b.sample(0, o); // 가장 오래된 8개는 사라졌으므로 첫 보관분(px=8)
    expect(o.px).toBe(8);
    expect(b.latest?.px).toBe(39);
    b.clear();
    expect(b.sample(0, o)).toBe(false);
  });
});
