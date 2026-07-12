/**
 * Specials for all 10 animals (BLUEPRINT §8) + the ability dispatcher shared
 * with the ultimates in abilities2. All damage flows through
 * CombatSystem.dealDamage; telegraph + special events fire at windup start.
 */

import type { Fighter, Sim, AbilityRuntime } from './Fighter';
import { AbilityPhase } from './Fighter';
import { dealDamage } from './CombatSystem';
import { applyEffect, applyKnockback } from './StatusEffects';
import { isTargetable } from './hitbox';
import { chargeStep, clampToWall, groundHeightAt } from './MovementSystem';
import { lerp } from '../core/math';
import { MOVE } from '../config/balance';
import { DASH_SPEED, LEAP_DURATION, LEAP_PEAK, LAND_RECOVER, CONTACT_PAD } from './simTuning';
import { beginAbility, emitCastEvents, endAbility, hitArea, aimX, aimZ, updateUlt } from './abilities2';

export { startUlt } from './abilities2';

/** Begin a special (cooldown already validated by World). */
export function startSpecial(sim: Sim, f: Fighter): void {
  const spec = f.def.special;
  const rt = beginAbility(f, 'special', spec);

  switch (f.def.id) {
    case 'lion':
    case 'gorilla': {
      rt.sx = f.state.pos.x;
      rt.sz = f.state.pos.z;
      rt.px = aimX(f, spec.range ?? 7);
      rt.pz = aimZ(f, spec.range ?? 7);
      emitCastEvents(sim, f, rt, rt.px, rt.pz, spec.radius ?? 2, 360, spec.windup);
      return;
    }
    case 'eagle':
    case 'giraffe': {
      emitCastEvents(sim, f, rt, f.state.pos.x, f.state.pos.z, spec.range ?? 3, spec.arcDeg ?? 90, spec.windup);
      return;
    }
    case 'python': {
      emitCastEvents(sim, f, rt, f.state.pos.x, f.state.pos.z, spec.range ?? 3, 360, spec.windup);
      return;
    }
    default: {
      // Charges / dashes / burrow: telegraph a forward lane.
      emitCastEvents(sim, f, rt, f.state.pos.x, f.state.pos.z, spec.range ?? 7, 30, spec.windup);
      return;
    }
  }
}

/** Ability dispatcher (specials + ultimates) called every tick a fighter casts. */
export function updateAbility(sim: Sim, f: Fighter, dt: number): void {
  const rt = f.ability;
  if (rt === null) return;
  if (rt.kind === 'ultimate') updateUlt(sim, f, dt);
  else updateSpecial(sim, f, dt);
}

function updateSpecial(sim: Sim, f: Fighter, dt: number): void {
  const rt = f.ability;
  if (rt === null) return;
  f.movementOwned = true;
  f.state.actionT += dt;

  if (rt.phase === AbilityPhase.Windup) {
    rt.t += dt;
    if (rt.t >= rt.spec.windup) {
      rt.phase = AbilityPhase.Active;
      rt.t = 0;
      activateSpecial(sim, f, rt);
    }
    return;
  }
  if (rt.phase === AbilityPhase.Active) {
    activeSpecial(sim, f, rt, dt);
    return;
  }
  rt.t += dt;
  const rec = rt.didHit ? LAND_RECOVER : rt.spec.recovery ?? LAND_RECOVER;
  if (rt.t >= rec) endAbility(sim, f);
}

function toRecovery(rt: AbilityRuntime): void {
  rt.phase = AbilityPhase.Recovery;
  rt.t = 0;
}

