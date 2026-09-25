import { Emitter } from './events';

/**
 * 한 프레임의 조작 의도. 로컬 플레이어는 키보드·마우스에서, 봇은 AI 에서 같은 구조를 만든다.
 */
export interface Intent {
  /** 좌우 이동 -1..1 (오른쪽 +) */
  moveX: number;
  /** 앞뒤 이동 -1..1 (앞 +) */
  moveZ: number;
  jump: boolean;
  /** 이번 프레임에 점프를 새로 눌렀다(점프 버퍼용) */
  jumpPressed: boolean;
  /** 이번 프레임에 슬라이드(Shift)를 새로 눌렀다 */
  slidePressed: boolean;
  fire: boolean;
  /** 이번 프레임에 발사 버튼을 새로 눌렀다(반자동 무기용) */
  firePressed: boolean;
  /** 이번 프레임에 물풍선 던지기를 눌렀다 */
  throwPressed: boolean;
  /** 이번 프레임에 고른 무기 슬롯(0..2), 없으면 null */
  weaponSlot: number | null;
  /** 휠 등으로 무기 순환 -1/0/+1 */
  weaponCycle: number;
}

export function emptyIntent(): Intent {
  return { moveX: 0, moveZ: 0, jump: false, jumpPressed: false, slidePressed: false, fire: false, firePressed: false, throwPressed: false, weaponSlot: null, weaponCycle: 0 };
}

/** 포인터 잠금 실패 이유: unsupported = 이 브라우저에 API 가 없음, failed = 요청이 거부됨 */
export type LockFailure = 'unsupported' | 'failed';

interface InputEvents {
  lockchange: (locked: boolean) => void;
  /** requestLock 이 실패했다(거부·API 없음). 성공하면 lockchange 가 온다 */
  lockerror: (reason: LockFailure) => void;
  /** 포인터 락 여부와 무관한 단축키(Tab, Esc 등) */
  key: (code: string, down: boolean) => void;
}

// ---------------------------------------------------------------- 입력 기기 확인

/** 조작 가능 여부를 가르는 브라우저 환경(테스트에서 직접 만들 수 있게 값으로 둔다) */
export interface PointerEnv {
  /** Element.requestPointerLock 이 있다 */
  pointerLock: boolean;
  /** 마우스·터치패드 같은 정밀 포인터가 하나라도 있다((any-pointer: fine)) */
  anyFine: boolean;
  /** 터치 같은 거친 포인터가 있다((any-pointer: coarse)) */
  anyCoarse: boolean;
}

function mediaMatches(query: string): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia(query).matches;
  } catch {
    return false;
  }
}

/** 지금 브라우저의 포인터 환경을 읽는다 */
export function readPointerEnv(): PointerEnv {
  const proto = typeof Element === 'undefined' ? null : (Element.prototype as Partial<Element>);
  return {
    pointerLock: typeof proto?.requestPointerLock === 'function',
    anyFine: mediaMatches('(any-pointer: fine)'),
    anyCoarse: mediaMatches('(any-pointer: coarse)'),
  };
}

/**
 * 키보드·마우스로 할 수 있는 환경인지. 포인터 잠금 API 가 없거나(iOS Safari·인앱 브라우저),
 * 터치만 있고 정밀 포인터가 없으면(휴대폰·태블릿) 조준할 방법이 없다.
 * any-pointer 를 모르는 옛 브라우저는 두 값이 모두 false 라 막지 않는다(잘못 막는 쪽을 피한다).
 */
export function canPlayWithMouse(env: PointerEnv): boolean {
  return env.pointerLock && !(env.anyCoarse && !env.anyFine);
}

/** 키보드·마우스 입력 수집기. 키는 레이아웃과 무관한 KeyboardEvent.code 로 다룬다(한글 자판 안전). */
export class Input extends Emitter<InputEvents> {
  sensitivity = 1;
  invertY = false;
  private keys = new Set<string>();
  private pressed = new Set<string>();
  private mouseDown = new Set<number>();
  private mousePressed = new Set<number>();
  private lookX = 0;
  private lookY = 0;
  private wheel = 0;
  private _locked = false;
  /**
   * 진행 중인 잠금 요청이 결과를 알리는 방식: promise = 요즘 브라우저(거부되면 reject),
   * event = Promise 를 돌려주지 않는 옛 브라우저(document 'pointerlockerror' 로만 안다)
   */
  private lockWait: 'none' | 'promise' | 'event' = 'none';
  private readonly disposers: Array<() => void> = [];

