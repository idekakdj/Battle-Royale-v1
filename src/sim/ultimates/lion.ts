/**
 * Lion — ROYAL HUNT (v1.3 Phase 2). A lock-on ultimate:
 *
 *   cast          eyes lock on the victim (reticle + arc on the client); requireTarget, 12 m
 *   0 – 0.55 s    coil (interruptible); the landing point homes on the victim (≤ homingSpeed)
 *   0.55 – 1.05   bounding pounce (~0.5 s arc; the lion is CC-immune from here to the end)
 *   touchdown     victim in reach → 65 dmg (guard-piercing) + knockdown pin; no one in reach → whiff (0.9 s recovery)
 *   4 strikes     0.3 s apart, 48 each (guard-piercing), one `ultimateStage` per strike (3..6)
 *   roar          stage 7: 35 dmg + stagger, MARK (+20% damage taken 6 s), lion +20% speed 4 s
 *   0.45 s        settle → end
 *
 * Beats (ultimateStage): 1 pounce leaves the ground · 2 touchdown · 3..6 maul strikes · 7 roar.
 * The timeline is fixed (LION_HUNT) so the rig, VFX and audio key off the same clock.
 * Damage totals (unblocked victim): 65 + 4 × 48 + 35 = 292.
 * Config: src/config/ultimates/lion.ts · AI: src/ai/ultScripts/lion.ts
 */

import { LION_HUNT as H, LION_T_LAND } from '../../config/ultimates/lion';
import { dirToYaw, lerp } from '../../core/math';
import type { Vec3 } from '../../core/types';
import { dealDamage } from '../CombatSystem';
import type { AbilityRuntime, Fighter, Sim } from '../Fighter';
import { isTargetable, withinGroundReach } from '../hitbox';
import { clampToWall, groundHeightAt, resolveObstacles } from '../MovementSystem';
import { KNOCKDOWN_RISE } from '../simTuning';
import { applyEffect } from '../StatusEffects';
import { emitCastEvents, emitUltimateStage, emitUltimateTarget, toRecovery } from './common';
import type { UltimateImpl } from './types';

/** rt.counter sub-states of the Active phase. */
const SUB_LEAP = 0;
const SUB_MAUL = 1;
/** rt.hitOnce keys: strike k → k, the roar → ROAR_KEY. */
const ROAR_KEY = 100;

function victimOf(sim: Sim, rt: AbilityRuntime): Fighter | undefined {
  return rt.lockId >= 0 ? sim.fighters[rt.lockId] : undefined;
}

function dist2(ax: number, az: number, bx: number, bz: number): number {
  return Math.sqrt((ax - bx) * (ax - bx) + (az - bz) * (az - bz));
}

/** Where the lion should land for victim `v` when it leaps from (sx,sz): short of the victim, on the near side. */
function idealLanding(f: Fighter, v: Fighter, sx: number, sz: number, out: { x: number; z: number }): void {
  const dx = v.state.pos.x - sx;
  const dz = v.state.pos.z - sz;
  const d = Math.sqrt(dx * dx + dz * dz);
  const off = (f.def.radius + v.def.radius) * H.landOffsetFrac;
  if (d <= off + 0.05) {
    out.x = sx;
    out.z = sz;
    return;
  }
  out.x = v.state.pos.x - (dx / d) * off;
  out.z = v.state.pos.z - (dz / d) * off;
}

const _ideal = { x: 0, z: 0 };

/** Slide the tracked landing point toward the victim by at most homingSpeed × dt. */
function trackLanding(f: Fighter, v: Fighter | undefined, rt: AbilityRuntime, dt: number): void {
  if (v === undefined || !v.state.alive) return; // hold the last point
  idealLanding(f, v, rt.sx, rt.sz, _ideal);
  const dx = _ideal.x - rt.px;
  const dz = _ideal.z - rt.pz;
  const d = Math.sqrt(dx * dx + dz * dz);
  const step = H.homingSpeed * dt;
  if (d <= step || d < 1e-6) {
    rt.px = _ideal.x;
    rt.pz = _ideal.z;
  } else {
    rt.px += (dx / d) * step;
    rt.pz += (dz / d) * step;
  }
}

/**
 * Let go of a pinned victim: they get up over the standard 0.3 s rise. (The fall / hold / rise pose clock is the
 * generic knockdown clock in `World.resolveAction`, so this just shortens the timer.)
 */
function releasePin(v: Fighter | undefined): void {
  if (v === undefined) return;
  if (v.knockdownTimer > KNOCKDOWN_RISE) v.knockdownTimer = KNOCKDOWN_RISE;
}

