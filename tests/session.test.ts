import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../src/net/session';
import { MSG, encodeBotStates, encodeHits, encodeInfo, encodeMatch, encodeShots, encodeSnapshot, encodeSplash, type NetHit, type NetShot } from '../src/net/protocol';
import { NET } from '../src/config';
import type { MatchState, PeerId, PlayerInfo, PlayerSnapshot } from '../src/types';
import { FakeHub, type FakeTransport } from './fakeNet';

function info(id: PeerId, joinedAt: number, name = id): PlayerInfo {
  return { id, name, cosmetics: { color: 0, hat: 'none' }, isBot: false, joinedAt };
}

function snap(px = 1): PlayerSnapshot {
  return {
    t: 1000, px, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, weapon: 'soaker',
    soak: 0, tank: 1, alive: true, grounded: true, shielded: false,
  };
}

function shot(shooter: PeerId): NetShot {
  return { shooter, kind: 'soaker', t: 1, seed: 7, spread: 1, origin: [0, 1, 0], dir: [0, 0, -1], inherit: [0, 0, 0] };
}

function hit(shooter: PeerId, victim: PeerId, amount = 20): NetHit {
  return { shooter, victim, amount, source: 'soaker', dir: [0, 0, -1] };
}

function match(hostId: PeerId, round = 1): MatchState {
  return { mode: 'ffa', phase: 'playing', remainingMs: 100_000, round, scores: {}, teamScores: [0, 0], hostId };
}

/** 세션이 받은 이벤트 기록 */
function record(s: Session) {
  const log = {
    infos: [] as PlayerInfo[],
    left: [] as PeerId[],
    botInfos: [] as PlayerInfo[][],
    snapshots: [] as Array<[PeerId, PlayerSnapshot]>,
    shots: [] as NetShot[],
    hits: [] as NetHit[],
    splashes: [] as Array<{ victim: PeerId; killer: PeerId }>,
    matches: [] as MatchState[],
    hosts: [] as Array<[PeerId, boolean]>,
  };
  s.on('playerInfo', (i) => log.infos.push(i));
  s.on('playerLeft', (id) => log.left.push(id));
  s.on('botInfos', (b) => log.botInfos.push(b));
  s.on('snapshot', (id, sn) => log.snapshots.push([id, sn]));
  s.on('shots', (sh) => log.shots.push(...sh));
  s.on('hits', (h) => log.hits.push(...h));
  s.on('splash', (ev) => log.splashes.push(ev));
  s.on('match', (m) => log.matches.push(m));
  s.on('hostChanged', (id, self) => log.hosts.push([id, self]));
  return log;
}

/** 모두 연결된 방에 세션 여러 개 */
function room(joined: Record<PeerId, number>) {
  const hub = new FakeHub();
  const ids = Object.keys(joined);
  for (const id of ids) hub.add(id);
  hub.connectAll();
  const sessions: Record<PeerId, Session> = {};
  for (const id of ids) sessions[id] = new Session(hub.node(id), info(id, joined[id]));
  hub.flush();
  return { hub, sessions };
}

/** 세션 없이 직접 메시지를 보내는 원격 피어(악의적·순서 뒤바뀐 입력 시험용) */
function rawPeer(hub: FakeHub, id: PeerId, to: PeerId): FakeTransport {
  const t = hub.add(id);
  hub.connect(id, to);
  return t;
}

