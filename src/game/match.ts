import { MATCH, PLAYER_COLORS, TEAM_COLORS } from '../config';
import type { GameMode, MatchState, PeerId, ScoreLine, TeamId } from '../types';

/**
 * 복사 없이 넘기는 읽기 전용 경기 상태(매 프레임 HUD·봇 판단용).
 * 원본을 그대로 가리키므로 받은 쪽은 고치지 않고, 다음 프레임까지 붙잡아 두지 않는다.
 */
export type MatchStateView = Readonly<Omit<MatchState, 'scores' | 'teamScores'>> & {
  readonly scores: Readonly<Record<PeerId, Readonly<ScoreLine>>>;
  readonly teamScores: readonly [number, number];
};

/** 몸·물줄기 색: 팀전이고 팀이 정해졌으면 팀 색, 아니면 꾸미기 색(없거나 범위 밖이면 0번) */
export function playerColor(mode: GameMode, team: TeamId, cosmeticColor: number | undefined): string {
  if (mode === 'tdm' && (team === 0 || team === 1)) return TEAM_COLORS[team];
  return PLAYER_COLORS[cosmeticColor ?? 0] ?? PLAYER_COLORS[0];
}

/** 이름표 색: 팀전이고 팀이 정해졌으면 팀 색, 아니면 흰색 */
export function nameTagColor(mode: GameMode, team: TeamId): string {
  return mode === 'tdm' && (team === 0 || team === 1) ? TEAM_COLORS[team] : '#ffffff';
}

/**
 * 새 봇의 꾸미기 색: 지금 방의 사람·봇이 쓰지 않는 색 중에서 무작위로 고른다.
 * 모두 쓰였으면 가장 적게 쓰인 색들 중에서 고른다(정원 안에서는 색이 겹치지 않게).
 */
export function pickBotColor(usedColors: Iterable<number>, rnd: () => number): number {
  const counts = new Array<number>(PLAYER_COLORS.length).fill(0);
  for (const c of usedColors) if (c >= 0 && c < counts.length) counts[c]++;
  const least = Math.min(...counts);
  const free: number[] = [];
  for (let i = 0; i < counts.length; i++) if (counts[i] === least) free.push(i);
  return free[Math.min(free.length - 1, Math.floor(rnd() * free.length))];
}

/**
 * 경기 규칙(호스트 전용): 시간, 점수, 팀 배정, 결과 화면, 다음 경기.
 * 호스트가 바뀌면 새 호스트가 마지막으로 받은 MatchState 로 이어서 만든다(fromState).
 */
export class MatchHost {
  private state: MatchState;
  private remaining: number;

  constructor(mode: GameMode, hostId: PeerId) {
    this.state = {
      mode, phase: 'playing', remainingMs: MATCH.durationSec * 1000, round: 1,
      scores: {}, teamScores: [0, 0], hostId,
    };
    this.remaining = this.state.remainingMs;
  }

  static fromState(prev: MatchState, hostId: PeerId, elapsedMs: number): MatchHost {
    const h = new MatchHost(prev.mode, hostId);
    h.state = structuredClone({ ...prev, hostId });
    h.remaining = Math.max(0, prev.remainingMs - elapsedMs);
    return h;
  }

  get mode(): GameMode {
    return this.state.mode;
  }

  get phase(): MatchState['phase'] {
    return this.state.phase;
  }

  teamOf(id: PeerId): TeamId {
    return this.state.scores[id]?.team ?? -1;
  }

  /** 이미 등록된 참가자인지 */
  has(id: PeerId): boolean {
    return Object.hasOwn(this.state.scores, id);
  }

  /** 참가자 등록(이미 있으면 유지). 팀전이면 인원이 적은 팀에 배정 */
  addPlayer(id: PeerId): ScoreLine {
    let line = this.state.scores[id];
    if (line) return line;
    let team: TeamId = -1;
    if (this.state.mode === 'tdm') {
      const counts = [0, 0];
      for (const l of Object.values(this.state.scores)) if (l.team === 0 || l.team === 1) counts[l.team]++;
      team = counts[0] <= counts[1] ? 0 : 1;
    }
    line = { splashes: 0, soaked: 0, team };
    this.state.scores[id] = line;
    return line;
  }

  removePlayer(id: PeerId): void {
    delete this.state.scores[id];
  }

  /** 지금 방에 있는 참가자만 남긴다(호스트를 이어받을 때, 받은 상태에 남아 있던 떠난 사람 정리) */
  retain(presentIds: Iterable<PeerId>): void {
    const present = new Set(presentIds);
    for (const id of Object.keys(this.state.scores)) if (!present.has(id)) delete this.state.scores[id];
  }

