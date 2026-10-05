/**
 * Online UI (WP-N4) — the screen flow for online play, kept out of main.ts:
 *
 *   Lobby -> OnlineScreen (host / join) -> RoomScreen -> networked match -> back to the RoomScreen
 *
 * The flow owns the room's `start` / `ended` subscriptions (the RoomScreen is unmounted while a match runs). It shares the
 * app's ScreenManager, canvas and single AudioEngine with the other flows.
 */

import type { ScreenManager, Screen } from '../../core/ScreenManager';
import type { AudioEngine } from '../../audio/AudioEngine';
import type { OnlineMatchResult } from '../matchTypes';
import type { GameChannel, OnlineStart } from '../types';
import type { RoomEndReason } from '../room/types';
import { describeMatchResult } from './errors';
import { joinCodeFromSearch, searchWithoutJoin } from './helpers';
import { createMatchScreenNow, launchOnlineMatch, prefetchMatchFactory } from './launch';
import { OnlineScreen, type OnlineScreenOptions } from './OnlineScreen';
import { RoomScreen } from './RoomScreen';
import type { OnlineNotice, RoomFactoryApi, RoomLike } from './types';

export interface OnlineFlowOptions {
  screens: ScreenManager;
  canvas: HTMLCanvasElement;
  audio: AudioEngine;
  /** Leave the online screens for the main lobby. */
  onExit: () => void;
  /** A room code from a `?join=CODE` link: opens the Join tab prefilled and joins once a name is saved. */
  joinCode?: string | null;
  /** Called whenever a menu-like online screen appears (the app starts its lobby music here). */
  onMenu?: () => void;
  /** Test seam for the Online screen. */
  api?: RoomFactoryApi;
}

export interface OnlineFlow {
  /** Close the flow's room subscriptions (the caller transitions to another screen itself). */
  dispose(): void;
}

/** The `?join=CODE` code of the current page URL (null when absent or invalid). */
export function currentJoinCode(): string | null {
  try {
    return joinCodeFromSearch(window.location.search);
  } catch {
    return null;
  }
}

/** Remove `join` from the address bar after the deep link was used (a reload must not join again). Other parameters stay. */
function consumeJoinParam(): void {
  try {
    const { pathname, search, hash } = window.location;
    const clean = searchWithoutJoin(search);
    if (clean !== search) window.history.replaceState(window.history.state, '', `${pathname}${clean}${hash}`);
  } catch {
    /* history API unavailable (file:// in some shells) */
  }
}

export function startOnlineFlow(opts: OnlineFlowOptions): OnlineFlow {
  const { screens, canvas, audio } = opts;
  let room: RoomLike | null = null;
  let unsubs: Array<() => void> = [];
  let ended: { reason: RoomEndReason; message: string } | null = null;
  let matchToken = 0;
  let disposed = false;

  const menu = (): void => opts.onMenu?.();

  const dropRoom = (): void => {
    for (const u of unsubs) u();
    unsubs = [];
    room = null;
    ended = null;
    matchToken++; // any match still starting is orphaned
  };

  const showOnline = (extra: Partial<OnlineScreenOptions> = {}): void => {
    menu();
    screens.transition(
      new OnlineScreen({
        api: opts.api,
        onRoom: (r) => enterRoom(r),
        onBack: () => {
          dropRoom();
          opts.onExit();
        },
        ...extra,
      }),
    );
  };

  const leaveRoom = (notice?: OnlineNotice): void => {
    dropRoom();
    showOnline(notice !== undefined ? { notice } : {});
  };

  const showRoom = (r: RoomLike, notice: string | null): void => {
    menu();
    screens.transition(new RoomScreen({ room: r, notice, ended, onLeave: () => leaveRoom() }));
  };

  const enterRoom = (r: RoomLike): void => {
    dropRoom();
    room = r;
    // Load the match module while the players are still choosing, so `start` can build the screen synchronously.
    const warm = (): void => {
      void prefetchMatchFactory(r.state.mode).catch(() => undefined);
    };
    warm();
    unsubs.push(
      r.on('state', warm),
      r.on('start', (start, channel) => beginMatch(r, start, channel)),
      r.on('ended', (reason, message) => {
        ended = { reason, message };
      }),
    );
    showRoom(r, null);
  };

  const matchDone = (r: RoomLike, token: number, result: OnlineMatchResult): void => {
    if (disposed || token !== matchToken || room !== r) return;
    r.backToRoom(); // idempotent; a closed room ignores it
    showRoom(r, describeMatchResult(result));
  };

  const beginMatch = (r: RoomLike, start: OnlineStart, channel: GameChannel): void => {
    const token = ++matchToken;
    const launchOpts = { canvas, audio, start, channel, onExit: (res: OnlineMatchResult) => matchDone(r, token, res) };
    audio.stopMusic();
    const mount = (screen: Screen): void => {
      if (disposed || token !== matchToken || room !== r) return;
      screens.transition(screen);
    };
    try {
      const now = createMatchScreenNow(launchOpts);
      if (now !== null) {
        mount(now);
        return;
      }
    } catch (err) {
      console.error('Online: could not create the match screen', err);
      matchDone(r, token, { reason: 'error', message: 'The match could not be started.' });
      return;
    }
    // Module not loaded yet (slow connection): load it now; packets that arrive meanwhile may be missed.
    launchOnlineMatch(launchOpts).then(
      (screen) => {
        if (ended !== null) showRoom(r, null);
        else mount(screen);
      },
      (err: unknown) => {
        console.error('Online: could not load the match screen', err);
        matchDone(r, token, { reason: 'error', message: 'The match could not be loaded.' });
      },
    );
  };

  const code = opts.joinCode ?? null;
  if (code !== null) consumeJoinParam();
  showOnline(code !== null ? { initialTab: 'join', initialCode: code, autoJoin: true } : {});

  return {
    dispose(): void {
      disposed = true;
      dropRoom();
    },
  };
}
