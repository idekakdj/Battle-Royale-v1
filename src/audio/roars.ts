/**
 * Per-animal roar voices (BLUEPRINT §13). Each roar = oscillator stack + formant
 * bandpass + AM growl (or filtered noise / percussion where the real animal calls
 * for it). All envelope shaped — no clicks. Played on match start, ult, and kill.
 *
 * Recipes (§13):
 *  lion    90 Hz long roar          gorilla  8-hit chest-beat percussion
 *  croc    hiss-growl 70 Hz         hippo    bellow 65 Hz
 *  rhino   snort-charge             eagle    1.8 kHz descending screech
 *  panther 120 Hz snarl             python   filtered-noise hiss
 *  giraffe deep hum + hoof stomp    mole     fast 300 Hz chitter
 */

import type { AnimalId } from '../core/types';
import {
  EPS,
  filter,
  makeLFO,
  noiseSource,
  osc,
  shapeEnv,
  type SynthCtx,
  type Voice,
} from './synth';

export class Roars {
  constructor(private readonly sc: SynthCtx) {}

  private get t(): number {
    return this.sc.ctx.currentTime;
  }

  roar(animal: AnimalId): void {
    switch (animal) {
      case 'lion':
        this.growl(90, 1.4, 24, 0.28, [420, 900, 2100]);
        break;
      case 'crocodile':
        this.hissGrowl(70);
        break;
      case 'hippo':
        this.bellow(65);
        break;
      case 'panther':
        this.growl(120, 0.7, 34, 0.24, [500, 1200, 2600]);
        break;
      case 'gorilla':
        this.chestBeat();
        break;
      case 'rhino':
        this.snort();
        break;
      case 'eagle':
        this.screech();
        break;
      case 'python':
        this.hiss();
        break;
      case 'giraffe':
        this.humStomp();
        break;
      case 'mole':
        this.chitter();
        break;
    }
  }

  /**
   * Sustained saw-stack growl with formant bandpasses and an AM "growl" LFO.
   * Used for lion (long) and panther (shorter snarl).
   */
  private growl(
    base: number,
    length: number,
    growlRate: number,
    growlDepth: number,
    formants: readonly number[],
  ): void {
    const sc = this.sc;
    const t0 = this.t;
    const v = sc.voices.create(t0);

    // AM gain the carrier passes through; base level + LFO modulation.
    const am = sc.ctx.createGain();
    am.gain.value = 1 - growlDepth;
    const lfo = makeLFO(sc.ctx, am.gain, growlRate, growlDepth);

    // Carrier stack: fundamental + slightly detuned octave/partials.
    const partials: Array<{ mul: number; gain: number; type: OscillatorType }> = [
      { mul: 1, gain: 0.5, type: 'sawtooth' },
      { mul: 1.01, gain: 0.35, type: 'sawtooth' },
      { mul: 2, gain: 0.18, type: 'sawtooth' },
    ];
    const oscs: OscillatorNode[] = [];
    for (const p of partials) {
      const o = osc(sc.ctx, p.type, base * p.mul);
      // Slight downward drift for a natural roar tail.
      o.frequency.setValueAtTime(base * p.mul, t0);
      o.frequency.linearRampToValueAtTime(base * p.mul * 0.9, t0 + length);
      const g = sc.ctx.createGain();
      g.gain.value = p.gain;
      o.connect(g);
      g.connect(am);
      oscs.push(o);
    }

    // Parallel formant bandpasses summed into the voice gain.
    for (const f of formants) {
      const bp = filter(sc.ctx, 'bandpass', f, 4);
      am.connect(bp);
      bp.connect(v.gain);
    }
    // A little direct signal for body.
    am.connect(v.gain);

    const end = shapeEnv(v.gain.gain, t0, 0.42, 0.06, length * 0.55, length * 0.5);
    lfo.start(t0);
    lfo.stop(end + 0.02);
    for (const o of oscs) {
      o.start(t0);
      o.stop(end + 0.02);
    }
    sc.voices.add(v, lfo);
    for (let i = 0; i < oscs.length; i++) sc.voices.add(v, oscs[i], i === 0);
  }

