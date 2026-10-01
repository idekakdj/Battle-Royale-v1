/**
 * Panther — SHADOW EXECUTION (v1.3 Phase 2). A lock-on ultimate:
 *
 *   cast          lock a foe within 11 m (requireTarget); melt into shadow (stealth fade) — interruptible
 *   0.35 s        CC-immune + −60% damage taken from here until the recovery
 *   5 strikes     blink to a new angle around the victim every 0.22 s (stage 1..5); the claws land
 *                 0.08 s after each blink: 40 dmg, half-piercing guard, brief flinch
 *   finisher      a sixth blink lands BEHIND the victim (stage 6); 0.16 s later a heavy two-paw strike:
 *                 85 dmg (+90 execute bonus, stage 7 flash, when the victim is below 35% HP) + stagger
 *   recovery      ~1 s, visible again (stage 8), vulnerable; a broken sequence (victim dead / untargetable)
 *                 recovers 0.5 s
 *
 * Damage totals (unblocked victim): 5 × 40 + 85 = 285 (375 with the execute bonus). The backstab passive is
 * NOT stacked on top (allowBackstab: false) so the numbers stay exact.
 * Config: src/config/ultimates/panther.ts · AI: src/ai/ultScripts/panther.ts
 */

import { PANTHER_EXEC as E, PANTHER_T_RECOVERY } from '../../config/ultimates/panther';
import { dirToYaw } from '../../core/math';
import type { Vec3 } from '../../core/types';
import { dealDamage } from '../CombatSystem';
import type { AbilityRuntime, Fighter, Sim } from '../Fighter';
import { isTargetable, withinGroundReach } from '../hitbox';
import { removeBuff, applyEffect } from '../StatusEffects';
import { blink, emitCastEvents, emitUltimateStage, emitUltimateTarget, toRecovery } from './common';
import type { UltimateImpl } from './types';

/** Stage number of the reappearance beat (recovery start). */
export const PANTHER_STAGE_REAPPEAR = 8;

function victimOf(sim: Sim, rt: AbilityRuntime): Fighter | undefined {
  return rt.lockId >= 0 ? sim.fighters[rt.lockId] : undefined;
}

/** Victim still a valid mark for the sequence (alive and targetable; airborne is allowed — those strikes just miss). */
function markable(v: Fighter | undefined): v is Fighter {
  return v !== undefined && v.state.alive && isTargetable(v);
}

function strikeReachable(f: Fighter, v: Fighter): boolean {
  if (!isTargetable(v) || !withinGroundReach(v)) return false;
  const dx = v.state.pos.x - f.state.pos.x;
  const dz = v.state.pos.z - f.state.pos.z;
  return Math.sqrt(dx * dx + dz * dz) <= f.def.radius + v.def.radius + E.strikeReach;
}

function faceVictim(f: Fighter, v: Fighter): void {
  const dx = v.state.pos.x - f.state.pos.x;
  const dz = v.state.pos.z - f.state.pos.z;
  if (dx * dx + dz * dz > 1e-6) f.state.yaw = dirToYaw(dx, dz);
}

function leaveShadow(f: Fighter): void {
  f.incomingDamageReduction = 0;
  f.ccImmuneChannel = false;
  removeBuff(f, 'stealth');
}

function enterRecovery(sim: Sim, f: Fighter, rt: AbilityRuntime, complete: boolean): void {
  leaveShadow(f);
  if (complete) emitUltimateStage(sim, f, rt, PANTHER_STAGE_REAPPEAR);
  toRecovery(rt);
}

/** Blink `k` (0..strikes−1 = the shifting strikes, `strikes` = the finisher behind the victim). */
function blinkBeat(sim: Sim, f: Fighter, rt: AbilityRuntime, v: Fighter, k: number): void {
  const finisher = k >= E.strikes;
  const ang = finisher ? v.state.yaw + Math.PI : rt.px + E.strikeAngles[k % E.strikeAngles.length];
  const d = v.def.radius + f.def.radius + E.ringPad;
  blink(sim, f, v.state.pos.x + Math.sin(ang) * d, v.state.pos.z + Math.cos(ang) * d);
  f.state.airborne = false;
  faceVictim(f, v);
  emitUltimateStage(sim, f, rt, finisher ? E.stage.finisher : E.stage.strike0 + k, { x: f.state.pos.x, y: f.state.pos.y, z: f.state.pos.z });
}

