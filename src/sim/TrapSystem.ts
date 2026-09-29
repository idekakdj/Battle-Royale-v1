/**
 * Arena traps (v1.2, UPGRADE-PLAN-v1.2 §3.2). Seeded placement at match start,
 * then a per-tick state machine per trap: armed → active (exactly 8 s) →
 * cooldown (20 s) → armed. All numbers come from `config/traps.ts`.
 *
 * Deterministic: placement uses its own mulberry32 stream (match seed XOR a
 * salt) so the sim RNG sequence is untouched; the tick iterates traps and
 * fighters in ascending id order. No per-tick allocation except event payloads.
 *
 * Damage is TRUE damage routed through the `deal` callback (World.applyTrapDamage):
 * no block/guard/armour/bloodlust/ult-charge, no flinch, no kill credit.
 */

import type { Difficulty, TrapKind, TrapState } from '../core/types';
import type { Fighter, Sim } from './Fighter';
import { mulberry32 } from '../core/math';
import {
  TRAP_COUNT_BY_DIFFICULTY,
  TRAP_ACTIVE_SECONDS,
  TRAP_REARM_SECONDS,
  TRAP_KINDS,
  TRAP_MAX_RADIUS,
  TRAP_PLACEMENT,
} from '../config/traps';
import { PILLARS, FALLEN_COLUMNS, CRATES, DAIS, PICKUP_PADS } from '../config/arena';
import { PICKUPS } from '../config/balance';
import { groundHeightAt } from './MovementSystem';

/** Sim-side trap: the public {@link TrapState} plus per-victim pulse timers. */
export interface TrapRuntime extends TrapState {
  /** Seconds until each fighter (by id) can take this trap's next pulse. */
  pulseT: Float64Array;
}

/** Applies true trap damage to a fighter; returns the hp actually removed. */
export type TrapDamageFn = (target: Fighter, amount: number) => number;

const EPS = 1e-6;
/** A fighter counts as standing on the sand (can trigger a plate) below this altitude (m). */
const GROUNDED_ALT = 0.3;

/** Build one trap (also used by tests to place a trap at a known spot). */
export function makeTrap(id: number, kind: TrapKind, x: number, z: number, fighterCount: number): TrapRuntime {
  return {
    id,
    kind,
    pos: { x, y: 0, z },
    radius: TRAP_KINDS[kind].radius,
    phase: 'armed',
    timeLeft: 0,
    triggeredBy: -1,
    pulseT: new Float64Array(Math.max(1, fighterCount)),
  };
}

// ── Placement ────────────────────────────────────────────────────────────────

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax;
  const abz = bz - az;
  const len2 = abx * abx + abz * abz;
  let t = len2 > 1e-9 ? ((px - ax) * abx + (pz - az) * abz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + abx * t);
  const dz = pz - (az + abz * t);
  return Math.sqrt(dx * dx + dz * dz);
}

/** Distance from (x,z) to the nearest obstacle SURFACE (pillars, columns, crates, dais). */
export function obstacleSurfaceDist(x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < PILLARS.length; i++) {
    const p = PILLARS[i];
    best = Math.min(best, Math.hypot(x - p.x, z - p.z) - p.radius);
  }
  for (let i = 0; i < FALLEN_COLUMNS.length; i++) {
    const c = FALLEN_COLUMNS[i];
    best = Math.min(best, segDist(x, z, c.ax, c.az, c.bx, c.bz) - c.thickness * 0.5);
  }
  for (let i = 0; i < CRATES.length; i++) {
    const c = CRATES[i];
    const dx = Math.max(0, Math.abs(x - c.x) - c.halfX);
    const dz = Math.max(0, Math.abs(z - c.z) - c.halfZ);
    best = Math.min(best, Math.sqrt(dx * dx + dz * dz));
  }
  best = Math.min(best, Math.hypot(x - DAIS.x, z - DAIS.z) - DAIS.radius);
  return best;
}

