/**
 * SerpentSense (v1.9 WP-O2, docs/OCEAN-PLAN.md; v1.10 WP-H3, docs/OCEAN-HEIGHTS-PLAN.md): how a bot sees and dodges the Ocean Dome's
 * sea-serpent strikes.
 *
 * A bot only knows what a human player sees: the public warnings (`WorldSnapshot.serpent`, the LOW serpent, and
 * `WorldSnapshot.serpentHigh`, the HIGH one: the glowing strips on the floor and the HUD banners). It does not react to one at once:
 * per event it draws a REACTION DELAY from its level's distribution ({@link SERPENT_AI}: the profile's reaction time plus a decision
 * lag, with a spread), a chance of not noticing at all (busy fighting / panicking), a chance of picking the wrong way out, and - for
 * the sloppier levels - it does not check that its way out is walkable. Then it leaves the strip by the SHORTEST walkable route,
 * attacks, blocks and ability starts are cancelled for the duration, and (Veteran / Apex) it never steps back into a strip while
 * the strike is live.
 *
 * v1.10, two lanes: a serpent only hurts fighters whose BAND (`arenaSerpentBand`: by the ground height under them, low or high)
 * is its own. So a bot reacts to the lane of the band it STANDS in, and watches the other lane too: its way out never crosses into the
 * other lane's live strip, and (Veteran / Apex) it does not walk up or down into a live strip of either lane (`repel`).
 *
 * On low, open ground the exit is the v1.9.1 one (24 straight headings scored by the distance to clear the capsule and a walkability
 * test over cliffs and solids; ledges up to 1.9 m may be dropped off), so the tuned dodge rates are unchanged. Near a DEADLY edge (a
 * tower top or the side of a tower ramp: a drop of 3.0 m or more costs 50 HP of fall damage) the exit is a Dijkstra over the nav grid
 * to the nearest cell that is safe from every live strip, which never steps off the rim: along the platform when it can, down the ramp
 * otherwise. A tower top is small: when no safe cell can be reached before the head arrives and the bot is healthy (a Veteran / Apex
 * at 60 % health or more) it takes the 50-HP fall deliberately - 50 true damage instead of 300 - by the shortest way off the platform.
 * Cub / Fighter only sometimes check ({@link SerpentAiLevel.fallAware}); otherwise they step off perpendicular and may fall.
 *
 * The numbers are tuned (tests/ai/serpent.dodge.test.ts, docs/BALANCE.md "v1.9 ocean" and "v1.10 heights") so that standing bots dodge:
 * Apex >= 90 %, Veteran >= 75 %, Fighter >= 50 %, Cub 25-40 %. The sim's serpent numbers are never touched.
 *
 * Inactive (every method returns immediately) on arenas without `hazards.serpent`, which keeps the colosseum and the jungle
 * byte-identical.
 */

import type { Difficulty, FighterState, SerpentState, SerpentTier } from '../core/types';
import { arenaGroundHeight, arenaSerpentBand, ARENA_STEP_UP, type ArenaDef } from '../config/arenas';
import { ANIMALS } from '../config/animals';
import { SERPENT } from '../config/serpent';
import type { Rng } from '../core/math';
import { LINE_BLOCKED, NavSearch, RIM_FAR, cellOf, cellX, cellZ, getNavGrid, lineWalk, nearestWalkCell, rimAt, type NavGrid } from './NavGrid';
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
  /** v1.10: probability (per event) that a bot WITHOUT `smartExit` still checks that its way out does not drop off a tower rim. */
  fallAware: number;
  /** v1.10: may take the 50-HP fall on purpose when no safe cell is reachable in time (needs {@link DIVE_MIN_HP} of its health). */
  dive: boolean;
}

