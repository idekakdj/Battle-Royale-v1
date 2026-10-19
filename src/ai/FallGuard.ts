/**
 * FallGuard (v1.10 WP-H3, docs/OCEAN-HEIGHTS-PLAN.md): keeps a bot from WALKING off a high platform by accident.
 *
 * A fighter that lands after dropping `hazards.fallDamage.minDrop` (3.4 m on the Ocean Dome) or more takes 50 true damage. The nav grid
 * (NavGrid.ts) never plans such a drop (its ledge edges stop at 1.9 m), but the rest of the steering does not know about edges: orbiting
 * a foe on a tower top, a separation push, a sidestep out of a corner, a flee heading or a dodge can all carry the body centre over the
 * rim. This is the last pass on the final heading: probe the ground a few metres ahead along it and, when it falls away by a deadly
 * drop, slide the heading round to the nearest direction that does not (along the rim, back onto the platform).
 *
 * It runs only on arenas with a fall rule, only on grounded bots, and only on cells within {@link RIM_FAR} of a deadly edge (the nav
 * grid's `rimD`), so it costs nothing elsewhere. Knockback, charges and pounces are not steered (a hit that shoves a fighter off a tower
 * is a fall, by design).
 *
 * Levels ({@link FALL_AI}): L1 / L2 sometimes misjudge an edge (one roll per approach; for `blunderS` seconds they walk on regardless),
 * L3 / L4 never do. Inactive (every call returns false) on arenas without `hazards.fallDamage`, which keeps the colosseum and the jungle
 * byte-identical.
 */

import type { ArenaDef } from '../config/arenas';
import type { Difficulty, FighterState } from '../core/types';
import { mulberry32, type Rng } from '../core/math';
import { arenaGroundHeight } from '../config/arenas';
import { FALL_RUN_SPEED, RIM_FAR, deadlyEdgeAhead, getNavGrid, rimAt, type NavGrid } from './NavGrid';
import type { Move2 } from './Steering';

export interface FallAiLevel {
  /** Probability per approach to an edge that the bot misjudges it and walks on for {@link blunderS} seconds. */
  blunderChance: number;
  blunderS: number;
}

/** "L1 / L2 may fall by mistake occasionally, L3 / L4 essentially never" (the fall-damage brief). */
export const FALL_AI: Record<Difficulty, FallAiLevel> = {
  1: { blunderChance: 0.3, blunderS: 0.9 },
  2: { blunderChance: 0.1, blunderS: 0.7 },
  3: { blunderChance: 0, blunderS: 0 },
  4: { blunderChance: 0, blunderS: 0 },
};

/** Metres above the ground at which a descending bot lets go of the stick (a hop over a low wall peaks at 1.2 m). */
const BRAKE_MIN_ALT_M = 1.5;

/** Heading offsets (radians) tried, nearest first; each is tried on both sides. */
const OFFSETS = [0.35, 0.7, 1.05, 1.4, 1.75, 2.1, 2.6, Math.PI];

export class FallGuard {
  /** False on arenas without a fall rule: every method is a no-op. */
  readonly active: boolean;
  level: FallAiLevel;
  /** True on the tick the guard rewrote the heading. */
  deflected = false;

  private readonly arena: ArenaDef;
  private readonly radius: number;
  private readonly rng: Rng;
  private grid: NavGrid | null = null;
  private deadly = Infinity;
  private blunderUntil = -1;
  private lastDeflectAt = -1e9;
  private side: 1 | -1 = 1;

  constructor(arena: ArenaDef, bodyRadius: number, difficulty: Difficulty, seed: number) {
    this.arena = arena;
    this.radius = bodyRadius;
    this.active = arena.heightfield !== undefined && arena.hazards?.fallDamage !== undefined;
    this.level = FALL_AI[difficulty];
    // its own stream, so the brain's decisions on the same seed are unaffected by how often a blunder is rolled
    this.rng = mulberry32((seed ^ 0x6a09e667) >>> 0);
  }

  setDifficulty(d: Difficulty): void {
    this.level = FALL_AI[d];
  }

  private getGrid(): NavGrid {
    if (this.grid === null) {
      this.grid = getNavGrid(this.arena, this.radius, 0);
      this.deadly = this.grid.deadly;
    }
    return this.grid;
  }

