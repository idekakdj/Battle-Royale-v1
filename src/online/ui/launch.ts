/**
 * Online UI (WP-N4) — starts a networked match. Picks the match-screen factory by `start.mode` and imports it
 * lazily, so neither mode's netcode nor its controller is part of the offline game's bundle.
 *
 *   championsLeague  ->  src/brawl/net/screen.ts   `createNetBrawlScreen`           (WP-N5)
 *   battleRoyale     ->  src/online/br/screen.ts   `createNetBattleRoyaleScreen`    (WP-N6)
 *
 * The room layer replays game packets that arrived before `start` to whoever subscribed to the `GameChannel` during the
 * `start` handler. So the flow PREFETCHES the factory while the players are still in the room; at `start` the screen can then be
 * built and mounted synchronously ({@link createMatchScreenNow}) and no early packet is lost.
 */

import type { Screen } from '../../core/ScreenManager';
import type { AudioEngine } from '../../audio/AudioEngine';
import type { OnlineMatchFactory, OnlineMatchOptions, OnlineMatchResult } from '../matchTypes';
import type { GameChannel, OnlineMode, OnlineStart } from '../types';

/** Dynamically import the match factory of a mode. Rejects when the module cannot be loaded. */
export async function loadMatchFactory(mode: OnlineMode): Promise<OnlineMatchFactory> {
  if (mode === 'championsLeague') {
    const m = await import('../../brawl/net/screen');
    return m.createNetBrawlScreen;
  }
  const m = await import('../br/screen');
  return m.createNetBattleRoyaleScreen;
}

const loaded = new Map<OnlineMode, OnlineMatchFactory>();
const loading = new Map<OnlineMode, Promise<OnlineMatchFactory>>();

/** Start loading a mode's match module (memoised). Resolves with the factory; rejection is not cached. */
export function prefetchMatchFactory(mode: OnlineMode, loader: (m: OnlineMode) => Promise<OnlineMatchFactory> = loadMatchFactory): Promise<OnlineMatchFactory> {
  const have = loaded.get(mode);
  if (have !== undefined) return Promise.resolve(have);
  let p = loading.get(mode);
  if (p === undefined) {
    p = loader(mode).then(
      (f) => {
        loaded.set(mode, f);
        loading.delete(mode);
        return f;
      },
      (err: unknown) => {
        loading.delete(mode);
        throw err;
      },
    );
    loading.set(mode, p);
  }
  return p;
}

/** True once the mode's module has been loaded (so a screen can be created synchronously). */
export function isMatchFactoryReady(mode: OnlineMode): boolean {
  return loaded.has(mode);
}

/** Forget cached factories (tests). */
export function resetMatchFactoryCache(): void {
  loaded.clear();
  loading.clear();
}

export interface LaunchOptions {
  canvas: HTMLCanvasElement;
  audio: AudioEngine;
  start: OnlineStart;
  channel: GameChannel;
  /** Called exactly once, however many times the match screen reports its end. */
  onExit: (result: OnlineMatchResult) => void;
  /** Test seam: replaces the dynamic import. */
  factoryLoader?: (mode: OnlineMode) => Promise<OnlineMatchFactory>;
}

/** Wrap `fn` so it can only fire once (a match screen may exit and then be unmounted by the flow). */
export function once<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  let called = false;
  return (...args: A): void => {
    if (called) return;
    called = true;
    fn(...args);
  };
}

function matchOptions(opts: LaunchOptions): OnlineMatchOptions {
  return { canvas: opts.canvas, audio: opts.audio, start: opts.start, channel: opts.channel, onExit: once(opts.onExit) };
}

/** Synchronous path: build the match screen when its factory is already loaded; null otherwise. */
export function createMatchScreenNow(opts: LaunchOptions): Screen | null {
  const factory = loaded.get(opts.start.mode);
  return factory === undefined ? null : factory(matchOptions(opts));
}

/** Build the networked match screen for `start` (not yet mounted), loading its module first when needed. */
export async function launchOnlineMatch(opts: LaunchOptions): Promise<Screen> {
  const factory = await prefetchMatchFactory(opts.start.mode, opts.factoryLoader);
  return factory(matchOptions(opts));
}
