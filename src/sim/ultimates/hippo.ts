/**
 * Hippo — Riverlord's Flood (v1.3: a line wave that leaves a slowing mud pool).
 *
 *   cast    the path is the aim line, `HIPPO_FLOOD.length` (11 m) x `width` (3.4 m), clipped at the arena wall.
 *   Windup  GAPE 0.9 s (stage 0): the hippo plants itself facing the path, rears up and bellows. Interruptible
 *           by a stagger like any windup. `ultimateTarget` (kind 'line') marks the rectangle.
 *   Active  SLAM + SURGE (stage 1): both forefeet slam down and a wave races along the path at 14 m/s. Every
 *           grounded fighter the wave head passes (body overlapping the rectangle) is hit ONCE: 130, blockable,
 *           shoved 5 m along the path, staggered. The surge is uninterruptible (the hippo is planted). At the
 *           slam the MUD POOL is laid (src/sim/groundZones.ts): the rectangle fills as the wave passes and stays
 *           for 5.5 s, slowing every grounded fighter in it 40% (the hippo itself is unaffected).
 *   Recovery 0.7 s heavy exhale (stage 2), interruptible.
 *
 * The caster owns its position for the whole ultimate; the phase clocks (`state.actionT`) restart at each phase
 * so the rig can use `actionT / actionDur` per phase. The mud outlives the ultimate (and the caster).
 *
 * Config: src/config/ultimates/hippo.ts · AI: src/ai/ultScripts/hippo.ts · Rig: src/render/animals/Hippo.ts
 */

import { clamp01 } from '../../core/math';
import { HIPPO_FLOOD as K, floodSurgeS } from '../../config/ultimates/hippo';
import type { AbilityRuntime, Fighter, Sim } from '../Fighter';
import { dealDamage } from '../CombatSystem';
import { spawnGroundZone } from '../groundZones';
import { withinGroundReach } from '../hitbox';
import { groundHeightAt } from '../MovementSystem';
import { applyDirectionalKnockback } from '../StatusEffects';
import { emitCastEvents, emitUltimateStage, emitUltimateTarget, toRecovery, ultOpts } from './common';
import type { UltimateImpl } from './types';

/** Per-cast geometry (kept off the shared AbilityRuntime shape). */
interface Flood {
  ax: number;
  az: number;
  dx: number;
  dz: number;
  len: number;
  surgeS: number;
}

const STATE = new WeakMap<AbilityRuntime, Flood>();

/** The path of a running Flood (test / debug hook): start, unit direction and length. */
export function floodPath(rt: AbilityRuntime | null): { ax: number; az: number; dx: number; dz: number; len: number } | null {
  if (rt === null) return null;
  const s = STATE.get(rt);
  return s === undefined ? null : { ax: s.ax, az: s.az, dx: s.dx, dz: s.dz, len: s.len };
}

function get(rt: AbilityRuntime): Flood {
  let s = STATE.get(rt);
  if (s === undefined) {
    s = { ax: rt.sx, az: rt.sz, dx: rt.dirX, dz: rt.dirZ, len: K.length, surgeS: floodSurgeS(K.length) };
    STATE.set(rt, s);
  }
  return s;
}

