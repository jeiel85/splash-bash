import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLAYER_COLORS } from '../src/config';
import { HAT_IDS } from '../src/types';
import { DEFAULT_SETTINGS, loadProfile, normalizeRoomCode, parseSettings, randomCosmetics, roomCodeFromHash, roomCodeHint, saveProfile } from '../src/ui/profile';

describe('설정 불러오기(parseSettings)', () => {
  it('예전 저장본(음악·효과음·움직임 줄이기 없음)은 기존 값을 살리고 새 항목만 기본값', () => {
    const s = parseSettings({ sensitivity: 2.5, volume: 0.3, fov: 95, quality: 'low', invertY: true });
    expect(s).toEqual({ ...DEFAULT_SETTINGS, sensitivity: 2.5, volume: 0.3, fov: 95, quality: 'low', invertY: true });
  });

  it('범위를 벗어나거나 형식이 틀린 값은 잘라내거나 기본값', () => {
    const s = parseSettings({ sensitivity: 99, volume: -1, music: 'loud', sfx: Number.NaN, fov: 10, quality: 'ultra', invertY: 'yes', reduceMotion: 1 });
    expect(s.sensitivity).toBe(4);
    expect(s.volume).toBe(0);
    expect(s.music).toBe(DEFAULT_SETTINGS.music);
    expect(s.sfx).toBe(DEFAULT_SETTINGS.sfx);
    expect(s.fov).toBe(60);
    expect(s.quality).toBe(DEFAULT_SETTINGS.quality);
    expect(s.invertY).toBe(false);
    expect(s.reduceMotion).toBe(DEFAULT_SETTINGS.reduceMotion);
  });

  it('새 항목은 저장된 대로', () => {
    const s = parseSettings({ music: 0, sfx: 0.25, reduceMotion: true });
    expect(s.music).toBe(0);
    expect(s.sfx).toBe(0.25);
    expect(s.reduceMotion).toBe(true);
  });

  it('객체가 아니면 전부 기본값', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('x')).toEqual(DEFAULT_SETTINGS);
  });
});

describe('초대 코드', () => {
  it('URL 해시에서 코드를 읽고 정규화한다', () => {
    expect(roomCodeFromHash('#room=k7qmx')).toBe('K7QMX');
    expect(roomCodeFromHash('#foo&room=ABCDE')).toBe('ABCDE');
    expect(roomCodeFromHash('')).toBeNull();
    // 헷갈리는 글자(I, O, 0, 1)는 코드 알파벳에 없다
    expect(roomCodeFromHash('#room=IO01')).toBeNull();
  });

  it('길이 4~8 만 받는다', () => {
    expect(normalizeRoomCode('abc')).toBeNull();
    expect(normalizeRoomCode(' ab-cd ')).toBe('ABCD');
    expect(normalizeRoomCode('ABCDEFGHJ')).toBeNull();
  });

  it('거절 이유 안내: 헷갈리는 글자(0·1·O·I)는 따로 알려 준다', () => {
    const confusing = '헷갈리는 글자(0, 1, O, I)는 방 코드에 없어요. 코드를 다시 확인해 주세요';
    for (const bad of ['K7QM0', 'k1ab', 'abode', 'pixel', 'O0O0']) {
      expect(normalizeRoomCode(bad)).toBeNull();
      expect(roomCodeHint(bad)).toBe(confusing);
    }
    // 길이가 틀린 경우도 헷갈리는 글자가 있으면 그 이유가 먼저
    expect(roomCodeHint('ABCDEFGHJO')).toBe(confusing);
    expect(roomCodeHint('abc')).toBe('방 코드를 확인해 주세요 (영문·숫자 4~8자)');
    expect(roomCodeHint('ABCDEFGHJK')).toBe('방 코드를 확인해 주세요 (영문·숫자 4~8자)');
    expect(roomCodeHint('  -- ')).toBe('방 코드를 입력해 주세요');
  });
});

