import { describe, expect, it, vi } from 'vitest';
import { MatchHost, MatchView, nameTagColor, pickBotColor, playerColor } from '../src/game/match';
import { mulberry32 } from '../src/core/rng';
import { MATCH, PLAYER_COLORS, TEAM_COLORS } from '../src/config';
import type { MatchState } from '../src/types';

const DURATION = MATCH.durationSec * 1000;
const RESULTS = MATCH.resultsSec * 1000;

function ffa(ids: string[] = ['a', 'b', 'c']): MatchHost {
  const m = new MatchHost('ffa', 'a');
  for (const id of ids) m.addPlayer(id);
  return m;
}

describe('MatchHost — 개인전', () => {
  it('새 경기: 1라운드, 경기 중, 전체 시간, 팀 없음', () => {
    const s = ffa().snapshot();
    expect(s).toMatchObject({ mode: 'ffa', phase: 'playing', round: 1, remainingMs: DURATION, teamScores: [0, 0], hostId: 'a' });
    expect(s.scores).toEqual({ a: { splashes: 0, soaked: 0, team: -1 }, b: { splashes: 0, soaked: 0, team: -1 }, c: { splashes: 0, soaked: 0, team: -1 } });
  });

  it('쓰러짐: 피해자 데스, 가해자 킬, 스스로 젖은 경우는 데스만', () => {
    const m = ffa();
    m.recordSplash('b', 'a');
    m.recordSplash('c', 'c');
    const s = m.snapshot().scores;
    expect(s.a).toMatchObject({ splashes: 1, soaked: 0 });
    expect(s.b).toMatchObject({ splashes: 0, soaked: 1 });
    expect(s.c).toMatchObject({ splashes: 0, soaked: 1 });
  });

  it(`${MATCH.ffaScoreLimit}킬이면 즉시 결과 화면, 우승자, 결과 중 쓰러짐은 무시`, () => {
    const m = ffa();
    for (let i = 0; i < MATCH.ffaScoreLimit - 1; i++) m.recordSplash('b', 'a');
    expect(m.phase).toBe('playing');
    m.recordSplash('c', 'a');
    const s = m.snapshot();
    expect(s.phase).toBe('results');
    expect(s.winner).toBe('a');
    expect(s.remainingMs).toBe(RESULTS);
    m.recordSplash('a', 'b');
    expect(m.snapshot().scores.b.splashes).toBe(0);
  });

  it('시간 종료: 킬이 가장 많은 사람(동률이면 데스가 적은 사람)이 우승', () => {
    const m = ffa();
    m.recordSplash('c', 'a');
    m.recordSplash('c', 'b');
    m.recordSplash('a', 'c');
    expect(m.tick(DURATION - 1, ['a', 'b', 'c'])).toBe(false);
    expect(m.snapshot().remainingMs).toBe(1);
    expect(m.tick(1, ['a', 'b', 'c'])).toBe(true);
    const s = m.snapshot();
    expect(s.phase).toBe('results');
    expect(s.winner).toBe('b');
  });

  it('결과 화면 뒤 다음 경기: 라운드+1, 점수 초기화, 떠난 사람 제외·새 사람 추가', () => {
    const m = ffa();
    m.recordSplash('b', 'a');
    m.tick(DURATION, ['a', 'b', 'c']);
    expect(m.tick(RESULTS, ['a', 'c', 'd'])).toBe(true);
    const s = m.snapshot();
    expect(s.phase).toBe('playing');
    expect(s.round).toBe(2);
    expect(s.winner).toBeUndefined();
    expect(s.remainingMs).toBe(DURATION);
    expect(Object.keys(s.scores).sort()).toEqual(['a', 'c', 'd']);
    expect(s.scores.a).toEqual({ splashes: 0, soaked: 0, team: -1 });
  });

  it('removePlayer: 점수 줄 삭제', () => {
    const m = ffa();
    m.removePlayer('b');
    expect(Object.keys(m.snapshot().scores)).toEqual(['a', 'c']);
  });

  it('떠난 사람(등록 안 된 id)이 가해자면 점수 줄을 되살리지 않는다', () => {
    const m = ffa();
    m.removePlayer('c');
    m.recordSplash('a', 'c');
    m.recordSplash('ghost', 'b');
    const s = m.snapshot().scores;
    expect(Object.keys(s).sort()).toEqual(['a', 'b']);
    expect(s.a.soaked).toBe(1);
    expect(s.b.splashes).toBe(1);
  });

  it('snapshot 은 복사본(받은 쪽이 고쳐도 호스트 상태는 그대로)', () => {
    const m = ffa();
    const s = m.snapshot();
    s.scores.a.splashes = 99;
    s.teamScores[0] = 99;
    expect(m.snapshot().scores.a.splashes).toBe(0);
    expect(m.snapshot().teamScores[0]).toBe(0);
  });
});

