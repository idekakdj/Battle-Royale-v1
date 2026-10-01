/**
 * Python — COIL SNARE audio (v1.3). Added on top of the shared ultimate stinger / roar.
 *
 *  cast     long rearing hiss (shimmering) + a tail rattle
 *  COMMIT   sharp inhale
 *  LASH     whip crack + the tether's whistle
 *  SNARE    rope-snap thwack + body thud + the yank whoosh
 *  WRAP 1-4 bone-creak squeeze pulses: a creaking tone that rises in pitch each beat, plus rope shhk and a sub pulse
 *  CRUSH    big bone crack, low thump, the released breath
 *  WHIFF    empty snap-back
 * Every voice is envelope-shaped (starts and ends at EPS): no clicks.
 */

import type { UltAudio, UltAudioApi } from './index';
import { PYTHON_STAGE } from '../../config/ultimates/python';

function noise(a: UltAudioApi, t0: number, type: BiquadFilterType, f0: number, f1: number, q: number, peak: number, attack: number, hold: number, release: number, lfoHz = 0, lfoDepth = 0): void {
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
  let node: AudioNode = fl;
  if (lfoHz > 0) {
    // Amplitude shimmer on its own gain stage so it stays inside the envelope.
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
    const f = synth.filter(sc.ctx, 'lowpass', lp, 1.2);
    o.connect(f);
    node = f;
  }
  node.connect(eg);
  eg.connect(v.gain);
  if (lfoHz > 0) {
    const lfo = synth.makeLFO(sc.ctx, o.frequency, lfoHz, lfoDepth);
    lfo.start(t0);
    lfo.stop(end + 0.05);
    sc.voices.add(v, lfo);
  }
  o.start(t0);
  o.stop(end + 0.05);
  sc.voices.add(v, o, true);
}

function clicks(a: UltAudioApi, t0: number, n: number, span: number, peak: number): void {
  for (let i = 0; i < n; i++) {
    const at = t0 + (span * i) / Math.max(1, n - 1) + Math.random() * 0.01;
    noise(a, at, 'highpass', 2800 + Math.random() * 1600, 5200, 0.8, peak * (0.45 + Math.random() * 0.55), 0.002, 0.004, 0.028);
  }
}

const python: UltAudio = {
  onTarget(a, ev) {
    const g = a.gainAt(ev.from);
    if (g < 0.04) return;
    const t0 = a.now;
    // The rearing hiss (shimmering) + a dry tail rattle.
    noise(a, t0, 'bandpass', 5200, 6800, 1.0, 0.36 * g, 0.12, Math.max(0.1, ev.windup - 0.3), 0.22, 11, 0.35);
    noise(a, t0 + 0.05, 'highpass', 3500, 6000, 0.7, 0.14 * g, 0.05, Math.max(0.1, ev.windup - 0.3), 0.15, 30, 0.9);
  },

  onStage(a, ev) {
    const g = a.gainAt(ev.pos);
    if (g < 0.04) return;
    const t0 = a.now;
    switch (ev.stage) {
      case PYTHON_STAGE.COMMIT:
        noise(a, t0, 'highpass', 1800, 5200, 0.8, 0.3 * g, 0.05, 0.04, 0.1); // inhale
        break;
      case PYTHON_STAGE.LASH:
        noise(a, t0, 'highpass', 3600, 6500, 0.7, 0.85 * g, 0.002, 0.012, 0.06); // crack
        clicks(a, t0, 2, 0.02, 0.35 * g);
        noise(a, t0 + 0.01, 'bandpass', 3800, 900, 1.6, 0.45 * g, 0.03, 0.12, 0.2); // tether whistle
        tone(a, t0, 'sine', 220, 120, 0.22 * g, 0.01, 0.05, 0.16);
        break;
      case PYTHON_STAGE.SNARE:
        noise(a, t0, 'lowpass', 2800, 500, 0.8, 0.85 * g, 0.003, 0.02, 0.12); // thwack
        tone(a, t0, 'sine', 170, 55, 0.8 * g, 0.004, 0.04, 0.22);
        noise(a, t0 + 0.03, 'bandpass', 600, 2400, 1.0, 0.45 * g, 0.03, 0.1, 0.2); // yank whoosh
        clicks(a, t0 + 0.01, 3, 0.06, 0.3 * g);
        break;
      case PYTHON_STAGE.WRAP1:
      case PYTHON_STAGE.WRAP2:
      case PYTHON_STAGE.WRAP3:
      case PYTHON_STAGE.WRAP4: {
        const lvl = ev.stage - PYTHON_STAGE.WRAP1 + 1; // 1..4
        const f = 150 + lvl * 26;
        // Bone creak (rising pitch each squeeze) + rope shhk + sub pulse.
        tone(a, t0, 'sawtooth', f, f * 0.8, (0.26 + 0.05 * lvl) * g, 0.05, 0.22, 0.25, 520, 9 + lvl * 2, 18 + lvl * 6);
        noise(a, t0, 'bandpass', 1300 + lvl * 120, 700, 1.4, (0.3 + 0.04 * lvl) * g, 0.05, 0.12, 0.25);
        tone(a, t0, 'sine', 78, 46, (0.5 + 0.06 * lvl) * g, 0.01, 0.06, 0.22);
        clicks(a, t0 + 0.06, lvl, 0.2, 0.3 * g);
        break;
      }
      case PYTHON_STAGE.CRUSH:
        noise(a, t0, 'lowpass', 3800, 700, 0.8, 1.0 * g, 0.003, 0.03, 0.16);
        tone(a, t0, 'sine', 135, 38, 0.95 * g, 0.004, 0.06, 0.4);
        clicks(a, t0, 6, 0.14, 0.6 * g);
        noise(a, t0 + 0.15, 'bandpass', 5200, 3200, 1.0, 0.3 * g, 0.06, 0.2, 0.4); // released breath
        break;
      case PYTHON_STAGE.WHIFF:
        noise(a, t0, 'bandpass', 1000, 4200, 1.2, 0.4 * g, 0.02, 0.08, 0.2);
        noise(a, t0, 'highpass', 4000, 6500, 0.7, 0.3 * g, 0.002, 0.012, 0.05);
        break;
      default:
        break;
    }
  },
};

export default python;
