import { GAME_VERSION, PLAYER_COLORS } from '../config';
import type { SfxName } from '../audio/sfx';
import { HAT_IDS, type GameMode, type HatId } from '../types';
import { sanitizeName } from '../net/protocol';
import { inviteLink, normalizeRoomCode, SETTING_RANGES, type Profile, type Settings } from './profile';

export type PlayChoice =
  | { kind: 'quick' }
  | { kind: 'create'; mode: GameMode }
  | { kind: 'join'; code: string }
  | { kind: 'practice'; mode: GameMode };

export type StatusKind = 'info' | 'error' | 'ok';

const HAT_LABEL: Record<HatId, string> = {
  none: '맨머리', cap: '🧢 모자', duck: '🦆 오리', flower: '🌼 꽃', crown: '👑 왕관', frog: '🐸 개구리', bucket: '👒 벙거지',
};

const COLOR_NAMES = ['탠저린', '포도', '딸기', '민트', '레몬', '하늘', '라임', '복숭아'];

/** 조작 안내(연결 중 카드·시작 안내에서 공용) */
const CONTROLS: Array<[string, string]> = [
  ['WASD', '이동'], ['Space', '점프'], ['Shift', '슬라이드'], ['클릭', '발사'],
  ['1 2 3', '무기'], ['G', '물풍선'], ['Tab', '점수판'], ['Esc', '메뉴'],
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

function controlsCard(parent: HTMLElement): HTMLDivElement {
  const box = el('div', 'controls', parent);
  for (const [key, what] of CONTROLS) {
    const c = el('span', 'control', box);
    el('kbd', '', c, key);
    el('span', '', c, what);
  }
  return box;
}

/** UI 효과음 콜백(없으면 무음) */
export type UiSound = (name: SfxName) => void;

// ---------------------------------------------------------------- 초대 링크

/**
 * 초대 링크를 클립보드에 복사한다. Clipboard API 가 없거나 거부되면(비보안 주소 등) 예전 방식으로,
 * 그것도 안 되면 링크를 선택 가능한 입력칸에 보여 줘 직접 복사하게 한다.
 */
export async function copyInvite(code: string, button: HTMLButtonElement, manualBox: HTMLInputElement): Promise<boolean> {
  const url = inviteLink(code);
  const label = button.dataset.label ?? button.textContent ?? '';
  button.dataset.label = label;
  let ok = false;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API 없음');
    await navigator.clipboard.writeText(url);
    ok = true;
  } catch (err) {
    console.warn('[invite] 클립보드 API 복사 실패 — 대체 방식 시도', err);
    manualBox.value = url;
    manualBox.classList.remove('hidden');
    manualBox.focus();
    manualBox.select();
    try {
      ok = document.execCommand('copy');
    } catch (err2) {
      console.warn('[invite] 대체 복사도 실패 — 직접 복사 안내', err2);
      ok = false;
    }
  }
  button.textContent = ok ? '복사했어요! ✓' : '링크를 직접 복사해 주세요';
  button.classList.toggle('copied', ok);
  if (ok) manualBox.classList.add('hidden');
  setTimeout(() => {
    button.textContent = label;
    button.classList.remove('copied');
  }, 1800);
  return ok;
}

/** 방 코드 + "초대 링크 복사" 카드(일시정지·시작 안내 공용) */
class InviteCard {
  readonly root: HTMLDivElement;
  private readonly codeEl: HTMLSpanElement;
  private readonly manual: HTMLInputElement;
  private readonly copyBtn: HTMLButtonElement;
  private code: string | null = null;

  constructor(parent: HTMLElement, sound: UiSound) {
    this.root = el('div', 'invite-card hidden', parent);
    const top = el('div', 'invite-top', this.root);
    el('span', 'invite-cap', top, '친구 초대 · 방 코드');
    this.codeEl = el('span', 'invite-code', top);
    this.copyBtn = el('button', 'btn primary invite-copy', this.root, '🔗 초대 링크 복사');
    this.manual = el('input', 'menu-input invite-manual hidden', this.root);
    this.manual.readOnly = true;
    this.manual.setAttribute('aria-label', '초대 링크');
    this.copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this.code) return;
      sound('click');
      void copyInvite(this.code, this.copyBtn, this.manual);
    });
  }

  set(code: string | null): void {
    this.code = code;
    this.root.classList.toggle('hidden', !code);
    this.codeEl.textContent = code ?? '';
    this.manual.classList.add('hidden');
  }
}

