import * as THREE from 'three';

/**
 * 효과음: 외부 파일 없이 WebAudio 로 합성한다(물총 발사, 물 튀김, 풍선 터짐, 점프 등).
 * 위치가 있으면 거리 감쇠 + 좌우 패닝을 적용한다.
 */
export type SfxName =
  | 'pistol' | 'soaker' | 'bucket' | 'throw' | 'burst' | 'impact' | 'hit' | 'hitmark'
  | 'splashed' | 'kill' | 'jump' | 'land' | 'refill' | 'dry' | 'spawn' | 'click' | 'countdown'
  | 'win' | 'jumppad' | 'switch';

export interface PlayOptions {
  volume?: number;
  /** 1 = 기본, 무작위 변화는 자동으로 약간 더해진다 */
  pitch?: number;
  pos?: THREE.Vector3;
}

const MAX_DIST = 40;

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private listenerPos = new THREE.Vector3();
  private listenerRight = new THREE.Vector3(1, 0, 0);
  private _volume = 0.7;
  private lastPlay = new Map<SfxName, number>();

  /** 사용자 입력(클릭) 이후에 호출해야 소리가 난다(브라우저 자동재생 정책) */
  unlock(): void {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this._volume;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  get volume(): number {
    return this._volume;
  }

  set volume(v: number) {
    this._volume = THREE.MathUtils.clamp(v, 0, 1);
    if (this.master) this.master.gain.value = this._volume;
  }

  setListener(pos: THREE.Vector3, yaw: number): void {
    this.listenerPos.copy(pos);
    this.listenerRight.set(Math.cos(yaw), 0, -Math.sin(yaw));
  }

  play(name: SfxName, opts: PlayOptions = {}): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || ctx.state !== 'running') return;
    // 같은 소리가 한 프레임에 여러 번 겹치지 않게
    const now = ctx.currentTime;
    const last = this.lastPlay.get(name) ?? -1;
    if (now - last < 0.025) return;
    this.lastPlay.set(name, now);

    let gain = opts.volume ?? 1;
    let pan = 0;
    if (opts.pos) {
      const d = opts.pos.distanceTo(this.listenerPos);
      if (d > MAX_DIST) return;
      gain *= 1 / (1 + d * 0.18);
      const dir = opts.pos.clone().sub(this.listenerPos).normalize();
      pan = THREE.MathUtils.clamp(dir.dot(this.listenerRight), -1, 1) * 0.8;
    }
    const out = ctx.createGain();
    out.gain.value = gain;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    out.connect(panner).connect(this.master);
    const pitch = (opts.pitch ?? 1) * (0.94 + Math.random() * 0.12);
    this.voice(name, out, now, pitch);
  }

  private voice(name: SfxName, out: GainNode, t: number, p: number): void {
    switch (name) {
      case 'pistol': return this.squirt(out, t, 0.12, 2400 * p, 0.5);
      case 'soaker': return this.squirt(out, t, 0.09, 1700 * p, 0.32);
      case 'bucket': this.squirt(out, t, 0.28, 900 * p, 0.8); return this.tone(out, t, 'sine', 140 * p, 70 * p, 0.2, 0.5);
      case 'throw': return this.tone(out, t, 'sine', 300 * p, 520 * p, 0.12, 0.25);
      case 'burst': this.tone(out, t, 'triangle', 420 * p, 90 * p, 0.12, 0.6); return this.splash(out, t + 0.02, 0.55, 1300 * p, 0.9);
      case 'impact': return this.splash(out, t, 0.1, 2600 * p, 0.12);
      case 'hit': return this.splash(out, t, 0.14, 1800 * p, 0.4);
      case 'hitmark': return this.tone(out, t, 'sine', 1400 * p, 1700 * p, 0.06, 0.28);
      case 'splashed':
        this.splash(out, t, 0.7, 900 * p, 0.9);
        return this.tone(out, t, 'sine', 700 * p, 180 * p, 0.5, 0.45);
      case 'kill':
        this.tone(out, t, 'triangle', 880 * p, 880 * p, 0.09, 0.35);
        return this.tone(out, t + 0.09, 'triangle', 1320 * p, 1320 * p, 0.16, 0.35);
      case 'jump': return this.tone(out, t, 'sine', 260 * p, 620 * p, 0.14, 0.22);
      case 'land': return this.splash(out, t, 0.08, 500 * p, 0.25);
      case 'jumppad': return this.tone(out, t, 'sine', 200 * p, 900 * p, 0.35, 0.4);
      case 'refill': return this.tone(out, t, 'sine', 500 * p + Math.random() * 300, 900 * p, 0.06, 0.12);
      case 'dry': return this.tone(out, t, 'square', 180 * p, 120 * p, 0.08, 0.12);
      case 'spawn':
        this.tone(out, t, 'sine', 520 * p, 520 * p, 0.1, 0.25);
        return this.tone(out, t + 0.1, 'sine', 780 * p, 780 * p, 0.18, 0.25);
      case 'click': return this.tone(out, t, 'sine', 900 * p, 1200 * p, 0.05, 0.2);
      case 'switch': return this.tone(out, t, 'triangle', 600 * p, 700 * p, 0.05, 0.15);
      case 'countdown': return this.tone(out, t, 'sine', 880 * p, 880 * p, 0.15, 0.3);
      case 'win':
        [523, 659, 784, 1047].forEach((f, i) => this.tone(out, t + i * 0.12, 'triangle', f, f, 0.22, 0.3));
        return;
    }
  }

  /** 물총 "칙" — 대역통과 노이즈 + 빠른 감쇠 */
  private squirt(out: AudioNode, t: number, dur: number, freq: number, vol: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(freq, t);
    bp.frequency.exponentialRampToValueAtTime(freq * 0.6, t + dur);
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp).connect(g).connect(out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  /** 물 "철퍽" — 저역통과 노이즈 */
  private splash(out: AudioNode, t: number, dur: number, freq: number, vol: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(freq, t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(80, freq * 0.25), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(lp).connect(g).connect(out);
    src.start(t, Math.random() * 0.4);
    src.stop(t + dur + 0.02);
  }

  private tone(out: AudioNode, t: number, type: OscillatorType, f0: number, f1: number, dur: number, vol: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
}
