import { PLAYER_COLORS } from '../config';
import { HAT_IDS, type GameMode, type HatId } from '../types';
import { sanitizeName } from '../net/protocol';
import { normalizeRoomCode, type Profile, type Settings } from './profile';

export type PlayChoice =
  | { kind: 'quick' }
  | { kind: 'create'; mode: GameMode }
  | { kind: 'join'; code: string }
  | { kind: 'practice'; mode: GameMode };

const HAT_LABEL: Record<HatId, string> = {
  none: '없음', cap: '모자', duck: '오리', flower: '꽃', crown: '왕관', frog: '개구리', bucket: '벙거지',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

/** 설정 입력 묶음(메인 메뉴·일시정지 메뉴 공용) */
export function buildSettings(parent: HTMLElement, settings: Settings, onChange: (s: Settings) => void): void {
  const box = el('div', 'settings', parent);
  const row = (label: string) => {
    const r = el('label', 'settings-row', box);
    el('span', '', r, label);
    return r;
  };
  const range = (label: string, key: 'sensitivity' | 'volume' | 'fov', min: number, max: number, step: number, fmt: (v: number) => string) => {
    const r = row(label);
    const input = el('input', '', r);
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(settings[key]);
    const val = el('span', 'settings-val', r, fmt(settings[key]));
    input.addEventListener('input', () => {
      settings[key] = Number(input.value);
      val.textContent = fmt(settings[key]);
      onChange(settings);
    });
  };
  range('마우스 감도', 'sensitivity', 0.2, 4, 0.05, (v) => v.toFixed(2));
  range('음량', 'volume', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`);
  range('시야각(FOV)', 'fov', 60, 110, 1, (v) => `${v}°`);
  const q = row('그래픽 품질');
  const sel = el('select', '', q);
  [['high', '높음'], ['low', '낮음(빠름)']].forEach(([v, t]) => {
    const o = el('option', '', sel, t);
    o.value = v;
  });
  sel.value = settings.quality;
  sel.addEventListener('change', () => {
    settings.quality = sel.value === 'low' ? 'low' : 'high';
    onChange(settings);
  });
  const inv = row('마우스 상하 반전');
  const cb = el('input', '', inv);
  cb.type = 'checkbox';
  cb.checked = settings.invertY;
  cb.addEventListener('change', () => {
    settings.invertY = cb.checked;
    onChange(settings);
  });
}

/** 메인 메뉴: 닉네임·색·모자 꾸미기, 빠른 대전/방 만들기/코드 참가/연습 */
export class Menu {
  readonly root: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly buttons: HTMLButtonElement[] = [];
  /** 캐릭터 미리보기 캔버스가 들어갈 자리 */
  readonly previewSlot: HTMLDivElement;

  constructor(
    parent: HTMLElement,
    profile: Profile,
    private readonly onProfile: (p: Profile) => void,
    private readonly onPlay: (c: PlayChoice) => void,
    initialCode: string | null,
  ) {
    this.root = el('div', 'menu', parent);
    const card = el('div', 'menu-card', this.root);
    const title = el('div', 'menu-title', card);
    el('div', 'menu-logo', title, 'Splash Bash!');
    el('div', 'menu-sub', title, '물총 대소동');

    const cols = el('div', 'menu-cols', card);
    const left = el('div', 'menu-col', cols);
    this.previewSlot = el('div', 'menu-preview', left);

    el('div', 'menu-label', left, '닉네임');
    const name = el('input', 'menu-input', left);
    name.maxLength = 14;
    name.value = profile.name;
    name.addEventListener('change', () => {
      profile.name = sanitizeName(name.value);
      name.value = profile.name;
      this.onProfile(profile);
    });

    el('div', 'menu-label', left, '색깔');
    const colors = el('div', 'menu-swatches', left);
    PLAYER_COLORS.forEach((c, i) => {
      const b = el('button', 'swatch', colors);
      b.style.background = c;
      b.setAttribute('aria-label', `색 ${i + 1}`);
      b.classList.toggle('active', profile.cosmetics.color === i);
      b.addEventListener('click', () => {
        profile.cosmetics.color = i;
        colors.querySelectorAll('.swatch').forEach((s, j) => s.classList.toggle('active', j === i));
        this.onProfile(profile);
      });
    });

    el('div', 'menu-label', left, '모자');
    const hats = el('div', 'menu-hats', left);
    HAT_IDS.forEach((h) => {
      const b = el('button', 'hat-btn', hats, HAT_LABEL[h]);
      b.classList.toggle('active', profile.cosmetics.hat === h);
      b.addEventListener('click', () => {
        profile.cosmetics.hat = h;
        hats.querySelectorAll('.hat-btn').forEach((s, j) => s.classList.toggle('active', HAT_IDS[j] === h));
        this.onProfile(profile);
      });
    });

    const right = el('div', 'menu-col', cols);
    const quick = this.button(right, '빠른 대전', 'big primary', () => this.onPlay({ kind: 'quick' }));
    quick.title = '다른 플레이어와 바로 대전(사람이 적으면 봇이 채워요)';

    el('div', 'menu-label', right, '친구와 하기');
    const modeRow = el('div', 'menu-mode', right);
    const modeBtns: HTMLButtonElement[] = [];
    (['ffa', 'tdm'] as const).forEach((m) => {
      const b = el('button', 'mode-btn', modeRow, m === 'ffa' ? '개인전' : '팀전');
      b.classList.toggle('active', profile.mode === m);
      b.addEventListener('click', () => {
        profile.mode = m;
        modeBtns.forEach((x, j) => x.classList.toggle('active', (j === 0 ? 'ffa' : 'tdm') === m));
        this.onProfile(profile);
      });
      modeBtns.push(b);
    });
    this.button(right, '방 만들기', 'secondary', () => this.onPlay({ kind: 'create', mode: profile.mode }));
    const joinRow = el('div', 'menu-join', right);
    const code = el('input', 'menu-input code', joinRow);
    code.placeholder = '방 코드';
    code.maxLength = 8;
    if (initialCode) code.value = initialCode;
    const join = () => {
      const c = normalizeRoomCode(code.value);
      if (!c) {
        this.setStatus('방 코드를 확인해 주세요 (영문·숫자 4~8자)');
        return;
      }
      this.onPlay({ kind: 'join', code: c });
    };
    code.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') join();
    });
    this.button(joinRow, '참가', 'secondary', join);
    this.button(right, '연습 모드 (봇과 대전)', 'ghost', () => this.onPlay({ kind: 'practice', mode: profile.mode }));

    const details = el('details', 'menu-settings', right);
    el('summary', '', details, '⚙ 설정');
    buildSettings(details, profile.settings, () => this.onProfile(profile));

    this.status = el('div', 'menu-status', card);
    el('div', 'menu-help', card, 'WASD 이동 · 스페이스 점프 · 마우스 발사 · 1/2/3 무기 · G 물풍선 · Tab 점수판 · Esc 메뉴');
  }

  private button(parent: HTMLElement, text: string, cls: string, fn: () => void): HTMLButtonElement {
    const b = el('button', `btn ${cls}`, parent, text);
    b.addEventListener('click', () => {
      if (!b.disabled) fn();
    });
    this.buttons.push(b);
    return b;
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }

  setBusy(busy: boolean): void {
    this.buttons.forEach((b) => (b.disabled = busy));
  }

  show(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }
}

/** 게임 중 Esc 메뉴 */
export class PauseMenu {
  readonly root: HTMLDivElement;
  private readonly codeRow: HTMLDivElement;
  private readonly codeEl: HTMLSpanElement;

  constructor(parent: HTMLElement, settings: Settings, onSettings: (s: Settings) => void, onResume: () => void, onLeave: () => void) {
    this.root = el('div', 'pause hidden', parent);
    const card = el('div', 'pause-card', this.root);
    el('div', 'pause-title', card, '일시정지');
    this.codeRow = el('div', 'pause-code hidden', card);
    el('span', '', this.codeRow, '방 코드 ');
    this.codeEl = el('span', 'code', this.codeRow);
    const copy = el('button', 'btn ghost small', this.codeRow, '초대 링크 복사');
    copy.addEventListener('click', () => {
      const url = `${location.origin}${location.pathname}#room=${this.codeEl.textContent ?? ''}`;
      navigator.clipboard?.writeText(url).then(
        () => (copy.textContent = '복사됨!'),
        () => (copy.textContent = url),
      );
    });
    const resume = el('button', 'btn big primary', card, '계속하기');
    resume.addEventListener('click', onResume);
    buildSettings(card, settings, onSettings);
    const leave = el('button', 'btn ghost', card, '방 나가기');
    leave.addEventListener('click', onLeave);
  }

  show(v: boolean, roomCode: string | null): void {
    this.root.classList.toggle('hidden', !v);
    this.codeRow.classList.toggle('hidden', !roomCode);
    this.codeEl.textContent = roomCode ?? '';
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }
}
