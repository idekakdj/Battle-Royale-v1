/**
 * Rhino — Seismic Stampede (v1.3: a homing, CC-immune charge that gores, carries and crushes).
 *
 *   cast    `targeting` is a lock-assisted line: the best foe inside a 50 degree cone / 16 m of the aim becomes
 *           `lockId` (none = a free, steerable charge as before). No `requireTarget`: it never fizzles.
 *   Windup  PAW 0.8 s (stage 0): head lowered, pawing the sand; the rhino turns (<= 150 deg/s) to sight the
 *           lock, else the aim. Interruptible like any windup.
 *   Active  CHARGE up to 3 s (stage 1), 12 m/s after a 0.5 s ramp, CC-immune, smashes crates. Steering:
 *           homing on the lock (feet of the victim's CURRENT position, turn <= 110 deg/s, dropped if the lock
 *           dies / flies / burrows / is > 28 m away), otherwise the aim at <= 90 deg/s as before.
 *           GORE (stage 2): the locked foe on contact (with no live lock, the first fighter touched) takes
 *           120 (blockable), is hoisted 1.7 m up on the horn and CARRIED along the charge (grabbed, helpless).
 *           CRUSH (stage 3): a wall / pillar / column stopping the rhino or the carried victim = +100 (true,
 *           unblockable) and a 1.2 s stun; the victim drops, the charge ends. If the charge times out
 *           instead the victim is flung off (knockdown) and the rhino SKIDS (stage 4, 0.45 s).
 *           Everyone else the rhino touches is swept once: 60 + knockdown 0.8 s.
 *   Recovery 0.7 s shake-off, interruptible.
 *
 * The rhino owns its position for the whole ultimate (and the carried victim's while gored); the phase
 * clocks (`state.actionT`) restart at each phase and at the gore / crush / skid beats so the rig can use
 * `actionT / actionDur` per beat.
 *
 * Config: src/config/ultimates/rhino.ts · AI: src/ai/ultScripts/rhino.ts · Rig: src/render/animals/Rhino.ts
 */

import { DEG2RAD, clamp01, dirToYaw, rotateToward } from '../../core/math';
import { RHINO_STAMPEDE as K } from '../../config/ultimates/rhino';
import type { AbilityRuntime, Fighter, Sim } from '../Fighter';
import { dealDamage } from '../CombatSystem';
import { applyDirectionalKnockback, applyEffect } from '../StatusEffects';
import { isGroundTargetable } from '../hitbox';
import { chargeStep, clampToWall, groundHeightAt, resolveObstacles } from '../MovementSystem';
import { CONTACT_PAD } from '../simTuning';
import { emitCastEvents, emitUltimateStage, emitUltimateTarget, toRecovery, ultOpts } from './common';
import type { UltimateImpl } from './types';

type Beat = 'charge' | 'skid';

/** Per-cast scratch (kept off the shared AbilityRuntime shape). */
interface Stampede {
  beat: Beat;
  /** Seconds since the charge began. */
  t: number;
  /** Gored victim being carried (-1 none) and seconds since the gore. */
  victimId: number;
  carryT: number;
  /** A fighter has been gored (the gore is spent even if the victim could not be carried). */
  gored: boolean;
  /** The rhino is currently homing on its lock. */
  homing: boolean;
  /** Skid state. */
  skidT: number;
  skidSpeed: number;
  /** Current charge speed (m/s). */
  speed: number;
}

const STATE = new WeakMap<AbilityRuntime, Stampede>();

function get(rt: AbilityRuntime): Stampede {
  let s = STATE.get(rt);
  if (s === undefined) {
    s = { beat: 'charge', t: 0, victimId: -1, carryT: 0, gored: false, homing: false, skidT: 0, skidSpeed: 0, speed: 0 };
    STATE.set(rt, s);
  }
  return s;
}

/** Debug / test hook: the charge's live state (beat, carried victim id, homing flag, speed). */
export function stampedeState(rt: AbilityRuntime | null): { beat: Beat; victimId: number; homing: boolean; gored: boolean; speed: number; t: number } | null {
  if (rt === null) return null;
  const s = STATE.get(rt);
  return s === undefined ? null : { beat: s.beat, victimId: s.victimId, homing: s.homing, gored: s.gored, speed: s.speed, t: s.t };
}

const smooth = (u: number): number => u * u * (3 - 2 * u);

