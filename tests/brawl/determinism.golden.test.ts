import { describe, expect, it } from 'vitest';
import { playScripted } from './netHelpers';

/**
 * Golden determinism test: a fixed, scripted match (inputs are a pure hash of seed / slot / frame) must produce these exact
 * 32-bit state checksums on EVERY machine and engine. If this fails after an intentional balance or rules change, regenerate
 * the numbers (print `playScripted(...).checksums`) and commit them together with the change; if it fails without such a
 * change, the simulation has become non-deterministic (or a banned Math.* call crept in) and online play would desync.
 */

const CHECKPOINTS = [180, 600, 1200, 2400, 3600];

const GOLDEN = [
  {
    stage: 'brokenColosseum' as const,
    n: 4,
    seed: 20260,
    checksums: { 180: 1088938368, 600: 2122908579, 1200: 1647849246, 2400: 1777575322, 3600: 3840310547 },
    hits: 30,
    kos: 7,
    moveStarts: 292,
  },
  {
    // moving platforms: exercises dsin
    stage: 'skyAqueduct' as const,
    n: 4,
    seed: 20261,
    checksums: { 180: 614612677, 600: 3682800498, 1200: 762779613, 2400: 3004956560, 3600: 4133167064 },
    hits: 26,
    kos: 18,
    moveStarts: 244,
  },
  {
    stage: 'skyAqueduct' as const,
    n: 2,
    seed: 20262,
    checksums: { 180: 3446792888, 600: 3781815623, 1200: 1285120272, 2400: 3028494547, 3600: 233312339 },
    hits: 3,
    kos: 10,
    moveStarts: 125,
  },
];

describe('golden determinism', () => {
  for (const g of GOLDEN) {
    it(`${g.n} fighters on ${g.stage} (seed ${g.seed}) reproduces the committed checksums`, () => {
      const r = playScripted(g.stage, g.n, g.seed, 3600, CHECKPOINTS);
      expect(Object.fromEntries(r.checksums)).toEqual(g.checksums);
      expect({ hits: r.hits, kos: r.kos, moveStarts: r.moveStarts }).toEqual({ hits: g.hits, kos: g.kos, moveStarts: g.moveStarts });
      expect(r.frames).toBe(3600);
    });
  }

  it('the scripted matches really fight (hits, KOs, respawns), so the checksums cover real gameplay', () => {
    const total = GOLDEN.reduce((a, g) => a + g.hits + g.kos, 0);
    expect(total).toBeGreaterThan(80);
    expect(GOLDEN.every((g) => g.moveStarts > 100)).toBe(true);
  });

  it('two independent runs agree (no hidden global state)', () => {
    const a = playScripted('brokenColosseum', 3, 777, 1500, [500, 1500]);
    const b = playScripted('brokenColosseum', 3, 777, 1500, [500, 1500]);
    expect([...a.checksums]).toEqual([...b.checksums]);
    const c = playScripted('brokenColosseum', 3, 778, 1500, [500, 1500]);
    expect(c.checksums.get(1500)).not.toBe(a.checksums.get(1500));
  });
});
