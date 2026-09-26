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
 * 사람이 들어와 봇을 하나 뺄 때 고를 봇(호스트).
 * 팀전이면 인원이 많은 팀의 봇부터 뺀다 — 팀을 보지 않고 빼면 3:3 방에 들어온 사람이 0팀에 서고 1팀 봇이 빠져 4:2 가 됐다.
 * 그 안에서는 점수가 가장 낮은 봇, 동점이면 먼저 넣은 봇. 인원이 많은 팀에 봇이 없으면 모든 봇에서 고른다.
 * @returns botIds 가 비었으면 undefined
 */
export function pickBotToRemove(state: MatchStateView, botIds: Iterable<PeerId>): PeerId | undefined {
  const scores = state.scores;
  let bigTeam: TeamId = -1;
  if (state.mode === 'tdm') {
    let c0 = 0;
    let c1 = 0;
    for (const id in scores) {
      const t = scores[id].team;
      if (t === 0) c0++;
      else if (t === 1) c1++;
    }
    if (c0 !== c1) bigTeam = c0 > c1 ? 0 : 1;
  }
  let best: PeerId | undefined;
  let bestInBig = false;
  let bestScore = Infinity;
  for (const id of botIds) {
    const line = scores[id];
    const inBig = bigTeam !== -1 && line?.team === bigTeam;
    const score = line?.splashes ?? 0;
    if (best === undefined || (inBig && !bestInBig) || (inBig === bestInBig && score < bestScore)) {
      best = id;
      bestInBig = inBig;
      bestScore = score;
    }
  }
  return best;
}

/**
 * 경기 규칙(호스트 전용): 시간, 점수, 팀 배정, 결과 화면, 다음 경기.
 * 호스트가 바뀌면 새 호스트가 마지막으로 받은 MatchState 로 이어서 만든다(fromState).
 */
export class MatchHost {
  private state: MatchState;
  private remaining: number;
  /**
   * 이번 경기 중에 떠난 사람의 점수 줄(팀 포함). 전송 계층은 5초 넘게 끊긴 피어를 떠난 것으로 치고 같은 id 로 다시 붙이므로,
   * 같은 경기 안에 돌아오면 점수와 팀을 되살린다. 점수판(state.scores)에는 없으므로 우승 후보·팀 인원 계산에서 빠진다.
   * 호스트 로컬 기록이라 방송하지 않고, 다음 경기로 넘어가면 비운다
   */
  private readonly departed = new Map<PeerId, ScoreLine>();

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

  /**
   * 참가자 등록(이미 있으면 유지). 이번 경기 중에 떠났다가 다시 붙은 사람은 떠날 때의 점수·팀을 되살린다.
   * 새 사람은 팀전이면 인원이 적은 팀에 배정. 인원이 같으면 0팀인데, 0팀에 봇이 없고 1팀에 있으면 1팀 —
   * 사람이 들어오면 호스트가 봇을 하나 빼므로(pickBotToRemove) 들어간 팀에 자리를 내줄 봇이 있어야 인원이 맞는다
   * @param bots 지금 봇인 id(사람을 등록할 때 넘긴다)
   */
  addPlayer(id: PeerId, bots?: { has(id: PeerId): boolean }): ScoreLine {
    const existing = this.state.scores[id];
    if (existing) return existing;
    const back = this.departed.get(id);
    if (back) {
      this.departed.delete(id);
      this.state.scores[id] = back;
      return back;
    }
    let team: TeamId = -1;
    if (this.state.mode === 'tdm') {
      const counts = [0, 0];
      const botCounts = [0, 0];
      for (const pid in this.state.scores) {
        const t = this.state.scores[pid].team;
        if (t !== 0 && t !== 1) continue;
        counts[t]++;
        if (bots?.has(pid)) botCounts[t]++;
      }
      if (counts[0] !== counts[1]) team = counts[0] < counts[1] ? 0 : 1;
      else team = botCounts[0] === 0 && botCounts[1] > 0 ? 1 : 0;
    }
    const line: ScoreLine = { splashes: 0, soaked: 0, team };
    this.state.scores[id] = line;
    return line;
  }

  /** 다시 올 일이 없는 참가자(뺀 봇 등)의 점수 줄 삭제 */
  removePlayer(id: PeerId): void {
    delete this.state.scores[id];
    this.departed.delete(id);
  }

  /**
   * 사람이 떠남(연결 끊김 포함): 점수판·우승 후보·팀 인원에서는 바로 빼고, 이번 경기가 끝날 때까지 줄을 보관한다.
   * 같은 id 로 다시 붙으면 addPlayer 가 되살린다
   */
  leavePlayer(id: PeerId): void {
    const line = this.state.scores[id];
    if (!line) return;
    delete this.state.scores[id];
    this.departed.set(id, line);
  }

  /**
   * 지금 방에 있는 참가자만 남긴다(호스트를 이어받을 때, 받은 상태에 남아 있던 떠난 사람 정리).
   * 뺀 사람은 떠난 것으로 보관한다 — 끊겼던 이전 호스트가 이번 경기 안에 다시 붙으면 점수·팀을 되살린다
   */
  retain(presentIds: Iterable<PeerId>): void {
    const present = new Set(presentIds);
    for (const id of Object.keys(this.state.scores)) if (!present.has(id)) this.leavePlayer(id);
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
    // 지난 경기에 떠난 사람의 줄은 버린다(새 경기는 점수가 0부터라 되살릴 것이 없고, 돌아오면 새 사람처럼 팀을 맞춘다)
    this.departed.clear();
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
