/**
 * CHANGELOG.md parser (WP-L). The changelog is the single source of truth for
 * version history: the in-game Version History panel renders these entries,
 * and CI (`npm run release:notes`) cuts the GitHub Release body from them.
 *
 * Accepted format (Keep a Changelog, https://keepachangelog.com):
 *
 *   ## [Unreleased]
 *   ## [1.1.0] - 2026-10-01        (also `## 1.1.0 - 2026-10-01`, `## [v1.1.0]`)
 *   ### Added | Changed | Fixed | … (any title)
 *   - bullet (`-`, `*` or `+`; indented lines continue the previous bullet)
 *
 * Tolerant by design: text before the first version heading, HTML comments,
 * link-reference definitions (`[1.0.0]: https://…`), headings that are not a
 * version, duplicate versions and stray lines are skipped rather than thrown.
 * Pure + headless (no DOM) so it runs in vitest and in the Node release script.
 */

import { compareSemver, parseSemver } from './semver';

export interface ChangelogSection {
  /** Section title as written (`Added`, `Changed`, `Fixed`, …). */
  readonly title: string;
  /** Bullet texts, inline markdown preserved, continuation lines joined. */
  readonly items: readonly string[];
}

export interface ChangelogEntry {
  /** Normalized version (`1.0.0`, no leading `v`) or `Unreleased`. */
  readonly version: string;
  /** Release date `YYYY-MM-DD`, or `null` when absent (always null for Unreleased). */
  readonly date: string | null;
  /** True for the `## [Unreleased]` block. */
  readonly unreleased: boolean;
  /** Non-empty sections in document order. */
  readonly sections: readonly ChangelogSection[];
}

/** Title used for bullets that appear before any `###` section heading. */
export const DEFAULT_SECTION_TITLE = 'Changes';

const VERSION_HEADING_RE = /^##\s+(.+?)\s*#*\s*$/;
const SECTION_HEADING_RE = /^###\s+(.+?)\s*#*\s*$/;
const BULLET_RE = /^(\s*)[-*+]\s+(.*)$/;
const LINK_REF_RE = /^\s{0,3}\[[^\]]+\]:\s*\S+/;
const DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/;

interface MutableSection {
  title: string;
  items: string[];
}

interface MutableEntry {
  version: string;
  date: string | null;
  unreleased: boolean;
  sections: MutableSection[];
}

/** Parse a `## …` heading body into version + date, or `null` if it is not a version heading. */
function parseVersionHeading(body: string): { version: string; date: string | null; unreleased: boolean } | null {
  // Split off the date part: `[1.0.0] - 2026-07-14`, `1.0.0 – 2026-07-14`, `[1.0.0]`.
  const m = /^\[?\s*([^\]\s]+)\s*\]?(?:\s*(?:[-–—:]\s*)?(.*))?$/.exec(body);
  if (m === null) return null;
  const rawVersion = (m[1] ?? '').trim();
  const rest = (m[2] ?? '').trim();
  if (rawVersion.toLowerCase() === 'unreleased') {
    return { version: 'Unreleased', date: null, unreleased: true };
  }
  if (parseSemver(rawVersion) === null) return null;
  const dm = DATE_RE.exec(rest);
  return {
    version: rawVersion.replace(/^v/, ''),
    date: dm === null ? null : (dm[1] as string),
    unreleased: false,
  };
}

/**
 * Parse changelog markdown into entries, in document order (Keep a Changelog
 * files are written newest-first; use {@link sortNewestFirst} if unsure).
 */
