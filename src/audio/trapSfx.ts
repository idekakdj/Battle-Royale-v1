/**
 * v1.2 arena-trap + eagle landing sounds (WP-P). Same rules as {@link Sfx}:
 * 100% synthesised, every amplitude envelope shaped (no clicks), transient
 * voices allocated through the shared {@link VoiceManager} polyphony guard.
 *
 *  - fire trigger:   ignition "fwoomp" (rising bandpassed noise) + low thump
 *                    + a spray of crackles
 *  - spikes trigger: metallic clank (inharmonic partials) + "shhk" + thud
 *  - trap tick:      fire = short sizzle; spikes = small stab (rate-limited by
 *                    the engine)
 *  - trap expire:    fire = dying hiss; spikes = retract scrape + clunk
 *  - landing impact: sub thump + dirt burst + feather rustle
 *  - fire bed:       optional looping low crackle while a fire trap burns near
 *                    the listener ({@link TrapSfx.setFireBed})
 *
 * `gain` (0..1) on every call is the engine's distance attenuation.
 */

import type { TrapKind } from '../core/types';
import { EPS, filter, makeLFO, noiseSource, osc, shapeEnv, type SynthCtx, type Voice } from './synth';

const BED_RAMP = 0.25; // s — fire-bed level smoothing
const BED_IDLE_STOP = 3; // s of silence before the bed's sources are stopped

export class TrapSfx {
  // Fire-crackle bed (lazily built, torn down after a quiet spell).
  private bedGain: GainNode | null = null;
  private bedSources: AudioScheduledSourceNode[] = [];
  private bedLevel = 0;
  private bedQuietSince = -1;

  constructor(private readonly sc: SynthCtx) {}

  private get t(): number {
    return this.sc.ctx.currentTime;
  }

  /** Crackle spray: `n` tiny highpassed noise pops scattered over `span` s. */
  private crackles(v: Voice, t0: number, n: number, span: number, level: number): number {
    const sc = this.sc;
    const src = noiseSource(sc);
    const hp = filter(sc.ctx, 'highpass', 2600, 0.8);
    const g = sc.ctx.createGain();
    g.gain.value = EPS;
    g.gain.setValueAtTime(EPS, t0);
    let tt = t0;
    for (let i = 0; i < n; i++) {
      tt += (span / n) * (0.4 + Math.random() * 1.2);
      const pk = level * (0.35 + Math.random() * 0.65);
      g.gain.setValueAtTime(EPS, tt);
      g.gain.linearRampToValueAtTime(pk, tt + 0.002);
      g.gain.exponentialRampToValueAtTime(EPS, tt + 0.012 + Math.random() * 0.02);
    }
    const end = tt + 0.05;
    src.connect(hp);
    hp.connect(g);
    g.connect(v.gain);
    src.start(t0);
    src.stop(end);
    this.sc.voices.add(v, src);
    return end;
  }

  /** Fire pit erupts: whoosh + low thump + crackles. */
  fireTrigger(gain = 1): void {
    const sc = this.sc;
    const t0 = this.t;
    const v = sc.voices.create(t0);
    v.gain.gain.value = Math.max(EPS, gain);

    // Ignition whoosh: bandpassed noise sweeping up then settling.
    const n = noiseSource(sc);
    const bp = filter(sc.ctx, 'bandpass', 260, 0.9);
    bp.frequency.setValueAtTime(260, t0);
    bp.frequency.exponentialRampToValueAtTime(1500, t0 + 0.22);
    bp.frequency.exponentialRampToValueAtTime(700, t0 + 0.7);
    const nG = sc.ctx.createGain();
    nG.gain.value = EPS;
    const nEnd = shapeEnv(nG.gain, t0, 0.5, 0.05, 0.18, 0.55);
    n.connect(bp);
    bp.connect(nG);
    nG.connect(v.gain);

    // Low "fwoomp" body.
    const s = osc(sc.ctx, 'sine', 95);
    s.frequency.setValueAtTime(95, t0);
    s.frequency.exponentialRampToValueAtTime(42, t0 + 0.35);
    const sG = sc.ctx.createGain();
    sG.gain.value = EPS;
    shapeEnv(sG.gain, t0, 0.42, 0.015, 0.05, 0.3);
    s.connect(sG);
    sG.connect(v.gain);

    const cEnd = this.crackles(v, t0 + 0.08, 14, 0.8, 0.22);
    const end = Math.max(nEnd, cEnd) + 0.05;
    n.start(t0);
    n.stop(end);
    s.start(t0);
    s.stop(end);
    sc.voices.add(v, s);
    sc.voices.add(v, n, true);
  }

