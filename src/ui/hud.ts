import { BALLOON, MATCH, PLAYER, SOURCE_LABEL, TANK, TEAM_COLORS, TEAM_NAMES, WEAPONS } from '../config';
import type { Sfx } from '../audio/sfx';
import type { DamageSource, GameMode, MatchPhase, TeamId, WeaponId } from '../types';
import { WEAPON_IDS } from '../types';
import { DROP_ICON, iconEl } from './icons';

export type MoveState = 'still' | 'moving' | 'air';

export interface HudData {
  soak: number;
  tank: number;
  weapon: WeaponId;
  /** 물풍선 던질 수 있음(물 40 이상 + 쿨다운 끝) */
  balloonReady: boolean;
  alive: boolean;
  /** 리스폰까지 남은 초(살아 있으면 null) */
  respawnIn: number | null;
  soakedBy: string | null;
  shielded: boolean;
  refilling: boolean;
  lowWater: boolean;
  timerMs: number;
  phase: MatchPhase | null;
  mode: GameMode;
  myScore: number;
  leaderScore: number;
  teamScores: [number, number];
  myTeam: TeamId;
  roomLabel: string;
  playerCount: number;
  /** 이동 상태(조준선 벌어짐 계산용) */
  moveState: MoveState;
}

export interface ScoreRow {
  id: string;
  name: string;
  color: string;
  team: TeamId;
  splashes: number;
  soaked: number;
  isSelf: boolean;
  isBot: boolean;
  isHost: boolean;
  ping: number | null;
}

