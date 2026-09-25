import { describe, expect, it } from 'vitest';
import {
  MAX_HIT_AMOUNT, MSG, decodeBotStates, decodeHello, decodeHits, decodeInfo, decodeInfos, decodeMatch, decodeShots, decodeSnapshot,
  decodeSplash, encodeBotStates, encodeHits, encodeInfo, encodeMatch, encodeShots, encodeSnapshot, encodeSplash, sanitizeName, wrapAngle,
  type NetHit, type NetShot, type NetSplash,
} from '../src/net/protocol';
import { MATCH, NET, PLAYER_COLORS } from '../src/config';
import type { MatchState, PlayerInfo, PlayerSnapshot } from '../src/types';

/** Trystero 는 JSON 으로 보낸다 — 실제 전송과 같은 왕복 */
const wire = <T>(v: T): unknown => JSON.parse(JSON.stringify(v));

const SNAP: PlayerSnapshot = {
  t: 123456.7, px: 1.23456, py: 2.5, pz: -3.3333, vx: 4.1, vy: -5.25, vz: 0.001,
  yaw: 1.2345, pitch: -0.5, weapon: 'bucket', soak: 0.4567, tank: 0.9, alive: true, grounded: false, shielded: true,
};

const INFO: PlayerInfo = { id: 'peerA', name: '촉촉한오리', cosmetics: { color: 3, hat: 'duck' }, isBot: false, joinedAt: 1_700_000_000_000 };

const SHOT: NetShot = {
  shooter: 'peerA', kind: 'soaker', t: 5000.4, seed: 0xdeadbeef, spread: 2,
  origin: [1.5, 1.4, -2], dir: [0, 0.6, -0.8], inherit: [3, 0, -1],
};

const HIT: NetHit = { victim: 'peerB', shooter: 'peerA', amount: 16, source: 'soaker', dir: [0, 0, -1] };

const MATCH_STATE: MatchState = {
  mode: 'tdm', phase: 'results', remainingMs: 4321, round: 3,
  scores: { peerA: { splashes: 5, soaked: 2, team: 0 }, 'bot-1': { splashes: 1, soaked: 4, team: 1 } },
  teamScores: [5, 1], hostId: 'peerA', winner: 'team0',
};

describe('protocol — 왕복(인코딩 → JSON → 디코딩)', () => {
  it('Trystero action 이름은 12바이트 이하', () => {
    for (const name of Object.values(MSG)) expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(12);
  });

  it('플레이어 정보·hello', () => {
    expect(decodeInfo(wire(encodeInfo(INFO)))).toEqual(INFO);
    const hello = decodeHello(wire({ v: NET.protocol, info: encodeInfo(INFO) }));
    expect(hello).toEqual({ v: NET.protocol, info: INFO });
    expect(decodeInfo(wire(encodeInfo({ ...INFO, isBot: true })))?.isBot).toBe(true);
  });

  it('스냅샷(좌표는 mm, 젖음·탱크는 0.1% 단위로 양자화)', () => {
    const d = decodeSnapshot(wire(encodeSnapshot(SNAP)))!;
    expect(d).not.toBeNull();
    expect(d.t).toBe(123457);
    for (const k of ['px', 'py', 'pz', 'vx', 'vy', 'vz', 'yaw', 'pitch'] as const) expect(d[k]).toBeCloseTo(SNAP[k], 3);
    expect(d.soak).toBeCloseTo(0.457, 6);
    expect(d.tank).toBeCloseTo(0.9, 6);
    expect(d).toMatchObject({ weapon: 'bucket', alive: true, grounded: false, shielded: true });
    for (const flags of [[false, true, false], [true, false, false], [false, false, true]] as const) {
      const s = { ...SNAP, alive: flags[0], grounded: flags[1], shielded: flags[2] };
      expect(decodeSnapshot(wire(encodeSnapshot(s)))).toMatchObject({ alive: flags[0], grounded: flags[1], shielded: flags[2] });
    }
  });

  it('봇 상태 묶음', () => {
    const list = decodeBotStates(wire(encodeBotStates([['bot-0', SNAP], ['bot-1', { ...SNAP, px: 9 }]])));
    expect(list.map(([id]) => id)).toEqual(['bot-0', 'bot-1']);
    expect(list[1][1].px).toBe(9);
  });

  it('발사(방향은 정규화, 시드는 u32 그대로)', () => {
    const [d] = decodeShots(wire(encodeShots([SHOT])));
    expect(d.shooter).toBe('peerA');
    expect(d.kind).toBe('soaker');
    expect(d.seed).toBe(0xdeadbeef);
    expect(d.spread).toBe(2);
    expect(d.origin).toEqual([1.5, 1.4, -2]);
    expect(Math.hypot(...d.dir)).toBeCloseTo(1, 9);
    expect(d.dir[1]).toBeCloseTo(0.6, 3);
    expect(d.inherit).toEqual([3, 0, -1]);
    const [b] = decodeShots(wire(encodeShots([{ ...SHOT, kind: 'balloon' }])));
    expect(b.kind).toBe('balloon');
  });

  it('명중·쓰러짐', () => {
    expect(decodeHits(wire(encodeHits([HIT])))).toEqual([HIT]);
    const sp: NetSplash = { victim: 'bot-2', killer: 'peerA', source: 'balloon', pos: [1, 2, 3] };
    expect(decodeSplash(wire(encodeSplash(sp)))).toEqual(sp);
  });

  it('경기 상태', () => {
    expect(decodeMatch(wire(encodeMatch(MATCH_STATE)))).toEqual(MATCH_STATE);
    const { winner: _w, ...noWinner } = { ...MATCH_STATE, phase: 'playing' as const };
    expect(decodeMatch(wire(encodeMatch(noWinner)))).toEqual({ ...noWinner, winner: undefined });
  });
});

