/**
 * SerpentSense (v1.9 WP-O2, docs/OCEAN-PLAN.md): how a bot sees and dodges the Ocean Dome's sea-serpent strike.
 *
 * A bot only knows what a human player sees: the public warning (`WorldSnapshot.serpent`, the glowing strip on the floor and the
 * HUD banner). It does not react to it at once: per event it draws a REACTION DELAY from its level's distribution
 * ({@link SERPENT_AI}: the profile's reaction time plus a decision lag, with a spread), a chance of not noticing at all (busy fighting
 * / panicking), a chance of picking the wrong way out, and - for the sloppier levels - it does not check that its way out is
 * walkable. Then it leaves the strip by the SHORTEST walkable route (the exit direction is chosen among 24 headings by the distance
 * to clear the capsule and a walkability test over cliffs, ramps and solids; ledges may be dropped off), attacks, blocks and ability
 * starts are cancelled for the duration, and (Veteran / Apex) it never steps back into the strip while the strike is live.
 *
 * The numbers are tuned (tests/ai/serpent.dodge.test.ts, docs/BALANCE.md "v1.9 ocean") so that standing bots dodge: Apex >= 90 %,
 * Veteran >= 75 %, Fighter >= 50 %, Cub 25-40 %. The sim's serpent numbers are never touched.
 *
 * Inactive (every method returns immediately) on arenas without `hazards.serpent`, which keeps the colosseum and the jungle
 * byte-identical.
 */

import type { Difficulty, FighterState, SerpentState } from '../core/types';
import type { ArenaDef } from '../config/arenas';
import { ANIMALS } from '../config/animals';
import { SERPENT } from '../config/serpent';
import type { Rng } from '../core/math';
import { LINE_BLOCKED, getNavGrid, lineWalk, type NavGrid } from './NavGrid';
import { setDir, type Move2 } from './Steering';

export interface SerpentAiLevel {
  /** Decision lag (ms) added to the profile's reaction time (`BotProfile.reactionMs`). */
  extraMs: number;
  /** Standard deviation (ms) of the reaction delay. */
  sdMs: number;
  /** The shortest reaction delay (ms). */
  minMs: number;
  /** Probability the bot never reacts to this event (looking elsewhere / mid-fight tunnel vision). */
  missChance: number;
  /** Probability it runs the wrong way (towards the far side of the strip). */
  wrongWayChance: number;
  /** Tests the exit for cliffs and solids; otherwise it simply steps off perpendicular to the line. */
  smartExit: boolean;
  /** After noticing, never walks (back) into the strip while the strike is live. */
  avoidStrip: boolean;
  /** Extra delay (ms) when it is mid-swing or blocking at the moment the warning appears. */
  busyMs: number;
}

/**
 * Tuned by `scripts/serpent-dodge.ts` (1000 isolated trials per level, a random spot in the strip): Cub 34 %, Fighter 60 %, Veteran
 * 84 %, Apex 94 % (N = 200 per animal; targets: 25-40 / >= 50 / >= 75 / >= 90). Mean reaction delays (profile reaction + decision lag): about 850 / 600 /
 * 400 / 170 ms; the head needs 1.1 s from the warning to reach the rim, so even a Fighter that reacts on time often fails to clear
 * the strip when it also runs the wrong way or has to cross a cliff.
 */
export const SERPENT_AI: Record<Difficulty, SerpentAiLevel> = {
  1: { extraMs: 250, sdMs: 300, minMs: 300, missChance: 0.3, wrongWayChance: 0.25, smartExit: false, avoidStrip: false, busyMs: 250 },
  2: { extraMs: 200, sdMs: 200, minMs: 250, missChance: 0.2, wrongWayChance: 0.2, smartExit: false, avoidStrip: false, busyMs: 150 },
  3: { extraMs: 150, sdMs: 120, minMs: 180, missChance: 0.1, wrongWayChance: 0.08, smartExit: true, avoidStrip: true, busyMs: 80 },
  4: { extraMs: 20, sdMs: 60, minMs: 100, missChance: 0.04, wrongWayChance: 0.02, smartExit: true, avoidStrip: true, busyMs: 40 },
};

/** Seconds a computed exit stays unchanged before it is re-evaluated. */
const REPLAN_S = 0.2;
/** Metres beyond the hit radius a dodging body aims to end up (the strip's edge is exact in the sim). */
const CLEAR_MARGIN = 0.35;
/** Candidate exit headings. */
const HEADINGS = 24;
/** A new heading must beat the current one by this many metres to replace it (no dithering). */
const KEEP_BONUS_M = 0.4;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Distance from (px, pz) to the strike line's segment from the centre to the wall along unit (ux, uz). */
export function stripDistance(px: number, pz: number, ux: number, uz: number, len: number): number {
  const t = clamp(px * ux + pz * uz, 0, len);
  return Math.hypot(px - ux * t, pz - uz * t);
}