/** True if a trap disc of {@link TRAP_MAX_RADIUS} at (x,z) satisfies every clearance rule. */
export function trapSiteValid(
  x: number,
  z: number,
  spawns: readonly { x: number; z: number }[],
  others: readonly { pos: { x: number; z: number } }[],
): boolean {
  const R = TRAP_MAX_RADIUS;
  const P = TRAP_PLACEMENT;
  const d = Math.hypot(x, z);
  if (d < P.minRadius - EPS || d > P.maxRadius + EPS) return false;
  if (obstacleSurfaceDist(x, z) - R < P.obstacleClear) return false;
  for (let i = 0; i < PICKUP_PADS.length; i++) {
    const p = PICKUP_PADS[i];
    if (Math.hypot(x - p.x, z - p.z) - PICKUPS.radius - R < P.pickupClear) return false;
  }
  for (let i = 0; i < spawns.length; i++) {
    if (Math.hypot(x - spawns[i].x, z - spawns[i].z) - R < P.spawnClear) return false;
  }
  for (let i = 0; i < others.length; i++) {
    if (Math.hypot(x - others[i].pos.x, z - others[i].pos.z) - 2 * R < P.trapClear) return false;
  }
  return true;
}

/**
 * Seeded trap layout for a match: {@link TRAP_COUNT_BY_DIFFICULTY} traps (fewer
 * if the clearances cannot be met within {@link TRAP_PLACEMENT.maxAttempts}),
 * uniformly by area in the placement ring, kinds random with both kinds present
 * whenever two or more traps are placed.
 */
export function placeTraps(
  seed: number,
  difficulty: Difficulty,
  spawns: readonly { x: number; z: number }[],
  fighterCount: number,
): TrapRuntime[] {
  const want = TRAP_COUNT_BY_DIFFICULTY[difficulty] ?? 0;
  const out: TrapRuntime[] = [];
  if (want <= 0) return out;
  const rng = mulberry32((seed ^ TRAP_PLACEMENT.seedSalt) >>> 0);
  const r0 = TRAP_PLACEMENT.minRadius;
  const r1 = TRAP_PLACEMENT.maxRadius;
  for (let attempt = 0; attempt < TRAP_PLACEMENT.maxAttempts && out.length < want; attempt++) {
    const r = Math.sqrt(r0 * r0 + rng() * (r1 * r1 - r0 * r0));
    const th = rng() * Math.PI * 2;
    const x = Math.round(r * Math.cos(th) * 1e4) / 1e4;
    const z = Math.round(r * Math.sin(th) * 1e4) / 1e4;
    if (!trapSiteValid(x, z, spawns, out)) continue;
    out.push(makeTrap(out.length, 'fire', x, z, fighterCount));
  }
  // Kinds: random per trap, then guarantee both kinds appear.
  let fire = 0;
  for (let i = 0; i < out.length; i++) {
    const kind: TrapKind = rng() < 0.5 ? 'fire' : 'spikes';
    out[i].kind = kind;
    out[i].radius = TRAP_KINDS[kind].radius;
    if (kind === 'fire') fire++;
  }
  if (out.length >= 2 && (fire === 0 || fire === out.length)) {
    const last = out[out.length - 1];
    last.kind = last.kind === 'fire' ? 'spikes' : 'fire';
    last.radius = TRAP_KINDS[last.kind].radius;
  }
  return out;
}

// ── Tick ─────────────────────────────────────────────────────────────────────

function altitude(f: Fighter): number {
  return f.state.pos.y - groundHeightAt(f.state.pos.x, f.state.pos.z);
}

function inside(t: TrapRuntime, f: Fighter): boolean {
  const dx = f.state.pos.x - t.pos.x;
  const dz = f.state.pos.z - t.pos.z;
  return dx * dx + dz * dz <= t.radius * t.radius;
}

/** Can `f` step on (trigger) an armed plate? Grounded, alive, not burrowed/untargetable. */
export function canTriggerTrap(f: Fighter): boolean {
  const s = f.state;
  return s.alive && !f.untargetable && s.burrowT <= 0 && !s.airborne && altitude(f) <= GROUNDED_ALT;
}

