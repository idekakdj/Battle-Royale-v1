/**
 * Eagle — Death From Above audio (v1.3). ADDED to the generic ultimate stinger.
 *
 *  cast      three powerful wing-beat thumps (band-passed noise) under a RISING SCREECH that climbs out of sight
 *  stage 1   (commit) a two-note lock-on ping, then — scheduled for the moment the stoop starts, 0.5 s later —
 *            a sharp dive screech and the WIND RUSH: a band-passed noise sweep rising in pitch and level, with a
 *            low rising hum, peaking at the touchdown
 *  stage 2   IMPACT: body thud + crack + a dust whoosh and a feather rustle
 *  stage 0   (tracking cadence) silent
 * Every envelope starts and ends at EPS (click-free); loudness scales with the listener distance.
 */

import { EAGLE_DFA } from '../../config/ultimates/eagle';
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

/** Pitch-swept oscillator through an envelope (optionally band-filtered and vibrato-ed). */
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

const eagleAudio: UltAudio = {
  onTarget(a, ev) {
    const g = a.gainAt(ev.from);
    if (g < 0.04) return;
    const t0 = a.now;
    // Three beats of the wings.
    for (let i = 0; i < 3; i++) noise(a, t0 + 0.02 + i * 0.25, 'bandpass', 520, 240, 0.9, 0.55 * g, 0.012, 0.03, 0.14);
    // Rising screech: a saw swept upward through a formant with a fast vibrato, climbing as the eagle vanishes.
    const dur = Math.max(0.5, ev.windup);
    tone(a, t0 + 0.08, 'sawtooth', 1150, 3300, 0.3 * g, 0.12, dur * 0.6, dur * 0.3, { bp: [2100, 1.4], vibHz: 34, vibDepth: 55 });
    tone(a, t0 + 0.08, 'triangle', 1700, 4200, 0.12 * g, 0.12, dur * 0.6, dur * 0.3, { vibHz: 40, vibDepth: 70 });
  },

  onStage(a, ev) {
    if (ev.stage === 0) return;
    const g = a.gainAt(ev.pos);
    if (g < 0.04) return;
    const t0 = a.now;
    if (ev.stage === 1) {
      // Lock-on ping: two short rising notes.
      tone(a, t0, 'sine', 1480, 1480, 0.26 * g, 0.004, 0.05, 0.1);
      tone(a, t0 + 0.13, 'sine', 1976, 1976, 0.26 * g, 0.004, 0.05, 0.12);
      // The stoop begins commitS later: sharp screech + wind rush building to the touchdown.
      const ts = t0 + EAGLE_DFA.commitS;
      tone(a, ts, 'sawtooth', 2900, 1700, 0.3 * g, 0.01, 0.12, 0.26, { bp: [2300, 1.6], vibHz: 52, vibDepth: 80 });
      const rush = 0.95;
      noise(a, ts, 'bandpass', 420, 2600, 0.7, 0.75 * g, rush * 0.85, 0.05, 0.12);
      noise(a, ts + 0.1, 'highpass', 1500, 5200, 0.6, 0.22 * g, rush * 0.7, 0.04, 0.08);
      tone(a, ts, 'sine', 90, 330, 0.3 * g, rush * 0.8, 0.05, 0.1, { lp: 500 });
      return;
    }
    // Impact.
    tone(a, t0, 'sine', 150, 38, 1.0 * g, 0.004, 0.05, 0.38, { lp: 420 });
    noise(a, t0, 'bandpass', 2400, 500, 0.8, 0.85 * g, 0.004, 0.03, 0.22);
    noise(a, t0 + 0.02, 'lowpass', 2600, 240, 0.5, 0.6 * g, 0.01, 0.08, 0.6);
    noise(a, t0 + 0.06, 'highpass', 3600, 2200, 0.7, 0.2 * g, 0.03, 0.05, 0.35); // feathers
  },
};

export default eagleAudio;