// ---------------------------------------------------------------- 설정

export interface SettingsPanel {
  /** 다른 곳(메인 메뉴 ↔ 일시정지)에서 바뀐 값을 다시 그린다 */
  refresh(): void;
}

/** 설정 입력 묶음(메인 메뉴·일시정지 메뉴 공용). 같은 Settings 객체를 고친다 */
export function buildSettings(parent: HTMLElement, settings: Settings, onChange: (s: Settings) => void): SettingsPanel {
  const box = el('div', 'settings', parent);
  const refreshers: Array<() => void> = [];
  const group = (title: string) => {
    const g = el('div', 'settings-group', box);
    el('div', 'settings-group-title', g, title);
    return g;
  };
  const range = (g: HTMLElement, label: string, key: 'sensitivity' | 'volume' | 'music' | 'sfx' | 'fov', fmt: (v: number) => string) => {
    const r = el('label', 'settings-row', g);
    el('span', 'settings-name', r, label);
    const input = el('input', '', r);
    const R = SETTING_RANGES[key];
    input.type = 'range';
    input.min = String(R.min);
    input.max = String(R.max);
    input.step = String(R.step);
    const val = el('span', 'settings-val', r);
    const paint = () => {
      input.value = String(settings[key]);
      val.textContent = fmt(settings[key]);
      input.style.setProperty('--fill', `${((settings[key] - R.min) / (R.max - R.min)) * 100}%`);
    };
    input.addEventListener('input', () => {
      settings[key] = Number(input.value);
      paint();
      onChange(settings);
    });
    paint();
    refreshers.push(paint);
  };
  const toggle = (g: HTMLElement, label: string, key: 'invertY' | 'reduceMotion', note?: string) => {
    const r = el('label', 'settings-row toggle', g);
    const name = el('span', 'settings-name', r, label);
    if (note) el('small', 'settings-note', name, note);
    const cb = el('input', 'switch-input', r);
    cb.type = 'checkbox';
    el('span', 'switch', r);
    cb.addEventListener('change', () => {
      settings[key] = cb.checked;
      onChange(settings);
    });
    const paint = () => (cb.checked = settings[key]);
    paint();
    refreshers.push(paint);
  };
  const pct = (v: number) => `${Math.round(v * 100)}%`;

  const sound = group('소리');
  range(sound, '전체 음량', 'volume', pct);
  range(sound, '음악', 'music', pct);
  range(sound, '효과음', 'sfx', pct);

  const ctl = group('조작');
  range(ctl, '마우스 감도', 'sensitivity', (v) => v.toFixed(2));
  toggle(ctl, '마우스 상하 반전', 'invertY');

  const screen = group('화면');
  range(screen, '시야각', 'fov', (v) => `${v}°`);
  const q = el('div', 'settings-row', screen);
  el('span', 'settings-name', q, '그래픽 품질');
  const seg = el('div', 'segmented', q);
  const qBtns = (['high', 'low'] as const).map((v) => {
    const b = el('button', 'seg-btn', seg, v === 'high' ? '높음' : '낮음(빠름)');
    b.type = 'button';
    b.addEventListener('click', () => {
      settings.quality = v;
      paintQ();
      onChange(settings);
    });
    return b;
  });
  const paintQ = () => qBtns.forEach((b, i) => b.classList.toggle('active', (i === 0 ? 'high' : 'low') === settings.quality));
  paintQ();
  refreshers.push(paintQ);
  toggle(screen, '움직임 줄이기', 'reduceMotion', '흔들림·통통 튀는 효과를 줄여요');

  return { refresh: () => refreshers.forEach((f) => f()) };
}

// ---------------------------------------------------------------- 메인 메뉴

export interface MenuHandlers {
  /** 저장할 변경(꾸미기·닉네임 확정·모드·설정) */
  onProfile(p: Profile): void;
  /** 닉네임 입력 중 미리보기(저장 안 함) */
  onPreview(p: Profile): void;
  onPlay(c: PlayChoice): void;
  sound: UiSound;
}

/** 메인 메뉴: 왼쪽 꾸미기, 가운데 캐릭터(3D 무대), 오른쪽 플레이 카드 */
export class Menu {
  readonly root: HTMLDivElement;
  /** 캐릭터 미리보기가 보일 화면 영역(MenuStage 가 이 사각형에 캐릭터를 맞춘다) */
  readonly stageSlot: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly buttons: HTMLButtonElement[] = [];
  private readonly inviteBox: HTMLDivElement;
  private readonly inviteCode: HTMLSpanElement;
  private readonly quick: HTMLButtonElement;
  private readonly codeRow: HTMLDivElement;
  private readonly codeInput: HTMLInputElement;
  private readonly settingsModal: HTMLDivElement;
  private readonly settingsPanel: SettingsPanel;
  private invite: string | null = null;