/** The lock if it can still be homed on (alive, targetable, low enough, inside the leash), else undefined. */
function homingTarget(sim: Sim, f: Fighter, rt: AbilityRuntime, st: Stampede): Fighter | undefined {
  if (rt.lockId < 0 || st.gored) return undefined;
  const t = sim.fighters[rt.lockId];
  if (t === undefined || !isGroundTargetable(t)) return undefined;
  const d = Math.hypot(t.state.pos.x - f.state.pos.x, t.state.pos.z - f.state.pos.z);
  return d <= K.leashM ? t : undefined;
}

export const rhinoUltimate: UltimateImpl = {
  start(sim, f, rt, target) {
    // `targeting` is a lock-assisted line: targetId = best foe in the cone (or -1). startUlt only fills
    // lockId for lock kinds, so set it here.
    rt.lockId = target.targetId;
    get(rt);
    // The live path ribbon is drawn by the VFX module: the generic ground ring is negligible.
    emitCastEvents(sim, f, rt, f.state.pos.x, f.state.pos.z, 0.05, 0, K.pawS);
    emitUltimateTarget(sim, f, rt, target, K.pawS);
    f.state.actionDur = K.pawS;
  },

  windupTick(sim, f, rt, dt) {
    const st = get(rt);
    const s = f.state;
    s.vel.x = 0;
    s.vel.z = 0;
    // Sight the lock (else the aim) while pawing.
    const lock = homingTarget(sim, f, rt, st);
    const want = lock !== undefined ? dirToYaw(lock.state.pos.x - s.pos.x, lock.state.pos.z - s.pos.z) : f.intent.aimYaw;
    s.yaw = rotateToward(s.yaw, want, K.sightTurnDeg * DEG2RAD * dt);
    rt.dirX = Math.sin(s.yaw);
    rt.dirZ = Math.cos(s.yaw);
  },

  windupDuration() {
    return K.pawS;
  },

  activate(sim, f, rt) {
    const st = get(rt);
    st.beat = 'charge';
    st.t = 0;
    f.ccImmuneChannel = true;
    rt.didHit = false;
    // Phase clock for the rig: the charge has its own actionT/actionDur.
    f.state.actionT = 0;
    f.state.actionDur = K.chargeS;
    emitUltimateStage(sim, f, rt, 1);
  },

  activeTick(sim, f, rt, dt) {
    const st = get(rt);
    f.ccImmuneChannel = true;
    if (st.beat === 'skid') {
      skid(sim, f, rt, st, dt);
      return;
    }
    charge(sim, f, rt, st, dt);
  },

  recoveryDuration() {
    return K.recoveryS;
  },

  abort(sim, f, rt) {
    f.ccImmuneChannel = false;
    const st = STATE.get(rt);
    if (st !== undefined && st.victimId >= 0) drop(sim, f, st);
  },
};

// ── The charge ───────────────────────────────────────────────────────────────

function charge(sim: Sim, f: Fighter, rt: AbilityRuntime, st: Stampede, dt: number): void {
  const s = f.state;
  st.t += dt;

  // Steer: home on the lock, else follow the aim (as before).
  const lock = homingTarget(sim, f, rt, st);
  st.homing = lock !== undefined;
  const want = lock !== undefined ? dirToYaw(lock.state.pos.x - s.pos.x, lock.state.pos.z - s.pos.z) : f.intent.aimYaw;
  const maxTurn = (lock !== undefined ? K.homingTurnDeg : K.freeTurnDeg) * DEG2RAD * dt;
  const yaw = rotateToward(dirToYaw(rt.dirX, rt.dirZ), want, maxTurn);
  rt.dirX = Math.sin(yaw);
  rt.dirZ = Math.cos(yaw);
  s.yaw = yaw;

  // Gallop: ramp up from a heavy first stride.
  const speed = K.speed * (K.rampFloor + (1 - K.rampFloor) * smooth(clamp01(st.t / K.rampS)));
  st.speed = speed;
  const step = speed * dt;

  // Smash crates in the path first (the Stampede ploughs through them).
  for (let i = 0; i < sim.crates.length; i++) {
    const c = sim.crates[i];
    if (!c.alive) continue;
    if (Math.hypot(c.x - s.pos.x, c.z - s.pos.z) <= f.def.radius + 0.6 + step) sim.damageCrate(c, c.hp);
  }

  const cr = chargeStep(sim, f, step, false);
  s.pos.y = groundHeightAt(s.pos.x, s.pos.z, sim.arena);
  s.vel.x = rt.dirX * speed;
  s.vel.z = rt.dirZ * speed;

  // Contacts: gore (lock / first fighter) and sweeps.
  contacts(sim, f, rt, st, true);

  // Carry the victim on the horn; a wall / pillar / column in front of the victim counts as a slam.
  let slammed = cr.stopped;
  if (st.victimId >= 0) {
    if (carry(sim, f, rt, st, dt)) slammed = true;
  }

  if (slammed) {
    s.vel.x = 0;
    s.vel.z = 0;
    st.speed = 0;
    if (st.victimId >= 0) crush(sim, f, rt, st);
    else {
      // Ran into geometry with nobody on the horn: a stumbling stop.
      emitUltimateStage(sim, f, rt, 4);
      endCharge(f, rt, K.recoveryS);
    }
    return;
  }

  if (st.t >= K.chargeS) {
    // Out of steam: fling the carried victim off the horn, then skid to a halt.
    if (st.victimId >= 0) throwOff(sim, f, rt, st);
    st.beat = 'skid';
    st.skidT = 0;
    st.skidSpeed = speed;
    emitUltimateStage(sim, f, rt, 4);
    s.actionT = 0;
    s.actionDur = K.skidS;
  }
}

