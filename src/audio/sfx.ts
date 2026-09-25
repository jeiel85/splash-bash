import * as THREE from 'three';
import { Ambience, MusicBox } from './music';

/**
 * 효과음·음악·환경음: 외부 파일 없이 WebAudio 로 합성한다.
 *
 * 신호 흐름:
 *   효과음 ─┐
 *   환경음 ─┴→ [젖음 먹먹함 저역통과] ─┐
 *   UI 소리 ────────────────────────────┼→ 마스터 → 컴프레서 → 출력
 *   음악 ───────────────────────────────┘
 *
 * 위치가 있으면 거리 감쇠 + 좌우(equal-power) 패닝. 소리 이름마다 동시 재생은 최대 MAX_VOICES.
 */
export type SfxName =
  | 'pistol' | 'soaker' | 'bucket' | 'throw' | 'burst' | 'impact' | 'hit' | 'hitmark'
  | 'splashed' | 'kill' | 'jump' | 'land' | 'refill' | 'dry' | 'spawn' | 'click' | 'countdown'
  | 'win' | 'jumppad' | 'switch'
  | 'step' | 'wade' | 'refillDone' | 'lowWater' | 'streak' | 'ready' | 'go' | 'back';

export interface PlayOptions {
  volume?: number;
  /** 1 = 기본, 무작위 변화는 자동으로 약간 더해진다 */
  pitch?: number;
  pos?: THREE.Vector3;
  /** 0..1 젖은 정도(발소리·착지가 더 철벅거린다) */
  wet?: number;
}

/** 메뉴/게임에 따라 음악·환경음 구성이 달라진다 */
export type AudioScene = 'menu' | 'game';

const MAX_DIST = 40;
const MAX_VOICES = 8;
/** 같은 소리 재생 최소 간격(초) — 한 프레임에 여러 번 겹치지 않게 */
const DEBOUNCE = 0.016;
/** 맞힘 "뽁" 음 사다리: 이 시간 안에 연속으로 맞히면 반음씩 올라간다 */
const LADDER_WINDOW = 0.5;
const LADDER_MAX = 7;
/** 발소리 보폭(m) — 콩 캐릭터의 종종걸음 */
const STRIDE = 1.9;
/** 이 젖음 이상이면 소리가 물속처럼 먹먹해진다 */
const MUFFLE_AT = 0.75;
/** 음악 버스 기본 배율(설정 100% 여도 효과음보다 작게) */
const MUSIC_LEVEL = 0.55;
const MUSIC_SCENE_LEVEL: Record<AudioScene, number> = { menu: 1, game: 0.7 };
const UI_SOUNDS = new Set<SfxName>(['click', 'back', 'countdown', 'go', 'streak', 'win', 'refillDone', 'ready', 'lowWater']);