  /**
   * Is the way along unit heading (hx, hz) from (sx, sz) free of a ledge, within `reach` metres, off which a running body lands a
   * deadly drop below (see {@link deadlyEdgeAhead})? `feetY` is only the sanity check that the bot stands on the ground it thinks.
   */
  private clear(feetY: number, sx: number, sz: number, hx: number, hz: number, reach: number, speed = FALL_RUN_SPEED): boolean {
    void feetY;
    return deadlyEdgeAhead(this.arena, sx, sz, hx, hz, reach, this.deadly, speed) < 0;
  }

  /**
   * A body that has stepped off a ledge keeps its run speed in the air: steering on over a lower level would carry it farther out
   * and down. So a bot that is dropping (well above the ground under it, descending, not a glider) lets go of the stick; the sim's
   * deceleration stops it within a metre, and it lands where it fell. Does nothing for a hop over a low wall (apex 1.2 m).
   */
  private brake(out: Move2, self: FighterState): boolean {
    if (!self.airborne || self.glideT > 0 || self.vel.y >= -0.5) return false;
    if (self.pos.y - arenaGroundHeight(this.arena, self.pos.x, self.pos.z) < BRAKE_MIN_ALT_M) return false;
    if (out.x === 0 && out.z === 0) return false;
    out.x = 0;
    out.z = 0;
    this.deflected = true;
    return true;
  }

  /**
   * Would an ability that carries the body `reach` metres along `aimYaw` (a charge, a leap, a pounce) run it over a deadly edge?
   * The brain holds such a cast back (a bot standing near an edge only casts a mover when the way ahead is solid ground). Always
   * false off the rim and on arenas without a fall rule.
   */
  dropAhead(self: FighterState, aimYaw: number, reach: number): boolean {
    if (!this.active || reach <= 0) return false;
    const grid = this.getGrid();
    const sx = self.pos.x;
    const sz = self.pos.z;
    if (rimAt(grid, sx, sz) >= RIM_FAR) return false;
    return !this.clear(self.pos.y, sx, sz, Math.sin(aimYaw), Math.cos(aimYaw), Math.max(1, reach));
  }

  /**
   * Rewrite `out` (the final heading, magnitude <= 1) when walking it would carry the body centre over a deadly edge within the
   * look-ahead. Returns true when it changed the heading.
   */
  guard(out: Move2, now: number, self: FighterState): boolean {
    this.deflected = false;
    if (!this.active) return false;
    // dropping well above the ground: let go of the stick (see brake); a hop that is still over the platform is steered like a step
    if (self.airborne && this.brake(out, self)) return true;
    const mag = Math.hypot(out.x, out.z);
    if (mag < 1e-6) return false;
    const grid = this.getGrid();
    const sx = self.pos.x;
    const sz = self.pos.z;
    if (rimAt(grid, sx, sz) >= RIM_FAR) return false;
    const feet = self.pos.y;
    const hx = out.x / mag;
    const hz = out.z / mag;
    const speed = Math.hypot(self.vel.x, self.vel.z);
    const reach = Math.min(3.4, 1.2 + 0.25 * speed);
    if (this.clear(feet, sx, sz, hx, hz, reach)) return false;

    // an edge ahead: a Cub / Fighter occasionally does not notice it
    if (now < this.blunderUntil) return false;
    if (now - this.lastDeflectAt > 0.6 && this.level.blunderChance > 0 && this.rng() < this.level.blunderChance) {
      this.blunderUntil = now + this.level.blunderS;
      this.lastDeflectAt = now;
      return false;
    }
    this.lastDeflectAt = now;

    for (let k = 0; k < OFFSETS.length; k++) {
      for (let q = 0; q < 2; q++) {
        const sign = q === 0 ? this.side : (-this.side as 1 | -1);
        const a = OFFSETS[k] * sign;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const rx = hx * ca - hz * sa;
        const rz = hx * sa + hz * ca;
        if (this.clear(feet, sx, sz, rx, rz, reach)) {
          this.side = sign;
          out.x = rx * mag;
          out.z = rz * mag;
          this.deflected = true;
          return true;
        }
      }
    }
    // boxed in on every side (cannot happen on a platform wider than the look-ahead): stand still
    out.x = 0;
    out.z = 0;
    this.deflected = true;
    return true;
  }
}