/** Seconds into the whole event at which `phase` begins. */
function phaseOffset(phase: SerpentState['phase']): number {
  switch (phase) {
    case 'warn':
      return 0;
    case 'strike':
      return SERPENT.warnS;
    case 'hold':
      return SERPENT.warnS + SERPENT.strikeS;
    default:
      return SERPENT.warnS + SERPENT.strikeS + SERPENT.holdS;
  }
}

/** A standard normal draw from `rng` (Box-Muller; consumes two numbers). */
function gauss(rng: Rng): number {
  const u = Math.max(1e-9, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class SerpentSense {
  /** False when the arena has no serpent: every method is a no-op. */
  readonly active: boolean;
  level: SerpentAiLevel;
  /** True on the tick the bot is steering out of the strip (set by {@link update}). */
  dodging = false;

  private readonly arena: ArenaDef;
  private readonly radius: number;
  private readonly speed: number;
  private grid: NavGrid | null = null;

  // Per-event state (reset when the snapshot has no serpent block).
  private evStart = Number.NaN;
  private noticeAt = Infinity;
  private missed = false;
  private wrongWay = false;
  private angleDeg = 0;
  private ux = 1;
  private uz = 0;
  private phase: SerpentState['phase'] | null = null;
  private planAt = -1e9;
  private dirX = 0;
  private dirZ = 0;
  private dirCost = Infinity;
  private readonly cand = { x: 0, z: 0, cost: 0 };

  constructor(arena: ArenaDef, animal: keyof typeof ANIMALS, difficulty: Difficulty) {
    this.arena = arena;
    this.radius = ANIMALS[animal].radius;
    this.speed = ANIMALS[animal].speed;
    this.active = arena.hazards?.serpent === true;
    this.level = SERPENT_AI[difficulty];
  }

  setDifficulty(d: Difficulty): void {
    this.level = SERPENT_AI[d];
  }

  /** The reaction delay (s after the warning begins) this bot drew for the current event (Infinity = never). Exposed for tests. */
  get reactAfterS(): number {
    return this.missed ? Infinity : this.noticeAt - this.evStart;
  }

  /** Has the bot noticed the running event (its reaction delay has elapsed)? */
  noticed(now: number): boolean {
    return this.phase !== null && !this.missed && now >= this.noticeAt;
  }

  private getGrid(): NavGrid | null {
    if (this.arena.heightfield === undefined) return null;
    if (this.grid === null) this.grid = getNavGrid(this.arena, this.radius, 0);
    return this.grid;
  }

  /**
   * Per-tick update. Returns true (and fills `out` with the unit heading) while the bot should steer out of the strip, false when its
   * normal behaviour may carry on. `now` = manager time, `reactionMs` = the profile's reaction time, `busy` = mid-swing / blocking.
   */
  update(now: number, self: FighterState, ser: SerpentState | undefined, reactionMs: number, busy: boolean, rng: Rng, out: Move2): boolean {
    this.dodging = false;
    if (!this.active) return false;
    if (ser === undefined) {
      if (this.phase !== null) this.reset();
      return false;
    }
    this.phase = ser.phase;
    if (Number.isNaN(this.evStart) || Math.abs(ser.angleDeg - this.angleDeg) > 1e-6) this.beginEvent(now, ser, reactionMs, busy, rng);
    if (this.missed || now < this.noticeAt) return false;
    if (ser.phase !== 'warn' && ser.phase !== 'strike') return false; // hold / retreat: harmless
    // Airborne above the strike (a soaring eagle): untouchable, nothing to dodge.
    const alt = self.pos.y - this.groundAt(self.pos.x, self.pos.z);
    if (alt > SERPENT.hazardHeight + 0.3) return false;

    const px = self.pos.x;
    const pz = self.pos.z;
    const len = this.arena.wallRadius;
    const need = SERPENT.headRadius + this.radius;
    if (stripDistance(px, pz, this.ux, this.uz, len) >= need + CLEAR_MARGIN) return false; // already clear
    // In the strip (or too close to its edge): steer out.
    if (now - this.planAt >= REPLAN_S || this.dirCost === Infinity) this.plan(now, px, pz, rng);
    out.x = this.dirX;
    out.z = this.dirZ;
    this.dodging = true;
    return true;
  }

  /**
   * For Veteran / Apex: once the strike is noticed, remove the component of `move` that would carry the body into the strip.
   * No-op for the lower levels, while no event runs, and for a bot that is not yet clear (the dodge steers it out).
   */
  repel(move: Move2, now: number, sx: number, sz: number): void {
    if (!this.active || !this.level.avoidStrip || this.dodging || !this.noticed(now)) return;
    if (this.phase !== 'warn' && this.phase !== 'strike') return;
    if (move.x === 0 && move.z === 0) return;
    const len = this.arena.wallRadius;
    const need = SERPENT.headRadius + this.radius + 0.1;
    // Where would 0.8 s of this heading take the body?
    const ahead = this.speed * 0.2;
    const fx = sx + move.x * ahead;
    const fz = sz + move.z * ahead;
    if (stripDistance(fx, fz, this.ux, this.uz, len) >= need) return;
    // Outward normal of the capsule at the future point.
    const t = clamp(fx * this.ux + fz * this.uz, 0, len);
    let nx = fx - this.ux * t;
    let nz = fz - this.uz * t;
    const nl = Math.hypot(nx, nz);
    if (nl < 1e-6) {
      nx = -this.uz;
      nz = this.ux;
    } else {
      nx /= nl;
      nz /= nl;
    }
    const inward = -(move.x * nx + move.z * nz);
    if (inward <= 0) return;
    move.x += nx * inward;
    move.z += nz * inward;
    const m = Math.hypot(move.x, move.z);
    if (m < 0.25) {
      move.x = 0;
      move.z = 0;
    } else {
      move.x /= m;
      move.z /= m;
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private reset(): void {
    this.evStart = Number.NaN;
    this.noticeAt = Infinity;
    this.missed = false;
    this.phase = null;
    this.dirCost = Infinity;
    this.planAt = -1e9;
  }

  private groundAt(x: number, z: number): number {
    const hf = this.arena.heightfield;
    if (hf === undefined) return 0;
    const g = this.getGrid();
    if (g === null) return 0;
    const ix = Math.floor((x - g.origin) / g.cell);
    const iz = Math.floor((z - g.origin) / g.cell);
    if (ix < 0 || iz < 0 || ix >= g.n || iz >= g.n) return 0;
    return g.h[iz * g.n + ix];
  }

  private beginEvent(now: number, ser: SerpentState, reactionMs: number, busy: boolean, rng: Rng): void {
    const lv = this.level;
    this.angleDeg = ser.angleDeg;
    const a = (ser.angleDeg * Math.PI) / 180;
    this.ux = Math.cos(a);
    this.uz = Math.sin(a);
    this.evStart = now - ser.t - phaseOffset(ser.phase);
    let d = reactionMs + lv.extraMs + lv.sdMs * gauss(rng);
    if (busy) d += lv.busyMs;
    d = Math.max(lv.minMs, d);
    this.noticeAt = this.evStart + d / 1000;
    this.missed = rng() < lv.missChance;
    this.wrongWay = rng() < lv.wrongWayChance;
    this.dirCost = Infinity;
    this.planAt = -1e9;
  }

  /** Distance along (dx, dz) from (px, pz) until the body is clear of the strip, or Infinity within 12 m. */
  private exitDistance(px: number, pz: number, dx: number, dz: number, clearR: number): number {
    const len = this.arena.wallRadius;
    for (let t = 0; t <= 12; t += 0.1) {
      if (stripDistance(px + dx * t, pz + dz * t, this.ux, this.uz, len) >= clearR) return t;
    }
    return Infinity;
  }

  private plan(now: number, px: number, pz: number, rng: Rng): void {
    this.planAt = now;
    const lv = this.level;
    const clearR = SERPENT.headRadius + this.radius + CLEAR_MARGIN;
    const grid = this.getGrid();
    let bx = 0;
    let bz = 0;
    let bc = Infinity;

    if (!lv.smartExit) {
      // Step off perpendicular to the line, on the nearer side (the far side when it picks the wrong way).
      const lat = px * -this.uz + pz * this.ux; // signed lateral offset
      let side = lat >= 0 ? 1 : -1;
      if (Math.abs(lat) < 0.05) side = rng() < 0.5 ? 1 : -1;
      if (this.wrongWay) side = -side;
      bx = -this.uz * side;
      bz = this.ux * side;
      bc = 1;
    } else {
      for (let k = 0; k < HEADINGS; k++) {
        const ang = (k / HEADINGS) * Math.PI * 2;
        const dx = Math.cos(ang);
        const dz = Math.sin(ang);
        const t = this.exitDistance(px, pz, dx, dz, clearR);
        if (!Number.isFinite(t)) continue;
        let cost = t;
        if (grid !== null) {
          const ex = px + dx * t;
          const ez = pz + dz * t;
          if (lineWalk(grid, px, pz, ex, ez, true, true) === LINE_BLOCKED) cost += 20; // blocked: a last resort
        }
        // a slight bias to keep the previous heading (no dithering between two equal sides)
        if (this.dirCost !== Infinity && dx * this.dirX + dz * this.dirZ > 0.9) cost -= KEEP_BONUS_M;
        if (cost < bc) {
          bc = cost;
          bx = dx;
          bz = dz;
        }
      }
      if (this.wrongWay && bc < Infinity) {
        // run the other way round: the mirror image across the line
        const dot = bx * this.ux + bz * this.uz;
        const px2 = this.ux * dot;
        const pz2 = this.uz * dot;
        const nbx = 2 * px2 - bx;
        const nbz = 2 * pz2 - bz;
        bx = nbx;
        bz = nbz;
      }
    }
    if (bc === Infinity) {
      // nowhere better: run perpendicular
      bx = -this.uz;
      bz = this.ux;
      bc = 1;
    }
    this.cand.x = bx;
    this.cand.z = bz;
    this.cand.cost = bc;
    const m = Math.hypot(bx, bz) || 1;
    this.dirX = bx / m;
    this.dirZ = bz / m;
    this.dirCost = bc;
    setDir(this.cand, this.dirX, this.dirZ);
  }
}
