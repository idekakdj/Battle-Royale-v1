/**
 * EXAMPLE per-animal ultimate audio module (v1.3 WP-T). NOT registered (leading
 * underscore). To make a real one copy it to `src/audio/ults/<animal>.ts`
 * (`lion.ts`, `panther.ts`, …) and keep `export default`.
 *
 * Hooks (all optional) get an `UltAudioApi`: `a.sc` (the shared SynthCtx: AudioContext,
 * sfx bus, voice manager, cached noise), `a.now`, `a.gainAt(pos)` (distance
 * attenuation), `a.isListener(id)` and `a.synth` (`shapeEnv`, `noiseSource`,
 * `filter`, `osc`, `makeLFO`, `EPS`). Sounds are ADDED to the existing ultimate
 * stinger/roar; keep envelopes click-free (start and end at `EPS`).
 *
 * This example: a rising "lock-on" shimmer on target, a heavy thump per stage beat.
 */

import type { UltAudio } from './index';

const example: UltAudio = {
  onTarget(a, ev) {
    const g = a.gainAt(ev.from);
    if (g < 0.04) return;
    const { sc, synth } = a;
    const t0 = a.now;
    const v = sc.voices.create(t0);
    v.gain.gain.value = Math.max(synth.EPS, 0.5 * g);
    const o = synth.osc(sc.ctx, 'sawtooth', 220);
    o.frequency.setValueAtTime(220, t0);
    o.frequency.exponentialRampToValueAtTime(880, t0 + Math.max(0.2, ev.windup));
    const lp = synth.filter(sc.ctx, 'lowpass', 1400, 0.8);
    const eg = sc.ctx.createGain();
    eg.gain.value = synth.EPS;
    const end = synth.shapeEnv(eg.gain, t0, 0.3, 0.08, Math.max(0.1, ev.windup - 0.2), 0.15);
    o.connect(lp);
    lp.connect(eg);
    eg.connect(v.gain);
    o.start(t0);
    o.stop(end + 0.05);
    sc.voices.add(v, o, true);
  },

  onStage(a, ev) {
    const g = a.gainAt(ev.pos);
    if (g < 0.04) return;
    const { sc, synth } = a;
    const t0 = a.now;
    const v = sc.voices.create(t0);
    v.gain.gain.value = Math.max(synth.EPS, 0.8 * g);
    const o = synth.osc(sc.ctx, 'sine', 120);
    o.frequency.setValueAtTime(120, t0);
    o.frequency.exponentialRampToValueAtTime(48, t0 + 0.18);
    const eg = sc.ctx.createGain();
    eg.gain.value = synth.EPS;
    const end = synth.shapeEnv(eg.gain, t0, 0.6, 0.004, 0.03, 0.22);
    o.connect(eg);
    eg.connect(v.gain);
    o.start(t0);
    o.stop(end + 0.05);
    sc.voices.add(v, o, true);
  },
};

export default example;