describe('MatchHost — 팀전', () => {
  it('팀 배정은 인원이 적은 팀으로(번갈아)', () => {
    const m = new MatchHost('tdm', 'a');
    const teams = ['a', 'b', 'c', 'd', 'e'].map((id) => m.addPlayer(id).team);
    expect(teams).toEqual([0, 1, 0, 1, 0]);
    // 이미 있으면 그대로
    expect(m.addPlayer('b').team).toBe(1);
    m.removePlayer('b');
    m.removePlayer('d');
    expect(m.addPlayer('f').team).toBe(1);
  });

  it('팀 점수 누적, 같은 팀 쓰러짐은 킬로 안 침', () => {
    const m = new MatchHost('tdm', 'a');
    for (const id of ['a', 'b', 'c', 'd']) m.addPlayer(id); // a,c=0  b,d=1
    m.recordSplash('b', 'a');
    m.recordSplash('d', 'c');
    m.recordSplash('a', 'b');
    m.recordSplash('c', 'a');
    const s = m.snapshot();
    expect(s.teamScores).toEqual([2, 1]);
    expect(s.scores.a.splashes).toBe(1);
    expect(s.scores.c.soaked).toBe(1);
  });

  it(`팀 ${MATCH.tdmScoreLimit}점이면 결과, 무승부·팀 우승 판정`, () => {
    const m = new MatchHost('tdm', 'a');
    for (const id of ['a', 'b']) m.addPlayer(id);
    for (let i = 0; i < MATCH.tdmScoreLimit; i++) m.recordSplash('a', 'b');
    expect(m.snapshot()).toMatchObject({ phase: 'results', winner: 'team1', teamScores: [0, MATCH.tdmScoreLimit] });

    const draw = new MatchHost('tdm', 'a');
    for (const id of ['a', 'b']) draw.addPlayer(id);
    draw.recordSplash('a', 'b');
    draw.recordSplash('b', 'a');
    draw.tick(DURATION, ['a', 'b']);
    expect(draw.snapshot().winner).toBe('draw');
  });

  it('다음 경기에서 팀 유지(섞지 않음), 새 사람은 적은 팀으로', () => {
    const m = new MatchHost('tdm', 'a');
    for (const id of ['a', 'b', 'c']) m.addPlayer(id); // a=0 b=1 c=0
    m.tick(DURATION, ['a', 'b', 'c']);
    m.tick(RESULTS, ['a', 'b', 'c', 'd']);
    const s = m.snapshot();
    expect(s.round).toBe(2);
    expect(s.teamScores).toEqual([0, 0]);
    expect([s.scores.a.team, s.scores.b.team, s.scores.c.team, s.scores.d.team]).toEqual([0, 1, 0, 1]);
  });
});

describe('MatchHost.fromState — 호스트 이전', () => {
  const prev: MatchState = {
    mode: 'tdm', phase: 'playing', remainingMs: 100_000, round: 4,
    scores: { old: { splashes: 3, soaked: 1, team: 0 }, b: { splashes: 1, soaked: 2, team: 1 }, 'bot-0': { splashes: 0, soaked: 1, team: 0 } },
    teamScores: [3, 1], hostId: 'old',
  };

  it('남은 시간은 받은 뒤 흐른 시간만큼 빼고 라운드·점수·팀을 이어받는다', () => {
    const m = MatchHost.fromState(prev, 'b', 2500);
    const s = m.snapshot();
    expect(s).toMatchObject({ mode: 'tdm', phase: 'playing', round: 4, remainingMs: 97_500, hostId: 'b', teamScores: [3, 1] });
    expect(m.teamOf('b')).toBe(1);
    expect(m.teamOf('bot-0')).toBe(0);
    expect(m.teamOf('nobody')).toBe(-1);
  });

  it('받은 상태 객체를 공유하지 않는다', () => {
    const m = MatchHost.fromState(prev, 'b', 0);
    m.recordSplash('b', 'bot-0');
    expect(prev.scores['bot-0'].splashes).toBe(0);
    expect(prev.teamScores).toEqual([3, 1]);
  });

  it('retain: 떠난 이전 호스트 등 없는 사람을 정리 → 우승 후보에서도 빠짐', () => {
    const m = MatchHost.fromState({ ...prev, mode: 'ffa', scores: { old: { splashes: 9, soaked: 0, team: -1 }, b: { splashes: 1, soaked: 0, team: -1 } } }, 'b', 0);
    m.retain(['b', 'c']);
    m.tick(1e9, ['b']);
    const s = m.snapshot();
    expect(Object.keys(s.scores)).toEqual(['b']);
    expect(s.winner).toBe('b');
  });

  it('시간이 이미 지났으면 다음 틱에 결과로, 결과 중이었으면 다음 경기로', () => {
    const late = MatchHost.fromState(prev, 'b', 200_000);
    expect(late.snapshot().remainingMs).toBe(0);
    expect(late.tick(16, ['b'])).toBe(true);
    expect(late.phase).toBe('results');
    const res = MatchHost.fromState({ ...prev, phase: 'results', remainingMs: 1000, winner: 'team0' }, 'b', 0);
    expect(res.tick(1000, ['b', 'c'])).toBe(true);
    expect(res.snapshot()).toMatchObject({ phase: 'playing', round: 5 });
  });
});

