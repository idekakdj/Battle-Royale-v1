/**
 * `npm run release:notes [-- <version>]` (WP-L). Prints the CHANGELOG.md
 * section for the given version (default: package.json `version`) as markdown
 * on stdout — CI uses it as the GitHub Release body:
 *
 *   npm run --silent release:notes > release-notes.md
 *
 * Exits 1 (message on stderr) when the version has no entry or the entry is
 * empty, so a release can never ship without notes. Uses the same parser as
 * the in-game Version History panel (src/version/changelog.ts). Run via
 * vite-node, like scripts/balance-sweep.ts.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseNotesFor } from '../src/version/changelog';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
const requested = process.argv.slice(2).find((a) => !a.startsWith('-'));
const version = (requested ?? pkg.version).replace(/^v/, '');
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');

const notes = releaseNotesFor(changelog, version);
if (notes === null) {
  process.stderr.write(
    `release:notes: CHANGELOG.md has no non-empty "## [${version}] - YYYY-MM-DD" section.\n` +
      'Move the Unreleased bullets under a heading for this version first (docs/RELEASING.md).\n',
  );
  process.exit(1);
}
process.stdout.write(`${notes}\n`);
