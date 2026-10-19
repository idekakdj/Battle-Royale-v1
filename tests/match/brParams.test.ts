/**
 * v1.8 QA shortcut parser: `?br=1&arena=jungle&animal=croc&level=3[&seed=…][&qa=1]`.
 */

import { describe, expect, it } from 'vitest';
import { EventBus } from '../../src/core/EventBus';
import { ARENAS } from '../../src/config/arenas';
import { World } from '../../src/sim/World';
import { seatRoster } from '../../src/match/seating';
import {
  DEFAULT_SERPENT_AT_S,
  MAX_SERPENT_AT_S,
  parseBrAnimal,
  parseBrArena,
  parseBrLevel,
  parseBrParams,
  parseBrSerpentAt,
  parseBrSerpentLanes,
  serpentOptionsFor,
} from '../../src/match/brParams';

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

  it('arena=ocean boots the Ocean Dome (v1.9), case-insensitively', () => {
    expect(parseBrArena('ocean')).toBe('ocean');
    expect(parseBrArena(' OCEAN ')).toBe('ocean');
    expect(parseBrParams(q('br=1&arena=ocean&animal=lion&level=2&qa=1'), base)).toEqual({ animal: 'lion', difficulty: 2, arena: 'ocean', qa: true });
  });

  it('the serpent QA link: ?br=1&arena=ocean&serpent=1[&serpentAt=12][&seed=N]&qa=1 forces BOTH serpents', () => {
    const r = parseBrParams(q('br=1&arena=ocean&serpent=1&qa=1'), base);
    expect(r?.serpent).toEqual({ atS: DEFAULT_SERPENT_AT_S, lanes: 'both' });
    expect(DEFAULT_SERPENT_AT_S).toBe(12);
    expect(parseBrParams(q('br=1&arena=ocean&serpent=1&serpentAt=5&seed=9&qa=1'), base)).toEqual({
      animal: 'lion',
      difficulty: 2,
      arena: 'ocean',
      seed: 9,
      qa: true,
      serpent: { atS: 5, lanes: 'both' },
    });
    expect(parseBrParams(q('br=1&arena=ocean&serpent=1&serpentAt=7.5'), base)?.serpent).toEqual({ atS: 7.5, lanes: 'both' });
  });

  it('serpent=both|low|high picks the lanes (v1.10 two serpents); case and spaces are forgiven', () => {
    expect(parseBrParams(q('br=1&arena=ocean&serpent=both&serpentAt=4&qa=1'), base)?.serpent).toEqual({ atS: 4, lanes: 'both' });
    expect(parseBrParams(q('br=1&arena=ocean&serpent=low&serpentAt=4'), base)?.serpent).toEqual({ atS: 4, lanes: 'low' });
    expect(parseBrParams(q('br=1&arena=ocean&serpent=high&serpentAt=4'), base)?.serpent).toEqual({ atS: 4, lanes: 'high' });
    expect(parseBrParams(q('br=1&arena=ocean&serpent=HIGH'), base)?.serpent).toEqual({ atS: DEFAULT_SERPENT_AT_S, lanes: 'high' });
    expect(parseBrParams(q('br=1&arena=ocean&serpent=%20Low%20'), base)?.serpent).toEqual({ atS: DEFAULT_SERPENT_AT_S, lanes: 'low' });
    expect(parseBrSerpentLanes('1')).toBe('both');
    expect(parseBrSerpentLanes('both')).toBe('both');
    expect(parseBrSerpentLanes('low')).toBe('low');
    expect(parseBrSerpentLanes('high')).toBe('high');
    for (const bad of [null, '', ' ', '0', '2', 'true', 'yes', 'all', 'mid', 'lowhigh', 'high,low']) expect(parseBrSerpentLanes(bad)).toBeNull();
  });

  it('serpent=… is only honoured on arenas with the hazard; any other value is ignored; no key without it', () => {
    for (const arena of ['colosseum', 'jungle']) {
      for (const v of ['1', 'both', 'low', 'high']) {
        expect(parseBrParams(q(`br=1&arena=${arena}&serpent=${v}&serpentAt=3`), base)).not.toHaveProperty('serpent');
      }
    }
    for (const v of ['0', 'true', 'yes', '', '2', 'mid', 'lowest']) expect(parseBrParams(q(`br=1&arena=ocean&serpent=${v}`), base)).not.toHaveProperty('serpent');
    expect(parseBrParams(q('br=1&arena=ocean&serpentAt=3'), base)).not.toHaveProperty('serpent');
    expect(parseBrParams(q('br=1&arena=ocean'), base)).toEqual({ animal: 'lion', difficulty: 2, arena: 'ocean', qa: false });
    expect(parseBrParams(q('br=1&arena=swamp&serpent=1'), base)).not.toHaveProperty('serpent'); // unknown arena -> colosseum
  });

  it('serpentAt falls back to 12 for anything that is not a finite number in (0, 3600]', () => {
    expect(parseBrSerpentAt('30')).toBe(30);
    expect(parseBrSerpentAt('0.5')).toBe(0.5);
    expect(parseBrSerpentAt(String(MAX_SERPENT_AT_S))).toBe(MAX_SERPENT_AT_S);
    for (const bad of [null, '', ' ', 'abc', '0', '-4', '3601', '1e9', 'Infinity', 'NaN']) expect(parseBrSerpentAt(bad)).toBe(DEFAULT_SERPENT_AT_S);
    expect(parseBrParams(q('br=1&arena=ocean&serpent=1&serpentAt=soon'), base)?.serpent).toEqual({ atS: 12, lanes: 'both' });
  });

  it('serpentOptionsFor builds the World option: a certain roll at serpentAt live seconds (undefined = the real rules)', () => {
    expect(serpentOptionsFor({})).toBeUndefined();
    // both lanes = the arena's default lane set (the high one exists only where the arena splits its bands)
    expect(serpentOptionsFor({ serpent: { atS: 12, lanes: 'both' } })).toEqual({ chance: 1, firstAtS: 12 });
    expect(serpentOptionsFor({ serpent: { atS: 3.5, lanes: 'both' } })).toEqual({ chance: 1, firstAtS: 3.5 });
    // one lane: the other never comes
    expect(serpentOptionsFor({ serpent: { atS: 4, lanes: 'low' } })).toEqual({ chance: 1, firstAtS: 4, lanes: ['low'] });
    expect(serpentOptionsFor({ serpent: { atS: 4, lanes: 'high' } })).toEqual({ chance: 1, firstAtS: 4, lanes: ['high'] });
  });

  it('the link end to end: the World gets both serpents / only the named one, and they really come at serpentAt', () => {
    const lanesOf = (query: string): string[] => {
      const sc = parseBrParams(q(query), base);
      const world = new World({ roster: seatRoster('lion', 5, ARENAS.ocean), difficulty: 1, arena: 'ocean' }, 5, new EventBus(), {
        traps: false,
        serpent: serpentOptionsFor(sc ?? {}),
      });
      return (world.serpent?.lanes ?? []).map((l) => l.tier);
    };
    expect(lanesOf('br=1&arena=ocean&serpent=1&serpentAt=4')).toEqual(['low', 'high']);
    expect(lanesOf('br=1&arena=ocean&serpent=both&serpentAt=4')).toEqual(['low', 'high']);
    expect(lanesOf('br=1&arena=ocean&serpent=low&serpentAt=4')).toEqual(['low']);
    expect(lanesOf('br=1&arena=ocean&serpent=high&serpentAt=4')).toEqual(['high']);
  });

  it('seed: a non-negative 32-bit integer is passed through, anything else is dropped', () => {
    expect(parseBrParams(q('br=1&seed=123'), base)?.seed).toBe(123);
    expect(parseBrParams(q('br=1&seed=0'), base)?.seed).toBe(0);
    for (const s of ['-1', '1.5', 'x', '', '99999999999']) expect(parseBrParams(q(`br=1&seed=${s}`), base)).not.toHaveProperty('seed');
  });
});
