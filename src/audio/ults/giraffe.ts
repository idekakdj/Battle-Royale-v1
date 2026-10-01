/**
 * Giraffe — Timber Fall audio (v1.3). ADDED to the generic ultimate stinger.
 *
 *  cast      the neck CREAKS back: a slow groaning wooden creak (a low saw sweeping up through a narrow band-pass with a
 *            slow wobble, a rope-like stretch of noise) while a low airy WHOOSH of the neck swinging up builds
 *  stage 1   (commit) a dry two-tick "lock" knock and a low rising tension hum, scheduled to peak at the slam, 0.5 s later
 *  stage 2   SLAM: a sharp whoosh peaking right at the thud, a huge sub thud, the crack of splitting timber, a rolling dust
 *            rumble and a scatter of debris
 *  stage 0   (tracking cadence) silent
 * Every envelope starts and ends at EPS (click-free); loudness scales with the listener distance.
 */

import { GIRAFFE_TIMBER } from '../../config/ultimates/giraffe';
import type { UltAudio, UltAudioApi } from './index';

/** Band-passed / low-passed noise burst with a swept centre frequency. */
function noise(a: UltAudioApi, t0: number, type: BiquadFilterType, f0: number, f1: number, q: number, peak: number, attack: number, hold: number, release: number): void {
  const { sc, synth } = a;
  const v = sc.voices.create(t0);
  v.gain.gain.value = 1;
  const n = synth.noiseSource(sc);
  const flt = synth.filter(sc.ctx, type, f0, q);
  const total = attack + hold + release;
  flt.frequency.setValueAtTime(f0, t0);
  flt.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + total);
  const eg = sc.ctx.createGain();
  eg.gain.value = synth.EPS;
  const end = synth.shapeEnv(eg.gain, t0, peak, attack, hold, release);
  n.connect(flt);
  flt.connect(eg);
  eg.connect(v.gain);
  n.start(t0);
  n.stop(end + 0.05);
  sc.voices.add(v, n, true);
}

/** Pitch-swept oscillator through an envelope (optionally band-filtered and wobbled). */
function tone(
  a: UltAudioApi, t0: number, type: OscillatorType, f0: number, f1: number, peak: number,
  attack: number, hold: number, release: number, opts?: { lp?: number; bp?: [number, number]; vibHz?: number; vibDepth?: number },
): void {
  const { sc, synth } = a;
  const v = sc.voices.create(t0);
  v.gain.gain.value = 1;
  const o = synth.osc(sc.ctx, type, f0);
  const total = attack + hold + release;
  o.frequency.setValueAtTime(f0, t0);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + total);
  let node: AudioNode = o;
  if (opts?.bp !== undefined) {
    const bp = synth.filter(sc.ctx, 'bandpass', opts.bp[0], opts.bp[1]);
    node.connect(bp);
    node = bp;
  }
  if (opts?.lp !== undefined) {
    const lp = synth.filter(sc.ctx, 'lowpass', opts.lp, 0.7);
    node.connect(lp);
    node = lp;
  }
  const eg = sc.ctx.createGain();
  eg.gain.value = synth.EPS;
  const end = synth.shapeEnv(eg.gain, t0, peak, attack, hold, release);
  node.connect(eg);
  eg.connect(v.gain);
  if (opts?.vibHz !== undefined) {
    const lfo = synth.makeLFO(sc.ctx, o.frequency, opts.vibHz, opts.vibDepth ?? 30);
    lfo.start(t0);
    lfo.stop(end + 0.05);
  }
  o.start(t0);
  o.stop(end + 0.05);
  sc.voices.add(v, o, true);
}

const giraffeAudio: UltAudio = {
  onTarget(a, ev) {
    const g = a.gainAt(ev.from);
    if (g < 0.04) return;
    const t0 = a.now;
    const dur = Math.max(0.6, ev.windup);
    // Creaking neck: a saw climbing through a narrow band with a slow wobble, like a bent plank taking the load.
    tone(a, t0 + 0.04, 'sawtooth', 130, 290, 0.22 * g, 0.1, dur * 0.55, dur * 0.3, { bp: [380, 4], vibHz: 7, vibDepth: 18 });
    tone(a, t0 + 0.2, 'triangle', 240, 420, 0.1 * g, 0.12, dur * 0.4, dur * 0.3, { bp: [820, 3], vibHz: 11, vibDepth: 26 });
    // The long airy swing-up of the neck.
    noise(a, t0, 'bandpass', 260, 900, 0.7, 0.4 * g, dur * 0.3, dur * 0.2, dur * 0.4);
  },

  onStage(a, ev) {
    if (ev.stage === 0) return;
    const g = a.gainAt(ev.pos);
    if (g < 0.04) return;
    const t0 = a.now;
    if (ev.stage === 1) {
      // Lock knock: two dry wooden ticks.
      tone(a, t0, 'triangle', 340, 300, 0.26 * g, 0.003, 0.02, 0.07, { bp: [620, 3] });
      tone(a, t0 + 0.11, 'triangle', 420, 360, 0.26 * g, 0.003, 0.02, 0.08, { bp: [760, 3] });
      // Tension hum rising to the slam (commitS + slamS later).
      const rise = GIRAFFE_TIMBER.commitS + GIRAFFE_TIMBER.slamS;
      tone(a, t0 + 0.05, 'sine', 70, 190, 0.3 * g, rise * 0.8, 0.02, 0.05, { lp: 400 });
      // The downswing whoosh, timed to peak at the impact.
      noise(a, t0 + GIRAFFE_TIMBER.commitS - 0.05, 'bandpass', 500, 2200, 0.8, 0.5 * g, 0.12, 0.03, 0.05);
      return;
    }
    // Impact: sub thud, splitting timber crack, dust rumble, debris.
    tone(a, t0, 'sine', 110, 30, 1.0 * g, 0.004, 0.07, 0.5, { lp: 340 });
    noise(a, t0, 'bandpass', 2800, 420, 0.8, 0.85 * g, 0.004, 0.03, 0.24);
    tone(a, t0 + 0.01, 'sawtooth', 320, 110, 0.3 * g, 0.004, 0.03, 0.2, { bp: [700, 2.5] }); // timber splitting
    noise(a, t0 + 0.03, 'lowpass', 1900, 180, 0.5, 0.6 * g, 0.015, 0.12, 0.8);
    noise(a, t0 + 0.08, 'highpass', 3200, 1800, 0.7, 0.22 * g, 0.02, 0.06, 0.4); // debris
  },
};

export default giraffeAudio;
