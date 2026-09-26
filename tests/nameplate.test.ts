import { describe, expect, it } from 'vitest';
import { fitNameText, NAME_MAX_TEXT_PX } from '../src/render/billboard';

/** 44px Jua 근사 폭: 한글 한 자 ≈ 36.5px, 아주 넓은 글자(﷽ ≈ 298px, 쐐기문자 ≈ 400px) */
function measure(s: string): number {
  let w = 0;
  for (const ch of s) {
    if (ch === '﷽') w += 298;
    else if (ch === '\u{1242B}') w += 400;
    else if (ch === 'W') w += 44;
    else if (ch === '…') w += 40;
    else w += 36.5;
  }
  return w;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** 캔버스 여백 44px, 높이 68px, 월드 높이 0.34 m (billboard.ts 이름표 규격) */
const worldWidth = (textPx: number) => ((Math.ceil(textPx) + 44) / 68) * 0.34;

describe('이름표 폭 상한(QA: 넓은 글자 닉네임으로 21 m 띠·4000px 텍스처)', () => {
  it('보통 닉네임과 한글 14자는 그대로 그린다', () => {
    expect(fitNameText('말랑한펭귄', measure)).toEqual({ text: '말랑한펭귄', width: measure('말랑한펭귄') });
    const long = '가나다라마바사아자차카타파하';
    expect(fitNameText(long, measure)).toEqual({ text: long, width: measure(long) });
  });

  it('조금 넘으면 글자는 그대로 두고 폭만 상한으로(가로로 좁혀 그림)', () => {
    const w14 = 'W'.repeat(14);
    const fit = fitNameText(w14, measure);
    expect(fit.text).toBe(w14);
    expect(fit.width).toBe(NAME_MAX_TEXT_PX);
  });

  it('아주 넓은 글자는 말줄임하고 폭·월드 크기가 상한을 넘지 않는다', () => {
    const wide = '﷽'.repeat(14);
    expect(worldWidth(measure(wide))).toBeGreaterThan(20);
    const fit = fitNameText(wide, measure);
    expect(fit.text.endsWith('…')).toBe(true);
    expect(fit.text.length).toBeLessThan(wide.length);
    expect(fit.width).toBeLessThanOrEqual(NAME_MAX_TEXT_PX);
    // 너무 좁히지 않도록 말줄임한 글자는 상한의 1/0.6 안
    expect(measure(fit.text)).toBeLessThanOrEqual(NAME_MAX_TEXT_PX / 0.6);
    expect(worldWidth(fit.width)).toBeLessThan(3.1);
  });

  it('서로게이트 쌍(쐐기문자 등)을 반으로 자르지 않는다', () => {
    const cune = '\u{1242B}'.repeat(7);
    const fit = fitNameText(cune, measure);
    expect(fit.text.endsWith('…')).toBe(true);
    expect(LONE_SURROGATE.test(fit.text)).toBe(false);
    expect(fit.width).toBeLessThanOrEqual(NAME_MAX_TEXT_PX);
  });

  it('한 글자도 상한보다 넓으면 첫 글자 + 말줄임을 좁혀 그린다', () => {
    const fit = fitNameText('\u{1242B}\u{1242B}', measure, 200);
    expect(fit.text).toBe('\u{1242B}…');
    expect(fit.width).toBe(200);
  });
});
