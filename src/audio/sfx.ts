/**
 * Combat & UI sound effects (BLUEPRINT §13, WP-G) — all synthesised, envelope
 * shaped (no clicks). Every voice is allocated through the shared
 * {@link VoiceManager} so simultaneous SFX stay under the polyphony cap.
 *
 * Recipes (from §13):
 *  - swing whoosh: bandpassed noise sweep, pitch scaled by animal size
 *  - hit thud: noise burst + 80→40 Hz sine drop (heavy = extra low layer)
 *  - blocked: metallic ping (~1.2 kHz + inharmonic partials)
 *  - guard break: crack + low boom
 *  - finisher: heavier layered thud
 *  - pickup: heal = warm triad, speed = arpeggio up, rage = drum hit
 *  - telegraph: short warning tick
 *  - death: thud (crowd gasp→cheer is layered by AudioEngine)
 *  - ult stinger: per-animal flourish (roar layered separately)
 *  - special: whoosh variant
 *  - UI: click / hover blips
 */

import type { AnimalId, PickupState } from '../core/types';
import { ANIMALS } from '../config/animals';
import { filter, makeLFO, noiseSource, osc, shapeEnv, type SynthCtx } from './synth';

/** Map a fighter collider radius (0.5–1.2 m) to a 0..1 "size" (0 = small/high). */
function sizeOf(animal: AnimalId): number {
  const r = ANIMALS[animal].radius;
  return Math.min(1, Math.max(0, (r - 0.5) / (1.2 - 0.5)));
}

export class Sfx {
  constructor(private readonly sc: SynthCtx) {}

  private get t(): number {
    return this.sc.ctx.currentTime;
  }

  /** Swing whoosh: bandpassed noise sweep; bigger animal ⇒ lower pitch. */
  swing(animal: AnimalId): void {
    const sc = this.sc;
    const t0 = this.t;
    const size = sizeOf(animal);
    const hi = 2200 - size * 1200; // small animals cut higher
    const lo = 700 - size * 350;
    const v = sc.voices.create(t0);

    const src = noiseSource(sc);
    const bp = filter(sc.ctx, 'bandpass', hi, 1.1);
    bp.frequency.setValueAtTime(hi, t0);
    bp.frequency.exponentialRampToValueAtTime(Math.max(lo, 60), t0 + 0.16);
    src.connect(bp);
    bp.connect(v.gain);

    const end = shapeEnv(v.gain.gain, t0, 0.28, 0.012, 0.02, 0.12);
    src.start(t0);
    src.stop(end + 0.02);
    sc.voices.add(v, src, true);
  }

  /** Special ability: an airier, lower whoosh variant with a pitch drop. */
  special(animal: AnimalId): void {
    const sc = this.sc;
    const t0 = this.t;
    const size = sizeOf(animal);
    const v = sc.voices.create(t0);

    const src = noiseSource(sc);
    const bp = filter(sc.ctx, 'bandpass', 1600 - size * 700, 0.8);
    bp.frequency.setValueAtTime(1600 - size * 700, t0);
    bp.frequency.exponentialRampToValueAtTime(240, t0 + 0.3);
    src.connect(bp);
    bp.connect(v.gain);

    // A low "swoosh body" sine underneath.
    const body = osc(sc.ctx, 'sine', 220 - size * 90);
    body.frequency.exponentialRampToValueAtTime(90 - size * 30, t0 + 0.3);
    const bodyGain = sc.ctx.createGain();
    bodyGain.gain.value = 0.0001;
    shapeEnv(bodyGain.gain, t0, 0.16, 0.02, 0.05, 0.22);
    body.connect(bodyGain);
    bodyGain.connect(v.gain);

    const end = shapeEnv(v.gain.gain, t0, 0.3, 0.02, 0.06, 0.24);
    src.start(t0);
    src.stop(end + 0.02);
    body.start(t0);
    body.stop(end + 0.02);
    sc.voices.add(v, src);
    sc.voices.add(v, body, true);
  }