  constructor(parent: HTMLElement, profile: Profile, private readonly h: MenuHandlers) {
    this.root = el('div', 'menu', parent);
    const grid = el('div', 'menu-grid', this.root);

    // ---- 로고
    const logo = el('header', 'menu-logo', grid);
    const title = el('h1', 'logo-title', logo);
    title.setAttribute('aria-label', 'Splash Bash!');
    let i = 0;
    for (const w of ['Splash', 'Bash!']) {
      const word = el('span', 'logo-word', title);
      word.setAttribute('aria-hidden', 'true');
      for (const ch of w) {
        const s = el('span', 'logo-letter', word, ch);
        s.style.setProperty('--i', String(i++));
      }
    }
    el('div', 'logo-sub', logo, '물총 대소동');

    // ---- 꾸미기
    const custom = el('section', 'menu-card menu-custom', grid);
    el('div', 'card-title', custom, '내 캐릭터 꾸미기');
    el('label', 'menu-label', custom, '닉네임').htmlFor = 'menu-name';
    const name = el('input', 'menu-input', custom);
    name.id = 'menu-name';
    name.maxLength = 14;
    name.autocomplete = 'off';
    name.spellcheck = false;
    name.value = profile.name;
    name.addEventListener('input', () => this.h.onPreview({ ...profile, name: sanitizeName(name.value) }));
    const commitName = () => {
      profile.name = sanitizeName(name.value);
      name.value = profile.name;
      this.h.onProfile(profile);
    };
    name.addEventListener('change', commitName);
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') name.blur();
    });

    el('div', 'menu-label', custom, '색깔');
    const colors = el('div', 'menu-swatches', custom);
    PLAYER_COLORS.forEach((c, i) => {
      const b = el('button', 'swatch', colors);
      b.type = 'button';
      b.style.background = c;
      b.title = COLOR_NAMES[i] ?? `색 ${i + 1}`;
      b.setAttribute('aria-label', b.title);
      b.classList.toggle('active', profile.cosmetics.color === i);
      b.addEventListener('click', () => {
        profile.cosmetics.color = i;
        colors.querySelectorAll('.swatch').forEach((s, j) => s.classList.toggle('active', j === i));
        this.h.sound('click');
        this.h.onProfile(profile);
      });
    });

    el('div', 'menu-label', custom, '모자');
    const hats = el('div', 'menu-hats', custom);
    HAT_IDS.forEach((hat) => {
      const b = el('button', 'chip', hats, HAT_LABEL[hat]);
      b.type = 'button';
      b.classList.toggle('active', profile.cosmetics.hat === hat);
      b.addEventListener('click', () => {
        profile.cosmetics.hat = hat;
        hats.querySelectorAll('.chip').forEach((s, j) => s.classList.toggle('active', HAT_IDS[j] === hat));
        this.h.sound('click');
        this.h.onProfile(profile);
      });
    });

    // ---- 캐릭터 자리(3D 무대가 비친다)
    this.stageSlot = el('div', 'menu-stage', grid);

    // ---- 플레이
    const play = el('section', 'menu-card menu-play', grid);
    this.inviteBox = el('div', 'menu-invite hidden', play);
    const invTop = el('div', 'menu-invite-top', this.inviteBox);
    el('span', '', invTop, '💌 초대받은 방');
    this.inviteCode = el('span', 'invite-code', invTop);
    // 문구 "참가" 는 tests/e2e/multiplayer.mjs 가 초대 링크 참가 버튼으로 찾는다(바꾸면 함께 고칠 것)
    this.button(this.inviteBox, '참가', 'big primary', () => {
      if (this.invite) this.h.onPlay({ kind: 'join', code: this.invite });
    });

    this.quick = this.button(play, '', 'big primary quick', () => this.h.onPlay({ kind: 'quick' }));
    el('span', 'btn-title', this.quick, '빠른 대전');
    el('span', 'btn-sub', this.quick, '바로 시작 · 사람이 적으면 봇이 채워요');

    const friends = el('div', 'menu-row', play);
    this.button(friends, '방 만들기', 'secondary', () => this.h.onPlay({ kind: 'create', mode: profile.mode }));
    this.button(friends, '코드로 참가', 'secondary', () => {
      this.codeRow.classList.toggle('hidden');
      if (!this.codeRow.classList.contains('hidden')) this.codeInput.focus();
    });
    this.codeRow = el('div', 'menu-join hidden', play);
    this.codeInput = el('input', 'menu-input code', this.codeRow);
    this.codeInput.placeholder = '방 코드';
    this.codeInput.maxLength = 8;
    this.codeInput.autocomplete = 'off';
    this.codeInput.spellcheck = false;
    this.codeInput.setAttribute('aria-label', '방 코드');
    const join = () => {
      const c = normalizeRoomCode(this.codeInput.value);
      if (!c) {
        this.setStatus('방 코드를 확인해 주세요 (영문·숫자 4~8자)', 'error');
        this.codeInput.focus();
        return;
      }
      this.h.onPlay({ kind: 'join', code: c });
    };
    this.codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') join();
    });
    this.button(this.codeRow, '입장', 'secondary', join);

    this.button(play, '🤖 연습 모드 (봇과 대전)', 'ghost', () => this.h.onPlay({ kind: 'practice', mode: profile.mode }));

    const modeRow = el('div', 'menu-mode', play);
    el('span', 'menu-label', modeRow, '방 만들기·연습 규칙');
    const seg = el('div', 'segmented', modeRow);
    const modeBtns = (['ffa', 'tdm'] as const).map((m) => {
      const b = el('button', 'seg-btn', seg, m === 'ffa' ? '개인전' : '팀전');
      b.type = 'button';
      b.addEventListener('click', () => {
        profile.mode = m;
        modeBtns.forEach((x, j) => x.classList.toggle('active', (j === 0 ? 'ffa' : 'tdm') === m));
        this.h.sound('click');
        this.h.onProfile(profile);
      });
      return b;
    });
    modeBtns.forEach((x, j) => x.classList.toggle('active', (j === 0 ? 'ffa' : 'tdm') === profile.mode));

    this.status = el('div', 'menu-status', play);
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');

    // ---- 아래: 조작 안내 + 설정
    const foot = el('footer', 'menu-foot', grid);
    controlsCard(foot);
    const gear = el('button', 'btn small ghost menu-gear', this.root, '⚙ 설정');
    gear.type = 'button';
    gear.addEventListener('click', () => this.openSettings(true));
    el('div', 'menu-version', this.root, `v${GAME_VERSION}`);

    // ---- 설정 창
    this.settingsModal = el('div', 'modal hidden', this.root);
    this.settingsModal.addEventListener('click', (e) => {
      if (e.target === this.settingsModal) this.openSettings(false);
    });
    const sCard = el('div', 'modal-card', this.settingsModal);
    sCard.setAttribute('role', 'dialog');
    sCard.setAttribute('aria-label', '설정');
    el('div', 'card-title', sCard, '⚙ 설정');
    this.settingsPanel = buildSettings(sCard, profile.settings, () => this.h.onProfile(profile));
    const close = el('button', 'btn primary', sCard, '닫기');
    close.type = 'button';
    close.addEventListener('click', () => this.openSettings(false));
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.settingsModal.classList.contains('hidden')) this.openSettings(false);
    });
  }

  private button(parent: HTMLElement, text: string, cls: string, fn: () => void): HTMLButtonElement {
    const b = el('button', `btn ${cls}`, parent, text);
    b.type = 'button';
    b.addEventListener('click', () => {
      if (b.disabled) return;
      fn();
    });
    this.buttons.push(b);
    return b;
  }

  private openSettings(open: boolean): void {
    if (open) this.settingsPanel.refresh();
    this.settingsModal.classList.toggle('hidden', !open);
    this.h.sound(open ? 'click' : 'back');
  }

  /** URL #room=CODE 초대: 한 번 클릭으로 참가하는 카드를 맨 위에 보여 준다 */
  setInvite(code: string | null): void {
    this.invite = code;
    this.inviteBox.classList.toggle('hidden', !code);
    this.inviteCode.textContent = code ?? '';
    this.quick.classList.toggle('primary', !code);
    this.quick.classList.toggle('secondary', !!code);
    if (code) this.codeInput.value = code;
  }

  /** 상태·오류 문구. action 이 있으면 옆에 버튼(예: 새로고침)을 붙인다 */
  setStatus(text: string, kind: StatusKind = 'info', action?: { label: string; fn: () => void }): void {
    this.status.textContent = text;
    this.status.dataset.kind = kind;
    if (action) {
      const b = el('button', 'btn small ghost status-action', this.status, action.label);
      b.type = 'button';
      b.addEventListener('click', action.fn);
    }
    this.status.classList.toggle('hidden', !text);
    if (kind === 'error' && text && !document.documentElement.classList.contains('reduce-motion')) {
      this.status.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(-3px)' }, { transform: 'translateX(0)' }], { duration: 300 });
    }
  }

  setBusy(busy: boolean): void {
    this.buttons.forEach((b) => (b.disabled = busy));
    this.root.classList.toggle('busy', busy);
  }

  show(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
    if (v) this.settingsPanel.refresh();
    else this.settingsModal.classList.add('hidden');
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }
}