/** Pin = a long knockdown (`pinTotal`); the victim's pose clock comes from the generic knockdown clock. */
function pinVictim(v: Fighter): void {
  if (v.ccImmune) return; // a stampeding rhino / raging gorilla cannot be pinned (the maul still follows them)
  v.blocking = false;
  v.knockdownTimer = Math.max(v.knockdownTimer, H.pinTotal);
  v.interrupt();
}

/** Keep the mauling lion on the victim's near side, facing them. */
function attach(sim: Sim, f: Fighter, v: Fighter, rt: AbilityRuntime): void {
  const s = f.state;
  const dx = v.state.pos.x - s.pos.x;
  const dz = v.state.pos.z - s.pos.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d > 0.05) {
    rt.dirX = dx / d;
    rt.dirZ = dz / d;
  }
  const off = (f.def.radius + v.def.radius) * H.landOffsetFrac;
  s.pos.x = v.state.pos.x - rt.dirX * off;
  s.pos.z = v.state.pos.z - rt.dirZ * off;
  resolveObstacles(sim, f, false);
  clampToWall(f);
  s.pos.y = groundHeightAt(s.pos.x, s.pos.z, sim.arena);
  s.yaw = dirToYaw(rt.dirX, rt.dirZ);
  s.vel.x = 0;
  s.vel.z = 0;
}

/** Is the victim still something the lion's claws can reach? */
function reachable(f: Fighter, v: Fighter | undefined, extra: number): v is Fighter {
  if (v === undefined || !v.state.alive || !isTargetable(v) || !withinGroundReach(v)) return false;
  return dist2(f.state.pos.x, f.state.pos.z, v.state.pos.x, v.state.pos.z) <= f.def.radius + v.def.radius + extra;
}

export const lionUltimate: UltimateImpl = {
  start(sim, f, rt, target) {
    const spec = rt.spec;
    rt.sx = f.state.pos.x;
    rt.sz = f.state.pos.z;
    rt.px = rt.sx;
    rt.pz = rt.sz;
    const v = victimOf(sim, rt);
    if (v !== undefined) {
      idealLanding(f, v, rt.sx, rt.sz, _ideal);
      rt.px = _ideal.x;
      rt.pz = _ideal.z;
    }
    rt.counter = SUB_LEAP;
    rt.accum = 0;
    emitCastEvents(sim, f, rt, target.to.x, target.to.z, spec.radius ?? 1.9, 360, spec.windup);
    emitUltimateTarget(sim, f, rt, target, LION_T_LAND);
  },

  windupTick(sim, f, rt, dt) {
    const v = victimOf(sim, rt);
    trackLanding(f, v, rt, dt);
    const s = f.state;
    s.vel.x = 0;
    s.vel.z = 0;
    if (v !== undefined && v.state.alive) {
      const dx = v.state.pos.x - s.pos.x;
      const dz = v.state.pos.z - s.pos.z;
      if (dx * dx + dz * dz > 0.01) s.yaw = dirToYaw(dx, dz);
    }
  },

  activate(sim, f, rt) {
    // From the moment the lion leaves the ground it cannot be interrupted.
    f.ccImmuneChannel = true;
    rt.counter = SUB_LEAP;
    rt.accum = 0;
    rt.sx = f.state.pos.x;
    rt.sz = f.state.pos.z;
    emitUltimateStage(sim, f, rt, H.stage.leap, { x: rt.px, y: groundHeightAt(rt.px, rt.pz, sim.arena), z: rt.pz });
  },

  activeTick(sim, f, rt, dt) {
    if (rt.counter === SUB_LEAP) leapTick(sim, f, rt, dt);
    else maulTick(sim, f, rt, dt);
  },

  recoveryDuration(rt) {
    return rt.didHit ? H.recovery : rt.spec.recovery ?? 0.9;
  },

  abort(sim, _f, rt) {
    releasePin(victimOf(sim, rt));
  },
};

function leapTick(sim: Sim, f: Fighter, rt: AbilityRuntime, dt: number): void {
  const s = f.state;
  rt.accum += dt;
  const frac = Math.min(1, rt.accum / H.leapT);
  if (frac < 0.75) trackLanding(f, victimOf(sim, rt), rt, dt); // the last quarter of the flight is committed
  const ox = s.pos.x;
  const oz = s.pos.z;
  const oy = s.pos.y;
  s.pos.x = lerp(rt.sx, rt.px, frac);
  s.pos.z = lerp(rt.sz, rt.pz, frac);
  clampToWall(f);
  const run = dist2(rt.sx, rt.sz, rt.px, rt.pz);
  const peak = Math.min(H.leapPeakMax, H.leapPeakBase + H.leapPeakPerM * run);
  const gy = groundHeightAt(s.pos.x, s.pos.z, sim.arena);
  s.pos.y = gy + peak * 4 * frac * (1 - frac);
  s.airborne = frac < 1;
  s.vel.x = (s.pos.x - ox) / dt;
  s.vel.z = (s.pos.z - oz) / dt;
  s.vel.y = (s.pos.y - oy) / dt;
  const dx = rt.px - rt.sx;
  const dz = rt.pz - rt.sz;
  if (dx * dx + dz * dz > 0.04) s.yaw = dirToYaw(dx, dz);
  if (frac >= 1) touchdown(sim, f, rt);
}

