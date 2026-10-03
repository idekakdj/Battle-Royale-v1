/**
 * Mini stat bars for the setup screen. Weight / Speed / Reach / Recovery come straight from the data package's
 * `ratings()`; POWER is derived here from the animal's best heavy attack ("kill percent": the lowest victim percent
 * at which it launches a mid-weight target off the stage — lower = more power), because `ratings().power`
 * (average damage x knockback per frame) is flat for the current move data. 85 % kill = full bar, 150 %+ = empty.
 */

import type { MovesetDef } from '../types';
import { bodyKillPercent, ratings } from '../data';

export interface UiRatings {
  weight: number;
  speed: number;
  reach: number;
  recovery: number;
  power: number;
}

const HEAVY: readonly ('heavyN' | 'heavyS' | 'heavyD' | 'heavyU')[] = ['heavyN', 'heavyS', 'heavyD', 'heavyU'];
const KILL_FULL = 85;
const KILL_EMPTY = 150;

/** Lowest kill percent over the four heavies (Infinity when none can kill). */
export function bestKillPercent(set: MovesetDef): number {
  let best = Infinity;
  for (const id of HEAVY) best = Math.min(best, bodyKillPercent(set.moves[id].ground));
  return best;
}

export function powerFromKillPercent(kill: number): number {
  if (!Number.isFinite(kill)) return 0;
  return Math.max(0, Math.min(1, (KILL_EMPTY - kill) / (KILL_EMPTY - KILL_FULL)));
}

const cache = new Map<string, UiRatings>();

export function uiRatings(set: MovesetDef): UiRatings {
  const hit = cache.get(set.animal);
  if (hit !== undefined) return hit;
  const r = ratings(set);
  const out: UiRatings = {
    weight: r.weight,
    speed: r.speed,
    reach: r.reach,
    recovery: r.recovery,
    power: powerFromKillPercent(bestKillPercent(set)),
  };
  cache.set(set.animal, out);
  return out;
}
