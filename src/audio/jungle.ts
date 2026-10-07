/**
 * Jungle audio (v1.8, WP-J3) — 100% synthesised like the rest of the engine, shaped envelopes (no clicks), bounded polyphony
 * through the shared `VoiceManager`, every output routed through the SFX bus so master / sfx volume and mute apply automatically.
 *
 *  - AMBIENCE BED (`start`/`stop`, only started when the arena is the jungle): leaf rustle, distant water, a slow-swelling insect
 *    chorus, plus randomly scheduled bird calls (whistles, trills, chatter) and the odd frog. Very low CPU: five always-on sources;
 *    everything else is short one-shot voices scheduled from one 8 Hz timer. The bed is DUCKED under combat (`noteCombat`: hits /
 *    ultimates / deaths raise a level that decays over ~3 s; birds stay quiet while it is high).
 *  - SPLASH (`splash(strength, entering, gain)`): noise burst + low bloop + a few droplet blips scaled by the `splash` event's
 *    `strength`; rate-limited (≤ 8 per second, ≥ 50 ms apart).
 *  - SLOSH LOOPS: ≤ 3 soft filtered-noise loops follow the nearest moving swimmers (positions come from `waterActivity`, written
 *    by the render-side water FX), level/brightness scaled by swim speed and listener distance.
 *  - MOSS SQUELCH (`squelch(gain)`): a subtle wet step, throttled (≥ 140 ms apart).
 *
 * The colosseum never constructs this module (AudioEngine only starts it when `getRenderArena().id === 'jungle'`).
 */

import { waterActivity } from '../render/arenaContext';
import { EPS, filter, noiseSource, osc, shapeEnv, type SynthCtx } from './synth';

/** Listener position provider (engine supplies it; `has` false → every sound plays at full level, e.g. in demos). */
export type ListenerFn = () => { has: boolean; x: number; z: number };

export const SLOSH_VOICES = 3;
const TICK_MS = 125;
const COMBAT_DECAY_S = 3;
const SPLASH_MIN_GAP = 0.05;
const SPLASH_MAX_PER_S = 8;
const SQUELCH_MIN_GAP = 0.14;
const ACTIVITY_STALE_MS = 400;
const DIST_REF = 10;

/** Pure: slosh voice level for a swimmer (0..~0.16) from its speed and distance to the listener. */
export function sloshLevel(speed: number, distance: number): number {
  if (speed < 0.4) return 0;
  const v = Math.min(1, speed / 5);
  const att = 1 / (1 + (distance / DIST_REF) * (distance / DIST_REF));
  return 0.16 * v * att;
}

/** Pure: splash peak levels from the event strength (0..1): noise, bloop. */
export function splashLevels(strength: number, entering: boolean): { noise: number; bloop: number; dur: number } {
  const s = Math.min(1, Math.max(0, strength));
  return { noise: (0.1 + 0.32 * s) * (entering ? 1 : 0.7), bloop: (0.05 + 0.26 * s) * (entering ? 1 : 0.6), dur: 0.16 + 0.34 * s };
}

export class JungleAudio {
  private started = false;
  private timer: number | null = null;
  private lastTick = 0;
  private combat = 0;

  private bed: GainNode | null = null;
  private bedSources: AudioScheduledSourceNode[] = [];
  private readonly slosh: { gain: GainNode; bp: BiquadFilterNode; src: AudioBufferSourceNode }[] = [];

  private nextBird = 0;
  private nextFrog = 0;
  private lastSplash = -1;
  private splashWindow: number[] = [];
  private lastSquelch = -1;

  constructor(
    private readonly sc: SynthCtx,
    private readonly listener: ListenerFn,
  ) {}

