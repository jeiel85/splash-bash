import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchVisitCount, formatCount, parseCount, shouldCountVisit } from '../src/ui/visitCounter';

describe('방문자 수 카운터', () => {
  it('배포 빌드 + 실제 주소에서만 센다(개발 서버·E2E·로컬 미리보기는 제외)', () => {
    expect(shouldCountVisit(true, 'jeiel85.github.io')).toBe(true);
    expect(shouldCountVisit(false, 'jeiel85.github.io')).toBe(false);
    expect(shouldCountVisit(true, 'localhost')).toBe(false);
    expect(shouldCountVisit(true, '127.0.0.1')).toBe(false);
    expect(shouldCountVisit(true, '[::1]')).toBe(false);
    expect(shouldCountVisit(true, 'app.localhost')).toBe(false);
  });

  it('응답이 0 이상 정수일 때만 값으로 받는다', () => {
    expect(parseCount({ value: 42 })).toBe(42);
    expect(parseCount({ value: 0 })).toBe(0);
    expect(parseCount({ error: 'Key not found' })).toBeNull();
    expect(parseCount({ value: '42' })).toBeNull();
    expect(parseCount({ value: -1 })).toBeNull();
    expect(parseCount({ value: 1.5 })).toBeNull();
    expect(parseCount({ value: Number.NaN })).toBeNull();
    expect(parseCount(null)).toBeNull();
    expect(parseCount('x')).toBeNull();
  });

  it('천 단위 쉼표', () => {
    expect(formatCount(7)).toBe('7');
    expect(formatCount(1234567)).toBe('1,234,567');
  });
});

describe('fetchVisitCount', () => {
  let store: Map<string, string>;
  const fetchMock = vi.fn();

  beforeEach(() => {
    store = new Map();
    fetchMock.mockReset();
    vi.stubEnv('PROD', true);
    vi.stubGlobal('location', { hostname: 'jeiel85.github.io' });
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const ok = (value: unknown) => ({ ok: true, status: 200, json: async () => value });

  it('탭에서 처음이면 hit(1 올림), 그다음부터는 get(읽기만)', async () => {
    fetchMock.mockResolvedValueOnce(ok({ value: 10 })).mockResolvedValueOnce(ok({ value: 10 }));
    expect(await fetchVisitCount()).toBe(10);
    expect(await fetchVisitCount()).toBe(10);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/hit/');
    expect(String(fetchMock.mock.calls[1][0])).toContain('/get/');
  });

  it('실패하면 null 이고, 다음 번에 다시 hit 한다(못 센 방문을 센 것으로 치지 않음)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('blocked')).mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) }).mockResolvedValueOnce(ok({ value: 3 }));
    expect(await fetchVisitCount()).toBeNull();
    expect(await fetchVisitCount()).toBeNull();
    expect(await fetchVisitCount()).toBe(3);
    expect(fetchMock.mock.calls.every(([u]) => String(u).includes('/hit/'))).toBe(true);
  });

  it('로컬 주소에서는 요청하지 않는다', async () => {
    vi.stubGlobal('location', { hostname: '127.0.0.1' });
    expect(await fetchVisitCount()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
