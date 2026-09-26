import { describe, expect, it } from 'vitest';
import { resultsLayout, scoreboardEntries, winningTeam, type TableEntry } from '../src/ui/ranking';
import type { ScoreRow } from '../src/ui/hud';
import type { TeamId } from '../src/types';

function row(id: string, team: TeamId, splashes: number, soaked = 0): ScoreRow {
  return { id, name: id, color: '#fff', team, splashes, soaked, isSelf: false, isBot: true, isHost: false, ping: null };
}

const rowsOf = (t: TableEntry[]) => t.map((e) => (e.kind === 'row' ? `${e.row.id}#${e.rank}` : `[${e.team}${e.winner ? '*' : ''}]`));

describe('결과 화면 배치(resultsLayout)', () => {
  // QA: 탠저린(0) 팀이 이겼는데 개인 1등은 그레이프(1) 선수 → 옛 시상대는 진 팀 선수를 1등 단상에 세웠다
  const tdm = [row('g1', 1, 12), row('t1', 0, 8, 2), row('g2', 1, 11), row('t2', 0, 8, 5), row('g3', 1, 9), row('t3', 0, 5)];

  it('팀전 승리: 시상대는 이긴 팀 선수만(팀 안 개인 순위), 표는 진 팀을 팀 머리줄과 함께', () => {
    const l = resultsLayout(tdm, 'tdm', [30, 26]);
    expect(l.winnerTeam).toBe(0);
    expect(l.podium.map((r) => r?.id)).toEqual(['t1', 't2', 't3']);
    expect(rowsOf(l.table)).toEqual(['[1]', 'g1#1', 'g2#2', 'g3#3']);
  });

  it('팀전 승리(그레이프): 이긴 팀이 4명 이상이면 넷째부터 이긴 팀 머리줄 아래 → 진 팀', () => {
    const rows = [...tdm, row('g4', 1, 1), row('t4', 0, 2)];
    const l = resultsLayout(rows, 'tdm', [22, 30]);
    expect(l.winnerTeam).toBe(1);
    expect(l.podium.map((r) => r?.id)).toEqual(['g1', 'g2', 'g3']);
    expect(rowsOf(l.table)).toEqual(['[1*]', 'g4#4', '[0]', 't1#1', 't2#2', 't3#3', 't4#4']);
  });

  it('이긴 팀이 1명뿐이면(봇 없는 1:1) 시상대 나머지 자리는 비고 진 팀은 표로', () => {
    const l = resultsLayout([row('a', 0, 3), row('b', 1, 9)], 'tdm', [3, 2]);
    expect(l.podium.map((r) => r?.id)).toEqual(['a', undefined, undefined]);
    expect(rowsOf(l.table)).toEqual(['[1]', 'b#1']);
  });

  it('팀전 무승부·개인전: 개인 순위 시상대 + 나머지는 순위를 이어서(팀 머리줄 없음)', () => {
    for (const [mode, scores] of [['tdm', [25, 25]], ['ffa', [0, 0]]] as const) {
      const l = resultsLayout(tdm, mode, scores);
      expect(l.winnerTeam).toBeNull();
      expect(l.podium.map((r) => r?.id)).toEqual(['g1', 'g2', 'g3']);
      // 같은 적심이면 덜 젖은 쪽이 앞
      expect(rowsOf(l.table)).toEqual(['t1#4', 't2#5', 't3#6']);
    }
  });

  it('팀전 승리 판정은 호스트와 같은 규칙(팀 점수 큰 쪽, 같으면 없음, 개인전은 없음)', () => {
    expect(winningTeam('tdm', [30, 26])).toBe(0);
    expect(winningTeam('tdm', [26, 30])).toBe(1);
    expect(winningTeam('tdm', [0, 0])).toBeNull();
    expect(winningTeam('ffa', [3, 1])).toBeNull();
  });
});

describe('점수판 순서(scoreboardEntries)', () => {
  it('팀전은 팀별로 묶고 순위도 팀 안에서, 개인전은 전체 순위', () => {
    const rows = [row('g1', 1, 12), row('t1', 0, 8), row('g2', 1, 11), row('t2', 0, 9)];
    expect(rowsOf(scoreboardEntries(rows, 'tdm'))).toEqual(['t2#1', 't1#2', 'g1#1', 'g2#2']);
    expect(rowsOf(scoreboardEntries(rows, 'ffa'))).toEqual(['g1#1', 'g2#2', 't2#3', 't1#4']);
  });
});
