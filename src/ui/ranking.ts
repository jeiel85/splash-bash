import type { GameMode, TeamId } from '../types';
import type { ScoreRow } from './hud';

/** 개인 순위: 적심 많이 → 덜 젖음 → 이름 */
export function byScore(a: ScoreRow, b: ScoreRow): number {
  return b.splashes - a.splashes || a.soaked - b.soaked || a.name.localeCompare(b.name);
}

/** 표 한 줄: 선수(순위 포함) 또는 팀 머리줄 */
export type TableEntry =
  | { kind: 'row'; row: ScoreRow; rank: number }
  | { kind: 'team'; team: TeamId; winner: boolean };

/** 점수판(Tab): 팀전이면 팀별로 묶고 순위도 팀 안에서 매긴다 */
export function scoreboardEntries(rows: readonly ScoreRow[], mode: GameMode): TableEntry[] {
  const sorted = [...rows].sort((a, b) => (mode === 'tdm' ? a.team - b.team : 0) || byScore(a, b));
  const out: TableEntry[] = [];
  let rank = 0;
  let team: TeamId | null = null;
  for (const row of sorted) {
    if (mode === 'tdm' && row.team !== team) {
      team = row.team;
      rank = 0;
    }
    out.push({ kind: 'row', row, rank: ++rank });
  }
  return out;
}

/**
 * 팀전에서 이긴 팀(비기거나 개인전이면 null). 호스트의 판정(MatchHost.finish: 팀 점수가 큰 쪽, 같으면 무승부)과 같은 규칙이고,
 * 결과 화면 동안 팀 점수는 멈춰 있다.
 */
export function winningTeam(mode: GameMode, teamScores: readonly [number, number]): 0 | 1 | null {
  if (mode !== 'tdm' || teamScores[0] === teamScores[1]) return null;
  return teamScores[0] > teamScores[1] ? 0 : 1;
}

export interface ResultsLayout {
  /** 팀전에서 이긴 팀(없으면 null) */
  winnerTeam: 0 | 1 | null;
  /** 시상대 1·2·3등 자리(비면 undefined) */
  podium: [ScoreRow | undefined, ScoreRow | undefined, ScoreRow | undefined];
  /** 시상대 아래 표 */
  table: TableEntry[];
}

/**
 * 결과 화면 배치.
 * - 개인전·무승부: 개인 순위 1~3등이 시상대, 나머지는 순위를 이어서 표로.
 * - 팀전 승리: 시상대는 이긴 팀 선수만(팀 안 순위). 표는 이긴 팀 나머지 → 진 팀 순으로 팀 머리줄을 붙여 묶는다(순위는 팀 안에서).
 */
export function resultsLayout(rows: readonly ScoreRow[], mode: GameMode, teamScores: readonly [number, number]): ResultsLayout {
  const win = winningTeam(mode, teamScores);
  if (win === null) {
    const ranked = [...rows].sort(byScore);
    return {
      winnerTeam: null,
      podium: [ranked[0], ranked[1], ranked[2]],
      table: ranked.slice(3).map((row, i) => ({ kind: 'row', row, rank: i + 4 })),
    };
  }
  const winners = rows.filter((r) => r.team === win).sort(byScore);
  // 진 팀(팀 번호 순, 팀이 없는 줄은 맨 뒤) — 한 팀 안에서는 개인 순위
  const teamKey = (t: TeamId) => (t === -1 ? 2 : t);
  const others = rows.filter((r) => r.team !== win).sort((a, b) => teamKey(a.team) - teamKey(b.team) || byScore(a, b));
  const table: TableEntry[] = [];
  if (winners.length > 3) {
    table.push({ kind: 'team', team: win, winner: true });
    winners.slice(3).forEach((row, i) => table.push({ kind: 'row', row, rank: i + 4 }));
  }
  let team: TeamId | null = null;
  let rank = 0;
  for (const row of others) {
    if (row.team !== team) {
      team = row.team;
      rank = 0;
      table.push({ kind: 'team', team, winner: false });
    }
    table.push({ kind: 'row', row, rank: ++rank });
  }
  return { winnerTeam: win, podium: [winners[0], winners[1], winners[2]], table };
}
