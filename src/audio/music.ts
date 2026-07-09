/**
 * Music (BLUEPRINT §13): lobby loop ~92 BPM over an 8-bar Am–F–C–G progression —
 * plucked-triangle melody, soft bass, light percussion, low-passed for warmth —
 * and a results fanfare (victory: brass-ish triad rise; defeat: minor descent).
 *
 * Scheduling: notes are placed at exact AudioContext times by a lookahead
 * `setInterval` pump (§13 allows the interval; the *samples* are always
 * scheduled on the audio clock), so the loop is seamless and drift-free.
 * No music plays mid-match.
 */

import { EPS, filter, osc, type SynthCtx } from './synth';

const BPM = 92;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const LOOP_BARS = 8;
/** Lookahead window (s) and pump interval (ms). */
const LOOKAHEAD_S = 0.3;
const PUMP_MS = 80;

/** Note frequencies (equal temperament, A4 = 440). */
function noteHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// MIDI numbers: A2=45 C3=48 E3=52 F2=41 G2=43 C4=60 A4=69 ...
interface Chord {
  bass: number;
  tones: readonly number[];
}

/** Am – F – C – G, two bars each (8-bar loop). */
const PROGRESSION: readonly Chord[] = [
  { bass: 45, tones: [57, 60, 64] }, // Am: A3 C4 E4
  { bass: 41, tones: [57, 60, 65] }, // F:  A3 C4 F4
  { bass: 48, tones: [55, 60, 64] }, // C:  G3 C4 E4
  { bass: 43, tones: [55, 59, 62] }, // G:  G3 B3 D4
];

/**
 * Melody: one entry per half-beat over the 8-bar loop (64 slots), MIDI or 0 for
 * rest. Hand-written to sit on the progression (A-minor pentatonic flavour).
 */
const MELODY: readonly number[] = [
  // Am (bars 1–2)
  69, 0, 72, 0, 76, 0, 72, 0, 69, 0, 67, 0, 64, 0, 67, 0,
  // F (bars 3–4)
  65, 0, 69, 0, 72, 0, 69, 0, 65, 0, 64, 0, 60, 0, 64, 0,
  // C (bars 5–6)
  64, 0, 67, 0, 72, 0, 67, 0, 64, 0, 62, 0, 60, 0, 62, 0,
  // G (bars 7–8)
  62, 0, 67, 0, 71, 0, 67, 0, 62, 0, 64, 0, 65, 0, 67, 0,
];

export class Music {
  private timer: number | null = null;
  /** Absolute AudioContext time of the next half-beat to schedule. */
  private nextSlotTime = 0;
  /** Half-beat index from loop start (0..63, wraps). */
  private slot = 0;
  private playing = false;

  constructor(private readonly sc: SynthCtx) {}

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Start the lobby loop (idempotent). */
  playLobby(): void {
    if (this.playing) return;
    this.playing = true;
    this.slot = 0;
    this.nextSlotTime = this.sc.ctx.currentTime + 0.1;
    this.pump();
    this.timer = window.setInterval(() => this.pump(), PUMP_MS);
  }