  /** Crocodile: low hiss-growl — 70 Hz growl body + broadband hiss layer. */
  private hissGrowl(base: number): void {
    const sc = this.sc;
    const t0 = this.t;
    const v = sc.voices.create(t0);
    const length = 1.1;

    const am = sc.ctx.createGain();
    am.gain.value = 0.6;
    const lfo = makeLFO(sc.ctx, am.gain, 30, 0.4);
    const o = osc(sc.ctx, 'sawtooth', base);
    o.frequency.linearRampToValueAtTime(base * 0.85, t0 + length);
    o.connect(am);
    const bp = filter(sc.ctx, 'bandpass', 500, 3);
    am.connect(bp);
    bp.connect(v.gain);

    // Hiss layer.
    const n = noiseSource(sc);
    const hp = filter(sc.ctx, 'highpass', 2000, 0.6);
    const nGain = sc.ctx.createGain();
    nGain.gain.value = EPS;
    shapeEnv(nGain.gain, t0, 0.14, 0.08, length * 0.5, length * 0.5);
    n.connect(hp);
    hp.connect(nGain);
    nGain.connect(v.gain);

    const end = shapeEnv(v.gain.gain, t0, 0.34, 0.05, length * 0.5, length * 0.5);
    lfo.start(t0);
    lfo.stop(end + 0.02);
    o.start(t0);
    o.stop(end + 0.02);
    n.start(t0);
    n.stop(end + 0.02);
    sc.voices.add(v, lfo);
    sc.voices.add(v, n);
    sc.voices.add(v, o, true);
  }

  /** Hippo: deep 65 Hz bellow, big and slow. */
  private bellow(base: number): void {
    const sc = this.sc;
    const t0 = this.t;
    const v = sc.voices.create(t0);
    const length = 1.3;

    const am = sc.ctx.createGain();
    am.gain.value = 0.85;
    const lfo = makeLFO(sc.ctx, am.gain, 12, 0.15);
    const sub = osc(sc.ctx, 'sine', base);
    const saw = osc(sc.ctx, 'sawtooth', base * 2);
    const subG = sc.ctx.createGain();
    subG.gain.value = 0.6;
    const sawG = sc.ctx.createGain();
    sawG.gain.value = 0.25;
    sub.connect(subG);
    subG.connect(am);
    saw.connect(sawG);
    sawG.connect(am);
    for (const f of [180, 500, 1100]) {
      const bp = filter(sc.ctx, 'bandpass', f, 3);
      am.connect(bp);
      bp.connect(v.gain);
    }
    am.connect(v.gain);

    const end = shapeEnv(v.gain.gain, t0, 0.5, 0.12, length * 0.5, length * 0.55);
    lfo.start(t0);
    lfo.stop(end + 0.02);
    sub.start(t0);
    sub.stop(end + 0.02);
    saw.start(t0);
    saw.stop(end + 0.02);
    sc.voices.add(v, lfo);
    sc.voices.add(v, saw);
    sc.voices.add(v, sub, true);
  }

  /** Gorilla: 8-hit chest-beat percussion. */
  private chestBeat(): void {
    const sc = this.sc;
    const t0 = this.t;
    const v = sc.voices.create(t0);
    const hits = 8;
    const step = 0.11;
    let end = t0;
    for (let i = 0; i < hits; i++) {
      const nt = t0 + i * step;
      // Hollow chest thump: short sine + lowpassed noise.
      const s = osc(sc.ctx, 'sine', 150 - i * 3);
      s.frequency.exponentialRampToValueAtTime(70, nt + 0.08);
      const sg = sc.ctx.createGain();
      sg.gain.value = EPS;
      const e = shapeEnv(sg.gain, nt, 0.34, 0.004, 0.01, 0.08);
      s.connect(sg);
      sg.connect(v.gain);
      const n = noiseSource(sc);
      const lp = filter(sc.ctx, 'lowpass', 600, 0.8);
      const ng = sc.ctx.createGain();
      ng.gain.value = EPS;
      shapeEnv(ng.gain, nt, 0.14, 0.002, 0.006, 0.05);
      n.connect(lp);
      lp.connect(ng);
      ng.connect(v.gain);
      s.start(nt);
      s.stop(e + 0.02);
      n.start(nt);
      n.stop(e + 0.02);
      sc.voices.add(v, n);
      sc.voices.add(v, s, i === hits - 1);
      end = e;
    }
    v.gain.gain.value = 1;
    void end;
  }

