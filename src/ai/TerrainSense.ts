/**
 * TerrainSense (v1.8 WP-J2, docs/JUNGLE-PLAN.md): how a bot reads the arena's moss patches and shallow pool.
 *
 * Everything here is a no-op when the arena has no terrain zones (`active === false`), so the colosseum's bot behaviour is
 * byte-identical to v1.7. A bot knows exactly what a player can see: the zone discs are static arena data (`ArenaDef.terrain`),
 * the cost of crossing them is the public speed multiplier (moss 0.65, water 0.30 + 0.70·swim of its OWN animal), and other
 * fighters' `inWater` / `onMoss` flags come from the (reaction-delayed) snapshot via Perception.
 *
 * What it gives the brain (each knob scales with the difficulty, see {@link TERRAIN_AI}):
 *  - `plan`        bend a travel path round a zone when the detour is cheaper than the slow ("cost"-weighted, exact shortest path
 *                  round a disc); leave a zone by the cheapest rim point when the goal is outside it.
 *  - `fleePlan`    flight with terrain in mind: fast swimmers run THROUGH the pool away from a slow swimmer; slow swimmers route round.
 *  - `guard`       a "soft wall": do not WALK INTO a zone to start a fight (poor swimmers: the water; everyone: moss), slide along its
 *                  edge for a few seconds of patience, then commit and go in.
 *  - `exitVector`  nearest dry point (never idle / heal / flee-stand in slow terrain).
 *  - `driftPoint`  the no-contact wander point: a dry ring round the pool instead of the pool's centre.
 *  - `targetBias`  a small target-score nudge (don't pick a fight with someone sitting in the pool unless you swim well).
 * Bots never hop-chain on purpose: nothing here sets the jump intent.
 */

import type { AnimalId, Difficulty } from '../core/types';
import type { ArenaDef } from '../config/arenas';
import { ANIMALS } from '../config/animals';
import { MOSS_SPEED_MULT, TERRAIN, waterSpeedMultiplier } from '../config/terrain';
import type { TrackedEnemy } from './Perception';
import { setDir, type Move2 } from './Steering';

/** Per-difficulty terrain behaviour. L1 is nearly ignorant, L4 plays the terrain. All are decision knobs (no stat cheats). */
export interface TerrainAiLevel {
  /**
   * How much of the slow-terrain cost a bot counts when planning a travel path (0 = none: walks straight through; 1 = the
   * exact time cost, an "effective metres" comparison between the detour and the slow chord).
   */
  detourWeight: number;
  /** Seconds a bot waits at the edge of slow terrain for a target to come out before committing to wade in (0 = never holds). */
  edgeHoldS: number;
  /** Leaves slow terrain when idle / hurt / not engaged instead of standing in it. */
  exitIdle: boolean;
  /** Flees with the terrain in mind (fast swimmers use the pool, slow ones route round it). */
  fleeSmart: boolean;
  /** Target-score bias for terrain (see {@link TerrainSense.targetBias}); 0 = none. */
  targetBias: number;
}

export const TERRAIN_AI: Record<Difficulty, TerrainAiLevel> = {
  1: { detourWeight: 0, edgeHoldS: 0, exitIdle: false, fleeSmart: false, targetBias: 0 },
  2: { detourWeight: 0.5, edgeHoldS: 0, exitIdle: true, fleeSmart: false, targetBias: 0 },
  3: { detourWeight: 1, edgeHoldS: 2.5, exitIdle: true, fleeSmart: true, targetBias: 0.25 },
  4: { detourWeight: 1.15, edgeHoldS: 3.5, exitIdle: true, fleeSmart: true, targetBias: 0.4 },
};

/** Water multiplier at/above which an animal counts as a good swimmer (croc / hippo / python by default). */
export const GOOD_SWIMMER_MULT = 0.7;
/** Water multiplier below which an animal counts as a poor swimmer (rhino / gorilla / giraffe / eagle on foot). */
export const POOR_SWIMMER_MULT = 0.45;