describe('프로필 불러오기(loadProfile) — 첫 방문 프로필 고정', () => {
  /** 메모리 localStorage(노드에는 없다) */
  function memoryStorage(initial: Record<string, string> = {}) {
    const m = new Map(Object.entries(initial));
    return {
      map: m,
      getItem: (k: string) => m.get(k) ?? null,
      setItem: vi.fn((k: string, v: string) => void m.set(k, v)),
      removeItem: (k: string) => void m.delete(k),
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('저장본이 없으면 자동 생성한 닉네임·색을 바로 저장해 다음 방문에도 같다(QA: 방문마다 이름·색이 바뀜)', () => {
    const store = memoryStorage();
    vi.stubGlobal('localStorage', store);
    const first = loadProfile();
    expect(store.setItem).toHaveBeenCalledTimes(1);
    // 난수가 달라져도 다시 불러오면 처음 것 그대로
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const second = loadProfile();
    expect(second).toEqual(first);
    // 이미 정규화된 저장본은 다시 쓰지 않는다
    expect(store.setItem).toHaveBeenCalledTimes(1);
  });

  it('손상된 저장본은 새 프로필로 덮어써 고정한다', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = memoryStorage({ 'splash-bash:profile:v1': '{망가진 json' });
    vi.stubGlobal('localStorage', store);
    const p = loadProfile();
    expect(loadProfile()).toEqual(p);
    expect(store.setItem).toHaveBeenCalledTimes(1);
  });

  it('예전 형식(새 설정 항목 없음)은 값을 살린 채 새 형식으로 한 번 저장한다', () => {
    const store = memoryStorage({
      'splash-bash:profile:v1': JSON.stringify({ name: '졸린고래', cosmetics: { color: 2, hat: 'duck' }, mode: 'tdm', settings: { sensitivity: 2, volume: 0.3, fov: 95, quality: 'low', invertY: true } }),
    });
    vi.stubGlobal('localStorage', store);
    const p = loadProfile();
    expect(p.name).toBe('졸린고래');
    expect(p.cosmetics).toEqual({ color: 2, hat: 'duck' });
    expect(p.settings.music).toBe(DEFAULT_SETTINGS.music);
    expect(store.setItem).toHaveBeenCalledTimes(1);
    saveProfile(p);
    expect(loadProfile()).toEqual(p);
  });

  it('저장소를 못 읽으면(시크릿 모드 등) 기본값으로 시작하고 저장을 시도하지 않는다', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem,
    });
    const p = loadProfile();
    expect(p.name.length).toBeGreaterThan(0);
    expect(setItem).not.toHaveBeenCalled();
  });
});

describe('캐릭터 랜덤(randomCosmetics)', () => {
  const combos = PLAYER_COLORS.length * HAT_IDS.length;

  it('어떤 난수가 나와도 지금과 다른, 유효한 조합을 고른다', () => {
    const cur = { color: 3, hat: HAT_IDS[2] };
    // 0 ≤ r < 1 전 구간을 촘촘히 훑는다(끝값 0.999999 포함)
    for (let k = 0; k <= 1000; k++) {
      const r = Math.min(k / 1000, 0.999999);
      const c = randomCosmetics(cur, () => r);
      expect(c.color).toBeGreaterThanOrEqual(0);
      expect(c.color).toBeLessThan(PLAYER_COLORS.length);
      expect(HAT_IDS).toContain(c.hat);
      expect(c.color === cur.color && c.hat === cur.hat).toBe(false);
    }
  });

  it('지금 조합을 뺀 나머지 전부가 고르게 나온다', () => {
    const cur = { color: 0, hat: HAT_IDS[0] };
    const seen = new Map<string, number>();
    for (let i = 0; i < combos - 1; i++) {
      const c = randomCosmetics(cur, () => (i + 0.5) / (combos - 1));
      const k = `${c.color}/${c.hat}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    expect(seen.size).toBe(combos - 1);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
    expect(seen.has(`0/${HAT_IDS[0]}`)).toBe(false);
  });

  it('원본 꾸미기를 고치지 않는다', () => {
    const cur = { color: 7, hat: HAT_IDS[HAT_IDS.length - 1] };
    const copy = { ...cur };
    randomCosmetics(cur, () => 0.5);
    expect(cur).toEqual(copy);
  });
});
