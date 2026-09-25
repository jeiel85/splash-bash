import type { DamageSource } from '../types';

/**
 * 작은 인라인 SVG 아이콘(킬피드·무기 슬롯·흠뻑 카드). 장난감 물총 느낌: 둥근 모서리 + 진한 잉크 외곽선.
 * 모두 코드에 고정된 문자열이라 innerHTML 로 넣어도 안전하다(사용자 입력 없음).
 */
const INK = '#2B1D4A';
const S = `stroke="${INK}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"`;
const SHINE = 'fill="#fff" opacity="0.75"';

const svg = (body: string) => `<svg viewBox="0 0 40 28" aria-hidden="true" focusable="false">${body}</svg>`;

export const SOURCE_ICONS: Record<DamageSource, string> = {
  // 퐁퐁 권총: 주황 몸통 + 동그란 물통
  pistol: svg(`
    <path d="M10 15h7l-2.4 9.6a2 2 0 0 1-2 1.5H9.8a1.6 1.6 0 0 1-1.6-2z" fill="#FF8A1F" ${S}/>
    <rect x="6" y="9" width="25" height="8" rx="4" fill="#FFA552" ${S}/>
    <rect x="30" y="10.6" width="6.5" height="4.6" rx="1.8" fill="#FFD35C" ${S}/>
    <circle cx="16.5" cy="7.4" r="5" fill="#4FD1E8" ${S}/>
    <ellipse cx="14.8" cy="5.8" rx="1.6" ry="1.1" ${SHINE}/>
    <path d="M17 17.5q1.2 3 3.6 2.4" fill="none" ${S}/>`),
  // 슈퍼 소커: 긴 총열 + 큰 물탱크 + 펌프 손잡이
  soaker: svg(`
    <rect x="5" y="15" width="6" height="10.5" rx="2.6" fill="#FF4F8B" ${S}/>
    <rect x="3" y="10.5" width="33" height="6" rx="3" fill="#FFD23F" ${S}/>
    <rect x="21" y="15.5" width="11" height="4.5" rx="2.2" fill="#FF8A1F" ${S}/>
    <rect x="35" y="11.6" width="3.6" height="3.8" rx="1.3" fill="#19C3A6" ${S}/>
    <rect x="8" y="2.6" width="15" height="8.6" rx="4" fill="#4FD1E8" ${S}/>
    <ellipse cx="12.2" cy="5.4" rx="2.3" ry="1.2" ${SHINE}/>`),
  // 양동이 블래스터: 양동이 + 손잡이 + 옆 주둥이
  bucket: svg(`
    <path d="M9.5 8.5q8.5-9 17 0" fill="none" ${S}/>
    <path d="M28 13.5l8.4-3.2a1.4 1.4 0 0 1 1.9 1.3v4.8a1.4 1.4 0 0 1-1 1.3L28 20.6z" fill="#4FD1E8" ${S}/>
    <path d="M8.3 10.5h19.4l-2.3 13.6a2.6 2.6 0 0 1-2.6 2.2h-9.6a2.6 2.6 0 0 1-2.6-2.2z" fill="#FF7B7B" ${S}/>
    <rect x="6.5" y="7.6" width="23" height="4.6" rx="2.3" fill="#FFD35C" ${S}/>
    <ellipse cx="12.5" cy="16" rx="1.3" ry="3" ${SHINE}/>`),
  // 물풍선: 분홍 풍선 + 매듭 + 끈
  balloon: svg(`
    <path d="M20 27c-1.5-2 1.6-3-.2-5" fill="none" ${S}/>
    <path d="M18.3 21.4l1.7-2 1.7 2z" fill="#FF6F9F" ${S}/>
    <path d="M20 19.4c-5.2 0-8.4-4-8.4-8.4a8.4 8.4 0 0 1 16.8 0c0 4.4-3.2 8.4-8.4 8.4z" fill="#FF9CCB" ${S}/>
    <ellipse cx="16.8" cy="7.8" rx="2.2" ry="1.5" ${SHINE}/>`),
};

/** 물방울(젖음 표시) */
export const DROP_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 2.5C8 8 5.5 11.4 5.5 15a6.5 6.5 0 0 0 13 0c0-3.6-2.5-7-6.5-12.5z" fill="#4FD1E8" ${S}/><ellipse cx="9.6" cy="14" rx="1.4" ry="2.4" ${SHINE}/></svg>`;

export function iconEl(source: DamageSource, cls: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = cls;
  s.innerHTML = SOURCE_ICONS[source];
  return s;
}
