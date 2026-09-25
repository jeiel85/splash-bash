/**
 * 네트워크 메시지 형식과 검증. 모든 수신 데이터는 신뢰할 수 없는 입력으로 보고 여기서 검증한다.
 * 형식을 바꾸면 NET.protocol 을 올린다(다른 버전과는 hello 단계에서 무시).
 */
import { HAT_IDS, WEAPON_IDS, type Cosmetics, type DamageSource, type MatchState, type PeerId, type PlayerInfo, type PlayerSnapshot, type ScoreLine, type TeamId, type WeaponId } from '../types';
import { MATCH, PLAYER_COLORS } from '../config';

/** Trystero action 이름(12바이트 이하) */
export const MSG = {
  hello: 'hello',
  state: 'st',
  bots: 'bots',
  botInfo: 'binfo',
  fire: 'fire',
  hit: 'hit',
  splash: 'splash',
  match: 'match',
} as const;
export type MsgType = (typeof MSG)[keyof typeof MSG];

const SOURCES: readonly DamageSource[] = [...WEAPON_IDS, 'balloon'];

// ------------------------------------------------------------------ helpers

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const MAX_COORD = 1000;
const TAU = Math.PI * 2;

/** 임의의 유한 각도를 [-π, π) 로(거대한 값도 반복 없이) */
export function wrapAngle(a: number): number {
  return ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
}

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
}

/** 닉네임 정리: 제어문자 제거, 공백 정리, 길이 제한 */
export function sanitizeName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : '';
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 14) || '물총러';
}

// ------------------------------------------------------------------ player info

export interface HelloMsg {
  v: number;
  info: PlayerInfo;
}

export function encodeInfo(info: PlayerInfo): unknown {
  return { id: info.id, n: info.name, c: info.cosmetics.color, h: info.cosmetics.hat, b: info.isBot ? 1 : 0, j: info.joinedAt };
}

export function decodeInfo(raw: unknown): PlayerInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = str(o.id, 64);
  if (!id || !isNum(o.c) || !isNum(o.j)) return null;
  const hat = HAT_IDS.includes(o.h as never) ? (o.h as Cosmetics['hat']) : 'none';
  const color = clamp(Math.floor(o.c), 0, PLAYER_COLORS.length - 1);
  return { id, name: sanitizeName(o.n), cosmetics: { color, hat }, isBot: o.b === 1, joinedAt: o.j };
}

// ------------------------------------------------------------------ snapshot

const F_ALIVE = 1;
const F_GROUNDED = 2;
const F_SHIELD = 4;

export function encodeSnapshot(s: PlayerSnapshot): number[] {
  const flags = (s.alive ? F_ALIVE : 0) | (s.grounded ? F_GROUNDED : 0) | (s.shielded ? F_SHIELD : 0);
  return [
    Math.round(s.t),
    r3(s.px), r3(s.py), r3(s.pz),
    r3(s.vx), r3(s.vy), r3(s.vz),
    r3(s.yaw), r3(s.pitch),
    WEAPON_IDS.indexOf(s.weapon),
    Math.round(clamp(s.soak, 0, 1) * 1000),
    Math.round(clamp(s.tank, 0, 1) * 1000),
    flags,
  ];
}

export function decodeSnapshot(raw: unknown): PlayerSnapshot | null {
  if (!Array.isArray(raw) || raw.length !== 13 || !raw.every(isNum)) return null;
  const a = raw as number[];
  const weapon = WEAPON_IDS[a[9]];
  if (!weapon) return null;
  if (Math.abs(a[1]) > MAX_COORD || Math.abs(a[2]) > MAX_COORD || Math.abs(a[3]) > MAX_COORD) return null;
  return {
    t: a[0],
    px: a[1], py: a[2], pz: a[3],
    vx: clamp(a[4], -60, 60), vy: clamp(a[5], -60, 60), vz: clamp(a[6], -60, 60),
    yaw: wrapAngle(a[7]), pitch: clamp(a[8], -Math.PI / 2, Math.PI / 2),
    weapon,
    soak: clamp(a[10] / 1000, 0, 1),
    tank: clamp(a[11] / 1000, 0, 1),
    alive: (a[12] & F_ALIVE) !== 0,
    grounded: (a[12] & F_GROUNDED) !== 0,
    shielded: (a[12] & F_SHIELD) !== 0,
  };
}