  get running(): boolean {
    return this.started;
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

    const noiseLoop = (): AudioBufferSourceNode => {
      const n = noiseSource(sc);
      n.loop = true;
      return n;
    };
    // Leaf rustle: wide bandpassed noise with a slow undulation.
    const rustle = noiseLoop();
    const rbp = filter(sc.ctx, 'bandpass', 1100, 0.45);
    const rg = sc.ctx.createGain();
    rg.gain.value = 0.05;
    const rl = osc(sc.ctx, 'sine', 0.11);
    const rlg = sc.ctx.createGain();
    rlg.gain.value = 0.022;
    rl.connect(rlg);
    rlg.connect(rg.gain);
    rustle.connect(rbp);
    rbp.connect(rg);
    rg.connect(bed);
    // Distant water: lowpassed noise breathing at ~0.27 Hz.
    const water = noiseLoop();
    const wlp = filter(sc.ctx, 'lowpass', 520, 0.6);
    const wg = sc.ctx.createGain();
    wg.gain.value = 0.05;
    const wl = osc(sc.ctx, 'sine', 0.27);
    const wlg = sc.ctx.createGain();
    wlg.gain.value = 0.016;
    wl.connect(wlg);
    wlg.connect(wg.gain);
    water.connect(wlp);
    wlp.connect(wg);
    wg.connect(bed);
    // Insect chorus: two high partials amplitude-modulated in the cricket range, gated by a very slow swell.
    const swell = sc.ctx.createGain();
    swell.gain.value = 0.5;
    swell.connect(bed);
    const swellLfo = osc(sc.ctx, 'sine', 0.045);
    const swellDepth = sc.ctx.createGain();
    swellDepth.gain.value = 0.45;
    swellLfo.connect(swellDepth);
    swellDepth.connect(swell.gain);
    const insects: OscillatorNode[] = [];
    for (const [f, am, lvl] of [[3850, 17, 0.012], [5150, 23, 0.008]] as const) {
      const o = osc(sc.ctx, 'sine', f);
      const g = sc.ctx.createGain();
      g.gain.value = lvl;
      const lfo = osc(sc.ctx, 'sine', am);
      const lg = sc.ctx.createGain();
      lg.gain.value = lvl * 0.9;
      lfo.connect(lg);
      lg.connect(g.gain);
      o.connect(g);
      g.connect(swell);
      insects.push(o, lfo);
    }

    const all: AudioScheduledSourceNode[] = [rustle, rl, water, wl, swellLfo, ...insects];
    rustle.start(t0, Math.random() * 2);
    water.start(t0, Math.random() * 2);
    for (const s of all) {
      if (s !== rustle && s !== water) s.start(t0);
    }
    this.bedSources = all;

    // Slosh loops (silent until a swimmer is near).
    for (let i = 0; i < SLOSH_VOICES; i++) {
      const src = noiseLoop();
      const bp = filter(sc.ctx, 'bandpass', 520, 0.9);
      const gain = sc.ctx.createGain();
      gain.gain.value = EPS;
      src.connect(bp);
      bp.connect(gain);
      gain.connect(sc.sfxBus);
      src.start(t0, Math.random() * 2);
      this.slosh.push({ gain, bp, src });
    }

    bed.gain.setValueAtTime(EPS, t0);
    bed.gain.linearRampToValueAtTime(1, t0 + 1.8);
    this.lastTick = performance.now();
    this.nextBird = performance.now() + 900 + Math.random() * 1800;
    this.nextFrog = performance.now() + 3500 + Math.random() * 4000;
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
      bed.gain.exponentialRampToValueAtTime(EPS, t + 0.7);
    }
    for (const s of this.bedSources) {
      try {
        s.stop(t + 0.8);
      } catch {
        /* already stopped */
      }
    }
    for (const v of this.slosh) {
      v.gain.gain.cancelScheduledValues(t);
      v.gain.gain.setTargetAtTime(EPS, t, 0.08);
      try {
        v.src.stop(t + 0.6);
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
    }, 1000);
    this.bed = null;
    this.bedSources = [];
    this.slosh.length = 0;
  }

  // ── Combat ducking ─────────────────────────────────────────────────────────

  /** A fight is happening: raise the duck level (0..1 clamped); decays over ~3 s. */
  noteCombat(amount: number): void {
    this.combat = Math.min(1, this.combat + Math.max(0, amount));
  }

  /** Current duck level 0..1 (tests). */
  get combatLevel(): number {
    return this.combat;
  }

  // ── One-shots ──────────────────────────────────────────────────────────────

  /** Splash on entering / leaving the pool; `gain` = the engine's distance attenuation (0..1). */
  splash(strength: number, entering: boolean, gain = 1): void {
    if (!this.started || gain < 0.03) return;
    const t = this.now;
    if (t - this.lastSplash < SPLASH_MIN_GAP) return;
    this.splashWindow = this.splashWindow.filter((x) => t - x < 1);
    if (this.splashWindow.length >= SPLASH_MAX_PER_S) return;
    this.splashWindow.push(t);
    this.lastSplash = t;

    const sc = this.sc;
    const lv = splashLevels(strength, entering);
    const v = sc.voices.create(t);
    v.gain.gain.value = Math.max(EPS, gain);
    // Water crash: bandpassed noise sweeping down as the surface settles.
    const n = noiseSource(sc);
    const bp = filter(sc.ctx, 'bandpass', entering ? 2300 : 1700, 0.8);
    bp.frequency.setValueAtTime(entering ? 2300 : 1700, t);
    bp.frequency.exponentialRampToValueAtTime(entering ? 700 : 520, t + lv.dur);
    const ng = sc.ctx.createGain();
    ng.gain.value = EPS;
    const nEnd = shapeEnv(ng.gain, t, lv.noise, 0.006, 0.03, lv.dur);
    n.connect(bp);
    bp.connect(ng);
    ng.connect(v.gain);
    // Low "bloop" of displaced water.
    const o = osc(sc.ctx, 'sine', 260 - strength * 90);
    o.frequency.setValueAtTime(260 - strength * 90, t);
    o.frequency.exponentialRampToValueAtTime(70 + 30 * (1 - strength), t + 0.2 + 0.12 * strength);
    const og = sc.ctx.createGain();
    og.gain.value = EPS;
    const oEnd = shapeEnv(og.gain, t + 0.004, lv.bloop, 0.01, 0.02, 0.18 + 0.14 * strength);
    o.connect(og);
    og.connect(v.gain);
    const end = Math.max(nEnd, oEnd) + 0.04;
    n.start(t);
    n.stop(end);
    o.start(t);
    o.stop(end);
    sc.voices.add(v, n);
    sc.voices.add(v, o, true);
    // Droplets pattering back onto the surface.
    const drops = Math.round(1 + strength * 4);
    for (let i = 0; i < drops; i++) {
      const dt = t + 0.06 + Math.random() * (0.18 + 0.2 * strength);
      this.blip(dt, 1500 + Math.random() * 1800, 0.05 * (0.5 + strength), gain);
    }
  }

  /** A short rising water "plink". */
  private blip(t: number, f: number, level: number, gain: number): void {
    const sc = this.sc;
    const v = sc.voices.create(t);
    v.gain.gain.value = Math.max(EPS, gain);
    const o = osc(sc.ctx, 'sine', f);
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 1.5, t + 0.05);
    const g = sc.ctx.createGain();
    g.gain.value = EPS;
    const end = shapeEnv(g.gain, t, level, 0.003, 0.004, 0.05);
    o.connect(g);
    g.connect(v.gain);
    o.start(t);
    o.stop(end + 0.02);
    sc.voices.add(v, o, true);
  }

  /** Subtle wet squelch of a footstep on moss (throttled). */
  squelch(gain = 1): void {
    if (!this.started || gain < 0.05) return;
    const t = this.now;
    if (t - this.lastSquelch < SQUELCH_MIN_GAP) return;
    this.lastSquelch = t;
    const sc = this.sc;
    const v = sc.voices.create(t);
    v.gain.gain.value = Math.max(EPS, gain * 0.7);
    const n = noiseSource(sc);
    const bp = filter(sc.ctx, 'bandpass', 520, 1.6);
    bp.frequency.setValueAtTime(700, t);
    bp.frequency.exponentialRampToValueAtTime(260, t + 0.09);
    const g = sc.ctx.createGain();
    g.gain.value = EPS;
    const end = shapeEnv(g.gain, t, 0.12, 0.006, 0.012, 0.08);
    n.connect(bp);
    bp.connect(g);
    g.connect(v.gain);
    const o = osc(sc.ctx, 'sine', 150);
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(90, t + 0.07);
    const og = sc.ctx.createGain();
    og.gain.value = EPS;
    shapeEnv(og.gain, t, 0.07, 0.005, 0.01, 0.06);
    o.connect(og);
    og.connect(v.gain);
    n.start(t);
    n.stop(end + 0.02);
    o.start(t);
    o.stop(end + 0.02);
    sc.voices.add(v, n);
    sc.voices.add(v, o, true);
  }

  /** The birds startle and take off (a death / a big crash): a burst of stacked calls. */
  flush(): void {
    if (!this.started) return;
    const n = 5 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) this.bird(this.now + i * (0.04 + Math.random() * 0.08), 0.9);
  }

  // ── Ticking ────────────────────────────────────────────────────────────────

  private tick(): void {
    if (!this.started) return;
    const nowMs = performance.now();
    const dt = Math.min(0.5, Math.max(0, (nowMs - this.lastTick) / 1000));
    this.lastTick = nowMs;
    this.combat = Math.max(0, this.combat - dt / COMBAT_DECAY_S);
    const t = this.now;

    // Duck the bed under combat.
    if (this.bed !== null) this.bed.gain.setTargetAtTime(1 - 0.58 * this.combat, t, 0.25);

    // Birds and frogs (quiet while a fight is on).
    if (this.combat < 0.65 && nowMs >= this.nextBird) {
      this.bird(t + 0.02, 1 - this.combat);
      this.nextBird = nowMs + 1400 + Math.random() * 4200;
    }
    if (this.combat < 0.5 && nowMs >= this.nextFrog) {
      this.frog(t + 0.02);
      this.nextFrog = nowMs + 4500 + Math.random() * 6500;
    }

    this.updateSlosh(nowMs, t);
  }

  private updateSlosh(nowMs: number, t: number): void {
    const fresh = nowMs - waterActivity.stamp < ACTIVITY_STALE_MS;
    const lis = this.listener();
    const best: { lvl: number; speed: number }[] = [];
    if (fresh) {
      for (let i = 0; i < waterActivity.count; i++) {
        const d = lis.has ? Math.hypot(waterActivity.x[i] - lis.x, waterActivity.z[i] - lis.z) : 0;
        const lvl = sloshLevel(waterActivity.speed[i], d);
        if (lvl > 0.004) best.push({ lvl, speed: waterActivity.speed[i] });
      }
      best.sort((a, b) => b.lvl - a.lvl);
    }
    for (let i = 0; i < this.slosh.length; i++) {
      const v = this.slosh[i];
      const b = best[i];
      if (b === undefined) {
        v.gain.gain.setTargetAtTime(EPS, t, 0.12);
      } else {
        v.gain.gain.setTargetAtTime(b.lvl, t, 0.1);
        v.bp.frequency.setTargetAtTime(380 + b.speed * 110, t, 0.12);
      }
    }
  }

  // ── Calls ──────────────────────────────────────────────────────────────────

  private bird(t: number, level: number): void {
    const sc = this.sc;
    const kind = Math.floor(Math.random() * 3);
    const base = 1700 + Math.random() * 1900;
    const lvl = (0.035 + Math.random() * 0.05) * level;
    const v = sc.voices.create(t);
    v.gain.gain.value = Math.max(EPS, lvl * 6); // leaf gains below shape the actual level
    const pan = sc.ctx.createStereoPanner();
    pan.pan.value = (Math.random() * 2 - 1) * 0.85;
    pan.connect(v.gain);
    let cursor = t;
    const notes = kind === 0 ? 2 : kind === 1 ? 3 + Math.floor(Math.random() * 3) : 5 + Math.floor(Math.random() * 4);
    let last: OscillatorNode | null = null;
    for (let i = 0; i < notes; i++) {
      const f0 = base * (kind === 2 ? 0.9 + Math.random() * 0.3 : 0.8 + i * 0.12);
      const dur = kind === 0 ? 0.16 + Math.random() * 0.12 : kind === 1 ? 0.045 + Math.random() * 0.03 : 0.03 + Math.random() * 0.02;
      const o = osc(sc.ctx, 'sine', f0);
      o.frequency.setValueAtTime(f0, cursor);
      o.frequency.exponentialRampToValueAtTime(f0 * (kind === 0 ? (i % 2 === 0 ? 1.45 : 0.7) : 1.3), cursor + dur);
      const g = sc.ctx.createGain();
      g.gain.value = EPS;
      const end = shapeEnv(g.gain, cursor, lvl * 0.16, 0.008, dur * 0.4, dur * 0.7);
      o.connect(g);
      g.connect(pan);
      o.start(cursor);
      o.stop(end + 0.02);
      sc.voices.add(v, o);
      last = o;
      cursor += dur + (kind === 2 ? 0.035 : kind === 1 ? 0.045 : 0.1);
    }
    if (last !== null) sc.voices.add(v, last, true);
  }

  private frog(t: number): void {
    const sc = this.sc;
    const v = sc.voices.create(t);
    v.gain.gain.value = 0.9;
    const pan = sc.ctx.createStereoPanner();
    pan.pan.value = (Math.random() * 2 - 1) * 0.9;
    pan.connect(v.gain);
    const pulses = 2 + Math.floor(Math.random() * 3);
    const f = 130 + Math.random() * 70;
    let cursor = t;
    let last: OscillatorNode | null = null;
    for (let i = 0; i < pulses; i++) {
      const o = osc(sc.ctx, 'square', f * (1 + i * 0.06));
      const bp = filter(sc.ctx, 'bandpass', 620 + Math.random() * 250, 3);
      const g = sc.ctx.createGain();
      g.gain.value = EPS;
      const end = shapeEnv(g.gain, cursor, 0.05, 0.005, 0.02, 0.035);
      o.connect(bp);
      bp.connect(g);
      g.connect(pan);
      o.start(cursor);
      o.stop(end + 0.02);
      sc.voices.add(v, o);
      last = o;
      cursor += 0.09;
    }
    if (last !== null) sc.voices.add(v, last, true);
  }
}
