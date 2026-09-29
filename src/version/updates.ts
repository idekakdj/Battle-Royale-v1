/**
 * Notify-only update check, renderer side (WP-L).
 *
 * The actual HTTP request (GitHub "latest release") happens in the Electron
 * main process — see electron/main.cjs — so the page itself never talks to the
 * network. This module only decides *whether* to ask, delays the ask a few
 * seconds after launch, caches the answer for the session (one request per
 * launch), and re-validates whatever comes back. Browser builds (no
 * `window.gkDesktop`) always resolve `null`. Nothing is ever downloaded or
 * installed automatically; the lobby merely shows a banner linking to the
 * release page.
 */

import { isNewerVersion } from './semver';

/** Delay between the first lobby mount and the update request. */
export const UPDATE_CHECK_DELAY_MS = 4000;

/** Only release pages on github.com are ever surfaced. */
const RELEASE_URL_PREFIX = 'https://github.com/';

let pending: Promise<GkUpdateInfo | null> | null = null;

/** Validate a main-process answer against the running version. */
export function acceptUpdateInfo(info: unknown, currentVersion: string): GkUpdateInfo | null {
  if (typeof info !== 'object' || info === null) return null;
  const { version, url } = info as { version?: unknown; url?: unknown };
  if (typeof version !== 'string' || typeof url !== 'string') return null;
  if (!url.startsWith(RELEASE_URL_PREFIX)) return null;
  const v = version.replace(/^v/, '');
  if (!isNewerVersion(v, currentVersion)) return null;
  return { version: v, url };
}

/**
 * Ask (once per session) whether a newer release exists. `enabled` is the
 * player's `checkUpdates` setting; when false nothing is requested and the
 * call is not cached, so re-enabling it takes effect on the next lobby visit.
 */
export function requestUpdateCheck(
  enabled: boolean,
  currentVersion: string,
  delayMs: number = UPDATE_CHECK_DELAY_MS,
): Promise<GkUpdateInfo | null> {
  if (pending !== null) return pending;
  const desktop = typeof window === 'undefined' ? undefined : window.gkDesktop;
  if (!enabled || desktop === undefined) return Promise.resolve(null);
  pending = new Promise<GkUpdateInfo | null>((resolve) => {
    window.setTimeout(() => {
      desktop
        .checkForUpdates()
        .then((info) => resolve(acceptUpdateInfo(info, currentVersion)))
        .catch(() => resolve(null));
    }, delayMs);
  });
  return pending;
}
