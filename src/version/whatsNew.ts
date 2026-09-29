/**
 * "What's New" show-once logic (WP-L). After an update the Version History
 * panel opens automatically exactly once, tracked by
 * `localStorage['gk-last-seen-version']`.
 *
 * Rules ({@link shouldShowWhatsNew}):
 *  - stored version older than the running one → show (an update happened);
 *  - nothing stored but the player has other `gk-*` keys → show (they played a
 *    build from before this tracking existed);
 *  - nothing stored and no other keys → fresh install, don't show;
 *  - same or newer stored version (downgrade) → don't show.
 * Whatever the outcome, the running version is recorded as seen.
 */

import { isNewerVersion, isSemver } from './semver';

export const LAST_SEEN_VERSION_KEY = 'gk-last-seen-version';

/** Pure decision function (unit-tested). */
export function shouldShowWhatsNew(lastSeen: string | null, current: string, returningPlayer: boolean): boolean {
  if (lastSeen === null || lastSeen.trim().length === 0) return returningPlayer;
  if (!isSemver(lastSeen)) return true; // corrupt value: treat as "older"
  return isNewerVersion(current, lastSeen);
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage blocked — the panel may simply show again next launch */
  }
}

/**
 * Decide whether to auto-open the panel for `current`, and record `current`
 * as seen. `returningKeys` are other persisted keys whose presence marks a
 * player who predates this tracking (e.g. `gk-settings`, `gk-animal`).
 */
export function consumeWhatsNew(current: string, returningKeys: readonly string[]): boolean {
  const lastSeen = read(LAST_SEEN_VERSION_KEY);
  const returning = returningKeys.some((k) => read(k) !== null);
  const show = shouldShowWhatsNew(lastSeen, current, returning);
  if (lastSeen !== current) write(LAST_SEEN_VERSION_KEY, current);
  return show;
}