/** Extra clearance (m) a planned path keeps from a zone's effective edge. */
const PATH_CLEAR = 0.45;
/** Hysteresis: a detour that was taken is kept while it stays within this factor of the crossing cost. */
const DETOUR_KEEP = 1.35;
/** Rim samples for the exit planner. */
const EXIT_SAMPLES = 16;
/** Seconds a committed bot ignores the soft wall. */
const COMMIT_S = 6;
/** Lookahead (m) of the soft wall. */
const WALL_AHEAD = 0.95;
/** Radius of the dry rally ring the no-contact drift heads for, measured from the pool centre (pool radius + this). */
const REST_RING_OVER = 3.4;
/** Radians the patrol point leads the bot along the rally ring. */
const PATROL_STEP = 0.7;

const TAU = Math.PI * 2;

function normAng(a: number): number {
  let r = a % TAU;
  if (r < 0) r += TAU;
  return r;
}

interface Zone {
  x: number;
  z: number;
  r: number;
  water: boolean;
}

export class TerrainSense {
  /** False for arenas without terrain (the colosseum): every method returns immediately. */
  readonly active: boolean;
  /** This animal's water speed multiplier (0.30–1.00). */
  readonly waterMult: number;
  readonly goodSwimmer: boolean;
  readonly poorSwimmer: boolean;
  level: TerrainAiLevel;

  private readonly zones: Zone[] = [];
  /** The pool disc (first water zone), for the drift / flee tactics. */
  private readonly pool: Zone | null;
  private readonly bodyR: number;
  private readonly trees: ArenaDef['circles'];
  private readonly wallR: number;
  /** +1 / -1: which way round the rally ring this bot patrols when it has no contact (alternates with the fighter id). */
  private readonly patrolSign: 1 | -1;

  // Soft-wall patience.
  private commitUntil = -1;
  private holdSince = -1;
  private holdLastSeen = -1;
  // Detour stickiness.
  private lastDetourZone = -1;
  private lastDetourAt = -1e9;

  constructor(arena: ArenaDef, animal: AnimalId, difficulty: Difficulty, fighterId = 0) {
    this.trees = arena.circles;
    this.wallR = arena.wallRadius;
    this.patrolSign = fighterId % 2 === 0 ? 1 : -1;
    for (const t of arena.terrain) this.zones.push({ x: t.x, z: t.z, r: t.radius, water: t.kind === 'water' });
    this.active = this.zones.length > 0;
    this.pool = this.zones.find((z) => z.water) ?? null;
    this.waterMult = waterSpeedMultiplier(animal);
    this.goodSwimmer = this.waterMult >= GOOD_SWIMMER_MULT;
    this.poorSwimmer = this.waterMult < POOR_SWIMMER_MULT;
    this.bodyR = ANIMALS[animal].radius;
    this.level = TERRAIN_AI[difficulty];
  }

  setDifficulty(d: Difficulty): void {
    this.level = TERRAIN_AI[d];
  }

  // ── Geometry helpers ───────────────────────────────────────────────────────

  /** Time-cost factor of standing in zone `z` for this animal (1 = free; 3.1 = a giraffe wading). */
  private costFactor(z: Zone): number {
    return z.water ? 1 / this.waterMult : 1 / MOSS_SPEED_MULT;
  }

  /** Effective radius: where the slow starts for a body at the zone (water: centre inside; moss: body overlap). */
  private eff(z: Zone): number {
    return z.water ? z.r : z.r + this.bodyR;
  }

  /** Is the point (x,z) in zone `z` (slow terrain), with `grow` extra metres? */
  private inside(z: Zone, x: number, zz: number, grow = 0): boolean {
    const dx = x - z.x;
    const dz = zz - z.z;
    const e = this.eff(z) + grow;
    return dx * dx + dz * dz < e * e;
  }

