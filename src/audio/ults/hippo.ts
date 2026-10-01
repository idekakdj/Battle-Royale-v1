/**
 * Hippo — Riverlord's Flood audio (v1.3). ADDED to the generic ultimate stinger.
 *
 *  cast      the BELLOW: a low vocal growl (saw through a rising lowpass, tremolo) swelling through the 0.9 s gape
 *            with a breathy rasp over it and a chesty sub
 *  stage 1   the SLAM: sub boom + crash, then RUSHING WATER — a bandpassed noise bed that surges with the wave
 *            (0.8 s) and trails off, a bubbling hiss over it, and the MUD SQUELCH: a few wet bloops as it settles
 *  stage 2   the heavy EXHALE: a breathy lowpassed noise fall + a low sigh
 * The bellow is tracked per caster so an aborted cast (death / interrupt) fades it out (`onEnd`); the water and
 * the squelches carry their own envelopes (they belong to the pool, which outlives the hippo).
 */

import { HIPPO_FLOOD as K, floodSurgeS } from '../../config/ultimates/hippo';
import type { UltAudio, UltAudioApi } from './index';

interface Bed {
  gains: GainNode[];
  until: number;
}
const beds = new Map<number, Bed>();

function noise(a: UltAudioApi, t0: number, type: BiquadFilterType, f0: number, f1: number, q: number, peak: number, attack: number, hold: number, release: number, am?: { hz: number; depth: number }): GainNode {
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
  if (am !== undefined) {
    const amg = sc.ctx.createGain();
    amg.gain.value = 1 - am.depth * 0.5;
    const lfo = synth.makeLFO(sc.ctx, amg.gain, am.hz, am.depth * 0.5);
    lfo.start(t0);
    lfo.stop(end + 0.05);
    flt.connect(amg);
    amg.connect(eg);
  } else {
    flt.connect(eg);
  }
  eg.connect(v.gain);
  n.start(t0);
  n.stop(end + 0.05);
  sc.voices.add(v, n, true);
  return v.gain;
}

function tone(a: UltAudioApi, t0: number, type: OscillatorType, f0: number, f1: number, peak: number, attack: number, hold: number, release: number, lp?: number, lp1?: number, trem?: { hz: number; depth: number }): GainNode {
  const { sc, synth } = a;
  const v = sc.voices.create(t0);
  v.gain.gain.value = 1;
  const o = synth.osc(sc.ctx, type, f0);
  const total = attack + hold + release;
  o.frequency.setValueAtTime(f0, t0);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + total);
  let node: AudioNode = o;
  if (lp !== undefined) {
    const f = synth.filter(sc.ctx, 'lowpass', lp, 0.8);
    if (lp1 !== undefined) {
      f.frequency.setValueAtTime(lp, t0);
      f.frequency.exponentialRampToValueAtTime(Math.max(40, lp1), t0 + total);
    }
    node.connect(f);
    node = f;
  }
  const eg = sc.ctx.createGain();
  eg.gain.value = synth.EPS;
  const end = synth.shapeEnv(eg.gain, t0, peak, attack, hold, release);
  if (trem !== undefined) {
    const amg = sc.ctx.createGain();
    amg.gain.value = 1 - trem.depth * 0.5;
    const lfo = synth.makeLFO(sc.ctx, amg.gain, trem.hz, trem.depth * 0.5);
    lfo.start(t0);
    lfo.stop(end + 0.05);
    node.connect(amg);
    amg.connect(eg);
  } else {
    node.connect(eg);
  }
  eg.connect(v.gain);
  o.start(t0);
  o.stop(end + 0.05);
  sc.voices.add(v, o, true);
  return v.gain;
}

