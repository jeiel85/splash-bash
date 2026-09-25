import { describe, expect, it } from 'vitest';
import { FrameClock, simulationPaused } from '../src/core/loop';

describe('일시정지 정책(simulationPaused)', () => {
  it('연습(오프라인)은 포인터 잠금이 풀리면 멈추고, 온라인은 멈추지 않는다', () => {
    expect(simulationPaused(false, false, true)).toBe(true);
    expect(simulationPaused(false, true, true)).toBe(false);
    expect(simulationPaused(true, false, true)).toBe(false);
    expect(simulationPaused(true, true, true)).toBe(false);
  });

  it('첫 프레임은 잠금 전이라도 한 번 돌린다(카메라·HUD 맞추기)', () => {
    expect(simulationPaused(false, false, false)).toBe(false);
  });
});

describe('FrameClock', () => {
  const run = (clock: FrameClock, now: number, paused = false) => {
    const steps: number[] = [];
    const total = clock.advance(now, paused, (h) => steps.push(h));
    return { steps, total };
  };

  it('긴 프레임은 maxStep 이하로 나누고 최대 maxFrame 까지만 따라잡는다', () => {
    const c = new FrameClock(0, 0.05, 1);
    const a = run(c, 120);
    expect(a.steps.length).toBe(3);
    expect(a.steps.every((h) => h <= 0.05 + 1e-9)).toBe(true);
    expect(a.total).toBeCloseTo(0.12, 9);
    // 5초 멈춤(탭 얼림)도 1초만 시뮬레이션
    expect(run(c, 5120).total).toBeCloseTo(1, 9);
  });

  it('멈춘 동안은 step 을 부르지 않고, 다시 움직일 때 밀린 시간이 한꺼번에 들어가지 않는다(QA: 연습 모드 일시정지)', () => {
    const c = new FrameClock(0);
    expect(run(c, 16).total).toBeCloseTo(0.016, 9);
    // 20초 동안 일시정지(매 프레임 호출)
    let t = 16;
    let calls = 0;
    for (let i = 0; i < 1200; i++) {
      t += 16.7;
      calls += run(c, t, true).steps.length;
    }
    expect(calls).toBe(0);
    // 재개 첫 프레임: 한 프레임 분량만
    const resumed = run(c, t + 16.7);
    expect(resumed.total).toBeCloseTo(0.0167, 6);
    expect(resumed.steps.length).toBe(1);
  });

  it('시각이 뒤로 가면(rAF 시각 < 앞선 타이머 호출) 0 초로 본다', () => {
    const c = new FrameClock(1000);
    const r = run(c, 990);
    expect(r.total).toBe(0);
    expect(r.steps.length).toBe(0);
    expect(run(c, 1006).total).toBeCloseTo(0.016, 9);
  });
});
