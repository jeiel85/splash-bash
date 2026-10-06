/**
 * 배포 서버 시각으로 맞춘 벽시계. 호스트 선출·정원 판정 순서(PlayerInfo.joinedAt)에 쓴다.
 *
 * 왜: joinedAt 은 각자 보고하는 벽시계라서, 시계가 크게 늦은 기기가 새로 들어오면 가장 먼저 온 사람으로 뽑혀
 *     진행 중인 경기를 초기화했다(#2). 서버가 없는 P2P 게임이지만 페이지를 내려 준 정적 호스트(GitHub Pages·Vite)는
 *     응답마다 Date 헤더를 붙이므로, 같은 출처 HEAD 요청 한 번으로 기기 시계 오차를 약 1초 안으로 줄인다.
 *     실패하면(오프라인·헤더 없음·시간 초과) 기기 시계를 그대로 쓴다 — 고치기 전과 같은 동작.
 *     보정값은 잰 순간의 기기 시계 기준이라, 탭을 열어 둔 사이 NTP 등으로 기기 시계가 바뀌면 틀어진다.
 *     그래서 온라인에 들어갈 때마다 새로 잰다(입장 탐색에 수 초가 걸리므로 HEAD 한 번은 무시할 만하다).
 *     performance.now() 기준으로 붙잡아 두는 방법은 절전 중 멈추는 플랫폼이 있어 쓰지 않는다.
 */

const TIMEOUT_MS = 3000;

let offsetMs = 0;
let pending: Promise<void> | null = null;

/**
 * Date 헤더로 기기 시계 보정값을 구한다.
 * Input: Date 헤더 문자열, 요청 보낸 시각·응답 받은 시각(기기 Date.now)
 * Output: 서버 시각 − 기기 시각(ms), 헤더가 없거나 읽을 수 없으면 null
 * 왜: Date 헤더는 초 단위로 잘려 있어 실제 서버 시각은 [D, D+1000) 안에 있다. 가운데(D+500)를
 *     요청·응답의 중간 시각과 맞춘다(왕복 지연을 반씩 나눔).
 */
export function offsetFromDate(dateHeader: string | null, sentAt: number, receivedAt: number): number | null {
  if (!dateHeader) return null;
  const server = Date.parse(dateHeader);
  if (!Number.isFinite(server)) return null;
  return Math.round(server + 500 - (sentAt + receivedAt) / 2);
}

/** 서버 시각 기준 Date.now(). 아직 맞추지 못했으면 기기 시계 그대로. */
export function serverNow(): number {
  return Date.now() + offsetMs;
}

async function measure(): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // 이번에 못 재면 옛 보정값이 아니라 기기 시계를 쓴다(옛 값은 그사이 바뀐 기기 시계에 맞지 않을 수 있다)
    offsetMs = 0;
    const url = new URL(import.meta.env.BASE_URL, location.href);
    const sentAt = Date.now();
    // 캐시된 응답의 Date 는 옛 시각이라 반드시 서버까지 간다
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store', credentials: 'omit', signal: ctrl.signal });
    const offset = offsetFromDate(res.headers.get('date'), sentAt, Date.now());
    if (offset === null) throw new Error('Date 헤더 없음');
    offsetMs = offset;
    if (Math.abs(offset) > 5000) console.info(`[clock] 기기 시계가 서버보다 ${(offset / 1000).toFixed(1)}초 ${offset > 0 ? '늦어요' : '빨라요'} — 보정해서 씁니다`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 서버 시각을 새로 잰다(재는 중에 또 부르면 같은 요청을 기다린다). 거부하지 않는다.
 * Input: 없음(같은 출처의 BASE_URL 에 HEAD)
 * Output: 끝나면 resolve — 성공하면 serverNow() 가 보정되고, 실패하면 기기 시계 그대로
 * 왜: 온라인 입장 직전에 기다릴 수 있게 Promise 로 돌려준다. 실패는 경고만 남긴다
 *     (게임 진행은 기기 시계로 계속 가능하므로 막지 않는다).
 */
export function syncServerClock(): Promise<void> {
  pending ??= measure()
    .catch((err: unknown) => {
      console.warn('[clock] 서버 시각을 가져오지 못해 기기 시계를 씁니다(호스트 선출이 시계 오차에 민감해짐)', err);
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}