  /** Stop any music with a short fade handled per-voice (notes are short). */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.playing = false;
    // Already-scheduled notes (≤ LOOKAHEAD_S ahead) ring out naturally — they
    // are envelope-shaped, so there is no click and at most ~0.3 s of tail.
  }

  /** Results fanfare: victory = brass-ish rising triads; defeat = minor descent. */
  playResultsFanfare(victory: boolean): void {
    this.stop();
    const t0 = this.sc.ctx.currentTime + 0.05;
    if (victory) {
      // C – F/C – G – C(high): rising, brassy.
      this.brassChord(t0, [48, 60, 64, 67], 0.5);
      this.brassChord(t0 + 0.45, [53, 60, 65, 69], 0.5);
      this.brassChord(t0 + 0.9, [55, 62, 67, 71], 0.55);
      this.brassChord(t0 + 1.45, [60, 64, 67, 72, 76], 1.4);
    } else {
      // Am – G – F – E: falling, darker (softer, longer tones).
      this.brassChord(t0, [57, 60, 64], 0.7, 0.5);
      this.brassChord(t0 + 0.65, [55, 59, 62], 0.7, 0.45);
      this.brassChord(t0 + 1.3, [53, 57, 60], 0.7, 0.4);
      this.brassChord(t0 + 1.95, [52, 56, 59], 1.6, 0.35);
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Schedule every half-beat that falls inside the lookahead window. */
  private pump(): void {
    if (!this.playing) return;
    const ctx = this.sc.ctx;
    const half = BEAT / 2;
    while (this.nextSlotTime < ctx.currentTime + LOOKAHEAD_S) {
      this.scheduleSlot(this.slot, this.nextSlotTime);
      this.slot = (this.slot + 1) % (LOOP_BARS * 8);
      this.nextSlotTime += half;
    }
  }

  /** Emit all parts active on one half-beat slot at absolute time `t`. */
  private scheduleSlot(slot: number, t: number): void {
    const halfBeatInBar = slot % 8;
    const bar = Math.floor(slot / 8);
    const chord = PROGRESSION[Math.floor(bar / 2) % PROGRESSION.length];

    // Melody: plucked triangle.
    const m = MELODY[slot];
    if (m !== 0) this.pluck(noteHz(m), t, 0.16, BEAT * 0.9);

    // Bass: root on beat 1, fifth on beat 3 (soft sine).
    if (halfBeatInBar === 0) this.bass(noteHz(chord.bass), t, BEAT * 1.6);
    if (halfBeatInBar === 4) this.bass(noteHz(chord.bass + 7), t, BEAT * 1.2);

    // Pad: chord tones sustained at bar start, very quiet.
    if (halfBeatInBar === 0) {
      for (const tone of chord.tones) this.pad(noteHz(tone), t, BAR * 0.95);
    }

    // Percussion: soft kick on beats 1 & 3, hat tick on off half-beats.
    if (halfBeatInBar === 0 || halfBeatInBar === 4) this.kick(t);
    if (halfBeatInBar % 2 === 1) this.hat(t, halfBeatInBar === 7 ? 0.05 : 0.035);
  }

  /** Plucked triangle: fast attack, exponential decay, low-passed. */
  private pluck(freq: number, t: number, level: number, dur: number): void {
    const { ctx, musicBus } = this.sc;
    const o = osc(ctx, 'triangle', freq);
    const g = ctx.createGain();
    const lp = filter(ctx, 'lowpass', 2400, 0.5);
    g.gain.setValueAtTime(EPS, t);
    g.gain.linearRampToValueAtTime(level, t + 0.008);
    g.gain.exponentialRampToValueAtTime(EPS, t + dur);
    o.connect(g);
    g.connect(lp);
    lp.connect(musicBus);
    o.start(t);
    o.stop(t + dur + 0.05);
    o.onended = () => lp.disconnect();
  }

  /** Soft bass: sine with a gentle envelope. */
  private bass(freq: number, t: number, dur: number): void {
    const { ctx, musicBus } = this.sc;
    const o = osc(ctx, 'sine', freq);
    const g = ctx.createGain();
    g.gain.setValueAtTime(EPS, t);
    g.gain.linearRampToValueAtTime(0.22, t + 0.03);
    g.gain.setValueAtTime(0.22, t + dur * 0.5);
    g.gain.exponentialRampToValueAtTime(EPS, t + dur);
    o.connect(g);
    g.connect(musicBus);
    o.start(t);
    o.stop(t + dur + 0.05);
    o.onended = () => g.disconnect();
  }

  /** Warm pad tone: quiet detuned triangle pair through a low lowpass. */
  private pad(freq: number, t: number, dur: number): void {
    const { ctx, musicBus } = this.sc;
    const lp = filter(ctx, 'lowpass', 1200, 0.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(EPS, t);
    g.gain.linearRampToValueAtTime(0.045, t + dur * 0.2);
    g.gain.setValueAtTime(0.045, t + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(EPS, t + dur);
    g.connect(lp);
    lp.connect(musicBus);
    const detunes = [0.998, 1.002];
    for (let i = 0; i < detunes.length; i++) {
      const o = osc(ctx, 'triangle', freq * detunes[i]);
      o.connect(g);
      o.start(t);
      o.stop(t + dur + 0.05);
      if (i === 0) o.onended = () => lp.disconnect();
    }
  }

  /** Soft kick: quick sine drop. */
  private kick(t: number): void {
    const { ctx, musicBus } = this.sc;
    const o = osc(ctx, 'sine', 110);
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.09);
    const g = ctx.createGain();
    g.gain.setValueAtTime(EPS, t);
    g.gain.linearRampToValueAtTime(0.22, t + 0.005);
    g.gain.exponentialRampToValueAtTime(EPS, t + 0.14);
    o.connect(g);
    g.connect(musicBus);
    o.start(t);
    o.stop(t + 0.2);
    o.onended = () => g.disconnect();
  }

  /** Hat tick: tiny highpassed noise blip. */
  private hat(t: number, level: number): void {
    const { ctx, musicBus, noise } = this.sc;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const hp = filter(ctx, 'highpass', 6000, 0.7);
    const g = ctx.createGain();
    g.gain.setValueAtTime(EPS, t);
    g.gain.linearRampToValueAtTime(level, t + 0.003);
    g.gain.exponentialRampToValueAtTime(EPS, t + 0.05);
    src.connect(hp);
    hp.connect(g);
    g.connect(musicBus);
    src.start(t);
    src.stop(t + 0.08);
    src.onended = () => g.disconnect();
  }

  /** Brass-ish chord: detuned saw stack, lowpassed, slow-ish attack. */
  private brassChord(t: number, midis: readonly number[], dur: number, level = 0.5): void {
    const { ctx, musicBus } = this.sc;
    const lp = filter(ctx, 'lowpass', 2200, 0.6);
    const master = ctx.createGain();
    master.gain.setValueAtTime(EPS, t);
    master.gain.linearRampToValueAtTime(level, t + 0.06);
    master.gain.setValueAtTime(level, t + dur * 0.55);
    master.gain.exponentialRampToValueAtTime(EPS, t + dur);
    master.connect(lp);
    lp.connect(musicBus);
    const per = 0.9 / Math.max(1, midis.length * 2);
    let first = true;
    for (const midi of midis) {
      for (const det of [0.9965, 1.0035]) {
        const o = osc(ctx, 'sawtooth', noteHz(midi) * det);
        const g = ctx.createGain();
        g.gain.value = per;
        o.connect(g);
        g.connect(master);
        o.start(t);
        o.stop(t + dur + 0.05);
        if (first) {
          o.onended = () => lp.disconnect();
          first = false;
        }
      }
    }
  }
}