  /** The zone the body at (x,z) stands in the deepest, or −1. */
  private zoneAt(x: number, z: number): number {
    let best = -1;
    let bestPen = 0;
    for (let i = 0; i < this.zones.length; i++) {
      const zn = this.zones[i];
      const pen = this.eff(zn) - Math.hypot(x - zn.x, z - zn.z);
      if (pen > bestPen) {
        bestPen = pen;
        best = i;
      }
    }
    return best;
  }

  /** True when the body at (x,z) is standing in slow terrain (water or moss) by geometry. */
  inSlowTerrain(x: number, z: number): boolean {
    return this.active && this.zoneAt(x, z) >= 0;
  }

  // ── Path planning ──────────────────────────────────────────────────────────

  /**
   * Bend a travel heading `out` (already pointing from (sx,sz) toward the goal (gx,gz)) so it does not wade through slow
   * terrain when a cheaper way exists. Returns true when it changed `out`.
   *  - Outside every zone, with the straight line crossing one: compare `chord × weight × (cost − 1)` against the extra length
   *    of the exact shortest path round the (inflated) disc; walk round when the detour is cheaper.
   *  - Inside a zone with the goal outside it: walk to the rim point that minimises (inside cost × distance + distance on).
   *  - Goal inside the zone: no plan (the soft wall / the fight decides).
   */
  plan(out: Move2, now: number, sx: number, sz: number, gx: number, gz: number): boolean {
    const weight = this.level.detourWeight;
    if (!this.active || weight <= 0) return false;
    const dx = gx - sx;
    const dz = gz - sz;
    const L = Math.sqrt(dx * dx + dz * dz);
    if (L < 1.5) return false;

    const inI = this.zoneAt(sx, sz);
    if (inI >= 0) return this.exitPlan(out, sx, sz, gx, gz, this.zones[inI], weight);

    const ux = dx / L;
    const uz = dz / L;
    let bestI = -1;
    let bestT = 1e9;
    let bestD = 0;
    for (let i = 0; i < this.zones.length; i++) {
      const z = this.zones[i];
      const e = this.eff(z);
      const rx = z.x - sx;
      const rz = z.z - sz;
      const t = rx * ux + rz * uz;
      if (t <= 0 || t >= L) continue;
      const d = Math.abs(rx * uz - rz * ux);
      if (d >= e) continue;
      if (Math.hypot(gx - z.x, gz - z.z) < e + 0.2) continue; // the goal is in the zone: handled by the soft wall
      if (t < bestT) {
        bestT = t;
        bestI = i;
        bestD = d;
      }
    }
    if (bestI < 0) return false;

    const z = this.zones[bestI];
    const e = this.eff(z);
    const k = this.costFactor(z);
    if (k <= 1.0001) return false;
    const chord = 2 * Math.sqrt(Math.max(0, e * e - bestD * bestD));
    const crossCost = chord * weight * (k - 1);

    const a = Math.hypot(sx - z.x, sz - z.z);
    const b = Math.hypot(gx - z.x, gz - z.z);
    const ep = Math.min(e + PATH_CLEAR, a - 0.05, b - 0.05);
    if (ep <= e) return false;
    const angS = Math.atan2(sz - z.z, sx - z.x);
    const angT = Math.atan2(gz - z.z, gx - z.x);
    const phiS = Math.acos(Math.min(1, ep / a));
    const phiT = Math.acos(Math.min(1, ep / b));
    const tanS = Math.sqrt(Math.max(0, a * a - ep * ep));
    const tanT = Math.sqrt(Math.max(0, b * b - ep * ep));
    const dPlus = normAng(angT - phiT - (angS + phiS));
    const dMinus = normAng(angS - phiS - (angT + phiT));
    const lenPlus = tanS + ep * dPlus + tanT;
    const lenMinus = tanS + ep * dMinus + tanT;
    const plus = lenPlus <= lenMinus;
    const detourExtra = (plus ? lenPlus : lenMinus) - L;

    const keep = this.lastDetourZone === bestI && now - this.lastDetourAt < 0.6 ? DETOUR_KEEP : 1;
    if (!(detourExtra < crossCost * keep)) return false;

    this.lastDetourZone = bestI;
    this.lastDetourAt = now;
    const th = plus ? angS + phiS : angS - phiS;
    setDir(out, z.x + ep * Math.cos(th) - sx, z.z + ep * Math.sin(th) - sz);
    return true;
  }