const _dir = new THREE.Vector3();

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private uiBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private muffle: BiquadFilterNode | null = null;
  private noise: AudioBuffer | null = null;
  private music: MusicBox | null = null;
  private ambience: Ambience | null = null;
  private readonly listenerPos = new THREE.Vector3();
  private readonly listenerRight = new THREE.Vector3(1, 0, 0);
  private _volume = 0.7;
  private musicVolume = 0.4;
  private sfxVolume = 1;
  private scene: AudioScene = 'menu';
  private muffled = -1;
  /** 소리 이름별 목소리 끝나는 시각(고정 크기 — 재생마다 할당 없음) */
  private readonly voiceEnds = new Map<SfxName, Float64Array>();
  private readonly lastPlay = new Map<SfxName, number>();
  private ladder = 0;
  private lastHitmark = -1;
  private stride = 0;
  private stepSide = 1;

  /** 사용자 입력(클릭) 이후에 호출해야 소리가 난다(브라우저 자동재생 정책) */
  unlock(): void {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) {
        console.warn('[sfx] 이 브라우저는 WebAudio 를 지원하지 않아 소리 없이 진행합니다');
        return;
      }
      this.build(new Ctx());
    }
    const ctx = this.ctx!;
    if (ctx.state === 'suspended' && !document.hidden) {
      ctx.resume().catch((err: unknown) => console.warn('[sfx] 오디오 재개 실패', err));
    }
  }

  private build(ctx: AudioContext): void {
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.connect(comp);
    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;
    this.muffle.Q.value = 0.9;
    this.muffle.connect(this.master);
    this.sfxBus = ctx.createGain();
    this.sfxBus.connect(this.muffle);
    this.uiBus = ctx.createGain();
    this.uiBus.connect(this.master);
    this.musicBus = ctx.createGain();
    this.musicBus.connect(this.master);
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.music = new MusicBox(ctx, this.musicBus, this.noise);
    this.ambience = new Ambience(ctx, this.sfxBus, this.noise);
    // 탭이 가려지면 소리를 멈추고(배터리·예약 음 몰림 방지) 돌아오면 이어서
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      const op = document.hidden ? this.ctx.suspend() : this.ctx.resume();
      op.catch((err: unknown) => console.warn('[sfx] 오디오 상태 전환 실패', err));
    });
    // 음악·환경음 시작도 여기서(음량 0 이면 시작하지 않음)
    this.applyVolumes();
  }

  get volume(): number {
    return this._volume;
  }

  /** 전체(마스터) 음량 */
  set volume(v: number) {
    this._volume = THREE.MathUtils.clamp(v, 0, 1);
    this.applyVolumes();
  }

  setVolumes(master: number, music: number, sfx: number): void {
    this._volume = THREE.MathUtils.clamp(master, 0, 1);
    this.musicVolume = THREE.MathUtils.clamp(music, 0, 1);
    this.sfxVolume = THREE.MathUtils.clamp(sfx, 0, 1);
    this.applyVolumes();
  }

  setScene(scene: AudioScene): void {
    this.scene = scene;
    this.applyVolumes();
    if (scene === 'menu') this.setSoak(0);
  }

  private applyVolumes(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.sfxBus || !this.uiBus || !this.musicBus) return;
    const t = ctx.currentTime;
    // 사람 귀는 로그 스케일 — 슬라이더를 제곱해 작은 값에서도 세밀하게
    this.master.gain.setTargetAtTime(this._volume * this._volume, t, 0.03);
    this.sfxBus.gain.setTargetAtTime(this.sfxVolume * this.sfxVolume, t, 0.03);
    this.uiBus.gain.setTargetAtTime(this.sfxVolume * this.sfxVolume, t, 0.03);
    const m = this.musicVolume * this.musicVolume * MUSIC_LEVEL * MUSIC_SCENE_LEVEL[this.scene];
    this.musicBus.gain.setTargetAtTime(m, t, 0.3);
    // 들리지 않을 음은 예약하지 않는다(CPU 절약)
    if (this.music) {
      if (m > 0 && this._volume > 0) this.music.start();
      else this.music.stop();
    }
    if (this.ambience) {
      if (this.sfxVolume > 0 && this._volume > 0) this.ambience.start();
      else this.ambience.stop();
    }
  }

  /**
   * 내 젖음(0..1). MUFFLE_AT 이상이면 게임 소리를 저역통과로 먹먹하게 한다(음악·UI 소리는 그대로).
   */
  setSoak(soak: number): void {
    if (!this.ctx || !this.muffle) return;
    const k = soak >= MUFFLE_AT ? THREE.MathUtils.clamp((soak - MUFFLE_AT) / (1 - MUFFLE_AT), 0, 1) : -1;
    // 값이 거의 같으면 AudioParam 예약을 새로 만들지 않는다(매 프레임 호출)
    const q = k < 0 ? -1 : Math.round(k * 10);
    if (q === this.muffled) return;
    this.muffled = q;
    const freq = q < 0 ? 20000 : 1500 - q * 90;
    this.muffle.frequency.setTargetAtTime(freq, this.ctx.currentTime, q < 0 ? 0.15 : 0.06);
  }

  setListener(pos: THREE.Vector3, yaw: number): void {
    this.listenerPos.copy(pos);
    this.listenerRight.set(Math.cos(yaw), 0, -Math.sin(yaw));
  }

  /**
   * 로컬 플레이어 발소리. 매 프레임 호출한다.
   * @param speed 땅 위 수평 속도(공중·슬라이드면 0)
   */
  footsteps(dt: number, speed: number, wet: number, inWater: boolean): void {
    if (speed < 1) {
      // 멈췄다가 걷기 시작하면 첫 걸음이 곧바로 나게
      this.stride = STRIDE * 0.7;
      return;
    }
    this.stride += speed * dt;
    if (this.stride < STRIDE) return;
    this.stride = Math.min(this.stride - STRIDE, STRIDE * 0.5);
    this.stepSide = -this.stepSide;
    this.play(inWater ? 'wade' : 'step', { volume: 0.55 + wet * 0.45, pitch: this.stepSide > 0 ? 1 : 0.9, wet });
  }

  /** 착지. strength = 낙하 속도 / 세게 착지 기준 속도(1 이상이면 쿵) */
  landing(strength: number, wet: number): void {
    if (strength < 0.35) return;
    this.play('land', { volume: Math.min(1, 0.3 + strength * 0.6), pitch: strength >= 1 ? 0.8 : 1, wet });
  }

  play(name: SfxName, opts: PlayOptions = {}): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxBus || !this.uiBus || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const last = this.lastPlay.get(name) ?? -1;
    if (now - last < DEBOUNCE) return;

    // 목소리 수 제한: 끝난 칸을 찾는다
    let ends = this.voiceEnds.get(name);
    if (!ends) this.voiceEnds.set(name, (ends = new Float64Array(MAX_VOICES)));
    let slot = -1;
    for (let i = 0; i < ends.length; i++) {
      if (ends[i] <= now) {
        slot = i;
        break;
      }
    }
    if (slot < 0) return;

    let gain = opts.volume ?? 1;
    let pan = 0;
    if (opts.pos) {
      const d = opts.pos.distanceTo(this.listenerPos);
      if (d > MAX_DIST) return;
      gain *= 1 / (1 + d * 0.18);
      if (d > 0.01) pan = THREE.MathUtils.clamp(_dir.subVectors(opts.pos, this.listenerPos).divideScalar(d).dot(this.listenerRight), -1, 1) * 0.8;
    }
    if (gain < 0.003) return;
    this.lastPlay.set(name, now);

    let pitch = (opts.pitch ?? 1) * (0.94 + Math.random() * 0.12);
    if (name === 'hitmark') {
      this.ladder = now - this.lastHitmark < LADDER_WINDOW ? Math.min(LADDER_MAX, this.ladder + 1) : 0;
      this.lastHitmark = now;
      // 사다리가 들리도록 무작위 변화는 작게(±0.3반음)
      pitch = Math.pow(2, (this.ladder + (Math.random() - 0.5) * 0.6) / 12);
    }

    const out = ctx.createGain();
    out.gain.value = gain;
    const bus = UI_SOUNDS.has(name) ? this.uiBus : this.sfxBus;
    if (pan !== 0) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      out.connect(panner).connect(bus);
    } else {
      out.connect(bus);
    }
    const dur = this.voice(name, out, now, pitch, THREE.MathUtils.clamp(opts.wet ?? 0, 0, 1));
    ends[slot] = now + dur;
  }

  /** @returns 소리 길이(초) */
  private voice(name: SfxName, out: GainNode, t: number, p: number, wet: number): number {
    switch (name) {
      case 'pistol':
        // "퓻" — 좁은 대역 노이즈 + 플라스틱 방아쇠 딸깍
        this.noiseSweep(out, t, 'bandpass', 3200 * p, 1500 * p, 0.12, 0.5, 2.2);
        this.tone(out, t, 'sine', 950 * p, 480 * p, 0.045, 0.22);
        return 0.13;
      case 'soaker':
        // "쉬익" — 연사 간격(0.1초)보다 살짝 길게 끌어 물줄기가 이어지게
        this.noiseSweep(out, t, 'bandpass', 2100 * p, 1300 * p, 0.14, 0.3, 1.3);
        this.tone(out, t, 'sine', 330 * p, 290 * p, 0.05, 0.05);
        return 0.15;
      case 'bucket':
        // "촤악" — 넓은 물보라 + 둔탁한 퉁
        this.noiseSweep(out, t, 'lowpass', 2600 * p, 300 * p, 0.38, 0.75, 0.8);
        this.noiseSweep(out, t, 'bandpass', 900 * p, 600 * p, 0.2, 0.3, 1.5);
        this.tone(out, t, 'sine', 170 * p, 60 * p, 0.2, 0.5);
        return 0.4;
      case 'throw':
        this.noiseSweep(out, t, 'bandpass', 420 * p, 1500 * p, 0.2, 0.28, 2.5);
        this.tone(out, t, 'sine', 700 * p, 1150 * p, 0.07, 0.1);
        return 0.22;
      case 'burst':
        // 풍선 "펑" + 물 쏟아짐 + 물방울 몇 개
        this.noiseSweep(out, t, 'highpass', 2500, 2500, 0.035, 0.8, 0.7);
        this.tone(out, t, 'triangle', 520 * p, 110 * p, 0.13, 0.4);
        this.noiseSweep(out, t + 0.02, 'lowpass', 1700 * p, 200 * p, 0.65, 0.85, 0.8);
        this.bloop(out, t + 0.12, 780 * p, 0.08, 0.12);
        this.bloop(out, t + 0.22, 1050 * p, 0.07, 0.09);
        this.bloop(out, t + 0.31, 640 * p, 0.08, 0.08);
        return 0.7;
      case 'impact':
        this.noiseSweep(out, t, 'bandpass', 2700 * p, 1400 * p, 0.08, 0.14, 1.2);
        return 0.09;
      case 'hit':
        // 몸에 물 "철썩"
        this.noiseSweep(out, t, 'bandpass', 1300 * p, 480 * p, 0.14, 0.5, 1.6);
        this.tone(out, t, 'sine', 320 * p, 170 * p, 0.07, 0.14);
        return 0.15;
      case 'hitmark':
        // 맞힘 "뽁" — 사다리 피치(p)
        this.bloop(out, t, 680 * p, 0.09, 0.3);
        this.tone(out, t, 'triangle', 1360 * p, 1500 * p, 0.05, 0.05);
        return 0.1;
      case 'splashed':
        // 누군가 흠뻑! — 큰 물벼락 + 내려가는 "우와앙"
        this.noiseSweep(out, t, 'lowpass', 1500 * p, 240 * p, 0.8, 0.9, 0.8);
        this.tone(out, t, 'sine', 760 * p, 200 * p, 0.5, 0.32);
        this.bloop(out, t + 0.15, 900 * p, 0.08, 0.12);
        this.bloop(out, t + 0.3, 700 * p, 0.08, 0.1);
        return 0.82;
      case 'kill': {
        // 파티 나팔 "뿌우" + 따단!
        this.horn(out, t, 520 * p, 0.22, 0.16);
        const u = t + 0.2;
        this.tone(out, u, 'triangle', 880 * p, 880 * p, 0.09, 0.32);
        this.tone(out, u + 0.09, 'triangle', 1320 * p, 1320 * p, 0.2, 0.32);
        this.tone(out, u + 0.09, 'sine', 1760 * p, 1760 * p, 0.2, 0.08);
        return 0.5;
      }
      case 'streak': {
        // 연속 기록 알림: 올라가는 아르페지오(p 가 높을수록 높게)
        const notes = [523, 659, 784, 1047];
        notes.forEach((f, i) => this.tone(out, t + i * 0.07, 'triangle', f * p, f * p, 0.14, 0.22));
        this.tone(out, t + 0.28, 'sine', 2093 * p, 2093 * p, 0.3, 0.08);
        return 0.6;
      }
      case 'jump':
        this.tone(out, t, 'sine', 280 * p, 610 * p, 0.12, 0.16);
        return 0.13;
      case 'land':
        // 착지 "퉁" + 젖었으면 "철벅"
        this.tone(out, t, 'sine', 150 * p, 55 * p, 0.13, 0.4);
        this.noiseSweep(out, t, 'lowpass', 800 * p, 200 * p, 0.1, 0.22, 0.7);
        if (wet > 0.2) this.noiseSweep(out, t + 0.01, 'bandpass', 1100 * p, 500 * p, 0.15, 0.15 + wet * 0.3, 3);
        return 0.17;
      case 'step':
        // 말랑한 종종걸음 — 젖을수록 "찰박" 소리가 커진다
        this.noiseSweep(out, t, 'lowpass', 650 * p, 250 * p, 0.06, 0.3, 0.7);
        if (wet > 0.15) {
          this.noiseSweep(out, t + 0.012, 'bandpass', 1200 * p, 550 * p, 0.09, 0.08 + wet * 0.32, 3.5);
          this.bloop(out, t + 0.02, 320 * p, 0.05, wet * 0.07);
        }
        return 0.11;
      case 'wade':
        this.noiseSweep(out, t, 'bandpass', 900 * p, 380 * p, 0.26, 0.32, 1.4);
        this.bloop(out, t + 0.05, 420 * p, 0.07, 0.07);
        return 0.27;
      case 'jumppad':
        // 트램펄린 "뽀잉" — 떨리며 올라가는 음
        this.boing(out, t, 170 * p, 560 * p, 0.38, 0.38);
        this.tone(out, t, 'triangle', 90 * p, 70 * p, 0.12, 0.2);
        return 0.4;
      case 'refill':
        // 보글보글 — 물 차오르는 거품
        this.bloop(out, t, (380 + Math.random() * 380) * p, 0.06, 0.13);
        this.bloop(out, t + 0.04 + Math.random() * 0.03, (520 + Math.random() * 420) * p, 0.05, 0.09);
        return 0.12;
      case 'refillDone':
        // 충전 완료 "띠링"
        this.tone(out, t, 'sine', 1047, 1047, 0.18, 0.2);
        this.tone(out, t + 0.1, 'sine', 1568, 1568, 0.35, 0.2);
        this.tone(out, t + 0.1, 'triangle', 3136, 3136, 0.15, 0.03);
        return 0.46;
      case 'lowWater':
        this.tone(out, t, 'triangle', 392, 392, 0.1, 0.16);
        this.tone(out, t + 0.13, 'triangle', 294, 294, 0.14, 0.16);
        return 0.28;
      case 'ready':
        this.tone(out, t, 'sine', 1319, 1319, 0.08, 0.1);
        this.tone(out, t + 0.07, 'sine', 1760, 1760, 0.12, 0.1);
        return 0.2;
      case 'dry':
        // 헛발사 "딸깍딸깍"
        this.noiseSweep(out, t, 'highpass', 3000, 3000, 0.02, 0.13, 0.7);
        this.tone(out, t, 'square', 1700 * p, 1400 * p, 0.018, 0.04);
        this.noiseSweep(out, t + 0.06, 'highpass', 3400, 3400, 0.02, 0.1, 0.7);
        return 0.09;
      case 'spawn':
        this.bloop(out, t, 480 * p, 0.08, 0.2);
        this.tone(out, t + 0.06, 'sine', 784 * p, 784 * p, 0.12, 0.2);
        this.tone(out, t + 0.14, 'sine', 1175 * p, 1175 * p, 0.2, 0.2);
        return 0.35;
      case 'click':
        this.tone(out, t, 'sine', 700 * p, 1150 * p, 0.05, 0.2);
        return 0.06;
      case 'back':
        this.tone(out, t, 'sine', 950 * p, 600 * p, 0.07, 0.16);
        return 0.08;
      case 'switch':
        this.noiseSweep(out, t, 'bandpass', 2600 * p, 2400 * p, 0.03, 0.3, 4);
        this.tone(out, t, 'triangle', 600 * p, 720 * p, 0.045, 0.12);
        return 0.06;
      case 'countdown':
        this.tone(out, t, 'sine', 880, 880, 0.13, 0.26);
        return 0.14;
      case 'go':
        this.tone(out, t, 'sine', 1320, 1320, 0.28, 0.24);
        this.tone(out, t, 'triangle', 660, 660, 0.28, 0.12);
        return 0.3;
      case 'win': {
        // 짧은 축하 징글: 도-미-솔-도 + 화음
        const mel = [523, 659, 784, 1047];
        mel.forEach((f, i) => this.tone(out, t + i * 0.12, 'triangle', f, f, 0.16, 0.26));
        const end = t + 0.5;
        for (const f of [1047, 1319, 1568]) this.tone(out, end, 'triangle', f, f, 0.6, 0.12);
        this.tone(out, end, 'sine', 523, 523, 0.6, 0.12);
        return 1.15;
      }
    }
  }

  // ---------------------------------------------------------------- 합성 부품

  /** 필터를 통과한 노이즈(주파수 스윕) */
  private noiseSweep(out: AudioNode, t: number, type: BiquadFilterType, f0: number, f1: number, dur: number, vol: number, q: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(Math.max(40, f0), t);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + Math.min(0.008, dur * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  private tone(out: AudioNode, t: number, type: OscillatorType, f0: number, f1: number, dur: number, vol: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, f0), t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + Math.min(0.01, dur * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** 물방울 "뽁": 짧은 사인이 빠르게 위로 미끄러진다 */
  private bloop(out: AudioNode, t: number, f: number, dur: number, vol: number): void {
    if (vol < 0.002) return;
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f * 0.7, t);
    osc.frequency.exponentialRampToValueAtTime(f * 1.35, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** 스프링 "뽀잉": 비브라토를 건 상승음 */
  private boing(out: AudioNode, t: number, f0: number, f1: number, dur: number, vol: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.6);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 16;
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(f0 * 0.25, t);
    depth.gain.exponentialRampToValueAtTime(1, t + dur);
    lfo.connect(depth).connect(osc.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(out);
    osc.start(t);
    lfo.start(t);
    osc.stop(t + dur + 0.02);
    lfo.stop(t + dur + 0.02);
  }

  /** 파티 나팔: 톱니파 + 저역통과 + 떨림 */
  private horn(out: AudioNode, t: number, f: number, dur: number, vol: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f * 0.92, t);
    osc.frequency.exponentialRampToValueAtTime(f, t + 0.05);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1700;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
    g.gain.setValueAtTime(vol, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(lp).connect(g).connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
}
