import { PLAYER_COLORS } from '../config';
import { HAT_IDS, type Cosmetics, type GameMode } from '../types';
import { sanitizeName } from '../net/protocol';

export interface Settings {
  sensitivity: number;
  volume: number;
  fov: number;
  quality: 'low' | 'high';
  invertY: boolean;
}

export interface Profile {
  name: string;
  cosmetics: Cosmetics;
  mode: GameMode;
  settings: Settings;
}

const KEY = 'splash-bash:profile:v1';

export const DEFAULT_SETTINGS: Settings = { sensitivity: 1, volume: 0.7, fov: 80, quality: 'high', invertY: false };

const ADJ = ['촉촉한', '말랑한', '통통한', '반짝이는', '졸린', '용감한', '수줍은', '신나는'];
const NOUN = ['오리', '물개', '해파리', '올챙이', '수달', '펭귄', '개구리', '고래'];

function randomName(): string {
  return `${ADJ[Math.floor(Math.random() * ADJ.length)]}${NOUN[Math.floor(Math.random() * NOUN.length)]}`;
}

/** 로컬 저장소는 막혀 있을 수 있으므로(시크릿 모드 등) 실패해도 기본값으로 동작한다. */
export function loadProfile(): Profile {
  const fallback: Profile = {
    name: randomName(),
    cosmetics: { color: Math.floor(Math.random() * PLAYER_COLORS.length), hat: 'none' },
    mode: 'ffa',
    settings: { ...DEFAULT_SETTINGS },
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<Profile>;
    const s = { ...DEFAULT_SETTINGS, ...(p.settings ?? {}) };
    return {
      name: sanitizeName(p.name ?? fallback.name),
      cosmetics: {
        color: Number.isInteger(p.cosmetics?.color) && p.cosmetics!.color >= 0 && p.cosmetics!.color < PLAYER_COLORS.length ? p.cosmetics!.color : fallback.cosmetics.color,
        hat: HAT_IDS.includes(p.cosmetics?.hat as never) ? p.cosmetics!.hat : 'none',
      },
      mode: p.mode === 'tdm' ? 'tdm' : 'ffa',
      settings: {
        sensitivity: clampNum(s.sensitivity, 0.2, 4, 1),
        volume: clampNum(s.volume, 0, 1, 0.7),
        fov: clampNum(s.fov, 60, 110, 80),
        quality: s.quality === 'low' ? 'low' : 'high',
        invertY: s.invertY === true,
      },
    };
  } catch {
    return fallback;
  }
}

export function saveProfile(p: Profile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // 저장 실패는 무시(다음 방문 때 기본값)
  }
}

function clampNum(v: unknown, lo: number, hi: number, d: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : d;
  return Math.min(hi, Math.max(lo, n));
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export function normalizeRoomCode(raw: string): string | null {
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length >= 4 && c.length <= 8 && [...c].every((ch) => CODE_ALPHABET.includes(ch)) ? c : null;
}
