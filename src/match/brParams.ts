/**
 * Battle Royale URL shortcut (v1.8 QA): `?br=1&arena=jungle&animal=croc&level=3[&seed=123][&qa=1]` boots straight into a LOCAL
 * Battle Royale match — the offline sibling of Champions League's `?brawl=1`. Pure parsing, every field validated:
 *
 *  - `animal`: an animal id (or a short alias like `croc`); missing / unknown → the stored `gk-animal` (the `base`).
 *  - `level`: difficulty 1..4; missing / unknown → the stored `gk-difficulty` (the `base`).
 *  - `arena`: `colosseum` | `jungle` | `ocean`; missing / unknown → the colosseum (a QA link never depends on a stored preference).
 *  - `seed`: optional integer (reproducible match); missing / invalid → the caller's usual fresh seed.
 *  - `qa=1`: expose `window.__gkBr = { world, controller }` (dev builds always expose it).
 *
 * v1.9 Ocean Dome sea-serpent QA: `?br=1&arena=ocean&serpent=1[&serpentAt=12][&seed=N]&qa=1` forces a serpent event at
 * `serpentAt` LIVE match seconds (the 3-2-1 countdown does not count; default 12) by giving the World the option
 * `{ serpent: { chance: 1, firstAtS: serpentAt } }` (see {@link serpentOptionsFor}; later rolls then follow every 60 s, also with
 * certainty). Only honoured when `arena` is an arena with a serpent hazard (`hazards.serpent`; otherwise `serpent=1` is ignored and
 * the match is exactly the normal one). `serpentAt` must be a finite number in (0, 3600]; anything else falls back to 12. The
 * event can also be started by hand from the console: `window.__gkBr.world.debugTriggerSerpent(angleDeg)`.
 *
 * Returns `null` when `br=1` is absent.
 */

import type { AnimalId, ArenaId, Difficulty } from '../core/types';
import { ANIMAL_IDS } from '../config/animals';
import { getArena, isArenaId } from '../config/arenas';
import type { SerpentOptions } from '../sim/SerpentSystem';

/** Live match seconds of the forced serpent event when `serpentAt` is missing / invalid. */
export const DEFAULT_SERPENT_AT_S = 12;
/** Largest accepted `serpentAt` (one hour of live match time). */
export const MAX_SERPENT_AT_S = 3600;

export interface BrShortcut {
  animal: AnimalId;
  difficulty: Difficulty;
  arena: ArenaId;
  /** Explicit seed, or `undefined` for a fresh one. */
  seed?: number;
  /** `qa=1` was passed (expose the QA handle in production builds too). */
  qa: boolean;
  /**
   * v1.9: `serpent=1` on a serpent arena — force a sea-serpent event at `atS` live seconds. Absent otherwise (the normal rules:
   * a 10 % roll per minute on arenas with the hazard, nothing elsewhere).
   */
  serpent?: { atS: number };
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

/** `serpentAt=` value → live seconds in (0, 3600]; missing / invalid → {@link DEFAULT_SERPENT_AT_S}. */
export function parseBrSerpentAt(raw: string | null): number {
  if (raw === null || raw.trim() === '') return DEFAULT_SERPENT_AT_S;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= MAX_SERPENT_AT_S ? n : DEFAULT_SERPENT_AT_S;
}

/** The World option that forces the shortcut's serpent event (`undefined` = play by the real rules). */
export function serpentOptionsFor(shortcut: Pick<BrShortcut, 'serpent'>): SerpentOptions | undefined {
  return shortcut.serpent === undefined ? undefined : { chance: 1, firstAtS: shortcut.serpent.atS };
}

export function parseBrParams(
  params: URLSearchParams,
  base: { animal: AnimalId; difficulty: Difficulty },
): BrShortcut | null {
  if (params.get('br') !== '1') return null;
  const seedRaw = params.get('seed');
  const seedN = seedRaw === null || seedRaw.trim() === '' ? NaN : Number(seedRaw);
  const arena = parseBrArena(params.get('arena'));
  const serpent = params.get('serpent') === '1' && getArena(arena).hazards?.serpent === true;
  return {
    animal: parseBrAnimal(params.get('animal')) ?? base.animal,
    difficulty: parseBrLevel(params.get('level')) ?? base.difficulty,
    arena,
    ...(Number.isInteger(seedN) && seedN >= 0 && seedN <= 0xffffffff ? { seed: seedN } : {}),
    qa: params.get('qa') === '1',
    ...(serpent ? { serpent: { atS: parseBrSerpentAt(params.get('serpentAt')) } } : {}),
  };
}
