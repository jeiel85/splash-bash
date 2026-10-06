import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { offsetFromDate } from '../src/net/serverClock';

describe('offsetFromDate', () => {
  const D = 'Tue, 06 Oct 2026 03:00:00 GMT';
  const server = Date.parse(D);

  it('초 단위 Date 의 가운데(+500ms)를 요청·응답 중간 시각에 맞춘다', () => {
    // 기기 시계가 정확하고 왕복 200ms
    expect(offsetFromDate(D, server + 400, server + 600)).toBe(0);
  });

  it('기기 시계가 늦으면 양수, 빠르면 음수', () => {
    expect(offsetFromDate(D, server - 60_000, server - 60_000)).toBe(60_500);
    expect(offsetFromDate(D, server + 3_600_000, server + 3_600_000)).toBe(-3_599_500);
  });

  it('헤더가 없거나 읽을 수 없으면 null', () => {
    expect(offsetFromDate(null, 0, 0)).toBeNull();
    expect(offsetFromDate('', 0, 0)).toBeNull();
    expect(offsetFromDate('not a date', 0, 0)).toBeNull();
  });
});

describe('syncServerClock / serverNow', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('location', { href: 'https://jeiel85.github.io/splash-bash/' });
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-10-06T03:00:00.500Z'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const dateResponse = (date: string | null) => ({ headers: new Headers(date ? { date } : {}) });

  it('서버 시각에 맞추면 serverNow 가 그만큼 보정된다(기기 시계 2분 늦음)', async () => {
    fetchMock.mockResolvedValue(dateResponse('Tue, 06 Oct 2026 03:02:00 GMT'));
    const clock = await import('../src/net/serverClock');
    expect(clock.serverNow()).toBe(Date.now());
    await clock.syncServerClock();
    expect(clock.serverNow() - Date.now()).toBe(120_000);
    // 같은 출처, 캐시 없이 HEAD
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe('https://jeiel85.github.io/');
    expect(init).toMatchObject({ method: 'HEAD', cache: 'no-store' });
  });

  it('재는 중에 또 부르면 요청은 하나, 끝난 뒤 부르면 새로 잰다', async () => {
    fetchMock.mockResolvedValue(dateResponse('Tue, 06 Oct 2026 03:00:00 GMT'));
    const clock = await import('../src/net/serverClock');
    await Promise.all([clock.syncServerClock(), clock.syncServerClock()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await clock.syncServerClock();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('기기 시계가 바뀐 뒤 다시 재면 새 보정값을 쓴다(옛 보정값을 더하지 않음)', async () => {
    fetchMock.mockResolvedValue(dateResponse('Tue, 06 Oct 2026 03:02:00 GMT'));
    const clock = await import('../src/net/serverClock');
    await clock.syncServerClock();
    expect(clock.serverNow() - Date.now()).toBe(120_000);
    // NTP 가 기기 시계를 2분 앞으로 고침
    vi.setSystemTime(Date.now() + 120_000);
    await clock.syncServerClock();
    expect(clock.serverNow() - Date.now()).toBe(0);
  });

  it('실패하면 기기 시계를 쓴다(거부하지 않음, 옛 보정값도 버림)', async () => {
    fetchMock.mockResolvedValueOnce(dateResponse('Tue, 06 Oct 2026 02:59:50 GMT'));
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fetchMock.mockResolvedValueOnce(dateResponse(null));
    const clock = await import('../src/net/serverClock');
    await clock.syncServerClock();
    expect(clock.serverNow() - Date.now()).toBe(-10_000);
    await expect(clock.syncServerClock()).resolves.toBeUndefined();
    expect(clock.serverNow()).toBe(Date.now());
    await clock.syncServerClock(); // Date 헤더 없음
    expect(clock.serverNow()).toBe(Date.now());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it('응답이 3초 안에 오지 않으면 포기한다', async () => {
    fetchMock.mockImplementation((_url: URL, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const clock = await import('../src/net/serverClock');
    const done = clock.syncServerClock();
    await vi.advanceTimersByTimeAsync(3000);
    await expect(done).resolves.toBeUndefined();
    expect(clock.serverNow()).toBe(Date.now());
  });
});