/** 호스트가 보내는 봇 상태 묶음: [[id, ...snapshot], ...] */
export function encodeBotStates(list: Array<[PeerId, PlayerSnapshot]>): unknown {
  return list.map(([id, s]) => [id, ...encodeSnapshot(s)]);
}

export function decodeBotStates(raw: unknown): Array<[PeerId, PlayerSnapshot]> {
  if (!Array.isArray(raw)) return [];
  const out: Array<[PeerId, PlayerSnapshot]> = [];
  for (const row of raw.slice(0, MATCH.maxPlayers)) {
    if (!Array.isArray(row)) continue;
    const id = str(row[0], 64);
    const snap = decodeSnapshot(row.slice(1));
    if (id && snap) out.push([id, snap]);
  }
  return out;
}

// ------------------------------------------------------------------ fire

export interface NetShot {
  shooter: PeerId;
  kind: WeaponId | 'balloon';
  /** 보낸 쪽 시계(ms) */
  t: number;
  seed: number;
  /** 퍼짐 배율(이동·공중) */
  spread: number;
  origin: [number, number, number];
  dir: [number, number, number];
  /** 물풍선: 던진 사람 속도(관성) */
  inherit: [number, number, number];
}

export function encodeShots(shots: NetShot[]): unknown {
  return shots.map((s) => [
    s.shooter, SOURCES.indexOf(s.kind), Math.round(s.t), s.seed >>> 0, Math.round(s.spread * 100),
    r3(s.origin[0]), r3(s.origin[1]), r3(s.origin[2]),
    r3(s.dir[0]), r3(s.dir[1]), r3(s.dir[2]),
    r3(s.inherit[0]), r3(s.inherit[1]), r3(s.inherit[2]),
  ]);
}

export function decodeShots(raw: unknown): NetShot[] {
  if (!Array.isArray(raw)) return [];
  const out: NetShot[] = [];
  for (const row of raw.slice(0, 64)) {
    if (!Array.isArray(row) || row.length !== 14) continue;
    const shooter = str(row[0], 64);
    const kind = SOURCES[row[1] as number];
    if (!shooter || !kind || !row.slice(1).every(isNum)) continue;
    const o: [number, number, number] = [row[5], row[6], row[7]];
    const d: [number, number, number] = [row[8], row[9], row[10]];
    if (o.some((v) => Math.abs(v) > MAX_COORD)) continue;
    const len = Math.hypot(d[0], d[1], d[2]);
    if (len < 0.5 || len > 1.5) continue;
    out.push({
      shooter, kind, t: row[2], seed: row[3] >>> 0,
      spread: clamp(row[4] / 100, 0, 5),
      origin: o,
      dir: [d[0] / len, d[1] / len, d[2] / len],
      inherit: [clamp(row[11], -30, 30), clamp(row[12], -30, 30), clamp(row[13], -30, 30)],
    });
  }
  return out;
}

// ------------------------------------------------------------------ hit

export interface NetHit {
  victim: PeerId;
  shooter: PeerId;
  amount: number;
  source: DamageSource;
  /** 맞은 방향(피격 방향 표시용) */
  dir: [number, number, number];
}

/** 한 번의 hit 메시지로 받을 수 있는 최대 적심(치트·버그 방지 상한) */
export const MAX_HIT_AMOUNT = 140;

export function encodeHits(hits: NetHit[]): unknown {
  return hits.map((h) => [h.victim, h.shooter, Math.round(h.amount), SOURCES.indexOf(h.source), r3(h.dir[0]), r3(h.dir[1]), r3(h.dir[2])]);
}

