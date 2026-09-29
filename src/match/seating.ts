/**
 * Spawn seating (WP-M). Roster order = fighter id = spawn slot, and the player
 * is always index 0 (south). The nine bots are dealt into the remaining seats
 * with a seeded Fisher–Yates permutation (mulberry32(seed ^ 0x9e3779b9), the
 * same derivation `scripts/balance-sweep.ts` uses) so neighbours change per
 * match/REMATCH while staying deterministic for a given seed.
 */

import { mulberry32 } from '../core/math';
import type { AnimalId, RosterEntry } from '../core/types';

/** Canonical animal order the bots are dealt from before shuffling. */
export const ALL_ANIMALS: readonly AnimalId[] = [
  'lion',
  'gorilla',
  'crocodile',
  'hippo',
  'rhino',
  'eagle',
  'panther',
  'python',
  'giraffe',
  'mole',
];

/** Seeded bot seating: player's animal first, then the other nine shuffled. */
export function seatRoster(playerAnimal: AnimalId, seed: number): RosterEntry[] {
  const bots = ALL_ANIMALS.filter((a) => a !== playerAnimal);
  const rng = mulberry32(seed ^ 0x9e3779b9);
  for (let i = bots.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = bots[i];
    bots[i] = bots[j];
    bots[j] = t;
  }
  return [
    { animal: playerAnimal, isPlayer: true },
    ...bots.map((a): RosterEntry => ({ animal: a, isPlayer: false })),
  ];
}
