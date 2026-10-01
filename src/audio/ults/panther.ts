/**
 * Panther — Shadow Execution audio (v1.3 Phase 2). Added on top of the shared ultimate stinger:
 *  - lock-on: a breathy whisper / hiss as the panther melts into shadow (high-passed noise swell + faint sub breath)
 *  - each blink: a "thwip" (band-passed noise swept down + a tiny sine blip), positioned at the landing spot
 *  - stages 1..5: a slash (rising band-passed noise) on the claw contact, pitched a little higher each strike
 *  - stage 6: the heavy two-paw finisher (low whoosh + slam thump)
 *  - stage 7: the EXECUTE thump (deep sine drop, crack, a rising shimmer)
 *  - stage 8: a soft exhale as it steps out of the shadow
 * Every voice is envelope-shaped (starts/ends at EPS), so nothing clicks.
 */

import type { Voice } from '../synth';
import type { UltAudio, UltAudioApi } from './index';

function tone(
  a: UltAudioApi,
  v: Voice,
  type: OscillatorType,
  f0: number,
  f1: number,
  t0: number,
  dur: number,
  peak: number,
  attack: number,
  terminal = false,
): void {
  const { sc, synth } = a;
  const o = synth.osc(sc.ctx, type, f0);
  o.frequency.setValueAtTime(f0, t0);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
  const eg = sc.ctx.createGain();
  eg.gain.value = synth.EPS;
  const end = synth.shapeEnv(eg.gain, t0, peak, attack, Math.max(0, dur - attack - dur * 0.5), dur * 0.5);
  o.connect(eg);
  eg.connect(v.gain);
  o.start(t0);
  o.stop(end + 0.05);
  sc.voices.add(v, o, terminal);
}

function noise(
  a: UltAudioApi,
  v: Voice,
  ft: BiquadFilterType,
  f0: number,
  f1: number,
  q: number,
  t0: number,
  dur: number,
  peak: number,
  attack: number,
  terminal = false,
): void {
  const { sc, synth } = a;
  const n = synth.noiseSource(sc);
  const f = synth.filter(sc.ctx, ft, f0, q);
  f.frequency.setValueAtTime(f0, t0);
  f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
  const eg = sc.ctx.createGain();
  eg.gain.value = synth.EPS;
  const end = synth.shapeEnv(eg.gain, t0, peak, attack, Math.max(0, dur - attack - dur * 0.5), dur * 0.5);
  n.connect(f);
  f.connect(eg);
  eg.connect(v.gain);
  n.start(t0);
  n.stop(end + 0.05);
  sc.voices.add(v, n, terminal);
}

const pantherAudio: UltAudio = {
  onTarget(a, ev) {
    const g = a.gainAt(ev.from);
    if (g < 0.04) return;
    const t0 = a.now;
    const v = a.sc.voices.create(t0);
    v.gain.gain.value = Math.max(a.synth.EPS, 0.6 * g);
    // Whisper / hiss: a soft swell of sibilant noise, plus a faint low breath.
    noise(a, v, 'highpass', 3200, 5200, 0.7, t0, 0.55, 0.42, 0.18);
    noise(a, v, 'bandpass', 2400, 1500, 2.5, t0 + 0.05, 0.5, 0.22, 0.15);
    tone(a, v, 'sine', 90, 55, t0, 0.5, 0.25, 0.15, true);
  },

  onBlink(a, ev) {
    const g = a.gainAt(ev.to);
    if (g < 0.04) return;
    const t0 = a.now;
    const v = a.sc.voices.create(t0);
    v.gain.gain.value = Math.max(a.synth.EPS, 0.6 * g);
    // "Thwip": a fast downward air-slice, and a small airy blip at the arrival.
    noise(a, v, 'bandpass', 3800, 900, 3.5, t0, 0.1, 0.8, 0.003);
    tone(a, v, 'sine', 1300, 320, t0, 0.08, 0.35, 0.002);
    noise(a, v, 'highpass', 2500, 2500, 0.8, t0 + 0.05, 0.08, 0.3, 0.003, true);
  },

  onStage(a, ev) {
    const g = a.gainAt(ev.pos);
    if (g < 0.04) return;
    const { synth } = a;
    const st = ev.stage;
    if (st >= 1 && st <= 5) {
      const t0 = a.now + 0.08; // claws land 0.08 s after the blink
      const v = a.sc.voices.create(t0);
      v.gain.gain.value = Math.max(synth.EPS, 0.7 * g);
      const p = 1 + 0.07 * (st - 1);
      noise(a, v, 'bandpass', 2400 * p, 6200 * p, 1.6, t0, 0.16, 0.75, 0.005);
      noise(a, v, 'bandpass', 900 * p, 500, 1.2, t0, 0.12, 0.4, 0.004);
      tone(a, v, 'triangle', 420 * p, 180, t0, 0.09, 0.3, 0.003, true);
    } else if (st === 6) {
      const t0 = a.now + 0.16; // heavy: lands 0.16 s after the blink
      const v = a.sc.voices.create(t0);
      v.gain.gain.value = Math.max(synth.EPS, 0.95 * g);
      noise(a, v, 'bandpass', 1600, 4200, 1.2, t0 - 0.12, 0.2, 0.55, 0.06);
      noise(a, v, 'lowpass', 1400, 260, 0.8, t0, 0.22, 0.7, 0.004);
      tone(a, v, 'sine', 130, 45, t0, 0.26, 0.95, 0.003, true);
    } else if (st === 7) {
      const t0 = a.now;
      const v = a.sc.voices.create(t0);
      v.gain.gain.value = Math.max(synth.EPS, 1.0 * g);
      // EXECUTE: deep thump, a crack, and a rising shimmer that resolves into the hit.
      tone(a, v, 'sine', 82, 30, t0, 0.5, 1.0, 0.004);
      noise(a, v, 'highpass', 1500, 1500, 0.7, t0, 0.14, 0.75, 0.002);
      noise(a, v, 'lowpass', 2200, 180, 0.8, t0, 0.35, 0.6, 0.004);
      tone(a, v, 'sine', 900, 2600, t0, 0.3, 0.3, 0.05, true);
    } else if (st >= 8) {
      const t0 = a.now;
      const v = a.sc.voices.create(t0);
      v.gain.gain.value = Math.max(synth.EPS, 0.45 * g);
      noise(a, v, 'lowpass', 1400, 500, 0.8, t0, 0.4, 0.5, 0.08, true);
    }
  },
};

export default pantherAudio;
