/**
 * Battle Royale URL shortcut (v1.8 QA): `?br=1&arena=jungle&animal=croc&level=3[&seed=123][&qa=1]` boots straight into a LOCAL
 * Battle Royale match — the offline sibling of Champions League's `?brawl=1`. Pure parsing, every field validated:
 *
 *  - `animal`: an animal id (or a short alias like `croc`); missing / unknown → the stored `gk-animal` (the `base`).
 *  - `level`: difficulty 1..4; missing / unknown → the stored `gk-difficulty` (the `base`).
 *  - `arena`: `colosseum` | `jungle`; missing / unknown → the colosseum (a QA link never depends on a stored preference).
 *  - `seed`: optional integer (reproducible match); missing / invalid → the caller's usual fresh seed.
 *  - `qa=1`: expose `window.__gkBr = { world, controller }` (dev builds always expose it).
 *
 * Returns `null` when `br=1` is absent.
 */

import type { AnimalId, ArenaId, Difficulty } from '../core/types';
import { ANIMAL_IDS } from '../config/animals';
import { isArenaId } from '../config/arenas';

export interface BrShortcut {
  animal: AnimalId;
  difficulty: Difficulty;
  arena: ArenaId;
  /** Explicit seed, or `undefined` for a fresh one. */
  seed?: number;
  /** `qa=1` was passed (expose the QA handle in production builds too). */
  qa: boolean;
}

/** Short names QA links may use instead of the animal id. */
const ANIMAL_ALIASES: Readonly<Record<string, AnimalId>> = {
  croc: 'crocodile',
  gator: 'crocodile',
  snake: 'python',
  bird: 'eagle',
  cat: 'panther',
  ape: 'gorilla',
};

/** `animal=` value → an {@link AnimalId} (case-insensitive, aliases allowed) or `null`. */
export function parseBrAnimal(raw: string | null): AnimalId | null {
  if (raw === null) return null;
  const k = raw.trim().toLowerCase();
  if ((ANIMAL_IDS as readonly string[]).includes(k)) return k as AnimalId;
  return ANIMAL_ALIASES[k] ?? null;
}

/** `level=` value → 1..4 or `null`. */
export function parseBrLevel(raw: string | null): Difficulty | null {
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return n === 1 || n === 2 || n === 3 || n === 4 ? n : null;
}

/** `arena=` value → an {@link ArenaId} (case-insensitive); missing / unknown → the colosseum. */
export function parseBrArena(raw: string | null): ArenaId {
  const k = raw === null ? '' : raw.trim().toLowerCase();
  return isArenaId(k) ? k : 'colosseum';
}

export function parseBrParams(
  params: URLSearchParams,
  base: { animal: AnimalId; difficulty: Difficulty },
): BrShortcut | null {
  if (params.get('br') !== '1') return null;
  const seedRaw = params.get('seed');
  const seedN = seedRaw === null || seedRaw.trim() === '' ? NaN : Number(seedRaw);
  return {
    animal: parseBrAnimal(params.get('animal')) ?? base.animal,
    difficulty: parseBrLevel(params.get('level')) ?? base.difficulty,
    arena: parseBrArena(params.get('arena')),
    ...(Number.isInteger(seedN) && seedN >= 0 && seedN <= 0xffffffff ? { seed: seedN } : {}),
    qa: params.get('qa') === '1',
  };
}