export function decodeHits(raw: unknown): NetHit[] {
  if (!Array.isArray(raw)) return [];
  const out: NetHit[] = [];
  for (const row of raw.slice(0, 64)) {
    if (!Array.isArray(row) || row.length !== 7) continue;
    const victim = str(row[0], 64);
    const shooter = str(row[1], 64);
    const source = SOURCES[row[3] as number];
    if (!victim || !shooter || !source || !row.slice(2).every(isNum)) continue;
    const amount = clamp(row[2], 0, MAX_HIT_AMOUNT);
    if (amount <= 0) continue;
    out.push({ victim, shooter, amount, source, dir: [row[4], row[5], row[6]] });
  }
  return out;
}

// ------------------------------------------------------------------ splash (knock-out)

export interface NetSplash {
  victim: PeerId;
  killer: PeerId;
  source: DamageSource;
  pos: [number, number, number];
}

export function encodeSplash(s: NetSplash): unknown {
  return [s.victim, s.killer, SOURCES.indexOf(s.source), r3(s.pos[0]), r3(s.pos[1]), r3(s.pos[2])];
}

export function decodeSplash(raw: unknown): NetSplash | null {
  if (!Array.isArray(raw) || raw.length !== 6) return null;
  const victim = str(raw[0], 64);
  const killer = str(raw[1], 64);
  const source = SOURCES[raw[2] as number];
  if (!victim || !killer || !source || !raw.slice(2).every(isNum)) return null;
  if (Math.abs(raw[3]) > MAX_COORD || Math.abs(raw[4]) > MAX_COORD || Math.abs(raw[5]) > MAX_COORD) return null;
  return { victim, killer, source, pos: [raw[3], raw[4], raw[5]] };
}

// ------------------------------------------------------------------ match

export function encodeMatch(m: MatchState): unknown {
  return m;
}

export function decodeMatch(raw: unknown): MatchState | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if ((o.mode !== 'ffa' && o.mode !== 'tdm') || (o.phase !== 'playing' && o.phase !== 'results')) return null;
  if (!isNum(o.remainingMs) || !isNum(o.round) || !str(o.hostId, 64)) return null;
  const ts = o.teamScores;
  if (!Array.isArray(ts) || ts.length !== 2 || !ts.every(isNum)) return null;
  const scores: Record<PeerId, ScoreLine> = {};
  if (o.scores && typeof o.scores === 'object') {
    let n = 0;
    for (const [id, line] of Object.entries(o.scores as Record<string, unknown>)) {
      if (++n > 32) break;
      // '__proto__'·'constructor' 같은 키는 일반 객체 조회를 오염시킨다
      if (id.length === 0 || id.length > 64 || id in Object.prototype || !line || typeof line !== 'object') continue;
      const l = line as Record<string, unknown>;
      if (!isNum(l.splashes) || !isNum(l.soaked)) continue;
      const team = (l.team === 0 || l.team === 1 ? l.team : -1) as TeamId;
      scores[id] = { splashes: Math.max(0, Math.floor(l.splashes)), soaked: Math.max(0, Math.floor(l.soaked)), team };
    }
  }
  return {
    mode: o.mode,
    phase: o.phase,
    remainingMs: clamp(o.remainingMs, 0, 60 * 60 * 1000),
    round: Math.floor(o.round),
    scores,
    teamScores: [Math.max(0, Math.floor(ts[0])), Math.max(0, Math.floor(ts[1]))],
    hostId: o.hostId as string,
    winner: typeof o.winner === 'string' ? o.winner.slice(0, 64) : undefined,
  };
}

export function decodeHello(raw: unknown): HelloMsg | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!isNum(o.v)) return null;
  const info = decodeInfo(o.info);
  return info ? { v: o.v, info } : null;
}

export function decodeInfos(raw: unknown): PlayerInfo[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MATCH.maxPlayers).map(decodeInfo).filter((x): x is PlayerInfo => x !== null);
}
