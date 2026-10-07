/**
 * TerrainSystem (v1.8, docs/JUNGLE-PLAN.md): the mechanics of the arena's `terrain` zones — moss patches and the shallow pool.
 * World owns ONE (`world.terrain`) and steps it once per tick BEFORE the decisions/locomotion phases, fighters in ascending id,
 * so everything later in the tick (the mole's Burrow rule, MovementSystem.locomote, the snapshot) sees this tick's flags.
 *
 * Per fighter it maintains
 *  - `inWater`  grounded (alive, not burrowed / untargetable, altitude ≤ TERRAIN.groundedAlt) AND the fighter's CENTRE inside a
 *               water disc. Shoreline hysteresis: it enters at radius R and only leaves beyond R + `shorelineHysteresis`.
 *  - `onMoss`   grounded AND the body circle overlaps a moss disc (no hysteresis; the slow itself lingers).
 *  - `terrainSpeedMult`  water multiplier (per-animal, from `AnimalDef.swim`) × moss factor (1 − 0.35, clinging `lingerS` after
 *               leaving the patch). Exactly 1 off terrain. MovementSystem.locomote multiplies ordinary run/walk speed by it and
 *               nothing else does: dashes, pounces, charges, leaps, soar/glide, knockback, grabs and ultimate-driven movement
 *               are untouched. A fighter that is airborne above the grounded line (jump apex, flight), burrowed or untargetable
 *               is unaffected (flags false, multiplier 1).
 * and emits `{type:'splash'}` (strength from the larger of the sim velocity and the real displacement per tick) whenever `inWater` flips for a physical reason (stepping in / out, landing in the pool from a jump
 * = entering, jumping / being launched out = leaving). Flips caused by burrowing / going untargetable, and a fighter's death, are
 * silent. The arena without terrain (the colosseum) makes `step` a no-op: no field is ever touched, no RNG, no event.
 *
 * Deterministic: no RNG, fighters in ascending id, zones in `ArenaDef.terrain` order, timers advance by `dt` only.
 */

import type { Fighter, Sim } from './Fighter';
import type { ArenaDef } from '../config/arenas';
import { MOSS_SPEED_MULT, TERRAIN, WATER_BLOCKED_SPECIALS, splashStrength, waterSpeedMultiplier } from '../config/terrain';
import { altitudeOf } from './hitbox';

/** A circular terrain zone ready for the hot loop. */
interface Disc {
  x: number;
  z: number;
  r: number;
  /** Water only: surface height (m) above the ground = the visible depth. */
  surface: number;
}

export class TerrainSystem {
  private readonly water: Disc[] = [];
  private readonly moss: Disc[] = [];
  /** False when the arena has no terrain zones (the colosseum): `step` returns immediately. */
  readonly active: boolean;

  constructor(arena: ArenaDef) {
    for (const z of arena.terrain) {
      const d: Disc = { x: z.x, z: z.z, r: z.radius, surface: z.depth ?? 0 };
      if (z.kind === 'water') this.water.push(d);
      else this.moss.push(d);
    }
    this.active = this.water.length + this.moss.length > 0;
  }

  /** Index of the water disc whose interior contains (x, z), −1 when none. `grow` widens every disc (hysteresis). Pure. */
  waterIndexAt(x: number, z: number, grow = 0): number {
    for (let i = 0; i < this.water.length; i++) {
      const w = this.water[i];
      const dx = x - w.x;
      const dz = z - w.z;
      const r = w.r + grow;
      if (dx * dx + dz * dz <= r * r) return i;
    }
    return -1;
  }