function impactBeat(sim: Sim, f: Fighter, rt: AbilityRuntime, v: Fighter | undefined, k: number): void {
  if (v === undefined || !v.state.alive || !strikeReachable(f, v)) return;
  faceVictim(f, v);
  const spec = rt.spec;
  if (k < E.strikes) {
    const res = dealDamage(sim, f, v, spec.damage ?? E.strikeDamage, {
      blockable: true,
      heavy: false,
      reaction: 'flinch',
      isBasic: false,
      blockIgnore: E.strikeBlockIgnore,
      allowBackstab: false,
    });
    if (res.hit) rt.didHit = true;
    return;
  }
  // Finisher.
  const execute = v.state.hp / v.state.maxHp < E.executeBelow;
  const at: Vec3 = { x: v.state.pos.x, y: v.state.pos.y, z: v.state.pos.z };
  if (execute) emitUltimateStage(sim, f, rt, E.stage.execute, at);
  const res = dealDamage(sim, f, v, spec.splashDamage ?? E.finisherDamage, {
    blockable: true,
    heavy: true,
    reaction: 'stagger',
    isBasic: false,
    blockIgnore: E.strikeBlockIgnore,
    allowBackstab: false,
    flatBonus: execute ? spec.bonusDamage ?? E.executeBonus : 0,
  });
  if (res.hit) rt.didHit = true;
}

export const pantherUltimate: UltimateImpl = {
  start(sim, f, rt, target) {
    const spec = rt.spec;
    const v = victimOf(sim, rt);
    // rt.px doubles as θ0: the bearing from the victim to the panther at cast (the strike angles are offsets from it).
    rt.px = v !== undefined ? dirToYaw(f.state.pos.x - v.state.pos.x, f.state.pos.z - v.state.pos.z) : f.state.yaw + Math.PI;
    rt.counter = 0; // next blink index
    rt.accum = 0;
    emitCastEvents(sim, f, rt, target.to.x, target.to.z, 1.6, 360, spec.windup);
    emitUltimateTarget(sim, f, rt, target);
    // Melt into shadow: the shared stealth fade (short — refreshed in activate; expires by itself if interrupted).
    applyEffect(sim, f, f, { kind: 'stealth', mag: 0, dur: spec.windup + 0.2 });
  },

  windupTick(sim, f, rt) {
    const v = victimOf(sim, rt);
    f.state.vel.x = 0;
    f.state.vel.z = 0;
    if (markable(v)) faceVictim(f, v);
  },

  activate(sim, f, rt) {
    f.ccImmuneChannel = true;
    f.incomingDamageReduction = rt.spec.damageReduction ?? E.shadowReduction;
    applyEffect(sim, f, f, { kind: 'stealth', mag: 0, dur: PANTHER_T_RECOVERY - E.windup + 0.1 });
    rt.counter = 0;
    rt.accum = 0;
    const v = victimOf(sim, rt);
    if (!markable(v)) {
      enterRecovery(sim, f, rt, false);
      return;
    }
    blinkBeat(sim, f, rt, v, 0); // strike 1 starts the instant the shadow closes
    rt.counter = 1;
  },

  activeTick(sim, f, rt, dt) {
    rt.accum += dt;
    const t = rt.accum;
    const v = victimOf(sim, rt);
    f.state.vel.x = 0;
    f.state.vel.z = 0;

    // Blink beats: k = 0..strikes−1 strikes, k = strikes the finisher (already-past beats first).
    while (rt.counter <= E.strikes && t >= rt.counter * E.strikeGap) {
      if (!markable(v)) {
        enterRecovery(sim, f, rt, false);
        return;
      }
      blinkBeat(sim, f, rt, v, rt.counter);
      rt.counter += 1;
    }
    // Impacts.
    for (let k = 0; k < rt.counter; k++) {
      if (rt.hitOnce.has(k)) continue;
      const delay = k >= E.strikes ? E.finisherImpactDelay : E.strikeImpactDelay;
      if (t < k * E.strikeGap + delay) continue;
      rt.hitOnce.add(k);
      impactBeat(sim, f, rt, v, k);
    }
    if (v !== undefined && v.state.alive && rt.counter > 0) faceVictim(f, v);
    // End of the finisher beat → recovery (visible again).
    if (rt.counter > E.strikes && t >= E.strikes * E.strikeGap + E.finisherBeat) enterRecovery(sim, f, rt, true);
  },

  recoveryDuration(rt) {
    return rt.stage >= E.stage.finisher ? rt.spec.recovery ?? E.recovery : E.brokenRecovery;
  },

  abort(_sim, f) {
    leaveShadow(f);
  },
};
