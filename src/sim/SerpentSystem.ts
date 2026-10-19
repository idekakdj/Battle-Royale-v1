/**
 * Sea-serpent events (v1.9, Ocean Dome; docs/OCEAN-PLAN.md, numbers in `config/serpent.ts`).
 * v1.10 (docs/OCEAN-HEIGHTS-PLAN.md): TWO independent lanes — the LOW serpent (the v1.9 one) and, on arenas that set
 * `hazards.serpentSplitY`, a HIGH serpent that attacks the upper platforms.
 *
 * Schedule: on LIVE match time (`sim.time`, which excludes the 3-2-1 countdown) every lane rolls at t = intervalS, 2 x intervalS, …
 * with its OWN mulberry32 stream (match seed XOR {@link SERPENT.seedSalt} for the low lane, XOR {@link SERPENT_LANES.highSeedSalt}
 * for the high one); the sim RNG is never touched. Both lanes roll at the same times with the same chance, independently (both can
 * start on the same tick: 25 % of rolls at chance 0.5; one of them: 50 %; none: 25 %). A successful roll draws the strike angle
 * from the lane's stream via {@link pickLaneAngle} (the low lane only ever strikes along lines that stay off the upper platforms,
 * the high lane along lines that cross them) and runs WARN -> STRIKE -> HOLD -> RETREAT. One event per lane at a time: a roll
 * that falls due while the lane's event runs is skipped (and logged).
 *
 * Strike: the head capsule (radius {@link SERPENT.headRadius}) travels along direction (cos θ, sin θ) from r = wallRadius to
 * r = 0 in `strikeS` (constant speed). Each tick every alive, targetable, non-burrowed fighter whose body circle overlaps the
 * capsule SWEPT this tick, whose BAND (`arenaSerpentBand`: by the GROUND height under it, low unless the arena has a split) is the
 * lane's tier, and whose altitude above the LOCAL ground (`arenaGroundHeight`) is <= `hazardHeight`, takes `damage` TRUE damage
 * once per event (a fighter can be hit by both lanes' events, once by each — never twice by the same one), through the World's
 * environment-damage callback (no block / guard / armour / ult charge / flinch / credit; a death is `killerId −1`). Points the head
 * has already passed are never hurt again, and the HOLD / RETREAT phases are harmless.
 *
 * Events: the low lane emits exactly the v1.9.1 events (no `tier` key); the high lane's carry `tier: 'high'`.
 *
 * Deterministic: the tick iterates fighters in ascending id order; no allocation except event payloads.
 */

import type { GameEvent, SerpentPhase, SerpentState, SerpentTier } from '../core/types';
import { mulberry32, type Rng } from '../core/math';
import { SERPENT } from '../config/serpent';
import { SERPENT_LANES, pickLaneAngle } from '../config/serpentLanes';
import { arenaGroundHeight, arenaHasHighSerpent, arenaSerpentBand, type ArenaDef } from '../config/arenas';
import type { Fighter, Sim } from './Fighter';

/** Test / QA overrides of the real rules (World option `serpent`). Defaults = `config/serpent.ts`. */
export interface SerpentOptions {
  /** Probability per roll (default {@link SERPENT.chance}); applies to both lanes. */
  chance?: number;
  /** Seconds of live match time between rolls (default {@link SERPENT.intervalS}); applies to both lanes. */
  intervalS?: number;
  /** Live match time of the FIRST roll (default = `intervalS`); later rolls follow every `intervalS`. Applies to both lanes. */
  firstAtS?: number;
  /**
   * v1.10: which lanes run (default: the low lane, plus the high lane when the arena has `hazards.serpentSplitY`). `['low']` keeps
   * the high serpent away (QA), `['high']` runs only it. A tier the arena cannot run (`'high'` without a split) is ignored.
   */
  lanes?: readonly SerpentTier[];
}

