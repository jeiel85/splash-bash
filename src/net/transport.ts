import { joinRoom, selfId, type Room, type JsonValue, type TurnServerConfig } from 'trystero';
import { NET } from '../config';
import { MSG, type MsgType } from './protocol';
import type { PeerId } from '../types';

/**
 * 메시지 전송 계층. 서버 없이 WebRTC P2P(Trystero + 공개 Nostr 릴레이 시그널링)로 연결하거나,
 * 연습 모드처럼 혼자 하는 경우 OfflineTransport 를 쓴다.
 */
export interface Transport {
  readonly selfId: PeerId;
  readonly online: boolean;
  /** target 이 없으면 모든 피어에게 */
  send(type: MsgType, data: unknown, target?: PeerId | PeerId[]): void;
  onMessage: ((type: MsgType, data: unknown, from: PeerId) => void) | null;
  onPeerJoin: ((id: PeerId) => void) | null;
  onPeerLeave: ((id: PeerId) => void) | null;
  /** 시그널링 릴레이 연결 실패 등 */
  onError: ((message: string) => void) | null;
  peers(): PeerId[];
  ping(id: PeerId): Promise<number>;
  leave(): Promise<void>;
}

/**
 * 시그널링용 공개 Nostr 릴레이. 모든 피어가 같은 목록을 써야 서로 만나고, Trystero 는 목록의 모든 릴레이에 붙는다
 * (한두 곳이 죽어도 나머지로 만난다).
 *
 * 명시하는 이유(QA P2-3): 목록을 주지 않으면 Trystero 가 appId 로 기본 목록에서 5곳을 뽑는데, 이 앱에는
 * relay-rpi.edufeed.org(임시 이벤트 거부 — 매 세션 경고)와 staging.yabu.me(스테이징 서버)가 걸려 실제로는 3곳만 믿을 만했다.
 *
 * 검증: 2026-09-26, 개발 PC(Windows 11, Playwright Chromium). 릴레이 하나만 설정한 두 브라우저가 Trystero 방에 들어가
 *   연결 + 메시지 왕복까지 성공한 곳만 골랐다(tools/check-relays.mjs 와 같은 방법). 후보 54곳(Trystero 0.25.4
 *   defaultRelayUrls 28 + 잘 알려진 공개 릴레이 26) × 2회 중 25곳 통과, 그중 연결이 빠르고(1~2.5초) 가입·신뢰망 조건이 없는
 *   6곳을 골라 tools/check-relays.mjs --rounds 2 로 다시 확인(6/6). 탈락 예: 임시 이벤트·종류 차단
 *   (relay-rpi.edufeed.org, relay.nostr.wirednet.jp, relay.nos.social), 신뢰망·NIP-05·가입 요구(offchain.pub,
 *   nostr.einundzwanzig.space, nostr.wine), 속도 제한(relay.damus.io), 무응답(relay.nostr.band 등).
 *   스테이징·시험용(staging.yabu.me, top.testrelay.top)은 통과해도 뺐다.
 *   이전 버전과도 만나도록 예전 자동 선택 중 통과한 3곳(sathoarder·corb·basspistol)을 유지한다.
 * 갱신: `node tools/check-relays.mjs`(이 목록 점검, 4곳 미만 통과면 실패) / `--candidates --rounds 2`(후보 전체).
 *   목록을 바꿀 때는 예전 빌드와도 같은 방에서 만날 수 있게 기존 릴레이를 절반 이상 남긴다.
 */
export const SIGNALING_RELAYS: readonly string[] = [
  'wss://nostr.sathoarder.com',
  'wss://nostr-relay.corb.net',
  'wss://basspistol.org',
  'wss://nostr-01.yakihonne.com',
  'wss://purplerelay.com',
  'wss://bucket.coracle.social',
];

/**
 * TURN 서버 설정(선택). 대칭형 NAT 뒤의 플레이어끼리는 STUN 만으로 연결이 안 될 수 있다.
 * 빌드 시 VITE_TURN_URLS(쉼표 구분), VITE_TURN_USERNAME, VITE_TURN_CREDENTIAL 로 넣는다.
 */
function turnConfigFromEnv(): TurnServerConfig[] | undefined {
  const urls = (import.meta.env.VITE_TURN_URLS as string | undefined)?.split(',').map((s) => s.trim()).filter(Boolean);
  if (!urls?.length) return undefined;
  return [{
    urls,
    username: import.meta.env.VITE_TURN_USERNAME as string | undefined,
    credential: import.meta.env.VITE_TURN_CREDENTIAL as string | undefined,
  }];
}

export class TrysteroTransport implements Transport {
  readonly selfId = selfId;
  readonly online = true;
  onMessage: Transport['onMessage'] = null;
  onPeerJoin: Transport['onPeerJoin'] = null;
  onPeerLeave: Transport['onPeerLeave'] = null;
  onError: Transport['onError'] = null;
  private readonly room: Room;
  private readonly senders = new Map<MsgType, (data: JsonValue, target?: PeerId | PeerId[]) => Promise<void>>();
  private readonly peerSet = new Set<PeerId>();
  private left = false;

  constructor(roomId: string, password?: string) {
    this.room = joinRoom(
      { appId: NET.appId, password, turnConfig: turnConfigFromEnv(), relayConfig: { urls: [...SIGNALING_RELAYS] } },
      roomId,
      { onJoinError: (e) => this.onError?.(`방 참가 오류: ${e.error}`) },
    );
    for (const type of Object.values(MSG)) {
      const action = this.room.makeAction<JsonValue>(type);
      action.onMessage = (data, ctx) => {
        if (!this.left) this.onMessage?.(type, data, ctx.peerId);
      };
      this.senders.set(type, (data, target) => action.send(data, target !== undefined ? { target } : undefined));
    }
    this.room.onPeerJoin = (id) => {
      this.peerSet.add(id);
      this.onPeerJoin?.(id);
    };
    this.room.onPeerLeave = (id) => {
      this.peerSet.delete(id);
      this.onPeerLeave?.(id);
    };
  }

  send(type: MsgType, data: unknown, target?: PeerId | PeerId[]): void {
    if (this.left || this.peerSet.size === 0) return;
    const fn = this.senders.get(type);
    if (!fn) return;
    fn(data as JsonValue, target).catch((err: unknown) => {
      // 피어가 막 떠난 경우 등 — 게임을 멈출 일은 아니므로 경고만 남긴다
      console.warn(`[net] send ${type} 실패`, err);
    });
  }

  peers(): PeerId[] {
    return [...this.peerSet];
  }

  ping(id: PeerId): Promise<number> {
    return this.room.ping(id);
  }

  async leave(): Promise<void> {
    if (this.left) return;
    this.left = true;
    this.peerSet.clear();
    await this.room.leave();
  }
}

/** 네트워크 없이 혼자 플레이(연습 모드). 자신이 곧 호스트. */
export class OfflineTransport implements Transport {
  readonly selfId: PeerId = 'local';
  readonly online = false;
  onMessage: Transport['onMessage'] = null;
  onPeerJoin: Transport['onPeerJoin'] = null;
  onPeerLeave: Transport['onPeerLeave'] = null;
  onError: Transport['onError'] = null;
  send(): void {}
  peers(): PeerId[] {
    return [];
  }
  ping(): Promise<number> {
    return Promise.resolve(0);
  }
  leave(): Promise<void> {
    return Promise.resolve();
  }
}
