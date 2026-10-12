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
 *
 * The colosseum and the jungle never construct / start this module (AudioEngine gates on `getRenderArena().id === 'ocean'`).
 */

import { EPS, filter, noiseSource, osc, shapeEnv, type SynthCtx } from './synth';
import type { ListenerFn } from './jungle';

const TICK_MS = 125;
const COMBAT_DECAY_S = 3;
const WARN_MIN_GAP = 1.5;
const STRIKE_MIN_GAP = 1.5;
const HIT_MIN_GAP = 0.08;
const HIT_MAX_PER_S = 4;
/** Seconds after the strike begins that the HOLD thump / the RETREAT rumble land (config/serpent.ts: strikeS 0.44, holdS 0.35). */
const HOLD_DELAY = 0.44;
const RETREAT_DELAY = 0.79;

/** Pure: level of a serpent hit sound (0..1) for the engine's distance gain; inaudible far away. */
export function hitLevel(gain: number): number {
  return Math.min(1, Math.max(0, gain));
}

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
  private lastWarn = -10;
  private lastStrike = -10;
  private lastHit = -10;
  private hitWindow: number[] = [];

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

  /** The serpent warning: a klaxon, a deep growl and a rising rumble. Rate-limited. */
  warning(): void {
    if (!this.started) return;
    const t = this.now;
    if (t - this.lastWarn < WARN_MIN_GAP) return;
    this.lastWarn = t;
    this.noteCombat(0.5);
    const sc = this.sc;
    // klaxon: three falling square pulses
    for (let k = 0; k < 3; k++) {
      const tt = t + k * 0.34;
      const v = sc.voices.create(tt);
      v.gain.gain.value = 0.9;
      this.glide(v, tt, 'square', 540, 392, 0.27, 0.085, 0.012, 1500);
    }
    // growl: a sawtooth sliding up with a fast tremolo, through a low filter
    const v = sc.voices.create(t);
    v.gain.gain.value = 1;
    const o = osc(sc.ctx, 'sawtooth', 52);
    o.frequency.setValueAtTime(52, t);
    o.frequency.exponentialRampToValueAtTime(81, t + 1.05);
    const lp = filter(sc.ctx, 'lowpass', 300, 0.9);
    const am = sc.ctx.createGain();
    am.gain.value = 0.6;
    const lfo = osc(sc.ctx, 'sine', 11);
    const lg = sc.ctx.createGain();
    lg.gain.value = 0.4;
    lfo.connect(lg);
    lg.connect(am.gain);
    const g = sc.ctx.createGain();
    g.gain.value = EPS;
    const end = shapeEnv(g.gain, t, 0.2, 0.25, 0.5, 0.45);
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
    this.burst(r, t, 'lowpass', 90, 260, 1.1, 0.13, 0.9, 0.7);
  }

  /** The head breaks through: glass shatter, heavy crash, roar; then the hold thump and the retreat rumble. Rate-limited. */
  strike(): void {
    if (!this.started) return;
    const t = this.now;
    if (t - this.lastStrike < STRIKE_MIN_GAP) return;
    this.lastStrike = t;
    this.noteCombat(1);
    const sc = this.sc;
    // glass shatter: a bright burst plus a scatter of shard ticks
    const gv = sc.voices.create(t);
    gv.gain.gain.value = 1;
    this.burst(gv, t, 'highpass', 3600, 3600, 0.3, 0.17, 0.002, 0.6);
    for (let i = 0; i < 7; i++) {
      const tt = t + 0.03 + Math.random() * 0.4;
      const sv = sc.voices.create(tt);
      sv.gain.gain.value = 1;
      this.burst(sv, tt, 'bandpass', 4800 + Math.random() * 3500, 3000, 0.045, 0.05 + Math.random() * 0.03, 0.001, 3);
    }
    // heavy crash + thump
    const cv = sc.voices.create(t);
    cv.gain.gain.value = 1;
    this.burst(cv, t, 'lowpass', 1100, 160, 0.7, 0.3, 0.004, 0.8);
    this.glide(cv, t, 'sine', 66, 28, 0.55, 0.42, 0.004);
    // roar: a sawtooth with a formant sweep and fast amplitude roughness
    const rv = sc.voices.create(t + 0.04);
    rv.gain.gain.value = 1;
    const o = osc(sc.ctx, 'sawtooth', 85);
    o.frequency.setValueAtTime(85, t + 0.04);
    o.frequency.exponentialRampToValueAtTime(215, t + 0.3);
    o.frequency.exponentialRampToValueAtTime(70, t + 1.15);
    const bp = filter(sc.ctx, 'bandpass', 500, 1.6);
    bp.frequency.setValueAtTime(500, t + 0.04);
    bp.frequency.linearRampToValueAtTime(980, t + 0.35);
    bp.frequency.linearRampToValueAtTime(380, t + 1.15);
    const am = sc.ctx.createGain();
    am.gain.value = 0.7;
    const lfo = osc(sc.ctx, 'square', 27);
    const lg = sc.ctx.createGain();
    lg.gain.value = 0.3;
    lfo.connect(lg);
    lg.connect(am.gain);
    const g = sc.ctx.createGain();
    g.gain.value = EPS;
    const end = shapeEnv(g.gain, t + 0.04, 0.26, 0.05, 0.45, 0.65);
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
    // HOLD: the head slams into the centre (thump + shockwave sweep)
    const hv = sc.voices.create(t + HOLD_DELAY);
    hv.gain.gain.value = 1;
    this.glide(hv, t + HOLD_DELAY, 'sine', 82, 30, 0.7, 0.5, 0.004);
    this.burst(hv, t + HOLD_DELAY, 'lowpass', 1400, 120, 0.6, 0.2, 0.004, 0.7);
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
