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

/**
 * 메뉴 "🎲 랜덤" 버튼: 색·모자를 무작위로 고른다.
 * Input: 지금 꾸미기, 난수 함수(테스트에서 고정값을 넣으려고 주입받는다)
 * Output: 새 꾸미기(원본은 고치지 않는다)
 * 왜: 조합이 8색×7모자=56가지라 그냥 뽑으면 1/56 확률로 지금과 똑같아져 버튼이 고장 난 것처럼 보인다.
 *     그래서 지금 조합을 뺀 55가지 중에서 한 번에 뽑는다(다시 뽑기 반복 없이 항상 1회 난수로 끝남).
 */
export function randomCosmetics(current: Cosmetics, rand: () => number = Math.random): Cosmetics {
  const hats = HAT_IDS.length;
  const total = PLAYER_COLORS.length * hats;
  const cur = current.color * hats + Math.max(0, HAT_IDS.indexOf(current.hat));
  let pick = Math.min(total - 2, Math.floor(rand() * (total - 1)));
  if (pick >= cur) pick++;
  return { color: Math.floor(pick / hats), hat: HAT_IDS[pick % hats] };
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

/**
 * 로컬 저장소는 막혀 있을 수 있으므로(시크릿 모드 등) 실패해도 기본값으로 동작한다.
 * 첫 방문(저장본 없음)·손상·예전 형식이면 정규화한 결과를 바로 저장한다. 그래야 꾸미기를 건드리지 않고
 * 바로 플레이하는 사람도 자동 생성 닉네임·색이 다음 방문에 그대로라서 친구들이 같은 사람으로 알아본다.
 */
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
    // 저장소 자체가 막혔으면 저장도 안 되므로 시도하지 않는다
    console.warn('[profile] 저장소를 읽을 수 없어 기본값으로 시작합니다', err);
    return fallback;
  }
  const profile = parseProfile(raw, fallback);
  if (JSON.stringify(profile) !== raw) saveProfile(profile);
  return profile;
}

function parseProfile(raw: string | null, fallback: Profile): Profile {
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

const ROOM_CODE_MIN = 4;
const ROOM_CODE_MAX = 8;

function roomCodeChars(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function normalizeRoomCode(raw: string): string | null {
  const c = roomCodeChars(raw);
  return c.length >= ROOM_CODE_MIN && c.length <= ROOM_CODE_MAX && [...c].every((ch) => CODE_ALPHABET.includes(ch)) ? c : null;
}

/**
 * normalizeRoomCode 가 거절한 입력에 대한 안내 문구. 코드 알파벳은 헷갈리는 글자(0·1·O·I)를 빼고 만들므로,
 * 그 글자가 들어 있으면 이유를 알려 준다(오타를 알아채도록).
 */
export function roomCodeHint(raw: string): string {
  const c = roomCodeChars(raw);
  if (!c) return '방 코드를 입력해 주세요';
  if ([...c].some((ch) => !CODE_ALPHABET.includes(ch))) return '헷갈리는 글자(0, 1, O, I)는 방 코드에 없어요. 코드를 다시 확인해 주세요';
  return `방 코드를 확인해 주세요 (영문·숫자 ${ROOM_CODE_MIN}~${ROOM_CODE_MAX}자)`;
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
