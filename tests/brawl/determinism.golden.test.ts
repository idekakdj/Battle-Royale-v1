import { describe, expect, it } from 'vitest';
import type { StageId } from '../../src/brawl/types';
import { playScripted } from './netHelpers';

/**
 * Golden determinism test: a fixed, scripted match (inputs are a pure hash of seed / slot / frame) must produce these exact
 * 32-bit state checksums on EVERY machine and engine. If this fails after an intentional balance or rules change, regenerate
 * the numbers (print `playScripted(...).checksums`) and commit them together with the change; if it fails without such a
 * change, the simulation has become non-deterministic (or a banned Math.* call crept in) and online play would desync.
 */

/*
 * REGENERATED for v1.6 (intentional rule / data changes, not a determinism regression): new saved fighter field `assistCd` (the state layout
 * changed, so every checksum differs from frame 180 on), the ledge auto-grab assist (PHYS.ledgeAssist*), the burrow / stopAtEdge / underground
 * sim rules, the crocodile's doubled ground jump height (jumpVel 12.5 -> 17.6777) and the lion / crocodile weight retune of the balance pass.
 * REGENERATED AGAIN for the v1.6 dynamic stages (WP-M1): the saved state grew (per platform `active` / `hp`, the stage's final-form flag, per fighter
 * `actSerial` / `platAct` / `platFrame`), riders now also follow their platform during hitlag / the countdown, a fighter that does not move horizontally
 * is never "blocked" by flipping it to the far side of a solid it merely touches, and a ledge climb is stored relative to its (possibly moving) platform
 * — so every checksum of the two ORIGINAL stages changed too, while the gameplay counters (hits / kos / moveStarts) of those scenarios are
 * unchanged. Two new stages are covered: Clockwork Heights (a moving solid core) and Crumbling Amphitheatre (breakables; the 4-player scenario flips
 * to the final form at frame 5471 and is played on for another 1700 frames).
 * (Regenerate with: print `playScripted(stage, n, seed, frames, checkpoints)` for the entries below.)
 *
 * REGENERATED for v1.7 (final-form span platform, intentional data change): the Crumbling Amphitheatre gained the `finalOnly` soft platform `span`
 * (x -6..6, y 3.0) — the stage's platform list, and with it the saved state, grew by one entry, so BOTH Amphitheatre scenarios changed from frame 180
 * on; the 4-player one flips to the final form at the same frame (5471) as before and its post-flip 1700 frames now play on the new layout (hits 28 -> 39,
 * kos 65 -> 55, moveStarts 436 -> 453). The other five scenarios (Broken Colosseum, Sky Aqueduct, Clockwork Heights) are byte-for-byte unchanged.
 */
const CHECKPOINTS = [180, 600, 1200, 2400, 3600];
const CHECKPOINTS_LONG = [180, 600, 1200, 2400, 3600, 5400, 7200];

interface Golden {
  stage: StageId;
  n: number;
  seed: number;
  frames: number;
  checkpoints: number[];
  checksums: Record<number, number>;
  hits: number;
  kos: number;
  moveStarts: number;
  platHits: number;
  platBreaks: number;
  finalFrame: number;
}

