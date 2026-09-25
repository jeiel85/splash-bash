import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Input } from '../src/core/input';

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
