/**
 * Jungle audio tests (v1.8 WP-J3), node-safe with a fake Web Audio graph: the pure level helpers, the splash / squelch throttles,
 * the slosh-voice cap, combat ducking, and the AudioEngine mapping — `splash` event → splash sound only while the jungle is the
 * arena, the jungle ambience REPLACES the crowd bed there, and the colosseum audio path is unchanged.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { JUNGLE_ARENA } from '../../src/config/arenas';
import { EventBus } from '../../src/core/EventBus';
import { AudioEngine } from '../../src/audio/AudioEngine';
import { JungleAudio, SLOSH_VOICES, sloshLevel, splashLevels } from '../../src/audio/jungle';
import { VoiceManager, makeWhiteNoise, type SynthCtx } from '../../src/audio/synth';
import { resetWaterActivity, setRenderArena, terrainAudio, waterActivity } from '../../src/render/arenaContext';

// ── Fake Web Audio ───────────────────────────────────────────────────────────

class FakeParam {
  value = 0;
  targets = 0;
  setValueAtTime(): this {
    return this;
  }
  linearRampToValueAtTime(): this {
    return this;
  }
  exponentialRampToValueAtTime(): this {
    return this;
  }
  cancelScheduledValues(): this {
    return this;
  }
  setTargetAtTime(): this {
    this.targets++;
    return this;
  }
}
class FakeNode {
  gain = new FakeParam();
  frequency = new FakeParam();
  Q = new FakeParam();
  pan = new FakeParam();
  type = '';
  buffer: unknown = null;
  loop = false;
  onended: (() => void) | null = null;
  connect<T>(n: T): T {
    return n;
  }
  disconnect(): void {}
  start(): void {}
  stop(): void {
    this.onended?.();
  }
}
class FakeCtx {
  currentTime = 0;
  state = 'running';
  sampleRate = 8000;
  destination = new FakeNode();
  createGain(): FakeNode {
    return new FakeNode();
  }
  createBufferSource(): FakeNode {
    return new FakeNode();
  }
  createBiquadFilter(): FakeNode {
    return new FakeNode();
  }
  createOscillator(): FakeNode {
    return new FakeNode();
  }
  createStereoPanner(): FakeNode {
    return new FakeNode();
  }
  createBuffer(_ch: number, len: number): { getChannelData(): Float32Array } {
    return { getChannelData: () => new Float32Array(len) };
  }
  async resume(): Promise<void> {}
  async close(): Promise<void> {}
}

function fakeSynth(): { sc: SynthCtx; ctx: FakeCtx; created: () => number } {
  const ctx = new FakeCtx();
  const sfx = new FakeNode();
  const voices = new VoiceManager(ctx as unknown as AudioContext, sfx as unknown as AudioNode, 24);
  let n = 0;
  const create = voices.create.bind(voices);
  voices.create = (t: number) => {
    n++;
    return create(t);
  };
  const sc = {
    ctx: ctx as unknown as AudioContext,
    sfxBus: sfx as unknown as GainNode,
    musicBus: new FakeNode() as unknown as GainNode,
    voices,
    noise: makeWhiteNoise(ctx as unknown as AudioContext, 1),
  } as SynthCtx;
  return { sc, ctx, created: () => n };
}

const listener = { has: true, x: 0, z: 0 };

beforeAll(() => {
  vi.stubGlobal('window', {
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal('AudioContext', FakeCtx);
});
afterAll(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  setRenderArena();
  resetWaterActivity();
  terrainAudio.mossStep = null;
});

describe('pure level helpers', () => {
  it('slosh level: silent when still, louder with speed, quieter with distance', () => {
    expect(sloshLevel(0.1, 0)).toBe(0);
    expect(sloshLevel(2, 0)).toBeLessThan(sloshLevel(5, 0));
    expect(sloshLevel(4, 0)).toBeGreaterThan(sloshLevel(4, 15));
    expect(sloshLevel(4, 40)).toBeLessThan(sloshLevel(4, 0) * 0.1);
    expect(sloshLevel(99, 0)).toBeLessThanOrEqual(0.16 + 1e-9);
  });

  it('splash levels scale with strength; leaving is softer than entering', () => {
    const a = splashLevels(0.1, true);
    const b = splashLevels(1, true);
    expect(b.noise).toBeGreaterThan(a.noise);
    expect(b.bloop).toBeGreaterThan(a.bloop);
    expect(b.dur).toBeGreaterThan(a.dur);
    expect(splashLevels(1, false).noise).toBeLessThan(b.noise);
    expect(splashLevels(-3, true).noise).toBeGreaterThan(0);
  });
});

describe('JungleAudio', () => {
  it('splash: only while the ambience runs, 50 ms apart at least and at most 8 per second', () => {
    const { sc, ctx, created } = fakeSynth();
    const ja = new JungleAudio(sc, () => listener);
    ja.splash(0.8, true);
    expect(created()).toBe(0); // not started: silent
    ja.start();
    const base = created();
    ja.splash(0.8, true, 1);
    expect(created()).toBeGreaterThan(base);
    const afterFirst = created();
    ja.splash(0.8, true, 1); // same instant: throttled
    expect(created()).toBe(afterFirst);
    let playedFirstSecond = 1;
    let played = 1;
    for (let i = 1; i < 40; i++) {
      ctx.currentTime = i * 0.06; // 40 attempts over 2.4 s
      const before = created();
      ja.splash(0.5, i % 2 === 0, 1);
      if (created() > before) {
        played++;
        if (ctx.currentTime < 1) playedFirstSecond++;
      }
    }
    expect(playedFirstSecond).toBeLessThanOrEqual(8);
    expect(played).toBeLessThan(40);
    const n = created();
    ctx.currentTime += 5;
    ja.splash(1, true, 0.001); // inaudible far away: skipped
    expect(created()).toBe(n);
    ja.stop();
  });

  it('squelch is throttled and skipped when far away', () => {
    const { sc, ctx, created } = fakeSynth();
    const ja = new JungleAudio(sc, () => listener);
    ja.start();
    const n0 = created();
    ja.squelch(1);
    const n1 = created();
    expect(n1).toBeGreaterThan(n0);
    ja.squelch(1);
    expect(created()).toBe(n1);
    ctx.currentTime += 0.2;
    ja.squelch(1);
    expect(created()).toBeGreaterThan(n1);
    ctx.currentTime += 0.2;
    const n2 = created();
    ja.squelch(0.01);
    expect(created()).toBe(n2);
    ja.stop();
  });

  it('keeps at most 3 slosh loops and ducks / decays under combat', () => {
    const { sc } = fakeSynth();
    const ja = new JungleAudio(sc, () => listener);
    ja.start();
    const inner = ja as unknown as { slosh: unknown[]; tick(): void; lastTick: number };
    expect(inner.slosh.length).toBe(SLOSH_VOICES);
    expect(SLOSH_VOICES).toBeLessThanOrEqual(3);
    // Eight swimmers: still only three voices exist and the tick never throws.
    waterActivity.count = 8;
    waterActivity.stamp = performance.now();
    for (let i = 0; i < 8; i++) {
      waterActivity.x[i] = i;
      waterActivity.z[i] = 0;
      waterActivity.speed[i] = 3 + i * 0.1;
    }
    inner.tick();
    expect(inner.slosh.length).toBe(3);
    ja.noteCombat(0.6);
    ja.noteCombat(0.9);
    expect(ja.combatLevel).toBe(1);
    inner.lastTick = performance.now() - 1500;
    inner.tick();
    expect(ja.combatLevel).toBeCloseTo(1 - 0.5 / 3, 2); // one tick decays at most 0.5 s worth (3 s to fully decay)
    ja.stop();
    expect(ja.running).toBe(false);
  });
});

describe('AudioEngine mapping', () => {
  async function engine(): Promise<AudioEngine> {
    const e = new AudioEngine();
    await e.resume();
    return e;
  }
  type Inner = { jungleMod: JungleAudio; crowdMod: { running: boolean } };

  it('jungle: startCrowd starts the jungle bed INSTEAD of the crowd; splash events and moss steps become audible', async () => {
    setRenderArena(JUNGLE_ARENA);
    const e = await engine();
    const bus = new EventBus();
    e.attachBus(bus);
    e.startCrowd();
    const internals = e as unknown as Inner;
    expect(internals.jungleMod.running).toBe(true);
    expect(internals.crowdMod.running).toBe(false);
    const spy = vi.spyOn(internals.jungleMod, 'splash');
    bus.emit({ type: 'splash', fighterId: 2, pos: { x: 1, y: 0, z: 1 }, entering: true, strength: 0.7 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBeCloseTo(0.7, 6);
    expect(spy.mock.calls[0][1]).toBe(true);
    expect(terrainAudio.mossStep).not.toBeNull();
    const sq = vi.spyOn(internals.jungleMod, 'squelch');
    terrainAudio.mossStep?.(3, 3);
    expect(sq).toHaveBeenCalledTimes(1);
    // A death scatters the birds instead of the crowd gasp / cheer.
    const flush = vi.spyOn(internals.jungleMod, 'flush');
    e.deathSfx();
    expect(flush).toHaveBeenCalledTimes(1);
    e.stopCrowd();
    expect(internals.jungleMod.running).toBe(false);
    expect(terrainAudio.mossStep).toBeNull();
    e.dispose();
  });

  it('colosseum: the crowd bed starts, the jungle stays silent, no moss hook', async () => {
    setRenderArena();
    const e = await engine();
    const bus = new EventBus();
    e.attachBus(bus);
    e.startCrowd();
    const internals = e as unknown as Inner;
    expect(internals.crowdMod.running).toBe(true);
    expect(internals.jungleMod.running).toBe(false);
    expect(terrainAudio.mossStep).toBeNull();
    const flush = vi.spyOn(internals.jungleMod, 'flush');
    e.deathSfx();
    expect(flush).not.toHaveBeenCalled();
    e.stopCrowd();
    expect(internals.crowdMod.running).toBe(false);
    e.dispose();
  });
});