  /** Hit thud: short noise burst + 80→40 Hz sine drop. Heavy adds a lower layer. */
  hit(heavy = false): void {
    const sc = this.sc;
    const t0 = this.t;
    const v = sc.voices.create(t0);
    const level = heavy ? 0.55 : 0.4;

    // Smack: lowpassed noise burst.
    const n = noiseSource(sc);
    const lp = filter(sc.ctx, 'lowpass', heavy ? 900 : 1400, 0.7);
    const nGain = sc.ctx.createGain();
    nGain.gain.value = 0.0001;
    shapeEnv(nGain.gain, t0, level * 0.7, 0.004, 0.008, heavy ? 0.11 : 0.07);
    n.connect(lp);
    lp.connect(nGain);
    nGain.connect(v.gain);

    // Body: 80→40 Hz sine drop.
    const s = osc(sc.ctx, 'sine', 80);
    s.frequency.setValueAtTime(80, t0);
    s.frequency.exponentialRampToValueAtTime(40, t0 + (heavy ? 0.22 : 0.14));
    const sGain = sc.ctx.createGain();
    sGain.gain.value = 0.0001;
    shapeEnv(sGain.gain, t0, level, 0.006, 0.02, heavy ? 0.24 : 0.15);
    s.connect(sGain);
    sGain.connect(v.gain);

    v.gain.gain.value = 1;
    let end = t0 + (heavy ? 0.5 : 0.32);

    // Heavy: extra sub layer (60→30 Hz) for the finisher weight.
    if (heavy) {
      const sub = osc(sc.ctx, 'sine', 60);
      sub.frequency.setValueAtTime(60, t0);
      sub.frequency.exponentialRampToValueAtTime(30, t0 + 0.3);
      const subGain = sc.ctx.createGain();
      subGain.gain.value = 0.0001;
      const subEnd = shapeEnv(subGain.gain, t0, 0.4, 0.01, 0.04, 0.3);
      sub.connect(subGain);
      subGain.connect(v.gain);
      sub.start(t0);
      sub.stop(subEnd + 0.02);
      sc.voices.add(v, sub);
      end = subEnd + 0.05;
    }

    n.start(t0);
    n.stop(end);
    s.start(t0);
    s.stop(end);
    sc.voices.add(v, n);
    sc.voices.add(v, s, true);
  }

  /** Finisher / combo-finisher: heavier layered thud. */
  finisher(): void {
    this.hit(true);
  }

  /** Blocked: metallic ping — 1.2 kHz fundamental + inharmonic partials. */
  blocked(): void {
    const sc = this.sc;
    const t0 = this.t;
    const v = sc.voices.create(t0);
    const partials = [1.0, 1.58, 2.24, 3.03];
    const gains = [0.24, 0.14, 0.09, 0.06];
    let end = t0;
    for (let i = 0; i < partials.length; i++) {
      const o = osc(sc.ctx, 'square', 1200 * partials[i]);
      const g = sc.ctx.createGain();
      g.gain.value = 0.0001;
      const e = shapeEnv(g.gain, t0, gains[i], 0.002, 0.004, 0.12 - i * 0.02);
      o.connect(g);
      g.connect(v.gain);
      o.start(t0);
      o.stop(e + 0.02);
      sc.voices.add(v, o, i === 0);
      end = Math.max(end, e);
    }
    // Bright noise chink for the "clang" transient.
    const n = noiseSource(sc);
    const hp = filter(sc.ctx, 'highpass', 2500, 0.7);
    const nGain = sc.ctx.createGain();
    nGain.gain.value = 0.0001;
    shapeEnv(nGain.gain, t0, 0.12, 0.001, 0.003, 0.04);
    n.connect(hp);
    hp.connect(nGain);
    nGain.connect(v.gain);
    n.start(t0);
    n.stop(end + 0.02);
    sc.voices.add(v, n);
    v.gain.gain.value = 1;
  }

  /** Guard break: sharp crack (high noise) + low boom. */
  guardBreak(): void {
    const sc = this.sc;
    const t0 = this.t;
    const v = sc.voices.create(t0);

    // Crack.
    const n = noiseSource(sc);
    const hp = filter(sc.ctx, 'highpass', 1800, 0.6);
    const nGain = sc.ctx.createGain();
    nGain.gain.value = 0.0001;
    shapeEnv(nGain.gain, t0, 0.35, 0.001, 0.006, 0.09);
    n.connect(hp);
    hp.connect(nGain);
    nGain.connect(v.gain);

    // Low boom: 90→45 Hz sine + noise rumble.
    const s = osc(sc.ctx, 'sine', 90);
    s.frequency.setValueAtTime(90, t0);
    s.frequency.exponentialRampToValueAtTime(45, t0 + 0.35);
    const sGain = sc.ctx.createGain();
    sGain.gain.value = 0.0001;
    const boomEnd = shapeEnv(sGain.gain, t0 + 0.02, 0.5, 0.02, 0.06, 0.4);
    s.connect(sGain);
    sGain.connect(v.gain);

    const rn = noiseSource(sc);
    const rlp = filter(sc.ctx, 'lowpass', 200, 0.9);
    const rGain = sc.ctx.createGain();
    rGain.gain.value = 0.0001;
    shapeEnv(rGain.gain, t0 + 0.02, 0.22, 0.02, 0.05, 0.35);
    rn.connect(rlp);
    rlp.connect(rGain);
    rGain.connect(v.gain);

    v.gain.gain.value = 1;
    const end = boomEnd + 0.05;
    n.start(t0);
    n.stop(t0 + 0.12);
    rn.start(t0);
    rn.stop(end);
    s.start(t0);
    s.stop(end);
    sc.voices.add(v, n);
    sc.voices.add(v, rn);
    sc.voices.add(v, s, true);
  }

