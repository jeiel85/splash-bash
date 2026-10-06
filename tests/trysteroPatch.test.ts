import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * tools/patch-deps.mjs 가 고친 Trystero 재조립(action-wire)을 직접 시험한다(#1).
 * 패치가 빠진 채(postinstall 미실행·버전 변경) 배포되지 않도록 CI 에서도 돈다.
 */
const WIRE_PATH = '../node_modules/@trystero-p2p/core/dist/action-wire.mjs';

interface Wire {
  makeInternalAction(type: string): {
    send(data: unknown, targets?: string | string[]): Promise<unknown>;
    onMessage(f: (payload: unknown, peerId: string) => void): void;
  };
  handleData(id: string, data: ArrayBuffer): void;
  clearPeer(id: string): void;
}

// eslint 없음: 타입 선언이 없는 배포 파일이라 any 로 받아 Wire 로 좁힌다
const { createActionWireManager } = (await import(/* @vite-ignore */ WIRE_PATH)) as {
  createActionWireManager(opts: object): Wire;
};

const CHUNK = 16 * 1024;
const HEADER = 36;

function receiver(): Wire {
  return createActionWireManager({
    getPeer: () => undefined,
    getPeerIds: () => [],
    canReceiveFromPeer: () => true,
    throwIfAborted: () => {},
  });
}

/** 진짜 송신 코드로 청크를 만들어 받는 쪽에 넘긴다(정상 메시지) */
async function sendVia(to: Wire, from: string, type: string, data: unknown): Promise<void> {
  const chunks: Uint8Array[] = [];
  // 송신 코드는 청크마다 같은 피어 객체인지 확인한다
  const peer = { channel: undefined, sendData: (c: Uint8Array) => chunks.push(c) };
  const sender = createActionWireManager({
    getPeer: (id: string) => (id === 'rx' ? peer : undefined),
    getPeerIds: () => ['rx'],
    canReceiveFromPeer: () => true,
    throwIfAborted: () => {},
  });
  await sender.makeInternalAction(type).send(data, 'rx');
  for (const c of chunks) to.handleData(from, c.slice().buffer);
}

/** 공격자가 손으로 만든 청크(JSON 텍스트 조각) */
function rawChunk(type: string, nonce: number, last: boolean, text: string): ArrayBuffer {
  const body = new TextEncoder().encode(text);
  const c = new Uint8Array(HEADER + body.byteLength);
  c.set(new TextEncoder().encode(type));
  c[32] = nonce >> 8;
  c[33] = nonce & 255;
  c[34] = (last ? 1 : 0) | 8; // JSON
  c[35] = last ? 255 : 0;
  c.set(body, HEADER);
  return c.buffer;
}

describe('Trystero 재조립 패치 (#1)', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('패치가 적용되어 있다(postinstall: tools/patch-deps.mjs)', () => {
    const src = readFileSync(new URL(WIRE_PATH, import.meta.url), 'utf8');
    expect(src).toContain('splash-bash patch (#1)');
  });

  it('여러 청크로 나뉜 정상 메시지는 그대로 받는다', async () => {
    const rx = receiver();
    const got: unknown[] = [];
    rx.makeInternalAction('state').onMessage((p) => got.push(p));
    const big = { s: 'x'.repeat(40_000), n: 7 };
    await sendVia(rx, 'A', 'state', big);
    await sendVia(rx, 'A', 'state', { n: 8 });
    expect(got).toEqual([big, { n: 8 }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('약 64KB 를 넘는 메시지는 버리고, 같은 피어의 다음 메시지는 받는다', async () => {
    const rx = receiver();
    const got: unknown[] = [];
    rx.makeInternalAction('state').onMessage((p) => got.push(p));
    await sendVia(rx, 'A', 'state', { s: 'x'.repeat(100_000) });
    await sendVia(rx, 'A', 'state', { ok: 1 });
    expect(got).toEqual([{ ok: 1 }]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('등록하지 않은 action 은 쌓아 두지 않는다(나중에 등록해도 옛 페이로드가 오지 않음)', async () => {
    const rx = receiver();
    await sendVia(rx, 'A', 'ghost', { a: 1 });
    const got: unknown[] = [];
    rx.makeInternalAction('ghost').onMessage((p) => got.push(p));
    expect(got).toEqual([]);
    await sendVia(rx, 'A', 'ghost', { a: 2 });
    expect(got).toEqual([{ a: 2 }]);
  });

  it('끝나지 않는 청크를 수천 개 보내도 피어당 약 256KB 까지만 붙잡는다', () => {
    const rx = receiver();
    const got: unknown[] = [];
    rx.makeInternalAction('state').onMessage((p) => got.push(p));
    const filler = `"${'x'.repeat(CHUNK - HEADER - 1)}`;
    const N = 2000; // 약 32MB
    for (let n = 0; n < N; n++) rx.handleData('A', rawChunk('state', n, false, filler));
    // 모두 마무리해 보면 붙잡고 있던 메시지만 완성된다
    for (let n = 0; n < N; n++) rx.handleData('A', rawChunk('state', n, true, '"'));
    expect(got.length).toBeGreaterThan(0);
    expect(got.length * CHUNK).toBeLessThanOrEqual(256 * 1024);
    // 다른 피어는 영향 없음
    const fromB: unknown[] = [];
    rx.makeInternalAction('hit').onMessage((p, id) => fromB.push([id, p]));
    rx.handleData('B', rawChunk('hit', 0, true, '{"b":1}'));
    expect(fromB).toEqual([['B', { b: 1 }]]);
  });

  it('피어가 떠나면(clearPeer) 그 피어의 대기 데이터 계산도 초기화된다', () => {
    const rx = receiver();
    const got: unknown[] = [];
    rx.makeInternalAction('state').onMessage((p) => got.push(p));
    const filler = `"${'x'.repeat(CHUNK - HEADER - 1)}`;
    for (let n = 0; n < 5000; n++) rx.handleData('A', rawChunk('state', n, false, filler));
    rx.handleData('A', rawChunk('state', 60000, true, '{"before":1}'));
    expect(got).toEqual([]); // 상한에 걸려 새 메시지도 못 받는 상태
    rx.clearPeer('A');
    rx.handleData('A', rawChunk('state', 60001, true, '{"after":1}'));
    expect(got).toEqual([{ after: 1 }]);
  });

  it('깨진 JSON 은 예외 없이 버린다', () => {
    const rx = receiver();
    const got: unknown[] = [];
    rx.makeInternalAction('state').onMessage((p) => got.push(p));
    expect(() => rx.handleData('A', rawChunk('state', 1, true, '{"a":'))).not.toThrow();
    rx.handleData('A', rawChunk('state', 2, true, '{"a":2}'));
    expect(got).toEqual([{ a: 2 }]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
