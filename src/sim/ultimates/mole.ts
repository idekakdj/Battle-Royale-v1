/**
 * Mole — Sinkhole Vortex (v1.3, redesigned ground-zone AoE).
 *
 *   cast    aim a point up to 10 m (snaps onto the foe you aim at); the zone is 4.5 m in radius.
 *   Windup  DIG 0.4 s (stage 0) then TUNNEL 0.9 s: the mole sinks in place, then races underground
 *           along the tremor crack toward the zone (untargetable from 0.3 s, uninterruptible) and
 *           ends at the pit's rim on the side it came from.
 *   Active  VORTEX 2.0 s (stage 1): the mole surfaces at the rim; the pit drags every GROUNDED foe in it
 *           toward the centre at 5 m/s (flyers / high jumpers are not pulled) and grinds them for 30/s
 *           (7.5 every 0.25 s, unblockable). Then the COLLAPSE (stage 2): 100 damage + root 2 s to all in
 *           the pit. The mole's +25% vs rooted targets is applied by the shared damage pipeline.
 *   Recovery 0.7 s (slam follow-through + shake-off), interruptible.
 *
 * The caster owns its position through the whole ultimate; the phase clocks (`state.actionT`) restart at
 * each phase so the rig can use `actionT / actionDur` per phase.
 *
 * Config: src/config/ultimates/mole.ts · AI: src/ai/ultScripts/mole.ts · Rig: src/render/animals/Mole.ts
 */

import { clamp01, dirToYaw } from '../../core/math';
import { MOLE_VORTEX as K } from '../../config/ultimates/mole';
import type { AbilityRuntime, Fighter, Sim } from '../Fighter';
import { altitudeOf, withinGroundReach } from '../hitbox';
import { clampToWall, groundHeightAt, resolveObstacles } from '../MovementSystem';
import { dealDamage } from '../CombatSystem';
import { AOE_HEIGHT, emitCastEvents, emitUltimateStage, emitUltimateTarget, hitArea, toRecovery, ultOpts } from './common';
import type { UltimateImpl } from './types';

interface Sink {
  /** Surfacing point at the pit's rim. */
  ex: number;
  ez: number;
  /** Direction of travel / facing toward the pit (unit). */
  ux: number;
  uz: number;
}

const STATE = new WeakMap<AbilityRuntime, Sink>();

const smooth = (u: number): number => u * u * (3 - 2 * u);

/** Where the mole surfaces (test / debug hook). */
export function sinkholeSurface(rt: AbilityRuntime | null): { x: number; z: number } | null {
  if (rt === null) return null;
  const s = STATE.get(rt);
  return s === undefined ? null : { x: s.ex, z: s.ez };
}

/** Pull one grounded foe `step` metres toward (cx, cz), respecting pillars/crates and the wall. */
function drag(sim: Sim, t: Fighter, cx: number, cz: number, dist: number, step: number): void {
  const s = t.state;
  const inv = 1 / Math.max(1e-6, dist);
  s.pos.x += (cx - s.pos.x) * inv * step;
  s.pos.z += (cz - s.pos.z) * inv * step;
  resolveObstacles(sim, t, false);
  clampToWall(t);
}