  /** Telegraph warning tick: short two-tone blip. */
  telegraph(): void {
    const sc = this.sc;
    const t0 = this.t;
    const v = sc.voices.create(t0);
    const o = osc(sc.ctx, 'square', 880);
    o.frequency.setValueAtTime(880, t0);
    o.frequency.setValueAtTime(660, t0 + 0.05);
    const lp = filter(sc.ctx, 'lowpass', 2600, 0.5);
    o.connect(lp);
    lp.connect(v.gain);
    const end = shapeEnv(v.gain.gain, t0, 0.16, 0.004, 0.02, 0.05);
    o.start(t0);
    o.stop(end + 0.02);
    sc.voices.add(v, o, true);
  }

  /** Pickup chime, varying by kind (§13). */
  pickup(kind: PickupState['kind']): void {
    if (kind === 'heal') this.healChime();
    else if (kind === 'speed') this.speedArp();
    else this.rageHit();
  }

  private healChime(): void {
    const sc = this.sc;
    const t0 = this.t;
    const v = sc.voices.create(t0);
    const triad = [523.25, 659.25, 783.99]; // C5 E5 G5
    let end = t0;
    for (let i = 0; i < triad.length; i++) {
      const o = osc(sc.ctx, 'triangle', triad[i]);
      const g = sc.ctx.createGain();
      g.gain.value = 0.0001;
      const e = shapeEnv(g.gain, t0, 0.16, 0.02, 0.16, 0.4);
      o.connect(g);
      g.connect(v.gain);
      o.start(t0);
      o.stop(e + 0.02);
      sc.voices.add(v, o, i === 0);
      end = Math.max(end, e);
    }
    v.gain.gain.value = 1;
  }

  private speedArp(): void {
    const sc = this.sc;
    const t0 = this.t;
    const v = sc.voices.create(t0);
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    const step = 0.06;
    let end = t0;
    for (let i = 0; i < notes.length; i++) {
      const nt = t0 + i * step;
      const o = osc(sc.ctx, 'triangle', notes[i]);
      const g = sc.ctx.createGain();
      g.gain.value = 0.0001;
      const e = shapeEnv(g.gain, nt, 0.16, 0.006, 0.02, 0.12);
      o.connect(g);
      g.connect(v.gain);
      o.start(nt);
      o.stop(e + 0.02);
      sc.voices.add(v, o, i === notes.length - 1);
      end = Math.max(end, e);
    }
    v.gain.gain.value = 1;
  }

  private rageHit(): void {
    const sc = this.sc;
    const t0 = this.t;
    const v = sc.voices.create(t0);
    // War-drum: low sine thump + noise body.
    const s = osc(sc.ctx, 'sine', 150);
    s.frequency.setValueAtTime(150, t0);
    s.frequency.exponentialRampToValueAtTime(60, t0 + 0.18);
    const sGain = sc.ctx.createGain();
    sGain.gain.value = 0.0001;
    const end = shapeEnv(sGain.gain, t0, 0.5, 0.006, 0.03, 0.2);
    s.connect(sGain);
    sGain.connect(v.gain);

    const n = noiseSource(sc);
    const lp = filter(sc.ctx, 'lowpass', 500, 0.8);
    const nGain = sc.ctx.createGain();
    nGain.gain.value = 0.0001;
    shapeEnv(nGain.gain, t0, 0.28, 0.003, 0.02, 0.12);
    n.connect(lp);
    lp.connect(nGain);
    nGain.connect(v.gain);

    v.gain.gain.value = 1;
    s.start(t0);
    s.stop(end + 0.02);
    n.start(t0);
    n.stop(end + 0.02);
    sc.voices.add(v, n);
    sc.voices.add(v, s, true);
  }

