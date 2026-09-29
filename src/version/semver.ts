/**
 * Minimal semantic-version helpers (WP-L). Only what the game needs: parse
 * `MAJOR.MINOR.PATCH[-prerelease][+build]` (an optional leading `v` is allowed,
 * as in git tags), and order two versions per semver §11 precedence.
 *
 * Headless and dependency-free so both the renderer and the tests can use it.
 * (The Electron main process keeps a tiny CommonJS twin in electron/main.cjs.)
 */

export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Dot-separated prerelease identifiers (`1.2.0-beta.1` → `['beta', '1']`). */
  readonly prerelease: readonly string[];
}

const SEMVER_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Parse a version string; returns `null` for anything that is not semver. */
export function parseSemver(input: string): SemVer | null {
  const m = SEMVER_RE.exec(input.trim());
  if (m === null) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] === undefined ? [] : m[4].split('.'),
  };
}

/** True when `input` is a valid semver string (leading `v` allowed). */
export function isSemver(input: string): boolean {
  return parseSemver(input) !== null;
}

function compareIdentifiers(a: string, b: string): number {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Math.sign(Number(a) - Number(b));
  if (an) return -1; // numeric identifiers sort before alphanumeric ones
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compare two versions: negative if `a < b`, 0 if equal precedence, positive
 * if `a > b`. Unparseable input sorts below every valid version (and equal to
 * other unparseable input) so callers never throw on junk.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa === null || pb === null) {
    if (pa === null && pb === null) return 0;
    return pa === null ? -1 : 1;
  }
  if (pa.major !== pb.major) return Math.sign(pa.major - pb.major);
  if (pa.minor !== pb.minor) return Math.sign(pa.minor - pb.minor);
  if (pa.patch !== pb.patch) return Math.sign(pa.patch - pb.patch);
  // A version without prerelease outranks the same version with one.
  const ra = pa.prerelease;
  const rb = pb.prerelease;
  if (ra.length === 0 || rb.length === 0) return ra.length === rb.length ? 0 : ra.length === 0 ? 1 : -1;
  const n = Math.min(ra.length, rb.length);
  for (let i = 0; i < n; i++) {
    const c = compareIdentifiers(ra[i] as string, rb[i] as string);
    if (c !== 0) return c;
  }
  return Math.sign(ra.length - rb.length);
}

/** True when `candidate` is strictly newer than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return parseSemver(candidate) !== null && compareSemver(candidate, current) > 0;
}
