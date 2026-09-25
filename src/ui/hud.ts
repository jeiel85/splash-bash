import { SOURCE_LABEL, TEAM_COLORS, TEAM_NAMES, WEAPONS } from '../config';
import type { DamageSource, GameMode, MatchPhase, TeamId, WeaponId } from '../types';
import { WEAPON_IDS } from '../types';

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

/** 게임 중 화면 표시(DOM 오버레이). 사용자 입력 텍스트는 항상 textContent 로 넣는다(XSS 방지). */
export class Hud {
  readonly root: HTMLDivElement;
  private readonly crosshair: HTMLDivElement;
  private readonly hitmark: HTMLDivElement;
  private readonly soakFill: HTMLDivElement;
  private readonly soakLabel: HTMLDivElement;
  private readonly tankFill: HTMLDivElement;
  private readonly tankWrap: HTMLDivElement;
  private readonly weaponSlots: HTMLDivElement[] = [];
  private readonly balloonEl: HTMLDivElement;
  private readonly timerEl: HTMLDivElement;
  private readonly scoreEl: HTMLDivElement;
  private readonly roomEl: HTMLDivElement;
  private readonly feed: HTMLDivElement;
  private readonly center: HTMLDivElement;
  private readonly toastBox: HTMLDivElement;
  private readonly soakedOverlay: HTMLDivElement;
  private readonly soakedText: HTMLDivElement;
  private readonly wetVignette: HTMLDivElement;
  private readonly damageRing: HTMLDivElement;
  private readonly scoreboard: HTMLDivElement;
  private readonly results: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private hitTimer = 0;
  private centerTimer = 0;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud hidden', parent);
    this.wetVignette = el('div', 'hud-wet', this.root);
    this.damageRing = el('div', 'hud-damage', this.root);
    this.crosshair = el('div', 'hud-crosshair', this.root);
    this.hitmark = el('div', 'hud-hitmark', this.root);

    const top = el('div', 'hud-top', this.root);
    this.scoreEl = el('div', 'hud-score', top);
    this.timerEl = el('div', 'hud-timer', top, '5:00');
    this.roomEl = el('div', 'hud-room', this.root);

    this.feed = el('div', 'hud-feed', this.root);
    this.toastBox = el('div', 'hud-toasts', this.root);
    this.center = el('div', 'hud-center hidden', this.root);

    const bl = el('div', 'hud-bottom-left', this.root);
    el('div', 'hud-label', bl, '젖음');
    const soakBar = el('div', 'hud-bar hud-soak', bl);
    this.soakFill = el('div', 'hud-bar-fill', soakBar);
    this.soakLabel = el('div', 'hud-bar-text', soakBar, '0%');

    const br = el('div', 'hud-bottom-right', this.root);
    this.tankWrap = el('div', 'hud-tank', br);
    this.tankFill = el('div', 'hud-tank-fill', this.tankWrap);
    el('div', 'hud-tank-shine', this.tankWrap);
    const slots = el('div', 'hud-slots', br);
    WEAPON_IDS.forEach((id, i) => {
      const s = el('div', 'hud-slot', slots);
      el('span', 'hud-slot-key', s, String(i + 1));
      el('span', 'hud-slot-name', s, WEAPONS[id].name);
      this.weaponSlots.push(s);
    });
    this.balloonEl = el('div', 'hud-balloons', br);
    this.hint = el('div', 'hud-hint', this.root);

    this.soakedOverlay = el('div', 'hud-soaked hidden', this.root);
    el('div', 'hud-soaked-title', this.soakedOverlay, '흠뻑 젖었다!');
    this.soakedText = el('div', 'hud-soaked-sub', this.soakedOverlay);

