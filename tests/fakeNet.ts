/**
 * 메모리 안에서 여러 Transport 를 잇는 가짜 네트워크(단위 테스트용).
 *
 * Trystero 와 같은 성질을 흉내 낸다.
 * - 연결이 활성화되면 양쪽에 onPeerJoin, 끊기면 onPeerLeave.
 * - 한 피어 쌍 사이의 메시지는 보낸 순서대로 도착한다(순서 보장 데이터 채널).
 * - 데이터는 JSON 으로 직렬화된다(NaN → null, undefined 필드 사라짐).
 * - 받는 쪽 onMessage 가 아직 없으면(세션 생성 전, 방 탐색 중) 메시지는 사라진다.
 *
 * 배달은 비동기 대기열이며 flush() 로 전부 배달한다(결정적).
 */
import type { MsgType } from '../src/net/protocol';
import type { Transport } from '../src/net/transport';
import type { PeerId } from '../src/types';

interface Packet {
  from: PeerId;
  to: PeerId;
  type: MsgType;
  json: string;
}

export interface SentRecord {
  from: PeerId;
  to: PeerId;
  type: MsgType;
  data: unknown;
}

export class FakeHub {
  private readonly nodes = new Map<PeerId, FakeTransport>();
  private readonly links = new Set<string>();
  private queue: Packet[] = [];
  /** 보낸 메시지 기록(배달 여부와 무관) */
  readonly sent: SentRecord[] = [];
  /**
   * true 면 연결이 끊긴 뒤에도 이미 보낸(대기열의) 메시지를 배달한다.
   * 실제로는 전송 계층이 막아 주지만, 세션이 늦은 메시지를 스스로 걸러 내는지 시험할 때 쓴다.
   */
  deliverAfterLeave = false;

  add(id: PeerId): FakeTransport {
    if (this.nodes.has(id)) throw new Error(`중복 id ${id}`);
    const t = new FakeTransport(this, id);
    this.nodes.set(id, t);
    return t;
  }

  node(id: PeerId): FakeTransport {
    const t = this.nodes.get(id);
    if (!t) throw new Error(`없는 id ${id}`);
    return t;
  }

  private key(a: PeerId, b: PeerId): string {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  linked(a: PeerId, b: PeerId): boolean {
    return this.links.has(this.key(a, b));
  }

  /** a-b 연결 활성화 → 양쪽 onPeerJoin */
  connect(a: PeerId, b: PeerId): void {
    if (a === b || this.linked(a, b)) return;
    const ta = this.node(a);
    const tb = this.node(b);
    if (ta.isLeft || tb.isLeft) return;
    this.links.add(this.key(a, b));
    ta.onPeerJoin?.(b);
    tb.onPeerJoin?.(a);
  }

  /** 주어진(없으면 모든) 노드를 서로 전부 연결 */
  connectAll(ids: PeerId[] = [...this.nodes.keys()]): void {
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) this.connect(ids[i], ids[j]);
  }

  /** a-b 연결 끊김 → 양쪽 onPeerLeave */
  disconnect(a: PeerId, b: PeerId): void {
    if (!this.links.delete(this.key(a, b))) return;
    if (!this.deliverAfterLeave) this.queue = this.queue.filter((p) => !((p.from === a && p.to === b) || (p.from === b && p.to === a)));
    this.node(a).onPeerLeave?.(b);
    this.node(b).onPeerLeave?.(a);
  }

  /** 노드가 방을 떠남(탭 닫힘) */
  remove(id: PeerId): void {
    for (const other of this.nodes.keys()) if (other !== id) this.disconnect(id, other);
    this.node(id).isLeft = true;
  }

  peersOf(id: PeerId): PeerId[] {
    return [...this.nodes.keys()].filter((o) => o !== id && this.linked(id, o));
  }

  enqueue(from: PeerId, type: MsgType, data: unknown, target?: PeerId | PeerId[]): void {
    const targets = target === undefined ? this.peersOf(from) : Array.isArray(target) ? target : [target];
    const json = JSON.stringify(data);
    for (const to of targets) {
      if (!this.linked(from, to)) continue;
      this.sent.push({ from, to, type, data: JSON.parse(json) });
      this.queue.push({ from, to, type, json });
    }
  }

  /** 대기열이 빌 때까지 배달(배달 중 새로 보낸 메시지도 포함). @returns 배달한 수 */
  flush(maxRounds = 10_000): number {
    let n = 0;
    while (this.queue.length) {
      if (++n > maxRounds) throw new Error('flush: 메시지가 끝없이 오간다(무한 핑퐁?)');
      const p = this.queue.shift()!;
      if (!this.deliverAfterLeave && !this.linked(p.from, p.to)) continue;
      const to = this.nodes.get(p.to);
      if (!to || to.isLeft) continue;
      to.onMessage?.(p.type, JSON.parse(p.json), p.from);
    }
    return n;
  }

  /** 대기열에 있는 메시지 종류(순서대로) — 순서 검증용 */
  pending(to?: PeerId): Array<{ from: PeerId; to: PeerId; type: MsgType }> {
    return this.queue.filter((p) => to === undefined || p.to === to).map(({ from, to: t, type }) => ({ from, to: t, type }));
  }
}

export class FakeTransport implements Transport {
  readonly online = true;
  onMessage: Transport['onMessage'] = null;
  onPeerJoin: Transport['onPeerJoin'] = null;
  onPeerLeave: Transport['onPeerLeave'] = null;
  onError: Transport['onError'] = null;
  isLeft = false;

  constructor(private readonly hub: FakeHub, readonly selfId: PeerId) {}

  send(type: MsgType, data: unknown, target?: PeerId | PeerId[]): void {
    if (this.isLeft) return;
    this.hub.enqueue(this.selfId, type, data, target);
  }

  peers(): PeerId[] {
    return this.hub.peersOf(this.selfId);
  }

  ping(): Promise<number> {
    return Promise.resolve(1);
  }

  leave(): Promise<void> {
    if (!this.isLeft) this.hub.remove(this.selfId);
    return Promise.resolve();
  }
}