/**
 * Tuned by `scripts/serpent-dodge.ts` (1000 isolated trials per level, a random spot in the strip): Cub 34 %, Fighter 60 %, Veteran
 * 84 %, Apex 94 % (N = 200 per animal; targets: 25-40 / >= 50 / >= 75 / >= 90). Mean reaction delays (profile reaction + decision lag): about 850 / 600 /
 * 400 / 170 ms; the head needs 1.1 s from the warning to reach the rim, so even a Fighter that reacts on time often fails to clear
 * the strip when it also runs the wrong way or has to cross a cliff.
 */
export const SERPENT_AI: Record<Difficulty, SerpentAiLevel> = {
  1: { extraMs: 250, sdMs: 300, minMs: 300, missChance: 0.3, wrongWayChance: 0.25, smartExit: false, avoidStrip: false, busyMs: 250, fallAware: 0.5, dive: false },
  2: { extraMs: 200, sdMs: 200, minMs: 250, missChance: 0.2, wrongWayChance: 0.2, smartExit: false, avoidStrip: false, busyMs: 150, fallAware: 0.85, dive: false },
  3: { extraMs: 150, sdMs: 120, minMs: 180, missChance: 0.1, wrongWayChance: 0.08, smartExit: true, avoidStrip: true, busyMs: 80, fallAware: 1, dive: true },
  4: { extraMs: 20, sdMs: 60, minMs: 100, missChance: 0.04, wrongWayChance: 0.02, smartExit: true, avoidStrip: true, busyMs: 40, fallAware: 1, dive: true },
};

/** Seconds a computed exit stays unchanged before it is re-evaluated. */
const REPLAN_S = 0.2;
/** Metres beyond the hit radius a dodging body aims to end up (the strip's edge is exact in the sim). */
const CLEAR_MARGIN = 0.35;
/** Candidate exit headings. */
const HEADINGS = 24;
/** A new heading must beat the current one by this many metres to replace it (no dithering). */
const KEEP_BONUS_M = 0.4;
/** Extra cost (m) of a legacy exit that runs through the other lane's live strip. */
const CROSS_LANE_COST = 25;
/** Standing within this many metres of a deadly edge (`NavGrid.rimD`) switches the exit to the fall-safe grid planner. */
const GRID_PLAN_RIM_M = RIM_FAR;
/** Largest total cost (path metres + penalties) the grid planner searches. */
const GRID_MAX_COST = 24;
/** Extra cost of a grid cell inside a live strip the bot is NOT yet in (never cross into the other lane's strip). */
const GRID_CROSS_COST = 14;
/** A Veteran / Apex takes the deliberate fall only with at least this fraction of its health ("never below 60 %"). */
export const DIVE_MIN_HP = 0.6;
/** Seconds of slack kept between the bot's arrival and the head's. */
const TIME_SLACK_S = 0.08;

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

/** What the bot knows about one serpent's running event. */
class LaneView {
  evStart = Number.NaN;
  noticeAt = Infinity;
  missed = false;
  wrongWay = false;
  angleDeg = 0;
  ux = 1;
  uz = 0;
  phase: SerpentState['phase'] | null = null;

  constructor(readonly tier: SerpentTier) {}

  /** The bot has noticed this event and it can still hurt (warn / strike). */
  live(now: number): boolean {
    return this.phase !== null && !this.missed && now >= this.noticeAt && (this.phase === 'warn' || this.phase === 'strike');
  }

  forget(): void {
    this.evStart = Number.NaN;
    this.noticeAt = Infinity;
    this.missed = false;
    this.phase = null;
  }
}

export class SerpentSense {
  /** False when the arena has no serpent: every method is a no-op. */
  readonly active: boolean;
  level: SerpentAiLevel;
  /** True on the tick the bot is steering out of a strip (set by {@link update}). */
  dodging = false;
  /** True on a tick the dodge is the deliberate 50-HP fall off a platform (the brain's fall guard stands aside). */
  diving = false;

  private readonly arena: ArenaDef;
  private readonly radius: number;
  private readonly speed: number;
  private readonly split: number;
  private grid: NavGrid | null = null;
  private search: NavSearch | null = null;

