/**
 * Sea-serpent event (v1.9, Ocean Dome; docs/OCEAN-PLAN.md, numbers in `config/serpent.ts`).
 *
 * Schedule: on LIVE match time (`sim.time`, which excludes the 3-2-1 countdown) the system rolls at t = intervalS,
 * 2 x intervalS, … with its own mulberry32 stream (match seed XOR {@link SERPENT.seedSalt}); the sim RNG is never touched.
 * A successful roll draws the strike angle from the same stream and runs WARN -> STRIKE -> HOLD -> RETREAT. One event at
 * a time: a roll that falls due while an event runs is skipped (and logged).
 *
 * Strike: the head capsule (radius {@link SERPENT.headRadius}) travels along direction (cos θ, sin θ) from r = wallRadius to
 * r = 0 in `strikeS` (constant speed). Each tick every alive, targetable, non-burrowed fighter whose body circle overlaps the
 * capsule SWEPT this tick, and whose altitude above the LOCAL ground (`arenaGroundHeight`) is <= `hazardHeight`, takes
 * `damage` TRUE damage once per event, through the World's environment-damage callback (no block / guard / armour / ult
 * charge / flinch / credit; a death is `killerId −1`). Points the head has already passed are never hurt again, and the
 * HOLD / RETREAT phases are harmless.
 *
 * Deterministic: the tick iterates fighters in ascending id order; no allocation except event payloads.
 */

import type { GameEvent, SerpentPhase, SerpentState } from '../core/types';
import { mulberry32, type Rng } from '../core/math';
import { SERPENT } from '../config/serpent';
import { arenaGroundHeight, type ArenaDef } from '../config/arenas';
import type { Fighter, Sim } from './Fighter';

/** Test / QA overrides of the real rules (World option `serpent`). Defaults = `config/serpent.ts`. */
export interface SerpentOptions {
  /** Probability per roll (default {@link SERPENT.chance}). */
  chance?: number;
  /** Seconds of live match time between rolls (default {@link SERPENT.intervalS}). */
  intervalS?: number;
  /** Live match time of the FIRST roll (default = `intervalS`); later rolls follow every `intervalS`. */
  firstAtS?: number;
}

/** One roll of the schedule, kept for tests / QA (`SerpentSystem.rollLog`). */
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

export class SerpentSystem {
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

  constructor(seed: number, arena: ArenaDef, opts: SerpentOptions = {}) {
    this.rng = mulberry32((seed ^ SERPENT.seedSalt) >>> 0);
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
   * starts during the 3-2-1 countdown. `angleDeg` default: drawn from the serpent stream now. Returns false (and does nothing)
   * while an event is running or already queued.
   */
  trigger(angleDeg?: number): boolean {
    if (this.active) return false;
    this.pendingAngle = angleDeg === undefined ? this.rng() * 360 : normalizeAngleDeg(angleDeg);
    return true;
  }

  /** Per-tick update; World calls it once, after movement and traps. */
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
        const a = this.rng() * 360;
        this.rollLog.push({ at, time: sim.time, started: true, skipped: false, angleDeg: a });
        this.start(sim, a);
        startedNow = true;
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
    sim.emit({ type: 'serpentEnd' });
  }

  /** Public state for `WorldSnapshot.serpent` (undefined when no event runs). */
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

  private start(sim: Sim, angleDeg: number): void {
    this.angleDeg = angleDeg;
    this.phase = 'warn';
    this.t = 0;
    this.eventsStarted += 1;
    if (this.hit.length < sim.fighters.length) this.hit = new Uint8Array(sim.fighters.length);
    else this.hit.fill(0);
    const ev: GameEvent = { type: 'serpentWarning', angleDeg, warnS: SERPENT.warnS };
    sim.emit(ev);
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
        sim.emit({ type: 'serpentEnd' });
        return;
      }
      this.phase = next;
      if (next === 'strike') sim.emit({ type: 'serpentStrike', angleDeg: this.angleDeg });
    }
    // A strike that begins exactly on a tick boundary still tests the disc at the wall (zero-length sweep) so a fighter
    // pressed against the dome edge on the line is not missed.
    if (this.phase === 'strike' && this.t === 0) this.sweep(sim, 0, 0, deal);
  }

  /** Hurts everyone the head capsule swept over while moving from `s0` to `s1` seconds into the strike. */
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
      if (segDist(s.pos.x, s.pos.z, ax, az, bx, bz) > SERPENT.headRadius + f.def.radius) continue;
      this.hit[f.id] = 1;
      const dealt = deal(f, SERPENT.damage);
      if (dealt <= 0) continue;
      this.hitNow.push(f.id);
      sim.emit({
        type: 'serpentHit',
        fighterId: f.id,
        damage: Math.round(dealt),
        pos: { x: s.pos.x, y: s.pos.y, z: s.pos.z },
      });
    }
  }
}
