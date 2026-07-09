/**
 * Crowd bed (BLUEPRINT §13): a looping filtered-noise murmur whose intensity
 * follows an excitement value (0..1). Kill/ult events spike excitement (decay
 * back over ~5 s), and cheer swells (voicy sawtooth clusters + noise) layer on
 * top for kills, bloodlust steps, and victory.
 *
 * The bed runs continuously once started (a looping noise source is cheap);
 * `setExcitement` sets the baseline, `spike` adds a decaying boost.
 */

import { EPS, filter, makeLFO, noiseSource, osc, shapeEnv, type SynthCtx } from './synth';

/** Seconds for a full-size spike to decay back to baseline. */
const SPIKE_DECAY_S = 5;
/** How often the bed level/filters are re-targeted (ms). */
const UPDATE_MS = 100;

export class Crowd {
  private started = false;
  private baseline = 0.2;
  private spikeLevel = 0;
  private lastUpdate = 0;
  private timer: number | null = null;

  private bedGain: GainNode | null = null;
  private bedFilter: BiquadFilterNode | null = null;
  private bedSource: AudioBufferSourceNode | null = null;
  private lfo: OscillatorNode | null = null;

  constructor(private readonly sc: SynthCtx) {}

  /** Start the looping bed (idempotent). Runs at the current excitement level. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const sc = this.sc;
    const t0 = sc.ctx.currentTime;

    const src = noiseSource(sc);
    src.loop = true;
    const lp = filter(sc.ctx, 'lowpass', 800, 0.4);
    const gain = sc.ctx.createGain();
    gain.gain.value = EPS;
    // Slow undulation so the murmur never sounds static.
    const lfo = makeLFO(sc.ctx, gain.gain, 0.17, 0.02);
    src.connect(lp);
    lp.connect(gain);
    gain.connect(sc.sfxBus);

    // Fade the bed in (no click).
    gain.gain.setValueAtTime(EPS, t0);
    gain.gain.linearRampToValueAtTime(this.levelFor(this.currentExcitement()), t0 + 0.8);

    src.start(t0);
    lfo.start(t0);
    this.bedSource = src;
    this.bedFilter = lp;
    this.bedGain = gain;
    this.lfo = lfo;
    this.lastUpdate = performance.now();
    this.timer = window.setInterval(() => this.update(), UPDATE_MS);
  }

  /** Fade out and stop the bed. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const sc = this.sc;
    const t = sc.ctx.currentTime;
    const gain = this.bedGain;
    const src = this.bedSource;
    const lfo = this.lfo;
    if (gain !== null) {
      const cur = Math.max(gain.gain.value, EPS);
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(cur, t);
      gain.gain.exponentialRampToValueAtTime(EPS, t + 0.6);
    }
    if (src !== null) {
      src.stop(t + 0.7);
      src.onended = () => {
        gain?.disconnect();
      };
    }
    if (lfo !== null) lfo.stop(t + 0.7);
    this.bedSource = null;
    this.bedGain = null;
    this.bedFilter = null;
    this.lfo = null;
  }

  /** Set the baseline excitement (0..1). Spikes stack on top of this. */
  setExcitement(x: number): void {
    this.baseline = Math.min(1, Math.max(0, x));
  }

  /** Add a decaying excitement boost (kills ~0.5, ults ~0.35, etc.). */
  spike(amount: number): void {
    this.spikeLevel = Math.min(1, this.spikeLevel + Math.max(0, amount));
  }

  /** Current combined excitement (baseline + decaying spikes, clamped 0..1). */
  currentExcitement(): number {
    return Math.min(1, this.baseline + this.spikeLevel);
  }