  /** Spikes thrust up: metallic clank + scrape + thud. */
  spikesTrigger(gain = 1): void {
    const sc = this.sc;
    const t0 = this.t;
    const v = sc.voices.create(t0);
    v.gain.gain.value = Math.max(EPS, gain);
    const partials = [1, 1.47, 2.09, 2.95, 4.1];
    const gains = [0.2, 0.14, 0.1, 0.06, 0.04];
    let end = t0;
    for (let i = 0; i < partials.length; i++) {
      const o = osc(sc.ctx, i < 2 ? 'triangle' : 'square', 540 * partials[i]);
      const g = sc.ctx.createGain();
      g.gain.value = EPS;
      const e = shapeEnv(g.gain, t0 + 0.012, gains[i], 0.002, 0.006, 0.28 - i * 0.04);
      o.connect(g);
      g.connect(v.gain);
      o.start(t0);
      o.stop(e + 0.02);
      sc.voices.add(v, o);
      end = Math.max(end, e);
    }
    // "Shhk" — fast bandpassed noise of spikes sliding through the holes.
    const n = noiseSource(sc);
    const bp = filter(sc.ctx, 'bandpass', 3200, 1.4);
    bp.frequency.setValueAtTime(1800, t0);
    bp.frequency.exponentialRampToValueAtTime(4200, t0 + 0.07);
    const nG = sc.ctx.createGain();
    nG.gain.value = EPS;
    shapeEnv(nG.gain, t0, 0.3, 0.004, 0.03, 0.08);
    n.connect(bp);
    bp.connect(nG);
    nG.connect(v.gain);
    // Thud.
    const s = osc(sc.ctx, 'sine', 110);
    s.frequency.setValueAtTime(110, t0);
    s.frequency.exponentialRampToValueAtTime(45, t0 + 0.16);
    const sG = sc.ctx.createGain();
    sG.gain.value = EPS;
    shapeEnv(sG.gain, t0, 0.45, 0.004, 0.02, 0.18);
    s.connect(sG);
    sG.connect(v.gain);
    end = Math.max(end, t0 + 0.3) + 0.04;
    n.start(t0);
    n.stop(end);
    s.start(t0);
    s.stop(end);
    sc.voices.add(v, n);
    sc.voices.add(v, s, true);
  }

  /** Damage tick: fire = sizzle, spikes = stab. Quiet by design. */
  tick(kind: TrapKind, gain = 1): void {
    const sc = this.sc;
    const t0 = this.t;
    const v = sc.voices.create(t0);
    v.gain.gain.value = Math.max(EPS, gain);
    const n = noiseSource(sc);
    let end: number;
    if (kind === 'fire') {
      const hp = filter(sc.ctx, 'highpass', 3800, 0.7);
      const g = sc.ctx.createGain();
      g.gain.value = EPS;
      end = shapeEnv(g.gain, t0, 0.13, 0.01, 0.05, 0.14);
      n.connect(hp);
      hp.connect(g);
      g.connect(v.gain);
      n.start(t0);
      n.stop(end + 0.02);
      sc.voices.add(v, n, true);
    } else {
      const bp = filter(sc.ctx, 'bandpass', 1900, 2);
      const g = sc.ctx.createGain();
      g.gain.value = EPS;
      shapeEnv(g.gain, t0, 0.2, 0.002, 0.01, 0.05);
      n.connect(bp);
      bp.connect(g);
      g.connect(v.gain);
      const s = osc(sc.ctx, 'sine', 160);
      s.frequency.setValueAtTime(160, t0);
      s.frequency.exponentialRampToValueAtTime(80, t0 + 0.08);
      const sG = sc.ctx.createGain();
      sG.gain.value = EPS;
      end = shapeEnv(sG.gain, t0, 0.22, 0.003, 0.01, 0.08);
      s.connect(sG);
      sG.connect(v.gain);
      n.start(t0);
      n.stop(end + 0.02);
      s.start(t0);
      s.stop(end + 0.02);
      sc.voices.add(v, n);
      sc.voices.add(v, s, true);
    }
  }