  /** Inside `z`, goal outside: head for the cheapest rim point. */
  private exitPlan(out: Move2, sx: number, sz: number, gx: number, gz: number, z: Zone, weight: number): boolean {
    const e = this.eff(z) + (z.water ? TERRAIN.water.shorelineHysteresis : 0) + PATH_CLEAR * 0.7;
    if (Math.hypot(gx - z.x, gz - z.z) < e) return false; // the goal is in the same zone: stay
    const k = 1 + weight * (this.costFactor(z) - 1);
    let bx = 0;
    let bz = 0;
    let bc = Infinity;
    for (let j = 0; j < EXIT_SAMPLES; j++) {
      const ang = (TAU * j) / EXIT_SAMPLES;
      const px = z.x + e * Math.cos(ang);
      const pz = z.z + e * Math.sin(ang);
      const c = Math.hypot(px - sx, pz - sz) * k + Math.hypot(gx - px, gz - pz);
      if (c < bc) {
        bc = c;
        bx = px;
        bz = pz;
      }
    }
    // The straight exit toward the goal (ray S→G meets the rim).
    const dx = gx - sx;
    const dz = gz - sz;
    const L = Math.sqrt(dx * dx + dz * dz);
    if (L > 1e-6) {
      const ux = dx / L;
      const uz = dz / L;
      const fx = sx - z.x;
      const fz = sz - z.z;
      const bq = fx * ux + fz * uz;
      const cq = fx * fx + fz * fz - e * e;
      const disc = bq * bq - cq;
      if (disc > 0) {
        const t = -bq + Math.sqrt(disc);
        if (t > 0 && t < L) {
          const px = sx + ux * t;
          const pz = sz + uz * t;
          const c = t * k + Math.hypot(gx - px, gz - pz);
          if (c <= bc) {
            bc = c;
            bx = px;
            bz = pz;
          }
        }
      }
    }
    setDir(out, bx - sx, bz - sz);
    return true;
  }

  /**
   * Terrain-aware flight. Fast swimmers (L3+) run THROUGH the pool when it lies ahead of them and the pursuer is
   * a slow swimmer; everyone else routes round slow terrain. `out` must already hold the plain flee heading.
   */
  fleePlan(out: Move2, now: number, sx: number, sz: number, threat: AnimalId | null): void {
    if (!this.active || !this.level.fleeSmart) return;
    const pool = this.pool;
    let gx = sx + out.x * 9;
    let gz = sz + out.z * 9;
    if (pool !== null && this.goodSwimmer && threat !== null) {
      const tm = waterSpeedMultiplier(threat);
      const toCx = pool.x - sx;
      const toCz = pool.z - sz;
      const dc = Math.hypot(toCx, toCz);
      // The pool is ahead (away from the threat), close enough to reach, and the pursuer wades much slower than we do.
      if (tm <= this.waterMult * 0.7 && dc < pool.r + 12 && dc > 1e-6 && (toCx * out.x + toCz * out.z) / dc > 0.2) {
        gx = pool.x + (toCx / dc) * (pool.r + 3);
        gz = pool.z + (toCz / dc) * (pool.r + 3);
        setDir(out, gx - sx, gz - sz);
        return;
      }
    }
    // A flight goal that lands inside slow terrain is pushed on past it (a goal in the zone would switch the planner off).
    for (let k = 0; k < 5 && this.zoneAt(gx, gz) >= 0; k++) {
      gx += out.x * 2.5;
      gz += out.z * 2.5;
    }
    // Keep the goal inside the wall (a goal beyond it would just pin the bot on the rim).
    const gl = Math.hypot(gx, gz);
    const lim = 26;
    if (gl > lim) {
      gx = (gx / gl) * lim;
      gz = (gz / gl) * lim;
    }
    this.plan(out, now, sx, sz, gx, gz);
  }