/** One roll of the schedule, kept for tests / QA (`SerpentLane.rollLog`). */
export interface SerpentRoll {
  /** The scheduled roll time (live seconds; an exact multiple of the interval from the first roll). */
  at: number;
  /** `sim.time` of the tick on which the roll was made (>= `at`, less than one tick later). */
  time: number;
  /** True when the roll started an event. */
  started: boolean;
  /** True when the roll was due while an earlier event was still running (no random numbers consumed). */
  skipped: boolean;
  /** The strike angle drawn on success, else −1. */
  angleDeg: number;
}

/** Applies true environmental damage to a fighter; returns the hp actually removed (World.applyTrapDamage). */
export type SerpentDamageFn = (target: Fighter, amount: number) => number;

/** A scheduled roll is made on the first tick whose time is within this of the due time (float drift of 3600+ additions). */
const ROLL_EPS = 1e-6;
/** Phase-boundary tolerance (s). */
const EPS = 1e-9;

function phaseDuration(p: SerpentPhase): number {
  switch (p) {
    case 'warn':
      return SERPENT.warnS;
    case 'strike':
      return SERPENT.strikeS;
    case 'hold':
      return SERPENT.holdS;
    default:
      return SERPENT.retreatS;
  }
}

function nextPhase(p: SerpentPhase): SerpentPhase | null {
  switch (p) {
    case 'warn':
      return 'strike';
    case 'strike':
      return 'hold';
    case 'hold':
      return 'retreat';
    default:
      return null;
  }
}

/** Distance from (px,pz) to the segment (ax,az)–(bx,bz) (a degenerate segment is a point). */
function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax;
  const abz = bz - az;
  const len2 = abx * abx + abz * abz;
  let t = len2 > 1e-12 ? ((px - ax) * abx + (pz - az) * abz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + abx * t);
  const dz = pz - (az + abz * t);
  return Math.sqrt(dx * dx + dz * dz);
}

/** Wrap any angle (degrees) into [0, 360). */
export function normalizeAngleDeg(a: number): number {
  if (!(a === a) || a === Infinity || a === -Infinity) return 0;
  const m = ((a % 360) + 360) % 360;
  return m >= 360 ? 0 : m;
}

/**
 * ONE serpent (one lane): its own RNG stream, schedule, timeline and hit list. {@link SerpentSystem} owns one per tier.
 */
export class SerpentLane {
  readonly tier: SerpentTier;
  /** Current phase, or null while no event runs. */
  phase: SerpentPhase | null = null;
  /** Strike-line direction of the running (or last) event, degrees [0, 360). */
  angleDeg = 0;
  /** Seconds into the current phase. */
  t = 0;
  /** Every roll made so far (tests / QA). At most one per `intervalS`. */
  readonly rollLog: SerpentRoll[] = [];
  /** Number of events started (scheduled or `debug`-triggered). */
  eventsStarted = 0;

  private readonly rng: Rng;
  private readonly arena: ArenaDef;
  /** A debug-triggered event waiting to start at the beginning of the next sim tick (angle, degrees), else null. */
  private pendingAngle: number | null = null;
  private readonly chance: number;
  private readonly intervalS: number;
  private nextRollAt: number;
  /** Per-event: fighters (by id) already hit. */
  private hit = new Uint8Array(0);
  /** Fighter ids hit during the CURRENT tick (World.kill reads it to tag `cause: 'serpent'`). */
  private readonly hitNow: number[] = [];

  constructor(tier: SerpentTier, seed: number, arena: ArenaDef, opts: SerpentOptions = {}) {
    this.tier = tier;
    const salt = tier === 'high' ? SERPENT_LANES.highSeedSalt : SERPENT.seedSalt;
    this.rng = mulberry32((seed ^ salt) >>> 0);
    this.arena = arena;
    this.chance = opts.chance ?? SERPENT.chance;
    this.intervalS = opts.intervalS ?? SERPENT.intervalS;
    this.nextRollAt = opts.firstAtS ?? this.intervalS;
  }