  /** Hazard ends: fire = dying hiss; spikes = retract scrape + clunk. */
  expire(kind: TrapKind, gain = 1): void {
    const sc = this.sc;
    const t0 = this.t;
    const v = sc.voices.create(t0);
    v.gain.gain.value = Math.max(EPS, gain);
    const n = noiseSource(sc);
    if (kind === 'fire') {
      const lp = filter(sc.ctx, 'lowpass', 2400, 0.6);
      lp.frequency.setValueAtTime(2400, t0);
      lp.frequency.exponentialRampToValueAtTime(300, t0 + 0.7);
      const g = sc.ctx.createGain();
      g.gain.value = EPS;
      const end = shapeEnv(g.gain, t0, 0.2, 0.04, 0.1, 0.6);
      n.connect(lp);
      lp.connect(g);
      g.connect(v.gain);
      n.start(t0);
      n.stop(end + 0.02);
      sc.voices.add(v, n, true);
    } else {
      const bp = filter(sc.ctx, 'bandpass', 3600, 1.2);
      bp.frequency.setValueAtTime(3600, t0);
      bp.frequency.exponentialRampToValueAtTime(1400, t0 + 0.14);
      const g = sc.ctx.createGain();
      g.gain.value = EPS;
      shapeEnv(g.gain, t0, 0.16, 0.01, 0.05, 0.1);
      n.connect(bp);
      bp.connect(g);
      g.connect(v.gain);
      const s = osc(sc.ctx, 'triangle', 300);
      s.frequency.setValueAtTime(300, t0 + 0.16);
      s.frequency.exponentialRampToValueAtTime(120, t0 + 0.26);
      const sG = sc.ctx.createGain();
      sG.gain.value = EPS;
      const end = shapeEnv(sG.gain, t0 + 0.16, 0.16, 0.003, 0.01, 0.12);
      s.connect(sG);
      sG.connect(v.gain);
      n.start(t0);
      n.stop(end + 0.02);
      s.start(t0);
      s.stop(end + 0.02);
      sc.voices.add(v, n);
      sc.voices.add(v, s, true);
    }
  }

  /** Eagle landing slam: sub thump + dirt burst + feather rustle. `k` 0..1 = weight. */
  landingImpact(gain = 1, k = 0.6): void {
    const sc = this.sc;
    const t0 = this.t;
    const v = sc.voices.create(t0);
    v.gain.gain.value = Math.max(EPS, gain);

    const s = osc(sc.ctx, 'sine', 72);
    s.frequency.setValueAtTime(72, t0);
    s.frequency.exponentialRampToValueAtTime(30, t0 + 0.32);
    const sG = sc.ctx.createGain();
    sG.gain.value = EPS;
    const sEnd = shapeEnv(sG.gain, t0, 0.5 + 0.2 * k, 0.006, 0.04, 0.34);
    s.connect(sG);
    sG.connect(v.gain);

    const d = noiseSource(sc);
    const lp = filter(sc.ctx, 'lowpass', 520, 0.7);
    const dG = sc.ctx.createGain();
    dG.gain.value = EPS;
    shapeEnv(dG.gain, t0, 0.4 + 0.15 * k, 0.004, 0.03, 0.22);
    d.connect(lp);
    lp.connect(dG);
    dG.connect(v.gain);

    // Feather rustle: airy bandpassed noise, amplitude-flutter via an LFO.
    const f = noiseSource(sc);
    const bp = filter(sc.ctx, 'bandpass', 2600, 0.9);
    const flutter = sc.ctx.createGain();
    flutter.gain.value = 0.5;
    const lfo = makeLFO(sc.ctx, flutter.gain, 23, 0.45, 'triangle');
    const fG = sc.ctx.createGain();
    fG.gain.value = EPS;
    const fEnd = shapeEnv(fG.gain, t0 + 0.03, 0.16, 0.05, 0.12, 0.3);
    f.connect(bp);
    bp.connect(flutter);
    flutter.connect(fG);
    fG.connect(v.gain);

    const end = Math.max(sEnd, fEnd) + 0.05;
    s.start(t0);
    s.stop(end);
    d.start(t0);
    d.stop(end);
    f.start(t0);
    f.stop(end);
    lfo.start(t0);
    lfo.stop(end);
    sc.voices.add(v, d);
    sc.voices.add(v, f);
    sc.voices.add(v, lfo);
    sc.voices.add(v, s, true);
  }