  /** Rhino: short snort-charge — noise burst + descending grunt + puff pulses. */
  private snort(): void {
    const sc = this.sc;
    const t0 = this.t;
    const v = sc.voices.create(t0);

    const o = osc(sc.ctx, 'sawtooth', 110);
    o.frequency.setValueAtTime(110, t0);
    o.frequency.exponentialRampToValueAtTime(60, t0 + 0.3);
    const og = sc.ctx.createGain();
    og.gain.value = EPS;
    const end = shapeEnv(og.gain, t0, 0.34, 0.006, 0.05, 0.22);
    const bp = filter(sc.ctx, 'bandpass', 700, 2);
    o.connect(bp);
    bp.connect(og);
    og.connect(v.gain);

    // Nostril puffs: two quick noise pulses.
    for (let i = 0; i < 2; i++) {
      const nt = t0 + i * 0.09;
      const n = noiseSource(sc);
      const hp = filter(sc.ctx, 'highpass', 1200, 0.7);
      const ng = sc.ctx.createGain();
      ng.gain.value = EPS;
      shapeEnv(ng.gain, nt, 0.22, 0.003, 0.01, 0.06);
      n.connect(hp);
      hp.connect(ng);
      ng.connect(v.gain);
      n.start(nt);
      n.stop(nt + 0.12);
      sc.voices.add(v, n);
    }
    v.gain.gain.value = 1;
    o.start(t0);
    o.stop(end + 0.02);
    sc.voices.add(v, o, true);
  }

  /** Eagle: 1.8 kHz descending screech + bright noise shimmer. */
  private screech(): void {
    const sc = this.sc;
    const t0 = this.t;
    const v = sc.voices.create(t0);
    const length = 0.6;

    const am = sc.ctx.createGain();
    am.gain.value = 0.7;
    const lfo = makeLFO(sc.ctx, am.gain, 60, 0.3);
    const o = osc(sc.ctx, 'sawtooth', 1800);
    o.frequency.setValueAtTime(1800, t0);
    o.frequency.exponentialRampToValueAtTime(900, t0 + length);
    const o2 = osc(sc.ctx, 'sawtooth', 1800 * 1.5);
    o2.frequency.setValueAtTime(1800 * 1.5, t0);
    o2.frequency.exponentialRampToValueAtTime(900 * 1.5, t0 + length);
    const o2g = sc.ctx.createGain();
    o2g.gain.value = 0.3;
    o.connect(am);
    o2.connect(o2g);
    o2g.connect(am);
    const bp = filter(sc.ctx, 'bandpass', 2200, 2);
    am.connect(bp);
    bp.connect(v.gain);

    // Airy noise on top.
    const n = noiseSource(sc);
    const hp = filter(sc.ctx, 'highpass', 3000, 0.6);
    const ng = sc.ctx.createGain();
    ng.gain.value = EPS;
    shapeEnv(ng.gain, t0, 0.1, 0.02, length * 0.4, length * 0.5);
    n.connect(hp);
    hp.connect(ng);
    ng.connect(v.gain);

    const end = shapeEnv(v.gain.gain, t0, 0.24, 0.02, length * 0.35, length * 0.6);
    lfo.start(t0);
    lfo.stop(end + 0.02);
    o.start(t0);
    o.stop(end + 0.02);
    o2.start(t0);
    o2.stop(end + 0.02);
    n.start(t0);
    n.stop(end + 0.02);
    sc.voices.add(v, lfo);
    sc.voices.add(v, o2);
    sc.voices.add(v, n);
    sc.voices.add(v, o, true);
  }