    this.scoreboard = el('div', 'hud-scoreboard hidden', this.root);
    this.results = el('div', 'hud-results hidden', this.root);
  }

  show(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }

  update(d: HudData, dt: number): void {
    const soakPct = Math.round(d.soak * 100);
    this.soakFill.style.width = `${soakPct}%`;
    this.soakLabel.textContent = `${soakPct}%`;
    this.soakFill.classList.toggle('danger', d.soak > 0.7);
    this.wetVignette.style.opacity = String(Math.min(1, d.soak * 1.1));
    this.tankFill.style.height = `${Math.round(d.tank * 100)}%`;
    this.tankWrap.classList.toggle('low', d.lowWater);
    this.tankWrap.classList.toggle('refill', d.refilling);
    WEAPON_IDS.forEach((id, i) => this.weaponSlots[i].classList.toggle('active', id === d.weapon));
    this.balloonEl.textContent = '🎈 물풍선 (G)';
    this.balloonEl.classList.toggle('ready', d.balloonReady);
    this.timerEl.textContent = d.phase ? fmtTime(d.timerMs) : '--:--';
    this.timerEl.classList.toggle('urgent', d.phase === 'playing' && d.timerMs < 30000);
    if (d.mode === 'tdm') {
      this.scoreEl.innerHTML = '';
      const a = el('span', 'team-score', this.scoreEl, String(d.teamScores[0]));
      a.style.background = TEAM_COLORS[0];
      el('span', 'team-sep', this.scoreEl, ':');
      const b = el('span', 'team-score', this.scoreEl, String(d.teamScores[1]));
      b.style.background = TEAM_COLORS[1];
    } else {
      this.scoreEl.textContent = `내 점수 ${d.myScore} · 1등 ${d.leaderScore}`;
    }
    this.roomEl.textContent = `${d.roomLabel} · ${d.playerCount}명`;
    this.crosshair.classList.toggle('hidden', !d.alive);

    this.hint.textContent = d.lowWater && d.alive ? '물 부족! 분수나 수영장에서 채우세요 💧' : d.shielded ? '보호막 중 (쏘면 해제)' : '';

    this.soakedOverlay.classList.toggle('hidden', d.alive);
    if (!d.alive) {
      const by = d.soakedBy ? `${d.soakedBy}에게 흠뻑!` : '';
      this.soakedText.textContent = `${by}${d.respawnIn !== null ? ` · 몸 말리는 중… ${Math.ceil(d.respawnIn)}` : ''}`;
    }

    if (this.hitTimer > 0) {
      this.hitTimer -= dt;
      if (this.hitTimer <= 0) this.hitmark.classList.remove('show', 'kill');
    }
    if (this.centerTimer > 0) {
      this.centerTimer -= dt;
      if (this.centerTimer <= 0) this.center.classList.add('hidden');
    }
  }

  hitMarker(kill: boolean): void {
    this.hitmark.classList.remove('show', 'kill');
    void this.hitmark.offsetWidth; // 애니메이션 재시작
    this.hitmark.classList.add('show');
    if (kill) this.hitmark.classList.add('kill');
    this.hitTimer = kill ? 0.45 : 0.18;
  }

  /** 맞은 방향 표시. angle = 화면 기준(0 = 정면, +오른쪽) 라디안 */
  damageFrom(angle: number): void {
    const arrow = el('div', 'hud-damage-arrow', this.damageRing);
    arrow.style.transform = `rotate(${angle}rad)`;
    setTimeout(() => arrow.remove(), 900);
  }

  killfeed(killer: string, killerColor: string, victim: string, victimColor: string, source: DamageSource, involvesSelf: boolean): void {
    const row = el('div', `feed-row${involvesSelf ? ' self' : ''}`, this.feed);
    const k = el('span', 'feed-name', row, killer);
    k.style.color = killerColor;
    el('span', 'feed-icon', row, source === 'balloon' ? '🎈' : '💦');
    const v = el('span', 'feed-name', row, victim);
    v.style.color = victimColor;
    row.title = SOURCE_LABEL[source];
    while (this.feed.children.length > 5) this.feed.firstElementChild?.remove();
    setTimeout(() => row.classList.add('fade'), 5000);
    setTimeout(() => row.remove(), 5600);
  }

  toast(text: string): void {
    const t = el('div', 'toast', this.toastBox, text);
    setTimeout(() => t.classList.add('fade'), 2600);
    setTimeout(() => t.remove(), 3200);
  }

  centerMessage(title: string, sub = '', seconds = 2): void {
    this.center.innerHTML = '';
    el('div', 'hud-center-title', this.center, title);
    if (sub) el('div', 'hud-center-sub', this.center, sub);
    this.center.classList.remove('hidden');
    this.centerTimer = seconds;
  }

  setScoreboard(visible: boolean, rows: ScoreRow[], mode: GameMode): void {
    this.scoreboard.classList.toggle('hidden', !visible);
    if (!visible) return;
    this.renderTable(this.scoreboard, rows, mode, '스코어보드');
  }

  showResults(visible: boolean, title: string, rows: ScoreRow[], mode: GameMode, secondsLeft: number): void {
    this.results.classList.toggle('hidden', !visible);
    if (!visible) return;
    this.renderTable(this.results, rows, mode, title);
    el('div', 'results-next', this.results, `${Math.ceil(secondsLeft)}초 후 다음 경기`);
  }

  private renderTable(box: HTMLElement, rows: ScoreRow[], mode: GameMode, title: string): void {
    box.innerHTML = '';
    el('div', 'sb-title', box, title);
    const table = el('div', 'sb-table', box);
    const head = el('div', 'sb-row sb-head', table);
    ['', '이름', '적심', '젖음', '핑'].forEach((h) => el('span', '', head, h));
    const sorted = [...rows].sort((a, b) => (mode === 'tdm' ? a.team - b.team : 0) || b.splashes - a.splashes || a.soaked - b.soaked);
    sorted.forEach((r, i) => {
      const row = el('div', `sb-row${r.isSelf ? ' self' : ''}`, table);
      if (mode === 'tdm' && (r.team === 0 || r.team === 1)) row.style.borderLeft = `6px solid ${TEAM_COLORS[r.team]}`;
      el('span', 'sb-rank', row, String(i + 1));
      const name = el('span', 'sb-name', row);
      const dot = el('span', 'sb-dot', name);
      dot.style.background = r.color;
      el('span', '', name, r.name);
      if (r.isBot) el('span', 'sb-tag', name, '봇');
      if (r.isHost) el('span', 'sb-tag host', name, '방장');
      el('span', '', row, String(r.splashes));
      el('span', '', row, String(r.soaked));
      el('span', 'sb-ping', row, r.isBot ? '-' : r.ping === null ? '·' : `${Math.round(r.ping)}`);
    });
    if (mode === 'tdm') {
      const legend = el('div', 'sb-legend', box);
      TEAM_NAMES.forEach((n, i) => {
        const t = el('span', 'sb-team', legend, n);
        t.style.background = TEAM_COLORS[i];
      });
    }
  }
}
