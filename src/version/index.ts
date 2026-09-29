/**
 * Version + version-history entry point (WP-L).
 *
 *  - {@link APP_VERSION}: package.json `version`, injected at build time as
 *    `__APP_VERSION__` by vite.config.ts (single source of truth).
 *  - {@link getChangelog}: CHANGELOG.md, bundled as a raw string and parsed
 *    into typed entries, newest first.
 */

import changelogMarkdown from '../../CHANGELOG.md?raw';
import { type ChangelogEntry, parseChangelog, sortNewestFirst } from './changelog';

/** The running app version, e.g. `1.0.0`. */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

/** Footer / badge label, e.g. `v1.0.0`. */
export const APP_VERSION_LABEL = `v${APP_VERSION}`;

let cached: readonly ChangelogEntry[] | null = null;

/** Every changelog entry, Unreleased first then newest release first. Parsed once. */
export function getChangelog(): readonly ChangelogEntry[] {
  if (cached === null) cached = sortNewestFirst(parseChangelog(changelogMarkdown));
  return cached;
}

export {
  type ChangelogEntry,
  type ChangelogSection,
  type InlineSegment,
  parseChangelog,
  sortNewestFirst,
  findEntry,
  entryItemCount,
  formatEntryMarkdown,
  releaseNotesFor,
  inlineSegments,
} from './changelog';
export { parseSemver, compareSemver, isNewerVersion, isSemver, type SemVer } from './semver';
export { LAST_SEEN_VERSION_KEY, shouldShowWhatsNew, consumeWhatsNew } from './whatsNew';
export { requestUpdateCheck, acceptUpdateInfo, UPDATE_CHECK_DELAY_MS } from './updates';
