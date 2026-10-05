/**
 * v1.6 stage audio cues (WP-M3): the glue maps `platformHit` / `platformBreak` / `stageFinal` to the procedural stone cues, and the
 * cues are throttled per kind. No Web Audio needed: the sfx class is mocked for the mapping test and driven with a stub clock for the gaps.
 */

import { describe, expect, it, vi } from 'vitest';
import type { SynthCtx } from '../../src/audio/synth';
import type { BrawlEvent, BrawlSnapshot } from '../../src/brawl/types';

const calls: string[] = [];

vi.mock('../../src/brawl/audio/BrawlSfx', () => {
  class FakeSfx {
    stoneCrack(pan: number): void {
      calls.push(`crack:${pan.toFixed(2)}`);
    }
    stoneCrash(pan: number): void {
      calls.push(`crash:${pan.toFixed(2)}`);
    }
    stageFinal(): void {
      calls.push('final');
    }
    hit(): void {
      calls.push('hit');
    }
  }
  return { BrawlSfx: FakeSfx };
});
vi.mock('../../src/brawl/audio/BrawlMusic', () => ({ BrawlMusic: class {} }));

describe('BrawlAudio v1.6 events', () => {
  it('plays the stone cues for the platform events (panned by x) and the final-form rumble', async () => {
    const { BrawlAudio } = await import('../../src/brawl/audio/BrawlAudio');
    const sc = {} as SynthCtx;
    const engine = {
      synthContext: () => sc,
      spikeExcitement: vi.fn(),
      crowdCheer: vi.fn(),
      startCrowd: vi.fn(),
      stopCrowd: vi.fn(),
      setExcitement: vi.fn(),
      matchEndSfx: vi.fn(),
    };
    const a = new BrawlAudio(engine as never);
    a.start();
    const snap = { fighters: [], platforms: [], hitboxes: [], countdown: 0, time: 1, matchOver: false } as unknown as BrawlSnapshot;
    const events: BrawlEvent[] = [
      { type: 'platformHit', platformId: 'tileL', attackerId: 0, hpLeft: 5, maxHp: 6, pos: { x: -11, y: 0 } },
      { type: 'platformBreak', platformId: 'tileL', pos: { x: 11, y: -1 }, x0: 8, x1: 14, y: 0 },
      { type: 'stageFinal' },
    ];
    a.onEvents(events, snap);
    expect(calls).toEqual(['crack:-0.50', 'crash:0.50', 'final']);
    expect(engine.spikeExcitement).toHaveBeenCalledTimes(2);
    a.stop();
  });
});

describe('BrawlSfx throttling of the stone cues', () => {
  it('gaps: crack 0.09 s, crash 0.22 s, final 2 s', async () => {
    const real = await vi.importActual<typeof import('../../src/brawl/audio/BrawlSfx')>('../../src/brawl/audio/BrawlSfx');
    const clock = { currentTime: 10 };
    const sfx = new real.BrawlSfx({ ctx: clock } as unknown as SynthCtx);
    expect(sfx.allow('crack')).toBe(true);
    expect(sfx.allow('crack')).toBe(false);
    clock.currentTime += 0.1;
    expect(sfx.allow('crack')).toBe(true);
    expect(sfx.allow('crash')).toBe(true);
    clock.currentTime += 0.1;
    expect(sfx.allow('crash')).toBe(false);
    clock.currentTime += 0.2;
    expect(sfx.allow('crash')).toBe(true);
    expect(sfx.allow('final')).toBe(true);
    clock.currentTime += 1.5;
    expect(sfx.allow('final')).toBe(false);
    clock.currentTime += 0.6;
    expect(sfx.allow('final')).toBe(true);
  });
});
