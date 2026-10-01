/**
 * Crocodile — DEATH ROLL audio (v1.3). Added on top of the shared ultimate stinger / roar.
 *
 *  cast     windup hiss + low throat growl (the gape)
 *  COMMIT   short rising rumble (the coil tightens)
 *  LUNGE    air whoosh + gape rasp
 *  CLAMP    jaw clamp crunch: noise burst + sub thump + a rattle of bone clicks
 *  DRAG     gravel scrape + grunt
 *  ROLL 1-3 thrash cadence: four body thumps per revolution (louder each turn) + a sand rush + growl
 *  TOSS     heavy ground thud + the exhale
 *  WHIFF    skid + missed-snap click
 * Every voice is envelope-shaped (starts and ends at EPS): no clicks.
 */

import type { UltAudio, UltAudioApi } from './index';
import { CROC_STAGE } from '../../config/ultimates/crocodile';

function noise(a: UltAudioApi, t0: number, type: BiquadFilterType, f0: number, f1: number, q: number, peak: number, attack: number, hold: number, release: number): void {
  const { sc, synth } = a;
  const v = sc.voices.create(t0);
  v.gain.gain.value = 1;
  const src = synth.noiseSource(sc);
  const fl = synth.filter(sc.ctx, type, f0, q);
  const dur = attack + hold + release;
  fl.frequency.setValueAtTime(f0, t0);
  fl.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
  const eg = sc.ctx.createGain();
  eg.gain.value = synth.EPS;
  const end = synth.shapeEnv(eg.gain, t0, peak, attack, hold, release);
  src.connect(fl);
  fl.connect(eg);
  eg.connect(v.gain);
  src.start(t0, Math.random() * 1.5);
  src.stop(end + 0.05);
  sc.voices.add(v, src, true);
}

function tone(a: UltAudioApi, t0: number, type: OscillatorType, f0: number, f1: number, peak: number, attack: number, hold: number, release: number, lp = 0, lfoHz = 0, lfoDepth = 0): void {
  const { sc, synth } = a;
  const v = sc.voices.create(t0);
  v.gain.gain.value = 1;
  const o = synth.osc(sc.ctx, type, f0);
  const dur = attack + hold + release;
  o.frequency.setValueAtTime(f0, t0);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
  const eg = sc.ctx.createGain();
  eg.gain.value = synth.EPS;
  const end = synth.shapeEnv(eg.gain, t0, peak, attack, hold, release);
  let node: AudioNode = o;
  if (lp > 0) {
    const f = synth.filter(sc.ctx, 'lowpass', lp, 0.7);
    o.connect(f);
    node = f;
  }
  if (lfoHz > 0) {
    // Amplitude wobble (growl) on its own gain stage so it stays inside the envelope.
    const am = sc.ctx.createGain();
    am.gain.value = 1;
    node.connect(am);
    node = am;
    const lfo = synth.makeLFO(sc.ctx, am.gain, lfoHz, lfoDepth);
    lfo.start(t0);
    lfo.stop(end + 0.05);
    sc.voices.add(v, lfo);
  }
  node.connect(eg);
  eg.connect(v.gain);
  o.start(t0);
  o.stop(end + 0.05);
  sc.voices.add(v, o, true);
}

/** Bone-click rattle: `n` short highpassed noise ticks spread over `span` seconds. */
function clicks(a: UltAudioApi, t0: number, n: number, span: number, peak: number): void {
  for (let i = 0; i < n; i++) {
    const at = t0 + (span * i) / Math.max(1, n - 1) + Math.random() * 0.012;
    noise(a, at, 'highpass', 2600 + Math.random() * 1800, 5000, 0.8, peak * (0.45 + Math.random() * 0.55), 0.002, 0.004, 0.03);
  }
}

