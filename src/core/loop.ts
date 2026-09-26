/**
 * 화면 프레임 시간을 시뮬레이션 단계로 나눈다.
 * - 긴 프레임(탭 전환 등)은 maxStep 이하로 잘게 나눠 넘기고, 한 번에 최대 maxFrame 초까지만 따라잡는다.
 * - 멈춘 동안(연습 모드 일시정지)은 시간을 흘려보내기만 한다: 다시 움직일 때 밀린 시간이 한꺼번에 들어가지 않는다.
 */
export class FrameClock {
  private last: number;

  constructor(now: number, private readonly maxStep = 0.05, private readonly maxFrame = 1) {
    this.last = now;
  }

  /**
   * @param now 지금 시각(ms, performance.now 기준). rAF 시각이 앞선 타이머 호출보다 이를 수 있어 뒤로 가면 0 으로 본다
   * @param paused 멈춤이면 step 을 부르지 않는다
   * @returns 이번에 시뮬레이션한 시간(초)
   */
  advance(now: number, paused: boolean, step: (dt: number) => void): number {
    let dt = Math.min(this.maxFrame, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    if (paused) return 0;
    const total = dt;
    while (dt > 0) {
      const h = Math.min(this.maxStep, dt);
      step(h);
      dt -= h;
    }
    return total;
  }
}

/**
 * 게임 시뮬레이션을 멈출지. 연습(오프라인)은 포인터 잠금이 풀리면(일시정지·시작 안내) 멈춘다.
 * 온라인은 다른 사람이 계속 움직이고 호스트가 경기·봇을 돌려야 하므로 멈출 수 없다.
 * 첫 프레임은 카메라·HUD 를 맞추려고 한 번 돌린다(연습은 잠금이 비동기로 걸리기 전에 화면이 먼저 나온다).
 */
export function simulationPaused(online: boolean, locked: boolean, started: boolean): boolean {
  return started && !online && !locked;
}