// ---------------------------------------------------------------- 게임 중 메뉴

/** 게임 중 Esc 메뉴: 초대, 계속하기, 설정, 나가기 */
export class PauseMenu {
  readonly root: HTMLDivElement;
  private readonly invite: InviteCard;
  private readonly panel: SettingsPanel;

  constructor(parent: HTMLElement, settings: Settings, onSettings: (s: Settings) => void, onResume: () => void, onLeave: () => void, sound: UiSound) {
    this.root = el('div', 'pause hidden', parent);
    const card = el('div', 'pause-card', this.root);
    const left = el('div', 'pause-col', card);
    el('div', 'pause-title', left, '잠깐 쉬는 중');
    const resume = el('button', 'btn big primary', left, '계속하기');
    resume.type = 'button';
    resume.addEventListener('click', () => {
      sound('click');
      onResume();
    });
    this.invite = new InviteCard(left, sound);
    const leave = el('button', 'btn ghost', left, '🚪 방 나가기');
    leave.type = 'button';
    leave.addEventListener('click', () => {
      sound('back');
      onLeave();
    });
    const right = el('div', 'pause-col settings-col', card);
    this.panel = buildSettings(right, settings, onSettings);
  }

  show(v: boolean, roomCode: string | null): void {
    this.root.classList.toggle('hidden', !v);
    if (v) {
      this.invite.set(roomCode);
      this.panel.refresh();
    }
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }
}

