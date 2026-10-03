/**
 * Champions League — battle music loop on the shared synth graph: ~148 BPM, D minor, an 8-bar
 * Dm – Bb – C – A loop with a four-on-the-floor kick, backbeat snare, driving saw-bass eighths, chord stabs and
 * (as the fight heats up) a 16th-note arpeggio lead. Scheduled on the audio clock by a lookahead pump (same
 * technique as the lobby loop in `src/audio/music.ts`). Everything goes through its own gain node into the
 * existing music bus, so master / music / mute settings apply and the loop fades out on stop.
 */

import { EPS, filter, noiseSource, osc, type SynthCtx } from '../../audio/synth';

const BPM = 148;
const STEP = 60 / BPM / 4; // one 16th note
const STEPS_PER_BAR = 16;
const LOOP_BARS = 8;
const LOOKAHEAD_S = 0.32;
const PUMP_MS = 70;
const FADE_OUT_S = 0.35;

const hz = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);

interface Chord {
  root: number;
  third: number;
  fifth: number;
}

/** One chord per two bars: Dm, Bb, C, A (major, for the pull back to Dm). */
const PROGRESSION: readonly Chord[] = [
  { root: 38, third: 41, fifth: 45 }, // Dm   D2 F2 A2
  { root: 34, third: 38, fifth: 41 }, // Bb   Bb1 D2 F2
  { root: 36, third: 40, fifth: 43 }, // C    C2 E2 G2
  { root: 33, third: 37, fifth: 40 }, // A    A1 C#2 E2
];

/** Lead arpeggio pattern over a chord (indices into [root, third, fifth, octave root]) per 16th. */
const ARP: readonly number[] = [0, 1, 2, 3, 2, 1, 2, 1, 0, 1, 2, 3, 2, 3, 2, 1];

export class BrawlMusic {
  private out: GainNode | null = null;
  private timer: number | null = null;
  private nextTime = 0;
  private step = 0;
  private running = false;
  private paused = false;
  private intensity = 0.3;

