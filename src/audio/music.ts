import { mulberry32 } from '../core/rng';

/**
 * 배경 음악: 파일 없이 WebAudio 로 합성하는 경쾌한 루프(마림바 멜로디 + 우쿨렐레 반주 + 베이스 + 가벼운 타악기).
 * 4마디 코드 진행 위에 시드 난수로 만든 멜로디를 두 번씩 반복하고(AABB), 프레이즈마다 새 멜로디를 만든다.
 * 미리보기(lookahead) 스케줄러로 AudioContext 시계에 음을 예약한다.
 */

const BPM = 104;
const STEP = 60 / BPM / 4; // 16분음표
const STEPS_PER_BAR = 16;
const BARS = 4;
const LOOKAHEAD = 0.3;
const TICK_MS = 60;

/** 코드: 근음(MIDI) + 3화음 */
interface Chord { root: number; tones: [number, number, number] }
const C: Chord = { root: 48, tones: [60, 64, 67] };
const G: Chord = { root: 43, tones: [55, 59, 62] };
const AM: Chord = { root: 45, tones: [57, 60, 64] };
const F: Chord = { root: 41, tones: [53, 57, 60] };
const PROGRESSIONS: Chord[][] = [
  [C, AM, F, G],
  [C, G, AM, F],
];
/** C 장조 펜타토닉(멜로디 경과음) */
const PENTA = [72, 74, 76, 79, 81, 84, 86, 88];

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

interface Note { step: number; midi: number; len: number }

export class MusicBox {
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextTime = 0;
  private step = 0;
  private phrase = 0;
  private melody: Note[] = [];
  private readonly rnd = mulberry32(20260925);
  private readonly comp: BiquadFilterNode;

  constructor(private readonly ctx: AudioContext, private readonly out: AudioNode, private readonly noise: AudioBuffer) {
    this.comp = ctx.createBiquadFilter();
    this.comp.type = 'lowpass';
    this.comp.frequency.value = 2400;
    this.comp.connect(out);
  }

  get playing(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    this.step = 0;
    this.phrase = 0;
    this.melody = this.makeMelody();
    this.nextTime = this.ctx.currentTime + 0.15;
    this.timer = setInterval(() => this.schedule(), TICK_MS);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    const ctx = this.ctx;
    if (ctx.state !== 'running') return;
    // 탭이 가려져 타이머가 늦게 돌았으면 밀린 음은 버리고 지금부터 다시 맞춘다
    if (this.nextTime < ctx.currentTime - 0.05) this.nextTime = ctx.currentTime + 0.05;
    while (this.nextTime < ctx.currentTime + LOOKAHEAD) {
      this.playStep(this.step, this.nextTime);
      this.nextTime += STEP;
      this.step++;
      if (this.step >= STEPS_PER_BAR * BARS) {
        this.step = 0;
        this.phrase++;
        // AABB: 같은 멜로디를 두 번 들려준 뒤 새로 만든다
        if (this.phrase % 2 === 0) this.melody = this.makeMelody();
      }
    }
  }

  private progression(): Chord[] {
    return PROGRESSIONS[Math.floor(this.phrase / 2) % PROGRESSIONS.length];
  }

  private playStep(step: number, t: number): void {
    const bar = Math.floor(step / STEPS_PER_BAR);
    const inBar = step % STEPS_PER_BAR;
    const chord = this.progression()[bar];
    // 타악기: 1·3박 쿵, 2·4박 짝, 8분 셰이커
    if (inBar === 0 || inBar === 8) this.kick(t);
    if (inBar === 4 || inBar === 12) this.snap(t);
    if (inBar % 2 === 0) this.shaker(t, inBar % 4 === 2 ? 0.022 : 0.012);
    // 베이스: 1박 근음, 3박 5도, 4박 뒤 경과음
    if (inBar === 0) this.bass(t, chord.root, STEP * 5);
    if (inBar === 8) this.bass(t, chord.root + 7, STEP * 3);
    if (inBar === 14) this.bass(t, chord.root + 12, STEP * 2);
    // 반주: 엇박 스트럼(2·4박 뒤)
    if (inBar === 6 || inBar === 14 || inBar === 10) {
      chord.tones.forEach((m, i) => this.pluck(t + i * 0.012, m, 0.028));
    }
    for (const n of this.melody) if (n.step === step) this.marimba(t, n.midi, n.len * STEP);
  }

  /** 4마디 멜로디: 강박은 코드음, 약박은 앞 음에서 가까운 펜타토닉 음. 마지막 마디는 근음으로 길게 끝낸다 */
  private makeMelody(): Note[] {
    const r = this.rnd;
    const prog = this.progression();
    const notes: Note[] = [];
    let prev = 76;
    for (let bar = 0; bar < BARS; bar++) {
      const chord = prog[bar];
      const last = bar === BARS - 1;
      for (let e = 0; e < 8; e++) {
        const step = bar * STEPS_PER_BAR + e * 2;
        if (last && e >= 4) break;
        const strong = e % 2 === 0;
        if (r() > (strong ? 0.78 : 0.42)) continue;
        let midi: number;
        if (strong || last) {
          const tone = chord.tones[Math.floor(r() * 3)] + 12;
          midi = tone < 72 ? tone + 12 : tone;
        } else {
          const i = PENTA.findIndex((p) => p >= prev);
          const j = Math.max(0, Math.min(PENTA.length - 1, (i < 0 ? PENTA.length - 1 : i) + (r() < 0.5 ? -1 : 1)));
          midi = PENTA[j];
        }
        prev = midi;
        notes.push({ step, midi, len: last && e === 3 ? 8 : strong ? 3 : 2 });
      }
    }
    // 마지막 마디 첫 음은 근음(안정감)
    const end = notes.find((n) => n.step === (BARS - 1) * STEPS_PER_BAR);
    if (end) end.midi = prog[BARS - 1].root + 36;
    return notes;
  }