describe('protocol — 잘못된·악의적 입력 거부', () => {
  const junk = [null, undefined, 0, 1, 'x', true, [], {}, [[]], { length: 13 }];

  it('어떤 쓰레기 값에도 예외 없이 null/빈 목록', () => {
    for (const j of junk) {
      expect(() => decodeSnapshot(j)).not.toThrow();
      expect(decodeSnapshot(j)).toBeNull();
      expect(decodeHello(j)).toBeNull();
      expect(decodeInfo(j)).toBeNull();
      expect(decodeSplash(j)).toBeNull();
      expect(decodeMatch(j)).toBeNull();
      expect(decodeShots(j)).toEqual([]);
      expect(decodeHits(j)).toEqual([]);
      expect(decodeBotStates(j)).toEqual([]);
      expect(decodeInfos(j)).toEqual([]);
    }
  });

  it('스냅샷: 길이·NaN·Infinity·문자열·무기 번호·좌표 범위', () => {
    const good = encodeSnapshot(SNAP);
    expect(decodeSnapshot(good.slice(0, 12))).toBeNull();
    expect(decodeSnapshot([...good, 0])).toBeNull();
    for (let i = 0; i < good.length; i++) {
      for (const bad of [NaN, Infinity, -Infinity, '1', null]) {
        const a: unknown[] = [...good];
        a[i] = bad;
        expect(decodeSnapshot(a), `index ${i} = ${String(bad)}`).toBeNull();
      }
    }
    for (const w of [-1, 3, 1.5, 99]) expect(decodeSnapshot(good.map((v, i) => (i === 9 ? w : v)))).toBeNull();
    for (const i of [1, 2, 3]) expect(decodeSnapshot(good.map((v, j) => (j === i ? 1001 : v)))).toBeNull();
    // JSON 왕복하면 NaN 은 null 이 된다
    expect(decodeSnapshot(wire({ ...good, 0: NaN }))).toBeNull();
    expect(decodeSnapshot(wire(good.map((v, i) => (i === 4 ? NaN : v))))).toBeNull();
  });

  it('스냅샷: 속도·젖음·탱크·피치는 범위로 자르고, 거대한 yaw 는 [-π, π) 로 감는다', () => {
    const a = encodeSnapshot(SNAP);
    a[4] = 1e9;
    a[5] = -1e9;
    a[7] = 1e12 + 0.5;
    a[8] = 50;
    a[10] = 5000;
    a[11] = -20;
    const d = decodeSnapshot(a)!;
    expect(d.vx).toBe(60);
    expect(d.vy).toBe(-60);
    expect(d.yaw).toBeGreaterThanOrEqual(-Math.PI);
    expect(d.yaw).toBeLessThan(Math.PI);
    expect(d.pitch).toBeCloseTo(Math.PI / 2, 9);
    expect(d.soak).toBe(1);
    expect(d.tank).toBe(0);
  });

  it('wrapAngle', () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(-Math.PI, 9);
    expect(wrapAngle(-Math.PI * 2.5)).toBeCloseTo(-Math.PI / 2, 9);
    expect(wrapAngle(1)).toBeCloseTo(1, 12);
    expect(Math.abs(wrapAngle(1e300))).toBeLessThanOrEqual(Math.PI);
  });

  it('발사: 길이·종류·방향·좌표가 이상한 줄은 건너뛰고, 한 메시지 최대 64줄', () => {
    const row = (encodeShots([SHOT]) as unknown[][])[0];
    const rows = [
      row.slice(0, 13),
      row.map((v, i) => (i === 1 ? 7 : v)),
      row.map((v, i) => (i === 1 ? 'length' : v)),
      row.map((v, i) => (i >= 8 && i <= 10 ? 0 : v)),
      row.map((v, i) => (i === 8 ? 5 : v)),
      row.map((v, i) => (i === 5 ? 5000 : v)),
      row.map((v, i) => (i === 3 ? null : v)),
      row.map((v, i) => (i === 0 ? '' : v)),
      row.map((v, i) => (i === 0 ? 'x'.repeat(65) : v)),
      row,
    ];
    expect(decodeShots(rows)).toHaveLength(1);
    const huge = Array.from({ length: 10_000 }, () => row);
    expect(decodeShots(huge)).toHaveLength(64);
    const clamped = decodeShots([row.map((v, i) => (i === 4 ? 1e6 : i >= 11 ? 1e6 : v))])[0];
    expect(clamped.spread).toBe(5);
    expect(clamped.inherit).toEqual([30, 30, 30]);
  });

  it('명중: 적심은 0 < amount ≤ MAX_HIT_AMOUNT, 이상한 줄은 건너뜀, 최대 64줄', () => {
    const row = (encodeHits([HIT]) as unknown[][])[0];
    expect(decodeHits([row.map((v, i) => (i === 2 ? 1e9 : v))])[0].amount).toBe(MAX_HIT_AMOUNT);
    expect(decodeHits([row.map((v, i) => (i === 2 ? 0 : v))])).toEqual([]);
    expect(decodeHits([row.map((v, i) => (i === 2 ? -50 : v))])).toEqual([]);
    expect(decodeHits([row.map((v, i) => (i === 3 ? 9 : v))])).toEqual([]);
    expect(decodeHits([row.map((v, i) => (i === 4 ? null : v))])).toEqual([]);
    expect(decodeHits([row.slice(0, 6)])).toEqual([]);
    expect(decodeHits(Array.from({ length: 500 }, () => row))).toHaveLength(64);
  });

  it('쓰러짐: 길이·원인·좌표 범위', () => {
    const good = encodeSplash({ victim: 'a', killer: 'b', source: 'pistol', pos: [0, 0, 0] }) as unknown[];
    expect(decodeSplash(good.slice(0, 5))).toBeNull();
    expect(decodeSplash(good.map((v, i) => (i === 2 ? 4 : v)))).toBeNull();
    expect(decodeSplash(good.map((v, i) => (i === 3 ? 1e7 : v)))).toBeNull();
    expect(decodeSplash(good.map((v, i) => (i === 5 ? NaN : v)))).toBeNull();
    expect(decodeSplash(good.map((v, i) => (i === 0 ? 5 : v)))).toBeNull();
  });

  it('hello: 버전·정보 형식', () => {
    const info = encodeInfo(INFO) as Record<string, unknown>;
    expect(decodeHello({ v: '1', info })).toBeNull();
    expect(decodeHello({ v: NaN, info })).toBeNull();
    expect(decodeHello({ v: 1, info: { ...info, j: 'soon' } })).toBeNull();
    expect(decodeHello({ v: 1, info: { ...info, id: '' } })).toBeNull();
    expect(decodeHello({ v: 1, info: { ...info, id: 'x'.repeat(65) } })).toBeNull();
    expect(decodeHello({ v: 1, info: { ...info, c: Infinity } })).toBeNull();
  });

  it('정보: 이름 정리, 모르는 모자 → none, 색 번호 범위', () => {
    const d = decodeInfo({ id: 'p', n: '  \u0000악당‮\n  이름이너무너무너무너무길어요 ', c: 999, h: 'tophat', b: 0, j: 1 })!;
    expect(d.name).toBe('악당 이름이너무너무너무너무');
    expect(d.name.length).toBeLessThanOrEqual(14);
    expect(d.cosmetics).toEqual({ color: PLAYER_COLORS.length - 1, hat: 'none' });
    expect(decodeInfo({ id: 'p', n: 42, c: -3.7, h: 'crown', b: 'yes', j: 1 })).toEqual({
      id: 'p', name: '물총러', cosmetics: { color: 0, hat: 'crown' }, isBot: false, joinedAt: 1,
    });
    expect(sanitizeName('​​')).toBe('물총러');
  });

  it('정보 목록·봇 상태 목록은 최대 인원까지만', () => {
    const infos = Array.from({ length: 50 }, (_, i) => encodeInfo({ ...INFO, id: `p${i}` }));
    expect(decodeInfos(infos)).toHaveLength(MATCH.maxPlayers);
    const bots = Array.from({ length: 50 }, (_, i) => [`bot-${i}`, ...encodeSnapshot(SNAP)]);
    expect(decodeBotStates(bots)).toHaveLength(MATCH.maxPlayers);
    expect(decodeBotStates([['bot-0', 1, 2], [5, ...encodeSnapshot(SNAP)], ['bot-1', ...encodeSnapshot(SNAP)]]).map(([id]) => id)).toEqual(['bot-1']);
  });

  it('경기 상태: 모드·단계·수치 검증, 점수 줄 32개 제한, 음수·소수 정리', () => {
    const base = wire(encodeMatch(MATCH_STATE)) as Record<string, unknown>;
    expect(decodeMatch({ ...base, mode: 'ctf' })).toBeNull();
    expect(decodeMatch({ ...base, phase: 'lobby' })).toBeNull();
    expect(decodeMatch({ ...base, remainingMs: null })).toBeNull();
    expect(decodeMatch({ ...base, round: '3' })).toBeNull();
    expect(decodeMatch({ ...base, hostId: '' })).toBeNull();
    expect(decodeMatch({ ...base, teamScores: [1] })).toBeNull();
    expect(decodeMatch({ ...base, teamScores: [1, NaN] })).toBeNull();
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i++) many[`p${i}`] = { splashes: 1, soaked: 1, team: -1 };
    expect(Object.keys(decodeMatch({ ...base, scores: many })!.scores)).toHaveLength(32);
    const d = decodeMatch({
      ...base, remainingMs: 1e12, teamScores: [-5, 2.7], winner: 'w'.repeat(100),
      scores: { a: { splashes: -3, soaked: 2.9, team: 7 }, b: { splashes: 'x', soaked: 1 }, c: null },
    })!;
    expect(d.remainingMs).toBe(60 * 60 * 1000);
    expect(d.teamScores).toEqual([0, 2]);
    expect(d.winner).toHaveLength(64);
    expect(d.scores).toEqual({ a: { splashes: 0, soaked: 2, team: -1 } });
  });

  it('경기 상태: __proto__·constructor 같은 키로 객체를 오염시키지 못한다', () => {
    const raw = JSON.parse('{"mode":"ffa","phase":"playing","remainingMs":1,"round":1,"hostId":"h","teamScores":[0,0],'
      + '"scores":{"__proto__":{"splashes":9,"soaked":0,"team":0},"constructor":{"splashes":9,"soaked":0,"team":0},"ok":{"splashes":1,"soaked":0,"team":-1}}}');
    const d = decodeMatch(raw)!;
    expect(Object.keys(d.scores)).toEqual(['ok']);
    expect(Object.getPrototypeOf(d.scores)).toBe(Object.prototype);
    expect((d.scores as Record<string, unknown>).splashes).toBeUndefined();
    expect(({} as Record<string, unknown>).splashes).toBeUndefined();
  });
});
