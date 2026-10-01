/**
 * Lion — Royal Hunt audio (v1.3 Phase 2). Added on top of the shared ultimate stinger:
 *  - lock-on: a low rising growl (AM-wobbled saw) while the eyes fix on the prey
 *  - stage 1 pounce: a rushing whoosh (band-passed noise swept up and back down) + a leg-drive thump
 *  - stage 2 touchdown: a body-slam thud (sine drop) + dust crunch
 *  - stages 3..6 maul: a ripping noise sweep + a tearing rasp per strike (delayed to the claw contact), the bite
 *    (stage 5) adds a jaw crunch, the double slam (stage 6) is heavier
 *  - stage 7 roar: a layered roar (formant-filtered saw pair with a growl LFO, hiss, sub thump)
 * Every voice is envelope-shaped (starts/ends at EPS), so nothing clicks.
 */

import type { Voice } from '../synth';
import type { UltAudio, UltAudioApi } from './index';

/** Oscillator voice part: frequency glide f0 → f1 over `dur`, optional filter, enveloped. Returns the end time. */
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
  filt?: { type: BiquadFilterType; f: number; q: number },
  terminal = false,
): { end: number; node: OscillatorNode } {
  const { sc, synth } = a;
  const o = synth.osc(sc.ctx, type, f0);
  o.frequency.setValueAtTime(f0, t0);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
  const eg = sc.ctx.createGain();
  eg.gain.value = synth.EPS;
  const end = synth.shapeEnv(eg.gain, t0, peak, attack, Math.max(0, dur - attack - dur * 0.45), dur * 0.45);
  if (filt !== undefined) {
    const f = synth.filter(sc.ctx, filt.type, filt.f, filt.q);
    o.connect(f);
    f.connect(eg);
  } else o.connect(eg);
  eg.connect(v.gain);
  o.start(t0);
  o.stop(end + 0.05);
  sc.voices.add(v, o, terminal);
  return { end, node: o };
}

/** Noise voice part through a band/low/high-pass whose frequency sweeps f0 → f1. */
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
): number {
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
  return end;
}

const lionAudio: UltAudio = {
  onTarget(a, ev) {
    const g = a.gainAt(ev.from);
    if (g < 0.04) return;
    const { sc, synth } = a;
    const t0 = a.now;
    const v = sc.voices.create(t0);
    v.gain.gain.value = Math.max(synth.EPS, 0.55 * g);
    // Low growl: a saw with a chest-rumble AM, rising slightly as the coil tightens.
    const growl = tone(a, v, 'sawtooth', 62, 84, t0, 0.62, 0.55, 0.12, { type: 'lowpass', f: 420, q: 2 });
    const lfo = synth.makeLFO(sc.ctx, v.gain.gain, 17, 0.22 * g, 'sine');
    lfo.start(t0);
    lfo.stop(growl.end + 0.05);
    sc.voices.add(v, lfo);
    noise(a, v, 'lowpass', 380, 260, 0.8, t0, 0.6, 0.2, 0.15, true);
  },

  onStage(a, ev) {
    const g = a.gainAt(ev.pos);
    if (g < 0.04) return;
    const { sc, synth } = a;
    const st = ev.stage;
    if (st === 1) {
      const t0 = a.now;
      const v = sc.voices.create(t0);
      v.gain.gain.value = Math.max(synth.EPS, 0.8 * g);
      tone(a, v, 'sine', 120, 55, t0, 0.14, 0.9, 0.004);
      noise(a, v, 'bandpass', 500, 2600, 1.1, t0, 0.22, 0.5, 0.05);
      noise(a, v, 'bandpass', 2600, 650, 1.1, t0 + 0.2, 0.3, 0.4, 0.08, true);
    } else if (st === 2) {
      const t0 = a.now;
      const v = sc.voices.create(t0);
      v.gain.gain.value = Math.max(synth.EPS, 1.0 * g);
      tone(a, v, 'sine', 95, 36, t0, 0.34, 1.0, 0.003);
      noise(a, v, 'lowpass', 1800, 300, 0.7, t0, 0.22, 0.75, 0.003, true);
    } else if (st >= 3 && st <= 6) {
      const t0 = a.now + 0.09; // the claws land 0.09 s after the beat starts
      const v = sc.voices.create(t0);
      const heavy = st >= 5 ? 1.25 : 1;
      v.gain.gain.value = Math.max(synth.EPS, 0.75 * g * heavy);
      const pitch = st === 3 ? 1 : st === 4 ? 1.12 : 0.9;
      noise(a, v, 'bandpass', 4200 * pitch, 900 * pitch, 2.2, t0, 0.16, 0.8, 0.004);
      tone(a, v, 'sawtooth', 170 * pitch, 80, t0, 0.12, 0.45, 0.004, { type: 'lowpass', f: 900, q: 1 });
      if (st === 5) {
        // Jaws snap shut: a dry crunch.
        noise(a, v, 'highpass', 1800, 1800, 0.8, t0 + 0.02, 0.05, 0.5, 0.002);
        tone(a, v, 'square', 130, 52, t0 + 0.01, 0.1, 0.5, 0.002, { type: 'lowpass', f: 600, q: 1 }, true);
      } else if (st === 6) {
        tone(a, v, 'sine', 105, 40, t0, 0.28, 0.9, 0.003, undefined, true);
      } else {
        tone(a, v, 'sine', 140, 70, t0, 0.1, 0.4, 0.003, undefined, true);
      }
    } else if (st === 7) {
      const t0 = a.now + 0.05;
      const v = sc.voices.create(t0);
      v.gain.gain.value = Math.max(synth.EPS, 0.95 * g);
      // Roar: two detuned saws through formant filters, growl-modulated, with a hiss bed and a sub thump.
      const r1 = tone(a, v, 'sawtooth', 98, 78, t0, 0.95, 0.55, 0.08, { type: 'bandpass', f: 650, q: 1.6 });
      tone(a, v, 'sawtooth', 101, 80, t0, 0.95, 0.4, 0.08, { type: 'bandpass', f: 1150, q: 2.2 });
      tone(a, v, 'sawtooth', 49, 40, t0, 0.95, 0.5, 0.06, { type: 'lowpass', f: 300, q: 1 });
      const lfo = synth.makeLFO(sc.ctx, v.gain.gain, 26, 0.35 * g, 'triangle');
      lfo.start(t0);
      lfo.stop(r1.end + 0.05);
      sc.voices.add(v, lfo);
      noise(a, v, 'bandpass', 1800, 900, 0.7, t0, 0.9, 0.22, 0.08);
      tone(a, v, 'sine', 62, 34, t0 + 0.12, 0.5, 0.85, 0.01, undefined, true);
    }
  },
};

export default lionAudio;
