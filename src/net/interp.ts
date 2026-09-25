import type { PlayerSnapshot } from '../types';

/**
 * 피어별 시계 오프셋 추정. offset ≈ (내 수신 시각 − 보낸 쪽 시각).
 * 빠르게 도착한 패킷(작은 값)은 즉시 반영하고, 큰 값은 천천히 따라가서 지터에 둔감하게 만든다.
 */
export class ClockOffset {
  private offset: number | null = null;

  sample(senderT: number, localT: number): void {
    const o = localT - senderT;
    if (this.offset === null || o < this.offset) this.offset = o;
    else this.offset += (o - this.offset) * 0.02;
  }

  /** 보낸 쪽 시각 → 내 시각 */
  toLocal(senderT: number): number {
    return senderT + (this.offset ?? 0);
  }

  get ready(): boolean {
    return this.offset !== null;
  }
}

export interface InterpState {
  px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  yaw: number; pitch: number;
  snap: PlayerSnapshot;
}

const MAX_EXTRAPOLATE_MS = 200;
const CAPACITY = 32;

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** 원격 엔티티 스냅샷 버퍼 — interpDelay 만큼 과거를 보간해서 부드럽게 보여 준다. */
export class SnapshotBuffer {
  /** 로컬 시각으로 변환된 시각 순서 */
  private readonly items: Array<{ t: number; s: PlayerSnapshot }> = [];

  push(localT: number, s: PlayerSnapshot): void {
    const last = this.items[this.items.length - 1];
    if (last && localT <= last.t) {
      // 순서가 뒤바뀐/중복 패킷은 버린다(리스폰 순간이동은 보낸 쪽 t 가 증가하므로 해당 없음)
      return;
    }
    this.items.push({ t: localT, s });
    if (this.items.length > CAPACITY) this.items.shift();
  }

  get latest(): PlayerSnapshot | null {
    return this.items.length ? this.items[this.items.length - 1].s : null;
  }

  clear(): void {
    this.items.length = 0;
  }

  /** renderT(로컬 시각) 시점의 상태. 데이터가 없으면 false */
  sample(renderT: number, out: InterpState): boolean {
    const n = this.items.length;
    if (n === 0) return false;
    const first = this.items[0];
    if (renderT <= first.t || n === 1) {
      return this.write(out, first.s, first.s, 0, n === 1 ? Math.min(renderT - first.t, MAX_EXTRAPOLATE_MS) : 0);
    }
    for (let i = n - 1; i > 0; i--) {
      const a = this.items[i - 1];
      const b = this.items[i];
      if (renderT >= a.t && renderT <= b.t) {
        // 죽음/리스폰 경계에서는 보간하지 않고 끊어서 보여 준다
        if (a.s.alive !== b.s.alive) return this.write(out, b.s, b.s, 0, 0);
        const k = (renderT - a.t) / Math.max(1, b.t - a.t);
        return this.write(out, a.s, b.s, k, 0);
      }
    }
    const last = this.items[n - 1];
    return this.write(out, last.s, last.s, 0, Math.min(renderT - last.t, MAX_EXTRAPOLATE_MS));
  }

  private write(out: InterpState, a: PlayerSnapshot, b: PlayerSnapshot, k: number, extrapolateMs: number): boolean {
    const e = Math.max(0, extrapolateMs) / 1000;
    out.px = a.px + (b.px - a.px) * k + b.vx * e;
    out.py = a.py + (b.py - a.py) * k + (b.grounded ? 0 : b.vy * e);
    out.pz = a.pz + (b.pz - a.pz) * k + b.vz * e;
    out.vx = a.vx + (b.vx - a.vx) * k;
    out.vy = a.vy + (b.vy - a.vy) * k;
    out.vz = a.vz + (b.vz - a.vz) * k;
    out.yaw = lerpAngle(a.yaw, b.yaw, k);
    out.pitch = a.pitch + (b.pitch - a.pitch) * k;
    out.snap = k < 0.5 ? a : b;
    return true;
  }
}
