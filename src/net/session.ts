import { Emitter } from '../core/events';
import { NET } from '../config';
import type { MatchState, PeerId, PlayerInfo, PlayerSnapshot } from '../types';
import { ClockOffset } from './interp';
import {
  MSG, decodeBotStates, decodeHello, decodeHits, decodeInfos, decodeMatch, decodeShots, decodeSnapshot, decodeSplash,
  encodeBotStates, encodeHits, encodeInfo, encodeMatch, encodeShots, encodeSnapshot, encodeSplash,
  type MsgType, type NetHit, type NetShot, type NetSplash,
} from './protocol';
import type { Transport } from './transport';

export interface SessionEvents {
  /** 사람 플레이어가 새로 보이거나 정보가 바뀜 */
  playerInfo: (info: PlayerInfo) => void;
  playerLeft: (id: PeerId) => void;
  /** 호스트가 알려 준 봇 목록(전체 교체) */
  botInfos: (infos: PlayerInfo[]) => void;
  snapshot: (id: PeerId, snap: PlayerSnapshot, localT: number) => void;
  shots: (shots: NetShot[], from: PeerId) => void;
  hits: (hits: NetHit[], from: PeerId) => void;
  splash: (ev: NetSplash, from: PeerId) => void;
  match: (m: MatchState, from: PeerId, localT: number) => void;
  hostChanged: (hostId: PeerId, isSelf: boolean) => void;
  error: (message: string) => void;
}

/**
 * 방 세션: 참가자 정보, 호스트 선출, 메시지 인코딩/디코딩, 피어별 시계 보정.
 *
 * 권한 모델(P2P, 서버 없음):
 * - 각 사람은 자기 이동·젖음·쓰러짐의 권한자다(쏜 사람 쪽 명중 판정).
 * - 호스트(가장 먼저 들어온 사람)는 경기 시간·점수·봇을 맡는다. 호스트가 나가면 다음 사람이 이어받는다.
 */
export class Session extends Emitter<SessionEvents> {
  readonly selfId: PeerId;
  private readonly infos = new Map<PeerId, PlayerInfo>();
  private readonly clocks = new Map<PeerId, ClockOffset>();
  private _hostId: PeerId;
  private closed = false;

  constructor(readonly transport: Transport, private selfInfo: PlayerInfo) {
    super();
    this.selfId = transport.selfId;
    this.selfInfo = { ...selfInfo, id: this.selfId };
    this.infos.set(this.selfId, this.selfInfo);
    this._hostId = this.selfId;

    transport.onPeerJoin = (id) => this.sendHello(id);
    transport.onPeerLeave = (id) => {
      this.clocks.delete(id);
      if (this.infos.delete(id)) this.emit('playerLeft', id);
      this.electHost();
    };
    transport.onError = (msg) => this.emit('error', msg);
    transport.onMessage = (type, data, from) => {
      if (this.closed) return;
      try {
        this.handle(type, data, from);
      } catch (err) {
        // 잘못된 메시지 하나가 게임 루프를 죽이지 않도록 격리
        console.warn(`[net] ${type} from ${from} 처리 실패`, err);
      }
    };
  }

  get hostId(): PeerId {
    return this._hostId;
  }

  get isHost(): boolean {
    return this._hostId === this.selfId;
  }

  get online(): boolean {
    return this.transport.online;
  }

  get self(): PlayerInfo {
    return this.selfInfo;
  }

  players(): PlayerInfo[] {
    return [...this.infos.values()];
  }

  info(id: PeerId): PlayerInfo | undefined {
    return this.infos.get(id);
  }

  peerCount(): number {
    return this.transport.peers().length;
  }

  clock(id: PeerId): ClockOffset {
    let c = this.clocks.get(id);
    if (!c) this.clocks.set(id, (c = new ClockOffset()));
    return c;
  }

  updateSelf(patch: Partial<Pick<PlayerInfo, 'name' | 'cosmetics'>>): void {
    this.selfInfo = { ...this.selfInfo, ...patch };
    this.infos.set(this.selfId, this.selfInfo);
    this.sendHello();
  }

  // ---------------------------------------------------------------- send

  sendHello(target?: PeerId): void {
    this.transport.send(MSG.hello, { v: NET.protocol, info: encodeInfo(this.selfInfo) }, target);
  }

