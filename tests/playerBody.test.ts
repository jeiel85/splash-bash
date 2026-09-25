import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PlayerBody } from '../src/game/playerBody';
import { emptyIntent, type Intent } from '../src/core/input';
import { buildTestArena } from '../src/world/testArena';
import type { GameMap } from '../src/world/map';
import { PLAYER, SLIDE } from '../src/config';

const DT = 1 / 60;
/** yaw: 0 = −Z 를 봄, −π/2 = +X, π = +Z */
const YAW_NEG_Z = 0;
const YAW_POS_X = -Math.PI / 2;
const YAW_POS_Z = Math.PI;

let map: GameMap;
beforeAll(() => {
  map = buildTestArena();
});

function spawn(x: number, y: number, z: number, yaw = 0, settle = 0.5): PlayerBody {
  const b = new PlayerBody(map.collision);
  b.teleport(new THREE.Vector3(x, y, z), yaw);
  run(b, settle, {});
  return b;
}

/** seconds 동안 같은 의도로 시뮬레이션. onStep 이 true 를 돌려주면 멈춤 */
function run(b: PlayerBody, seconds: number, patch: Partial<Intent>, onStep?: (b: PlayerBody) => boolean | void): number {
  const intent = { ...emptyIntent(), ...patch };
  let t = 0;
  while (t < seconds - 1e-9) {
    b.step(DT, intent);
    t += DT;
    if (onStep?.(b)) break;
  }
  return t;
}

const hSpeed = (b: PlayerBody) => Math.hypot(b.velocity.x, b.velocity.z);