  /** Does a body circle (x, z, radius) overlap a moss disc? Pure. */
  mossOverlaps(x: number, z: number, radius: number): boolean {
    for (let i = 0; i < this.moss.length; i++) {
      const m = this.moss[i];
      const dx = x - m.x;
      const dz = z - m.z;
      const r = m.r + radius;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }

  /** Surface height (m above the ground) of water disc `index`. */
  surfaceOf(index: number): number {
    return index >= 0 && index < this.water.length ? this.water[index].surface : 0;
  }

  /** Advance one tick (World calls this before decisions and locomotion). */
  step(sim: Sim, dt: number): void {
    if (!this.active) return;
    const fs = sim.fighters;
    for (let i = 0; i < fs.length; i++) {
      const f = fs[i];
      if (!f.state.alive) {
        clearTerrain(f);
        continue;
      }
      this.stepFighter(sim, f, dt);
    }
  }

  private stepFighter(sim: Sim, f: Fighter, dt: number): void {
    const s = f.state;
    // Speed through the waterline for the splash strength: the larger of the sim velocity and the real displacement since the
    // last tick (ability-driven moves — pounce, lunge, rush, blink — leave `vel` at 0 but do move the fighter).
    let hSpeed = Math.hypot(s.vel.x, s.vel.z);
    let vSpeed = Math.abs(s.vel.y);
    if (f.terrainPrevX === f.terrainPrevX) {
      hSpeed = Math.max(hSpeed, Math.hypot(s.pos.x - f.terrainPrevX, s.pos.z - f.terrainPrevZ) / dt);
      vSpeed = Math.max(vSpeed, Math.abs(s.pos.y - f.terrainPrevY) / dt);
    }
    f.terrainPrevX = s.pos.x;
    f.terrainPrevY = s.pos.y;
    f.terrainPrevZ = s.pos.z;
    const phased = f.untargetable || s.burrowT > 0; // underground / out of the world: terrain cannot touch it
    const grounded = !phased && altitudeOf(f) <= TERRAIN.groundedAlt;

    // ── Water ────────────────────────────────────────────────────────────────
    let zone = -1;
    if (grounded) {
      // Already wading? keep the same disc until the centre is farther than R + hysteresis.
      if (f.waterZone >= 0 && f.waterZone < this.water.length) {
        const w = this.water[f.waterZone];
        const dx = s.pos.x - w.x;
        const dz = s.pos.z - w.z;
        const keep = w.r + TERRAIN.water.shorelineHysteresis;
        if (dx * dx + dz * dz <= keep * keep) zone = f.waterZone;
      }
      if (zone < 0) zone = this.waterIndexAt(s.pos.x, s.pos.z);
    }
    const wasIn = f.inWater;
    const nowIn = zone >= 0;
    if (wasIn !== nowIn) {
      if (!phased) {
        const surf = this.surfaceOf(nowIn ? zone : f.waterZone);
        sim.emit({
          type: 'splash',
          fighterId: f.id,
          pos: { x: s.pos.x, y: surf, z: s.pos.z },
          entering: nowIn,
          strength: splashStrength(hSpeed, vSpeed),
        });
      }
      f.inWater = nowIn;
    }
    f.waterZone = zone;

    // ── Moss (+ linger) ──────────────────────────────────────────────────────
    const onMoss = grounded && this.mossOverlaps(s.pos.x, s.pos.z, f.def.radius);
    f.onMoss = onMoss;
    if (onMoss) f.mossLingerT = TERRAIN.moss.lingerS;
    else if (!grounded) f.mossLingerT = 0;
    else if (f.mossLingerT > 0) f.mossLingerT = Math.max(0, f.mossLingerT - dt);

    // ── Combined multiplier ──────────────────────────────────────────────────
    let mult = 1;
    if (nowIn) mult *= waterSpeedMultiplier(f.def);
    if (f.mossLingerT > 0) mult *= MOSS_SPEED_MULT;
    f.terrainSpeedMult = mult;
  }
}

/** Back to the neutral, off-terrain state (death; also used by tests). */
function clearTerrain(f: Fighter): void {
  f.inWater = false;
  f.onMoss = false;
  f.waterZone = -1;
  f.mossLingerT = 0;
  f.terrainSpeedMult = 1;
  f.terrainPrevX = Number.NaN;
  f.terrainPrevY = Number.NaN;
  f.terrainPrevZ = Number.NaN;
}

/**
 * True when `f` may not start its special right now because of terrain (the mole's Burrow does nothing in the water: the cast
 * fizzles, the cooldown is not consumed and no animation starts). World checks this before `startSpecial`.
 */
export function specialBlockedByTerrain(f: Fighter): boolean {
  return f.inWater && WATER_BLOCKED_SPECIALS.includes(f.def.id);
}