  /**
   * Cheer swell: voicy sawtooth clusters + noise. `big` = victory / bloodlust
   * eruption (longer, louder); default = kill cheer. `delay` (s) offsets the
   * start on the audio clock (used for the death gasp→cheer sequence).
   */
  cheer(big = false, delay = 0): void {
    const sc = this.sc;
    const t0 = sc.ctx.currentTime + Math.max(0, delay);
    const v = sc.voices.create(t0);
    const dur = big ? 2.4 : 1.2;
    const level = big ? 0.5 : 0.32;

    // Noise "crowd wall": swells up then falls away.
    const n = noiseSource(sc);
    const bp = filter(sc.ctx, 'bandpass', 1100, 0.5);
    const ng = sc.ctx.createGain();
    ng.gain.value = EPS;
    shapeEnv(ng.gain, t0, level, dur * 0.25, dur * 0.2, dur * 0.55);
    n.connect(bp);
    bp.connect(ng);
    ng.connect(v.gain);

    // Voicy cluster: detuned saws through vowel-ish bandpasses, pitch rising.
    const freqs = big ? [196, 247, 294, 392] : [220, 277, 330];
    const oscs: OscillatorNode[] = [];
    for (const f of freqs) {
      const o = osc(sc.ctx, 'sawtooth', f * 0.92);
      o.frequency.setValueAtTime(f * 0.92, t0);
      o.frequency.linearRampToValueAtTime(f * 1.05, t0 + dur * 0.5);
      const vg = sc.ctx.createGain();
      vg.gain.value = EPS;
      shapeEnv(vg.gain, t0, level * 0.14, dur * 0.3, dur * 0.15, dur * 0.5);
      const vowel = filter(sc.ctx, 'bandpass', 800 + Math.random() * 500, 2.5);
      o.connect(vowel);
      vowel.connect(vg);
      vg.connect(v.gain);
      oscs.push(o);
    }

    v.gain.gain.value = 1;
    const end = t0 + dur + 0.1;
    n.start(t0);
    n.stop(end);
    for (const o of oscs) {
      o.start(t0);
      o.stop(end);
    }
    sc.voices.add(v, n, true);
    for (const o of oscs) sc.voices.add(v, o);

    // A cheer also lifts the bed for a while.
    this.spike(big ? 0.6 : 0.35);
  }

  /** Crowd gasp: quick inhale-like noise swell that cuts off (pre-cheer on death). */
  gasp(delay = 0): void {
    const sc = this.sc;
    const t0 = sc.ctx.currentTime + Math.max(0, delay);
    const v = sc.voices.create(t0);
    const n = noiseSource(sc);
    const bp = filter(sc.ctx, 'bandpass', 2000, 0.8);
    bp.frequency.setValueAtTime(1400, t0);
    bp.frequency.linearRampToValueAtTime(2600, t0 + 0.25);
    n.connect(bp);
    bp.connect(v.gain);
    const end = shapeEnv(v.gain.gain, t0, 0.26, 0.18, 0.05, 0.12);
    n.start(t0);
    n.stop(end + 0.02);
    sc.voices.add(v, n, true);
  }

  /** Whether the bed is currently running. */
  get running(): boolean {
    return this.started;
  }

  /** Map excitement (0..1) to bed gain. */
  private levelFor(x: number): number {
    return 0.03 + x * 0.24;
  }

  /** Periodic re-target of bed loudness/brightness toward current excitement. */
  private update(): void {
    const now = performance.now();
    const dt = Math.max(0, (now - this.lastUpdate) / 1000);
    this.lastUpdate = now;

    // Spikes decay linearly over SPIKE_DECAY_S.
    if (this.spikeLevel > 0) {
      this.spikeLevel = Math.max(0, this.spikeLevel - dt / SPIKE_DECAY_S);
    }

    const gain = this.bedGain;
    const lp = this.bedFilter;
    if (gain === null || lp === null) return;
    const x = this.currentExcitement();
    const t = this.sc.ctx.currentTime;
    const ramp = UPDATE_MS / 1000 + 0.05;
    // setTargetAtTime gives smooth, click-free convergence between updates.
    gain.gain.setTargetAtTime(this.levelFor(x), t, ramp);
    lp.frequency.setTargetAtTime(600 + x * 2400, t, ramp);
  }
}