function activateSpecial(sim: Sim, f: Fighter, rt: AbilityRuntime): void {
  const spec = rt.spec;
  switch (f.def.id) {
    case 'lion':
    case 'gorilla':
      rt.accum = 0; // leap elapsed; handled in active
      return;
    case 'crocodile':
    case 'hippo':
    case 'panther':
      rt.accum = 0;
      return;
    case 'rhino':
      rt.accum = 0;
      rt.didHit = false;
      return;
    case 'mole':
      f.state.burrowT = spec.maxTime ?? 3;
      f.untargetable = true;
      f.state.action = 'burrowed';
      rt.accum = 0;
      return;
    case 'eagle': {
      // Gale Burst: 5 m / 90° cone, 45 + pushback + disarm.
      rt.didHit = hitArea(sim, f, {
        shape: 'cone',
        cx: f.state.pos.x,
        cz: f.state.pos.z,
        cy: f.state.pos.y,
        yaw: f.state.yaw,
        range: spec.range ?? 5,
        arcDeg: spec.arcDeg ?? 90,
        heightTol: MOVE.heightOverlap,
        base: spec.damage ?? 45,
        opts: { blockable: true, heavy: true, reaction: 'stagger', isBasic: false },
        effects: spec.effects,
        pushDist: spec.knockback ?? 5,
        pushDirX: Math.sin(f.state.yaw),
        pushDirZ: Math.cos(f.state.yaw),
      });
      rt.didHit = true;
      toRecovery(rt);
      return;
    }
    case 'python': {
      // Coil Sweep: 360° / 3 m, 60 + slow.
      hitArea(sim, f, {
        shape: 'circle',
        cx: f.state.pos.x,
        cz: f.state.pos.z,
        cy: f.state.pos.y,
        yaw: f.state.yaw,
        range: spec.range ?? 3,
        arcDeg: 360,
        heightTol: MOVE.heightOverlap,
        base: spec.damage ?? 60,
        opts: { blockable: true, heavy: true, reaction: 'stagger', isBasic: false },
        effects: spec.effects,
      });
      rt.didHit = true;
      toRecovery(rt);
      return;
    }
    case 'giraffe': {
      // Thunder Kick: 2.5 m / 60° cone, 120 + 6 m knockback toward aim.
      hitArea(sim, f, {
        shape: 'cone',
        cx: f.state.pos.x,
        cz: f.state.pos.z,
        cy: f.state.pos.y,
        yaw: f.state.yaw,
        range: spec.range ?? 2.5,
        arcDeg: spec.arcDeg ?? 60,
        heightTol: MOVE.heightOverlapGiraffe,
        base: spec.damage ?? 120,
        opts: { blockable: true, heavy: true, reaction: 'stagger', isBasic: false },
        pushDist: spec.knockback ?? 6,
        pushDirX: Math.sin(f.state.yaw),
        pushDirZ: Math.cos(f.state.yaw),
      });
      rt.didHit = true;
      toRecovery(rt);
      return;
    }
  }
}

function activeSpecial(sim: Sim, f: Fighter, rt: AbilityRuntime, dt: number): void {
  switch (f.def.id) {
    case 'lion':
    case 'gorilla':
      leap(sim, f, rt, dt);
      return;
    case 'crocodile':
      ambushLunge(sim, f, rt, dt);
      return;
    case 'hippo':
      riverRush(sim, f, rt, dt);
      return;
    case 'rhino':
      lockdownCharge(sim, f, rt, dt);
      return;
    case 'panther':
      shadowDash(sim, f, rt, dt);
      return;
    case 'mole':
      burrow(sim, f, rt, dt);
      return;
    default:
      toRecovery(rt);
      return;
  }
}

