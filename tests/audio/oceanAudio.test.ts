/**
 * Ocean Dome audio tests (v1.9 WP-O3), node-safe with a fake Web Audio graph: the serpent one-shot throttles, ambience start / stop,
 * combat ducking, and the AudioEngine mapping - the serpent events make sounds ONLY while the Ocean Dome is the arena, the
 * underwater bed replaces the crowd there, and the colosseum / jungle audio paths are unchanged.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { JUNGLE_ARENA, OCEAN_ARENA } from '../../src/config/arenas';
import { EventBus } from '../../src/core/EventBus';
import { AudioEngine } from '../../src/audio/AudioEngine';
import { OceanAudio, hitLevel } from '../../src/audio/ocean';
import { VoiceManager, makeWhiteNoise, type SynthCtx } from '../../src/audio/synth';
import { resetWaterActivity, setRenderArena, terrainAudio } from '../../src/render/arenaContext';

class FakeParam {
  value = 0;
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

describe('OceanAudio', () => {
  it('serpent sounds only play while the ambience runs; warning / strike are rate-limited', () => {
    const { sc, ctx, created } = fakeSynth();
    const oa = new OceanAudio(sc, () => listener);
    oa.warning();
    oa.strike();
    oa.hit(1);
    expect(created()).toBe(0); // not started: silent
    oa.start();
    const base = created();
    oa.warning();
    const afterWarn = created();
    expect(afterWarn).toBeGreaterThan(base + 3); // klaxon pulses + growl + rumble
    oa.warning(); // same instant: throttled
    expect(created()).toBe(afterWarn);
    ctx.currentTime += 2;
    oa.warning();
    expect(created()).toBeGreaterThan(afterWarn);
    const n1 = created();
    oa.strike();
    expect(created()).toBeGreaterThan(n1 + 8); // shatter + shards + crash + roar + hold thump + retreat rumble
    const n2 = created();
    oa.strike();
    expect(created()).toBe(n2);
    oa.stop();
    expect(oa.running).toBe(false);
  });

  it('hit: at most 4 per second and 80 ms apart, silent when far away, raises the combat duck', () => {
    const { sc, ctx, created } = fakeSynth();
    const oa = new OceanAudio(sc, () => listener);
    oa.start();
    const times: number[] = [];
    for (let i = 0; i < 30; i++) {
      ctx.currentTime = i * 0.05; // 30 attempts over 1.5 s
      const before = created();
      oa.hit(1);
      if (created() > before) times.push(ctx.currentTime);
    }
    expect(times.length).toBeGreaterThan(2);
    // never more than 4 within any one-second window, and at least 80 ms apart
    for (let i = 0; i < times.length; i++) {
      expect(times.filter((x) => x >= times[i] && x < times[i] + 1).length).toBeLessThanOrEqual(4);
      if (i > 0) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(0.08 - 1e-9);
    }
    const n = created();
    ctx.currentTime += 5;
    oa.hit(0.001);
    expect(created()).toBe(n);
    expect(oa.combatLevel).toBeGreaterThan(0);
    expect(hitLevel(2)).toBe(1);
    expect(hitLevel(-1)).toBe(0);
    oa.stop();
  });

  it('ducks and decays under combat', () => {
    const { sc } = fakeSynth();
    const oa = new OceanAudio(sc, () => listener);
    oa.start();
    const inner = oa as unknown as { tick(): void; lastTick: number };
    oa.noteCombat(0.6);
    oa.noteCombat(0.9);
    expect(oa.combatLevel).toBe(1);
    inner.lastTick = performance.now() - 1500;
    inner.tick();
    expect(oa.combatLevel).toBeCloseTo(1 - 0.5 / 3, 2);
    oa.stop();
  });
});

describe('AudioEngine mapping', () => {
  type Inner = { oceanMod: OceanAudio; jungleMod: { running: boolean }; crowdMod: { running: boolean } };
  async function engine(): Promise<AudioEngine> {
    const e = new AudioEngine();
    await e.resume();
    return e;
  }

  it('ocean: startCrowd starts the underwater bed INSTEAD of the crowd; the serpent events become sounds; a death sends bubbles', async () => {
    setRenderArena(OCEAN_ARENA);
    const e = await engine();
    const bus = new EventBus();
    e.attachBus(bus);
    e.startCrowd();
    const inner = e as unknown as Inner;
    expect(inner.oceanMod.running).toBe(true);
    expect(inner.crowdMod.running).toBe(false);
    expect(inner.jungleMod.running).toBe(false);
    const warn = vi.spyOn(inner.oceanMod, 'warning');
    const strike = vi.spyOn(inner.oceanMod, 'strike');
    const hit = vi.spyOn(inner.oceanMod, 'hit');
    const flush = vi.spyOn(inner.oceanMod, 'flush');
    bus.emit({ type: 'serpentWarning', angleDeg: 40, warnS: 1.1 });
    expect(warn).toHaveBeenCalledTimes(1);
    bus.emit({ type: 'serpentStrike', angleDeg: 40 });
    expect(strike).toHaveBeenCalledTimes(1);
    bus.emit({ type: 'serpentHit', fighterId: 2, damage: 300, pos: { x: 3, y: 0, z: 3 } });
    expect(hit).toHaveBeenCalledTimes(1);
    expect(hit.mock.calls[0][0]).toBeGreaterThan(0);
    bus.emit({ type: 'serpentEnd' });
    e.deathSfx();
    expect(flush).toHaveBeenCalledTimes(1);
    e.stopCrowd();
    expect(inner.oceanMod.running).toBe(false);
    e.dispose();
  });

  it('colosseum and jungle: the serpent events are silent and the ocean bed never starts', async () => {
    for (const arena of [undefined, JUNGLE_ARENA]) {
      setRenderArena(arena);
      const e = await engine();
      const bus = new EventBus();
      e.attachBus(bus);
      e.startCrowd();
      const inner = e as unknown as Inner;
      expect(inner.oceanMod.running).toBe(false);
      const warn = vi.spyOn(inner.oceanMod, 'warning');
      const strike = vi.spyOn(inner.oceanMod, 'strike');
      const hit = vi.spyOn(inner.oceanMod, 'hit');
      bus.emit({ type: 'serpentWarning', angleDeg: 40, warnS: 1.1 });
      bus.emit({ type: 'serpentStrike', angleDeg: 40 });
      bus.emit({ type: 'serpentHit', fighterId: 2, damage: 300, pos: { x: 3, y: 0, z: 3 } });
      expect(warn).not.toHaveBeenCalled();
      expect(strike).not.toHaveBeenCalled();
      expect(hit).not.toHaveBeenCalled();
      if (arena === undefined) expect(inner.crowdMod.running).toBe(true);
      else expect(inner.jungleMod.running).toBe(true);
      e.stopCrowd();
      e.dispose();
    }
  });
});