describe('Session — hello·호스트 선출', () => {
  it('방 탐색 중(세션 생성 전)에 연결된 피어끼리도 서로를 알게 된다', () => {
    const hub = new FakeHub();
    hub.add('a');
    hub.add('b');
    // A 는 이미 게임 중, B 는 방 탐색 중에 연결됨 → A 의 hello 는 B 에게 받을 곳이 없어 사라진다
    const a = new Session(hub.node('a'), info('a', 100));
    hub.connect('a', 'b');
    hub.flush();
    expect(a.players().map((p) => p.id)).toEqual(['a']);
    // B 의 세션이 생기면 먼저 hello 를 보내고, A 가 답한다
    const b = new Session(hub.node('b'), info('b', 200));
    hub.flush();
    expect(a.players().map((p) => p.id).sort()).toEqual(['a', 'b']);
    expect(b.players().map((p) => p.id).sort()).toEqual(['a', 'b']);
    expect(a.hostId).toBe('a');
    expect(b.hostId).toBe('a');
  });

  it('둘 다 탐색 중에 연결되어도(세션 생성 순서 무관) 합의에 이른다', () => {
    const hub = new FakeHub();
    hub.add('a');
    hub.add('b');
    hub.connect('a', 'b');
    const b = new Session(hub.node('b'), info('b', 200));
    hub.flush(); // b 의 hello 는 a 에게 받을 곳이 없어 사라짐
    const a = new Session(hub.node('a'), info('a', 100));
    hub.flush();
    expect(a.info('b')?.name).toBe('b');
    expect(b.info('a')?.name).toBe('a');
    expect(a.isHost).toBe(true);
    expect(b.isHost).toBe(false);
  });

  it('hello 는 무한히 주고받지 않는다(처음 보는 사람에게만 답장)', () => {
    const { hub } = room({ a: 1, b: 2, c: 3 });
    const hellos = hub.sent.filter((s) => s.type === MSG.hello).length;
    expect(hub.flush()).toBe(0);
    // 3명: 각자 시작 hello 2통 + 처음 보는 사람에게 답장(최대 2통) → 12통 이하
    expect(hellos).toBeLessThanOrEqual(12);
  });

  it('모두 같은 호스트(joinedAt 가 가장 작은 사람)에 합의, 동률은 id 순', () => {
    const { sessions } = room({ c: 50, a: 100, b: 50 });
    for (const s of Object.values(sessions)) expect(s.hostId).toBe('b');
    expect(Object.values(sessions).filter((s) => s.isHost)).toHaveLength(1);
  });

  it('호스트가 떠나면 남은 사람이 같은 새 호스트를 뽑고 hostChanged 를 알린다', () => {
    const { hub, sessions } = room({ a: 1, b: 2, c: 3 });
    const logB = record(sessions.b);
    const logC = record(sessions.c);
    hub.remove('a');
    expect(sessions.b.hostId).toBe('b');
    expect(sessions.c.hostId).toBe('b');
    expect(logB.hosts).toEqual([['b', true]]);
    expect(logC.hosts).toEqual([['b', false]]);
    expect(logB.left).toEqual(['a']);
    expect(sessions.b.players().map((p) => p.id).sort()).toEqual(['b', 'c']);
  });

  it('혼자 남으면 자기가 호스트', () => {
    const { hub, sessions } = room({ a: 1, b: 2 });
    hub.remove('a');
    expect(sessions.b.isHost).toBe(true);
  });

  it('호스트 둘이 합쳐짐: 따로 시작한 두 호스트가 연결되면 더 먼저 들어온 쪽으로 합의', () => {
    const hub = new FakeHub();
    hub.add('a');
    hub.add('b');
    const a = new Session(hub.node('a'), info('a', 100));
    const b = new Session(hub.node('b'), info('b', 200));
    expect(a.isHost && b.isHost).toBe(true);
    const logA = record(a);
    const logB = record(b);
    hub.connect('a', 'b');
    hub.flush();
    expect(a.isHost).toBe(true);
    expect(b.isHost).toBe(false);
    expect(logA.hosts).toEqual([]);
    expect(logB.hosts).toEqual([['a', false]]);
    // 진 쪽(b)이 아직 보내던 봇 메시지는 이긴 쪽이 무시, 이긴 쪽 봇 목록은 진 쪽이 받는다
    hub.node('b').send(MSG.botInfo, [encodeInfo({ ...info('bot-0', 0, 'B봇'), isBot: true })]);
    hub.node('b').send(MSG.bots, encodeBotStates([['bot-0', snap(9)]]));
    a.sendBotInfos([{ ...info('bot-0', 0, 'A봇'), isBot: true }]);
    hub.flush();
    expect(logA.botInfos).toEqual([]);
    expect(logA.snapshots).toEqual([]);
    expect(logB.botInfos).toHaveLength(1);
    expect(logB.botInfos[0][0]).toMatchObject({ id: 'bot-0', name: 'A봇', isBot: true });
  });

  it('새 참가자에게는 호스트의 hello 가 경기 상태·봇 목록보다 먼저 도착한다', () => {
    const hub = new FakeHub();
    hub.add('host');
    hub.add('late');
    const host = new Session(hub.node('host'), info('host', 1));
    // 게임(호스트)은 playerInfo 를 받으면 바로 그 사람에게 경기 상태·봇 목록을 보낸다
    host.on('playerInfo', (i) => {
      host.sendMatch(match('host', 3), i.id);
      host.sendBotInfos([{ ...info('bot-1', 0), isBot: true }], i.id);
    });
    hub.connect('host', 'late');
    hub.flush();
    const late = new Session(hub.node('late'), info('late', 5));
    const log = record(late);
    hub.flush();
    expect(late.hostId).toBe('host');
    expect(log.matches.map((m) => m.round)).toEqual([3]);
    expect(log.botInfos[0].map((b) => b.id)).toEqual(['bot-1']);
  });

  it('프로토콜 버전이 다르거나 봇이라고 주장하는 hello 는 무시', () => {
    const hub = new FakeHub();
    hub.add('a');
    const a = new Session(hub.node('a'), info('a', 100));
    const x = rawPeer(hub, 'x', 'a');
    x.send(MSG.hello, { v: NET.protocol + 1, info: encodeInfo(info('x', 1)) });
    x.send(MSG.hello, { v: NET.protocol, info: encodeInfo({ ...info('x', 1), isBot: true }) });
    x.send(MSG.hello, { v: NET.protocol, info: null });
    hub.flush();
    expect(a.players().map((p) => p.id)).toEqual(['a']);
    expect(a.isHost).toBe(true);
  });

  it('hello 안의 id 는 무시하고 전송 계층의 보낸 사람 id 를 쓴다(사칭 방지)', () => {
    const hub = new FakeHub();
    hub.add('a');
    const a = new Session(hub.node('a'), info('a', 100));
    const x = rawPeer(hub, 'x', 'a');
    x.send(MSG.hello, { v: NET.protocol, info: encodeInfo(info('a', 1, '가짜')) });
    hub.flush();
    expect(a.info('a')?.name).toBe('a');
    expect(a.info('x')?.name).toBe('가짜');
    expect(a.hostId).toBe('x');
  });

  it('떠난 피어의 늦은 hello 로 유령 플레이어(호스트)가 생기지 않는다', () => {
    const { hub, sessions } = room({ a: 1, b: 2, c: 3 });
    hub.deliverAfterLeave = true;
    // a 가 이름을 바꾸며 hello 를 보낸 직후 떠남 — 떠난 뒤에 hello 가 도착
    sessions.a.updateSelf({ name: '떠날사람' });
    hub.remove('a');
    hub.flush();
    for (const id of ['b', 'c']) {
      expect(sessions[id].info('a')).toBeUndefined();
      expect(sessions[id].hostId).toBe('b');
    }
  });

  it('떠났다가 다시 연결된 피어는 hello 로 다시 인정', () => {
    const { hub, sessions } = room({ a: 1, b: 2 });
    hub.disconnect('a', 'b');
    expect(sessions.b.isHost).toBe(true);
    hub.connect('a', 'b');
    hub.flush();
    expect(sessions.b.hostId).toBe('a');
    expect(sessions.a.hostId).toBe('a');
  });
});

