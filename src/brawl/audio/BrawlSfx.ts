/**
 * Champions League — procedural combat SFX on the shared synth graph (Web Audio only, no assets). Every voice
 * goes through the engine's VoiceManager (capped polyphony, sfx bus: master / sfx / mute apply) and uses
 * click-free envelopes. Sounds are panned by the fighter's X position and throttled per kind so a four-fighter
 * brawl cannot clip.
 */

import { filter, noiseSource, osc, shapeEnv, type SynthCtx, type Voice } from '../../audio/synth';

interface ToneOpts {
  type: OscillatorType;
  f0: number;
  /** End frequency (exponential glide over `glide` seconds). */
  f1?: number;
  glide?: number;
  peak: number;
  att?: number;
  hold?: number;
  rel: number;
  delay?: number;
}

interface NoiseOpts {
  filter: BiquadFilterType;
  f0: number;
  f1?: number;
  sweep?: number;
  q?: number;
  peak: number;
  att?: number;
  hold?: number;
  rel: number;
  delay?: number;
}

/** Minimum gap (seconds) between two sounds of the same kind. */
const GAP: Record<string, number> = {
  hit: 0.04,
  armor: 0.08,
  whoosh: 0.045,
  jump: 0.07,
  land: 0.08,
  dodge: 0.09,
  ledge: 0.12,
  ko: 0.3,
  respawn: 0.4,
  tick: 0.2,
  crack: 0.09,
  crash: 0.22,
  final: 2.0,
};
/** At most this many sounds per rolling window (guards a pile-up in a 4-way brawl). */
const WINDOW_S = 0.1;
const WINDOW_MAX = 7;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export class BrawlSfx {
  private readonly last = new Map<string, number>();
  private readonly recent: number[] = [];

  constructor(private readonly sc: SynthCtx) {}

  /** True if a sound of `kind` may play now (per-kind gap + global window cap). Records it when allowed. */
  allow(kind: string): boolean {
    const now = this.sc.ctx.currentTime;
    const gap = GAP[kind] ?? 0.03;
    const prev = this.last.get(kind);
    if (prev !== undefined && now - prev < gap) return false;
    while (this.recent.length > 0 && now - this.recent[0] > WINDOW_S) this.recent.shift();
    if (this.recent.length >= WINDOW_MAX) return false;
    this.recent.push(now);
    this.last.set(kind, now);
    return true;
  }

  // ── combat ─────────────────────────────────────────────────────────────────

  /** Hit: weight and pitch follow the damage; a sweetspot adds a crack + sub thump; big launches add a tail. */
  hit(damage: number, kbSpeed: number, sweetspot: boolean, pan: number): void {
    if (!this.allow('hit')) return;
    const k = clamp(damage / 18, 0, 1);
    const big = clamp(kbSpeed / 45, 0, 1);
    const { v, t0, fin } = this.begin(pan, 0.62);
    // smack: lowpassed noise burst
    this.noise(v, t0, { filter: 'lowpass', f0: 2600 - k * 1500, peak: 0.34 + k * 0.28, att: 0.003, hold: 0.008, rel: 0.05 + k * 0.08 }, fin);
    // body: sine drop, deeper for heavier hits
    this.tone(v, t0, { type: 'sine', f0: 190 - k * 90, f1: 46, glide: 0.1 + k * 0.1, peak: 0.42 + k * 0.3, att: 0.004, hold: 0.015, rel: 0.12 + k * 0.14 }, fin);
    if (k > 0.45 || sweetspot) {
      this.tone(v, t0, { type: 'sine', f0: 72, f1: 28, glide: 0.3, peak: 0.45 + big * 0.2, att: 0.006, hold: 0.03, rel: 0.28 }, fin);
    }
    if (sweetspot) {
      // crack on top of the thump
      this.noise(v, t0, { filter: 'bandpass', f0: 3400, q: 0.9, peak: 0.34, att: 0.001, hold: 0.004, rel: 0.07 }, fin);
      this.tone(v, t0, { type: 'square', f0: 880, f1: 330, glide: 0.08, peak: 0.1, att: 0.002, hold: 0.004, rel: 0.09 }, fin);
    }
    if (big > 0.55) {
      // launch tail: a short rising air sweep
      this.noise(v, t0, { filter: 'bandpass', f0: 500, f1: 2200, sweep: 0.22, q: 0.7, peak: 0.12 * big, att: 0.02, hold: 0.03, rel: 0.2, delay: 0.03 }, fin);
    }
    this.finish(v, fin);
  }

  /** Armor absorbed a hit: metallic clink over a dull thud. */
  armorClink(pan: number): void {
    if (!this.allow('armor')) return;
    const { v, t0, fin } = this.begin(pan, 0.8);
    const partials = [1.0, 1.58, 2.24, 3.03];
    const gains = [0.2, 0.12, 0.08, 0.05];
    partials.forEach((p, i) => this.tone(v, t0, { type: 'square', f0: 1100 * p, peak: gains[i], att: 0.002, hold: 0.004, rel: 0.14 - i * 0.02 }, fin));
    this.noise(v, t0, { filter: 'highpass', f0: 2600, peak: 0.1, att: 0.001, hold: 0.003, rel: 0.04 }, fin);
    this.tone(v, t0, { type: 'sine', f0: 120, f1: 55, glide: 0.1, peak: 0.28, att: 0.004, hold: 0.01, rel: 0.12 }, fin);
    this.finish(v, fin);
  }

  /** Move whoosh: heavier moves sweep lower and longer; aerials are airier. */
  whoosh(heavy: boolean, air: boolean, pan: number): void {
    if (!this.allow('whoosh')) return;
    const { v, t0, fin } = this.begin(pan);
    const hi = heavy ? 1100 : 2300;
    const lo = heavy ? 180 : 650;
    const dur = heavy ? 0.24 : 0.13;
    this.noise(v, t0, { filter: 'bandpass', f0: hi, f1: lo, sweep: dur, q: heavy ? 0.8 : 1.1, peak: heavy ? 0.3 : 0.2, att: 0.012, hold: 0.015, rel: dur * 0.7 }, fin);
    if (heavy) this.tone(v, t0, { type: 'sine', f0: 170, f1: 70, glide: dur, peak: 0.12, att: 0.02, hold: 0.04, rel: 0.2 }, fin);
    if (air) this.noise(v, t0, { filter: 'highpass', f0: 4200, peak: 0.04, att: 0.02, hold: 0.04, rel: 0.1 }, fin);
    this.finish(v, fin);
  }

  jump(air: boolean, pan: number): void {
    if (!this.allow('jump')) return;
    const { v, t0, fin } = this.begin(pan);
    if (air) {
      // flap: airy puff + quick rising blip
      this.noise(v, t0, { filter: 'bandpass', f0: 1500, f1: 3200, sweep: 0.1, q: 0.8, peak: 0.16, att: 0.008, hold: 0.01, rel: 0.1 }, fin);
      this.tone(v, t0, { type: 'triangle', f0: 420, f1: 820, glide: 0.09, peak: 0.1, att: 0.004, hold: 0.01, rel: 0.1 }, fin);
    } else {
      this.noise(v, t0, { filter: 'lowpass', f0: 900, peak: 0.12, att: 0.004, hold: 0.008, rel: 0.07 }, fin);
      this.tone(v, t0, { type: 'sine', f0: 240, f1: 420, glide: 0.08, peak: 0.12, att: 0.004, hold: 0.01, rel: 0.09 }, fin);
    }
    this.finish(v, fin);
  }

  land(hard: boolean, pan: number): void {
    if (!this.allow('land')) return;
    const { v, t0, fin } = this.begin(pan);
    this.tone(v, t0, { type: 'sine', f0: hard ? 110 : 150, f1: 48, glide: 0.1, peak: hard ? 0.4 : 0.18, att: 0.004, hold: 0.01, rel: hard ? 0.2 : 0.1 }, fin);
    this.noise(v, t0, { filter: 'lowpass', f0: hard ? 1200 : 800, peak: hard ? 0.24 : 0.1, att: 0.003, hold: 0.006, rel: hard ? 0.16 : 0.07 }, fin);
    this.finish(v, fin);
  }

  dodge(kind: 'spot' | 'roll' | 'air', pan: number): void {
    if (!this.allow('dodge')) return;
    const { v, t0, fin } = this.begin(pan);
    const dur = kind === 'spot' ? 0.14 : 0.2;
    this.noise(
      v,
      t0,
      { filter: 'bandpass', f0: kind === 'air' ? 1400 : 2600, f1: kind === 'air' ? 3400 : 700, sweep: dur, q: 1.4, peak: 0.16, att: 0.01, hold: 0.02, rel: dur },
      fin,
    );
    this.tone(v, t0, { type: 'sine', f0: kind === 'spot' ? 520 : 340, f1: kind === 'spot' ? 300 : 620, glide: dur, peak: 0.05, att: 0.01, hold: 0.02, rel: 0.12 }, fin);
    this.finish(v, fin);
  }

  ledgeGrab(pan: number): void {
    if (!this.allow('ledge')) return;
    const { v, t0, fin } = this.begin(pan);
    this.tone(v, t0, { type: 'square', f0: 1500, f1: 900, glide: 0.04, peak: 0.1, att: 0.001, hold: 0.003, rel: 0.05 }, fin);
    this.tone(v, t0, { type: 'square', f0: 2100, f1: 1300, glide: 0.04, peak: 0.07, att: 0.001, hold: 0.003, rel: 0.05, delay: 0.05 }, fin);
    this.noise(v, t0, { filter: 'bandpass', f0: 1800, q: 1.2, peak: 0.12, att: 0.002, hold: 0.006, rel: 0.07 }, fin);
    this.finish(v, fin);
  }

  /** Blast-zone KO: a boom with a falling rumble; top KOs add a rising shimmer, bottom KOs a long drop. */
  ko(side: 'left' | 'right' | 'top' | 'bottom', pan: number): void {
    if (!this.allow('ko')) return;
    const { v, t0, fin } = this.begin(pan * 0.5, 0.5);
    this.tone(v, t0, { type: 'sine', f0: 96, f1: 24, glide: 0.9, peak: 0.85, att: 0.006, hold: 0.06, rel: 0.85 }, fin);
    this.tone(v, t0, { type: 'sine', f0: 52, f1: 22, glide: 0.7, peak: 0.6, att: 0.01, hold: 0.1, rel: 0.7 }, fin);
    this.noise(v, t0, { filter: 'lowpass', f0: 2400, f1: 90, sweep: 0.9, q: 0.6, peak: 0.55, att: 0.004, hold: 0.04, rel: 0.7 }, fin);
    this.noise(v, t0, { filter: 'bandpass', f0: 3000, q: 0.8, peak: 0.28, att: 0.001, hold: 0.004, rel: 0.1 }, fin);
    if (side === 'top') {
      this.tone(v, t0, { type: 'triangle', f0: 400, f1: 1800, glide: 0.5, peak: 0.1, att: 0.02, hold: 0.1, rel: 0.45, delay: 0.05 }, fin);
    } else if (side === 'bottom') {
      this.tone(v, t0, { type: 'triangle', f0: 900, f1: 120, glide: 0.8, peak: 0.1, att: 0.02, hold: 0.1, rel: 0.5 }, fin);
    }
    this.finish(v, fin);
  }

  /** Respawn: a short rising chime (C5 E5 G5 C6). */
  respawn(pan: number): void {
    if (!this.allow('respawn')) return;
    const { v, t0, fin } = this.begin(pan * 0.4);
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      this.tone(v, t0, { type: 'sine', f0: f, peak: 0.12, att: 0.006, hold: 0.02, rel: 0.34, delay: i * 0.07 }, fin);
      this.tone(v, t0, { type: 'triangle', f0: f * 2, peak: 0.03, att: 0.006, hold: 0.01, rel: 0.2, delay: i * 0.07 }, fin);
    });
    this.finish(v, fin);
  }

  // ── v1.6 dynamic stages ────────────────────────────────────────────────────

  /** A counted hit on a breakable piece: a dry stone crack over a dull thud (throttled; the hit sound itself still plays). */
  stoneCrack(pan: number): void {
    if (!this.allow('crack')) return;
    const { v, t0, fin } = this.begin(pan, 0.7);
    this.noise(v, t0, { filter: 'bandpass', f0: 2200, f1: 700, sweep: 0.07, q: 1.1, peak: 0.3, att: 0.001, hold: 0.004, rel: 0.07 }, fin);
    this.noise(v, t0, { filter: 'highpass', f0: 3600, peak: 0.12, att: 0.001, hold: 0.002, rel: 0.03 }, fin);
    this.tone(v, t0, { type: 'sine', f0: 170, f1: 70, glide: 0.08, peak: 0.26, att: 0.003, hold: 0.008, rel: 0.1 }, fin);
    this.finish(v, fin);
  }

  /** A piece is destroyed: a heavy crash with a rumble tail and a few falling-rubble clatters. */
  stoneCrash(pan: number): void {
    if (!this.allow('crash')) return;
    const { v, t0, fin } = this.begin(pan * 0.7, 0.75);
    this.noise(v, t0, { filter: 'lowpass', f0: 3200, f1: 130, sweep: 0.6, q: 0.6, peak: 0.55, att: 0.002, hold: 0.04, rel: 0.55 }, fin);
    this.tone(v, t0, { type: 'sine', f0: 88, f1: 30, glide: 0.5, peak: 0.6, att: 0.004, hold: 0.05, rel: 0.5 }, fin);
    this.noise(v, t0, { filter: 'bandpass', f0: 1500, q: 0.8, peak: 0.28, att: 0.001, hold: 0.006, rel: 0.12 }, fin);
    const clatter = [0.09, 0.17, 0.26, 0.34, 0.47];
    clatter.forEach((d, i) => {
      this.noise(v, t0, { filter: 'bandpass', f0: 1100 + i * 380, q: 1.3, peak: 0.12 - i * 0.012, att: 0.001, hold: 0.003, rel: 0.05, delay: d }, fin);
    });
    this.finish(v, fin);
  }

  /** The arena transforms: a deep rumble swelling under a rising golden chime. */
  stageFinal(): void {
    if (!this.allow('final')) return;
    const { v, t0, fin } = this.begin(0, 0.8);
    this.tone(v, t0, { type: 'sine', f0: 52, f1: 26, glide: 1.6, peak: 0.7, att: 0.05, hold: 0.4, rel: 1.3 }, fin);
    this.noise(v, t0, { filter: 'lowpass', f0: 700, f1: 160, sweep: 1.7, q: 0.6, peak: 0.34, att: 0.04, hold: 0.3, rel: 1.2 }, fin);
    this.noise(v, t0, { filter: 'bandpass', f0: 3000, q: 0.8, peak: 0.2, att: 0.002, hold: 0.01, rel: 0.2 }, fin);
    [440, 659.25, 880, 1108.7, 1318.5].forEach((f, i) => {
      this.tone(v, t0, { type: 'sine', f0: f, peak: 0.13, att: 0.01, hold: 0.04, rel: 0.9, delay: 0.3 + i * 0.13 }, fin);
      this.tone(v, t0, { type: 'triangle', f0: f * 2, peak: 0.035, att: 0.01, hold: 0.02, rel: 0.6, delay: 0.3 + i * 0.13 }, fin);
    });
    this.finish(v, fin);
  }

  // ── countdown ──────────────────────────────────────────────────────────────

  /** 3 / 2 / 1 tick. */
  countdownTick(): void {
    if (!this.allow('tick')) return;
    const { v, t0, fin } = this.begin(0);
    this.tone(v, t0, { type: 'triangle', f0: 660, peak: 0.22, att: 0.004, hold: 0.07, rel: 0.12 }, fin);
    this.tone(v, t0, { type: 'sine', f0: 330, peak: 0.12, att: 0.004, hold: 0.07, rel: 0.12 }, fin);
    this.finish(v, fin);
  }

  /** FIGHT!: a bright two-note brass hit over a drum. */
  fight(): void {
    const { v, t0, fin } = this.begin(0);
    this.tone(v, t0, { type: 'sawtooth', f0: 392, peak: 0.18, att: 0.01, hold: 0.18, rel: 0.4 }, fin);
    this.tone(v, t0, { type: 'sawtooth', f0: 587.33, peak: 0.16, att: 0.01, hold: 0.18, rel: 0.4 }, fin);
    this.tone(v, t0, { type: 'sawtooth', f0: 784, peak: 0.12, att: 0.01, hold: 0.18, rel: 0.45, delay: 0.09 }, fin);
    this.tone(v, t0, { type: 'sine', f0: 120, f1: 44, glide: 0.2, peak: 0.6, att: 0.004, hold: 0.04, rel: 0.3 }, fin);
    this.noise(v, t0, { filter: 'bandpass', f0: 3200, q: 0.7, peak: 0.2, att: 0.002, hold: 0.01, rel: 0.25 }, fin);
    this.finish(v, fin);
  }

  // ── plumbing ───────────────────────────────────────────────────────────────

  private begin(pan: number, level = 1): { v: Voice; t0: number; fin: Array<[AudioScheduledSourceNode, number]> } {
    const t0 = this.sc.ctx.currentTime;
    const v = this.sc.voices.create(t0);
    v.gain.gain.value = level;
    if (Math.abs(pan) > 0.04 && typeof this.sc.ctx.createStereoPanner === 'function') {
      const p = this.sc.ctx.createStereoPanner();
      p.pan.value = clamp(pan, -0.85, 0.85);
      v.gain.disconnect();
      v.gain.connect(p);
      p.connect(this.sc.sfxBus);
    }
    return { v, t0, fin: [] };
  }

  /** Register all sources on the voice; the longest-lived one frees it. */
  private finish(v: Voice, fin: Array<[AudioScheduledSourceNode, number]>): void {
    let longest = -1;
    let end = -Infinity;
    fin.forEach(([, e], i) => {
      if (e > end) {
        end = e;
        longest = i;
      }
    });
    fin.forEach(([src], i) => this.sc.voices.add(v, src, i === longest));
  }

  private tone(v: Voice, t0: number, o: ToneOpts, fin: Array<[AudioScheduledSourceNode, number]>): void {
    const { ctx } = this.sc;
    const start = t0 + (o.delay ?? 0);
    const src = osc(ctx, o.type, o.f0);
    if (o.f1 !== undefined) {
      src.frequency.setValueAtTime(o.f0, start);
      src.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), start + (o.glide ?? 0.1));
    }
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    const end = shapeEnv(g.gain, start, o.peak, o.att ?? 0.005, o.hold ?? 0.01, o.rel);
    src.connect(g);
    g.connect(v.gain);
    src.start(start);
    src.stop(end + 0.03);
    fin.push([src, end + 0.03]);
  }

  private noise(v: Voice, t0: number, o: NoiseOpts, fin: Array<[AudioScheduledSourceNode, number]>): void {
    const { ctx } = this.sc;
    const start = t0 + (o.delay ?? 0);
    const src = noiseSource(this.sc);
    const f = filter(ctx, o.filter, o.f0, o.q ?? 0.7);
    if (o.f1 !== undefined) {
      f.frequency.setValueAtTime(o.f0, start);
      f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), start + (o.sweep ?? 0.15));
    }
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    const end = shapeEnv(g.gain, start, o.peak, o.att ?? 0.005, o.hold ?? 0.01, o.rel);
    src.connect(f);
    f.connect(g);
    g.connect(v.gain);
    src.start(start);
    src.stop(end + 0.03);
    fin.push([src, end + 0.03]);
  }
}