export const moleUltimate: UltimateImpl = {
  start(sim, f, rt, target) {
    const spec = rt.spec;
    const radius = spec.radius ?? 4.5;
    rt.px = target.to.x;
    rt.pz = target.to.z;
    // Where to come up: at the rim of the pit on the side we came from (nearer than the rim = stay put).
    let dx = rt.px - f.state.pos.x;
    let dz = rt.pz - f.state.pos.z;
    let dist = Math.hypot(dx, dz);
    if (dist < 1e-4) {
      dx = Math.sin(f.state.yaw);
      dz = Math.cos(f.state.yaw);
      dist = 0;
    } else {
      dx /= dist;
      dz /= dist;
    }
    const travel = Math.max(0, dist - (radius + K.surfaceGap));
    STATE.set(rt, { ex: f.state.pos.x + dx * travel, ez: f.state.pos.z + dz * travel, ux: dx, uz: dz });
    f.state.yaw = dirToYaw(dx, dz);
    // Ground markers (crack ribbon, pit zone, decals) are drawn by the VFX module: the generic ring is negligible.
    emitCastEvents(sim, f, rt, rt.px, rt.pz, 0.05, 0, spec.windup);
    emitUltimateTarget(sim, f, rt, target, spec.windup, { x: rt.px, z: rt.pz });
    f.ccImmuneChannel = true;
    f.state.actionDur = spec.windup;
  },

  windupTick(_sim, f, rt, dt) {
    const sk = STATE.get(rt);
    if (sk === undefined) return;
    const t = rt.t + dt;
    f.ccImmuneChannel = true;
    if (t >= K.hideAtS) f.untargetable = true;
    if (t > K.digS) {
      const u = smooth(clamp01((t - K.digS) / K.crackS));
      const s = f.state;
      const ox = s.pos.x;
      const oz = s.pos.z;
      s.pos.x = rt.sx + (sk.ex - rt.sx) * u;
      s.pos.z = rt.sz + (sk.ez - rt.sz) * u;
      clampToWall(f); // underground: no pillars, but never outside the arena
      s.pos.y = groundHeightAt(s.pos.x, s.pos.z, f.arena);
      const inv = dt > 1e-6 ? 1 / dt : 0;
      s.vel.x = (s.pos.x - ox) * inv;
      s.vel.z = (s.pos.z - oz) * inv;
    }
  },

  windupDuration(rt) {
    return rt.spec.windup;
  },

  activate(sim, f, rt) {
    const sk = STATE.get(rt);
    const s = f.state;
    if (sk !== undefined) {
      s.pos.x = sk.ex;
      s.pos.z = sk.ez;
      resolveObstacles(sim, f, false);
      clampToWall(f);
      s.yaw = dirToYaw(rt.px - s.pos.x, rt.pz - s.pos.z);
    }
    s.pos.y = groundHeightAt(s.pos.x, s.pos.z, sim.arena);
    s.vel.x = 0;
    s.vel.z = 0;
    f.untargetable = false; // surfaced at the rim: vulnerable, but the cast is uninterruptible
    f.ccImmuneChannel = true;
    rt.accum = 0;
    // Phase clock for the rig: the vortex has its own actionT/actionDur.
    s.actionT = 0;
    s.actionDur = K.vortexS;
    emitUltimateStage(sim, f, rt, 1, { x: rt.px, y: groundHeightAt(rt.px, rt.pz, sim.arena), z: rt.pz });
  },

  activeTick(sim, f, rt, dt) {
    const spec = rt.spec;
    const radius = spec.radius ?? 4.5;
    f.ccImmuneChannel = true;
    f.untargetable = false;
    rt.t += dt;
    rt.accum += dt;
    let tick = false;
    if (rt.accum >= K.tickS) {
      rt.accum -= K.tickS;
      tick = true;
    }
    const cy = groundHeightAt(rt.px, rt.pz, sim.arena);
    const fs = sim.fighters;
    for (let i = 0; i < fs.length; i++) {
      const t = fs[i];
      if (t === f || !t.state.alive || t.untargetable) continue;
      if (!withinGroundReach(t)) continue; // flyers / high jumpers are out of the pit's reach
      const dx = rt.px - t.state.pos.x;
      const dz = rt.pz - t.state.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > radius + t.def.radius) continue;
      if (Math.abs(t.state.pos.y - cy) > AOE_HEIGHT) continue;
      if (tick) {
        // Grinding damage: unblockable, no flinch (the pull is the crowd control).
        dealDamage(sim, f, t, K.tickDps * K.tickS, { blockable: false, heavy: false, reaction: 'none', isBasic: false });
      }
      if (!t.state.alive) continue;
      if (t.ccImmune || t.state.grabbedById !== -1 || t.state.grabTargetId !== -1) continue;
      if (altitudeOf(t) > K.groundedAlt) continue; // a hop or a glide breaks the pull
      const step = Math.min(K.pullSpeed * dt, Math.max(0, dist - 0.35));
      if (step > 0) drag(sim, t, rt.px, rt.pz, dist, step);
    }
    if (rt.t >= K.vortexS) collapse(sim, f, rt);
  },

  recoveryDuration() {
    return K.recoveryS;
  },

  abort(_sim, f) {
    f.untargetable = false;
    f.ccImmuneChannel = false;
  },
};

/** The pit caves in: damage + root everything inside, then recover. */
function collapse(sim: Sim, f: Fighter, rt: AbilityRuntime): void {
  const spec = rt.spec;
  const any = hitArea(sim, f, {
    shape: 'circle',
    cx: rt.px,
    cz: rt.pz,
    cy: groundHeightAt(rt.px, rt.pz, sim.arena),
    yaw: f.state.yaw,
    range: spec.radius ?? 4.5,
    arcDeg: 360,
    heightTol: AOE_HEIGHT,
    base: spec.damage ?? K.collapseDamage,
    opts: ultOpts('stagger'),
    effects: spec.effects,
    // +25% vs rooted is applied for all mole damage in dealDamage.
  });
  rt.didHit = any;
  f.ccImmuneChannel = false;
  emitUltimateStage(sim, f, rt, 2, { x: rt.px, y: groundHeightAt(rt.px, rt.pz, sim.arena), z: rt.pz });
  f.state.actionT = 0;
  f.state.actionDur = K.recoveryS;
  toRecovery(rt);
}
