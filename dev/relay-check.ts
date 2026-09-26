/**
 * 시그널링 릴레이 점검 페이지. tools/check-relays.mjs 가 브라우저 컨텍스트 두 개(= 두 플레이어)로 열어
 * 릴레이 하나만 설정한 Trystero 방에서 연결 + 메시지 왕복이 되는지 확인한다.
 * 게임과 같은 Trystero 빌드·같은 이벤트 종류(임시 이벤트 20000번대)를 쓰므로 게임에서의 동작과 같다.
 */
import { defaultRelayUrls, joinRoom, type Room } from 'trystero';
import { SIGNALING_RELAYS } from '../src/net/transport';

interface RelayResult {
  ok: boolean;
  /** 실패 이유(timeout, joinError …) */
  reason?: string;
  /** 상대가 들어온 시각(ms, 시작 기준) */
  joinedMs?: number;
  ms: number;
  /** Trystero 가 남긴 릴레이 경고(거부 사유 등) */
  warnings: string[];
}

declare global {
  interface Window {
    __ready?: boolean;
    relayCheck: {
      configured: readonly string[];
      trysteroDefaults: readonly string[];
      /** role 'a' 는 상대가 오면 ping 을 보내고 pong 을 기다린다, 'b' 는 ping 에 pong 으로 답한다 */
      run(url: string, appId: string, roomId: string, role: 'a' | 'b', timeoutMs: number): Promise<RelayResult>;
    };
  }
}

const warnings: string[] = [];
const origWarn = console.warn.bind(console);
console.warn = (...a: unknown[]) => {
  warnings.push(a.map(String).join(' '));
  origWarn(...a);
};

function run(url: string, appId: string, roomId: string, role: 'a' | 'b', timeoutMs: number): Promise<RelayResult> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let room: Room | null = null;
    let joinedMs: number | undefined;
    let done = false;
    const finish = (r: Omit<RelayResult, 'ms' | 'warnings' | 'joinedMs'>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // b 는 a 가 pong 을 받을 시간을 조금 주고 나간다
      setTimeout(() => void room?.leave().catch(() => undefined), role === 'b' ? 1500 : 0);
      resolve({ ...r, joinedMs, ms: Math.round(performance.now() - t0), warnings: [...warnings] });
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
    room = joinRoom({ appId, relayConfig: { urls: [url] } }, roomId, { onJoinError: (e) => finish({ ok: false, reason: `joinError ${e.error}` }) });
    const ping = room.makeAction<{ t: number }>('ping');
    const pong = room.makeAction<{ t: number }>('pong');
    room.onPeerJoin = (id) => {
      joinedMs = Math.round(performance.now() - t0);
      if (role === 'a') void ping.send({ t: Date.now() }, { target: id });
    };
    ping.onMessage = (data, ctx) => {
      if (role !== 'b') return;
      void pong.send(data, { target: ctx.peerId });
      finish({ ok: true });
    };
    pong.onMessage = () => {
      if (role === 'a') finish({ ok: true });
    };
  });
}

window.relayCheck = { configured: SIGNALING_RELAYS, trysteroDefaults: defaultRelayUrls, run };
window.__ready = true;