function leap(sim: Sim, f: Fighter, rt: AbilityRuntime, dt: number): void {
  const spec = rt.spec;
  rt.accum += dt;
  const frac = Math.min(1, rt.accum / LEAP_DURATION);
  f.state.pos.x = lerp(rt.sx, rt.px, frac);
  f.state.pos.z = lerp(rt.sz, rt.pz, frac);
  const gy = groundHeightAt(f.state.pos.x, f.state.pos.z);
  f.state.pos.y = gy + LEAP_PEAK * Math.sin(Math.PI * frac);
  f.state.airborne = true;
  clampToWall(f);
  if (frac >= 1) {
    f.state.pos.y = groundHeightAt(f.state.pos.x, f.state.pos.z);
    f.state.airborne = false;
    if (f.def.id === 'lion') {
      hitArea(sim, f, {
        shape: 'circle',
        cx: f.state.pos.x,
        cz: f.state.pos.z,
        cy: f.state.pos.y,
        yaw: f.state.yaw,
        range: spec.radius ?? 1.5,
        arcDeg: 360,
        heightTol: MOVE.heightOverlap,
        base: spec.damage ?? 60,
        opts: { blockable: true, heavy: true, reaction: 'stagger', isBasic: false },
        effects: spec.effects,
      });
    } else {
      hitArea(sim, f, {
        shape: 'circle',
        cx: f.state.pos.x,
        cz: f.state.pos.z,
        cy: f.state.pos.y,
        yaw: f.state.yaw,
        range: spec.radius ?? 2.5,
        arcDeg: 360,
        heightTol: MOVE.heightOverlap,
        base: spec.damage ?? 75,
        opts: { blockable: true, heavy: true, reaction: 'stagger', isBasic: false },
        pushDist: spec.knockback ?? 4,
      });
    }
    rt.didHit = true;
    toRecovery(rt);
  }
}

function ambushLunge(sim: Sim, f: Fighter, rt: AbilityRuntime, dt: number): void {
  const spec = rt.spec;
  const step = DASH_SPEED * dt;
  rt.accum += step;
  const cr = chargeStep(sim, f, step, false);
  if (rt.accum >= (spec.range ?? 7) || cr.stopped) {
    f.ambushBonusTimer = spec.followupWindow ?? 1;
    rt.didHit = true;
    toRecovery(rt);
  }
}

function riverRush(sim: Sim, f: Fighter, rt: AbilityRuntime, dt: number): void {
  const spec = rt.spec;
  const step = (spec.moveSpeed ?? 11) * dt;
  const cr = chargeStep(sim, f, step, false);
  for (let i = 0; i < sim.fighters.length; i++) {
    const t = sim.fighters[i];
    if (t === f || !t.state.alive || !isTargetable(t) || rt.hitOnce.has(t.id)) continue;
    const dx = t.state.pos.x - f.state.pos.x;
    const dz = t.state.pos.z - f.state.pos.z;
    if (Math.sqrt(dx * dx + dz * dz) <= f.def.radius + t.def.radius + CONTACT_PAD) {
      rt.hitOnce.add(t.id);
      const res = dealDamage(sim, f, t, spec.damage ?? 80, { blockable: true, heavy: true, reaction: 'stagger', isBasic: false });
      if (res.hit) applyKnockback(t, f.state.pos.x, f.state.pos.z, spec.knockback ?? 4);
    }
  }
  rt.accum += dt;
  if (rt.accum >= (spec.maxTime ?? 1.2) || cr.stopped) {
    rt.didHit = true;
    toRecovery(rt);
  }
}