  // Per-event state (reset when the snapshot has no serpent block).
  private readonly low = new LaneView('low');
  private readonly high = new LaneView('high');
  private readonly lanes: readonly LaneView[] = [this.low, this.high];
  private planAt = -1e9;
  private dirX = 0;
  private dirZ = 0;
  private dirCost = Infinity;
  private diveWanted = false;
  /** Once a dive is chosen for an event the bot keeps to it (no dithering between the dive and the walk-out). */
  private diveLocked = false;
  /** Lazily drawn per event (only when the bot stands near a deadly edge): the roll for {@link SerpentAiLevel.fallAware}. */
  private awareRoll = -1;
  private readonly cand = { x: 0, z: 0, cost: 0 };

  constructor(arena: ArenaDef, animal: keyof typeof ANIMALS, difficulty: Difficulty) {
    this.arena = arena;
    this.radius = ANIMALS[animal].radius;
    this.speed = ANIMALS[animal].speed;
    this.active = arena.hazards?.serpent === true;
    this.split = arena.hazards?.serpentSplitY ?? Infinity;
    this.level = SERPENT_AI[difficulty];
  }

  setDifficulty(d: Difficulty): void {
    this.level = SERPENT_AI[d];
  }

  /** The reaction delay (s after the warning begins) this bot drew for the current LOW event, else the HIGH one (Infinity = never). Exposed for tests. */
  get reactAfterS(): number {
    const l = this.low.phase !== null || this.high.phase === null ? this.low : this.high;
    return l.missed ? Infinity : l.noticeAt - l.evStart;
  }

  /** The reaction delay drawn for one lane's current event (Infinity = never noticed; NaN when it has no event). */
  reactionOf(tier: SerpentTier): number {
    const l = tier === 'high' ? this.high : this.low;
    if (l.phase === null) return Number.NaN;
    return l.missed ? Infinity : l.noticeAt - l.evStart;
  }

  /** Has the bot noticed a running event (its reaction delay has elapsed)? */
  noticed(now: number): boolean {
    for (const l of this.lanes) if (l.phase !== null && !l.missed && now >= l.noticeAt) return true;
    return false;
  }

  private getGrid(): NavGrid | null {
    if (this.arena.heightfield === undefined) return null;
    if (this.grid === null) this.grid = getNavGrid(this.arena, this.radius, 0);
    return this.grid;
  }

  /**
   * Per-tick update. Returns true (and fills `out` with the unit heading) while the bot should steer out of a strip, false when its
   * normal behaviour may carry on. `now` = manager time, `reactionMs` = the profile's reaction time, `busy` = mid-swing / blocking.
   * `ser` = `snapshot.serpent` (the LOW serpent), `serHigh` = `snapshot.serpentHigh`.
   */
  update(
    now: number,
    self: FighterState,
    ser: SerpentState | undefined,
    reactionMs: number,
    busy: boolean,
    rng: Rng,
    out: Move2,
    serHigh?: SerpentState,
  ): boolean {
    this.dodging = false;
    this.diving = false;
    if (!this.active) return false;
    this.feed(this.low, ser, now, reactionMs, busy, rng);
    this.feed(this.high, serHigh, now, reactionMs, busy, rng);
    if (this.low.phase === null && this.high.phase === null) {
      this.planAt = -1e9;
      this.dirCost = Infinity;
      return false;
    }
    // Airborne above the strike (a soaring eagle): untouchable, nothing to dodge.
    const alt = self.pos.y - this.groundAt(self.pos.x, self.pos.z);
    if (alt > SERPENT.hazardHeight + 0.3) return false;

    const px = self.pos.x;
    const pz = self.pos.z;
    const len = this.arena.wallRadius;
    const need = SERPENT.headRadius + this.radius;
    const band = arenaSerpentBand(this.arena, px, pz);
    let endangered = false;
    for (const l of this.lanes) {
      if (l.live(now) && l.tier === band && stripDistance(px, pz, l.ux, l.uz, len) < need + CLEAR_MARGIN) endangered = true;
    }
    if (!endangered) return false; // already clear (or standing in the other band)
    // In a strip (or too close to its edge): steer out.
    if (now - this.planAt >= REPLAN_S || this.dirCost === Infinity) this.plan(now, self, px, pz, band, rng);
    out.x = this.dirX;
    out.z = this.dirZ;
    this.dodging = true;
    this.diving = this.diveWanted;
    return true;
  }

