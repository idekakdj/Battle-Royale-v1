/**
 * Gorilla — Boulder Hurl audio (v1.3). ADDED to the generic ultimate stinger.
 *
 *  cast       (scheduled against the windup) two chest DRUMS (a deep hollow thump + a slap of noise) at the beat
 *             instants, a STONE RIP (gritty low-passed noise tearing open, a low groan and a crackle of
 *             pebbles) as the slab leaves the ground, a strained grunt while it is hoisted
 *  stage 1    (release) the THROW: a short roaring grunt and a low whoosh that follows the boulder
 *  stage 0/2  silent (the tracking cadence; the impact is the `projectileImpact` hook)
 *  onImpact   the BOOM: a sub thud, a stone crack, a rumbling rolling dust whoosh and scattering debris
 * Every envelope starts and ends at EPS (click-free); loudness scales with the listener distance.
 */

import { GORILLA_HURL } from '../../config/ultimates/gorilla';
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

/** Where each gorilla's current cast started (the release sound is heard there, not at the landing point). */
const castFrom = new Map<number, { x: number; y: number; z: number }>();

const gorillaAudio: UltAudio = {
  onTarget(a, ev) {
    castFrom.set(ev.fighterId, { x: ev.from.x, y: ev.from.y, z: ev.from.z });
    const g = a.gainAt(ev.from);
    if (g < 0.04) return;
    const t0 = a.now;
    // Two chest drums: hollow thump + a slap of noise, the second a touch heavier.
    for (let i = 0; i < GORILLA_HURL.beatAt.length; i++) {
      const tb = t0 + GORILLA_HURL.beatAt[i];
      const k = i === 0 ? 0.85 : 1;
      tone(a, tb, 'sine', 120, 52, 0.85 * g * k, 0.004, 0.03, 0.2, { lp: 380 });
      noise(a, tb, 'bandpass', 420, 180, 0.9, 0.5 * g * k, 0.004, 0.02, 0.1);
    }
    // The slab tears out of the ground.
    const tr = t0 + GORILLA_HURL.ripAt;
    noise(a, tr, 'lowpass', 1800, 260, 0.7, 0.6 * g, 0.03, 0.12, 0.3);
    tone(a, tr, 'sawtooth', 70, 38, 0.3 * g, 0.03, 0.1, 0.3, { lp: 240 });
    noise(a, tr + 0.08, 'highpass', 2600, 1400, 0.8, 0.22 * g, 0.02, 0.08, 0.25); // pebbles cracking loose
    // Effort grunt as it is hoisted overhead.
    const th = t0 + GORILLA_HURL.ripAt + 0.14;
    tone(a, th, 'sawtooth', 150, 105, 0.22 * g, 0.05, 0.12, 0.18, { bp: [420, 2.2], vibHz: 16, vibDepth: 10 });
  },

  onEnd(_a, fighterId) {
    castFrom.delete(fighterId);
  },

  dispose() {
    castFrom.clear();
  },

  onStage(a, ev) {
    if (ev.stage !== 1) return; // tracking cadence and impact are silent here
    // The release is heard at the thrower (the stage position is the landing point): use the cast position.
    const g = a.gainAt(castFrom.get(ev.fighterId) ?? ev.pos);
    if (g < 0.04) return;
    const t0 = a.now;
    // Throw grunt: a roaring shout that drops in pitch.
    tone(a, t0, 'sawtooth', 210, 120, 0.32 * g, 0.012, 0.08, 0.2, { bp: [520, 1.6], vibHz: 22, vibDepth: 14 });
    tone(a, t0, 'triangle', 105, 62, 0.22 * g, 0.012, 0.08, 0.22, { lp: 420 });
    // Whoosh of the heavy slab leaving the hands.
    noise(a, t0 + 0.02, 'bandpass', 500, 1400, 0.8, 0.42 * g, 0.02, 0.06, 0.3);
  },

  onImpact(a, ev) {
    const g = a.gainAt(ev.pos);
    if (g < 0.04) return;
    const t0 = a.now;
    // Boom: sub thud + stone crack + rolling dust whoosh + scattering debris.
    tone(a, t0, 'sine', 120, 34, 1.0 * g, 0.004, 0.06, 0.46, { lp: 360 });
    noise(a, t0, 'bandpass', 2600, 480, 0.8, 0.85 * g, 0.004, 0.03, 0.22);
    noise(a, t0 + 0.02, 'lowpass', 2000, 200, 0.5, 0.6 * g, 0.012, 0.1, 0.7);
    noise(a, t0 + 0.07, 'highpass', 3000, 1600, 0.7, 0.24 * g, 0.02, 0.06, 0.4); // debris
  },
};

export default gorillaAudio;
