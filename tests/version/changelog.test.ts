import { describe, expect, it } from 'vitest';
import changelogMarkdown from '../../CHANGELOG.md?raw';
import {
  DEFAULT_SECTION_TITLE,
  entryItemCount,
  findEntry,
  formatEntryMarkdown,
  inlineSegments,
  parseChangelog,
  releaseNotesFor,
  sortNewestFirst,
} from '../../src/version/changelog';

const SAMPLE = `# Changelog

Intro prose that is not part of any version.

## [Unreleased]

### Added
- Nameplates over enemies

## [1.1.0] - 2026-10-01

### Added
- Graphics quality setting
- **Bold** thing with \`code\`

### Changed
- Giraffe reach reduced
  from 4.0 m to 3.4 m

### Fixed
* Ability icons no longer blank
+ Plus-style bullet

## [1.0.0] - 2026-07-14

### Added
- Initial release

[Unreleased]: https://example.com/compare/v1.1.0...HEAD
[1.1.0]: https://example.com/releases/tag/v1.1.0
[1.0.0]: https://example.com/releases/tag/v1.0.0
`;

describe('parseChangelog — headings', () => {
  const entries = parseChangelog(SAMPLE);

  it('finds every version heading in document order', () => {
    expect(entries.map((e) => e.version)).toEqual(['Unreleased', '1.1.0', '1.0.0']);
  });

  it('parses dates and leaves Unreleased undated', () => {
    expect(entries[0]?.date).toBeNull();
    expect(entries[1]?.date).toBe('2026-10-01');
    expect(entries[2]?.date).toBe('2026-07-14');
  });

  it('accepts unbracketed, v-prefixed, en-dash and dateless headings', () => {
    const e = parseChangelog('## 2.0.0 – 2027-01-02\n- a\n\n## [v1.9.0]\n- b\n\n## 1.8.0-beta.2 - 2026-12-01\n- c\n');
    expect(e.map((x) => [x.version, x.date])).toEqual([
      ['2.0.0', '2027-01-02'],
      ['1.9.0', null],
      ['1.8.0-beta.2', '2026-12-01'],
    ]);
  });

  it('ignores the title, preamble prose and link-reference definitions', () => {
    const all = entries.flatMap((e) => e.sections.flatMap((s) => s.items));
    expect(all.some((t) => t.includes('Intro prose'))).toBe(false);
    expect(all.some((t) => t.includes('example.com'))).toBe(false);
  });
});

describe('parseChangelog — sections and bullets', () => {
  const entries = parseChangelog(SAMPLE);
  const v110 = findEntry(entries, '1.1.0');

  it('groups bullets under Added / Changed / Fixed in order', () => {
    expect(v110?.sections.map((s) => s.title)).toEqual(['Added', 'Changed', 'Fixed']);
    expect(v110?.sections[0]?.items).toEqual(['Graphics quality setting', '**Bold** thing with `code`']);
  });

  it('joins indented continuation lines onto the previous bullet', () => {
    expect(v110?.sections[1]?.items).toEqual(['Giraffe reach reduced from 4.0 m to 3.4 m']);
  });

  it('accepts -, * and + bullet markers', () => {
    expect(v110?.sections[2]?.items).toEqual(['Ability icons no longer blank', 'Plus-style bullet']);
  });

  it('counts items', () => {
    expect(v110 === undefined ? -1 : entryItemCount(v110)).toBe(5);
  });

  it('puts bullets before any ### heading into a default section', () => {
    const [e] = parseChangelog('## [1.0.0] - 2026-01-01\n- loose bullet\n### Fixed\n- fix\n');
    expect(e?.sections.map((s) => [s.title, s.items])).toEqual([
      [DEFAULT_SECTION_TITLE, ['loose bullet']],
      ['Fixed', ['fix']],
    ]);
  });

  it('merges repeated section titles within one version', () => {
    const [e] = parseChangelog('## [1.0.0]\n### Added\n- a\n### Fixed\n- f\n### added\n- b\n');
    expect(e?.sections.map((s) => [s.title, s.items])).toEqual([
      ['Added', ['a', 'b']],
      ['Fixed', ['f']],
    ]);
  });

  it('handles CRLF line endings', () => {
    const [e] = parseChangelog('## [1.0.0] - 2026-01-01\r\n### Added\r\n- crlf item\r\n');
    expect(e?.sections[0]?.items).toEqual(['crlf item']);
  });
});