describe('Session — 권한 필터', () => {
  it('hello 전의 메시지(스냅샷·발사·명중·쓰러짐)는 버리고, hello 뒤에는 받는다', () => {
    const hub = new FakeHub();
    hub.add('a');
    const a = new Session(hub.node('a'), info('a', 1));
    const log = record(a);
    const x = rawPeer(hub, 'x', 'a');
    const early = () => {
      x.send(MSG.state, encodeSnapshot(snap()));
      x.send(MSG.fire, encodeShots([shot('x')]));
      x.send(MSG.hit, encodeHits([hit('x', 'a')]));
      x.send(MSG.splash, encodeSplash({ victim: 'x', killer: 'a', source: 'soaker', pos: [0, 0, 0] }));
    };
    early();
    hub.flush();
    expect([log.snapshots.length, log.shots.length, log.hits.length, log.splashes.length]).toEqual([0, 0, 0, 0]);
    x.send(MSG.hello, { v: NET.protocol, info: encodeInfo(info('x', 5)) });
    early();
    hub.flush();
    expect([log.snapshots.length, log.shots.length, log.hits.length, log.splashes.length]).toEqual([1, 1, 1, 1]);
    expect(log.snapshots[0][0]).toBe('x');
  });

  it('잘못된 스냅샷은 버린다', () => {
    const { hub, sessions } = room({ a: 1, b: 2 });
    const log = record(sessions.a);
    hub.node('b').send(MSG.state, [1, 2, 3]);
    hub.node('b').send(MSG.state, { px: 1 });
    hub.node('b').send(MSG.state, encodeSnapshot(snap()).map((v, i) => (i === 1 ? 'x' : v)));
    hub.flush();
    expect(log.snapshots).toEqual([]);
  });

  it('사람은 자기 발사·명중만 보낼 수 있다(남 명의·봇 명의 불가)', () => {
    const { hub, sessions } = room({ a: 1, b: 2, c: 3 });
    const log = record(sessions.c);
    hub.node('b').send(MSG.fire, encodeShots([shot('b'), shot('a'), shot('bot-0')]));
    hub.node('b').send(MSG.hit, encodeHits([hit('b', 'c'), hit('a', 'c'), hit('bot-0', 'c')]));
    hub.flush();
    expect(log.shots.map((s) => s.shooter)).toEqual(['b']);
    expect(log.hits.map((h) => h.shooter)).toEqual(['b']);
  });

  it('호스트는 봇 명의로 발사·명중·쓰러짐을 보낼 수 있지만 사람 명의는 안 된다', () => {
    const { hub, sessions } = room({ a: 1, b: 2, c: 3 });
    const log = record(sessions.c);
    hub.node('a').send(MSG.fire, encodeShots([shot('bot-0'), shot('b')]));
    hub.node('a').send(MSG.hit, encodeHits([hit('bot-0', 'c'), hit('b', 'c')]));
    hub.node('a').send(MSG.splash, encodeSplash({ victim: 'bot-0', killer: 'c', source: 'soaker', pos: [0, 0, 0] }));
    hub.node('a').send(MSG.splash, encodeSplash({ victim: 'b', killer: 'a', source: 'soaker', pos: [0, 0, 0] }));
    hub.flush();
    expect(log.shots.map((s) => s.shooter)).toEqual(['bot-0']);
    expect(log.hits.map((h) => h.shooter)).toEqual(['bot-0']);
    expect(log.splashes.map((s) => s.victim)).toEqual(['bot-0']);
  });

  it('쓰러짐은 피해자 본인만 알릴 수 있다', () => {
    const { hub, sessions } = room({ a: 1, b: 2, c: 3 });
    const log = record(sessions.a);
    hub.node('c').send(MSG.splash, encodeSplash({ victim: 'b', killer: 'c', source: 'soaker', pos: [0, 0, 0] }));
    hub.node('c').send(MSG.splash, encodeSplash({ victim: 'c', killer: 'b', source: 'bucket', pos: [1, 0, 1] }));
    hub.flush();
    expect(log.splashes).toEqual([{ victim: 'c', killer: 'b', source: 'bucket', pos: [1, 0, 1] }]);
  });

  it('봇 상태·봇 목록·경기 상태는 현재 호스트만 보낼 수 있다', () => {
    const { hub, sessions } = room({ a: 1, b: 2, c: 3 });
    const log = record(sessions.c);
    hub.node('b').send(MSG.bots, encodeBotStates([['bot-0', snap()]]));
    hub.node('b').send(MSG.botInfo, [encodeInfo({ ...info('bot-0', 0), isBot: true })]);
    hub.node('b').send(MSG.match, encodeMatch(match('b')));
    hub.flush();
    expect(log.snapshots).toEqual([]);
    expect(log.botInfos).toEqual([]);
    expect(log.matches).toEqual([]);
    hub.node('a').send(MSG.bots, encodeBotStates([['bot-0', snap()]]));
    hub.node('a').send(MSG.botInfo, [encodeInfo({ ...info('bot-0', 0), isBot: false })]);
    hub.node('a').send(MSG.match, encodeMatch(match('a')));
    hub.flush();
    expect(log.snapshots.map(([id]) => id)).toEqual(['bot-0']);
    expect(log.botInfos[0]).toMatchObject([{ id: 'bot-0', isBot: true }]);
    expect(log.matches).toHaveLength(1);
  });

  it('호스트도 사람 id 로 봇 상태·봇 목록을 보낼 수 없다(사람 위치·정보 덮어쓰기 방지)', () => {
    const { hub, sessions } = room({ a: 1, b: 2, c: 3 });
    const log = record(sessions.c);
    hub.node('a').send(MSG.bots, encodeBotStates([['b', snap(50)], ['c', snap(50)], ['bot-2', snap(3)]]));
    hub.node('a').send(MSG.botInfo, [encodeInfo({ ...info('b', 0), isBot: true }), encodeInfo({ ...info('bot-2', 0), isBot: true })]);
    hub.flush();
    expect(log.snapshots.map(([id]) => id)).toEqual(['bot-2']);
    expect(log.botInfos[0].map((i) => i.id)).toEqual(['bot-2']);
  });

  it('경기 상태의 hostId 는 보낸 사람으로 고정된다', () => {
    const { hub, sessions } = room({ a: 1, b: 2 });
    const log = record(sessions.b);
    hub.node('a').send(MSG.match, encodeMatch(match('b')));
    hub.flush();
    expect(log.matches[0].hostId).toBe('a');
  });

  it('호스트 이전 뒤에는 이전 호스트(아직 연결된 진 쪽)의 경기 상태를 버리고 새 호스트 것을 받는다', () => {
    const { hub, sessions } = room({ a: 1, b: 2, c: 3 });
    const log = record(sessions.c);
    hub.disconnect('a', 'c'); // c 기준으로 a 가 떠남 → 새 호스트 b
    expect(sessions.c.hostId).toBe('b');
    hub.node('b').send(MSG.match, encodeMatch(match('b', 2)));
    hub.flush();
    expect(log.matches.map((m) => [m.hostId, m.round])).toEqual([['b', 2]]);
  });

  it('잘못된 메시지 하나가 예외로 세션을 멈추지 않는다', () => {
    const { hub, sessions } = room({ a: 1, b: 2 });
    const log = record(sessions.a);
    sessions.a.on('snapshot', () => {
      throw new Error('handler 폭발');
    });
    const warn = console.warn;
    const warned: unknown[] = [];
    console.warn = (...a: unknown[]) => warned.push(a);
    try {
      hub.node('b').send(MSG.state, encodeSnapshot(snap()));
      hub.node('b').send(MSG.fire, encodeShots([shot('b')]));
      hub.flush();
    } finally {
      console.warn = warn;
    }
    expect(warned).toHaveLength(1);
    expect(log.shots).toHaveLength(1);
  });

  it('닫힌 세션은 메시지를 처리하지 않는다', async () => {
    const { hub, sessions } = room({ a: 1, b: 2 });
    const log = record(sessions.a);
    await sessions.a.close();
    hub.node('b').send(MSG.state, encodeSnapshot(snap()));
    hub.flush();
    expect(log.snapshots).toEqual([]);
    expect(sessions.b.isHost).toBe(true);
  });
});

