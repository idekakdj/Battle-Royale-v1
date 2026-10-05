import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Champions League online determinism rule (plan §4): the simulation may only use + - * /, comparisons, and the exactly-specified
 * Math.sqrt/abs/min/max/floor/ceil/round/trunc/sign/imul/fround. This scan fails the build the moment a banned call (or a
 * nondeterministic source such as Math.random / Date / performance.now) appears in src/brawl/sim/** or in the data helpers the
 * sim reads at runtime.
 */

const ROOT = join(__dirname, '..', '..', 'src', 'brawl');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Strip comments and string literals (so documentation may mention the banned names). */
function code(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && d === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      out += '""';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const BANNED: Array<[string, RegExp]> = [
  ['Math.sin/cos/tan family', /\bMath\s*\.\s*(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh)\b/],
  ['Math.pow/exp/log family', /\bMath\s*\.\s*(pow|exp|expm1|log|log2|log10|log1p)\b/],
  ['Math.hypot/cbrt', /\bMath\s*\.\s*(hypot|cbrt)\b/],
  ['Math.random', /\bMath\s*\.\s*random\b/],
  ['** operator', /\*\*/],
  ['Date', /\bDate\b/],
  ['performance', /\bperformance\b/],
  ['crypto.getRandomValues', /\bgetRandomValues\b/],
  ['setTimeout/Interval', /\bset(Timeout|Interval)\b/],
];

const SIM_FILES = walk(join(ROOT, 'sim'));
const DATA_FILES = [
  join(ROOT, 'data', 'index.ts'),
  join(ROOT, 'data', 'helpers.ts'),
  ...walk(join(ROOT, 'data', 'animals')),
  // data/stages.ts holds movingOffset() (Math.sin) for the view and the bots; the sim never imports it (checked below).
];

describe('determinism scan: banned tokens', () => {
  it('finds the files it is supposed to scan', () => {
    expect(SIM_FILES.map((f) => relative(ROOT, f).replace(/\\/g, '/'))).toEqual(
      expect.arrayContaining(['sim/BrawlWorld.ts', 'sim/combat.ts', 'sim/geometry.ts', 'sim/dmath.ts', 'sim/rng.ts', 'sim/stateIO.ts', 'sim/Fighter.ts']),
    );
    expect(DATA_FILES.length).toBeGreaterThanOrEqual(12);
  });

  for (const file of [...SIM_FILES, ...DATA_FILES]) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    it(`${rel} has no banned math / nondeterminism`, () => {
      const src = code(readFileSync(file, 'utf8'));
      for (const [label, re] of BANNED) {
        const m = re.exec(src);
        expect(m, `${rel}: ${label} -> ${m?.[0]}`).toBeNull();
      }
    });
  }

  it('the sim never imports the view-side stage helpers that use Math.sin, nor core/math', () => {
    for (const file of SIM_FILES) {
      const raw = readFileSync(file, 'utf8');
      const src = code(raw);
      expect(/\bmovingOffset\b|\bplatformAt\b/.test(src), relative(ROOT, file)).toBe(false);
      expect(/core\/math/.test(raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), `${relative(ROOT, file)} imports core/math`).toBe(false);
    }
  });

  it('self-check: the scanner flags what it should', () => {
    expect(BANNED.some(([, re]) => re.test(code('const a = Math.sin(1);')))).toBe(true);
    expect(BANNED.some(([, re]) => re.test(code('x = a ** 2')))).toBe(true);
    expect(BANNED.some(([, re]) => re.test(code('const t = Date.now();')))).toBe(true);
    expect(BANNED.some(([, re]) => re.test(code('// Math.sin in a comment\n/* Math.cos */ const s = "Math.pow";')))).toBe(false);
    expect(BANNED.some(([, re]) => re.test(code('Math.sqrt(Math.abs(x)) + Math.min(1, 2) + Math.imul(3, 4)')))).toBe(false);
  });
});