  /**
   * For Veteran / Apex: once a strike is noticed, remove the component of `move` that would carry the body into a live strip of the
   * band it would stand in (either lane). No-op for the lower levels, while no event runs, and for a bot that is not yet clear (the
   * dodge steers it out).
   */
  repel(move: Move2, now: number, sx: number, sz: number): void {
    if (!this.active || !this.level.avoidStrip || this.dodging) return;
    if (move.x === 0 && move.z === 0) return;
    const len = this.arena.wallRadius;
    const need = SERPENT.headRadius + this.radius + 0.1;
    // Where would 0.2 s of this heading take the body?
    const ahead = this.speed * 0.2;
    for (const l of this.lanes) {
      if (!l.live(now)) continue;
      const fx = sx + move.x * ahead;
      const fz = sz + move.z * ahead;
      if (stripDistance(fx, fz, l.ux, l.uz, len) >= need) continue;
      if (this.split !== Infinity) {
        if (arenaSerpentBand(this.arena, fx, fz) !== l.tier) continue; // that band is not this serpent's
        if (arenaSerpentBand(this.arena, sx, sz) !== l.tier) {
          // about to walk (up or down a ramp) INTO this serpent's band inside its live strip: hold at the foot until the strike is over
          move.x = 0;
          move.z = 0;
          return;
        }
      }
      // Outward normal of the capsule at the future point.
      const t = clamp(fx * l.ux + fz * l.uz, 0, len);
      let nx = fx - l.ux * t;
      let nz = fz - l.uz * t;
      const nl = Math.hypot(nx, nz);
      if (nl < 1e-6) {
        nx = -l.uz;
        nz = l.ux;
      } else {
        nx /= nl;
        nz /= nl;
      }
      const inward = -(move.x * nx + move.z * nz);
      if (inward <= 0) continue;
      move.x += nx * inward;
      move.z += nz * inward;
      const m = Math.hypot(move.x, move.z);
      if (m < 0.25) {
        move.x = 0;
        move.z = 0;
        return;
      }
      move.x /= m;
      move.z /= m;
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Track one lane's public state: start a new event view, or forget it when the serpent is gone. */
  private feed(l: LaneView, ser: SerpentState | undefined, now: number, reactionMs: number, busy: boolean, rng: Rng): void {
    if (ser === undefined) {
      if (l.phase !== null) {
        l.forget();
        this.dirCost = Infinity;
        this.planAt = -1e9;
        this.awareRoll = -1;
        this.diveLocked = false;
        this.diveWanted = false;
      }
      return;
    }
    l.phase = ser.phase;
    if (Number.isNaN(l.evStart) || Math.abs(ser.angleDeg - l.angleDeg) > 1e-6) this.beginEvent(l, now, ser, reactionMs, busy, rng);
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

  private beginEvent(l: LaneView, now: number, ser: SerpentState, reactionMs: number, busy: boolean, rng: Rng): void {
    const lv = this.level;
    l.angleDeg = ser.angleDeg;
    const a = (ser.angleDeg * Math.PI) / 180;
    l.ux = Math.cos(a);
    l.uz = Math.sin(a);
    l.evStart = now - ser.t - phaseOffset(ser.phase);
    let d = reactionMs + lv.extraMs + lv.sdMs * gauss(rng);
    if (busy) d += lv.busyMs;
    d = Math.max(lv.minMs, d);
    l.noticeAt = l.evStart + d / 1000;
    l.missed = rng() < lv.missChance;
    l.wrongWay = rng() < lv.wrongWayChance;
    this.dirCost = Infinity;
    this.planAt = -1e9;
    this.awareRoll = -1;
    this.diveLocked = false;
    this.diveWanted = false;
  }

  /** Distance along (dx, dz) from (px, pz) until the body is clear of the strip, or Infinity within 12 m. */
  private exitDistance(l: LaneView, px: number, pz: number, dx: number, dz: number, clearR: number): number {
    const len = this.arena.wallRadius;
    for (let t = 0; t <= 12; t += 0.1) {
      if (stripDistance(px + dx * t, pz + dz * t, l.ux, l.uz, len) >= clearR) return t;
    }
    return Infinity;
  }

  /** Is the point inside lane `l`'s strike strip AND in its band (the places that serpent hurts)? */
  private unsafe(l: LaneView, x: number, z: number, clearR: number): boolean {
    return arenaSerpentBand(this.arena, x, z) === l.tier && stripDistance(x, z, l.ux, l.uz, this.arena.wallRadius) < clearR;
  }

  /** Should a bot without `smartExit` still check its way out for a deadly drop? (one lazy roll per event) */
  private fallAware(rng: Rng): boolean {
    if (this.level.smartExit) return true;
    if (this.awareRoll < 0) this.awareRoll = rng();
    return this.awareRoll < this.level.fallAware;
  }

  private plan(now: number, self: FighterState, px: number, pz: number, band: SerpentTier, rng: Rng): void {
    this.planAt = now;
    this.diveWanted = false;
    const grid = this.getGrid();
    if (grid !== null && grid.deadly < Infinity) {
      if (rimAt(grid, px, pz) < GRID_PLAN_RIM_M && this.fallAware(rng) && this.gridPlan(now, self, px, pz, grid)) return;
    }
    this.legacyPlan(now, px, pz, band, rng);
  }

  /** The v1.9.1 exit: the best of 24 straight headings (or the perpendicular step of the sloppy levels). */
  private legacyPlan(now: number, px: number, pz: number, band: SerpentTier, rng: Rng): void {
    const lv = this.level;
    const clearR = SERPENT.headRadius + this.radius + CLEAR_MARGIN;
    const grid = this.getGrid();
    // the strips this bot is in danger of (its band) and the other lane's live strip it must not run into
    const danger: LaneView[] = [];
    const watch: LaneView[] = [];
    const len = this.arena.wallRadius;
    for (const l of this.lanes) {
      if (!l.live(now)) continue;
      if (l.tier === band && stripDistance(px, pz, l.ux, l.uz, len) < clearR) danger.push(l);
      else watch.push(l);
    }
    const main = danger.length > 0 ? danger[0] : this.low.phase !== null ? this.low : this.high;
    let bx = 0;
    let bz = 0;
    let bc = Infinity;

    if (!lv.smartExit) {
      // Step off perpendicular to the line, on the nearer side (the far side when it picks the wrong way).
      const lat = px * -main.uz + pz * main.ux; // signed lateral offset
      let side = lat >= 0 ? 1 : -1;
      if (Math.abs(lat) < 0.05) side = rng() < 0.5 ? 1 : -1;
      if (main.wrongWay) side = -side;
      bx = -main.uz * side;
      bz = main.ux * side;
      bc = 1;
    } else {
      for (let k = 0; k < HEADINGS; k++) {
        const ang = (k / HEADINGS) * Math.PI * 2;
        const dx = Math.cos(ang);
        const dz = Math.sin(ang);
        // the way out must clear every strip the bot is in
        let t = 0;
        for (const l of danger) t = Math.max(t, this.exitDistance(l, px, pz, dx, dz, clearR));
        if (danger.length === 0) t = this.exitDistance(main, px, pz, dx, dz, clearR);
        if (!Number.isFinite(t)) continue;
        let cost = t;
        if (grid !== null) {
          const ex = px + dx * t;
          const ez = pz + dz * t;
          if (lineWalk(grid, px, pz, ex, ez, true, true) === LINE_BLOCKED) cost += 20; // blocked: a last resort
        }
        // never run into the other lane's live strip
        if (watch.length > 0 && this.crossesWatch(watch, px, pz, dx, dz, t, clearR)) cost += CROSS_LANE_COST;
        // a slight bias to keep the previous heading (no dithering between two equal sides)
        if (this.dirCost !== Infinity && dx * this.dirX + dz * this.dirZ > 0.9) cost -= KEEP_BONUS_M;
        if (cost < bc) {
          bc = cost;
          bx = dx;
          bz = dz;
        }
      }
      if (main.wrongWay && bc < Infinity) {
        // run the other way round: the mirror image across the line
        const dot = bx * main.ux + bz * main.uz;
        const px2 = main.ux * dot;
        const pz2 = main.uz * dot;
        const nbx = 2 * px2 - bx;
        const nbz = 2 * pz2 - bz;
        bx = nbx;
        bz = nbz;
      }
    }
    if (bc === Infinity) {
      // nowhere better: run perpendicular
      bx = -main.uz;
      bz = main.ux;
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

  /** Does the straight exit (dx, dz) for `t` metres pass through a live strip (in that strip's band) of a lane the bot is not in? */
  private crossesWatch(watch: readonly LaneView[], px: number, pz: number, dx: number, dz: number, t: number, clearR: number): boolean {
    const need = clearR - CLEAR_MARGIN;
    for (let u = 0.5; u <= t + 1e-9; u += 0.5) {
      for (const l of watch) if (this.unsafe(l, px + dx * u, pz + dz * u, need)) return true;
    }
    return false;
  }

  /**
   * The fall-safe exit near a deadly edge: Dijkstra over the nav grid (walk edges and ledge drops under 1.9 m, never a deadly drop) to
   * the nearest cell that is safe from EVERY live strip, entering a live strip of the lane the bot is not in costs extra. When no such
   * cell is reachable before the head arrives, a healthy Veteran / Apex dives off the platform instead (50 HP, not 300). Returns false
   * when it found nothing at all (the caller falls back to the legacy exit).
   */
  private gridPlan(now: number, self: FighterState, px: number, pz: number, grid: NavGrid): boolean {
    const len = this.arena.wallRadius;
    const clearR = SERPENT.headRadius + this.radius + CLEAR_MARGIN;
    const danger: LaneView[] = [];
    const watch: LaneView[] = [];
    const band = arenaSerpentBand(this.arena, px, pz);
    for (const l of this.lanes) {
      if (!l.live(now)) continue;
      if (l.tier === band && stripDistance(px, pz, l.ux, l.uz, len) < clearR) danger.push(l);
      else watch.push(l);
    }
    if (danger.length === 0) return false;
    if (this.search === null) this.search = new NavSearch(grid.n * grid.n);
    const search = this.search;
    const s = nearestWalkCell(grid, px, pz, 3);
    if (s < 0) return false;
    const split = this.split;
    const cellUnsafe = (l: LaneView, c: number): boolean => {
      const tier: SerpentTier = grid.h[c] >= split ? 'high' : 'low';
      return tier === l.tier && stripDistance(cellX(grid, c), cellZ(grid, c), l.ux, l.uz, len) < clearR;
    };
    const safeAll = (c: number): boolean => {
      for (const l of danger) if (cellUnsafe(l, c)) return false;
      for (const l of watch) if (cellUnsafe(l, c)) return false;
      return true;
    };
    const extra = (c: number): number => {
      for (const l of watch) if (cellUnsafe(l, c)) return GRID_CROSS_COST;
      return 0;
    };
    let goal = search.findNearest(grid, s, GRID_MAX_COST, safeAll, extra, true);
    // the sloppy "wrong way": the nearest safe cell on the far side of the (first) line
    const first = danger[0];
    if (goal >= 0 && first.wrongWay) {
      const sideOf = (c: number): number => (-first.uz * cellX(grid, c) + first.ux * cellZ(grid, c) >= 0 ? 1 : -1);
      const want = -sideOf(goal);
      const alt = search.findNearest(grid, s, GRID_MAX_COST, (c) => safeAll(c) && sideOf(c) === want, extra, true);
      if (alt >= 0) goal = alt;
    }
    // can the bot make it before the head? (the head reaches its spot at warnS + strikeS * (1 - along / R) after the warning)
    let budget = Infinity;
    for (const l of danger) {
      const along = clamp(px * l.ux + pz * l.uz, 0, len);
      budget = Math.min(budget, l.evStart + SERPENT.warnS + SERPENT.strikeS * (1 - along / len) - now);
    }
    const exitTime = goal >= 0 ? search.pathMetres / this.speed + 0.1 : Infinity;
    const hpFrac = self.maxHp > 0 ? self.hp / self.maxHp : 1;
    if (this.level.dive && hpFrac >= DIVE_MIN_HP && (this.diveLocked || exitTime > budget - TIME_SLACK_S)) {
      const dist = this.diveHeading(self.pos.y, px, pz, grid, danger);
      if (dist >= 0 && (this.diveLocked || dist / this.speed + 0.1 < exitTime - 0.05 || exitTime === Infinity)) {
        this.diveWanted = true;
        this.diveLocked = true;
        this.dirCost = dist;
        return true;
      }
    }
    if (goal < 0) return false;
    // heading: the farthest path cell within ~3 m that can be walked to in a straight line
    let pick = 1;
    let metres = 0;
    for (let k = 1; k < search.pathLen; k++) {
      const c = search.path[k];
      metres += Math.hypot(cellX(grid, c) - cellX(grid, search.path[k - 1]), cellZ(grid, c) - cellZ(grid, search.path[k - 1]));
      if (metres > 3.2) break;
      if (lineWalk(grid, px, pz, cellX(grid, c), cellZ(grid, c), false, true, 0.5) !== LINE_BLOCKED) pick = k;
    }
    const target = search.path[Math.min(pick, search.pathLen - 1)];
    let hx = cellX(grid, target) - px;
    let hz = cellZ(grid, target) - pz;
    if (Math.hypot(hx, hz) < 0.05) {
      hx = -first.uz;
      hz = first.ux;
    }
    const m = Math.hypot(hx, hz) || 1;
    this.dirX = hx / m;
    this.dirZ = hz / m;
    this.dirCost = search.pathMetres + 1e-3;
    return true;
  }

  /**
   * The shortest way off the platform the bot stands on: for 24 headings, march outward until the ground drops away by a metre or
   * more (a rim) with a cliff, a solid or the wall not in the way and a landing OUT of the endangered band. Sets the heading and
   * returns the distance to the rim (m), or -1 when there is none within 7 m.
   */
  private diveHeading(feetY: number, px: number, pz: number, grid: NavGrid, danger: readonly LaneView[]): number {
    let best = Infinity;
    let bx = 0;
    let bz = 0;
    for (let k = 0; k < HEADINGS; k++) {
      const ang = (k / HEADINGS) * Math.PI * 2;
      const dx = Math.cos(ang);
      const dz = Math.sin(ang);
      let prev = feetY;
      for (let t = 0.25; t <= 7 && t < best; t += 0.25) {
        const x = px + dx * t;
        const z = pz + dz * t;
        const gy = arenaGroundHeight(this.arena, x, z);
        if (gy > prev + ARENA_STEP_UP * 0.99) break; // a cliff
        const c = cellOf(grid, x, z);
        if (c < 0 || grid.solidOk[c] === 0) break; // a solid or the wall
        if (gy <= feetY - 1.0) {
          // off the platform: the landing must be out of every endangered band
          let ok = true;
          for (const l of danger) if ((gy >= this.split ? 'high' : 'low') === l.tier) ok = false;
          if (ok && t < best) {
            best = t;
            bx = dx;
            bz = dz;
          }
          break;
        }
        prev = gy;
      }
    }
    if (best === Infinity) return -1;
    this.dirX = bx;
    this.dirZ = bz;
    return best;
  }
}