export const hippoUltimate: UltimateImpl = {
  start(sim, f, rt, target) {
    const s = get(rt);
    s.ax = f.state.pos.x;
    s.az = f.state.pos.z;
    s.dx = Math.sin(f.state.yaw);
    s.dz = Math.cos(f.state.yaw);
    // The resolved line end already stops 0.5 m inside the wall.
    s.len = Math.max(K.minLength, Math.hypot(target.to.x - s.ax, target.to.z - s.az));
    s.surgeS = floodSurgeS(s.len);
    rt.px = s.ax + s.dx * s.len;
    rt.pz = s.az + s.dz * s.len;
    // The marker (rectangle + chevrons) is drawn by the VFX module: the generic ground ring is negligible.
    emitCastEvents(sim, f, rt, s.ax, s.az, 0.05, 0, K.windupS);
    emitUltimateTarget(sim, f, rt, target, K.windupS, { x: rt.px, z: rt.pz });
    f.state.actionDur = K.windupS;
  },

  windupTick(_sim, f) {
    // Planted: the hippo rears up facing the path (locomotion is skipped: the cast owns the position).
    f.state.vel.x = 0;
    f.state.vel.z = 0;
  },

  windupDuration() {
    return K.windupS;
  },

  activate(sim, f, rt) {
    const s = get(rt);
    f.ccImmuneChannel = true; // the surge cannot be interrupted: the forefeet are planted
    f.state.vel.x = 0;
    f.state.vel.z = 0;
    rt.accum = 0;
    // Phase clock for the rig: the slam + surge has its own actionT/actionDur.
    f.state.actionT = 0;
    f.state.actionDur = s.surgeS;
    // The mud is laid as the wave passes and stays for `mudS` from the slam.
    spawnGroundZone(sim, {
      kind: 'mud',
      ownerId: f.id,
      ax: s.ax,
      az: s.az,
      dx: s.dx,
      dz: s.dz,
      len: s.len,
      halfWidth: K.width * 0.5,
      growS: s.surgeS,
      lifeS: K.mudS,
      slow: K.mudSlow,
      ownerSlow: K.mudSlowOwner,
      slowLingerS: K.slowLingerS,
      groundedAlt: K.groundedAlt,
    });
    emitUltimateStage(sim, f, rt, 1, { x: s.ax + s.dx * 1.6, y: groundHeightAt(s.ax, s.az), z: s.az + s.dz * 1.6 });
  },

  activeTick(sim, f, rt, dt) {
    const s = get(rt);
    f.ccImmuneChannel = true;
    rt.accum += dt;
    const head = Math.min(s.len, K.waveSpeed * rt.accum);
    waveHits(sim, f, rt, s, head);
    if (rt.accum >= s.surgeS) {
      f.ccImmuneChannel = false;
      emitUltimateStage(sim, f, rt, 2);
      f.state.actionT = 0;
      f.state.actionDur = K.recoveryS;
      toRecovery(rt);
    }
  },

  recoveryDuration() {
    return K.recoveryS;
  },

  abort(_sim, f) {
    f.ccImmuneChannel = false;
  },
};

/** Hit every fighter the wave head has reached (once each): damage, directional shove, stagger. */
function waveHits(sim: Sim, f: Fighter, rt: AbilityRuntime, s: Flood, head: number): void {
  const fs = sim.fighters;
  for (let i = 0; i < fs.length; i++) {
    const t = fs[i];
    if (t === f || !t.state.alive || t.untargetable || rt.hitOnce.has(t.id)) continue;
    if (!withinGroundReach(t)) continue; // a high jump / flight clears the flood
    const rx = t.state.pos.x - s.ax;
    const rz = t.state.pos.z - s.az;
    const along = rx * s.dx + rz * s.dz;
    const lat = Math.abs(rx * s.dz - rz * s.dx);
    const r = t.def.radius;
    if (lat > K.width * 0.5 + r) continue;
    if (along < -r || along - r > head) continue; // behind the hippo, or the head has not reached them yet
    rt.hitOnce.add(t.id);
    const res = dealDamage(sim, f, t, rt.spec.damage ?? K.damage, ultOpts('stagger'));
    if (res.hit) {
      applyDirectionalKnockback(t, s.dx, s.dz, rt.spec.knockback ?? K.knockback);
      rt.didHit = true;
    }
  }
}

/** 0..1 progress of the surge inside the Active phase (debug / test hook). */
export function floodProgress(rt: AbilityRuntime | null): number {
  if (rt === null) return 0;
  const s = STATE.get(rt);
  return s === undefined ? 0 : clamp01(rt.accum / s.surgeS);
}
