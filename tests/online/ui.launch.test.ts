import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Screen } from '../../src/core/ScreenManager';
import type { OnlineMatchFactory, OnlineMatchOptions } from '../../src/online/matchTypes';
import type { GameChannel, OnlineMode, OnlineStart } from '../../src/online/types';
import {
  createMatchScreenNow,
  isMatchFactoryReady,
  launchOnlineMatch,
  once,
  prefetchMatchFactory,
  resetMatchFactoryCache,
  type LaunchOptions,
} from '../../src/online/ui/launch';

const channel = { localPeerId: 'me' } as unknown as GameChannel;

function startFor(mode: OnlineMode): OnlineStart {
  return {
    mode,
    seed: 1,
    slots: [
      { slot: 0, peerId: 'me', name: 'Ann', animal: 'lion', kind: 'human' },
      { slot: 1, peerId: 'p2', name: 'Bob', animal: 'eagle', kind: 'human' },
    ],
    localSlot: 0,
    hostPeerId: 'me',
  };
}

function launchOpts(mode: OnlineMode, extra: Partial<LaunchOptions> = {}): LaunchOptions {
  return {
    canvas: {} as HTMLCanvasElement,
    audio: {} as LaunchOptions['audio'],
    start: startFor(mode),
    channel,
    onExit: () => undefined,
    ...extra,
  };
}

/** A factory that records the options it was called with and returns a trivial screen. */
function fakeFactory(seen: OnlineMatchOptions[]): OnlineMatchFactory {
  return (o) => {
    seen.push(o);
    const screen: Screen = { mount: () => undefined, unmount: () => undefined };
    return screen;
  };
}

beforeEach(() => resetMatchFactoryCache());

describe('once', () => {
  it('only lets the first call through', () => {
    const fn = vi.fn();
    const w = once(fn);
    w(1);
    w(2);
    w(3);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(1);
  });
});

describe('match factory loading', () => {
  it('prefetch loads each mode once, memoised, and marks it ready', async () => {
    const loader = vi.fn(async (_m: OnlineMode) => fakeFactory([]));
    expect(isMatchFactoryReady('championsLeague')).toBe(false);
    const a = prefetchMatchFactory('championsLeague', loader);
    const b = prefetchMatchFactory('championsLeague', loader);
    await Promise.all([a, b]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(isMatchFactoryReady('championsLeague')).toBe(true);
    expect(isMatchFactoryReady('battleRoyale')).toBe(false);
    await prefetchMatchFactory('championsLeague', loader);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('a failed load is not cached, so the next attempt retries', async () => {
    const loader = vi.fn<(m: OnlineMode) => Promise<OnlineMatchFactory>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(fakeFactory([]));
    await expect(prefetchMatchFactory('battleRoyale', loader)).rejects.toThrow('offline');
    expect(isMatchFactoryReady('battleRoyale')).toBe(false);
    await expect(prefetchMatchFactory('battleRoyale', loader)).resolves.toBeTypeOf('function');
    expect(isMatchFactoryReady('battleRoyale')).toBe(true);
  });

  it('the module paths named in the contract exist and export the agreed factory names', () => {
    // Static check on purpose: importing the real screens would pull in the whole renderer / three.js.
    const read = (p: string): string => readFileSync(resolve(__dirname, '../..', p), 'utf8');
    expect(read('src/brawl/net/screen.ts')).toMatch(/export const createNetBrawlScreen[:\s]/);
    expect(read('src/online/br/screen.ts')).toMatch(/export const createNetBattleRoyaleScreen[:\s]/);
    const launch = read('src/online/ui/launch.ts');
    expect(launch).toContain("import('../../brawl/net/screen')");
    expect(launch).toContain("import('../br/screen')");
  });
});

describe('creating the match screen', () => {
  it('createMatchScreenNow is null until the factory is loaded, then synchronous', async () => {
    const seen: OnlineMatchOptions[] = [];
    expect(createMatchScreenNow(launchOpts('battleRoyale'))).toBeNull();
    await prefetchMatchFactory('battleRoyale', async () => fakeFactory(seen));
    const screen = createMatchScreenNow(launchOpts('battleRoyale'));
    expect(screen).not.toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0].start.mode).toBe('battleRoyale');
    expect(seen[0].channel).toBe(channel);
  });

  it('picks the factory by start.mode and hands over the whole option set', async () => {
    const seenCl: OnlineMatchOptions[] = [];
    const seenBr: OnlineMatchOptions[] = [];
    const loader = async (m: OnlineMode): Promise<OnlineMatchFactory> => fakeFactory(m === 'championsLeague' ? seenCl : seenBr);
    await launchOnlineMatch(launchOpts('championsLeague', { factoryLoader: loader }));
    await launchOnlineMatch(launchOpts('battleRoyale', { factoryLoader: loader }));
    expect(seenCl).toHaveLength(1);
    expect(seenBr).toHaveLength(1);
    expect(seenCl[0].start.mode).toBe('championsLeague');
    expect(seenBr[0].start.mode).toBe('battleRoyale');
    for (const o of [...seenCl, ...seenBr]) {
      expect(o.canvas).toBeDefined();
      expect(o.audio).toBeDefined();
      expect(o.channel).toBe(channel);
      expect(typeof o.onExit).toBe('function');
    }
  });

  it('onExit reaches the UI exactly once however often the match screen calls it', async () => {
    const seen: OnlineMatchOptions[] = [];
    const exit = vi.fn();
    await launchOnlineMatch(launchOpts('championsLeague', { onExit: exit, factoryLoader: async () => fakeFactory(seen) }));
    seen[0].onExit({ reason: 'finished' });
    seen[0].onExit({ reason: 'host-left', message: 'late' });
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith({ reason: 'finished' });
  });

  it('propagates a load failure to the caller', async () => {
    await expect(
      launchOnlineMatch(launchOpts('championsLeague', { factoryLoader: async () => Promise.reject(new Error('chunk failed')) })),
    ).rejects.toThrow('chunk failed');
  });
});
