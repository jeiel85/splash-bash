import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeRoomCode, parseSettings, roomCodeFromHash } from '../src/ui/profile';

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
});