/** Touch tests against every other fighter: gore the victim, sweep the rest. */
function contacts(sim: Sim, f: Fighter, rt: AbilityRuntime, st: Stampede, allowGore: boolean): void {
  const spec = rt.spec;
  const lock = rt.lockId >= 0 ? sim.fighters[rt.lockId] : undefined;
  const lockLive = lock !== undefined && lock.state.alive;
  for (let i = 0; i < sim.fighters.length; i++) {
    const t = sim.fighters[i];
    if (t === f || !t.state.alive || !isGroundTargetable(t) || rt.hitOnce.has(t.id) || t.state.grabbedById !== -1) continue;
    const dx = t.state.pos.x - f.state.pos.x;
    const dz = t.state.pos.z - f.state.pos.z;
    if (Math.hypot(dx, dz) > f.def.radius + t.def.radius + CONTACT_PAD) continue;
    rt.hitOnce.add(t.id);
    if (allowGore && !st.gored && (!lockLive || t === lock)) {
      gore(sim, f, rt, st, t);
    } else {
      const res = dealDamage(sim, f, t, spec.splashDamage ?? K.sweepDamage, ultOpts('stagger'));
      if (res.hit) {
        rt.didHit = true;
        if (spec.effects !== undefined) for (const e of spec.effects) applyEffect(sim, f, t, e);
      }
    }
  }
}

/** The gore: damage, then hoist the victim on the horn (unless it cannot be carried). */
function gore(sim: Sim, f: Fighter, rt: AbilityRuntime, st: Stampede, t: Fighter): void {
  const spec = rt.spec;
  st.gored = true;
  const res = dealDamage(sim, f, t, spec.damage ?? K.goreDamage, ultOpts('stagger'));
  if (res.hit) rt.didHit = true;
  // CC-immune (rampaging gorilla, another charging rhino), dead, or still mid-cast: no carry.
  if (!t.state.alive || t.ccImmune || t.ability !== null) return;
  st.victimId = t.id;
  st.carryT = 0;
  rt.lockId = t.id; // the snapshot's ultTargetId now names the victim on the horn
  f.state.grabTargetId = t.id;
  t.state.grabbedById = f.id;
  t.movementOwned = true;
  t.knockTimer = 0;
  t.state.vel.x = 0;
  t.state.vel.z = 0;
  // Beat clock for the rig: the hoist (horn lift) then the ride.
  f.state.actionT = 0;
  f.state.actionDur = K.hoistS;
  emitUltimateStage(sim, f, rt, 2, { x: t.state.pos.x, y: t.state.pos.y, z: t.state.pos.z });
}

/**
 * Keep the victim on the horn: ahead of the body, eased up to the hoist height, pushed out of pillars and the
 * wall. Returns true when the victim was blocked by geometry (= the crush).
 */