  /** Python: sustained filtered-noise hiss with a slow amplitude wobble. */
  private hiss(): void {
    const sc = this.sc;
    const t0 = this.t;
    const v = sc.voices.create(t0);
    const length = 1.0;
    const n = noiseSource(sc);
    const bp = filter(sc.ctx, 'bandpass', 5000, 1.2);
    const hp = filter(sc.ctx, 'highpass', 2500, 0.5);
    n.connect(hp);
    hp.connect(bp);
    bp.connect(v.gain);
    // Slow wobble on the loudness.
    const wobble = makeLFO(sc.ctx, v.gain.gain, 6, 0.05);
    const end = shapeEnv(v.gain.gain, t0, 0.18, 0.1, length * 0.5, length * 0.5);
    wobble.start(t0);
    wobble.stop(end + 0.02);
    n.start(t0);
    n.stop(end + 0.02);
    sc.voices.add(v, wobble);
    sc.voices.add(v, n, true);
  }

  /** Giraffe: deep infrasonic-ish hum + a hoof stomp transient. */
  private humStomp(): void {
    const sc = this.sc;
    const t0 = this.t;
    const v = sc.voices.create(t0);
    const length = 1.1;

    // Stomp first.
    const st = osc(sc.ctx, 'sine', 90);
    st.frequency.exponentialRampToValueAtTime(40, t0 + 0.15);
    const stg = sc.ctx.createGain();
    stg.gain.value = EPS;
    shapeEnv(stg.gain, t0, 0.45, 0.004, 0.02, 0.16);
    st.connect(stg);
    stg.connect(v.gain);
    const sn = noiseSource(sc);
    const slp = filter(sc.ctx, 'lowpass', 400, 0.8);
    const sng = sc.ctx.createGain();
    sng.gain.value = EPS;
    shapeEnv(sng.gain, t0, 0.16, 0.002, 0.01, 0.08);
    sn.connect(slp);
    slp.connect(sng);
    sng.connect(v.gain);

    // Deep hum swelling after the stomp.
    const hum = osc(sc.ctx, 'sine', 55);
    const humG = sc.ctx.createGain();
    humG.gain.value = EPS;
    const end = shapeEnv(humG.gain, t0 + 0.05, 0.3, 0.25, length * 0.4, length * 0.5);
    const hum2 = osc(sc.ctx, 'triangle', 110);
    const hum2G = sc.ctx.createGain();
    hum2G.gain.value = 0.12;
    hum.connect(humG);
    hum2.connect(hum2G);
    hum2G.connect(humG);
    humG.connect(v.gain);

    v.gain.gain.value = 1;
    st.start(t0);
    st.stop(t0 + 0.35);
    sn.start(t0);
    sn.stop(t0 + 0.2);
    hum.start(t0);
    hum.stop(end + 0.02);
    hum2.start(t0);
    hum2.stop(end + 0.02);
    sc.voices.add(v, st);
    sc.voices.add(v, sn);
    sc.voices.add(v, hum2);
    sc.voices.add(v, hum, true);
  }

  /** Mole: fast ~300 Hz chitter — rapid gated pulses. */
  private chitter(): void {
    const sc = this.sc;
    const t0 = this.t;
    const v: Voice = sc.voices.create(t0);
    const pulses = 10;
    const step = 0.045;
    let end = t0;
    for (let i = 0; i < pulses; i++) {
      const nt = t0 + i * step;
      const o = osc(sc.ctx, 'square', 300 + (i % 2) * 60);
      const g = sc.ctx.createGain();
      g.gain.value = EPS;
      const e = shapeEnv(g.gain, nt, 0.12, 0.003, 0.006, 0.02);
      const bp = filter(sc.ctx, 'bandpass', 1600, 2);
      o.connect(bp);
      bp.connect(g);
      g.connect(v.gain);
      o.start(nt);
      o.stop(e + 0.02);
      sc.voices.add(v, o, i === pulses - 1);
      end = e;
    }
    v.gain.gain.value = 1;
    void end;
  }
}
