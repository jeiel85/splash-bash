import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getLang, LANGS, pickLang, setLang, STRING_TABLES, t, tList, type StringKey } from '../src/i18n';
import { PLAYER_COLORS } from '../src/config';
import { HAT_IDS, WEAPON_IDS } from '../src/types';
import { lockFailureText } from '../src/ui/menu';
import { roomCodeHint } from '../src/ui/profile';
import { sanitizeName } from '../src/net/protocol';
import { botName } from '../src/game/bots';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const HANGUL = /[ㄱ-ㆎ가-힣]/;

afterEach(() => setLang('en'));

describe('언어 고르기(pickLang)', () => {
  it('?lang= → 저장된 선택 → 브라우저 언어 목록 순, 모르면 영어', () => {
    expect(pickLang('en', 'ko', ['ko-KR'])).toBe('en');
    expect(pickLang(null, 'ko', ['en-US'])).toBe('ko');
    expect(pickLang('xx', 'yy', ['ko-KR', 'en'])).toBe('ko');
    expect(pickLang(null, null, ['fr-FR', 'en-GB', 'ko'])).toBe('en');
    expect(pickLang(null, null, ['ja-JP'])).toBe('en');
    expect(pickLang(undefined, undefined, [])).toBe('en');
  });

  it('브라우저가 아니면(테스트) 영어', () => {
    expect(getLang()).toBe('en');
  });
});

describe('문구 표', () => {
  it('한국어·영어가 같은 키와 같은 자리표시자를 가진다', () => {
    const ko = STRING_TABLES.ko;
    const en = STRING_TABLES.en;
    expect(Object.keys(en).sort()).toEqual(Object.keys(ko).sort());
    for (const key of Object.keys(ko) as StringKey[]) {
      expect(placeholders(en[key]), key).toEqual(placeholders(ko[key]));
      expect(en[key].length > 0 || ko[key].length === 0, key).toBe(true);
    }
  });

  it('영어 문구에는 한글이 없다(한국어로 바꾸는 언어 버튼만 예외)', () => {
    const left = Object.entries(STRING_TABLES.en).filter(([k, v]) => !k.startsWith('menu.lang') && HANGUL.test(v));
    expect(left).toEqual([]);
  });

  it('자리표시자를 채우고, 모르는 자리는 그대로 두고, 없는 키는 예외', () => {
    expect(t('hud.drying', { s: 3 })).toBe('Drying off… 3');
    expect(t('connect.roomFull', { code: 'K7QMX' })).toBe('That room is full (code K7QMX, max {max} players). Try creating another room.');
    expect(() => t('no.such.key' as StringKey)).toThrow();
    setLang('ko');
    expect(t('hud.drying', { s: 3 })).toBe('몸 말리는 중… 3');
  });

  it('코드가 쓰는 모든 키가 표에 있다', () => {
    const known = new Set(Object.keys(STRING_TABLES.ko));
    const namespaces = new Set([...known].map((k) => k.split('.')[0]));
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
    const used = new Set<string>();
    for (const file of walk('src').filter((f) => f.endsWith('.ts') && !f.endsWith('i18n.ts'))) {
      const src = readFileSync(file, 'utf8');
      // t('…') · i18n('…') · tList('…') 와 표에 넘기려고 모아 둔 '이름공간.키' 문자열(조작 안내·연속 기록 등)
      for (const m of src.matchAll(/'([a-z][\w]*\.[\w.]+)'/g)) {
        if (namespaces.has(m[1].split('.')[0])) used.add(m[1]);
      }
    }
    // 아이디로 만드는 키: `hat.${id}`, `weapon.${id}`, `color.${i}`, team.0/1
    for (const h of HAT_IDS) used.add(`hat.${h}`);
    for (const w of [...WEAPON_IDS, 'balloon']) used.add(`weapon.${w}`);
    PLAYER_COLORS.forEach((_, i) => used.add(`color.${i}`));
    used.add('team.0').add('team.1');
    const missing = [...used].filter((k) => !known.has(k));
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(150);
  });
});

describe('언어별 결과', () => {
  it('방 코드 안내·기본 닉네임·봇 이름·잠금 실패 안내가 영어로 나온다', () => {
    expect(roomCodeHint('abc')).toBe('Check the room code (4–8 letters and digits)');
    expect(roomCodeHint('O0O0')).toBe(t('code.confusing'));
    expect(sanitizeName('   ')).toBe('Splasher');
    expect(botName(0)).toBe('Bubbles');
    expect(lockFailureText('failed', false)).toBe(t('lock.failed'));
    expect(lockFailureText('failed', true)).toBe(t('lock.embedded'));
    expect(lockFailureText('unsupported', true)).toBe(t('lock.unsupported'));
  });

  it('처음 닉네임 조합은 두 언어 모두 이름 길이 상한(14자) 안', () => {
    for (const lang of LANGS) {
      setLang(lang);
      for (const a of tList('name.adj')) for (const n of tList('name.noun')) expect(sanitizeName(a + n), lang).toBe(a + n);
      expect(new Set(tList('bot.names')).size, lang).toBe(tList('bot.names').length);
    }
  });
});