  sendState(s: PlayerSnapshot): void {
    this.transport.send(MSG.state, encodeSnapshot(s));
  }

  sendBotStates(list: Array<[PeerId, PlayerSnapshot]>): void {
    if (list.length) this.transport.send(MSG.bots, encodeBotStates(list));
  }

  sendBotInfos(infos: PlayerInfo[], target?: PeerId): void {
    this.transport.send(MSG.botInfo, infos.map(encodeInfo), target);
  }

  sendShots(shots: NetShot[]): void {
    if (shots.length) this.transport.send(MSG.fire, encodeShots(shots));
  }

  sendHits(hits: NetHit[]): void {
    if (hits.length) this.transport.send(MSG.hit, encodeHits(hits));
  }

  sendSplash(ev: NetSplash): void {
    this.transport.send(MSG.splash, encodeSplash(ev));
  }

  sendMatch(m: MatchState, target?: PeerId): void {
    this.transport.send(MSG.match, encodeMatch(m), target);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clear();
    await this.transport.leave();
  }

  // ---------------------------------------------------------------- receive

  private handle(type: MsgType, data: unknown, from: PeerId): void {
    const now = performance.now();
    switch (type) {
      case MSG.hello: {
        const hello = decodeHello(data);
        if (!hello || hello.v !== NET.protocol || hello.info.isBot) return;
        // 보낸 사람 id 는 전송 계층이 보증하는 값을 쓴다(사칭 방지)
        const info: PlayerInfo = { ...hello.info, id: from };
        const isNew = !this.infos.has(from);
        this.infos.set(from, info);
        this.emit('playerInfo', info);
        if (isNew) this.sendHello(from);
        this.electHost();
        return;
      }
      case MSG.state: {
        if (!this.infos.has(from)) return;
        const snap = decodeSnapshot(data);
        if (!snap) return;
        const clock = this.clock(from);
        clock.sample(snap.t, now);
        this.emit('snapshot', from, snap, clock.toLocal(snap.t));
        return;
      }
      case MSG.bots: {
        if (from !== this._hostId) return;
        const clock = this.clock(from);
        for (const [id, snap] of decodeBotStates(data)) {
          clock.sample(snap.t, now);
          this.emit('snapshot', id, snap, clock.toLocal(snap.t));
        }
        return;
      }
      case MSG.botInfo: {
        if (from !== this._hostId) return;
        this.emit('botInfos', decodeInfos(data).map((i) => ({ ...i, isBot: true })));
        return;
      }
      case MSG.fire: {
        // 사람은 자기 발사만, 호스트는 봇 발사도 보낼 수 있다
        const shots = decodeShots(data).filter((s) => s.shooter === from || (from === this._hostId && !this.infos.has(s.shooter)));
        if (shots.length) this.emit('shots', shots, from);
        return;
      }
      case MSG.hit: {
        const hits = decodeHits(data).filter((h) => h.shooter === from || (from === this._hostId && !this.infos.has(h.shooter)));
        if (hits.length) this.emit('hits', hits, from);
        return;
      }
      case MSG.splash: {
        const ev = decodeSplash(data);
        // 쓰러짐은 피해자 권한자(본인, 봇이면 호스트)만 알릴 수 있다
        if (ev && (ev.victim === from || (from === this._hostId && !this.infos.has(ev.victim)))) this.emit('splash', ev, from);
        return;
      }
      case MSG.match: {
        const m = decodeMatch(data);
        if (!m || from !== this._hostId) return;
        this.emit('match', m, from, now);
        return;
      }
    }
  }

  /** 호스트 = (joinedAt, id) 가 가장 작은 사람. 모든 피어가 같은 정보로 같은 결론을 낸다. */
  private electHost(): void {
    let best: PlayerInfo | null = null;
    for (const info of this.infos.values()) {
      if (info.isBot) continue;
      if (!best || info.joinedAt < best.joinedAt || (info.joinedAt === best.joinedAt && info.id < best.id)) best = info;
    }
    const next = best?.id ?? this.selfId;
    if (next !== this._hostId) {
      this._hostId = next;
      this.emit('hostChanged', next, next === this.selfId);
    }
  }
}