  constructor(private readonly element: HTMLElement) {
    super();
    const on = <K extends keyof DocumentEventMap>(target: Document | Window, type: K, fn: (e: DocumentEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };
    on(document, 'keydown', (e) => {
      if (this.isTypingTarget(e.target)) return;
      // 게임 중(포인터 잠금)에만 브라우저 기본 동작을 막는다: Tab = 점수판, Space = 점프.
      // 메뉴·설정·일시정지에서는 Tab 으로 포커스를 옮기고 Space 로 버튼을 누를 수 있어야 한다
      if (this._locked && (e.code === 'Tab' || e.code === 'Space')) e.preventDefault();
      if (!e.repeat) {
        this.keys.add(e.code);
        this.pressed.add(e.code);
        this.emit('key', e.code, true);
      }
    });
    on(document, 'keyup', (e) => {
      this.keys.delete(e.code);
      this.emit('key', e.code, false);
    });
    on(document, 'mousedown', (e) => {
      if (!this._locked) return;
      this.mouseDown.add(e.button);
      this.mousePressed.add(e.button);
    });
    on(document, 'mouseup', (e) => {
      this.mouseDown.delete(e.button);
    });
    on(document, 'mousemove', (e) => {
      if (!this._locked) return;
      this.lookX += e.movementX;
      this.lookY += e.movementY;
    });
    on(document, 'wheel', (e) => {
      if (!this._locked) return;
      this.wheel += Math.sign(e.deltaY);
    }, { passive: true });
    on(document, 'pointerlockchange', () => {
      this._locked = document.pointerLockElement === this.element;
      if (this._locked) this.lockWait = 'none';
      else this.releaseAll();
      this.emit('lockchange', this._locked);
    });
    // Promise 를 돌려주는 브라우저는 거기서 실패를 받는다. 원시 입력 옵션이 거부돼 옵션 없이 다시 요청하는 사이에
    // 오는 이 이벤트를 실패로 오인하지 않도록, 이벤트로만 결과를 아는 옛 브라우저의 요청일 때만 쓴다
    on(document, 'pointerlockerror', () => {
      if (this.lockWait === 'event') this.lockFailed('failed', null);
    });
    on(window as unknown as Document, 'blur', () => this.releaseAll());
    on(document, 'contextmenu', (e) => {
      if (this._locked) e.preventDefault();
    });
  }

  get locked(): boolean {
    return this._locked;
  }

  /** 포인터 잠금을 요청한다. 실패하면(거부·API 없음) 'lockerror' 로 알린다 — 화면에 안내와 나가는 길을 보이도록 */
  requestLock(): void {
    if (this._locked) return;
    if (typeof (this.element as Partial<HTMLElement>).requestPointerLock !== 'function') {
      this.lockFailed('unsupported', null);
      return;
    }
    const plain = () => {
      try {
        this.track(this.element.requestPointerLock(), (err) => this.lockFailed('failed', err));
      } catch (err) {
        this.lockFailed('failed', err);
      }
    };
    try {
      // unadjustedMovement(원시 입력)를 거부하는 브라우저는 옵션 없이 한 번 더
      this.track(this.element.requestPointerLock({ unadjustedMovement: true } as never), plain);
    } catch {
      plain();
    }
  }

  /** 요청 결과 추적: Promise 면 거부될 때 onReject, 아니면(옛 브라우저) document 'pointerlockerror' 를 기다린다 */
  private track(result: unknown, onReject: (err: unknown) => void): void {
    const p = result as PromiseLike<void> | undefined;
    if (p && typeof p.then === 'function') {
      this.lockWait = 'promise';
      p.then(() => {
        if (this.lockWait === 'promise') this.lockWait = 'none';
      }, onReject);
    } else {
      this.lockWait = 'event';
    }
  }

  private lockFailed(reason: LockFailure, err: unknown): void {
    this.lockWait = 'none';
    if (this._locked) return;
    if (err !== null) console.warn('[input] 포인터 잠금 실패', err);
    this.emit('lockerror', reason);
  }

  exitLock(): void {
    if (this._locked) document.exitPointerLock();
  }

  /** 게임 키를 누르고 있는지. 포인터 잠금이 풀린 동안(메뉴에서 Tab 으로 포커스 이동 등)은 게임 입력이 아니므로 false */
  isDown(code: string): boolean {
    return this._locked && this.keys.has(code);
  }

  /** 누적된 마우스 이동을 라디안 단위 yaw/pitch 변화량으로 돌려주고 비운다. */
  consumeLook(): { dYaw: number; dPitch: number } {
    const k = 0.0022 * this.sensitivity;
    const out = { dYaw: -this.lookX * k, dPitch: -this.lookY * k * (this.invertY ? -1 : 1) };
    this.lookX = 0;
    this.lookY = 0;
    return out;
  }

  /** 이번 프레임의 조작 의도를 만들고 edge 입력(pressed)을 비운다. */
  sample(): Intent {
    const k = this.keys;
    const intent = emptyIntent();
    if (!this._locked) {
      this.pressed.clear();
      this.mousePressed.clear();
      this.wheel = 0;
      return intent;
    }
    intent.moveZ = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    intent.moveX = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    intent.jump = k.has('Space');
    intent.jumpPressed = this.pressed.has('Space');
    intent.slidePressed = this.pressed.has('ShiftLeft') || this.pressed.has('ShiftRight') || this.pressed.has('KeyC');
    intent.fire = this.mouseDown.has(0);
    intent.firePressed = this.mousePressed.has(0);
    intent.throwPressed = this.pressed.has('KeyG') || this.pressed.has('KeyQ') || this.mousePressed.has(2);
    if (this.pressed.has('Digit1')) intent.weaponSlot = 0;
    if (this.pressed.has('Digit2')) intent.weaponSlot = 1;
    if (this.pressed.has('Digit3')) intent.weaponSlot = 2;
    intent.weaponCycle = Math.sign(this.wheel);
    this.pressed.clear();
    this.mousePressed.clear();
    this.wheel = 0;
    return intent;
  }

  private releaseAll(): void {
    this.keys.clear();
    this.pressed.clear();
    this.mouseDown.clear();
    this.mousePressed.clear();
    this.lookX = this.lookY = 0;
    this.wheel = 0;
  }

  private isTypingTarget(t: EventTarget | null): boolean {
    const el = t as HTMLElement | null;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  dispose(): void {
    this.disposers.forEach((d) => d());
    this.clear();
  }
}