function carry(sim: Sim, f: Fighter, rt: AbilityRuntime, st: Stampede, dt: number): boolean {
  const t = sim.fighters[st.victimId];
  if (t === undefined || !t.state.alive) {
    drop(sim, f, st);
    return false;
  }
  st.carryT += dt;
  const off = f.def.radius + K.carryGap;
  const v = t.state;
  v.pos.x = f.state.pos.x + rt.dirX * off;
  v.pos.z = f.state.pos.z + rt.dirZ * off;
  const res = resolveObstacles(sim, t, false);
  const hitWall = clampToWall(t);
  const opposed = res.corrX * rt.dirX + res.corrZ * rt.dirZ;
  v.pos.y = groundHeightAt(v.pos.x, v.pos.z, sim.arena) + K.hoistAlt * smooth(clamp01(st.carryT / K.hoistS));
  v.vel.x = f.state.vel.x;
  v.vel.z = f.state.vel.z;
  v.vel.y = 0;
  v.airborne = false;
  t.movementOwned = true;
  t.knockTimer = 0;
  t.state.grabbedById = f.id;
  return hitWall || opposed < -1e-4;
}

/** Let go of the carried victim (it falls from the horn under normal gravity). */
function drop(sim: Sim, f: Fighter, st: Stampede): void {
  const t = sim.fighters[st.victimId];
  st.victimId = -1;
  f.state.grabTargetId = -1;
  if (t === undefined) return;
  t.state.grabbedById = -1;
  t.movementOwned = false;
  t.state.vel.x = 0;
  t.state.vel.z = 0;
  t.state.vel.y = 0;
  if (t.state.pos.y > groundHeightAt(t.state.pos.x, t.state.pos.z, sim.arena) + 1e-3) t.state.airborne = true;
}

/** Slammed into geometry with a victim on the horn: crush damage + stun, then the charge ends. */
function crush(sim: Sim, f: Fighter, rt: AbilityRuntime, st: Stampede): void {
  const spec = rt.spec;
  const t = sim.fighters[st.victimId];
  if (t !== undefined && t.state.alive) {
    // True damage: the victim is pinned, blocking does not help.
    dealDamage(sim, f, t, spec.bonusDamage ?? K.crushDamage, { blockable: false, heavy: true, reaction: 'none', isBasic: false });
    if (t.state.alive && spec.bonusEffects !== undefined) for (const e of spec.bonusEffects) applyEffect(sim, f, t, e);
  }
  const pos = t !== undefined ? { x: t.state.pos.x, y: groundHeightAt(t.state.pos.x, t.state.pos.z, sim.arena), z: t.state.pos.z } : undefined;
  drop(sim, f, st);
  rt.didHit = true;
  emitUltimateStage(sim, f, rt, 3, pos);
  endCharge(f, rt, K.recoveryS);
}

/** Timed out with a victim on the horn: fling it forward, knocked down. */
function throwOff(sim: Sim, f: Fighter, rt: AbilityRuntime, st: Stampede): void {
  const t = sim.fighters[st.victimId];
  drop(sim, f, st);
  if (t === undefined || !t.state.alive) return;
  applyDirectionalKnockback(t, rt.dirX, rt.dirZ, 3);
  applyEffect(sim, f, t, { kind: 'knockdown', mag: 0, dur: K.throwKnockdownS });
}

/** Skid to a halt (deceleration over `skidS`), then the shake-off. */
function skid(sim: Sim, f: Fighter, rt: AbilityRuntime, st: Stampede, dt: number): void {
  st.skidT += dt;
  const u = clamp01(st.skidT / K.skidS);
  const speed = st.skidSpeed * (1 - u) * (1 - u);
  st.speed = speed;
  chargeStep(sim, f, speed * dt, false);
  f.state.pos.y = groundHeightAt(f.state.pos.x, f.state.pos.z, sim.arena);
  f.state.vel.x = rt.dirX * speed;
  f.state.vel.z = rt.dirZ * speed;
  contacts(sim, f, rt, st, false); // still a battering ram while it slides (sweeps only)
  if (u >= 1) endCharge(f, rt, K.recoveryS);
}

/** End of the active phase: stop dead, drop CC immunity, start the shake-off recovery (own clock for the rig). */
function endCharge(f: Fighter, rt: AbilityRuntime, recoveryS: number): void {
  f.state.vel.x = 0;
  f.state.vel.z = 0;
  f.ccImmuneChannel = false;
  f.state.actionT = 0;
  f.state.actionDur = recoveryS;
  toRecovery(rt);
}
