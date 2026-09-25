import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canPlayWithMouse, Input, readPointerEnv, type LockFailure } from '../src/core/input';

/** 포인터 잠금만 흉내 내는 최소 document(노드 환경에는 DOM 이 없다) */
class FakeDocument extends EventTarget {
  pointerLockElement: unknown = null;
  exitPointerLock(): void {
    this.pointerLockElement = null;
    this.dispatchEvent(new Event('pointerlockchange'));
  }
}

function press(target: EventTarget, code: string, type: 'keydown' | 'keyup' = 'keydown'): Event {
  const e = new Event(type, { cancelable: true });
  Object.defineProperties(e, { code: { value: code }, key: { value: code }, repeat: { value: false } });
  target.dispatchEvent(e);
  return e;
}

describe('Input — 키보드 기본 동작(Tab 포커스 이동)', () => {
  let doc: FakeDocument;
  let input: Input;
  const canvas = {} as HTMLElement;

  const lock = (locked: boolean) => {
    doc.pointerLockElement = locked ? canvas : null;
    doc.dispatchEvent(new Event('pointerlockchange'));
  };

  beforeEach(() => {
    doc = new FakeDocument();
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', new EventTarget());
    input = new Input(canvas);
  });

  afterEach(() => {
    input.dispose();
    vi.unstubAllGlobals();
  });

  it('메뉴·설정·일시정지(잠금 없음)에서는 Tab·Space 기본 동작을 막지 않는다(QA: Tab 포커스가 안 움직임)', () => {
    expect(press(doc, 'Tab').defaultPrevented).toBe(false);
    expect(press(doc, 'Space').defaultPrevented).toBe(false);
    // 게임 키로 보지 않는다(일시정지 중 Tab 으로 포커스를 옮겨도 점수판이 뜨지 않게)
    expect(input.isDown('Tab')).toBe(false);
  });

  it('게임 중(포인터 잠금)에는 Tab(점수판)·Space(점프) 기본 동작을 막는다', () => {
    lock(true);
    expect(input.locked).toBe(true);
    expect(press(doc, 'Tab').defaultPrevented).toBe(true);
    expect(input.isDown('Tab')).toBe(true);
    expect(press(doc, 'Space').defaultPrevented).toBe(true);
    press(doc, 'Tab', 'keyup');
    expect(input.isDown('Tab')).toBe(false);
    // 잠금이 풀리면(Esc → 일시정지) 다시 포커스 이동이 된다
    lock(false);
    expect(press(doc, 'Tab').defaultPrevented).toBe(false);
  });

  it('잠금 여부와 상관없이 key 이벤트는 알린다(Esc 로 연결 취소 등)', () => {
    const seen: string[] = [];
    input.on('key', (code, down) => seen.push(`${code}:${down ? 'd' : 'u'}`));
    press(doc, 'Tab');
    press(doc, 'Tab', 'keyup');
    expect(seen).toEqual(['Tab:d', 'Tab:u']);
  });
});