  /**
   * 쓰러짐 반영. 경기 중이 아니면 무시.
   * 등록되지 않은 id(이미 떠난 사람·빠진 봇)는 점수 줄을 새로 만들지 않는다 — 떠난 사람이 던진 물풍선에 맞은 경우 등.
   * 되살려 두면 팀전 인원 계산이 틀어지고 떠난 사람이 우승자로 뽑힐 수 있다.
   */
  recordSplash(victim: PeerId, killer: PeerId): void {
    if (this.state.phase !== 'playing') return;
    const v = this.state.scores[victim];
    if (v) v.soaked++;
    const k = killer !== victim ? this.state.scores[killer] : undefined;
    if (k) {
      const friendly = this.state.mode === 'tdm' && !!v && k.team === v.team;
      if (!friendly) {
        k.splashes++;
        if (this.state.mode === 'tdm' && (k.team === 0 || k.team === 1)) this.state.teamScores[k.team]++;
      }
    }
    this.checkLimit();
  }

  /**
   * @param presentIds 다음 경기로 넘어갈 때만 쓰는 지금 방의 참가자. 매 프레임 부르므로 함수로 넘기면 그때만 만든다
   * @returns 상태가 크게 바뀌었으면(단계 전환) true
   */
  tick(dtMs: number, presentIds: Iterable<PeerId> | (() => Iterable<PeerId>)): boolean {
    this.remaining -= dtMs;
    if (this.remaining > 0) return false;
    if (this.state.phase === 'playing') {
      this.finish();
    } else {
      this.nextRound(typeof presentIds === 'function' ? presentIds() : presentIds);
    }
    return true;
  }

  /** 지금 기준 남은 시간(ms) */
  get remainingMs(): number {
    return Math.max(0, Math.round(this.remaining));
  }

  /**
   * 복사 없는 읽기 전용 보기(매 프레임 HUD·봇 판단용). remainingMs 는 부를 때 맞춘다.
   * 쓰러짐·틱·참가자 변경 때 내용이 바뀌므로 붙잡아 두지 않는다. 네트워크로 보내거나 보관할 때는 snapshot().
   */
  view(): MatchStateView {
    this.state.remainingMs = this.remainingMs;
    return this.state;
  }

  /** 보내거나 보관할 복사본(받은 쪽이 고쳐도 호스트 상태는 그대로) */
  snapshot(): MatchState {
    return { ...this.state, remainingMs: this.remainingMs, scores: structuredClone(this.state.scores), teamScores: [...this.state.teamScores] as [number, number] };
  }

  private checkLimit(): void {
    if (this.state.mode === 'tdm') {
      if (this.state.teamScores.some((s) => s >= MATCH.tdmScoreLimit)) this.finish();
    } else if (Object.values(this.state.scores).some((l) => l.splashes >= MATCH.ffaScoreLimit)) {
      this.finish();
    }
  }

  private finish(): void {
    this.state.phase = 'results';
    this.remaining = MATCH.resultsSec * 1000;
    if (this.state.mode === 'tdm') {
      const [a, b] = this.state.teamScores;
      this.state.winner = a === b ? 'draw' : a > b ? 'team0' : 'team1';
    } else {
      let best: [PeerId, ScoreLine] | null = null;
      for (const e of Object.entries(this.state.scores)) {
        if (!best || e[1].splashes > best[1].splashes || (e[1].splashes === best[1].splashes && e[1].soaked < best[1].soaked)) best = e;
      }
      this.state.winner = best?.[0];
    }
  }

  private nextRound(presentIds: Iterable<PeerId>): void {
    const present = new Set(presentIds);
    const prev = this.state.scores;
    this.state.phase = 'playing';
    this.state.round++;
    this.state.winner = undefined;
    this.state.teamScores = [0, 0];
    this.state.scores = {};
    this.remaining = MATCH.durationSec * 1000;
    // 팀은 섞지 않고 유지(떠난 사람은 제외)
    for (const [id, line] of Object.entries(prev)) {
      if (present.has(id)) this.state.scores[id] = { splashes: 0, soaked: 0, team: line.team };
    }
    for (const id of present) this.addPlayer(id);
  }
}

/** 클라이언트 쪽 경기 보기: 마지막으로 받은 상태 + 받은 시각으로 남은 시간 계산 */
export class MatchView {
  state: MatchState | null = null;
  private receivedAt = 0;

  apply(m: MatchState, localT: number): boolean {
    if (this.state && m.round < this.state.round && m.hostId === this.state.hostId) return false;
    const roundChanged = !this.state || this.state.round !== m.round || this.state.phase !== m.phase;
    this.state = m;
    this.receivedAt = localT;
    return roundChanged;
  }

  remainingMs(now: number): number {
    if (!this.state) return 0;
    return Math.max(0, this.state.remainingMs - (now - this.receivedAt));
  }

  elapsedSinceReceive(now: number): number {
    return now - this.receivedAt;
  }

  teamOf(id: PeerId): TeamId {
    return this.state?.scores[id]?.team ?? -1;
  }
}