  /** True while an event is running or a {@link trigger} is waiting for the next tick. */
  get active(): boolean {
    return this.phase !== null || this.pendingAngle !== null;
  }

  /** True if `id` was hit by the strike during the current tick. */
  wasHitThisTick(id: number): boolean {
    return this.hitNow.indexOf(id) >= 0;
  }

  /**
   * Debug / QA: queues an event that starts (WARN, `serpentWarning` emitted) at the beginning of the NEXT sim tick, ignoring the
   * schedule and the chance — so its events always belong to a tick (the online host collects events per step), and nothing
   * starts during the 3-2-1 countdown. `angleDeg` default: drawn from the lane's stream now (an allowed strike line of the lane;
   * a lane without any allowed line cannot be triggered without an explicit angle). Returns false (and does nothing) while an
   * event is running or already queued.
   */
  trigger(angleDeg?: number): boolean {
    if (this.active) return false;
    if (angleDeg === undefined) {
      const a = pickLaneAngle(this.arena, this.tier, this.rng);
      if (a < 0) return false;
      this.pendingAngle = a;
    } else {
      this.pendingAngle = normalizeAngleDeg(angleDeg);
    }
    return true;
  }

  /** Per-tick update; SerpentSystem calls it once, after movement and traps. */
  step(sim: Sim, dt: number, deal: SerpentDamageFn): void {
    this.hitNow.length = 0;
    let startedNow = false;
    if (this.pendingAngle !== null) {
      const a = this.pendingAngle;
      this.pendingAngle = null;
      this.start(sim, a);
      startedNow = true;
    }
    // 1. Schedule: every roll that has fallen due (normally exactly one, on the tick `time` reaches the multiple).
    while (sim.time + ROLL_EPS >= this.nextRollAt) {
      const at = this.nextRollAt;
      this.nextRollAt += this.intervalS;
      if (this.phase !== null || startedNow) {
        this.rollLog.push({ at, time: sim.time, started: false, skipped: true, angleDeg: -1 });
        continue;
      }
      if (this.rng() < this.chance) {
        const a = pickLaneAngle(this.arena, this.tier, this.rng); // exactly two draws; −1 = the lane has no allowed line
        if (a >= 0) {
          this.rollLog.push({ at, time: sim.time, started: true, skipped: false, angleDeg: a });
          this.start(sim, a);
          startedNow = true;
        } else {
          this.rollLog.push({ at, time: sim.time, started: false, skipped: false, angleDeg: -1 });
        }
      } else {
        this.rollLog.push({ at, time: sim.time, started: false, skipped: false, angleDeg: -1 });
      }
    }
    // 2. Advance a running event (the tick that started it only shows t = 0).
    if (this.phase !== null && !startedNow) this.advance(sim, dt, deal);
  }

  /** Ends a running event at once (World does this when the match ends). Emits `serpentEnd`. */
  abort(sim: Sim): void {
    this.pendingAngle = null;
    if (this.phase === null) return;
    this.phase = null;
    this.t = 0;
    sim.emit(this.tagged({ type: 'serpentEnd' }));
  }

  /** Public state for `WorldSnapshot.serpent` / `.serpentHigh` (undefined when no event runs). */
  snapshot(): SerpentState | undefined {
    if (this.phase === null) return undefined;
    return { phase: this.phase, angleDeg: this.angleDeg, t: this.t, headR: this.headRAt(this.phase, this.t) };
  }