  constructor(private readonly sc: SynthCtx) {}

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    const { ctx, musicBus } = this.sc;
    this.running = true;
    this.paused = false;
    this.out = ctx.createGain();
    this.out.gain.value = 0.9;
    this.out.connect(musicBus);
    this.step = 0;
    this.nextTime = ctx.currentTime + 0.08;
    this.pump();
    this.timer = window.setInterval(() => this.pump(), PUMP_MS);
  }

  /** 0..1: arpeggio lead above ~0.35, extra percussion above ~0.65. */
  setIntensity(x: number): void {
    this.intensity = Math.max(0, Math.min(1, x));
  }

  /** Duck the loop while the pause menu is open (notes stop being scheduled). */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (!paused && this.running) this.nextTime = this.sc.ctx.currentTime + 0.06;
    if (this.out !== null) this.out.gain.setTargetAtTime(paused ? 0.25 : 0.9, this.sc.ctx.currentTime, 0.05);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    const out = this.out;
    this.out = null;
    if (out !== null) {
      const t = this.sc.ctx.currentTime;
      try {
        out.gain.cancelScheduledValues(t);
        out.gain.setValueAtTime(Math.max(out.gain.value, EPS), t);
        out.gain.exponentialRampToValueAtTime(EPS, t + FADE_OUT_S);
      } catch {
        /* context closing */
      }
      window.setTimeout(() => {
        try {
          out.disconnect();
        } catch {
          /* already gone */
        }
      }, FADE_OUT_S * 1000 + 600);
    }
  }

  // ── scheduling ─────────────────────────────────────────────────────────────

  private pump(): void {
    if (!this.running || this.paused || this.out === null) return;
    const ctx = this.sc.ctx;
    while (this.nextTime < ctx.currentTime + LOOKAHEAD_S) {
      this.schedule(this.step, this.nextTime);
      this.step = (this.step + 1) % (STEPS_PER_BAR * LOOP_BARS);
      this.nextTime += STEP;
    }
  }

  private schedule(step: number, t: number): void {
    const bar = Math.floor(step / STEPS_PER_BAR);
    const s = step % STEPS_PER_BAR;
    const chord = PROGRESSION[Math.floor(bar / 2) % PROGRESSION.length];
    const heat = this.intensity;

    // Kick: four on the floor; an extra push before the bar turns over.
    if (s % 4 === 0 || (heat > 0.65 && (s === 10 || (bar % 2 === 1 && s === 14)))) this.kick(t, s === 0 ? 0.3 : 0.24);
    // Snare backbeat.
    if (s === 4 || s === 12) this.snare(t, 0.2);
    // Hats: eighths, open hat on the "and" of 4.
    if (s % 2 === 0) this.hat(t, s % 4 === 2 ? 0.05 : 0.03, 0.035);
    if (s === 14) this.hat(t, 0.06, 0.12);
    if (heat > 0.65 && s % 2 === 1) this.hat(t, 0.02, 0.03);

    // Bass: driving eighths on the root, octave jump on the off-beats.
    if (s % 2 === 0) {
      const octave = s % 8 === 6 ? 12 : 0;
      this.bass(hz(chord.root + octave), t, STEP * 1.7, 0.2);
    }
    // Chord stabs on 1 and the "and" of 2.
    if (s === 0 || s === 6 || s === 8) this.stab(t, chord, s === 0 ? 0.075 : 0.055);

    // Arpeggio lead.
    if (heat > 0.35) {
      const tones = [chord.root + 24, chord.third + 24, chord.fifth + 24, chord.root + 36];
      this.lead(hz(tones[ARP[s]]), t, STEP * 0.85, 0.045 + heat * 0.03);
    }
  }

  // ── voices (all into `out`) ────────────────────────────────────────────────

  private kick(t: number, level: number): void {
    const { ctx } = this.sc;
    const out = this.out;
    if (out === null) return;
    const o = osc(ctx, 'sine', 128);
    o.frequency.setValueAtTime(128, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.11);
    const g = ctx.createGain();
    g.gain.setValueAtTime(EPS, t);
    g.gain.linearRampToValueAtTime(level, t + 0.004);
    g.gain.exponentialRampToValueAtTime(EPS, t + 0.2);
    o.connect(g);
    g.connect(out);
    o.start(t);
    o.stop(t + 0.24);
    o.onended = () => g.disconnect();
  }

  private snare(t: number, level: number): void {
    const { ctx } = this.sc;
    const out = this.out;
    if (out === null) return;
    const n = noiseSource(this.sc);
    const hp = filter(ctx, 'highpass', 1800, 0.7);
    const g = ctx.createGain();
    g.gain.setValueAtTime(EPS, t);
    g.gain.linearRampToValueAtTime(level, t + 0.002);
    g.gain.exponentialRampToValueAtTime(EPS, t + 0.14);
    n.connect(hp);
    hp.connect(g);
    g.connect(out);
    n.start(t);
    n.stop(t + 0.18);
    n.onended = () => g.disconnect();
    const b = osc(ctx, 'triangle', 190);
    b.frequency.exponentialRampToValueAtTime(120, t + 0.08);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(EPS, t);
    bg.gain.linearRampToValueAtTime(level * 0.8, t + 0.003);
    bg.gain.exponentialRampToValueAtTime(EPS, t + 0.1);
    b.connect(bg);
    bg.connect(out);
    b.start(t);
    b.stop(t + 0.14);
    b.onended = () => bg.disconnect();
  }

  private hat(t: number, level: number, dur: number): void {
    const { ctx } = this.sc;
    const out = this.out;
    if (out === null) return;
    const n = noiseSource(this.sc);
    const hp = filter(ctx, 'highpass', 7000, 0.7);
    const g = ctx.createGain();
    g.gain.setValueAtTime(EPS, t);
    g.gain.linearRampToValueAtTime(level, t + 0.002);
    g.gain.exponentialRampToValueAtTime(EPS, t + dur);
    n.connect(hp);
    hp.connect(g);
    g.connect(out);
    n.start(t);
    n.stop(t + dur + 0.03);
    n.onended = () => g.disconnect();
  }

  private bass(freq: number, t: number, dur: number, level: number): void {
    const { ctx } = this.sc;
    const out = this.out;
    if (out === null) return;
    const o = osc(ctx, 'sawtooth', freq);
    const lp = filter(ctx, 'lowpass', 520, 1.2);
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(260, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(EPS, t);
    g.gain.linearRampToValueAtTime(level, t + 0.006);
    g.gain.exponentialRampToValueAtTime(EPS, t + dur);
    o.connect(lp);
    lp.connect(g);
    g.connect(out);
    o.start(t);
    o.stop(t + dur + 0.03);
    o.onended = () => g.disconnect();
  }

  private stab(t: number, chord: Chord, level: number): void {
    const { ctx } = this.sc;
    const out = this.out;
    if (out === null) return;
    const lp = filter(ctx, 'lowpass', 2400, 0.6);
    const g = ctx.createGain();
    const dur = STEP * 2.4;
    g.gain.setValueAtTime(EPS, t);
    g.gain.linearRampToValueAtTime(level, t + 0.01);
    g.gain.exponentialRampToValueAtTime(EPS, t + dur);
    lp.connect(g);
    g.connect(out);
    let first = true;
    for (const m of [chord.root + 24, chord.third + 24, chord.fifth + 24, chord.fifth + 31]) {
      for (const det of [0.994, 1.006]) {
        const o = osc(ctx, 'sawtooth', hz(m) * det);
        const og = ctx.createGain();
        og.gain.value = 0.16;
        o.connect(og);
        og.connect(lp);
        o.start(t);
        o.stop(t + dur + 0.03);
        if (first) {
          o.onended = () => g.disconnect();
          first = false;
        }
      }
    }
  }

  private lead(freq: number, t: number, dur: number, level: number): void {
    const { ctx } = this.sc;
    const out = this.out;
    if (out === null) return;
    const o = osc(ctx, 'square', freq);
    const lp = filter(ctx, 'lowpass', 3200, 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(EPS, t);
    g.gain.linearRampToValueAtTime(level, t + 0.004);
    g.gain.exponentialRampToValueAtTime(EPS, t + dur);
    o.connect(lp);
    lp.connect(g);
    g.connect(out);
    o.start(t);
    o.stop(t + dur + 0.03);
    o.onended = () => g.disconnect();
  }
}
