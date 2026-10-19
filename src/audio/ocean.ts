/**
 * Ocean Dome audio (v1.9, WP-O3) - 100% synthesised like the rest of the engine: shaped envelopes (no clicks), bounded polyphony through
 * the shared `VoiceManager`, every output routed through the SFX bus so master / sfx volume and mute apply automatically.
 *
 *  - AMBIENCE BED (`start`/`stop`; AudioEngine starts it INSTEAD of the crowd murmur when the arena on screen is the Ocean Dome): a
 *    muffled underwater body (lowpassed noise breathing slowly), a deep drone, a faint surface shimmer, plus randomly scheduled
 *    bubbles, distant WHALE SONG and the odd sonar-like PING with a decaying echo. DUCKED under combat (`noteCombat`).
 *  - SEA SERPENT (all one-shots, rate-limited): `warning()` = a three-pulse klaxon + a deep growl + a rising rumble; `strike()` = glass
 *    shatter + heavy crash + roar, then (audio-clock scheduled) the HOLD thump + shockwave and the RETREAT rumble; `hit(gain)` = a heavy
 *    crunch + thud (distance-attenuated by the engine).
 *  - v1.10 HIGH SERPENT: `warning('high')` = a four-pulse RISING two-tone siren (the low one falls) + a higher shrieking growl + an eerie
 *    gliding "ghost" tone and a glassy chime stinger; `strike('high')` = shatter + a lighter crash + a higher roar + an overhead whoosh sweep.
 *    The two tiers rate-limit independently (both can come in the same second and must stay distinguishable).
 *  - FALL DAMAGE: `fall(gain)` = a body thud + a dry crunch + a short grunt ("ugh"); rate-limited (>= 120 ms apart, <= 3 / s).
 *
 * The colosseum and the jungle never construct / start this module (AudioEngine gates on `getRenderArena().id === 'ocean'`).
 */

import { EPS, filter, noiseSource, osc, shapeEnv, type SynthCtx } from './synth';
import type { SerpentTier } from '../core/types';
import type { ListenerFn } from './jungle';

const TICK_MS = 125;
const COMBAT_DECAY_S = 3;
const WARN_MIN_GAP = 1.5;
const STRIKE_MIN_GAP = 1.5;
const HIT_MIN_GAP = 0.08;
const HIT_MAX_PER_S = 4;
const FALL_MIN_GAP = 0.12;
const FALL_MAX_PER_S = 3;
/** Seconds after the strike begins that the HOLD thump / the RETREAT rumble land (config/serpent.ts: strikeS 0.44, holdS 0.35). */
const HOLD_DELAY = 0.44;
const RETREAT_DELAY = 0.79;

/** Pure: level of a serpent hit sound (0..1) for the engine's distance gain; inaudible far away. */
export function hitLevel(gain: number): number {
  return Math.min(1, Math.max(0, gain));
}

/** Pure: level of a fall thud (0..1) for the engine's distance gain (same curve as the serpent hit). */
export function fallLevel(gain: number): number {
  return Math.min(1, Math.max(0, gain));
}

/**
 * Pure: the sound design of each serpent's warning, so the two are told apart by ear (the tests pin the contract): the low serpent's
 * klaxon FALLS (540 -> 392 Hz, three square pulses) over a deep growl (52 -> 81 Hz); the high serpent's RISES (700 -> 1010 Hz, four
 * triangle pulses) over a higher shriek (118 -> 205 Hz) and adds a gliding ghost tone and a chime stinger.
 */
export const WARNING_VOICE: Record<SerpentTier, { pulses: number; type: OscillatorType; f0: number; f1: number; growl0: number; growl1: number; stinger: boolean }> = {
  low: { pulses: 3, type: 'square', f0: 540, f1: 392, growl0: 52, growl1: 81, stinger: false },
  high: { pulses: 4, type: 'triangle', f0: 700, f1: 1010, growl0: 118, growl1: 205, stinger: true },
};

export class OceanAudio {
  private started = false;
  private timer: number | null = null;
  private lastTick = 0;
  private combat = 0;
  private bed: GainNode | null = null;
  private bedSources: AudioScheduledSourceNode[] = [];
  private nextBubble = 0;
  private nextWhale = 0;
  private nextPing = 0;
  private lastWarn: Record<SerpentTier, number> = { low: -10, high: -10 };
  private lastStrike: Record<SerpentTier, number> = { low: -10, high: -10 };
  private lastHit = -10;
  private hitWindow: number[] = [];
  private lastFall = -10;
  private fallWindow: number[] = [];

