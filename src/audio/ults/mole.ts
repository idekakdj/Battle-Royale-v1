/**
 * Mole — Sinkhole Vortex audio (v1.3). ADDED to the generic ultimate stinger.
 *
 *  cast      dig-in scrabbling (noise bursts) + a low RUMBLE that swells while the mole tunnels, and a crackling
 *            sweep for the tremor crack racing to the zone
 *  stage 1   the pit opens: deep boom, then the SUCKING WHOOSH — a low-passed noise bed whose cutoff rises and
 *            wobbles with the swirl (AM) for the whole 2 s vortex, over a trembling sub rumble
 *  stage 2   COLLAPSE boom: sub thud, crash, falling debris rattle; the bed is cut
 * Sustained beds are tracked per caster so an aborted cast (death) fades them out (`onEnd`).
 */

import { MOLE_VORTEX as K } from '../../config/ultimates/mole';
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

function tone(a: UltAudioApi, t0: number, type: OscillatorType, f0: number, f1: number, peak: number, attack: number, hold: number, release: number, lp?: number, trem?: { hz: number; depth: number }): GainNode {
  const { sc, synth } = a;
  const v = sc.voices.create(t0);
  v.gain.gain.value = 1;
  const o = synth.osc(sc.ctx, type, f0);
  const total = attack + hold + release;
  o.frequency.setValueAtTime(f0, t0);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + total);
  let node: AudioNode = o;
  if (lp !== undefined) {
    const f = synth.filter(sc.ctx, 'lowpass', lp, 0.7);
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

const moleAudio: UltAudio = {
  onTarget(a, ev) {
    const g = a.gainAt(ev.from);
    if (g < 0.04) return;
    const t0 = a.now;
    // Dig-in: scrabbling claws.
    for (let i = 0; i < 5; i++) noise(a, t0 + 0.02 + i * 0.075, 'bandpass', 1100 - i * 90, 500, 1.3, 0.4 * g, 0.006, 0.02, 0.07);
    // Underground rumble that swells while the mole tunnels.
    const w = Math.max(0.6, ev.windup);
    const g1 = tone(a, t0 + 0.1, 'sine', 52, 66, 0.55 * g, w * 0.45, w * 0.4, 0.3, 140, { hz: 9, depth: 0.35 });
    const g2 = noise(a, t0 + 0.1, 'lowpass', 160, 380, 0.6, 0.4 * g, w * 0.5, w * 0.35, 0.25);
    // The tremor crack racing out: a crackling band sweep.
    noise(a, t0 + K.digS, 'bandpass', 280, 1900, 1.1, 0.42 * g, K.crackS * 0.6, 0.05, K.crackS * 0.35, { hz: 24, depth: 0.6 });
    beds.set(ev.fighterId, { gains: [g1, g2], until: t0 + w + 0.4 });
  },

  onStage(a, ev) {
    const g = a.gainAt(ev.pos);
    if (g < 0.04) return;
    const t0 = a.now;
    if (ev.stage === 1) {
      // The ground gives way, then the pit starts to suck.
      tone(a, t0, 'sine', 95, 34, 0.95 * g, 0.006, 0.06, 0.5, 260);
      noise(a, t0, 'lowpass', 1800, 260, 0.6, 0.6 * g, 0.01, 0.06, 0.45);
      const v = K.vortexS;
      const bed = noise(a, t0 + 0.1, 'lowpass', 240, 1700, 1.0, 0.5 * g, 0.45, v - 0.85, 0.4, { hz: 6.5, depth: 0.45 });
      const sub = tone(a, t0 + 0.1, 'sine', 46, 62, 0.4 * g, 0.4, v - 0.7, 0.3, 120, { hz: 11, depth: 0.4 });
      const hiss = noise(a, t0 + 0.2, 'bandpass', 500, 2600, 0.8, 0.14 * g, 0.6, v - 1.1, 0.4, { hz: 6.5, depth: 0.6 });
      beds.set(ev.fighterId, { gains: [bed, sub, hiss], until: t0 + v + 0.3 });
      return;
    }
    if (ev.stage === 2) {
      stopBed(a, ev.fighterId, 0.08);
      tone(a, t0, 'sine', 110, 26, 1.05 * g, 0.004, 0.08, 0.55, 300);
      noise(a, t0, 'lowpass', 2200, 200, 0.6, 0.8 * g, 0.004, 0.08, 0.6);
      noise(a, t0 + 0.05, 'bandpass', 1400, 400, 0.9, 0.35 * g, 0.01, 0.06, 0.4);
      for (let i = 0; i < 5; i++) noise(a, t0 + 0.12 + i * 0.09, 'bandpass', 1800 - i * 200, 700, 1.4, 0.2 * g, 0.004, 0.015, 0.06); // falling debris
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

export default moleAudio;