  // ---------------------------------------------------------------- instruments

  private env(g: GainNode, t: number, peak: number, attack: number, decay: number): void {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private marimba(t: number, midi: number, len: number): void {
    const ctx = this.ctx;
    const f = mtof(midi);
    const decay = Math.min(0.6, Math.max(0.22, len));
    const g = ctx.createGain();
    this.env(g, t, 0.11, 0.006, decay);
    g.connect(this.out);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    o.connect(g);
    // 마림바 특유의 4배음(짧게)
    const g2 = ctx.createGain();
    this.env(g2, t, 0.025, 0.004, 0.08);
    g2.connect(this.out);
    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = f * 4;
    o2.connect(g2);
    o.start(t);
    o2.start(t);
    o.stop(t + decay + 0.05);
    o2.stop(t + 0.12);
  }

  private pluck(t: number, midi: number, vol: number): void {
    const ctx = this.ctx;
    const g = ctx.createGain();
    this.env(g, t, vol, 0.004, 0.2);
    g.connect(this.comp);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = mtof(midi);
    o.connect(g);
    o.start(t);
    o.stop(t + 0.25);
  }

  private bass(t: number, midi: number, len: number): void {
    const ctx = this.ctx;
    const g = ctx.createGain();
    this.env(g, t, 0.13, 0.01, Math.max(0.15, len * 0.9));
    g.connect(this.out);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = mtof(midi);
    o.connect(g);
    o.start(t);
    o.stop(t + len + 0.05);
  }

  private kick(t: number): void {
    const ctx = this.ctx;
    const g = ctx.createGain();
    this.env(g, t, 0.16, 0.004, 0.14);
    g.connect(this.out);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.12);
    o.connect(g);
    o.start(t);
    o.stop(t + 0.18);
  }

  private snap(t: number): void {
    this.noiseHit(t, 'bandpass', 1900, 0.05, 0.07);
  }

  private shaker(t: number, vol: number): void {
    this.noiseHit(t, 'highpass', 6500, vol, 0.035);
  }

  private noiseHit(t: number, type: BiquadFilterType, freq: number, vol: number, dur: number): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    this.env(g, t, vol, 0.002, dur);
    src.connect(f).connect(g).connect(this.out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }
}

/**
 * 뒷마당 환경음: 잔잔한 바람(저역 노이즈, 천천히 일렁임) + 가끔 새 지저귐.
 */
export class Ambience {
  private breeze: AudioBufferSourceNode | null = null;
  private lfo: OscillatorNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextBird = 0;
  private readonly rnd = mulberry32(7);

  constructor(private readonly ctx: AudioContext, private readonly out: AudioNode, private readonly noise: AudioBuffer) {}

  start(): void {
    if (this.timer) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    const g = ctx.createGain();
    g.gain.value = 0.05;
    // 바람 세기가 천천히 오르내린다
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const depth = ctx.createGain();
    depth.gain.value = 0.03;
    lfo.connect(depth).connect(g.gain);
    src.connect(lp).connect(g).connect(this.out);
    src.start();
    lfo.start();
    this.breeze = src;
    this.lfo = lfo;
    this.nextBird = ctx.currentTime + 1.5;
    this.timer = setInterval(() => this.tick(), 250);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    const t = this.ctx.currentTime;
    this.breeze?.stop(t + 0.05);
    this.lfo?.stop(t + 0.05);
    this.breeze = null;
    this.lfo = null;
  }

  private tick(): void {
    const ctx = this.ctx;
    if (ctx.state !== 'running') return;
    if (ctx.currentTime < this.nextBird) return;
    this.nextBird = ctx.currentTime + 2.5 + this.rnd() * 5;
    this.chirp(ctx.currentTime + 0.05);
  }

  /** 짹짹: 짧은 고음 사인 스윕 2~4번, 좌우 무작위 */
  private chirp(t: number): void {
    const ctx = this.ctx;
    const r = this.rnd;
    const pan = ctx.createStereoPanner();
    pan.pan.value = (r() * 2 - 1) * 0.8;
    pan.connect(this.out);
    const count = 2 + Math.floor(r() * 3);
    const base = 2600 + r() * 1400;
    const up = r() < 0.5;
    for (let i = 0; i < count; i++) {
      const st = t + i * (0.09 + r() * 0.05);
      const dur = 0.05 + r() * 0.04;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(up ? base : base * 1.35, st);
      o.frequency.exponentialRampToValueAtTime(up ? base * 1.35 : base, st + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, st);
      g.gain.exponentialRampToValueAtTime(0.018, st + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, st + dur);
      o.connect(g).connect(pan);
      o.start(st);
      o.stop(st + dur + 0.02);
    }
  }
}
