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
 * v1.9 Ocean Dome sea-serpent QA: `?br=1&arena=ocean&serpent=1|both|low|high[&serpentAt=12][&seed=N]&qa=1` forces serpent events at
 * `serpentAt` LIVE match seconds (the 3-2-1 countdown does not count; default 12) by giving the World the option
 * `{ serpent: { chance: 1, firstAtS: serpentAt[, lanes] } }` (see {@link serpentOptionsFor}; later rolls then follow every
 * `SERPENT.intervalS` (20 s), also with certainty). v1.10 (two serpents): `serpent=1` and `serpent=both` force BOTH lanes (the low and
 * the high serpent), `serpent=low` / `serpent=high` force one lane only (the other never comes). Only honoured when `arena` is an
 * arena with a serpent hazard (`hazards.serpent`; `high` also needs the high lane, `serpentSplitY`; otherwise `serpent=…` is ignored
 * and the match is exactly the normal one). `serpentAt` must be a finite number in (0, 3600]; anything else falls back to 12. Events
 * can also be started by hand from the console: `window.__gkBr.world.debugTriggerSerpent(angleDeg, 'low' | 'high')`.
 *
 * Returns `null` when `br=1` is absent.
 */

import type { AnimalId, ArenaId, Difficulty } from '../core/types';
import { ANIMAL_IDS } from '../config/animals';
import { arenaHasHighSerpent, getArena, isArenaId } from '../config/arenas';
import type { SerpentOptions } from '../sim/SerpentSystem';

/** Live match seconds of the forced serpent event when `serpentAt` is missing / invalid. */
export const DEFAULT_SERPENT_AT_S = 12;
/** Largest accepted `serpentAt` (one hour of live match time). */
export const MAX_SERPENT_AT_S = 3600;

/** Which lanes a `serpent=` QA link forces: both serpents, or only the low / only the high one. */
export type BrSerpentLanes = 'both' | 'low' | 'high';

export interface BrShortcut {
  animal: AnimalId;
  difficulty: Difficulty;
  arena: ArenaId;
  /** Explicit seed, or `undefined` for a fresh one. */
  seed?: number;
  /** `qa=1` was passed (expose the QA handle in production builds too). */
  qa: boolean;
  /**
   * v1.9: `serpent=…` on a serpent arena — force sea-serpent events at `atS` live seconds (v1.10: of `lanes`; `1` = `both`). Absent
   * otherwise (the normal rules: an independent 50 % roll per lane every 20 s on arenas with the hazard, nothing elsewhere).
   */
  serpent?: { atS: number; lanes: BrSerpentLanes };
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

/**
 * `serpent=` value → the lanes it forces: `1` / `both` → both, `low`, `high` (trimmed, case-insensitive); anything else (missing, `0`,
 * `true`, `yes`, `2`, …) → `null` = ignored.
 */
export function parseBrSerpentLanes(raw: string | null): BrSerpentLanes | null {
  if (raw === null) return null;
  const k = raw.trim().toLowerCase();
  return k === '1' || k === 'both' ? 'both' : k === 'low' || k === 'high' ? k : null;
}

/**
 * The World option that forces the shortcut's serpent events (`undefined` = play by the real rules): a certain roll at `serpentAt`
 * live seconds (and every interval after), for both lanes (the default lane set of a two-serpent arena, so no `lanes` key) or only
 * the one named.
 */
export function serpentOptionsFor(shortcut: Pick<BrShortcut, 'serpent'>): SerpentOptions | undefined {
  const s = shortcut.serpent;
  if (s === undefined) return undefined;
  return { chance: 1, firstAtS: s.atS, ...(s.lanes === 'both' ? {} : { lanes: [s.lanes] as const }) };
}

export function parseBrParams(
  params: URLSearchParams,
  base: { animal: AnimalId; difficulty: Difficulty },
): BrShortcut | null {
  if (params.get('br') !== '1') return null;
  const seedRaw = params.get('seed');
  const seedN = seedRaw === null || seedRaw.trim() === '' ? NaN : Number(seedRaw);
  const arena = parseBrArena(params.get('arena'));
  const def = getArena(arena);
  const lanes = parseBrSerpentLanes(params.get('serpent'));
  const serpent =
    lanes !== null && def.hazards?.serpent === true && (lanes !== 'high' || arenaHasHighSerpent(def)) ? lanes : null;
  return {
    animal: parseBrAnimal(params.get('animal')) ?? base.animal,
    difficulty: parseBrLevel(params.get('level')) ?? base.difficulty,
    arena,
    ...(Number.isInteger(seedN) && seedN >= 0 && seedN <= 0xffffffff ? { seed: seedN } : {}),
    qa: params.get('qa') === '1',
    ...(serpent !== null ? { serpent: { atS: parseBrSerpentAt(params.get('serpentAt')), lanes: serpent } } : {}),
  };
}
