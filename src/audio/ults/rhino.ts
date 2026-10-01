/**
 * Rhino — Seismic Stampede audio (v1.3). ADDED to the generic ultimate stinger.
 *
 *  cast      SNORT + PAW: two sharp nostril blasts (bandpassed noise bursts) and three scraping paws, a low
 *            menacing growl under them while the head lowers
 *  stage 1   the CHARGE: a thundering gallop bed — sub-bass and lowpassed noise amplitude-modulated at the stride
 *            cadence (the modulation speeds up over the first half second as the rhino gets up to speed), with a
 *            rattle of hide and a gust over it; it runs for the whole charge
 *  stage 2   GORE: a wet impact, a sharp horn crack and a short pained grunt as the victim is hoisted (the gallop goes on)
 *  stage 3   CRUSH: the bed is cut; a huge boom, stone crack and falling debris rattle
 *  stage 4   SKID: the bed is cut; a gravel scrape sliding to a halt and a low blow-out
 * The gallop is tracked per caster so a death / interrupt fades it out (`onEnd`).
 */

import { RHINO_STAMPEDE as K } from '../../config/ultimates/rhino';
import type { UltAudio, UltAudioApi } from './index';

interface Bed {
  gains: GainNode[];
  until: number;
}
const beds = new Map<number, Bed>();

function noise(a: UltAudioApi, t0: number, type: BiquadFilterType, f0: number, f1: number, q: number, peak: number, attack: number, hold: number, release: number, am?: { hz0: number; hz1?: number; depth: number }): GainNode {
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
    const lfo = synth.makeLFO(sc.ctx, amg.gain, am.hz0, am.depth * 0.5);
    if (am.hz1 !== undefined) {
      lfo.frequency.setValueAtTime(am.hz0, t0);
      lfo.frequency.linearRampToValueAtTime(am.hz1, t0 + 0.6);
    }
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

function tone(a: UltAudioApi, t0: number, type: OscillatorType, f0: number, f1: number, peak: number, attack: number, hold: number, release: number, lp?: number, am?: { hz0: number; hz1?: number; depth: number }): GainNode {
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
  if (am !== undefined) {
    const amg = sc.ctx.createGain();
    amg.gain.value = 1 - am.depth * 0.5;
    const lfo = synth.makeLFO(sc.ctx, amg.gain, am.hz0, am.depth * 0.5);
    if (am.hz1 !== undefined) {
      lfo.frequency.setValueAtTime(am.hz0, t0);
      lfo.frequency.linearRampToValueAtTime(am.hz1, t0 + 0.6);
    }
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

const rhinoAudio: UltAudio = {
  onTarget(a, ev) {
    const g = a.gainAt(ev.from);
    if (g < 0.04) return;
    const t0 = a.now;
    // Two hard snorts.
    noise(a, t0 + 0.04, 'bandpass', 1500, 500, 1.1, 0.5 * g, 0.006, 0.03, 0.14);
    noise(a, t0 + 0.3, 'bandpass', 1300, 420, 1.1, 0.55 * g, 0.006, 0.035, 0.16);
    // Three paws: scraping hooves on sand (falling band sweep + a soft thud).
    for (let i = 0; i < 3; i++) {
      const tt = t0 + 0.12 + i * 0.22;
      noise(a, tt, 'bandpass', 1000 - i * 100, 380, 1.4, 0.36 * g, 0.01, 0.03, 0.12);
      tone(a, tt + 0.05, 'sine', 90, 48, 0.4 * g, 0.004, 0.02, 0.1, 220);
    }
    // A low growl while the head lowers.
    const w = Math.max(0.6, ev.windup);
    const gr = tone(a, t0 + 0.1, 'sawtooth', 52, 64, 0.26 * g, w * 0.5, w * 0.3, 0.2, 200, { hz0: 9, depth: 0.4 });
    beds.set(ev.fighterId, { gains: [gr], until: t0 + w + 0.3 });
  },

  onStage(a, ev) {
    const g = a.gainAt(ev.pos);
    if (g < 0.04) return;
    const t0 = a.now;
    if (ev.stage === 1) {
      stopBed(a, ev.fighterId, 0.05);
      // The gallop: sub-bass + rumble modulated at the stride cadence (3.2 -> 5 Hz as it speeds up).
      const c = K.chargeS;
      const am = { hz0: 3.2, hz1: 5.0, depth: 0.95 };
      const sub = tone(a, t0, 'sine', 50, 58, 0.75 * g, 0.25, c - 0.6, 0.3, 140, am);
      const rum = noise(a, t0, 'lowpass', 220, 320, 0.7, 0.6 * g, 0.3, c - 0.7, 0.3, am);
      const hide = noise(a, t0 + 0.1, 'bandpass', 700, 1300, 0.8, 0.12 * g, 0.4, c - 0.8, 0.3, { hz0: 10, hz1: 15, depth: 0.7 });
      beds.set(ev.fighterId, { gains: [sub, rum, hide], until: t0 + c + 0.3 });
      return;
    }
    if (ev.stage === 2) {
      // GORE: wet thud + horn crack + a grunt.
      noise(a, t0, 'lowpass', 1800, 250, 0.8, 0.7 * g, 0.004, 0.04, 0.3);
      tone(a, t0, 'sine', 130, 52, 0.85 * g, 0.004, 0.05, 0.3, 380);
      noise(a, t0 + 0.01, 'bandpass', 3200, 1400, 1.6, 0.4 * g, 0.003, 0.012, 0.09);
      tone(a, t0 + 0.05, 'sawtooth', 170, 90, 0.22 * g, 0.01, 0.06, 0.18, 520);
      return;
    }
    if (ev.stage === 3) {
      // CRUSH into geometry.
      stopBed(a, ev.fighterId, 0.06);
      tone(a, t0, 'sine', 120, 24, 1.1 * g, 0.004, 0.09, 0.6, 300);
      noise(a, t0, 'lowpass', 2600, 200, 0.6, 0.85 * g, 0.004, 0.08, 0.6);
      noise(a, t0 + 0.02, 'bandpass', 2400, 700, 1.2, 0.4 * g, 0.004, 0.03, 0.25);
      for (let i = 0; i < 5; i++) noise(a, t0 + 0.14 + i * 0.085, 'bandpass', 1900 - i * 210, 700, 1.4, 0.2 * g, 0.004, 0.015, 0.06);
      return;
    }
    if (ev.stage === 4) {
      // SKID: gravel scrape sliding to a halt.
      stopBed(a, ev.fighterId, 0.1);
      noise(a, t0, 'highpass', 2600, 600, 0.7, 0.3 * g, 0.03, K.skidS * 0.5, K.skidS * 0.6, { hz0: 26, depth: 0.5 });
      noise(a, t0, 'lowpass', 600, 160, 0.7, 0.4 * g, 0.03, K.skidS * 0.4, 0.4);
      tone(a, t0 + K.skidS * 0.5, 'sine', 80, 40, 0.3 * g, 0.01, 0.1, 0.3, 200);
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

export default rhinoAudio;