  /** Per-animal ultimate stinger (a short flourish; the roar is layered by the engine). */
  ultStinger(animal: AnimalId): void {
    const sc = this.sc;
    const t0 = this.t;
    const v = sc.voices.create(t0);
    const size = sizeOf(animal);
    const accent = ANIMALS[animal].accent;
    // Base note scaled by size: bigger animal ⇒ lower, weightier stinger.
    const base = 330 - size * 170;
    // A rising perfect-fifth swell through a lowpass — regal but brief.
    const detune = [0, 3, 7]; // semitone-ish offsets for a stacked chord shimmer
    const lpf = filter(sc.ctx, 'lowpass', 3000, 0.6);
    lpf.connect(v.gain);
    let end = t0;
    for (let i = 0; i < detune.length; i++) {
      const freq = base * Math.pow(2, detune[i] / 12);
      const o = osc(sc.ctx, 'sawtooth', freq);
      o.frequency.setValueAtTime(freq * 0.75, t0);
      o.frequency.exponentialRampToValueAtTime(freq, t0 + 0.25);
      const g = sc.ctx.createGain();
      g.gain.value = 0.0001;
      const e = shapeEnv(g.gain, t0, 0.14, 0.03, 0.14, 0.35);
      o.connect(g);
      g.connect(lpf);
      o.start(t0);
      o.stop(e + 0.02);
      sc.voices.add(v, o, i === 0);
      end = Math.max(end, e);
    }
    // Impact transient tinted by accent brightness (hash the hex for variety).
    const bright = (parseInt(accent.slice(1, 3), 16) / 255) * 0.5 + 0.5;
    const n = noiseSource(sc);
    const bp = filter(sc.ctx, 'bandpass', 400 + bright * 1600, 0.9);
    const nGain = sc.ctx.createGain();
    nGain.gain.value = 0.0001;
    shapeEnv(nGain.gain, t0, 0.22, 0.002, 0.02, 0.18);
    n.connect(bp);
    bp.connect(v.gain);
    n.start(t0);
    n.stop(end + 0.02);
    sc.voices.add(v, n);
    v.gain.gain.value = 1;
  }

  /** Crate break: dry woody crack. */
  crateBreak(): void {
    const sc = this.sc;
    const t0 = this.t;
    const v = sc.voices.create(t0);
    const n = noiseSource(sc);
    const bp = filter(sc.ctx, 'bandpass', 900, 1.4);
    const nGain = sc.ctx.createGain();
    nGain.gain.value = 0.0001;
    const end = shapeEnv(nGain.gain, t0, 0.3, 0.002, 0.01, 0.14);
    n.connect(bp);
    bp.connect(nGain);
    nGain.connect(v.gain);
    // Low knock.
    const s = osc(sc.ctx, 'triangle', 140);
    s.frequency.exponentialRampToValueAtTime(70, t0 + 0.12);
    const sGain = sc.ctx.createGain();
    sGain.gain.value = 0.0001;
    shapeEnv(sGain.gain, t0, 0.2, 0.004, 0.01, 0.1);
    s.connect(sGain);
    sGain.connect(v.gain);
    v.gain.gain.value = 1;
    n.start(t0);
    n.stop(end + 0.02);
    s.start(t0);
    s.stop(end + 0.02);
    sc.voices.add(v, n);
    sc.voices.add(v, s, true);
  }

  /** UI click: firm short tick. */
  uiClick(): void {
    const sc = this.sc;
    const t0 = this.t;
    const v = sc.voices.create(t0);
    const o = osc(sc.ctx, 'triangle', 660);
    o.frequency.setValueAtTime(660, t0);
    o.frequency.exponentialRampToValueAtTime(440, t0 + 0.05);
    o.connect(v.gain);
    const end = shapeEnv(v.gain.gain, t0, 0.13, 0.003, 0.008, 0.05);
    o.start(t0);
    o.stop(end + 0.02);
    sc.voices.add(v, o, true);
  }

  /** UI hover: soft high blip. */
  uiHover(): void {
    const sc = this.sc;
    const t0 = this.t;
    const v = sc.voices.create(t0);
    const o = osc(sc.ctx, 'sine', 1200);
    o.connect(v.gain);
    const end = shapeEnv(v.gain.gain, t0, 0.05, 0.004, 0.006, 0.05);
    o.start(t0);
    o.stop(end + 0.02);
    sc.voices.add(v, o, true);
  }

  /** Amplitude-modulated low rumble used to weight death impacts (crowd is separate). */
  deathThud(): void {
    this.hit(true);
    // Extra sub-thump.
    const sc = this.sc;
    const t0 = this.t;
    const v = sc.voices.create(t0);
    const s = osc(sc.ctx, 'sine', 55);
    s.frequency.exponentialRampToValueAtTime(28, t0 + 0.4);
    const g = sc.ctx.createGain();
    g.gain.value = 0.0001;
    const end = shapeEnv(g.gain, t0, 0.4, 0.01, 0.05, 0.4);
    const lfo = makeLFO(sc.ctx, g.gain, 7, 0.05);
    s.connect(g);
    g.connect(v.gain);
    v.gain.gain.value = 1;
    s.start(t0);
    s.stop(end + 0.02);
    lfo.start(t0);
    lfo.stop(end + 0.02);
    sc.voices.add(v, lfo);
    sc.voices.add(v, s, true);
  }
}
