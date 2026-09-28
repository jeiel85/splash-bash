import { GAME_VERSION, PLAYER_COLORS } from '../config';
import type { SfxName } from '../audio/sfx';
import { HAT_IDS, type GameMode, type HatId } from '../types';
import { sanitizeName } from '../net/protocol';
import type { LockFailure } from '../core/input';
import { inviteLink, normalizeRoomCode, randomCosmetics, roomCodeHint, SETTING_RANGES, type Profile, type Settings } from './profile';
import { formatCount } from './visitCounter';

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
  /** 온라인 방에 들어가는 버튼(키보드·마우스가 없는 기기에서는 막는다) */
  private readonly onlineButtons = new Set<HTMLButtonElement>();
  private onlineBlocked = false;
  private busy = false;
  private readonly deviceNote: HTMLDivElement;
  private readonly inviteBox: HTMLDivElement;
  private readonly inviteCode: HTMLSpanElement;
  private readonly quick: HTMLButtonElement;
  private readonly codeRow: HTMLDivElement;
  private readonly codeInput: HTMLInputElement;
  private readonly settingsModal: HTMLDivElement;
  private readonly settingsPanel: SettingsPanel;
  private readonly visits: HTMLSpanElement;
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
    const customHead = el('div', 'card-head', custom);
    el('div', 'card-title', customHead, '내 캐릭터 꾸미기');
    const dice = el('button', 'chip dice', customHead, '🎲 랜덤');
    dice.type = 'button';
    dice.title = '색깔·모자를 무작위로 바꿔요';
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
    const colorBtns = PLAYER_COLORS.map((c, i) => {
      const b = el('button', 'swatch', colors);
      b.type = 'button';
      b.style.background = c;
      b.title = COLOR_NAMES[i] ?? `색 ${i + 1}`;
      b.setAttribute('aria-label', b.title);
      b.addEventListener('click', () => {
        profile.cosmetics.color = i;
        paintCosmetics();
        this.h.sound('click');
        this.h.onProfile(profile);
      });
      return b;
    });

    el('div', 'menu-label', custom, '모자');
    const hats = el('div', 'menu-hats', custom);
    const hatBtns = HAT_IDS.map((hat) => {
      const b = el('button', 'chip', hats, HAT_LABEL[hat]);
      b.type = 'button';
      b.addEventListener('click', () => {
        profile.cosmetics.hat = hat;
        paintCosmetics();
        this.h.sound('click');
        this.h.onProfile(profile);
      });
      return b;
    });
    // 색·모자 버튼과 🎲 랜덤이 같은 그리기 함수를 써서 선택 표시가 어긋나지 않게 한다
    const paintCosmetics = () => {
      colorBtns.forEach((b, i) => b.classList.toggle('active', profile.cosmetics.color === i));
      hatBtns.forEach((b, i) => b.classList.toggle('active', profile.cosmetics.hat === HAT_IDS[i]));
    };
    paintCosmetics();
    dice.addEventListener('click', () => {
      profile.cosmetics = randomCosmetics(profile.cosmetics);
      paintCosmetics();
      this.h.sound('click');
      this.h.onProfile(profile);
      if (!document.documentElement.classList.contains('reduce-motion')) {
        dice.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(-18deg) scale(1.1)' }, { transform: 'rotate(14deg)' }, { transform: 'rotate(0)' }], { duration: 320 });
      }
    });

    // ---- 캐릭터 자리(3D 무대가 비친다)
    this.stageSlot = el('div', 'menu-stage', grid);

    // ---- 플레이
    const play = el('section', 'menu-card menu-play', grid);
    // 키보드·마우스가 없는 기기 안내(초대 링크를 휴대폰으로 연 사람이 가장 먼저 보도록 맨 위)
    this.deviceNote = el('div', 'menu-device hidden', play);
    this.deviceNote.setAttribute('role', 'alert');
    this.inviteBox = el('div', 'menu-invite hidden', play);
    const invTop = el('div', 'menu-invite-top', this.inviteBox);
    el('span', '', invTop, '💌 초대받은 방');
    this.inviteCode = el('span', 'invite-code', invTop);
    // 문구 "참가" 는 tests/e2e/multiplayer.mjs 가 초대 링크 참가 버튼으로 찾는다(바꾸면 함께 고칠 것)
    this.onlineButton(this.button(this.inviteBox, '참가', 'big primary', () => {
      if (this.invite) this.h.onPlay({ kind: 'join', code: this.invite });
    }));

    this.quick = this.onlineButton(this.button(play, '', 'big primary quick', () => this.h.onPlay({ kind: 'quick' })));
    el('span', 'btn-title', this.quick, '빠른 대전');
    el('span', 'btn-sub', this.quick, '바로 시작 · 사람이 적으면 봇이 채워요');

    const friends = el('div', 'menu-row', play);
    this.onlineButton(this.button(friends, '방 만들기', 'secondary', () => this.h.onPlay({ kind: 'create', mode: profile.mode })));
    this.onlineButton(this.button(friends, '코드로 참가', 'secondary', () => {
      this.codeRow.classList.toggle('hidden');
      if (!this.codeRow.classList.contains('hidden')) this.codeInput.focus();
    }));
    // P2P 라 같은 방 사람끼리 IP 주소가 보인다(서버리스 구조의 한계) — 공개 방에 들어가기 전에 알린다
    el('div', 'menu-note', play, '🔒 온라인은 브라우저끼리 직접 연결돼서 같은 방 사람에게 내 IP 주소가 보여요. 모르는 사람이 싫으면 방 만들기로 친구끼리!');
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
        this.setStatus(roomCodeHint(this.codeInput.value), 'error');
        this.codeInput.focus();
        return;
      }
      this.h.onPlay({ kind: 'join', code: c });
    };
    this.codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') join();
    });
    this.onlineButton(this.button(this.codeRow, '입장', 'secondary', join));

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
    // 번들한 오픈소스(three.js·Trystero·Jua 폰트 등) 고지. tools/licenses.mjs 가 만든 public/ 파일
    const credits = el('a', 'menu-credits', foot, '크레딧·라이선스');
    credits.href = 'third-party-licenses.txt';
    credits.target = '_blank';
    credits.rel = 'noopener';
    // 방문자 수는 외부 카운터에서 늦게 오거나 못 올 수 있어 값이 생길 때까지 숨겨 둔다(setVisits)
    this.visits = el('span', 'menu-visits hidden', foot);
    this.visits.setAttribute('aria-live', 'polite');
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

  /** 사이트 방문자 수(외부 카운터). null 이면 칸을 숨긴다 */
  setVisits(n: number | null): void {
    this.visits.textContent = n === null ? '' : `👀 방문 ${formatCount(n)}`;
    this.visits.title = n === null ? '' : '이 사이트를 찾아온 방문 수(탭당 한 번 세요)';
    this.visits.classList.toggle('hidden', n === null);
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
    this.busy = busy;
    this.paintButtons();
    this.root.classList.toggle('busy', busy);
  }

  /**
   * 키보드·마우스로 할 수 없는 기기(휴대폰·태블릿·포인터 잠금 없는 브라우저)면 안내를 띄우고 온라인 입장 버튼을 막는다.
   * 들어가 봐야 조작할 수 없이 방 자리만 차지하고 다른 사람 화면에 멈춘 캐릭터로 보이기 때문이다. 연습 모드는 둔다.
   */
  setDeviceBlock(message: string | null): void {
    this.onlineBlocked = !!message;
    this.deviceNote.textContent = message ?? '';
    this.deviceNote.classList.toggle('hidden', !message);
    this.codeRow.classList.add('hidden');
    this.paintButtons();
  }

  private onlineButton(b: HTMLButtonElement): HTMLButtonElement {
    this.onlineButtons.add(b);
    return b;
  }

  private paintButtons(): void {
    for (const b of this.buttons) b.disabled = this.busy || (this.onlineBlocked && this.onlineButtons.has(b));
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
  private readonly onlineNote: HTMLDivElement;

  constructor(parent: HTMLElement, settings: Settings, onSettings: (s: Settings) => void, onResume: () => void, onLeave: () => void, sound: UiSound) {
    this.root = el('div', 'pause hidden', parent);
    const card = el('div', 'pause-card', this.root);
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', '일시정지');
    const left = el('div', 'pause-col', card);
    el('div', 'pause-title', left, '잠깐 쉬는 중');
    // 연습은 이 동안 멈추지만 온라인은 다른 사람이 계속 움직인다
    this.onlineNote = el('div', 'pause-note hidden', left, '온라인 경기는 멈추지 않아요 — 쉬는 동안에도 젖을 수 있어요!');
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

  /** @param online 온라인 경기면 "멈추지 않아요" 안내를 보인다 */
  show(v: boolean, roomCode: string | null, online = false): void {
    this.root.classList.toggle('hidden', !v);
    if (v) {
      this.invite.set(roomCode);
      this.onlineNote.classList.toggle('hidden', !online);
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

/** 포인터 잠금을 못 얻었을 때 시작 안내에 띄우는 문구 */
export const LOCK_FAILURE_TEXT: Record<LockFailure, string> = {
  unsupported: '이 기기·브라우저에서는 마우스로 조준할 수 없어요. 키보드·마우스가 있는 PC 브라우저로 열어 주세요.',
  failed: '마우스 잠금을 못 했어요 😢 다시 눌러 보고, 그래도 안 되면 메뉴로 나가 주세요.',
};

/**
 * 포인터 잠금이 없을 때: "클릭해서 시작!" + (방 코드가 있으면) 초대 카드 + 메뉴로 나가기.
 * 잠금을 끝내 못 얻는 기기(휴대폰·인앱 브라우저)에서도 이 화면에 갇히지 않도록 나가는 버튼을 늘 둔다.
 */
export class PlayPrompt {
  readonly root: HTMLDivElement;
  private readonly invite: InviteCard;
  private readonly error: HTMLDivElement;
  /** 이번 안내에서 시작 버튼을 눌렀는지(누르기 전의 자동 요청 실패는 알리지 않는다) */
  private clicked = false;

  constructor(parent: HTMLElement, onStart: () => void, onLeave: () => void, sound: UiSound) {
    // click-to-play: tools/ingame-shot.mjs 가 이 클래스로 안내를 숨긴다(호환 유지)
    this.root = el('div', 'overlay play-prompt click-to-play hidden', parent);
    const card = el('div', 'overlay-card', this.root);
    const start = el('button', 'btn big primary play-start', card, '클릭해서 시작! 💦');
    start.type = 'button';
    start.addEventListener('click', () => {
      sound('click');
      this.clicked = true;
      this.error.classList.add('hidden');
      onStart();
    });
    this.error = el('div', 'play-error hidden', card);
    this.error.setAttribute('role', 'alert');
    controlsCard(card);
    this.invite = new InviteCard(card, sound);
    const leave = el('button', 'btn ghost', card, '🚪 메뉴로 나가기');
    leave.type = 'button';
    leave.addEventListener('click', () => {
      sound('back');
      onLeave();
    });
  }

  show(v: boolean, roomCode: string | null = null): void {
    this.root.classList.toggle('hidden', !v);
    if (v) {
      this.invite.set(roomCode);
      this.clicked = false;
      this.error.classList.add('hidden');
    }
  }

  /**
   * 잠금 요청 실패를 알린다. 'failed' 는 사용자가 시작 버튼을 누른 뒤에만 보인다
   * (입장 직후 사용자 동작 없이 한 자동 요청은 브라우저가 거절하는 게 정상이라 안내할 일이 아니다).
   */
  lockFailed(reason: LockFailure): void {
    if (!this.visible || (reason === 'failed' && !this.clicked)) return;
    this.error.textContent = LOCK_FAILURE_TEXT[reason];
    this.error.classList.remove('hidden');
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }
}