describe('Session — 시계', () => {
  it('스냅샷의 보낸 쪽 시각을 내 시각으로 바꿔 준다(가장 빠른 표본 기준)', () => {
    const { hub, sessions } = room({ a: 1, b: 2 });
    const got: number[] = [];
    sessions.a.on('snapshot', (_id, _s, localT) => got.push(localT));
    const before = performance.now();
    hub.node('b').send(MSG.state, encodeSnapshot({ ...snap(), t: 5_000 }));
    hub.node('b').send(MSG.state, encodeSnapshot({ ...snap(), t: 5_050 }));
    hub.flush();
    const after = performance.now();
    expect(got).toHaveLength(2);
    // 첫 표본: 받은 시각 그대로. 둘째(50ms 뒤에 보냈는데 거의 동시에 도착): 더 빠른 표본이므로 즉시 반영되어 역시 받은 시각
    for (const t of got) {
      expect(t).toBeGreaterThanOrEqual(before);
      expect(t).toBeLessThanOrEqual(after);
    }
    expect(sessions.a.clock('b').ready).toBe(true);
  });
});

describe('Session — 말 없는 호스트(탭 강제 종료) 감지', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['performance'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** ms 동안 frameMs 간격으로 시간을 흘리며 update, 말하는 사람들은 매 프레임 상태를 보낸다 */
  function advance(hub: FakeHub, sessions: Record<PeerId, Session>, ms: number, speakers: PeerId[], frameMs = 50) {
    for (let t = 0; t < ms; t += frameMs) {
      vi.advanceTimersByTime(frameMs);
      for (const id of speakers) sessions[id].sendState(snap());
      hub.flush();
      for (const id of Object.keys(sessions)) sessions[id].update(performance.now());
    }
  }

  it(`호스트가 ${NET.hostSilenceMs}ms 넘게 조용하면 모두 같은 다음 사람을 뽑고, 다시 말하면 되돌린다`, () => {
    const { hub, sessions } = room({ a: 1, b: 2, c: 3 });
    const logB = record(sessions.b);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      advance(hub, sessions, NET.hostSilenceMs - 500, ['b', 'c']);
      expect(sessions.b.hostId).toBe('a');
      advance(hub, sessions, 1000, ['b', 'c']);
      expect(sessions.b.hostId).toBe('b');
      expect(sessions.c.hostId).toBe('b');
      expect(logB.hosts).toEqual([['b', true]]);
      // a 는 자기가 멈춘 줄 모르고 여전히 자기가 호스트 — 다시 말하면 모두 a 로 돌아감
      expect(sessions.a.isHost).toBe(true);
      advance(hub, sessions, 100, ['a', 'b', 'c']);
      expect(sessions.b.hostId).toBe('a');
      expect(sessions.c.hostId).toBe('a');
      expect(logB.hosts).toEqual([['b', true], ['a', false]]);
    } finally {
      warn.mockRestore();
    }
  });

  it('호스트가 아닌 사람이 조용해도 호스트는 그대로, 호스트가 떠나면 조용한 사람은 건너뛴다', () => {
    const { hub, sessions } = room({ a: 1, b: 2, c: 3 });
    advance(hub, sessions, NET.hostSilenceMs + 500, ['a', 'c']);
    expect(sessions.c.hostId).toBe('a');
    hub.remove('a');
    expect(sessions.c.hostId).toBe('c');
  });

  it('isSilent: 조용한 사람만 true(게임이 유령을 숨김), 다시 말하거나 떠나면 false', () => {
    const { hub, sessions } = room({ a: 1, b: 2, c: 3 });
    advance(hub, sessions, NET.hostSilenceMs - 500, ['a', 'c']);
    expect(sessions.a.isSilent('b')).toBe(false);
    advance(hub, sessions, 1000, ['a', 'c']);
    expect(sessions.a.isSilent('b')).toBe(true);
    expect(sessions.c.isSilent('b')).toBe(true);
    expect(sessions.a.isSilent('c')).toBe(false);
    expect(sessions.a.isSilent('a')).toBe(false);
    advance(hub, sessions, 100, ['a', 'b', 'c']);
    expect(sessions.a.isSilent('b')).toBe(false);
    advance(hub, sessions, NET.hostSilenceMs + 500, ['a', 'c']);
    expect(sessions.a.isSilent('b')).toBe(true);
    hub.remove('b');
    expect(sessions.a.isSilent('b')).toBe(false);
    expect(sessions.a.info('b')).toBeUndefined();
  });

  it('내 쪽 루프가 멈췄다 깨어난 경우(탭 얼림)는 남 탓으로 호스트를 바꾸지 않는다', () => {
    const { hub, sessions } = room({ a: 1, b: 2 });
    advance(hub, sessions, 500, ['a', 'b']);
    // b 의 루프가 10초 멈춤(그동안 메시지 처리도 없음)
    vi.advanceTimersByTime(10_000);
    sessions.b.update(performance.now());
    expect(sessions.b.hostId).toBe('a');
    advance(hub, sessions, 500, ['a', 'b']);
    expect(sessions.b.hostId).toBe('a');
  });
});