  constructor(
    private readonly sc: SynthCtx,
    private readonly listener: ListenerFn,
  ) {}

  get running(): boolean {
    return this.started;
  }

  get combatLevel(): number {
    return this.combat;
  }

  private get now(): number {
    return this.sc.ctx.currentTime;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start(): void {
    if (this.started) return;
    this.started = true;
    const sc = this.sc;
    const t0 = this.now;
    const bed = sc.ctx.createGain();
    bed.gain.value = EPS;
    bed.connect(sc.sfxBus);
    this.bed = bed;
    const loop = (): AudioBufferSourceNode => {
      const n = noiseSource(sc);
      n.loop = true;
      return n;
    };
    // Muffled water body: lowpassed noise whose cutoff and level breathe slowly.
    const body = loop();
    const blp = filter(sc.ctx, 'lowpass', 360, 0.8);
    const bg = sc.ctx.createGain();
    bg.gain.value = 0.11;
    const bl = osc(sc.ctx, 'sine', 0.083);
    const blg = sc.ctx.createGain();
    blg.gain.value = 110;
    bl.connect(blg);
    blg.connect(blp.frequency);
    const bl2 = osc(sc.ctx, 'sine', 0.061);
    const bl2g = sc.ctx.createGain();
    bl2g.gain.value = 0.03;
    bl2.connect(bl2g);
    bl2g.connect(bg.gain);
    body.connect(blp);
    blp.connect(bg);
    bg.connect(bed);
    // Deep drone: two slightly detuned sines, slowly amplitude-modulated.
    const dg = sc.ctx.createGain();
    dg.gain.value = 0.045;
    dg.connect(bed);
    const d1 = osc(sc.ctx, 'sine', 49);
    const d2 = osc(sc.ctx, 'sine', 73.9);
    const d2g = sc.ctx.createGain();
    d2g.gain.value = 0.55;
    d1.connect(dg);
    d2.connect(d2g);
    d2g.connect(dg);
    const dl = osc(sc.ctx, 'sine', 0.11);
    const dlg = sc.ctx.createGain();
    dlg.gain.value = 0.02;
    dl.connect(dlg);
    dlg.connect(dg.gain);
    // Faint surface shimmer far above.
    const sh = loop();
    const sbp = filter(sc.ctx, 'bandpass', 2300, 2.2);
    const sg = sc.ctx.createGain();
    sg.gain.value = 0.006;
    const sl = osc(sc.ctx, 'sine', 0.31);
    const slg = sc.ctx.createGain();
    slg.gain.value = 0.004;
    sl.connect(slg);
    slg.connect(sg.gain);
    sh.connect(sbp);
    sbp.connect(sg);
    sg.connect(bed);

    const all: AudioScheduledSourceNode[] = [body, bl, bl2, d1, d2, dl, sh, sl];
    body.start(t0, Math.random() * 2);
    sh.start(t0, Math.random() * 2);
    for (const s of all) if (s !== body && s !== sh) s.start(t0);
    this.bedSources = all;

    bed.gain.setValueAtTime(EPS, t0);
    bed.gain.linearRampToValueAtTime(1, t0 + 2.2);
    const nowMs = performance.now();
    this.lastTick = nowMs;
    this.nextBubble = nowMs + 700 + Math.random() * 1500;
    this.nextWhale = nowMs + 6000 + Math.random() * 6000;
    this.nextPing = nowMs + 11000 + Math.random() * 9000;
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const t = this.now;
    const bed = this.bed;
    if (bed !== null) {
      const cur = Math.max(bed.gain.value, EPS);
      bed.gain.cancelScheduledValues(t);
      bed.gain.setValueAtTime(cur, t);
      bed.gain.exponentialRampToValueAtTime(EPS, t + 0.8);
    }
    for (const s of this.bedSources) {
      try {
        s.stop(t + 0.9);
      } catch {
        /* already stopped */
      }
    }
    const old = bed;
    window.setTimeout(() => {
      try {
        old?.disconnect();
      } catch {
        /* ignore */
      }
    }, 1100);
    this.bed = null;
    this.bedSources = [];
  }

  /** A fight is happening: raise the duck level (0..1); decays over ~3 s. */
  noteCombat(amount: number): void {
    this.combat = Math.min(1, this.combat + Math.max(0, amount));
  }

  // ── One-shot helpers ───────────────────────────────────────────────────────

  /** An oscillator with a frequency glide and a shaped envelope into the voice; returns the end time. */
  private glide(v: ReturnType<SynthCtx['voices']['create']>, t: number, type: OscillatorType, f0: number, f1: number, dur: number, peak: number, attack = 0.01, lp = 0): number {
    const sc = this.sc;
    const o = osc(sc.ctx, type, f0);
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = sc.ctx.createGain();
    g.gain.value = EPS;
    const end = shapeEnv(g.gain, t, peak, attack, dur * 0.25, dur * 0.75);
    if (lp > 0) {
      const f = filter(sc.ctx, 'lowpass', lp, 0.7);
      o.connect(f);
      f.connect(g);
    } else o.connect(g);
    g.connect(v.gain);
    o.start(t);
    o.stop(end + 0.03);
    sc.voices.add(v, o, true);
    return end;
  }

  /** A filtered noise burst with a shaped envelope into the voice; returns the end time. */
  private burst(v: ReturnType<SynthCtx['voices']['create']>, t: number, type: BiquadFilterType, f0: number, f1: number, dur: number, peak: number, attack = 0.004, q = 0.8): number {
    const sc = this.sc;
    const n = noiseSource(sc);
    const f = filter(sc.ctx, type, f0, q);
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = sc.ctx.createGain();
    g.gain.value = EPS;
    const end = shapeEnv(g.gain, t, peak, attack, dur * 0.2, dur * 0.8);
    n.connect(f);
    f.connect(g);
    g.connect(v.gain);
    n.start(t);
    n.stop(end + 0.03);
    sc.voices.add(v, n);
    return end;
  }

  // ── Ambience events ────────────────────────────────────────────────────────

  private bubbles(t: number, count: number): void {
    const sc = this.sc;
    for (let i = 0; i < count; i++) {
      const tt = t + i * (0.05 + Math.random() * 0.14);
      const v = sc.voices.create(tt);
      v.gain.gain.value = 0.5 + Math.random() * 0.5;
      const f = 260 + Math.random() * 520;
      this.glide(v, tt, 'sine', f, f * (1.5 + Math.random() * 0.7), 0.07 + Math.random() * 0.05, 0.05, 0.004, 1400);
    }
  }

  private whale(t: number): void {
    const sc = this.sc;
    const v = sc.voices.create(t);
    v.gain.gain.value = 0.9;
    const pan = sc.ctx.createStereoPanner();
    pan.pan.value = (Math.random() * 2 - 1) * 0.8;
    pan.connect(v.gain);
    const dur = 4.2 + Math.random() * 2.4;
    const base = 150 + Math.random() * 70;
    const lp = filter(sc.ctx, 'lowpass', 650, 0.7);
    lp.connect(pan);
    const mk = (mul: number, level: number): OscillatorNode => {
      const o = osc(sc.ctx, 'sine', base * mul);
      o.frequency.setValueAtTime(base * mul, t);
      o.frequency.linearRampToValueAtTime(base * mul * 2.1, t + dur * 0.4);
      o.frequency.linearRampToValueAtTime(base * mul * 0.9, t + dur);
      const vib = osc(sc.ctx, 'sine', 4.6);
      const vg = sc.ctx.createGain();
      vg.gain.value = 5 * mul;
      vib.connect(vg);
      vg.connect(o.frequency);
      const g = sc.ctx.createGain();
      g.gain.value = EPS;
      const end = shapeEnv(g.gain, t, 0.075 * level, dur * 0.25, dur * 0.2, dur * 0.55);
      o.connect(g);
      g.connect(lp);
      o.start(t);
      vib.start(t);
      o.stop(end + 0.05);
      vib.stop(end + 0.05);
      sc.voices.add(v, vib);
      return o;
    };
    mk(1, 1);
    const last = mk(2.01, 0.45);
    sc.voices.add(v, last, true);
  }

  private ping(t: number): void {
    const sc = this.sc;
    const pan = (Math.random() * 2 - 1) * 0.6;
    for (let k = 0; k < 3; k++) {
      const v = sc.voices.create(t + k * 0.62);
      v.gain.gain.value = 1;
      const p = sc.ctx.createStereoPanner();
      p.pan.value = pan;
      p.connect(v.gain);
      const o = osc(sc.ctx, 'sine', 1180);
      const g = sc.ctx.createGain();
      g.gain.value = EPS;
      const tt = t + k * 0.62;
      const end = shapeEnv(g.gain, tt, 0.05 * Math.pow(0.45, k), 0.004, 0.02, 0.5);
      const lp = filter(sc.ctx, 'lowpass', 1700 - k * 350, 0.7);
      o.connect(lp);
      lp.connect(g);
      g.connect(p);
      o.start(tt);
      o.stop(end + 0.03);
      sc.voices.add(v, o, true);
    }
  }

  // ── Serpent ────────────────────────────────────────────────────────────────

  /** The serpent warning: a klaxon, a growl and a rumble (the high serpent: a rising siren, a shriek, a ghost tone and a chime). Rate-limited per tier. */
  warning(tier: SerpentTier = 'low'): void {
    if (!this.started) return;
    const t = this.now;
    if (t - this.lastWarn[tier] < WARN_MIN_GAP) return;
    this.lastWarn[tier] = t;
    this.noteCombat(0.5);
    const sc = this.sc;
    const w = WARNING_VOICE[tier];
    const high = tier === 'high';
    // klaxon: falling square pulses (low) / rising triangle pulses, a little shorter apart (high)
    for (let k = 0; k < w.pulses; k++) {
      const tt = t + k * (high ? 0.27 : 0.34);
      const v = sc.voices.create(tt);
      v.gain.gain.value = 0.9;
      this.glide(v, tt, w.type, w.f0 + (high ? k * 38 : 0), w.f1 + (high ? k * 38 : 0), high ? 0.22 : 0.27, high ? 0.075 : 0.085, 0.012, high ? 2400 : 1500);
    }
    // growl: a sawtooth sliding up with a fast tremolo, through a low filter (higher and more strained for the high serpent)
    const v = sc.voices.create(t);
    v.gain.gain.value = 1;
    const o = osc(sc.ctx, 'sawtooth', w.growl0);
    o.frequency.setValueAtTime(w.growl0, t);
    o.frequency.exponentialRampToValueAtTime(w.growl1, t + 1.05);
    const lp = filter(sc.ctx, 'lowpass', high ? 720 : 300, high ? 1.4 : 0.9);
    const am = sc.ctx.createGain();
    am.gain.value = 0.6;
    const lfo = osc(sc.ctx, 'sine', high ? 17 : 11);
    const lg = sc.ctx.createGain();
    lg.gain.value = 0.4;
    lfo.connect(lg);
    lg.connect(am.gain);
    const g = sc.ctx.createGain();
    g.gain.value = EPS;
    const end = shapeEnv(g.gain, t, high ? 0.15 : 0.2, 0.25, 0.5, 0.45);
    o.connect(lp);
    lp.connect(am);
    am.connect(g);
    g.connect(v.gain);
    o.start(t);
    lfo.start(t);
    o.stop(end + 0.05);
    lfo.stop(end + 0.05);
    sc.voices.add(v, lfo);
    sc.voices.add(v, o, true);
    // rumble rising toward the strike
    const r = sc.voices.create(t);
    r.gain.gain.value = 1;
    this.burst(r, t, 'lowpass', high ? 140 : 90, high ? 520 : 260, 1.1, high ? 0.09 : 0.13, 0.9, 0.7);
    if (w.stinger) {
      // the high serpent's stinger: an eerie ghost tone gliding up over the warning + three glassy descending chimes
      const gv = sc.voices.create(t);
      gv.gain.gain.value = 1;
      this.glide(gv, t + 0.05, 'sine', 330, 760, 1.05, 0.06, 0.4, 1800);
      for (let k = 0; k < 3; k++) {
        const tt = t + 0.12 + k * 0.17;
        const cv = sc.voices.create(tt);
        cv.gain.gain.value = 0.9;
        this.glide(cv, tt, 'sine', 1560 - k * 260, 1520 - k * 260, 0.5, 0.045 * Math.pow(0.8, k), 0.004, 3200);
      }
    }
  }

  /** The head breaks through: glass shatter, heavy crash, roar; then the hold thump and the retreat rumble. Rate-limited per tier. */
  strike(tier: SerpentTier = 'low'): void {
    if (!this.started) return;
    const t = this.now;
    if (t - this.lastStrike[tier] < STRIKE_MIN_GAP) return;
    this.lastStrike[tier] = t;
    this.noteCombat(1);
    const sc = this.sc;
    const high = tier === 'high';
    // glass shatter: a bright burst plus a scatter of shard ticks
    const gv = sc.voices.create(t);
    gv.gain.gain.value = 1;
    this.burst(gv, t, 'highpass', high ? 4400 : 3600, high ? 4400 : 3600, 0.3, 0.17, 0.002, 0.6);
    for (let i = 0; i < 7; i++) {
      const tt = t + 0.03 + Math.random() * 0.4;
      const sv = sc.voices.create(tt);
      sv.gain.gain.value = 1;
      this.burst(sv, tt, 'bandpass', (high ? 5600 : 4800) + Math.random() * 3500, 3000, 0.045, 0.05 + Math.random() * 0.03, 0.001, 3);
    }
    // heavy crash + thump (lighter and higher for the high serpent: it sweeps through the air, not along the floor)
    const cv = sc.voices.create(t);
    cv.gain.gain.value = 1;
    this.burst(cv, t, 'lowpass', high ? 1900 : 1100, high ? 240 : 160, high ? 0.55 : 0.7, high ? 0.22 : 0.3, 0.004, 0.8);
    this.glide(cv, t, 'sine', high ? 92 : 66, high ? 40 : 28, 0.55, high ? 0.3 : 0.42, 0.004);
    // roar: a sawtooth with a formant sweep and fast amplitude roughness (the high one is a shriek an octave up)
    const rv = sc.voices.create(t + 0.04);
    rv.gain.gain.value = 1;
    const f0 = high ? 160 : 85;
    const o = osc(sc.ctx, 'sawtooth', f0);
    o.frequency.setValueAtTime(f0, t + 0.04);
    o.frequency.exponentialRampToValueAtTime(f0 * 2.5, t + 0.3);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.82, t + 1.15);
    const bp = filter(sc.ctx, 'bandpass', high ? 900 : 500, 1.6);
    bp.frequency.setValueAtTime(high ? 900 : 500, t + 0.04);
    bp.frequency.linearRampToValueAtTime(high ? 1700 : 980, t + 0.35);
    bp.frequency.linearRampToValueAtTime(high ? 700 : 380, t + 1.15);
    const am = sc.ctx.createGain();
    am.gain.value = 0.7;
    const lfo = osc(sc.ctx, 'square', high ? 34 : 27);
    const lg = sc.ctx.createGain();
    lg.gain.value = 0.3;
    lfo.connect(lg);
    lg.connect(am.gain);
    const g = sc.ctx.createGain();
    g.gain.value = EPS;
    const end = shapeEnv(g.gain, t + 0.04, high ? 0.2 : 0.26, 0.05, 0.45, 0.65);
    o.connect(bp);
    bp.connect(am);
    am.connect(g);
    g.connect(rv.gain);
    o.start(t + 0.04);
    lfo.start(t + 0.04);
    o.stop(end + 0.05);
    lfo.stop(end + 0.05);
    sc.voices.add(rv, lfo);
    sc.voices.add(rv, o, true);
    if (high) {
      // an overhead whoosh: a bandpassed noise sweeping up as the head passes over the platforms
      const wv = sc.voices.create(t + 0.05);
      wv.gain.gain.value = 1;
      this.burst(wv, t + 0.05, 'bandpass', 500, 2600, 0.5, 0.15, 0.12, 1.4);
    }
    // HOLD: the head slams into the centre (thump + shockwave sweep)
    const hv = sc.voices.create(t + HOLD_DELAY);
    hv.gain.gain.value = 1;
    this.glide(hv, t + HOLD_DELAY, 'sine', high ? 110 : 82, high ? 44 : 30, 0.7, high ? 0.4 : 0.5, 0.004);
    this.burst(hv, t + HOLD_DELAY, 'lowpass', 1400, 120, 0.6, high ? 0.16 : 0.2, 0.004, 0.7);
    // RETREAT: a receding rumble
    const dv = sc.voices.create(t + RETREAT_DELAY);
    dv.gain.gain.value = 1;
    this.burst(dv, t + RETREAT_DELAY, 'lowpass', 300, 60, 1.1, 0.2, 0.15, 0.7);
    this.glide(dv, t + RETREAT_DELAY, 'sawtooth', 62, 36, 1.0, 0.08, 0.12, 240);
  }