const hippoAudio: UltAudio = {
  onTarget(a, ev) {
    const g = a.gainAt(ev.from);
    if (g < 0.04) return;
    const t0 = a.now;
    const w = Math.max(0.6, ev.windup);
    // The bellow: rears up (rising pitch, opening formant), then a long heaving roar at the top of the gape.
    const g1 = tone(a, t0 + 0.05, 'sawtooth', 78, 132, 0.55 * g, w * 0.5, w * 0.3, 0.22, 420, 1500, { hz: 7.5, depth: 0.4 });
    const g2 = tone(a, t0 + 0.05, 'square', 39, 66, 0.4 * g, w * 0.5, w * 0.3, 0.22, 160, 320, { hz: 5.2, depth: 0.3 });
    const g3 = noise(a, t0 + 0.2, 'bandpass', 500, 1500, 0.9, 0.3 * g, w * 0.45, w * 0.25, 0.25, { hz: 13, depth: 0.5 });
    beds.set(ev.fighterId, { gains: [g1, g2, g3], until: t0 + w + 0.4 });
  },

  onStage(a, ev) {
    const g = a.gainAt(ev.pos);
    if (g < 0.04) return;
    const t0 = a.now;
    if (ev.stage === 1) {
      stopBed(a, ev.fighterId, 0.05);
      // SLAM: both forefeet hit the sand.
      tone(a, t0, 'sine', 92, 26, 1.0 * g, 0.004, 0.07, 0.5, 280);
      noise(a, t0, 'lowpass', 2400, 240, 0.6, 0.75 * g, 0.004, 0.07, 0.5);
      noise(a, t0 + 0.02, 'bandpass', 1500, 450, 0.9, 0.3 * g, 0.006, 0.05, 0.3);
      // RUSHING WATER: surges with the wave head, then drains away.
      const surge = floodSurgeS(K.length);
      noise(a, t0 + 0.05, 'bandpass', 380, 2600, 0.7, 0.55 * g, surge * 0.45, surge * 0.4, 0.75, { hz: 9, depth: 0.35 });
      noise(a, t0 + 0.1, 'highpass', 1800, 4200, 0.6, 0.16 * g, surge * 0.5, surge * 0.35, 0.8, { hz: 17, depth: 0.6 });
      tone(a, t0 + 0.05, 'sine', 48, 38, 0.4 * g, surge * 0.4, surge * 0.4, 0.5, 120);
      // MUD SQUELCH: wet bloops as the water soaks into the sand.
      for (let i = 0; i < 6; i++) {
        const tt = t0 + surge * 0.6 + 0.18 + i * 0.13 + (i % 2) * 0.03;
        tone(a, tt, 'sine', 300 - i * 18, 110, 0.22 * g, 0.004, 0.01, 0.06 + (i % 3) * 0.02, 900);
        noise(a, tt, 'lowpass', 900, 260, 0.9, 0.12 * g, 0.004, 0.01, 0.08);
      }
      return;
    }
    if (ev.stage === 2) {
      // The heavy exhale.
      noise(a, t0, 'lowpass', 1100, 260, 0.6, 0.3 * g, 0.12, 0.15, 0.5, { hz: 6, depth: 0.25 });
      tone(a, t0, 'sine', 120, 62, 0.3 * g, 0.1, 0.2, 0.4, 300);
    }
  },

  onEnd(a, fighterId) {
    stopBed(a, fighterId, 0.12);
  },

  dispose() {
    beds.clear();
  },
};

/** Fade out whatever sustained voices the caster still has running. */
function stopBed(a: UltAudioApi, id: number, fade: number): void {
  const b = beds.get(id);
  if (b === undefined) return;
  beds.delete(id);
  const t = a.now;
  if (t >= b.until) return;
  for (const gn of b.gains) {
    try {
      const cur = Math.max(gn.gain.value, a.synth.EPS);
      gn.gain.cancelScheduledValues(t);
      gn.gain.setValueAtTime(cur, t);
      gn.gain.exponentialRampToValueAtTime(a.synth.EPS, t + fade);
    } catch {
      /* voice already torn down */
    }
  }
}

export default hippoAudio;
