/**
 * v1.10 serpent LANES (docs/OCEAN-HEIGHTS-PLAN.md): the Ocean Dome runs two independent sea serpents.
 *
 *  - the LOW serpent only ever attacks along strike lines whose whole strip (half-width + margin) stays over LOW ground, i.e. it
 *    never runs over, through or alongside an upper platform (or the high part of its ramp) — "doesn't conflict with upper
 *    platform placement";
 *  - the HIGH serpent only ever attacks along strike lines that run over HIGH ground for a real stretch, so every high event
 *    threatens the upper platforms.
 *
 * "High" = ground height >= `arena.hazards.serpentSplitY` (see `arenaSerpentBand`). The strike angle of a lane is drawn from the
 * lane's own RNG stream by picking a uniformly random ALLOWED 1-degree bin and a uniformly random fraction inside it
 * ({@link pickLaneAngle}); the bin tables are pure functions of the arena (cached per arena object).
 *
 * Pure data + helpers: no three/DOM/sim imports.
 */

import { arenaGroundHeight, type ArenaDef } from './arenas';
import { SERPENT } from './serpent';
import type { SerpentTier } from '../core/types';

/** Lane tuning (geometry only; timing/damage stay in `SERPENT`). */
export const SERPENT_LANES = {
  /** XOR'd into the match seed for the HIGH serpent's RNG stream (the low serpent keeps `SERPENT.seedSalt`). */
  highSeedSalt: 0x7a15c0de,
  /** LOW lane: no point within `stripHalfWidth + lowClearMargin` of the strike line may stand on HIGH ground. */
  lowClearMargin: 1.0,
  /** HIGH lane: the strike centre line must run over HIGH ground for at least this much length (m). */
  highMinOverlapM: 2.0,
  /** Sampling step along the strike line (m). */
  stepM: 0.5,
} as const;

/** Allowed 1-degree bins of each lane: bin `b` covers angles [b, b + 1). Ascending. */
export interface SerpentLaneBins {
  low: readonly number[];
  high: readonly number[];
}

const DEG = Math.PI / 180;

/** Highest ground under the strip of half-width `hw` around the strike line at `angleDeg` (centre → wall). */
export function stripMaxGround(arena: ArenaDef, angleDeg: number, hw: number): number {
  const c = Math.cos(angleDeg * DEG);
  const s = Math.sin(angleDeg * DEG);
  let max = -Infinity;
  const lat = [-hw, -hw / 2, 0, hw / 2, hw];
  for (let r = 0; r <= arena.wallRadius; r += SERPENT_LANES.stepM) {
    for (let k = 0; k < lat.length; k++) {
      const x = c * r - s * lat[k];
      const z = s * r + c * lat[k];
      const g = arenaGroundHeight(arena, x, z);
      if (g > max) max = g;
    }
  }
  return max;
}

/** Length (m) of the strike CENTRE line that runs over ground of height >= `splitY`. */
export function stripHighLength(arena: ArenaDef, angleDeg: number, splitY: number): number {
  const c = Math.cos(angleDeg * DEG);
  const s = Math.sin(angleDeg * DEG);
  let n = 0;
  for (let r = 0; r <= arena.wallRadius; r += SERPENT_LANES.stepM) {
    if (arenaGroundHeight(arena, c * r, s * r) >= splitY) n++;
  }
  return n * SERPENT_LANES.stepM;
}

const CACHE = new WeakMap<ArenaDef, SerpentLaneBins>();

/**
 * The allowed angle bins of both lanes. An arena without `hazards.serpentSplitY` has every bin in `low` and none in `high`
 * (the single v1.9 serpent, uniform over the circle).
 */
export function serpentLaneBins(arena: ArenaDef): SerpentLaneBins {
  const hit = CACHE.get(arena);
  if (hit !== undefined) return hit;
  const split = arena.hazards?.serpentSplitY;
  const low: number[] = [];
  const high: number[] = [];
  const hw = SERPENT.stripHalfWidth + SERPENT_LANES.lowClearMargin;
  for (let b = 0; b < 360; b++) {
    if (split === undefined) {
      low.push(b);
      continue;
    }
    // LOW: the whole bin (both edges and the middle) keeps the padded strip off high ground
    if (
      stripMaxGround(arena, b, hw) < split &&
      stripMaxGround(arena, b + 0.5, hw) < split &&
      stripMaxGround(arena, b + 1, hw) < split
    ) {
      low.push(b);
    }
    // HIGH: the centre line of the bin's middle runs over high ground for a real stretch
    if (stripHighLength(arena, b + 0.5, split) >= SERPENT_LANES.highMinOverlapM) high.push(b);
  }
  const out: SerpentLaneBins = { low, high };
  CACHE.set(arena, out);
  return out;
}

/**
 * Draw a strike angle (degrees, [0, 360)) for `tier` from `rng` (a `() => [0,1)` stream): exactly TWO draws (bin, fraction) so the
 * stream consumption is the same for every outcome. Returns −1 (still consuming the two draws) when the lane has no allowed bin —
 * the caller then skips the event.
 */
export function pickLaneAngle(arena: ArenaDef, tier: SerpentTier, rng: () => number): number {
  const bins = serpentLaneBins(arena)[tier];
  const u = rng();
  const f = rng();
  if (bins.length === 0) return -1;
  const b = bins[Math.min(bins.length - 1, Math.floor(u * bins.length))];
  return b + f;
}