  /** The head hit a fighter: a crunch and a thud. `gain` = the engine's distance attenuation. Rate-limited (<= 4 / s, 80 ms apart). */
  hit(gain = 1): void {
    if (!this.started || gain < 0.03) return;
    const t = this.now;
    if (t - this.lastHit < HIT_MIN_GAP) return;
    this.hitWindow = this.hitWindow.filter((x) => t - x < 1);
    if (this.hitWindow.length >= HIT_MAX_PER_S) return;
    this.hitWindow.push(t);
    this.lastHit = t;
    const sc = this.sc;
    const v = sc.voices.create(t);
    v.gain.gain.value = Math.max(EPS, hitLevel(gain));
    this.glide(v, t, 'sine', 130, 42, 0.3, 0.36, 0.003);
    this.burst(v, t, 'bandpass', 1100, 400, 0.16, 0.22, 0.002, 1.2);
    this.noteCombat(0.3);
  }

  /**
   * A fighter landed hard (fall damage): a body thud, a dry crunch and a short grunt. `gain` = the engine's distance attenuation.
   * Rate-limited (>= 120 ms apart, <= 3 per second).
   */
  fall(gain = 1): void {
    if (!this.started || gain < 0.03) return;
    const t = this.now;
    if (t - this.lastFall < FALL_MIN_GAP) return;
    this.fallWindow = this.fallWindow.filter((x) => t - x < 1);
    if (this.fallWindow.length >= FALL_MAX_PER_S) return;
    this.fallWindow.push(t);
    this.lastFall = t;
    const sc = this.sc;
    const v = sc.voices.create(t);
    v.gain.gain.value = Math.max(EPS, fallLevel(gain));
    // thud
    this.glide(v, t, 'sine', 98, 34, 0.3, 0.36, 0.003);
    // crunch (dry, mid band)
    this.burst(v, t, 'bandpass', 760, 230, 0.13, 0.2, 0.002, 1.1);
    // "ugh": a short, falling, filtered saw grunt a hair after the impact
    const gv = sc.voices.create(t + 0.03);
    gv.gain.gain.value = Math.max(EPS, fallLevel(gain));
    const o = osc(sc.ctx, 'sawtooth', 182);
    o.frequency.setValueAtTime(182, t + 0.03);
    o.frequency.exponentialRampToValueAtTime(96, t + 0.23);
    const bp = filter(sc.ctx, 'bandpass', 560, 1.8);
    bp.frequency.setValueAtTime(620, t + 0.03);
    bp.frequency.linearRampToValueAtTime(380, t + 0.23);
    const g = sc.ctx.createGain();
    g.gain.value = EPS;
    const end = shapeEnv(g.gain, t + 0.03, 0.13, 0.02, 0.07, 0.12);
    o.connect(bp);
    bp.connect(g);
    g.connect(gv.gain);
    o.start(t + 0.03);
    o.stop(end + 0.03);
    sc.voices.add(gv, o, true);
    this.noteCombat(0.2);
  }

