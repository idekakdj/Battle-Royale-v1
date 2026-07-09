/**
 * Low-level Web Audio synthesis helpers (BLUEPRINT §13, WP-G).
 *
 * Everything the audio package builds — SFX, roars, crowd, music — is 100%
 * synthesised here from oscillators and noise. Two invariants live in this file:
 *
 *  1. **No clicks/pops.** Every amplitude envelope starts and ends at (near) zero
 *     with shaped attack/release; see {@link shapeEnv}.
 *  2. **Bounded polyphony.** {@link VoiceManager} caps simultaneous SFX voices and
 *     steals the oldest (fading it, never hard-cutting) when the cap is exceeded.
 *
 * No audio files, no external assets — a white-noise {@link AudioBuffer} is
 * generated once and reused as the source for every noise-based voice.
 */

/** Smallest non-zero level used for exponential ramps (they cannot reach 0). */
export const EPS = 1e-4;

/**
 * Shared audio graph handed to every sub-module. `sfxBus`/`musicBus` are the two
 * category sub-mixes; SFX-ish transient voices route through {@link VoiceManager}
 * (which connects them to `sfxBus`), continuous beds connect to a bus directly.
 */
export interface SynthCtx {
  ctx: AudioContext;
  sfxBus: GainNode;
  musicBus: GainNode;
  voices: VoiceManager;
  /** Cached white noise (a few seconds); reuse as the buffer for noise sources. */
  noise: AudioBuffer;
}

/** Generate a mono white-noise buffer once; reuse its data for every noise voice. */
export function makeWhiteNoise(ctx: AudioContext, seconds = 3): AudioBuffer {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

/**
 * Shape an amplitude envelope on `param` with a click-free attack/hold/release.
 * Starts at {@link EPS}, linear-ramps up to `peak`, holds, then exponential-decays
 * back to {@link EPS}. Returns the absolute end time so callers can stop sources.
 */
export function shapeEnv(
  param: AudioParam,
  t0: number,
  peak: number,
  attack: number,
  hold: number,
  release: number,
): number {
  const start = Math.max(t0, 0);
  const top = Math.max(peak, EPS);
  const holdEnd = start + attack + hold;
  const end = holdEnd + release;
  param.cancelScheduledValues(start);
  param.setValueAtTime(EPS, start);
  param.linearRampToValueAtTime(top, start + attack);
  param.setValueAtTime(top, holdEnd);
  param.exponentialRampToValueAtTime(EPS, end);
  return end;
}

/**
 * A group of nodes with one shared output {@link GainNode}. Sources registered on
 * it are stopped early when the voice is stolen, and the terminal source frees the
 * voice when it ends.
 */
export interface Voice {
  gain: GainNode;
  sources: AudioScheduledSourceNode[];
  startTime: number;
}

/** Caps concurrent SFX voices (~24) and steals the oldest by fading, not cutting. */
export class VoiceManager {
  private readonly active: Voice[] = [];

  constructor(
    private readonly ctx: AudioContext,
    private readonly dest: AudioNode,
    private readonly max = 24,
  ) {}

  /** Allocate a voice whose gain is routed to the SFX bus. */
  create(startTime: number): Voice {
    const gain = this.ctx.createGain();
    gain.connect(this.dest);
    const v: Voice = { gain, sources: [], startTime };
    this.active.push(v);
    while (this.active.length > this.max) {
      const victim = this.active.shift();
      if (victim !== undefined) this.steal(victim);
    }
    return v;
  }

  /**
   * Register a source on the voice. Mark the longest-lived one `terminal` so its
   * `onended` disposes the voice.
   */
  add(v: Voice, src: AudioScheduledSourceNode, terminal = false): void {
    v.sources.push(src);
    if (terminal) src.onended = () => this.dispose(v);
  }

  private steal(v: Voice): void {
    const t = this.ctx.currentTime;
    try {
      const cur = Math.max(v.gain.gain.value, EPS);
      v.gain.gain.cancelScheduledValues(t);
      v.gain.gain.setValueAtTime(cur, t);
      v.gain.gain.exponentialRampToValueAtTime(EPS, t + 0.03);
    } catch {
      /* param already torn down — ignore */
    }
    // Sources finish naturally and fire onended → dispose(); the fade above keeps
    // the steal inaudible in the meantime.
  }

  private dispose(v: Voice): void {
    const i = this.active.indexOf(v);
    if (i !== -1) this.active.splice(i, 1);
    try {
      v.gain.disconnect();
    } catch {
      /* already disconnected — ignore */
    }
  }
}

/** Create a one-shot noise source from the cached buffer. */
export function noiseSource(sc: SynthCtx): AudioBufferSourceNode {
  const src = sc.ctx.createBufferSource();
  src.buffer = sc.noise;
  return src;
}

/** Create a bandpass/lowpass/highpass filter node. */
export function filter(
  ctx: AudioContext,
  type: BiquadFilterType,
  freq: number,
  q = 1,
): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

/** Create an oscillator at a fixed frequency (no envelope). */
export function osc(ctx: AudioContext, type: OscillatorType, freq: number): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  return o;
}

/**
 * Build an amplitude-modulation "growl": an LFO oscillator whose output is scaled
 * by `depth` and added to `target` (typically a gain param sitting at `base`).
 * Returns the LFO so the caller can start/stop it with the voice.
 */
export function makeLFO(
  ctx: AudioContext,
  target: AudioParam,
  freq: number,
  depth: number,
  type: OscillatorType = 'sine',
): OscillatorNode {
  const lfo = ctx.createOscillator();
  lfo.type = type;
  lfo.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.value = depth;
  lfo.connect(g);
  g.connect(target);
  return lfo;
}