function touchdown(sim: Sim, f: Fighter, rt: AbilityRuntime): void {
  const s = f.state;
  const spec = rt.spec;
  s.pos.x = rt.px;
  s.pos.z = rt.pz;
  resolveObstacles(sim, f, false);
  clampToWall(f);
  s.pos.y = groundHeightAt(s.pos.x, s.pos.z, sim.arena);
  s.airborne = false;
  s.vel.x = 0;
  s.vel.y = 0;
  s.vel.z = 0;

  const v = victimOf(sim, rt);
  const hit = reachable(f, v, H.landReach);
  const at: Vec3 = v !== undefined ? { x: v.state.pos.x, y: v.state.pos.y, z: v.state.pos.z } : { x: s.pos.x, y: s.pos.y, z: s.pos.z };
  emitUltimateStage(sim, f, rt, H.stage.pin, at);

  if (!hit || v === undefined) {
    // Whiff: the victim was out of reach (ran, jumped, burrowed) — punishable recovery.
    rt.didHit = false;
    f.ccImmuneChannel = false;
    toRecovery(rt);
    return;
  }
  rt.didHit = true;
  const dx = v.state.pos.x - s.pos.x;
  const dz = v.state.pos.z - s.pos.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d > 0.05) {
    rt.dirX = dx / d;
    rt.dirZ = dz / d;
  }
  s.yaw = dirToYaw(rt.dirX, rt.dirZ);
  dealDamage(sim, f, v, spec.damage ?? 60, { blockable: true, heavy: true, reaction: 'none', isBasic: false, blockIgnore: 1 });
  pinVictim(v);
  rt.counter = SUB_MAUL;
  rt.accum = 0;
}

function maulTick(sim: Sim, f: Fighter, rt: AbilityRuntime, dt: number): void {
  const spec = rt.spec;
  rt.accum += dt;
  const t = rt.accum;
  const v = victimOf(sim, rt);
  if (v !== undefined && v.state.alive) {
    attach(sim, f, v, rt);
  }
  const at = (): Vec3 =>
    v !== undefined ? { x: v.state.pos.x, y: v.state.pos.y, z: v.state.pos.z } : { x: f.state.pos.x, y: f.state.pos.y, z: f.state.pos.z };

  // Strike beats: stage 3+k starts at firstStrike + k × gap; the claws land `impactDelay` later.
  let started = rt.stage >= H.stage.roar ? H.strikes : Math.max(0, rt.stage - H.stage.pin); // stage 2 = none begun, 3 = one, …
  while (started < H.strikes && t >= H.firstStrike + started * H.strikeGap) {
    emitUltimateStage(sim, f, rt, H.stage.strike0 + started, at());
    started += 1;
  }
  for (let k = 0; k < started; k++) {
    if (rt.hitOnce.has(k) || t < H.firstStrike + k * H.strikeGap + H.impactDelay) continue;
    rt.hitOnce.add(k);
    if (reachable(f, v, 1.6)) {
      dealDamage(sim, f, v, spec.bonusDamage ?? 45, {
        blockable: true,
        heavy: k >= 2,
        reaction: 'none',
        isBasic: false,
        blockIgnore: 1,
      });
    }
  }

  // Roar: face-to-face, marks the victim, the lion surges.
  const lastStrike = H.stage.strike0 + H.strikes - 1;
  if (rt.stage === lastStrike && t >= H.roarLead) emitUltimateStage(sim, f, rt, H.stage.roar, at());
  if (rt.stage === H.stage.roar && !rt.hitOnce.has(ROAR_KEY) && t >= H.roarLead + H.roarImpactDelay) {
    rt.hitOnce.add(ROAR_KEY);
    if (reachable(f, v, 2.4)) {
      const res = dealDamage(sim, f, v, H.roarDamage, { blockable: false, heavy: true, reaction: 'stagger', isBasic: false });
      if (res.hit) {
        if (spec.effects !== undefined) for (const e of spec.effects) applyEffect(sim, f, v, e);
        if (spec.bonusEffects !== undefined) for (const e of spec.bonusEffects) applyEffect(sim, f, v, e);
      }
    }
    if (spec.selfBuffs !== undefined) for (const b of spec.selfBuffs) applyEffect(sim, f, f, b);
  }
  if (rt.stage === H.stage.roar && t >= H.roarLead + H.roarHold) toRecovery(rt);
}
