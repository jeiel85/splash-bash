/**
 * 사이트 방문자 수. 게임 서버가 없으므로 무료 공개 카운터 API(Abacus, https://v2.jasoncameron.dev/abacus)를 쓴다.
 * - /hit/{ns}/{key}: 1 올리고 새 값을 돌려준다(키가 없으면 0에서 만든다 — Redis INCR)
 * - /get/{ns}/{key}: 값만 읽는다
 * 응답은 { "value": N }. 키는 6개월 동안 한 번도 안 불리면 사라진다(공식 문서).
 */

const COUNTER_BASE = 'https://abacus.jasoncameron.dev';
const COUNTER_NS = 'splash-bash-jeiel85';
const COUNTER_KEY = 'visits';
/** 이 탭(세션)에서 이미 셌는지 — 새로고침마다 올라가지 않게 */
const SESSION_FLAG = 'splash-bash:visit-counted';
const TIMEOUT_MS = 5000;

/**
 * 세어도 되는 환경인지.
 * Input: 배포 빌드 여부(import.meta.env.PROD), 현재 호스트 이름
 * Output: true 면 카운터를 부른다
 * 왜: 개발 서버·E2E·스크린샷 도구(모두 127.0.0.1/localhost)가 실제 방문 수를 부풀리지 않게 막는다.
 *     vite preview 로 배포 빌드를 로컬에서 열어도 호스트 이름으로 한 번 더 거른다.
 */
export function shouldCountVisit(prod: boolean, hostname: string): boolean {
  if (!prod) return false;
  return !(hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost'));
}

/**
 * 카운터 응답 본문 검증.
 * Input: fetch 로 받은 JSON(형식 모름)
 * Output: 0 이상 정수면 그 값, 아니면 null
 * 왜: 외부 서비스라 오류 본문({ error })이나 바뀐 형식이 와도 화면에 NaN·undefined 가 찍히면 안 된다.
 */
export function parseCount(body: unknown): number | null {
  const v = (body as { value?: unknown } | null)?.value;
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** 1234567 → "1,234,567" (Jua 폰트 메뉴에 맞춰 한국식 자릿수 쉼표) */
export function formatCount(n: number): string {
  return n.toLocaleString('ko-KR');
}

function sessionFlag(read: boolean): boolean {
  try {
    if (read) return sessionStorage.getItem(SESSION_FLAG) === '1';
    sessionStorage.setItem(SESSION_FLAG, '1');
  } catch {
    // 저장소가 막힌 환경(시크릿 모드 일부): 매번 센다 — 숫자가 조금 부풀 뿐 게임엔 영향 없음
  }
  return false;
}

/**
 * 방문 수를 가져온다(이 탭에서 처음이면 1 올린다).
 * Input: 없음(환경은 import.meta.env·location 에서 읽음)
 * Output: 방문 수, 셀 수 없는 환경이거나 실패하면 null
 * 왜: 카운터는 장식이라 느리거나 막혀도(광고 차단기·회사망·서비스 중단) 게임 로딩을 절대 막지 않아야 한다.
 *     그래서 5초 제한을 두고, 모든 실패를 null 로 삼켜 메뉴가 카운터 칸을 숨기게 한다.
 *     세션당 한 번만 hit 하는 건 새로고침·방 나가기 후 재방문으로 숫자가 부풀지 않게 하려는 것.
 */
export async function fetchVisitCount(): Promise<number | null> {
  if (!shouldCountVisit(import.meta.env.PROD, location.hostname)) return null;
  const counted = sessionFlag(true);
  const url = `${COUNTER_BASE}/${counted ? 'get' : 'hit'}/${COUNTER_NS}/${COUNTER_KEY}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // 쿠키·리퍼러를 보낼 이유가 없다(카운터는 키 하나만 필요)
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const n = parseCount(await res.json());
    if (n !== null && !counted) sessionFlag(false);
    return n;
  } catch (err) {
    console.warn('[visits] 방문자 수를 가져오지 못했습니다(게임에는 영향 없음)', err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