describe('MatchView', () => {
  const st = (p: Partial<MatchState>): MatchState => ({
    mode: 'ffa', phase: 'playing', remainingMs: 60_000, round: 1, scores: { a: { splashes: 0, soaked: 0, team: 1 } }, teamScores: [0, 0], hostId: 'h', ...p,
  });

  it('받은 시각 기준으로 남은 시간이 줄어든다', () => {
    const v = new MatchView();
    expect(v.remainingMs(0)).toBe(0);
    expect(v.apply(st({}), 1000)).toBe(true);
    expect(v.remainingMs(1000)).toBe(60_000);
    expect(v.remainingMs(11_000)).toBe(50_000);
    expect(v.remainingMs(1e9)).toBe(0);
    expect(v.elapsedSinceReceive(4000)).toBe(3000);
    expect(v.teamOf('a')).toBe(1);
    expect(v.teamOf('z')).toBe(-1);
  });

  it('같은 호스트의 옛 라운드는 무시, 다른(새) 호스트의 상태는 라운드가 작아도 받는다', () => {
    const v = new MatchView();
    v.apply(st({ round: 3 }), 0);
    expect(v.apply(st({ round: 2 }), 10)).toBe(false);
    expect(v.state?.round).toBe(3);
    expect(v.apply(st({ round: 3, remainingMs: 1 }), 20)).toBe(false);
    expect(v.state?.remainingMs).toBe(1);
    expect(v.apply(st({ round: 3, phase: 'results' }), 30)).toBe(true);
    expect(v.apply(st({ round: 2, hostId: 'h2' }), 40)).toBe(true);
    expect(v.state?.hostId).toBe('h2');
  });
});

describe('MatchHost — 매 프레임 읽기(복사 없음)', () => {
  it('view() 는 복사하지 않고 최신 점수·남은 시간을 보여 준다, snapshot() 은 여전히 독립 복사본', () => {
    const m = ffa();
    const v = m.view();
    expect(m.view()).toBe(v);
    expect(v.remainingMs).toBe(DURATION);
    m.tick(1500, ['a', 'b', 'c']);
    expect(m.remainingMs).toBe(DURATION - 1500);
    expect(m.view().remainingMs).toBe(DURATION - 1500);
    m.recordSplash('b', 'a');
    expect(v.scores.a.splashes).toBe(1);
    const snap = m.snapshot();
    expect(snap).toEqual(m.view());
    expect(snap.scores).not.toBe(v.scores);
    expect(snap.teamScores).not.toBe(v.teamScores);
    snap.scores.a.splashes = 99;
    expect(m.view().scores.a.splashes).toBe(1);
  });

  it('view() 는 다음 경기로 넘어가도 새 점수판을 가리킨다', () => {
    const m = new MatchHost('tdm', 'a');
    for (const id of ['a', 'b']) m.addPlayer(id);
    m.recordSplash('a', 'b');
    const v = m.view();
    expect(v.teamScores).toEqual([0, 1]);
    m.tick(DURATION, ['a', 'b']);
    m.tick(RESULTS, ['a', 'b']);
    expect(m.view().round).toBe(2);
    expect(m.view().teamScores).toEqual([0, 0]);
    expect(m.view().scores.b).toEqual({ splashes: 0, soaked: 0, team: 1 });
  });

  it('tick 의 참가자 목록 함수는 다음 경기로 넘어갈 때만 불린다(매 프레임 배열 할당 없음)', () => {
    const m = ffa(['a', 'b']);
    const ids = vi.fn(() => ['a', 'c']);
    for (let i = 0; i < 100; i++) m.tick(16, ids);
    expect(ids).not.toHaveBeenCalled();
    m.tick(DURATION, ids);
    expect(m.phase).toBe('results');
    expect(ids).not.toHaveBeenCalled();
    m.tick(RESULTS, ids);
    expect(ids).toHaveBeenCalledTimes(1);
    expect(Object.keys(m.view().scores).sort()).toEqual(['a', 'c']);
  });

  it('has: 등록 여부(객체 기본 속성 이름과 헷갈리지 않음)', () => {
    const m = ffa(['a']);
    expect(m.has('a')).toBe(true);
    expect(m.has('b')).toBe(false);
    expect(m.has('toString')).toBe(false);
    m.removePlayer('a');
    expect(m.has('a')).toBe(false);
  });
});