  // ── Standing in terrain ────────────────────────────────────────────────────

  /**
   * Should this bot leave the slow terrain it stands in when it has nothing to fight? Fast swimmers do not leave the pool on
   * their own unless hurt (they may use it); everyone leaves moss; poor / mid swimmers leave the water.
   */
  wantsOut(selfInWater: boolean, selfOnMoss: boolean, hurt: boolean): boolean {
    if (!this.active || !this.level.exitIdle) return false;
    if (selfOnMoss) return true;
    if (selfInWater) return hurt || !this.goodSwimmer;
    return false;
  }

  /** Heading to the nearest dry point out of the zone the body stands in (false when not in one). */
  exitVector(out: Move2, sx: number, sz: number): boolean {
    if (!this.active) return false;
    const i = this.zoneAt(sx, sz);
    if (i < 0) return false;
    const z = this.zones[i];
    const dx = sx - z.x;
    const dz = sz - z.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < 1e-6) setDir(out, 1, 0);
    else setDir(out, dx, dz);
    return true;
  }

  // ── Soft wall ──────────────────────────────────────────────────────────────

  private forbidden(z: Zone): boolean {
    return z.water ? this.poorSwimmer : true;
  }

  /**
   * A soft wall in front of slow terrain: while the bot is OUTSIDE a zone and `out` would carry it into one it should not enter
   * (water for poor swimmers, moss for everyone — L3+), remove the inward component so it slides along the edge. After
   * `edgeHoldS` seconds of this it commits and the wall is down for {@link COMMIT_S}. `reached` = the target is already in
   * swing reach (no need to walk in). Returns true while the wall is holding the bot.
   */
  guard(out: Move2, now: number, sx: number, sz: number, reached: boolean): boolean {
    const patience = this.level.edgeHoldS;
    if (!this.active || patience <= 0) return false;
    if (now < this.commitUntil) return false;
    if (out.x === 0 && out.z === 0) return false;
    if (this.zoneAt(sx, sz) >= 0) return false; // already standing in slow terrain: the exit planner decides, never hold here
    let held = false;
    for (let i = 0; i < this.zones.length; i++) {
      const z = this.zones[i];
      if (!this.forbidden(z)) continue;
      if (this.inside(z, sx, sz)) continue; // already in: the exit planner deals with it
      if (!this.inside(z, sx + out.x * WALL_AHEAD, sz + out.z * WALL_AHEAD, 0.25)) continue;
      held = true;
      if (reached) {
        out.x = 0;
        out.z = 0;
        break;
      }
      let nx = sx - z.x;
      let nz = sz - z.z;
      const nl = Math.sqrt(nx * nx + nz * nz) || 1;
      nx /= nl;
      nz /= nl;
      const inward = -(out.x * nx + out.z * nz);
      if (inward > 0) {
        out.x += nx * inward;
        out.z += nz * inward;
      }
      const m = Math.sqrt(out.x * out.x + out.z * out.z);
      if (m < 0.25) {
        out.x = 0;
        out.z = 0;
      } else {
        out.x /= m;
        out.z /= m;
      }
      break;
    }
    if (held) {
      if (this.holdSince < 0 || now - this.holdLastSeen > 0.5) this.holdSince = now;
      this.holdLastSeen = now;
      const wait = patience;
      if (now - this.holdSince >= wait) {
        this.commitUntil = now + COMMIT_S;
        this.holdSince = -1;
      }
    }
    return held;
  }

  /** True while the soft wall is holding this bot at the edge of slow terrain (it held on the last tick or so). */
  wallHolding(now: number): boolean {
    return this.holdSince >= 0 && now - this.holdLastSeen <= 0.25;
  }

  /**
   * Would a movement special (leap / pounce / charge) start a fight INSIDE the pool? True for a slow swimmer (L3+) that is not in
   * the water while its target is, or while the soft wall is holding it back: abilities keep their own speed, so a leap would
   * otherwise carry it straight over the shore the wall is guarding.
   */
  specialIntoWater(now: number, selfInWater: boolean, target: TrackedEnemy | null): boolean {
    if (!this.active || this.level.edgeHoldS <= 0 || this.goodSwimmer || selfInWater) return false;
    if (now < this.commitUntil) return false;
    return this.wallHolding(now) || (target !== null && target.inWater);
  }

  // ── Wander / targeting ─────────────────────────────────────────────────────

  /**
   * Where a bot with no contact heads (null = nowhere). The colosseum drifts to the centre and every blind bot converges there;
   * the jungle's centre is a pool, so bots rally on a dry ring round it and PATROL it (half clockwise, half counter-clockwise)
   * until somebody comes into view, so two bots hidden from each other by a trunk can never idle side by side forever.
   */
  driftPoint(sx: number, sz: number): { x: number; z: number } | null {
    const p = this.pool;
    if (p === null) return sx * sx + sz * sz > 36 ? { x: 0, z: 0 } : null;
    const ring = p.r + REST_RING_OVER;
    const dx = sx - p.x;
    const dz = sz - p.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    const bearing = d < 1e-6 ? 0 : Math.atan2(dz, dx);
    const onRing = Math.abs(d - ring) <= 1.8;
    return this.dryRingPoint(p, ring, onRing ? bearing + this.patrolSign * PATROL_STEP : bearing);
  }

  /** A point on the rally ring near `angle` that is clear of moss, trunks and the wall (scans outward from the angle). */
  private dryRingPoint(p: Zone, ring: number, angle: number): { x: number; z: number } {
    let fx = p.x + ring * Math.cos(angle);
    let fz = p.z + ring * Math.sin(angle);
    for (let k = 0; k < 17; k++) {
      const off = k === 0 ? 0 : (k % 2 === 1 ? 1 : -1) * Math.ceil(k / 2) * 0.2;
      const x = p.x + ring * Math.cos(angle + off);
      const z = p.z + ring * Math.sin(angle + off);
      if (k === 0) {
        fx = x;
        fz = z;
      }
      if (Math.hypot(x, z) > this.wallR - 2.5) continue;
      let ok = true;
      for (let i = 0; ok && i < this.zones.length; i++) {
        const zn = this.zones[i];
        if (!zn.water && Math.hypot(x - zn.x, z - zn.z) < this.eff(zn) + 0.5) ok = false;
      }
      for (let i = 0; ok && i < this.trees.length; i++) {
        const tr = this.trees[i];
        if (Math.hypot(x - tr.x, z - tr.z) < tr.radius + this.bodyR + 0.8) ok = false;
      }
      if (ok) return { x, z };
    }
    return { x: fx, z: fz };
  }

  /**
   * Target-score nudge (L3+): a poor swimmer prefers targets on dry land over ones wading in the pool; a good swimmer prefers a
   * slow swimmer standing in the water. 0 when terrain is off or the level ignores it.
   */
  targetBias(t: TrackedEnemy): number {
    const bias = this.level.targetBias;
    if (!this.active || bias <= 0) return 0;
    if (t.inWater) {
      const tm = waterSpeedMultiplier(t.animal);
      if (this.poorSwimmer) return -bias;
      if (this.goodSwimmer && tm < this.waterMult * 0.7) return bias;
    }
    return 0;
  }
}
