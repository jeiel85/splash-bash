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
      { appId: NET.appId, password, turnConfig: turnConfigFromEnv() },
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
