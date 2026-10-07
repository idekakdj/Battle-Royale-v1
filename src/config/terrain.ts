/**
 * Terrain tuning (v1.8, docs/JUNGLE-PLAN.md): EVERY number of the moss patches, the shallow pool and the splash event in one
 * documented place. The mechanics live in `sim/TerrainSystem.ts`; the zone GEOMETRY lives in `config/arenas.ts`
 * (`ArenaDef.terrain`). Pure data + two pure helpers: no sim / three / DOM imports (config, sim, ai, render, audio and
 * online can all read it).
 *
 * What terrain does (and does not do)
 *  - A fighter is GROUNDED when it is alive, not burrowed / untargetable and at most {@link TERRAIN.groundedAlt} metres above the
 *    ground under it (the same 0.6 m the hippo mud pool uses; flyers and high jumps are never affected).
 *  - Moss: a grounded fighter whose BODY CIRCLE overlaps a moss disc is slowed by {@link TERRAIN.moss}.slow (all animals
 *    equally); the slow clings for {@link TERRAIN.moss}.lingerS after leaving the patch.
 *  - Water: a grounded fighter whose CENTRE is inside a water disc is "wading/swimming" (`inWater`) and its ordinary run speed
 *    is multiplied by {@link waterSpeedMultiplier} (from `AnimalDef.swim`). The pool is shallow (≈ 0.55 m) so nobody ever goes under.
 *  - Terrain only scales ORDINARY run/walk locomotion (`Fighter.terrainSpeedMult` → MovementSystem.locomote). Dashes, pounces,
 *    charges, leaps, soar/glide, knockback, grab movement and ultimate-driven movement keep their own speeds. Block, attacks and
 *    ultimates work normally in water; the mole's Burrow special does not work in water ({@link WATER_BLOCKED_SPECIALS}).
 */

import type { AnimalId } from '../core/types';
import { ANIMALS, type AnimalDef } from './animals';

export const TERRAIN = {
  /** A fighter at or below this altitude (m above the ground) counts as grounded (same value as the hippo mud's `groundedAlt`). */
  groundedAlt: 0.6,

  /**
   * v1.8 anti hop-chain rule: a jump launched from slow terrain (water, or moss / its linger) leaves the ground at this fraction of
   * the normal launch speed, so the apex (7 m/s x 0.55 = 3.85 m/s -> 0.37 m) stays below {@link TERRAIN.groundedAlt} and the
   * fighter keeps wading / being slowed through the hop. Without it a held-jump spam crossed the pool in about half the walking
   * time (giraffe 7.7 s -> 3.8 s) because 70 % of every hop is above the 0.6 m grounded line. Not applied off terrain.
   */
  wetJumpMult: 0.55,

  moss: {
    /** Fraction of ordinary run speed lost on moss (plan: 35 %). */
    slow: 0.35,
    /** Seconds the slow clings to the legs after the body leaves the patch (a bit longer than the mud's 0.3 s so the edge reads). */
    lingerS: 0.4,
  },

  water: {
    /**
     * Shoreline hysteresis (m): a fighter ENTERS the water when its centre is within the disc radius R and only LEAVES once it
     * is farther than R + this, so wading along the shoreline never flickers `inWater` / spams splashes.
     */
    shorelineHysteresis: 0.15,
    /** Water speed multiplier of an animal with `swim = 0` (a pure wader). */
    multMin: 0.3,
    /** Water speed multiplier of an animal with `swim = 1` (as fast in the water as on land). */
    multMax: 1.0,
  },

  /**
   * `splash` event strength (0..1) = clamp(base + horizW·hSpeed/horizRef + vertW·|vSpeed|/vertRef): a standing mole
   * stepping in gives a soft ≈ 0.15 plop, a full-speed run ≈ 0.5, a jump landing in the pool at full tilt ≈ 0.9+.
   */
  splash: {
    base: 0.15,
    horizW: 0.5,
    /** Horizontal speed (m/s) that earns the full `horizW` (≈ the fastest ordinary run). */
    horizRef: 8,
    vertW: 0.5,
    /** Vertical speed (m/s) that earns the full `vertW` (a jump lands at ≈ 7 m/s, from the pool's 0.6 m grounded line ≈ 5). */
    vertRef: 6,
  },
} as const;

/**
 * Specials that do nothing while their user is in the water (the cast fizzles, the cooldown is NOT consumed, no animation starts):
 * the mole cannot dig into a pool. (The Burrow in progress is unaffected; a burrowed mole is never `inWater`.)
 */
export const WATER_BLOCKED_SPECIALS: readonly AnimalId[] = ['mole'];

/**
 * Water speed multiplier for a swim aptitude: `multMin + (multMax − multMin) × swim` (swim clamped to 0..1), so it is always
 * within [0.30, 1.00]. With the shipped `swim` values: crocodile 0.95, hippo 0.86, python 0.76, panther 0.60, mole 0.55,
 * lion 0.50, eagle 0.45, rhino 0.40, gorilla 0.36, giraffe 0.32 (× each animal's own land speed).
 */
export function waterMultFromSwim(swim: number): number {
  const s = swim !== swim ? 0 : swim < 0 ? 0 : swim > 1 ? 1 : swim;
  const { multMin, multMax } = TERRAIN.water;
  return multMin + (multMax - multMin) * s;
}

/** The water speed multiplier of an animal (by id or by def). */
export function waterSpeedMultiplier(animal: AnimalId | Pick<AnimalDef, 'swim'>): number {
  const swim = typeof animal === 'string' ? ANIMALS[animal].swim : animal.swim;
  return waterMultFromSwim(swim);
}

/** Moss speed multiplier (1 − slow), the factor `TerrainSystem` applies while a fighter is on / lingering on a patch. */
export const MOSS_SPEED_MULT = 1 - TERRAIN.moss.slow;

/** Splash strength 0..1 for a fighter crossing the waterline at horizontal speed `hSpeed` and vertical speed `vSpeed` (m/s). */
export function splashStrength(hSpeed: number, vSpeed: number): number {
  const s = TERRAIN.splash;
  const v = s.base + (s.horizW * Math.min(1, Math.abs(hSpeed) / s.horizRef)) + (s.vertW * Math.min(1, Math.abs(vSpeed) / s.vertRef));
  return v !== v ? 0 : v < 0 ? 0 : v > 1 ? 1 : v;
}