  /**
   * Fire crackle bed level (0..1). Built lazily on first use; stopped after a
   * few quiet seconds so an idle bed costs nothing.
   */
  setFireBed(level: number): void {
    const t = this.t;
    const lv = Math.min(1, Math.max(0, level));
    if (lv > 0.01 && this.bedGain === null) this.buildBed();
    if (this.bedGain === null) return;
    if (Math.abs(lv - this.bedLevel) > 0.015 || (lv === 0 && this.bedLevel !== 0)) {
      this.bedLevel = lv;
      this.bedGain.gain.setTargetAtTime(lv * 0.16, t, BED_RAMP);
    }
    if (lv <= 0.01) {
      if (this.bedQuietSince < 0) this.bedQuietSince = t;
      else if (t - this.bedQuietSince > BED_IDLE_STOP) this.stopBed();
    } else {
      this.bedQuietSince = -1;
    }
  }

  /** Stop the bed immediately (match teardown). */
  stopBed(): void {
    const g = this.bedGain;
    if (g === null) return;
    const t = this.t;
    try {
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(Math.max(EPS, g.gain.value), t);
      g.gain.exponentialRampToValueAtTime(EPS, t + 0.12);
    } catch {
      /* torn down */
    }
    for (const s of this.bedSources) {
      try {
        s.stop(t + 0.15);
      } catch {
        /* already stopped */
      }
    }
    const sources = this.bedSources;
    const gain = g;
    sources[0]?.addEventListener('ended', () => {
      try {
        gain.disconnect();
      } catch {
        /* ignore */
      }
    });
    this.bedSources = [];
    this.bedGain = null;
    this.bedLevel = 0;
    this.bedQuietSince = -1;
  }

  private buildBed(): void {
    const sc = this.sc;
    const t = this.t;
    const out = sc.ctx.createGain();
    out.gain.value = EPS;
    out.connect(sc.sfxBus);
    // Low roar of the flames.
    const roar = noiseSource(sc);
    roar.loop = true;
    const lp = filter(sc.ctx, 'lowpass', 520, 0.5);
    const roarG = sc.ctx.createGain();
    roarG.gain.value = 0.7;
    const wobble = makeLFO(sc.ctx, roarG.gain, 3.1, 0.25);
    roar.connect(lp);
    lp.connect(roarG);
    roarG.connect(out);
    // Crackle layer: highpassed noise, gated by a fast square-ish LFO pair.
    const crack = noiseSource(sc);
    crack.loop = true;
    const hp = filter(sc.ctx, 'highpass', 2800, 0.8);
    const crackG = sc.ctx.createGain();
    crackG.gain.value = 0.12;
    const gate1 = makeLFO(sc.ctx, crackG.gain, 11.3, 0.12, 'square');
    const gate2 = makeLFO(sc.ctx, crackG.gain, 7.7, 0.08, 'sawtooth');
    crack.connect(hp);
    hp.connect(crackG);
    crackG.connect(out);
    roar.start(t);
    crack.start(t, 1.3);
    wobble.start(t);
    gate1.start(t);
    gate2.start(t);
    this.bedSources = [roar, crack, wobble, gate1, gate2];
    this.bedGain = out;
    this.bedLevel = 0;
    this.bedQuietSince = -1;
  }
}