describe('색 결정', () => {
  it('팀전은 팀이 정해진 뒤에만 팀 색, 개인전·팀 미정은 꾸미기 색', () => {
    expect(playerColor('tdm', 0, 5)).toBe(TEAM_COLORS[0]);
    expect(playerColor('tdm', 1, 0)).toBe(TEAM_COLORS[1]);
    expect(playerColor('tdm', -1, 5)).toBe(PLAYER_COLORS[5]);
    expect(playerColor('ffa', 1, 5)).toBe(PLAYER_COLORS[5]);
    expect(playerColor('ffa', -1, undefined)).toBe(PLAYER_COLORS[0]);
    expect(playerColor('ffa', -1, 99)).toBe(PLAYER_COLORS[0]);
    expect(nameTagColor('tdm', 1)).toBe(TEAM_COLORS[1]);
    expect(nameTagColor('tdm', -1)).toBe('#ffffff');
    expect(nameTagColor('ffa', 0)).toBe('#ffffff');
  });

  it('회귀(QA P2-1): 호스트가 참가자를 먼저 등록해야 팀전 새 참가자가 처음부터 팀 색', () => {
    const m = new MatchHost('tdm', 'host');
    m.addPlayer('host'); // 탠저린
    const cosmetic = 0; // 꾸미기 색이 탠저린과 같은 사람이 그레이프 팀에 들어오는 경우
    // 등록 전에 모습을 만들면 꾸미기 색(= 탠저린 팀 색)으로 보인다 — 예전 버그
    expect(playerColor(m.mode, m.teamOf('guest'), cosmetic)).toBe(TEAM_COLORS[0]);
    m.addPlayer('guest');
    expect(playerColor(m.mode, m.teamOf('guest'), cosmetic)).toBe(TEAM_COLORS[1]);
    expect(nameTagColor(m.mode, m.teamOf('guest'))).toBe(TEAM_COLORS[1]);
  });

  it('pickBotColor: 쓰이지 않은 색만 고르고, 모두 쓰였으면 가장 적게 쓰인 색에서', () => {
    const rnd = mulberry32(7);
    for (let i = 0; i < 200; i++) expect([0, 1, 2]).not.toContain(pickBotColor([0, 1, 2], rnd));
    // 남은 색이 하나면 그 색
    expect(pickBotColor([0, 1, 2, 3, 4, 5, 6], rnd)).toBe(7);
    // 모두 한 번씩 쓰였으면 두 번 쓰인 색은 피한다
    const all = [0, 1, 2, 3, 4, 5, 6, 7, 3, 3, 5];
    for (let i = 0; i < 200; i++) expect([3, 5]).not.toContain(pickBotColor(all, rnd));
    // 범위 밖 값은 무시, rnd 가 1 에 가까워도 범위 안
    expect(pickBotColor([-1, 42], () => 0.9999999)).toBe(PLAYER_COLORS.length - 1);
  });

  it('pickBotColor: 사람 1명 + 봇 5명을 채우면 모두 다른 색(시드 여러 개)', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const rnd = mulberry32(seed);
      const used = [seed % PLAYER_COLORS.length];
      for (let b = 0; b < MATCH.botFillTo - 1; b++) used.push(pickBotColor(used, rnd));
      expect(new Set(used).size).toBe(used.length);
    }
  });
});