export function parseChangelog(markdown: string): ChangelogEntry[] {
  // Normalize newlines and drop HTML comments (used as authoring hints).
  const text = markdown.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  const lines = text.split('\n');

  const entries: MutableEntry[] = [];
  const seen = new Set<string>();
  let entry: MutableEntry | null = null;
  let section: MutableSection | null = null;
  /** True while the previous line was part of a bullet (lazy continuation allowed). */
  let inItem = false;
  let inFence = false;

  for (const line of lines) {
    // Fenced code blocks are never structure; skip them wholesale.
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      inItem = false;
      continue;
    }
    if (inFence) continue;

    if (line.trim().length === 0) {
      inItem = false;
      continue;
    }

    if (/^#\s/.test(line) || /^#{4,}\s/.test(line)) {
      // Document title or deeper headings: not structure we model.
      inItem = false;
      continue;
    }

    const vh = VERSION_HEADING_RE.exec(line);
    if (vh !== null) {
      inItem = false;
      section = null;
      const parsed = parseVersionHeading(vh[1] as string);
      const key = parsed?.version.toLowerCase() ?? '';
      if (parsed === null || seen.has(key)) {
        // Not a version (or a duplicate): ignore everything until the next valid heading.
        entry = null;
        continue;
      }
      seen.add(key);
      entry = { ...parsed, sections: [] };
      entries.push(entry);
      continue;
    }

    if (entry === null) continue; // preamble / skipped block

    const sh = SECTION_HEADING_RE.exec(line);
    if (sh !== null) {
      inItem = false;
      const title = (sh[1] as string).trim();
      section = entry.sections.find((s) => s.title.toLowerCase() === title.toLowerCase()) ?? null;
      if (section === null) {
        section = { title, items: [] };
        entry.sections.push(section);
      }
      continue;
    }

    if (LINK_REF_RE.test(line)) {
      inItem = false;
      continue;
    }

    const bm = BULLET_RE.exec(line);
    if (bm !== null) {
      const itemText = (bm[2] as string).trim();
      if (itemText.length === 0) {
        inItem = false;
        continue;
      }
      if (section === null) {
        section = entry.sections.find((s) => s.title === DEFAULT_SECTION_TITLE) ?? null;
        if (section === null) {
          section = { title: DEFAULT_SECTION_TITLE, items: [] };
          entry.sections.push(section);
        }
      }
      section.items.push(itemText);
      inItem = true;
      continue;
    }

    // Continuation of the previous bullet (indented or lazy); otherwise prose we skip.
    if (inItem && section !== null && section.items.length > 0) {
      const last = section.items.length - 1;
      section.items[last] = `${section.items[last] as string} ${line.trim()}`;
    }
  }

  return entries.map((e) => ({
    version: e.version,
    date: e.date,
    unreleased: e.unreleased,
    sections: e.sections
      .filter((s) => s.items.length > 0)
      .map((s) => ({ title: s.title, items: [...s.items] })),
  }));
}

/** Total bullet count of an entry. */
export function entryItemCount(entry: ChangelogEntry): number {
  let n = 0;
  for (const s of entry.sections) n += s.items.length;
  return n;
}

/** Find the entry for `version` (leading `v` ignored; `unreleased` matches the Unreleased block). */
export function findEntry(entries: readonly ChangelogEntry[], version: string): ChangelogEntry | undefined {
  const want = version.trim().replace(/^v/, '').toLowerCase();
  return entries.find((e) => e.version.toLowerCase() === want);
}

/**
 * Newest-first ordering: Unreleased on top, then released versions by
 * descending semver. Stable for equal keys. Returns a new array.
 */
export function sortNewestFirst(entries: readonly ChangelogEntry[]): ChangelogEntry[] {
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      if (a.e.unreleased !== b.e.unreleased) return a.e.unreleased ? -1 : 1;
      const c = compareSemver(b.e.version, a.e.version);
      return c !== 0 ? c : a.i - b.i;
    })
    .map((x) => x.e);
}

/**
 * Render one entry's body back to markdown (no version heading) — the GitHub
 * Release body produced by `npm run release:notes`.
 */
export function formatEntryMarkdown(entry: ChangelogEntry): string {
  return entry.sections
    .map((s) => [`### ${s.title}`, ...s.items.map((item) => `- ${item}`)].join('\n'))
    .join('\n\n');
}

/**
 * Release notes for `version` straight from changelog markdown, or `null` if
 * the version has no entry or the entry has no bullets.
 */
export function releaseNotesFor(markdown: string, version: string): string | null {
  const entry = findEntry(parseChangelog(markdown), version);
  if (entry === undefined || entryItemCount(entry) === 0) return null;
  return formatEntryMarkdown(entry);
}

/** One styled run of bullet text for renderers (no HTML ever produced here). */
export interface InlineSegment {
  readonly kind: 'text' | 'strong' | 'code';
  readonly text: string;
}

/**
 * Split bullet text into plain / **strong** / `code` runs; `[label](url)`
 * links collapse to their label. Renderers set `textContent` per segment, so
 * changelog text can never inject markup.
 */
export function inlineSegments(text: string): InlineSegment[] {
  const plain = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  const out: InlineSegment[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  for (let m = re.exec(plain); m !== null; m = re.exec(plain)) {
    if (m.index > last) out.push({ kind: 'text', text: plain.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: 'strong', text: m[1] });
    else out.push({ kind: 'code', text: m[2] as string });
    last = m.index + m[0].length;
  }
  if (last < plain.length) out.push({ kind: 'text', text: plain.slice(last) });
  return out;
}
