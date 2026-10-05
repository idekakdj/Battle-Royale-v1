/**
 * Online multiplayer — hand-off between the Online UI (WP-N4) and the two networked match screens (WP-N5 Champions
 * League, WP-N6 Battle Royale). Architect-owned contract.
 *
 * Fixed module paths (N4 imports them dynamically; N5/N6 own and implement them):
 *   Champions League:  `src/brawl/net/screen.ts`   exports `createNetBrawlScreen: OnlineMatchFactory`
 *   Battle Royale:     `src/online/br/screen.ts`    exports `createNetBattleRoyaleScreen: OnlineMatchFactory`
 * N4 creates a throw-away stub at each path ONLY if the file does not exist yet; the owning agent replaces it.
 */

import type { Screen } from '../core/ScreenManager';
import type { AudioEngine } from '../audio/AudioEngine';
import type { GameChannel, NetEndReason, OnlineStart } from './types';

export interface OnlineMatchResult {
  /** `finished` = the match ran to its normal end (results were shown). Anything else = it was cut short. */
  reason: 'finished' | NetEndReason;
  /** Human-readable explanation to show in the room ("Ann left the match", "Connection lost"…). */
  message?: string;
}

export interface OnlineMatchOptions {
  canvas: HTMLCanvasElement;
  audio: AudioEngine;
  start: OnlineStart;
  channel: GameChannel;
  /** Called exactly once when this machine is done with the match (after the results screen, or when it was cut short). The UI then returns to the room. */
  onExit: (result: OnlineMatchResult) => void;
}

/** A networked match as a normal `Screen` (mounted by the ScreenManager like the local match controllers). */
export type OnlineMatchFactory = (opts: OnlineMatchOptions) => Screen;