describe('parseChangelog — Unreleased handling', () => {
  it('returns an empty Unreleased block with no sections', () => {
    const [u] = parseChangelog('## [Unreleased]\n\n## [1.0.0] - 2026-07-14\n### Added\n- x\n');
    expect(u).toEqual({ version: 'Unreleased', date: null, unreleased: true, sections: [] });
  });

  it('ignores HTML comment hints (even ones containing bullets)', () => {
    const [u] = parseChangelog('## [Unreleased]\n<!--\n- not a real bullet\n### Added\n-->\n');
    expect(u?.sections).toEqual([]);
  });

  it('matches the Unreleased heading case-insensitively', () => {
    const [u] = parseChangelog('## unreleased\n### Added\n- soon\n');
    expect(u?.unreleased).toBe(true);
    expect(findEntry([u!], 'unreleased')?.sections[0]?.items).toEqual(['soon']);
  });

  it('sorts Unreleased first, then releases by descending semver', () => {
    const e = parseChangelog('## [1.0.0]\n- a\n## [1.10.0]\n- b\n## [Unreleased]\n## [1.2.0]\n- c\n');
    expect(sortNewestFirst(e).map((x) => x.version)).toEqual(['Unreleased', '1.10.0', '1.2.0', '1.0.0']);
  });
});

describe('parseChangelog — malformed input', () => {
  it('returns [] for empty or version-less text', () => {
    expect(parseChangelog('')).toEqual([]);
    expect(parseChangelog('# Changelog\n\njust prose\n- stray bullet\n')).toEqual([]);
  });

  it('skips headings that are not versions, and their bullets', () => {
    const e = parseChangelog('## [1.0.0]\n- keep\n## Notes for devs\n- drop me\n## [0.9.0]\n- older\n');
    expect(e.map((x) => x.version)).toEqual(['1.0.0', '0.9.0']);
    expect(e.flatMap((x) => x.sections.flatMap((s) => s.items))).toEqual(['keep', 'older']);
  });

  it('rejects non-semver versions like 1.0 or v1', () => {
    expect(parseChangelog('## [1.0]\n- a\n## v1\n- b\n')).toEqual([]);
  });

  it('keeps only the first of duplicate versions', () => {
    const e = parseChangelog('## [1.0.0] - 2026-01-01\n- first\n## [1.0.0] - 2025-01-01\n- second\n');
    expect(e).toHaveLength(1);
    expect(e[0]?.sections[0]?.items).toEqual(['first']);
  });

  it('drops empty bullets and empty sections, and ignores fenced code', () => {
    const [e] = parseChangelog('## [1.0.0]\n### Added\n-   \n### Fixed\n- real\n```\n- fenced\n## [9.9.9]\n```\n');
    expect(e?.sections.map((s) => [s.title, s.items])).toEqual([['Fixed', ['real']]]);
  });

  it('tolerates a missing or garbled date', () => {
    const [e] = parseChangelog('## [1.0.0] - someday\n- a\n');
    expect(e?.version).toBe('1.0.0');
    expect(e?.date).toBeNull();
  });
});

describe('release notes + inline formatting', () => {
  it('formats one entry back to markdown for the GitHub Release body', () => {
    expect(releaseNotesFor(SAMPLE, 'v1.0.0')).toBe('### Added\n- Initial release');
    const e = findEntry(parseChangelog(SAMPLE), '1.1.0');
    expect(e === undefined ? '' : formatEntryMarkdown(e)).toContain('### Changed\n- Giraffe reach reduced from 4.0 m to 3.4 m');
  });

  it('returns null for unknown or empty versions', () => {
    expect(releaseNotesFor(SAMPLE, '3.0.0')).toBeNull();
    expect(releaseNotesFor('## [Unreleased]\n', 'Unreleased')).toBeNull();
  });

  it('splits **strong**, `code` and link labels without producing markup', () => {
    expect(inlineSegments('Use **Shift** or `Q` — see [docs](https://x.y)')).toEqual([
      { kind: 'text', text: 'Use ' },
      { kind: 'strong', text: 'Shift' },
      { kind: 'text', text: ' or ' },
      { kind: 'code', text: 'Q' },
      { kind: 'text', text: ' — see docs' },
    ]);
    expect(inlineSegments('<b>raw</b>')).toEqual([{ kind: 'text', text: '<b>raw</b>' }]);
  });
});

describe('the real CHANGELOG.md', () => {
  const entries = parseChangelog(changelogMarkdown);

  it('starts with an Unreleased block', () => {
    expect(entries[0]?.unreleased).toBe(true);
  });

  it('has a dated, non-empty entry for the running version (package.json)', () => {
    const current = findEntry(entries, __APP_VERSION__);
    expect(current, `CHANGELOG.md needs a "## [${__APP_VERSION__}] - YYYY-MM-DD" entry`).toBeDefined();
    expect(current?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(current === undefined ? 0 : entryItemCount(current)).toBeGreaterThan(0);
  });

  it('lists released versions newest-first with valid dates', () => {
    const released = entries.filter((e) => !e.unreleased);
    expect(sortNewestFirst(released).map((e) => e.version)).toEqual(released.map((e) => e.version));
    for (const e of released) expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