  /** Bubbles rising from a fallen fighter (the Ocean Dome has no crowd). */
  flush(): void {
    if (!this.started) return;
    this.bubbles(this.now, 7);
  }

  // ── Ticking ────────────────────────────────────────────────────────────────

  private tick(): void {
    if (!this.started) return;
    const nowMs = performance.now();
    const dt = Math.min(0.5, Math.max(0, (nowMs - this.lastTick) / 1000));
    this.lastTick = nowMs;
    this.combat = Math.max(0, this.combat - dt / COMBAT_DECAY_S);
    const t = this.now;
    if (this.bed !== null) this.bed.gain.setTargetAtTime(1 - 0.6 * this.combat, t, 0.25);
    if (this.combat < 0.7 && nowMs >= this.nextBubble) {
      this.bubbles(t + 0.02, 1 + Math.floor(Math.random() * 4));
      this.nextBubble = nowMs + 900 + Math.random() * 3200;
    }
    if (this.combat < 0.4 && nowMs >= this.nextWhale) {
      this.whale(t + 0.05);
      this.nextWhale = nowMs + 14000 + Math.random() * 16000;
    }
    if (this.combat < 0.5 && nowMs >= this.nextPing) {
      this.ping(t + 0.05);
      this.nextPing = nowMs + 18000 + Math.random() * 22000;
    }
    void this.listener;
  }
}