/** 누군가 흠뻑 젖음(킬피드·연속 기록·흠뻑 카드) */
export interface SplashFeed {
  killer: string;
  killerColor: string;
  victim: string;
  victimColor: string;
  source: DamageSource;
  /** 내가 다른 사람을 적셨다 */
  bySelf: boolean;
  /** 내가 젖었다 */
  onSelf: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

function fmtTime(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 개인 순위: 적심 많이 → 덜 젖음 → 이름 */
function byScore(a: ScoreRow, b: ScoreRow): number {
  return b.splashes - a.splashes || a.soaked - b.soaked || a.name.localeCompare(b.name);
}

/** 점수판 순서: 팀전이면 팀별로 묶는다 */
function sortRows(rows: ScoreRow[], mode: GameMode): ScoreRow[] {
  return [...rows].sort((a, b) => (mode === 'tdm' ? a.team - b.team : 0) || byScore(a, b));
}

/** 연속 기록(흠뻑 젖지 않고 연달아 적심) 알림 */
const STREAK_CALLOUTS: Record<number, { title: string; sub: string }> = {
  3: { title: '3연속 스플래시!', sub: '물총 솜씨가 반짝반짝' },
  5: { title: '5연속! 멈출 수 없어!', sub: '뒷마당이 물바다가 되어 가요' },
  8: { title: '8연속! 전설의 물총왕!', sub: '아무도 못 말려요' },
};
/** 3초 안에 연달아 적심 */
const MULTI_WINDOW = 3;
const MULTI_CALLOUTS = ['', '', '더블 스플래시!', '트리플 스플래시!', '멀티 스플래시!'];

const WAVE_DIAL = 'M0 0Q12.5 -5 25 0T50 0T75 0T100 0T125 0T150 0T175 0T200 0V110H0Z';
const WAVE_DIAL_BACK = 'M0 0Q12.5 5 25 0T50 0T75 0T100 0T125 0T150 0T175 0T200 0V110H0Z';
const WAVE_TANK = 'M0 0Q5.5 -3.2 11 0T22 0T33 0T44 0T55 0T66 0T77 0T88 0V130H0Z';

const HIT_POP: Keyframe[] = [
  { transform: 'scale(1)', opacity: 1 },
  { transform: 'scale(1.3)', opacity: 1, offset: 0.25, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
  { transform: 'scale(1)', opacity: 1, offset: 0.55 },
  { transform: 'scale(1)', opacity: 0 },
];
const FADE_OUT: Keyframe[] = [{ opacity: 1 }, { opacity: 1, offset: 0.35 }, { opacity: 0 }];
const POP_IN: Keyframe[] = [
  { transform: 'translate(-50%, 0) scale(0.4)', opacity: 0 },
  { transform: 'translate(-50%, 0) scale(1.12)', opacity: 1, offset: 0.6 },
  { transform: 'translate(-50%, 0) scale(1)', opacity: 1 },
];
const FADE_IN: Keyframe[] = [{ opacity: 0 }, { opacity: 1 }];

interface Timed { el: HTMLElement; life: number; fadeAt: number }

/**
 * 게임 중 화면 표시(DOM 오버레이). 사용자 입력 텍스트는 항상 textContent 로 넣는다(XSS 방지).
 * 매 프레임 update 는 값이 바뀐 요소만 건드린다(레이아웃·스타일 재계산 최소화).
 */
export class Hud {
  readonly root: HTMLDivElement;
  private readonly cross: HTMLDivElement;
  private readonly hitmark: HTMLDivElement;
  private readonly wet: HTMLDivElement;
  private readonly dmgArcs: SVGGElement[] = [];
  private dmgCursor = 0;
  // 상단
  private readonly scoreEl: HTMLDivElement;
  private readonly timerEl: HTMLDivElement;
  private readonly roomEl: HTMLDivElement;
  private readonly roomName: HTMLSpanElement;
  private readonly pingEl: HTMLSpanElement;
  private readonly inviteChip: HTMLDivElement;
  private readonly feed: HTMLDivElement;
  private readonly toastBox: HTMLDivElement;
  private readonly callout: HTMLDivElement;
  private readonly calloutTitle: HTMLDivElement;
  private readonly calloutSub: HTMLDivElement;
  private readonly confirm: HTMLDivElement;
  private readonly center: HTMLDivElement;
  // 젖음 다이얼
  private readonly dial: HTMLDivElement;
  private readonly dialLevel: SVGGElement;
  private readonly dialText: HTMLSpanElement;
  // 탱크·무기
  private readonly tank: HTMLDivElement;
  private readonly tankLevel: SVGGElement;
  private readonly tankMsg: HTMLDivElement;
  private readonly weaponSlots: HTMLDivElement[] = [];
  private readonly balloonEl: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  // 흠뻑 카드
  private readonly soaked: HTMLDivElement;
  private readonly soakedTitle: HTMLDivElement;
  private readonly soakedDot: HTMLSpanElement;
  private readonly soakedBy: HTMLSpanElement;
  private readonly soakedWeapon: HTMLDivElement;
  private readonly soakedTimer: HTMLDivElement;
  private readonly soakedBar: HTMLDivElement;
  // 점수판·결과
  private readonly scoreboard: HTMLDivElement;
  private readonly results: HTMLDivElement;
  private resultsNext: HTMLDivElement | null = null;

  private readonly toasts: Timed[] = [];
  private readonly feedRows: Timed[] = [];
  private clock = 0;
  private centerTimer = 0;
  private calloutTimer = 0;
  private confirmTimer = 0;
  private fovDeg = 80;
  private viewH = innerHeight;
  private reduceMotion = false;
  private inviteCode: string | null = null;
  private readonly sfx: Sfx | null;

  // 이전 값(바뀐 것만 DOM 에 쓴다)
  private crossGap = -1;
  private crossShown = true;
  private dialPct = -1;
  private dialDanger = false;
  private tankPct = -1;
  private lowShown = false;
  private refillShown = false;
  private refillArmed = false;
  private refillDoneT = 0;
  private weaponShown: WeaponId | null = null;
  private balloonShown: boolean | null = null;
  private prevTank = 1;
  private timerSec = -2;
  private timerUrgent = false;
  private scoreMode: GameMode | null = null;
  private readonly scoreVals = [-1, -1, -1];
  private roomLabel = '';
  private roomCount = -1;
  private hintText = '';
  private aliveShown = true;
  private soakedHiddenByResults = false;
  private soakedSec = -1;
  private lastPhase: MatchPhase | null = null;
  private beepSec = -1;
  private pingT = 0;
  private rowsRef: ScoreRow[] = [];
  private teamScores: [number, number] = [0, 0];
  private sbVisible = false;
  private sbNextAt = 0;
  private resultsVisible = false;
  private resultsNextAt = 0;
  private resultsKey = '';
  private resultsSec = -1;
  private resultsBeep = -1;

  // 연속 기록
  private streak = 0;
  private multi = 0;
  private lastSelfSplash = -99;
  private soakedInfo: { name: string; color: string; source: DamageSource } | null = null;

  constructor(parent: HTMLElement, sfx: Sfx | null = null) {
    this.sfx = sfx;
    this.root = el('div', 'hud hidden', parent);
    this.wet = el('div', 'hud-wet', this.root);

    // 피격 방향 호(풀 6개)
    const dmg = el('div', 'hud-damage', this.root);
    dmg.innerHTML = `<svg viewBox="-200 -200 400 400" aria-hidden="true">${'<g class="dmg-arc" opacity="0"><path d="M-54 -128A139 139 0 0 1 54 -128" class="dmg-ink"/><path d="M-54 -128A139 139 0 0 1 54 -128" class="dmg-water"/></g>'.repeat(6)}</svg>`;
    dmg.querySelectorAll<SVGGElement>('.dmg-arc').forEach((g) => this.dmgArcs.push(g));

    // 조준선: 점 + 틱 4개(간격 = 퍼짐)
    this.cross = el('div', 'hud-cross', this.root);
    el('div', 'ch-dot', this.cross);
    for (const d of ['t', 'b', 'l', 'r']) el('div', `ch-tick ${d}`, this.cross);
    this.hitmark = el('div', 'hud-hit', this.root);
    for (const d of ['tl', 'tr', 'bl', 'br']) el('div', `hit-tick ${d}`, this.hitmark);

    const top = el('div', 'hud-top', this.root);
    this.scoreEl = el('div', 'hud-score', top);
    this.timerEl = el('div', 'hud-timer', top, '--:--');

    this.roomEl = el('div', 'hud-room', this.root);
    this.roomName = el('span', 'hud-room-name ink', this.roomEl);
    this.pingEl = el('span', 'hud-ping ink hidden', this.roomEl);
    this.inviteChip = el('div', 'hud-invite hidden', this.root);

    this.feed = el('div', 'hud-feed', this.root);
    this.toastBox = el('div', 'hud-toasts', this.root);
    this.callout = el('div', 'hud-callout hidden', this.root);
    this.calloutTitle = el('div', 'hud-callout-title', this.callout);
    this.calloutSub = el('div', 'hud-callout-sub ink', this.callout);
    this.confirm = el('div', 'hud-confirm hidden', this.root);
    this.center = el('div', 'hud-center hidden', this.root);

    // 젖음 다이얼(왼쪽 아래)
    this.dial = el('div', 'hud-dial', this.root);
    const dialSvg = el('div', 'dial-svg', this.dial);
    dialSvg.innerHTML = `<svg viewBox="0 0 100 100" aria-hidden="true">
      <defs><clipPath id="hud-dial-clip"><circle cx="50" cy="50" r="41"/></clipPath></defs>
      <circle cx="50" cy="50" r="46" class="dial-rim"/>
      <g clip-path="url(#hud-dial-clip)">
        <rect width="100" height="100" class="dial-empty"/>
        <g class="dial-level"><path class="dial-wave back" d="${WAVE_DIAL_BACK}"/><path class="dial-wave front" d="${WAVE_DIAL}"/></g>
      </g>
      <circle cx="50" cy="50" r="41" class="dial-glass"/>
      <path d="M27 33Q32 21 45 16" class="dial-shine"/>
    </svg>`;
    this.dialLevel = dialSvg.querySelector('.dial-level') as SVGGElement;
    this.dialText = el('span', 'dial-text', this.dial, '0');
    const dialLabel = el('div', 'dial-label ink', this.dial);
    const drop = el('span', 'dial-drop', dialLabel);
    drop.innerHTML = DROP_ICON;
    el('span', '', dialLabel, '젖음');

    // 물탱크·무기(오른쪽 아래)
    const br = el('div', 'hud-arms', this.root);
    const slots = el('div', 'hud-slots', br);
    WEAPON_IDS.forEach((id, i) => {
      const s = el('div', 'hud-slot', slots);
      el('span', 'slot-key', s, String(i + 1));
      s.appendChild(iconEl(id, 'slot-icon'));
      el('span', 'slot-name', s, WEAPONS[id].name);
      this.weaponSlots.push(s);
    });
    this.balloonEl = el('div', 'hud-balloon', slots);
    this.balloonEl.appendChild(iconEl('balloon', 'slot-icon'));
    el('span', 'slot-name', this.balloonEl, '물풍선');
    el('span', 'slot-key', this.balloonEl, 'G');
    const tankCol = el('div', 'hud-tank-col', br);
    this.tankMsg = el('div', 'hud-tank-msg hidden', tankCol);
    this.tank = el('div', 'hud-tank', tankCol);
    const lowY = 114 - (TANK.lowThreshold / TANK.capacity) * 108;
    this.tank.innerHTML = `<svg viewBox="0 0 44 120" aria-hidden="true">
      <defs><clipPath id="hud-tank-clip"><rect x="6" y="6" width="32" height="108" rx="14"/></clipPath></defs>
      <rect x="3" y="3" width="38" height="114" rx="17" class="tank-rim"/>
      <g clip-path="url(#hud-tank-clip)">
        <rect width="44" height="120" class="tank-empty"/>
        <g class="tank-level"><path class="tank-wave" d="${WAVE_TANK}"/></g>
        <circle cx="16" cy="112" r="2.2" class="tank-bubble b1"/><circle cx="27" cy="112" r="1.6" class="tank-bubble b2"/><circle cx="21" cy="112" r="2.6" class="tank-bubble b3"/>
      </g>
      <line x1="29" x2="36" y1="${lowY}" y2="${lowY}" class="tank-tick"/>
      <rect x="11" y="15" width="5" height="64" rx="2.5" class="tank-shine"/>
    </svg>`;
    this.tankLevel = this.tank.querySelector('.tank-level') as SVGGElement;
    el('div', 'hud-tank-label ink', tankCol, '물탱크');

    this.hint = el('div', 'hud-hint ink hidden', this.root);

    // 흠뻑 카드
    this.soaked = el('div', 'hud-soaked hidden', this.root);
    this.soakedTitle = el('div', 'soaked-title', this.soaked, '흠뻑 젖었다!');
    const card = el('div', 'soaked-card', this.soaked);
    const by = el('div', 'soaked-by', card);
    this.soakedDot = el('span', 'soaked-dot', by);
    this.soakedBy = el('span', 'soaked-name', by);
    this.soakedWeapon = el('div', 'soaked-weapon', card);
    this.soakedTimer = el('div', 'soaked-timer', card);
    const bar = el('div', 'soaked-bar', card);
    this.soakedBar = el('div', 'soaked-bar-fill', bar);

    this.scoreboard = el('div', 'hud-panel hud-scoreboard hidden', this.root);
    this.results = el('div', 'hud-panel hud-results hidden', this.root);
    addEventListener('resize', () => {
      this.viewH = innerHeight;
      this.crossGap = -1;
    });
  }

  // ================================================================ 설정

  show(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
    if (!v) this.reset();
  }

  /** 조준선 퍼짐을 화면 픽셀로 바꾸는 데 쓴다 */
  setFov(deg: number): void {
    this.fovDeg = deg;
    this.crossGap = -1;
  }

  setReduceMotion(v: boolean): void {
    this.reduceMotion = v;
  }

  /** 초대 코드(빠른 대전·연습이면 null) — 점수판·결과·상단에 표시 */
  setInvite(code: string | null): void {
    this.inviteCode = code;
    this.inviteChip.classList.toggle('hidden', !code);
    this.inviteChip.textContent = '';
    if (code) {
      el('span', 'invite-label', this.inviteChip, '방 코드');
      el('span', 'invite-code', this.inviteChip, code);
      el('span', 'invite-hint', this.inviteChip, 'Esc → 초대 링크 복사');
    }
  }

  /** 경기(방)가 끝나면 남은 알림·연속 기록을 비운다 */
  private reset(): void {
    this.toasts.forEach((t) => t.el.remove());
    this.toasts.length = 0;
    this.feedRows.forEach((t) => t.el.remove());
    this.feedRows.length = 0;
    this.streak = 0;
    this.multi = 0;
    this.lastSelfSplash = -99;
    this.soakedInfo = null;
    this.callout.classList.add('hidden');
    this.confirm.classList.add('hidden');
    this.center.classList.add('hidden');
    this.scoreboard.classList.add('hidden');
    this.results.classList.add('hidden');
    this.sbVisible = false;
    this.resultsVisible = false;
    this.lastPhase = null;
    this.refillArmed = false;
    this.beepSec = -1;
    this.aliveShown = true;
    this.soaked.classList.add('hidden');
    this.setInvite(null);
  }

  private animate(target: Element, frames: Keyframe[], ms: number): void {
    // WAAPI: 강제 리플로 없이 애니메이션을 다시 시작한다
    target.getAnimations().forEach((a) => a.cancel());
    target.animate(frames, { duration: this.reduceMotion ? Math.min(ms, 160) : ms, easing: 'ease-out', fill: 'forwards' });
  }

  // ================================================================ 매 프레임

  update(d: HudData, dt: number): void {
    this.clock += dt;
    this.updateCrosshair(d, dt);
    this.updateDial(d);
    this.updateTank(d, dt);
    this.updateArms(d);
    this.updateTop(d);
    this.updateSoaked(d);
    this.updateTimers(dt);

    const hint = !d.alive ? '' : d.lowWater ? '물 부족! 분수나 수영장에서 채워요 💧' : d.shielded ? '비눗방울 보호 중 · 쏘면 풀려요' : '';
    if (hint !== this.hintText) {
      this.hintText = hint;
      this.hint.textContent = hint;
      this.hint.classList.toggle('hidden', !hint);
      this.hint.classList.toggle('warn', d.lowWater);
    }

    // 페이즈 전환: 결과 → 경기면 "시작!" 소리
    if (d.phase !== this.lastPhase) {
      if (d.phase === 'playing' && this.lastPhase === 'results') this.sfx?.play('go');
      this.lastPhase = d.phase;
      this.beepSec = -1;
    }
    // 경기 마지막 5초 카운트다운 삑
    if (d.phase === 'playing') {
      const sec = Math.ceil(d.timerMs / 1000);
      if (sec >= 1 && sec <= 5 && sec !== this.beepSec) {
        this.beepSec = sec;
        this.sfx?.play('countdown');
      }
    }
  }

  private updateCrosshair(d: HudData, dt: number): void {
    const shown = d.alive && d.phase !== 'results';
    if (shown !== this.crossShown) {
      this.crossShown = shown;
      this.cross.classList.toggle('hidden', !shown);
    }
    if (!shown) return;
    const def = WEAPONS[d.weapon];
    const base = def.pattern ? def.pattern[def.pattern.length - 1].deg : def.spreadDeg;
    const mult = d.moveState === 'air' ? def.spreadAir : d.moveState === 'moving' ? def.spreadMoving : 1;
    const rad = (base * mult * Math.PI) / 180;
    const half = Math.tan((this.fovDeg * Math.PI) / 360);
    const target = Math.max(5, (Math.tan(rad) / half) * (this.viewH / 2));
    const gap = this.crossGap < 0 ? target : this.crossGap + (target - this.crossGap) * Math.min(1, dt * 16);
    if (Math.abs(gap - this.crossGap) > 0.2) {
      this.crossGap = gap;
      this.cross.style.setProperty('--gap', `${gap.toFixed(1)}px`);
    }
  }

  private updateDial(d: HudData): void {
    const pct = Math.round(d.soak * 100);
    if (pct === this.dialPct) return;
    this.dialPct = pct;
    // 수면 y: 96(빈) → 4(가득)
    this.dialLevel.style.transform = `translateY(${(96 - d.soak * 92).toFixed(1)}px)`;
    this.dialText.textContent = String(pct);
    const danger = d.soak >= 0.75;
    if (danger !== this.dialDanger) {
      this.dialDanger = danger;
      this.dial.classList.toggle('danger', danger);
    }
    // 화면 가장자리 물방울: 25 이상부터 젖음에 비례
    this.wet.style.opacity = String(Math.min(1, Math.max(0, (d.soak - 0.2) * 1.4)).toFixed(2));
  }

  private updateTank(d: HudData, dt: number): void {
    const pct = Math.round(d.tank * 200) / 2;
    if (pct !== this.tankPct) {
      this.tankPct = pct;
      this.tankLevel.style.transform = `translateY(${(114 - d.tank * 108).toFixed(1)}px)`;
    }
    this.tank.classList.toggle('low', d.lowWater && d.alive);
    this.tank.classList.toggle('refill', d.refilling && d.tank < 0.999);

    // "충전 완료!": 보충 구역에서 채우다가 가득 찼을 때 한 번
    if (!d.refilling) this.refillArmed = false;
    else if (d.tank < 0.97) this.refillArmed = true;
    if (this.refillArmed && d.tank >= 0.999) {
      this.refillArmed = false;
      this.refillDoneT = 1.3;
      this.sfx?.play('refillDone');
    }
    this.refillDoneT = Math.max(0, this.refillDoneT - dt);
    const low = d.lowWater && d.alive;
    const done = this.refillDoneT > 0 && d.alive;
    if (low !== this.lowShown || done !== this.refillShown) {
      this.lowShown = low;
      const popDone = done && !this.refillShown;
      this.refillShown = done;
      this.tankMsg.classList.toggle('hidden', !low && !done);
      this.tankMsg.classList.toggle('low', low && !done);
      this.tankMsg.classList.toggle('done', done);
      this.tankMsg.textContent = done ? '충전 완료!' : low ? '물 부족!' : '';
      if (popDone || (low && !done)) this.animate(this.tankMsg, POP_IN, 260);
    }
    // 물풍선 준비 "띵": 물이 40 을 넘어 준비됐을 때
    const need = BALLOON.cost / TANK.capacity;
    if (d.alive && d.balloonReady && this.balloonShown === false && this.prevTank < need && d.tank < need + 0.2) this.sfx?.play('ready');
    this.prevTank = d.tank;
  }

  private updateArms(d: HudData): void {
    if (d.weapon !== this.weaponShown) {
      this.weaponShown = d.weapon;
      WEAPON_IDS.forEach((id, i) => {
        const active = id === d.weapon;
        this.weaponSlots[i].classList.toggle('active', active);
        if (active && !this.reduceMotion) this.weaponSlots[i].animate([{ transform: 'scale(1.18)' }, { transform: 'scale(1)' }], { duration: 180, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' });
      });
    }
    if (d.balloonReady !== this.balloonShown) {
      const becameReady = d.balloonReady && this.balloonShown === false;
      this.balloonShown = d.balloonReady;
      this.balloonEl.classList.toggle('ready', d.balloonReady);
      if (becameReady && !this.reduceMotion) this.balloonEl.animate([{ transform: 'translateY(-6px) scale(1.12)' }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' });
    }
  }

  private updateTop(d: HudData): void {
    // 문자열은 초가 바뀔 때만 만든다(매 프레임 할당 없음)
    const sec = d.phase ? Math.max(0, Math.ceil(d.timerMs / 1000)) : -1;
    if (sec !== this.timerSec) {
      this.timerSec = sec;
      this.timerEl.textContent = d.phase ? fmtTime(d.timerMs) : '--:--';
    }
    const urgent = d.phase === 'playing' && d.timerMs < 30000;
    if (urgent !== this.timerUrgent) {
      this.timerUrgent = urgent;
      this.timerEl.classList.toggle('urgent', urgent);
    }

    const a = d.mode === 'tdm' ? d.teamScores[0] : d.myScore;
    const b = d.mode === 'tdm' ? d.teamScores[1] : d.leaderScore;
    const c = d.mode === 'tdm' ? d.myTeam : 0;
    const v = this.scoreVals;
    if (d.mode !== this.scoreMode || a !== v[0] || b !== v[1] || c !== v[2]) {
      this.scoreMode = d.mode;
      v[0] = a;
      v[1] = b;
      v[2] = c;
      this.teamScores = [d.teamScores[0], d.teamScores[1]];
      this.scoreEl.textContent = '';
      if (d.mode === 'tdm') {
        for (const team of [0, 1] as const) {
          const chip = el('span', `score-chip team${d.myTeam === team ? ' mine' : ''}`, this.scoreEl);
          chip.style.background = TEAM_COLORS[team];
          el('span', 'score-num ink', chip, String(d.teamScores[team]));
          if (team === 0) el('span', 'score-sep ink', this.scoreEl, `목표 ${MATCH.tdmScoreLimit}`);
        }
      } else {
        const me = el('span', 'score-chip me', this.scoreEl);
        el('span', 'score-cap', me, '나');
        el('span', 'score-num', me, String(d.myScore));
        const lead = el('span', 'score-chip lead', this.scoreEl);
        el('span', 'score-cap', lead, '1등');
        el('span', 'score-num', lead, String(d.leaderScore));
        el('span', 'score-goal', lead, `/${MATCH.ffaScoreLimit}`);
      }
    }

    if (d.roomLabel !== this.roomLabel || d.playerCount !== this.roomCount) {
      this.roomLabel = d.roomLabel;
      this.roomCount = d.playerCount;
      this.roomName.textContent = `${d.roomLabel} · ${d.playerCount}명`;
    }
  }

  private updateSoaked(d: HudData): void {
    // 결과 화면(시상대)이 뜨면 흠뻑 카드는 가린다
    const inResults = d.phase === 'results';
    if (inResults !== this.soakedHiddenByResults) {
      this.soakedHiddenByResults = inResults;
      this.soaked.classList.toggle('covered', inResults);
    }
    if (d.alive !== this.aliveShown) {
      this.aliveShown = d.alive;
      this.soaked.classList.toggle('hidden', d.alive);
      if (!d.alive) {
        this.soakedSec = -1;
        const info = this.soakedInfo;
        const name = info?.name ?? d.soakedBy;
        this.soakedDot.classList.toggle('hidden', !info);
        if (info) this.soakedDot.style.background = info.color;
        this.soakedBy.textContent = name ? `${name}에게 흠뻑!` : '물에 풍덩!';
        if (info) this.soakedBy.style.color = info.color;
        else this.soakedBy.style.removeProperty('color');
        this.soakedWeapon.textContent = '';
        if (info) {
          this.soakedWeapon.appendChild(iconEl(info.source, 'soaked-icon'));
          el('span', '', this.soakedWeapon, SOURCE_LABEL[info.source]);
        }
        this.animate(this.soakedTitle, [
          { transform: 'scale(0.5)', opacity: 0 },
          { transform: 'scale(1.18)', opacity: 1, offset: 0.55 },
          { transform: 'scale(1)', opacity: 1 },
        ], 380);
        this.animate(this.soaked, FADE_IN, 200);
      } else {
        this.soakedInfo = null;
      }
    }
    if (!d.alive && d.respawnIn !== null) {
      const sec = Math.max(1, Math.ceil(d.respawnIn));
      if (sec !== this.soakedSec) {
        this.soakedSec = sec;
        this.soakedTimer.textContent = `몸 말리는 중… ${sec}`;
      }
      const k = 1 - Math.min(1, Math.max(0, d.respawnIn / PLAYER.respawnDelay));
      this.soakedBar.style.transform = `scaleX(${k.toFixed(3)})`;
    }
  }

  private updateTimers(dt: number): void {
    for (const list of [this.toasts, this.feedRows]) {
      for (let i = list.length - 1; i >= 0; i--) {
        const t = list[i];
        t.life -= dt;
        if (t.life <= t.fadeAt && !t.el.classList.contains('fade')) t.el.classList.add('fade');
        if (t.life <= 0) {
          t.el.remove();
          list.splice(i, 1);
        }
      }
    }
    if (this.centerTimer > 0) {
      this.centerTimer -= dt;
      if (this.centerTimer <= 0) this.center.classList.add('hidden');
    }
    if (this.calloutTimer > 0) {
      this.calloutTimer -= dt;
      if (this.calloutTimer <= 0) this.callout.classList.add('hidden');
    }
    if (this.confirmTimer > 0) {
      this.confirmTimer -= dt;
      if (this.confirmTimer <= 0) this.confirm.classList.add('hidden');
    }
    // 핑(상단 왼쪽): 1초마다
    this.pingT -= dt;
    if (this.pingT <= 0) {
      this.pingT = 1;
      this.refreshPing();
    }
  }

  private refreshPing(): void {
    let ping: number | null = null;
    const host = this.rowsRef.find((r) => r.isHost && !r.isSelf);
    if (host) {
      ping = host.ping;
    } else {
      // 내가 방장이면 사람 참가자 평균
      let sum = 0;
      let n = 0;
      for (const r of this.rowsRef) {
        if (!r.isSelf && !r.isBot && r.ping !== null) {
          sum += r.ping;
          n++;
        }
      }
      ping = n ? sum / n : null;
    }
    this.pingEl.classList.toggle('hidden', ping === null);
    if (ping !== null) {
      this.pingEl.textContent = `핑 ${Math.round(ping)}ms`;
      this.pingEl.dataset.q = ping < 90 ? 'good' : ping < 180 ? 'ok' : 'bad';
    }
  }

  // ================================================================ 이벤트

  /** 내 물줄기가 맞음. amount = 이번 적심 양(클수록 표시가 커진다) */
  hitMarker(kill: boolean, amount = 20): void {
    const k = Math.min(1, Math.max(0, amount / 60));
    this.hitmark.style.setProperty('--hs', (kill ? 1.5 : 0.85 + k * 0.6).toFixed(2));
    this.hitmark.classList.toggle('kill', kill);
    this.animate(this.hitmark, this.reduceMotion ? FADE_OUT : HIT_POP, kill ? 460 : 240);
  }

  /** 맞은 방향 표시. angle = 화면 기준(0 = 정면, +오른쪽) 라디안 */
  damageFrom(angle: number): void {
    const g = this.dmgArcs[this.dmgCursor];
    this.dmgCursor = (this.dmgCursor + 1) % this.dmgArcs.length;
    g.setAttribute('transform', `rotate(${((angle * 180) / Math.PI).toFixed(1)})`);
    g.getAnimations().forEach((a) => a.cancel());
    g.animate([{ opacity: 1 }, { opacity: 0.9, offset: 0.3 }, { opacity: 0 }], { duration: 1000, easing: 'ease-in', fill: 'forwards' });
  }

  /** 누군가 흠뻑 젖음: 킬피드 + (내가 적셨으면) 확인 표시·연속 기록 + (내가 젖었으면) 흠뻑 카드 정보 */
  splash(ev: SplashFeed): void {
    const row = el('div', `feed-row${ev.bySelf || ev.onSelf ? ' self' : ''}`, this.feed);
    const k = el('span', 'feed-name', row, ev.killer);
    k.style.color = ev.killerColor;
    row.appendChild(iconEl(ev.source, 'feed-icon'));
    const v = el('span', 'feed-name', row, ev.victim);
    v.style.color = ev.victimColor;
    row.title = SOURCE_LABEL[ev.source];
    if (!this.reduceMotion) row.animate([{ transform: 'translateX(40px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 220, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' });
    this.feedRows.push({ el: row, life: 5, fadeAt: 0.5 });
    while (this.feedRows.length > 5) this.feedRows.shift()!.el.remove();

    if (ev.bySelf) {
      this.multi = this.clock - this.lastSelfSplash <= MULTI_WINDOW ? this.multi + 1 : 1;
      this.lastSelfSplash = this.clock;
      this.streak++;
      this.showConfirm(ev.victim, ev.victimColor);
      const milestone = STREAK_CALLOUTS[this.streak];
      const multi = this.multi >= 2 ? MULTI_CALLOUTS[Math.min(this.multi, MULTI_CALLOUTS.length - 1)] : '';
      if (milestone) this.showCallout(milestone.title, multi || milestone.sub, this.streak);
      else if (multi) this.showCallout(multi, '', this.multi);
    }
    if (ev.onSelf) {
      this.streak = 0;
      this.multi = 0;
      this.soakedInfo = { name: ev.killer, color: ev.killerColor, source: ev.source };
    }
  }

  private showConfirm(victim: string, color: string): void {
    this.confirm.textContent = '';
    const dot = el('span', 'confirm-dot', this.confirm);
    dot.style.background = color;
    el('span', 'ink', this.confirm, `${victim} 흠뻑!`);
    this.confirm.classList.remove('hidden');
    this.confirmTimer = 1.3;
    this.animate(this.confirm, POP_IN, 240);
  }

  private showCallout(title: string, sub: string, level: number): void {
    this.calloutTitle.textContent = title;
    this.calloutSub.textContent = sub;
    this.calloutSub.classList.toggle('hidden', !sub);
    this.callout.dataset.level = String(Math.min(level, 8));
    this.callout.classList.remove('hidden');
    this.calloutTimer = 2.2;
    this.animate(this.callout, [
      { transform: 'translate(-50%, 0) scale(0.3) rotate(-8deg)', opacity: 0 },
      { transform: 'translate(-50%, 0) scale(1.15) rotate(2deg)', opacity: 1, offset: 0.55 },
      { transform: 'translate(-50%, 0) scale(1) rotate(0deg)', opacity: 1 },
    ], 420);
    this.sfx?.play('streak', { pitch: 1 + Math.min(level, 8) * 0.06 });
  }

  toast(text: string, seconds = 3.2): void {
    const t = el('div', 'toast', this.toastBox, text);
    if (!this.reduceMotion) t.animate([{ transform: 'translateY(-10px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 200, easing: 'ease-out' });
    this.toasts.push({ el: t, life: seconds, fadeAt: 0.5 });
    while (this.toasts.length > 4) this.toasts.shift()!.el.remove();
  }

  centerMessage(title: string, sub = '', seconds = 2): void {
    this.center.textContent = '';
    el('div', 'hud-center-title', this.center, title);
    if (sub) el('div', 'hud-center-sub ink', this.center, sub);
    this.center.classList.remove('hidden');
    this.centerTimer = seconds;
    this.animate(this.center, POP_IN, 320);
  }

  // ================================================================ 점수판·결과

  /** 매 프레임 호출된다(보이지 않아도 핑 계산에 rows 를 쓴다). 보일 때만 0.3초마다 다시 그린다 */
  setScoreboard(visible: boolean, rows: ScoreRow[], mode: GameMode): void {
    this.rowsRef = rows;
    if (visible !== this.sbVisible) {
      this.sbVisible = visible;
      this.scoreboard.classList.toggle('hidden', !visible);
      this.sbNextAt = 0;
      if (visible) this.animate(this.scoreboard, FADE_IN, 120);
    }
    if (!visible || this.clock < this.sbNextAt) return;
    this.sbNextAt = this.clock + 0.3;
    const box = this.scoreboard;
    box.textContent = '';
    const head = el('div', 'panel-head', box);
    el('div', 'panel-title', head, '점수판');
    if (mode === 'tdm') {
      const teams = el('div', 'sb-teams', head);
      for (const team of [0, 1] as const) {
        const t = el('span', 'sb-team', teams);
        t.style.background = TEAM_COLORS[team];
        el('span', 'ink', t, `${TEAM_NAMES[team]} ${this.teamScores[team]}`);
      }
    }
    this.renderTable(box, rows, mode);
    this.renderInviteLine(box);
  }

  showResults(visible: boolean, title: string, rows: ScoreRow[], mode: GameMode, secondsLeft: number): void {
    if (visible !== this.resultsVisible) {
      this.resultsVisible = visible;
      this.results.classList.toggle('hidden', !visible);
      this.resultsNextAt = 0;
      this.resultsKey = '';
      this.resultsBeep = -1;
      if (visible) this.animate(this.results, [{ transform: 'translate(-50%, -50%) scale(0.85)', opacity: 0 }, { transform: 'translate(-50%, -50%) scale(1)', opacity: 1 }], 260);
    }
    if (!visible) return;
    // 점수는 결과 화면 동안 멈춰 있지만 사람이 나가고 들어올 수 있다 — 1초마다 확인해 바뀌었을 때만 다시 그린다
    if (this.clock >= this.resultsNextAt) {
      this.resultsNextAt = this.clock + 1;
      const key = `${title}|${rows.map((r) => `${r.id}:${r.splashes}:${r.soaked}:${r.color}:${r.name}`).join(',')}`;
      if (key !== this.resultsKey) {
        this.resultsKey = key;
        this.buildResults(title, rows, mode);
        this.resultsSec = -1;
      }
    }
    const sec = Math.max(0, Math.ceil(secondsLeft));
    if (sec !== this.resultsSec && this.resultsNext) {
      this.resultsSec = sec;
      this.resultsNext.textContent = sec > 0 ? `${sec}초 후 다음 경기` : '곧 시작!';
      this.resultsNext.classList.toggle('soon', sec <= 3);
      // 표를 다시 그려도 같은 초에 두 번 울리지 않게 따로 기억한다
      if (sec >= 1 && sec <= 3 && sec !== this.resultsBeep) {
        this.resultsBeep = sec;
        this.sfx?.play('countdown');
      }
    }
  }

  private buildResults(title: string, rows: ScoreRow[], mode: GameMode): void {
    const box = this.results;
    box.textContent = '';
    const head = el('div', 'panel-head', box);
    el('div', 'results-title', head, title);
    if (mode === 'tdm') {
      const teams = el('div', 'sb-teams big', head);
      for (const team of [0, 1] as const) {
        const t = el('span', 'sb-team', teams);
        t.style.background = TEAM_COLORS[team];
        el('span', 'ink', t, `${TEAM_NAMES[team]} ${this.teamScores[team]}`);
      }
    }
    // 시상대: 가운데 1등, 왼쪽 2등, 오른쪽 3등
    const ranked = [...rows].sort(byScore);
    const podium = el('div', 'podium', box);
    const order = [1, 0, 2];
    for (const i of order) {
      const r = ranked[i];
      const slot = el('div', `podium-slot p${i + 1}${r ? '' : ' empty'}`, podium);
      if (!r) continue;
      const bean = el('div', 'podium-bean', slot);
      bean.style.background = r.color;
      el('div', 'bean-eyes', bean);
      if (i === 0) el('div', 'bean-crown', bean, '👑');
      const name = el('div', 'podium-name ink', slot, r.name);
      name.title = r.name;
      if (r.isSelf) el('span', 'sb-tag me', slot, '나');
      el('div', 'podium-score', slot, `${r.splashes} 적심`);
      el('div', 'podium-block', slot, String(i + 1));
    }
    if (rows.length > 3) this.renderTable(box, rows, mode, 3);
    this.resultsNext = el('div', 'results-next', box);
    this.renderInviteLine(box);
  }

  private renderInviteLine(box: HTMLElement): void {
    if (!this.inviteCode) return;
    const line = el('div', 'panel-invite', box);
    el('span', '', line, '친구 부르기 · 방 코드');
    el('span', 'invite-code', line, this.inviteCode);
    el('span', 'invite-hint', line, 'Esc → 초대 링크 복사');
  }

  /**
   * @param skipTop 결과 화면: 시상대에 오른 사람 수(표에서는 빼고, 순위는 개인 점수로 이어서 매긴다).
   *                점수판(0): 팀전이면 팀별로 묶고 순위도 팀 안에서 매긴다.
   */
  private renderTable(box: HTMLElement, rows: ScoreRow[], mode: GameMode, skipTop = 0): void {
    const table = el('div', 'sb-table', box);
    const head = el('div', 'sb-row sb-head', table);
    ['#', '이름', '적심', '젖음', '핑'].forEach((h) => el('span', '', head, h));
    const sorted = skipTop ? [...rows].sort(byScore) : sortRows(rows, mode);
    let rank = 0;
    let team: TeamId | null = null;
    sorted.forEach((r, i) => {
      if (!skipTop && mode === 'tdm' && r.team !== team) {
        team = r.team;
        rank = 0;
      }
      rank++;
      if (i < skipTop) return;
      const row = el('div', `sb-row${r.isSelf ? ' self' : ''}`, table);
      if (mode === 'tdm' && (r.team === 0 || r.team === 1)) row.style.setProperty('--team', TEAM_COLORS[r.team]);
      row.classList.toggle('teamed', mode === 'tdm');
      el('span', 'sb-rank', row, String(rank));
      const name = el('span', 'sb-name', row);
      const dot = el('span', 'sb-dot', name);
      dot.style.background = r.color;
      const n = el('span', 'sb-nametext', name, r.name);
      n.title = r.name;
      if (r.isHost) el('span', 'sb-tag host', name, '👑 방장');
      if (r.isBot) el('span', 'sb-tag bot', name, '봇');
      if (r.isSelf) el('span', 'sb-tag me', name, '나');
      el('span', 'sb-num', row, String(r.splashes));
      el('span', 'sb-num dim', row, String(r.soaked));
      const ping = el('span', 'sb-ping', row, r.isBot || r.isSelf ? '-' : r.ping === null ? '…' : `${Math.round(r.ping)}`);
      if (!r.isBot && !r.isSelf && r.ping !== null) ping.dataset.q = r.ping < 90 ? 'good' : r.ping < 180 ? 'ok' : 'bad';
    });
  }
}