// ---------------------------------------------------------------- 연결 중 / 시작 안내

/** 방 찾는 중 오버레이: 진행 문구 + 조작 안내 + 취소 */
export class ConnectingOverlay {
  readonly root: HTMLDivElement;
  private readonly text: HTMLDivElement;
  private readonly sub: HTMLDivElement;

  constructor(parent: HTMLElement, onCancel: () => void, sound: UiSound) {
    this.root = el('div', 'overlay connecting hidden', parent);
    const card = el('div', 'overlay-card', this.root);
    card.setAttribute('role', 'status');
    const drop = el('div', 'connecting-drops', card);
    for (let i = 0; i < 3; i++) el('span', 'drop', drop);
    this.text = el('div', 'overlay-title', card);
    this.sub = el('div', 'overlay-sub', card);
    el('div', 'overlay-cap', card, '조작법');
    controlsCard(card);
    const cancel = el('button', 'btn ghost', card, '취소 (Esc)');
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      sound('back');
      onCancel();
    });
  }

  show(text: string, sub = ''): void {
    this.text.textContent = text;
    this.sub.textContent = sub;
    this.sub.classList.toggle('hidden', !sub);
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }
}

/** 포인터 잠금이 없을 때: "클릭해서 시작!" + (방 코드가 있으면) 초대 카드 */
export class PlayPrompt {
  readonly root: HTMLDivElement;
  private readonly invite: InviteCard;

  constructor(parent: HTMLElement, onStart: () => void, sound: UiSound) {
    // click-to-play: tools/ingame-shot.mjs 가 이 클래스로 안내를 숨긴다(호환 유지)
    this.root = el('div', 'overlay play-prompt click-to-play hidden', parent);
    const card = el('div', 'overlay-card', this.root);
    const start = el('button', 'btn big primary play-start', card, '클릭해서 시작! 💦');
    start.type = 'button';
    start.addEventListener('click', () => {
      sound('click');
      onStart();
    });
    controlsCard(card);
    this.invite = new InviteCard(card, sound);
  }

  show(v: boolean, roomCode: string | null = null): void {
    this.root.classList.toggle('hidden', !v);
    if (v) this.invite.set(roomCode);
  }
}
