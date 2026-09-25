import { PLAYER_COLORS } from '../config';
import { HAT_IDS, type Cosmetics, type GameMode } from '../types';
import { sanitizeName } from '../net/protocol';

export interface Settings {
  sensitivity: number;
  /** 전체 음량(마스터) 0..1 — 예전 저장본의 volume 과 같은 뜻이라 이름을 유지한다 */
  volume: number;
  /** 배경 음악 0..1 */
  music: number;
  /** 효과음 0..1 */
  sfx: number;
  fov: number;
  quality: 'low' | 'high';
  invertY: boolean;
  /** 움직임 줄이기(화면 흔들림·통통 튀는 애니메이션 최소화) */
  reduceMotion: boolean;
}

export interface Profile {
  name: string;
  cosmetics: Cosmetics;
  mode: GameMode;
  settings: Settings;
}

const KEY = 'splash-bash:profile:v1';

/** 설정 범위(메뉴 슬라이더와 불러오기 검증이 같은 값을 쓴다) */
export const SETTING_RANGES = {
  sensitivity: { min: 0.2, max: 4, step: 0.05 },
  volume: { min: 0, max: 1, step: 0.05 },
  music: { min: 0, max: 1, step: 0.05 },
  sfx: { min: 0, max: 1, step: 0.05 },
  fov: { min: 60, max: 110, step: 1 },
} as const;

export const DEFAULT_SETTINGS: Settings = {
  sensitivity: 1, volume: 0.7, music: 0.4, sfx: 1, fov: 80, quality: 'high', invertY: false, reduceMotion: false,
};

const ADJ = ['촉촉한', '말랑한', '통통한', '반짝이는', '졸린', '용감한', '수줍은', '신나는'];
const NOUN = ['오리', '물개', '해파리', '올챙이', '수달', '펭귄', '개구리', '고래'];

function randomName(): string {
  return `${ADJ[Math.floor(Math.random() * ADJ.length)]}${NOUN[Math.floor(Math.random() * NOUN.length)]}`;
}

/** 운영체제의 "동작 줄이기" 설정을 처음 기본값으로 따른다 */
function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function defaultSettings(): Settings {
  return { ...DEFAULT_SETTINGS, reduceMotion: prefersReducedMotion() };
}

/**
 * 저장된 설정 조각을 검증해 완전한 Settings 로 만든다. 예전 버전 저장본(music/sfx/reduceMotion 없음)도 받는다.
 */
export function parseSettings(raw: unknown): Settings {
  const d = defaultSettings();
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Settings, unknown>>;
  const R = SETTING_RANGES;
  return {
    sensitivity: clampNum(s.sensitivity, R.sensitivity.min, R.sensitivity.max, d.sensitivity),
    volume: clampNum(s.volume, R.volume.min, R.volume.max, d.volume),
    music: clampNum(s.music, R.music.min, R.music.max, d.music),
    sfx: clampNum(s.sfx, R.sfx.min, R.sfx.max, d.sfx),
    fov: clampNum(s.fov, R.fov.min, R.fov.max, d.fov),
    quality: s.quality === 'low' ? 'low' : s.quality === 'high' ? 'high' : d.quality,
    invertY: s.invertY === true,
    reduceMotion: typeof s.reduceMotion === 'boolean' ? s.reduceMotion : d.reduceMotion,
  };
}

/** 로컬 저장소는 막혀 있을 수 있으므로(시크릿 모드 등) 실패해도 기본값으로 동작한다. */
export function loadProfile(): Profile {
  const fallback: Profile = {
    name: randomName(),
    cosmetics: { color: Math.floor(Math.random() * PLAYER_COLORS.length), hat: 'none' },
    mode: 'ffa',
    settings: defaultSettings(),
  };
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch (err) {
    console.warn('[profile] 저장소를 읽을 수 없어 기본값으로 시작합니다', err);
    return fallback;
  }
  if (!raw) return fallback;
  let p: Partial<Profile>;
  try {
    p = JSON.parse(raw) as Partial<Profile>;
  } catch (err) {
    console.warn('[profile] 저장된 프로필이 손상되어 기본값으로 시작합니다', err);
    return fallback;
  }
  if (!p || typeof p !== 'object') return fallback;
  const color = p.cosmetics?.color;
  return {
    name: sanitizeName(p.name ?? fallback.name),
    cosmetics: {
      color: typeof color === 'number' && Number.isInteger(color) && color >= 0 && color < PLAYER_COLORS.length ? color : fallback.cosmetics.color,
      hat: HAT_IDS.includes(p.cosmetics?.hat as never) ? p.cosmetics!.hat : 'none',
    },
    mode: p.mode === 'tdm' ? 'tdm' : 'ffa',
    settings: parseSettings(p.settings),
  };
}

let saveWarned = false;

export function saveProfile(p: Profile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch (err) {
    // 시크릿 모드·저장소 가득 참 — 게임은 계속하되 한 번만 알린다(다음 방문 때 기본값)
    if (!saveWarned) console.warn('[profile] 프로필을 저장하지 못했습니다', err);
    saveWarned = true;
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

/** URL 해시(#room=CODE)에서 초대 코드를 읽는다 */
export function roomCodeFromHash(hash: string): string | null {
  const m = /room=([A-Za-z0-9]+)/.exec(hash);
  return m ? normalizeRoomCode(m[1]) : null;
}

/** 초대 링크: 현재 주소 + #room=CODE (개발용 ?map= 같은 쿼리는 유지) */
export function inviteLink(code: string): string {
  return `${location.origin}${location.pathname}${location.search}#room=${code}`;
}
