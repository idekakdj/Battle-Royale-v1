/**
 * Nav-grid warm-up (v1.10.1, WP-L2): build the Ocean Dome's bot navigation grids during the countdown, not on the first live tick.
 *
 * `getNavGrid(arena, radius, margin)` (src/ai/NavGrid.ts) builds a ~0.75 m walkability grid over the dome the first time a bot
 * asks for it and caches it per (arena, body radius, margin). Every bot asks on the FIRST live tick (the instant "FIGHT!" starts),
 * and each distinct (animal radius x difficulty margin) is a separate grid costing 80-170 ms - measured here: one bot's first live
 * update = 320 ms, all nine = 2.7-4.4 s in ONE tick. For the online host that is a multi-second stall of the whole loop at the start
 * of the fight (no snapshots, no pongs: the "5500 ms ping" in the field reports), for an offline player a frozen screen.
 *
 * The grids are pure functions of (arena, radius, margin), so building them earlier changes nothing the sim can observe - the same
 * grids, the same bot decisions, byte-identical matches. This module lists exactly the grids the bots will ask for and builds them
 * in slices (one per few rendered frames while the countdown is frozen), with a synchronous flush as the safety net just before the
 * fight starts. Flat arenas (colosseum, jungle) build no grids at all, so they get an empty list.
 */

import type { AnimalId, Difficulty } from '../core/types';
import type { ArenaDef } from '../config/arenas';
import { ANIMALS } from '../config/animals';
import { getNavGrid } from '../ai/NavGrid';
import { NAV_AI } from '../ai/Navigator';

export interface NavWarmKey {
  /** Body radius of the animal (m). */
  radius: number;
  /** Extra clearance: the navigator's per-difficulty margin, or 0 (SerpentSense / FallGuard). */
  margin: number;
}

/**
 * The grids the bots of `animals` at `difficulty` will request on `arena`, most urgent first: the navigator's own margin for every
 * distinct body radius, then the margin-0 grids the serpent / fall guards use. Empty on arenas without a heightfield.
 */
export function navWarmKeys(arena: ArenaDef, animals: readonly AnimalId[], difficulty: Difficulty): NavWarmKey[] {
  if (arena.heightfield === undefined) return [];
  const radii: number[] = [];
  for (const a of animals) {
    const r = ANIMALS[a].radius;
    if (!radii.includes(r)) radii.push(r);
  }
  const margins = [NAV_AI[difficulty].margin];
  if (!margins.includes(0)) margins.push(0);
  const keys: NavWarmKey[] = [];
  for (const margin of margins) for (const radius of radii) keys.push({ radius, margin });
  return keys;
}

export type GridBuilder = (arena: ArenaDef, radius: number, margin: number) => unknown;

/** Builds the listed grids one at a time (the slices) or all at once (the flush). */
export class NavWarmer {
  private next = 0;
  /** Total ms spent building so far (diagnostics). */
  spentMs = 0;

  constructor(
    private readonly arena: ArenaDef,
    private readonly keys: readonly NavWarmKey[],
    private readonly build: GridBuilder = getNavGrid,
    private readonly clock: () => number = () => performance.now(),
  ) {}

  /** Grids still to build. */
  get pending(): number {
    return this.keys.length - this.next;
  }

  get total(): number {
    return this.keys.length;
  }

  /** Build the next grid; returns the ms it took (0 when nothing is left). */
  stepOne(): number {
    if (this.next >= this.keys.length) return 0;
    const k = this.keys[this.next++];
    const t0 = this.clock();
    this.build(this.arena, k.radius, k.margin);
    const ms = this.clock() - t0;
    this.spentMs += ms;
    return ms;
  }

  /** Build everything that is left (right before the fight starts); returns the ms it took. */
  flush(): number {
    let ms = 0;
    while (this.next < this.keys.length) ms += this.stepOne();
    return ms;
  }
}