const crocodile: UltAudio = {
  onTarget(a, ev) {
    const g = a.gainAt(ev.from);
    if (g < 0.04) return;
    const t0 = a.now;
    // Hiss (the gape) + throat growl.
    noise(a, t0, 'bandpass', 3200, 5200, 1.1, 0.34 * g, 0.12, Math.max(0.1, ev.windup - 0.3), 0.2);
    tone(a, t0 + 0.03, 'sawtooth', 62, 48, 0.3 * g, 0.12, Math.max(0.1, ev.windup - 0.25), 0.22, 240, 9, 0.35);
  },

  onStage(a, ev) {
    const g = a.gainAt(ev.pos);
    if (g < 0.04) return;
    const t0 = a.now;
    switch (ev.stage) {
      case CROC_STAGE.COMMIT:
        tone(a, t0, 'sine', 52, 78, 0.42 * g, 0.06, 0.1, 0.12, 220);
        clicks(a, t0, 2, 0.05, 0.2 * g);
        break;
      case CROC_STAGE.LUNGE:
        noise(a, t0, 'bandpass', 500, 2600, 0.9, 0.62 * g, 0.03, 0.08, 0.22);
        noise(a, t0, 'highpass', 1800, 4200, 0.7, 0.3 * g, 0.02, 0.06, 0.2);
        tone(a, t0, 'sawtooth', 110, 70, 0.22 * g, 0.02, 0.08, 0.2, 500);
        break;
      case CROC_STAGE.CLAMP:
        noise(a, t0, 'lowpass', 2400, 600, 0.8, 1.0 * g, 0.004, 0.03, 0.16);
        tone(a, t0, 'sine', 150, 42, 0.95 * g, 0.004, 0.05, 0.3);
        clicks(a, t0 + 0.02, 6, 0.16, 0.55 * g);
        tone(a, t0 + 0.05, 'sawtooth', 75, 55, 0.25 * g, 0.03, 0.12, 0.2, 260);
        break;
      case CROC_STAGE.DRAG:
        noise(a, t0, 'bandpass', 520, 380, 1.4, 0.4 * g, 0.05, 0.25, 0.2);
        tone(a, t0, 'sawtooth', 70, 58, 0.28 * g, 0.06, 0.25, 0.15, 280, 14, 0.3);
        break;
      case CROC_STAGE.ROLL1:
      case CROC_STAGE.ROLL2:
      case CROC_STAGE.ROLL3: {
        const rev = ev.stage - CROC_STAGE.ROLL1; // 0..2
        const level = 0.75 + 0.15 * rev;
        const rev_t = 0.83; // one revolution (spec.duration / hits)
        // Four body thumps per revolution, harder each turn.
        for (let i = 0; i < 4; i++) {
          const at = t0 + (rev_t * i) / 4;
          tone(a, at, 'sine', 100 - rev * 8, 48, 0.75 * level * g, 0.005, 0.03, 0.17);
          noise(a, at, 'lowpass', 1100, 300, 0.8, 0.45 * level * g, 0.004, 0.02, 0.14);
        }
        // Sand rush sweeping through the turn + growl.
        noise(a, t0, 'bandpass', 700 + rev * 120, 2000 + rev * 300, 0.9, 0.36 * level * g, 0.15, 0.4, 0.3);
        tone(a, t0, 'sawtooth', 58 + rev * 6, 50, 0.3 * g, 0.1, 0.55, 0.2, 230, 11 + rev, 0.35);
        clicks(a, t0 + 0.05, 2 + rev, 0.5, 0.3 * g);
        break;
      }
      case CROC_STAGE.TOSS:
        tone(a, t0, 'sine', 110, 34, 1.0 * g, 0.004, 0.06, 0.4);
        noise(a, t0, 'lowpass', 900, 260, 0.8, 0.85 * g, 0.004, 0.04, 0.3);
        noise(a, t0 + 0.12, 'bandpass', 1400, 800, 0.9, 0.3 * g, 0.06, 0.12, 0.3); // dust hiss
        noise(a, t0 + 0.4, 'bandpass', 1100, 500, 0.8, 0.22 * g, 0.12, 0.2, 0.3); // the exhale
        break;
      case CROC_STAGE.WHIFF:
        noise(a, t0, 'bandpass', 1900, 500, 1.0, 0.45 * g, 0.02, 0.12, 0.3);
        clicks(a, t0, 2, 0.06, 0.4 * g);
        tone(a, t0 + 0.05, 'sine', 90, 50, 0.25 * g, 0.01, 0.06, 0.2);
        break;
      default:
        break;
    }
  },
};

export default crocodile;
