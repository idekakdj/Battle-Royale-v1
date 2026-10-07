/**
 * v1.8 QA shortcut parser: `?br=1&arena=jungle&animal=croc&level=3[&seed=…][&qa=1]`.
 */

import { describe, expect, it } from 'vitest';
import { parseBrAnimal, parseBrArena, parseBrLevel, parseBrParams } from '../../src/match/brParams';

const base = { animal: 'lion', difficulty: 2 } as const;
const q = (s: string): URLSearchParams => new URLSearchParams(s);

describe('parseBrParams', () => {
  it('returns null unless br=1', () => {
    expect(parseBrParams(q(''), base)).toBeNull();
    expect(parseBrParams(q('arena=jungle'), base)).toBeNull();
    expect(parseBrParams(q('br=0'), base)).toBeNull();
    expect(parseBrParams(q('br=true'), base)).toBeNull();
    expect(parseBrParams(q('brawl=1'), base)).toBeNull(); // Champions League has its own shortcut
  });

  it('the documented link boots a jungle match with the crocodile at level 3', () => {
    expect(parseBrParams(q('br=1&arena=jungle&animal=croc&level=3&qa=1'), base)).toEqual({
      animal: 'crocodile',
      difficulty: 3,
      arena: 'jungle',
      qa: true,
    });
  });

  it('bare br=1 uses the stored animal + difficulty and the colosseum (a QA link never depends on gk-arena)', () => {
    expect(parseBrParams(q('br=1'), base)).toEqual({ animal: 'lion', difficulty: 2, arena: 'colosseum', qa: false });
    expect(parseBrParams(q('br=1'), { animal: 'hippo', difficulty: 4 })).toEqual({
      animal: 'hippo',
      difficulty: 4,
      arena: 'colosseum',
      qa: false,
    });
  });

  it('invalid values fall back safely', () => {
    const r = parseBrParams(q('br=1&arena=swamp&animal=dragon&level=9&seed=abc&qa=yes'), base);
    expect(r).toEqual({ animal: 'lion', difficulty: 2, arena: 'colosseum', qa: false });
    for (const lvl of ['0', '5', '2.5', '-1', 'x', '', ' ']) {
      expect(parseBrParams(q(`br=1&level=${encodeURIComponent(lvl)}`), base)?.difficulty).toBe(2);
    }
  });

  it('accepts every animal id, case-insensitively, and the short aliases', () => {
    expect(parseBrAnimal('GIRAFFE')).toBe('giraffe');
    expect(parseBrAnimal(' mole ')).toBe('mole');
    expect(parseBrAnimal('croc')).toBe('crocodile');
    expect(parseBrAnimal('snake')).toBe('python');
    expect(parseBrAnimal('nope')).toBeNull();
    expect(parseBrAnimal(null)).toBeNull();
  });

  it('arena is case-insensitive; level only 1..4', () => {
    expect(parseBrArena('JUNGLE')).toBe('jungle');
    expect(parseBrArena('Colosseum')).toBe('colosseum');
    expect(parseBrArena(null)).toBe('colosseum');
    expect(parseBrArena('forest')).toBe('colosseum');
    expect([1, 2, 3, 4].map((n) => parseBrLevel(String(n)))).toEqual([1, 2, 3, 4]);
    expect(parseBrLevel('4.0')).toBe(4);
    expect(parseBrLevel(null)).toBeNull();
  });

  it('seed: a non-negative 32-bit integer is passed through, anything else is dropped', () => {
    expect(parseBrParams(q('br=1&seed=123'), base)?.seed).toBe(123);
    expect(parseBrParams(q('br=1&seed=0'), base)?.seed).toBe(0);
    for (const s of ['-1', '1.5', 'x', '', '99999999999']) expect(parseBrParams(q(`br=1&seed=${s}`), base)).not.toHaveProperty('seed');
  });
});