const GOLDEN: Golden[] = [
  {
    stage: 'brokenColosseum',
    n: 4,
    seed: 20260,
    frames: 3600,
    checkpoints: CHECKPOINTS,
    checksums: { 180: 1452315024, 600: 874384531, 1200: 3330959672, 2400: 1122561305, 3600: 441412730 },
    hits: 19,
    kos: 11,
    moveStarts: 286,
    platHits: 0,
    platBreaks: 0,
    finalFrame: -1,
  },
  {
    // moving platforms: exercises dsin
    stage: 'skyAqueduct',
    n: 4,
    seed: 20261,
    frames: 3600,
    checkpoints: CHECKPOINTS,
    checksums: { 180: 2463151820, 600: 4281680347, 1200: 223856994, 2400: 753204806, 3600: 459889267 },
    hits: 25,
    kos: 19,
    moveStarts: 235,
    platHits: 0,
    platBreaks: 0,
    finalFrame: -1,
  },
  {
    stage: 'skyAqueduct',
    n: 2,
    seed: 20262,
    frames: 3600,
    checkpoints: CHECKPOINTS,
    checksums: { 180: 459218670, 600: 3522242080, 1200: 4184184839, 2400: 2927276780, 3600: 3453886989 },
    hits: 3,
    kos: 8,
    moveStarts: 126,
    platHits: 0,
    platBreaks: 0,
    finalFrame: -1,
  },
  {
    // v1.6: a moving SOLID platform (path motion through dcos, riders carried, push-out)
    stage: 'clockworkHeights',
    n: 4,
    seed: 20263,
    frames: 3600,
    checkpoints: CHECKPOINTS,
    checksums: { 180: 3022816081, 600: 3161874119, 1200: 1511591472, 2400: 4104710722, 3600: 2110371342 },
    hits: 22,
    kos: 18,
    moveStarts: 258,
    platHits: 0,
    platBreaks: 0,
    finalFrame: -1,
  },
  {
    stage: 'clockworkHeights',
    n: 2,
    seed: 20266,
    frames: 3600,
    checkpoints: CHECKPOINTS,
    checksums: { 180: 2134312547, 600: 611261712, 1200: 3517114609, 2400: 2751190768, 3600: 196432281 },
    hits: 9,
    kos: 9,
    moveStarts: 121,
    platHits: 0,
    platBreaks: 0,
    finalFrame: -1,
  },
  {
    // v1.6: breakables -> all six pieces destroyed -> FINAL FORM at frame 5471, then 1700 more frames on the new layout
    stage: 'crumblingAmphitheatre',
    n: 4,
    seed: 1,
    frames: 7200,
    checkpoints: CHECKPOINTS_LONG,
    checksums: { 180: 2478484700, 600: 3499052753, 1200: 3581821668, 2400: 3197006905, 3600: 1105596366, 5400: 586225110, 7200: 2784368028 },
    hits: 39,
    kos: 55,
    moveStarts: 453,
    platHits: 30,
    platBreaks: 6,
    finalFrame: 5471,
  },
  {
    // v1.6: a partly destroyed arena (two pieces down, no final form yet)
    stage: 'crumblingAmphitheatre',
    n: 2,
    seed: 20265,
    frames: 3600,
    checkpoints: CHECKPOINTS,
    checksums: { 180: 1461904664, 600: 3440480880, 1200: 2808649852, 2400: 1080358772, 3600: 3812929020 },
    hits: 10,
    kos: 10,
    moveStarts: 136,
    platHits: 18,
    platBreaks: 2,
    finalFrame: -1,
  },
];

describe('golden determinism', () => {
  for (const g of GOLDEN) {
    it(`${g.n} fighters on ${g.stage} (seed ${g.seed}, ${g.frames} frames) reproduces the committed checksums`, () => {
      const r = playScripted(g.stage, g.n, g.seed, g.frames, g.checkpoints);
      expect(Object.fromEntries(r.checksums)).toEqual(g.checksums);
      expect({ hits: r.hits, kos: r.kos, moveStarts: r.moveStarts }).toEqual({ hits: g.hits, kos: g.kos, moveStarts: g.moveStarts });
      expect({ platHits: r.platHits, platBreaks: r.platBreaks, finalFrame: r.finalFrame }).toEqual({ platHits: g.platHits, platBreaks: g.platBreaks, finalFrame: g.finalFrame });
      expect(r.frames).toBe(g.frames);
    });
  }

  it('the scripted matches really fight (hits, KOs, respawns), so the checksums cover real gameplay', () => {
    const total = GOLDEN.reduce((a, g) => a + g.hits + g.kos, 0);
    expect(total).toBeGreaterThan(80);
    expect(GOLDEN.every((g) => g.moveStarts > 100)).toBe(true);
    // the dynamic stages' scenarios exercise their features: breaking, the final form, KOs on the moving stage
    expect(GOLDEN.some((g) => g.finalFrame > 0 && g.platBreaks === 6)).toBe(true);
    expect(GOLDEN.some((g) => g.stage === 'clockworkHeights' && g.kos > 5)).toBe(true);
  });

  it('two independent runs agree (no hidden global state)', () => {
    const a = playScripted('brokenColosseum', 3, 777, 1500, [500, 1500]);
    const b = playScripted('brokenColosseum', 3, 777, 1500, [500, 1500]);
    expect([...a.checksums]).toEqual([...b.checksums]);
    const c = playScripted('brokenColosseum', 3, 778, 1500, [500, 1500]);
    expect(c.checksums.get(1500)).not.toBe(a.checksums.get(1500));
  });
});