describe('Input — 포인터 잠금 실패 알림(QA: 휴대폰에서 "클릭해서 시작!" 화면에 갇힘)', () => {
  let doc: FakeDocument;
  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    doc = new FakeDocument();
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', new EventTarget());
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function watch(el: unknown): { input: Input; seen: LockFailure[] } {
    const input = new Input(el as HTMLElement);
    const seen: LockFailure[] = [];
    input.on('lockerror', (r) => seen.push(r));
    return { input, seen };
  }

  it('requestPointerLock 이 없는 브라우저(iOS Safari·인앱 브라우저)는 바로 unsupported', () => {
    const { input, seen } = watch({});
    input.requestLock();
    expect(seen).toEqual(['unsupported']);
    input.dispose();
  });

  it('원시 입력 옵션 거부 → 옵션 없이 재시도 → 그것도 거부되면 failed 를 한 번만(중간의 pointerlockerror 로 두 번 알리지 않음)', async () => {
    const calls: unknown[] = [];
    const el = {
      requestPointerLock(opts?: unknown) {
        calls.push(opts);
        doc.dispatchEvent(new Event('pointerlockerror'));
        return Promise.reject(new Error('사용자 동작 없음'));
      },
    };
    const { input, seen } = watch(el);
    input.requestLock();
    await flush();
    expect(calls).toEqual([{ unadjustedMovement: true }, undefined]);
    expect(seen).toEqual(['failed']);
    input.dispose();
  });

  it('원시 입력만 거부되고 옵션 없는 재요청이 잠기면 실패로 알리지 않는다', async () => {
    const el = {
      requestPointerLock(opts?: unknown) {
        // 크로미움은 옵션 거부 때도 pointerlockerror 를 쏠 수 있다 — Promise 경로에서는 오탐하지 않아야 한다
        doc.dispatchEvent(new Event('pointerlockerror'));
        if (opts) return Promise.reject(new Error('NotSupportedError'));
        doc.pointerLockElement = el;
        doc.dispatchEvent(new Event('pointerlockchange'));
        return Promise.resolve();
      },
    };
    const { input, seen } = watch(el);
    input.requestLock();
    await flush();
    expect(input.locked).toBe(true);
    expect(seen).toEqual([]);
    input.dispose();
  });

  it('요청이 동기로 던지면(두 번 다) failed', () => {
    const el = {
      requestPointerLock() {
        throw new Error('SecurityError');
      },
    };
    const { input, seen } = watch(el);
    input.requestLock();
    expect(seen).toEqual(['failed']);
    input.dispose();
  });

  it('Promise 를 돌려주지 않는 옛 브라우저는 pointerlockerror 이벤트로 failed, 요청 없이 온 이벤트는 무시', () => {
    const { input, seen } = watch({ requestPointerLock: () => undefined });
    doc.dispatchEvent(new Event('pointerlockerror'));
    expect(seen).toEqual([]);
    input.requestLock();
    expect(seen).toEqual([]);
    doc.dispatchEvent(new Event('pointerlockerror'));
    expect(seen).toEqual(['failed']);
    doc.dispatchEvent(new Event('pointerlockerror'));
    expect(seen).toEqual(['failed']);
    input.dispose();
  });
});

describe('키보드·마우스 기기 확인(휴대폰으로 초대 링크를 열면 온라인 방에 들이지 않는다)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('정밀 포인터와 포인터 잠금이 있어야 한다', () => {
    // 데스크톱
    expect(canPlayWithMouse({ pointerLock: true, anyFine: true, anyCoarse: false })).toBe(true);
    // 터치스크린 노트북(마우스·터치패드도 있음)
    expect(canPlayWithMouse({ pointerLock: true, anyFine: true, anyCoarse: true })).toBe(true);
    // 안드로이드 Chrome: API 는 있지만 터치뿐
    expect(canPlayWithMouse({ pointerLock: true, anyFine: false, anyCoarse: true })).toBe(false);
    // iOS Safari·인앱 브라우저: API 없음
    expect(canPlayWithMouse({ pointerLock: false, anyFine: false, anyCoarse: true })).toBe(false);
    expect(canPlayWithMouse({ pointerLock: false, anyFine: true, anyCoarse: false })).toBe(false);
    // any-pointer 를 모르는 옛 브라우저는 막지 않는다
    expect(canPlayWithMouse({ pointerLock: true, anyFine: false, anyCoarse: false })).toBe(true);
  });

  it('브라우저 환경을 읽는다(API 유무·any-pointer 미디어 쿼리)', () => {
    class FakeElement {}
    (FakeElement.prototype as unknown as { requestPointerLock: () => void }).requestPointerLock = () => {};
    vi.stubGlobal('Element', FakeElement);
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(any-pointer: coarse)' }));
    expect(readPointerEnv()).toEqual({ pointerLock: true, anyFine: false, anyCoarse: true });

    // 미디어 쿼리가 던지거나 API 가 없으면 false
    vi.stubGlobal('Element', class {});
    vi.stubGlobal('matchMedia', () => {
      throw new Error('지원 안 함');
    });
    expect(readPointerEnv()).toEqual({ pointerLock: false, anyFine: false, anyCoarse: false });
  });
});