  /** Head distance from the centre for `phase` at `t` seconds into it. */
  headRAt(phase: SerpentPhase, t: number): number {
    const R = this.arena.wallRadius;
    switch (phase) {
      case 'warn':
        return R;
      case 'strike':
        return R * (1 - Math.min(1, Math.max(0, t / SERPENT.strikeS)));
      case 'hold':
        return 0;
      default:
        return R * Math.min(1, Math.max(0, t / SERPENT.retreatS));
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** The high lane's events carry `tier: 'high'`; the low lane's are exactly the v1.9.1 events (no `tier` key). */
  private tagged<E extends GameEvent>(ev: E): E {
    if (this.tier === 'high') (ev as { tier?: SerpentTier }).tier = 'high';
    return ev;
  }

  private start(sim: Sim, angleDeg: number): void {
    this.angleDeg = angleDeg;
    this.phase = 'warn';
    this.t = 0;
    this.eventsStarted += 1;
    if (this.hit.length < sim.fighters.length) this.hit = new Uint8Array(sim.fighters.length);
    else this.hit.fill(0);
    sim.emit(this.tagged({ type: 'serpentWarning', angleDeg, warnS: SERPENT.warnS }));
  }

  /** Consumes `dt` seconds of the event, crossing phase boundaries as needed (carry-over keeps the timeline exact). */
  private advance(sim: Sim, dt: number, deal: SerpentDamageFn): void {
    let remaining = dt;
    while (remaining > EPS && this.phase !== null) {
      const phase = this.phase;
      const dur = phaseDuration(phase);
      const room = dur - this.t;
      if (remaining < room - EPS) {
        const t0 = this.t;
        this.t += remaining;
        remaining = 0;
        if (phase === 'strike') this.sweep(sim, t0, this.t, deal);
        break;
      }
      // The phase ends within this tick: finish it, carry the rest into the next one.
      if (phase === 'strike') this.sweep(sim, this.t, dur, deal);
      remaining -= Math.max(0, room);
      const next = nextPhase(phase);
      this.t = 0;
      if (next === null) {
        this.phase = null;
        sim.emit(this.tagged({ type: 'serpentEnd' }));
        return;
      }
      this.phase = next;
      if (next === 'strike') sim.emit(this.tagged({ type: 'serpentStrike', angleDeg: this.angleDeg }));
    }
    // A strike that begins exactly on a tick boundary still tests the disc at the wall (zero-length sweep) so a fighter
    // pressed against the dome edge on the line is not missed.
    if (this.phase === 'strike' && this.t === 0) this.sweep(sim, 0, 0, deal);
  }

  /** Hurts everyone of this lane's band the head capsule swept over while moving from `s0` to `s1` seconds into the strike. */
  private sweep(sim: Sim, s0: number, s1: number, deal: SerpentDamageFn): void {
    const R = this.arena.wallRadius;
    const rad = (this.angleDeg * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dz = Math.sin(rad);
    const r0 = R * (1 - Math.min(1, Math.max(0, s0 / SERPENT.strikeS)));
    const r1 = R * (1 - Math.min(1, Math.max(0, s1 / SERPENT.strikeS)));
    const ax = dx * r0;
    const az = dz * r0;
    const bx = dx * r1;
    const bz = dz * r1;
    const fs = sim.fighters;
    for (let i = 0; i < fs.length; i++) {
      const f = fs[i];
      if (f.id >= this.hit.length || this.hit[f.id] !== 0) continue;
      const s = f.state;
      if (!s.alive || f.untargetable || s.burrowT > 0) continue;
      if (s.pos.y - arenaGroundHeight(this.arena, s.pos.x, s.pos.z) > SERPENT.hazardHeight) continue;
      if (arenaSerpentBand(this.arena, s.pos.x, s.pos.z) !== this.tier) continue; // v1.10: each serpent hurts only its own band
      if (segDist(s.pos.x, s.pos.z, ax, az, bx, bz) > SERPENT.headRadius + f.def.radius) continue;
      this.hit[f.id] = 1;
      const dealt = deal(f, SERPENT.damage);
      if (dealt <= 0) continue;
      this.hitNow.push(f.id);
      sim.emit(
        this.tagged({
          type: 'serpentHit',
          fighterId: f.id,
          damage: Math.round(dealt),
          pos: { x: s.pos.x, y: s.pos.y, z: s.pos.z },
        }),
      );
    }
  }
}

/**
 * The arena's serpents: the LOW lane (always, unless `opts.lanes` leaves it out) and the HIGH lane (arenas with
 * `hazards.serpentSplitY`). The single-event accessors below (`phase`, `angleDeg`, `t`, `rollLog`, `eventsStarted`, `headRAt`)
 * read the LOW lane — the v1.9 serpent — so the v1.9 callers and tests keep working; `lane(tier)` reaches either lane.
 */
export class SerpentSystem {
  readonly low: SerpentLane | null;
  readonly high: SerpentLane | null;
  /** The lanes that exist, low first (tick order: low, then high). */
  readonly lanes: readonly SerpentLane[];

  constructor(seed: number, arena: ArenaDef, opts: SerpentOptions = {}) {
    const want: readonly SerpentTier[] = opts.lanes ?? (arenaHasHighSerpent(arena) ? ['low', 'high'] : ['low']);
    this.low = want.includes('low') ? new SerpentLane('low', seed, arena, opts) : null;
    this.high = want.includes('high') && arenaHasHighSerpent(arena) ? new SerpentLane('high', seed, arena, opts) : null;
    const lanes: SerpentLane[] = [];
    if (this.low !== null) lanes.push(this.low);
    if (this.high !== null) lanes.push(this.high);
    this.lanes = lanes;
  }

  /** The lane of `tier`, or null when it does not run on this arena / in this match. */
  lane(tier: SerpentTier): SerpentLane | null {
    return tier === 'high' ? this.high : this.low;
  }

  // ── the LOW (v1.9) serpent, under its old names ───────────────────────────
  get phase(): SerpentPhase | null {
    return this.low?.phase ?? null;
  }
  get angleDeg(): number {
    return this.low?.angleDeg ?? 0;
  }
  get t(): number {
    return this.low?.t ?? 0;
  }
  get rollLog(): readonly SerpentRoll[] {
    return this.low?.rollLog ?? [];
  }
  get eventsStarted(): number {
    return this.low?.eventsStarted ?? 0;
  }
  headRAt(phase: SerpentPhase, t: number): number {
    return (this.low ?? this.high)?.headRAt(phase, t) ?? 0;
  }

  /** True while ANY lane has an event running or queued. */
  get active(): boolean {
    for (const l of this.lanes) if (l.active) return true;
    return false;
  }

  /** True if `id` was hit by a serpent strike (either lane) during the current tick. */
  wasHitThisTick(id: number): boolean {
    for (const l of this.lanes) if (l.wasHitThisTick(id)) return true;
    return false;
  }

  /**
   * Debug / QA: queue an event on `tier`'s lane (see {@link SerpentLane.trigger}). Returns false when that lane does not exist,
   * is busy, or (no angle given) has no allowed strike line.
   */
  trigger(angleDeg?: number, tier: SerpentTier = 'low'): boolean {
    const l = this.lane(tier);
    return l !== null && l.trigger(angleDeg);
  }

  /** Per-tick update; World calls it once, after movement and traps. Lanes run low then high. */
  step(sim: Sim, dt: number, deal: SerpentDamageFn): void {
    for (const l of this.lanes) l.step(sim, dt, deal);
  }

  /** Ends every running event at once (World does this when the match ends). Emits one `serpentEnd` per running lane. */
  abort(sim: Sim): void {
    for (const l of this.lanes) l.abort(sim);
  }

  /** Public state for `WorldSnapshot.serpent` (the LOW serpent; undefined when it is not attacking). */
  snapshot(): SerpentState | undefined {
    return this.low?.snapshot();
  }

  /** Public state for `WorldSnapshot.serpentHigh` (undefined when the high serpent is not attacking / does not exist). */
  snapshotHigh(): SerpentState | undefined {
    return this.high?.snapshot();
  }
}