function lockdownCharge(sim: Sim, f: Fighter, rt: AbilityRuntime, dt: number): void {
  const spec = rt.spec;
  const step = (spec.moveSpeed ?? 12) * dt;
  if (!rt.didHit) {
    rt.accum += step;
    const cr = chargeStep(sim, f, step, false);
    for (let i = 0; i < sim.fighters.length; i++) {
      const t = sim.fighters[i];
      if (t === f || !t.state.alive || !isTargetable(t) || t.state.grabbedById !== -1) continue;
      const dx = t.state.pos.x - f.state.pos.x;
      const dz = t.state.pos.z - f.state.pos.z;
      if (Math.sqrt(dx * dx + dz * dz) <= f.def.radius + t.def.radius + CONTACT_PAD) {
        rt.didHit = true;
        rt.targetId = t.id;
        t.state.grabbedById = f.id;
        f.state.grabTargetId = t.id;
        dealDamage(sim, f, t, spec.damage ?? 100, { blockable: true, heavy: true, reaction: 'stagger', isBasic: false });
        break;
      }
    }
    if (!rt.didHit && (rt.accum >= (spec.range ?? 12) || cr.stopped)) {
      toRecovery(rt);
    }
    return;
  }
  // Carrying a target.
  rt.accum += step;
  const cr = chargeStep(sim, f, step, false);
  const t = sim.fighters[rt.targetId];
  if (t !== undefined && t.state.alive) {
    t.movementOwned = true;
    t.state.grabbedById = f.id;
    t.state.pos.x = f.state.pos.x + rt.dirX * (f.def.radius + t.def.radius);
    t.state.pos.z = f.state.pos.z + rt.dirZ * (f.def.radius + t.def.radius);
    t.state.pos.y = f.state.pos.y;
    t.state.action = 'grabbed';
  }
  const slammed = cr.stopped || cr.hitCrate !== null;
  if (slammed || rt.accum >= (spec.range ?? 12)) {
    if (slammed && t !== undefined && t.state.alive) {
      dealDamage(sim, f, t, spec.bonusDamage ?? 60, { blockable: false, heavy: true, reaction: 'none', isBasic: false });
      if (spec.bonusEffects !== undefined) for (const e of spec.bonusEffects) applyEffect(sim, f, t, e);
    }
    if (t !== undefined) {
      t.state.grabbedById = -1;
      t.movementOwned = false;
    }
    f.state.grabTargetId = -1;
    rt.targetId = -1;
    rt.didHit = true;
    toRecovery(rt);
  }
}

function shadowDash(sim: Sim, f: Fighter, rt: AbilityRuntime, dt: number): void {
  const spec = rt.spec;
  const step = DASH_SPEED * dt;
  rt.accum += step;
  const cr = chargeStep(sim, f, step, false);
  for (let i = 0; i < sim.fighters.length; i++) {
    const t = sim.fighters[i];
    if (t === f || !t.state.alive || !isTargetable(t) || rt.hitOnce.has(t.id)) continue;
    const dx = t.state.pos.x - f.state.pos.x;
    const dz = t.state.pos.z - f.state.pos.z;
    if (Math.sqrt(dx * dx + dz * dz) <= f.def.radius + t.def.radius + CONTACT_PAD) {
      rt.hitOnce.add(t.id);
      dealDamage(sim, f, t, spec.damage ?? 50, { blockable: true, heavy: false, reaction: 'flinch', isBasic: false });
    }
  }
  if (rt.accum >= (spec.range ?? 7) || cr.stopped) {
    rt.didHit = true;
    toRecovery(rt);
  }
}

function burrow(sim: Sim, f: Fighter, rt: AbilityRuntime, dt: number): void {
  const spec = rt.spec;
  f.untargetable = true;
  f.state.action = 'burrowed';
  // Move underground at burrow speed, ignoring obstacles (arena wall still holds).
  let mx = f.intent.moveX;
  let mz = f.intent.moveZ;
  const mlen = Math.sqrt(mx * mx + mz * mz);
  if (mlen > 1e-4) {
    mx /= mlen;
    mz /= mlen;
    const spd = (spec.moveSpeed ?? 8.5) * dt;
    f.state.pos.x += mx * spd;
    f.state.pos.z += mz * spd;
    clampToWall(f);
  }
  f.state.burrowT = Math.max(0, f.state.burrowT - dt);
  if (f.edgeSpecial || f.state.burrowT <= 0) {
    // Uppercut Eruption on emerge.
    f.untargetable = false;
    hitArea(sim, f, {
      shape: 'circle',
      cx: f.state.pos.x,
      cz: f.state.pos.z,
      cy: f.state.pos.y,
      yaw: f.state.yaw,
      range: spec.radius ?? 1.5,
      arcDeg: 360,
      heightTol: MOVE.heightOverlap,
      base: spec.damage ?? 80,
      opts: { blockable: true, heavy: true, reaction: 'stagger', isBasic: false },
      effects: spec.effects,
    });
    rt.didHit = true;
    toRecovery(rt);
  }
}