describe('PlayerBody (시험장)', () => {
  it('서 있으면 바닥에 붙어 있다', () => {
    const b = spawn(0, 0.3, 8, YAW_NEG_Z, 1);
    expect(b.grounded).toBe(true);
    expect(b.position.y).toBeCloseTo(0, 2);
    expect(hSpeed(b)).toBeLessThan(1e-6);
  });

  it(`걷기 속도 ≈ ${PLAYER.walkSpeed} m/s (정면), 뒷걸음은 ×${PLAYER.backpedalScale}`, () => {
    const b = spawn(0, 0.05, 8, YAW_NEG_Z);
    run(b, 0.3, { moveZ: 1 });
    const z0 = b.position.z;
    run(b, 1, { moveZ: 1 });
    expect(z0 - b.position.z).toBeCloseTo(PLAYER.walkSpeed, 1);
    expect(b.velocity.z).toBeCloseTo(-PLAYER.walkSpeed, 3);
    expect(Math.abs(b.position.x)).toBeLessThan(1e-6);
    expect(b.grounded).toBe(true);

    const back = spawn(0, 0.05, -8, YAW_NEG_Z);
    run(back, 0.3, { moveZ: -1 });
    expect(back.velocity.z).toBeCloseTo(PLAYER.walkSpeed * PLAYER.backpedalScale, 3);
  });

  it('대각선 입력도 걷기 속도를 넘지 않는다', () => {
    const b = spawn(0, 0.05, 0, YAW_NEG_Z);
    run(b, 0.5, { moveZ: 1, moveX: 1 });
    expect(hSpeed(b)).toBeCloseTo(PLAYER.walkSpeed, 3);
  });

  it('입력을 떼면 금방 멈춘다', () => {
    const b = spawn(0, 0.05, 8, YAW_NEG_Z);
    run(b, 0.5, { moveZ: 1 });
    run(b, PLAYER.walkSpeed / PLAYER.groundDecel + 0.05, {});
    expect(hSpeed(b)).toBeLessThan(1e-6);
  });

  it('점프 최고점 ≈ v²/2g ≈ 1.2 m, 체공 ≈ 2v/g', () => {
    const b = spawn(0, 0.05, 8);
    const ground = b.position.y;
    b.step(DT, { ...emptyIntent(), jump: true, jumpPressed: true });
    expect(b.jumped).toBe(true);
    let apex = b.position.y;
    const air = run(b, 2, {}, (x) => {
      apex = Math.max(apex, x.position.y);
      return x.grounded;
    });
    const expected = (PLAYER.jumpVelocity * PLAYER.jumpVelocity) / (2 * PLAYER.gravity);
    expect(apex - ground).toBeGreaterThan(expected - 0.06);
    expect(apex - ground).toBeLessThan(expected + 0.02);
    expect(air).toBeCloseTo((2 * PLAYER.jumpVelocity) / PLAYER.gravity, 1);
    expect(b.landedSpeed).toBeGreaterThan(5);
  });

  it('경사로를 걸어 올라간다(미끄러지거나 막히지 않음)', () => {
    // 경사로 방향은 레이캐스트로 찾는다(시험장 배치가 바뀌어도 성립)
    const down = new THREE.Vector3(0, -1, 0);
    const slope: Array<{ z: number; y: number }> = [];
    for (let z = -4; z <= 12; z += 0.25) {
      const h = map.collision.raycast(new THREE.Vector3(8, 10, z), down, 20);
      if (h && h.normal.y > PLAYER.groundNormalY && h.normal.y < 0.99) slope.push({ z, y: h.point.y });
    }
    expect(slope.length).toBeGreaterThan(8);
    const low = slope.reduce((a, b) => (b.y < a.y ? b : a));
    const high = slope.reduce((a, b) => (b.y > a.y ? b : a));
    const yaw = high.z < low.z ? YAW_NEG_Z : YAW_POS_Z;
    const b = spawn(8, low.y + 0.3, low.z, yaw, 0.3);
    expect(b.grounded).toBe(true);
    let top = b.position.y;
    let airborneFrames = 0;
    run(b, 3, { moveZ: 1 }, (x) => {
      if (!x.grounded) airborneFrames++;
      top = Math.max(top, x.position.y);
      return Math.abs(x.position.z - high.z) < 0.3;
    });
    expect(top).toBeGreaterThan(high.y - 0.3);
    expect(airborneFrames).toBeLessThan(3);
    // 오르막에서도 수평 속도는 거의 유지
    expect(hSpeed(b)).toBeGreaterThan(PLAYER.walkSpeed * 0.8);
  });

  it('벽에 비스듬히 부딪히면 벽을 따라 미끄러진다', () => {
    // 동쪽 벽 안쪽 면 x = 20
    const b = spawn(15, 0.05, 6, -Math.PI / 4);
    run(b, 2.5, { moveZ: 1 });
    expect(b.position.x).toBeLessThanOrEqual(20 - PLAYER.radius + 0.01);
    expect(b.position.x).toBeGreaterThan(20 - PLAYER.radius - 0.05);
    const z0 = b.position.z;
    run(b, 0.5, { moveZ: 1 });
    // 벽 방향 성분만 사라지고 벽을 따라가는 성분(6·cos45°)은 남는다
    expect((z0 - b.position.z) / 0.5).toBeCloseTo(PLAYER.walkSpeed * Math.SQRT1_2, 0);
    expect(b.velocity.x).toBeLessThan(0.01);
  });

  it('정면으로 벽에 막히면 뚫고 나가지 않는다', () => {
    const b = spawn(15, 0.05, 0, YAW_POS_X);
    run(b, 3, { moveZ: 1 });
    expect(b.position.x).toBeLessThanOrEqual(20 - PLAYER.radius + 0.01);
    expect(hSpeed(b)).toBeLessThan(0.5);
  });

  it('슬라이드: 달리다 누르면 가속·눈높이 낮아짐, 감속 후 끝, 쿨다운 동안 재발동 없음', () => {
    const b = spawn(0, 0.05, 15, YAW_NEG_Z);
    run(b, 0.5, { moveZ: 1 });
    b.step(DT, { ...emptyIntent(), moveZ: 1, slidePressed: true });
    expect(b.slideStarted).toBe(true);
    expect(b.sliding).toBe(true);
    const start = Math.max(PLAYER.walkSpeed * SLIDE.boost, SLIDE.minSlideSpeed);
    expect(hSpeed(b)).toBeCloseTo(Math.min(SLIDE.maxSpeed, start) - SLIDE.decel * DT, 2);
    run(b, 0.3, { moveZ: 1 });
    expect(b.eyeHeight).toBeLessThan((PLAYER.eyeHeight + PLAYER.slideEyeHeight) / 2);
    const slideLeft = run(b, 2, { moveZ: 1 }, (x) => !x.sliding);
    expect(0.3 + DT + slideLeft).toBeCloseTo(SLIDE.duration, 1);
    // 쿨다운 중에는 다시 눌러도 안 됨
    b.step(DT, { ...emptyIntent(), moveZ: 1, slidePressed: true });
    expect(b.sliding).toBe(false);
    run(b, SLIDE.cooldown, { moveZ: 1 });
    expect(hSpeed(b)).toBeCloseTo(PLAYER.walkSpeed, 1);
    b.step(DT, { ...emptyIntent(), moveZ: 1, slidePressed: true });
    expect(b.sliding).toBe(true);
    // 슬라이드가 끝나면 눈높이 복귀
    run(b, SLIDE.duration + 0.5, { moveZ: 1 });
    expect(b.eyeHeight).toBeCloseTo(PLAYER.eyeHeight, 2);
  });

  it('슬라이드는 걷기보다 확실히 멀리 간다(0.8초에 25% 이상), 끝나면 걷기 속도로 이어진다', () => {
    const walk = spawn(-6, 0.05, 15, YAW_NEG_Z);
    const slide = spawn(6, 0.05, 15, YAW_NEG_Z);
    run(walk, 0.5, { moveZ: 1 });
    run(slide, 0.5, { moveZ: 1 });
    const w0 = walk.position.z;
    const s0 = slide.position.z;
    slide.step(DT, { ...emptyIntent(), moveZ: 1, slidePressed: true });
    walk.step(DT, { ...emptyIntent(), moveZ: 1 });
    expect(slide.slideStarted).toBe(true);
    // 걷기 속도에서 시작하면 최소 시작 속도 이상, 최대 속도 이하
    expect(hSpeed(slide)).toBeGreaterThanOrEqual(SLIDE.minSlideSpeed - SLIDE.decel * DT - 1e-6);
    expect(hSpeed(slide)).toBeLessThanOrEqual(SLIDE.maxSpeed);
    run(slide, SLIDE.duration - DT, { moveZ: 1 });
    run(walk, SLIDE.duration - DT, { moveZ: 1 });
    const walked = w0 - walk.position.z;
    const slid = s0 - slide.position.z;
    expect(walked).toBeCloseTo(PLAYER.walkSpeed * SLIDE.duration, 1);
    expect(slid).toBeGreaterThanOrEqual(walked * 1.25);
    // 끝날 때 걷기보다 느려져 멈칫하지 않는다
    expect(slide.grounded).toBe(true);
    run(slide, 0.1, { moveZ: 1 });
    expect(slide.sliding).toBe(false);
    expect(hSpeed(slide)).toBeCloseTo(PLAYER.walkSpeed, 1);
  });

  it('빨리 달려 들어와도 슬라이드 속도는 최대 속도를 넘지 않는다', () => {
    const b = spawn(0, 0.05, 15, YAW_NEG_Z);
    run(b, 0.5, { moveZ: 1 });
    b.velocity.z = -14; // 점프대·넉백 직후 등
    b.step(DT, { ...emptyIntent(), moveZ: 1, slidePressed: true });
    expect(b.sliding).toBe(true);
    expect(hSpeed(b)).toBeLessThanOrEqual(SLIDE.maxSpeed);
  });

  it('슬라이드는 바닥을 한 프레임 놓친 것으로는 끊기지 않는다(코요테 타임만큼 너그럽게)', () => {
    const b = spawn(0, 0.05, 15, YAW_NEG_Z);
    run(b, 0.5, { moveZ: 1 });
    b.step(DT, { ...emptyIntent(), moveZ: 1, slidePressed: true });
    run(b, 0.2, { moveZ: 1 });
    const speed = hSpeed(b);
    // 작은 턱·경사 꼭대기에서 지난 스텝이 바닥 판정을 놓친 상황
    b.grounded = false;
    b.step(DT, { ...emptyIntent(), moveZ: 1 });
    expect(b.sliding).toBe(true);
    expect(hSpeed(b)).toBeCloseTo(speed - SLIDE.decel * DT, 3);
    expect(b.grounded).toBe(true);
    // 그 한 프레임에 누른 슬라이드 입력도 받는다(쿨다운이 끝난 뒤)
    run(b, SLIDE.duration + SLIDE.cooldown, { moveZ: 1 });
    expect(b.sliding).toBe(false);
    b.grounded = false;
    b.step(DT, { ...emptyIntent(), moveZ: 1, slidePressed: true });
    expect(b.slideStarted).toBe(true);
  });

  it('난간에서 슬라이드로 떨어지면 코요테 타임 뒤 공중에서 끝나고 관성은 유지, 쿨다운 적용', () => {
    // 플랫폼(윗면 y=2.5, x 5..11) 위에서 +X 로 달리다 슬라이드
    const b = spawn(5.6, 2.6, 8, YAW_POS_X);
    run(b, 0.3, { moveZ: 1 });
    expect(b.grounded).toBe(true);
    b.step(DT, { ...emptyIntent(), moveZ: 1, slidePressed: true });
    expect(b.sliding).toBe(true);
    let leftAt = -1;
    let t = 0;
    run(b, 1, { moveZ: 1 }, (x) => {
      t += DT;
      if (leftAt < 0 && !x.grounded) leftAt = t;
      return !x.sliding;
    });
    expect(leftAt).toBeGreaterThan(0);
    // 떨어진 뒤 코요테 타임(± 한 프레임) 동안은 계속 슬라이드
    expect(t - leftAt).toBeGreaterThan(PLAYER.coyoteTime - DT * 1.5);
    expect(t - leftAt).toBeLessThan(PLAYER.coyoteTime + DT * 1.5);
    expect(b.grounded).toBe(false);
    expect(b.position.x).toBeGreaterThan(11);
    // 공중 관성: 걷기보다 빠른 수평 속도가 남는다
    expect(hSpeed(b)).toBeGreaterThan(PLAYER.walkSpeed);
    // 2.5 m 낙하(≈0.5초)는 쿨다운(0.6초)보다 짧다: 착지하자마자 누르면 안 되고, 쿨다운이 끝나면 된다
    const fell = run(b, 2, { moveZ: 1 }, (x) => x.grounded);
    expect(b.grounded).toBe(true);
    expect(fell).toBeLessThan(SLIDE.cooldown);
    b.step(DT, { ...emptyIntent(), moveZ: 1, slidePressed: true });
    expect(b.sliding).toBe(false);
    run(b, SLIDE.cooldown - fell, { moveZ: 1 });
    b.step(DT, { ...emptyIntent(), moveZ: 1, slidePressed: true });
    expect(b.slideStarted).toBe(true);
  });

  it(`느리면(< ${SLIDE.minSpeed} m/s) 슬라이드 안 됨`, () => {
    const b = spawn(0, 0.05, 8, YAW_NEG_Z);
    b.step(DT, { ...emptyIntent(), moveZ: 1, slidePressed: true });
    expect(b.sliding).toBe(false);
  });

  it(`코요테 타임: 난간에서 떨어진 뒤 ${PLAYER.coyoteTime}s 안에는 점프 가능`, () => {
    // 플랫폼(윗면 y=2.5, x 5..11) 가운데서 +X 가장자리로 걸어 나감
    const leave = () => {
      const b = spawn(8, 2.6, 8, YAW_POS_X);
      expect(b.position.y).toBeCloseTo(2.5, 1);
      run(b, 3, { moveZ: 1 }, (x) => !x.grounded);
      expect(b.grounded).toBe(false);
      expect(b.position.x).toBeGreaterThan(10.5);
      return b;
    };
    const ok = leave();
    run(ok, PLAYER.coyoteTime * 0.5, { moveZ: 1 });
    ok.step(DT, { ...emptyIntent(), moveZ: 1, jump: true, jumpPressed: true });
    expect(ok.jumped).toBe(true);
    expect(ok.velocity.y).toBeGreaterThan(PLAYER.jumpVelocity - PLAYER.gravity * DT * 2);

    const late = leave();
    run(late, PLAYER.coyoteTime + 0.05, { moveZ: 1 });
    late.step(DT, { ...emptyIntent(), moveZ: 1, jump: true, jumpPressed: true });
    expect(late.jumped).toBe(false);
    expect(late.velocity.y).toBeLessThan(0);
  });

  it('점프 버퍼: 착지 직전에 누른 점프는 착지하자마자 나간다', () => {
    const b = spawn(0, 0.05, 8);
    b.step(DT, { ...emptyIntent(), jump: true, jumpPressed: true });
    // 내려오다가 바닥 조금 위(착지 0.1s 전 안쪽)에서 누름
    run(b, 2, {}, (x) => x.velocity.y < 0 && x.position.y < 0.3);
    expect(b.grounded).toBe(false);
    b.step(DT, { ...emptyIntent(), jumpPressed: true });
    let jumpedAgain = false;
    run(b, 0.2, {}, (x) => {
      jumpedAgain ||= x.jumped;
      return jumpedAgain;
    });
    expect(jumpedAgain).toBe(true);
  });

  it('긴 프레임(dt 0.05)도 서브스텝으로 바닥·벽을 뚫지 않는다', () => {
    const b = new PlayerBody(map.collision);
    b.teleport(new THREE.Vector3(18, 3, 0), YAW_POS_X);
    const intent = { ...emptyIntent(), moveZ: 1 };
    for (let i = 0; i < 60; i++) b.step(0.05, intent);
    expect(b.grounded).toBe(true);
    expect(b.position.y).toBeCloseTo(0, 1);
    expect(b.position.x).toBeLessThanOrEqual(20 - PLAYER.radius + 0.01);
  });
});
