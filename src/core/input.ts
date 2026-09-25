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

interface InputEvents {
  lockchange: (locked: boolean) => void;
  /** 포인터 락 여부와 무관한 단축키(Tab, Esc 등) */
  key: (code: string, down: boolean) => void;
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
      if (!this._locked) this.releaseAll();
      this.emit('lockchange', this._locked);
    });
    on(window as unknown as Document, 'blur', () => this.releaseAll());
    on(document, 'contextmenu', (e) => {
      if (this._locked) e.preventDefault();
    });
  }

  get locked(): boolean {
    return this._locked;
  }

  requestLock(): void {
    if (this._locked) return;
    const fallback = () => {
      try {
        const p = this.element.requestPointerLock?.() as unknown as Promise<void> | undefined;
        p?.catch?.((err: unknown) => console.warn('[input] 포인터 락 실패', err));
      } catch (err) {
        console.warn('[input] 포인터 락 실패', err);
      }
    };
    try {
      const req = this.element.requestPointerLock?.({ unadjustedMovement: true } as never) as unknown as Promise<void> | undefined;
      // unadjustedMovement(원시 입력) 미지원 브라우저는 옵션 없이 재시도
      req?.catch?.(fallback);
    } catch {
      fallback();
    }
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
