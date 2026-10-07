/**
 * Spawn seating (WP-M). Roster order = fighter id = spawn slot, and the player
 * is always index 0 (south). The nine bots are dealt into the remaining seats
 * with a seeded Fisher–Yates permutation (mulberry32(seed ^ 0x9e3779b9), the
 * same derivation `scripts/balance-sweep.ts` uses) so neighbours change per
 * match/REMATCH while staying deterministic for a given seed.
 *
 * v1.8: the seats themselves (spawn positions) belong to the ARENA (`config/arenas.ts`): roster index = fighter id =
 * seat index of `arena.spawns` (seat 0, the player's, is due south in both arenas). {@link seatPositions} exposes
 * the positions a roster gets so UI/tests/online can read them without building a World.
 */

import { mulberry32 } from '../core/math';
import type { AnimalId, RosterEntry } from '../core/types';
import type { ArenaDef, SpawnPoint } from '../config/arenas';
import { COLOSSEUM_ARENA, spawnPositions } from '../config/arenas';

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

/**
 * Spawn positions for a roster of `n` in `arena` (index = roster index = fighter id), exactly what `new World` uses:
 * the colosseum's 360°/n ring, or the jungle's cleared seats.
 */
export function seatPositions(n: number, arena: ArenaDef = COLOSSEUM_ARENA): SpawnPoint[] {
  return spawnPositions(arena, n);
}

/**
 * Seeded bot seating: player's animal first, then the other nine shuffled. `arena` (default colosseum) caps the roster
 * at the arena's seat count (10 in both shipped arenas, so the roster is the usual ten); the shuffle is unchanged.
 */
export function seatRoster(playerAnimal: AnimalId, seed: number, arena: ArenaDef = COLOSSEUM_ARENA): RosterEntry[] {
  const bots = ALL_ANIMALS.filter((a) => a !== playerAnimal);
  const rng = mulberry32(seed ^ 0x9e3779b9);
  for (let i = bots.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = bots[i];
    bots[i] = bots[j];
    bots[j] = t;
  }
  const roster: RosterEntry[] = [
    { animal: playerAnimal, isPlayer: true },
    ...bots.map((a): RosterEntry => ({ animal: a, isPlayer: false })),
  ];
  return roster.length > arena.spawns.length ? roster.slice(0, Math.max(1, arena.spawns.length)) : roster;
}