/** Is `f` exposed to an active hazard of `kind` (low enough, alive, not burrowed/untargetable)? */
export function exposedToTrap(f: Fighter, kind: TrapKind): boolean {
  const s = f.state;
  return s.alive && !f.untargetable && s.burrowT <= 0 && altitude(f) <= TRAP_KINDS[kind].hazardHeight;
}

function pulseVictims(sim: Sim, t: TrapRuntime, deal: TrapDamageFn): void {
  const spec = TRAP_KINDS[t.kind];
  const fs = sim.fighters;
  for (let i = 0; i < fs.length; i++) {
    const f = fs[i];
    if (f.id >= t.pulseT.length) continue;
    if (t.pulseT[f.id] > EPS) continue;
    if (!inside(t, f) || !exposedToTrap(f, t.kind)) continue;
    const dealt = deal(f, spec.pulseDamage);
    t.pulseT[f.id] = spec.pulseInterval;
    if (dealt > 0) {
      sim.emit({
        type: 'trapDamage',
        trapId: t.id,
        kind: t.kind,
        targetId: f.id,
        damage: Math.round(dealt),
        pos: { x: f.state.pos.x, y: f.state.pos.y, z: f.state.pos.z },
      });
    }
  }
}

/** Advance every trap one tick (World calls this after movement, before deaths). */
export function updateTraps(sim: Sim, traps: TrapRuntime[], dt: number, deal: TrapDamageFn): void {
  for (let k = 0; k < traps.length; k++) {
    const t = traps[k];
    if (t.phase === 'armed') {
      const fs = sim.fighters;
      let trigger: Fighter | null = null;
      for (let i = 0; i < fs.length; i++) {
        const f = fs[i];
        if (canTriggerTrap(f) && inside(t, f)) {
          trigger = f;
          break;
        }
      }
      if (trigger === null) continue;
      t.phase = 'active';
      t.timeLeft = TRAP_ACTIVE_SECONDS;
      t.triggeredBy = trigger.id;
      t.pulseT.fill(0);
      sim.emit({
        type: 'trapTriggered',
        trapId: t.id,
        kind: t.kind,
        pos: { x: t.pos.x, y: t.pos.y, z: t.pos.z },
        fighterId: trigger.id,
      });
      // The hazard is up the same tick: the triggerer is hurt at once.
      pulseVictims(sim, t, deal);
      continue;
    }
    if (t.phase === 'active') {
      t.timeLeft -= dt;
      for (let i = 0; i < t.pulseT.length; i++) if (t.pulseT[i] > 0) t.pulseT[i] = Math.max(0, t.pulseT[i] - dt);
      if (t.timeLeft <= EPS) {
        t.phase = 'cooldown';
        t.timeLeft = TRAP_REARM_SECONDS;
        t.pulseT.fill(0);
        sim.emit({ type: 'trapExpired', trapId: t.id, kind: t.kind, pos: { x: t.pos.x, y: t.pos.y, z: t.pos.z } });
        continue;
      }
      pulseVictims(sim, t, deal);
      continue;
    }
    // Cooldown → re-arm.
    t.timeLeft -= dt;
    if (t.timeLeft <= EPS) {
      t.phase = 'armed';
      t.timeLeft = 0;
      t.triggeredBy = -1;
    }
  }
}

/** Deep copy for {@link WorldSnapshot.traps} (never aliases sim state). */
export function snapshotTraps(traps: readonly TrapRuntime[]): TrapState[] {
  const out: TrapState[] = new Array(traps.length);
  for (let i = 0; i < traps.length; i++) {
    const t = traps[i];
    out[i] = {
      id: t.id,
      kind: t.kind,
      pos: { x: t.pos.x, y: t.pos.y, z: t.pos.z },
      radius: t.radius,
      phase: t.phase,
      timeLeft: Math.max(0, t.timeLeft),
      triggeredBy: t.triggeredBy,
    };
  }
  return out;
}
