/**
 * Ultimates for all 10 animals (BLUEPRINT §8) + the shared ability scaffolding
 * (begin/telegraph/end, area-damage helper) reused by the specials in
 * abilities1. Every ability flows its damage through CombatSystem.dealDamage so
 * §7.1 holds; telegraph + special/ultimate events fire at windup start (§7.5/6).
 */

import type { EffectSpec, AbilitySpec } from '../config/animals';
import type { Fighter, Sim, AbilityRuntime } from './Fighter';
import { AbilityPhase } from './Fighter';
import type { DamageOpts } from './CombatSystem';
import { dealDamage } from './CombatSystem';
import { applyEffect, applyKnockback, applyDirectionalKnockback } from './StatusEffects';
import { isTargetable, circleHit, coneHit } from './hitbox';
import { chargeStep, clampToWall, groundHeightAt } from './MovementSystem';
import { DEG2RAD, rotateToward, dirToYaw } from '../core/math';
import { MOVE } from '../config/balance';
import { DASH_SPEED, STAMPEDE_SPEED, DFA_DIVE_RANGE, LAND_RECOVER, CONTACT_PAD } from './simTuning';

// ── Shared scaffolding ───────────────────────────────────────────────────────

/** Aim ground point `dist` metres along the caster's aim yaw. */
export function aimX(f: Fighter, dist: number): number {
  return f.state.pos.x + Math.sin(f.intent.aimYaw) * dist;
}
export function aimZ(f: Fighter, dist: number): number {
  return f.state.pos.z + Math.cos(f.intent.aimYaw) * dist;
}

/** Allocate + attach an ability runtime, snap yaw, reset combo (§7.2). */
export function beginAbility(f: Fighter, kind: 'special' | 'ultimate', spec: AbilitySpec): AbilityRuntime {
  f.state.yaw = f.intent.aimYaw;
  const rt: AbilityRuntime = {
    kind,
    spec,
    phase: AbilityPhase.Windup,
    t: 0,
    px: 0,
    pz: 0,
    sx: f.state.pos.x,
    sz: f.state.pos.z,
    dirX: Math.sin(f.state.yaw),
    dirZ: Math.cos(f.state.yaw),
    hitOnce: new Set<number>(),
    counter: 0,
    accum: 0,
    didHit: false,
    targetId: -1,
    isGrab: false,
  };
  f.ability = rt;
  f.blocking = false; // casting drops block
  f.state.action = kind === 'special' ? 'special' : 'ultimate';
  f.state.actionT = 0;
  f.state.actionDur = spec.windup + (spec.duration ?? spec.maxTime ?? spec.recovery ?? 0.4);
  f.resetCombo();
  return rt;
}

/** Emit the windup telegraph + special/ultimate events (§7.5/§7.6). */
export function emitCastEvents(sim: Sim, f: Fighter, rt: AbilityRuntime, tx: number, tz: number, radius: number, arcDeg: number, windup: number): void {
  sim.emit({
    type: 'telegraph',
    fighterId: f.id,
    kind: rt.kind,
    pos: { x: tx, y: f.state.pos.y, z: tz },
    radius,
    yaw: f.state.yaw,
    arcDeg,
    windup,
  });
  if (rt.kind === 'special') sim.emit({ type: 'special', fighterId: f.id, animal: f.def.id });
  else sim.emit({ type: 'ultimate', fighterId: f.id, animal: f.def.id });
}

/** Tear down an ability: cooldown (specials), release grab, clear phase flags. */
export function endAbility(sim: Sim, f: Fighter): void {
  const rt = f.ability;
  if (rt === null) return;
  if (rt.kind === 'special') f.state.specialCd = rt.spec.cooldown;
  if (rt.isGrab && rt.targetId >= 0) {
    const t = sim.fighters[rt.targetId];
    if (t !== undefined) {
      t.state.grabbedById = -1;
      t.state.action = 'idle';
    }
  }
  f.state.grabTargetId = -1;
  f.incomingDamageReduction = 0;
  f.ccImmuneChannel = false;
  f.untargetable = false;
  f.state.burrowT = 0;
  f.ability = null;
  if (f.state.action === 'special' || f.state.action === 'ultimate' || f.state.action === 'grab' || f.state.action === 'burrowed') {
    f.state.action = 'idle';
  }
}

/** Area damage config for {@link hitArea}. */
export interface AreaCfg {
  shape: 'circle' | 'cone';
  cx: number;
  cz: number;
  cy: number;
  yaw: number;
  range: number;
  arcDeg: number;
  heightTol: number;
  base: number;
  opts: DamageOpts;
  effects?: readonly EffectSpec[];
  once?: Set<number>;
  /** Radial pushback distance from the centre (m). */
  pushDist?: number;
  /** Directional pushback along (pushDirX,pushDirZ) instead of radial. */
  pushDirX?: number;
  pushDirZ?: number;
  /** Extra damage fraction vs rooted targets (mole Sinkhole). */
  bonusVsRooted?: number;
}

/** Apply an area hit (circle or cone) to every valid fighter once. */
export function hitArea(sim: Sim, f: Fighter, cfg: AreaCfg): boolean {
  let any = false;
  for (let i = 0; i < sim.fighters.length; i++) {
    const t = sim.fighters[i];
    if (t === f || !t.state.alive) continue;
    if (cfg.once !== undefined && cfg.once.has(t.id)) continue;
    const hit =
      cfg.shape === 'circle'
        ? circleHit(cfg.cx, cfg.cz, cfg.cy, cfg.range, t, cfg.heightTol)
        : coneHit(cfg.cx, cfg.cz, cfg.cy, cfg.yaw, cfg.range, cfg.arcDeg, t, cfg.heightTol);
    if (!hit) continue;
    if (cfg.once !== undefined) cfg.once.add(t.id);
    let mult = cfg.opts.dmgMult ?? 1;
    if (cfg.bonusVsRooted !== undefined && t.rootTimer > 0) mult *= 1 + cfg.bonusVsRooted;
    const opts: DamageOpts = { ...cfg.opts, dmgMult: mult };
    const res = dealDamage(sim, f, t, cfg.base, opts);
    if (!res.hit) continue;
    any = true;
    if (cfg.effects !== undefined) for (let k = 0; k < cfg.effects.length; k++) applyEffect(sim, f, t, cfg.effects[k]);
    if (cfg.pushDist !== undefined && cfg.pushDist > 0) {
      if (cfg.pushDirX !== undefined && cfg.pushDirZ !== undefined) applyDirectionalKnockback(t, cfg.pushDirX, cfg.pushDirZ, cfg.pushDist);
      else applyKnockback(t, cfg.cx, cfg.cz, cfg.pushDist);
    }
  }
  return any;
}

const AOE_HEIGHT = 3.0;

function ultOpts(reaction: 'none' | 'stagger'): DamageOpts {
  return { blockable: true, heavy: true, reaction, isBasic: false };
}

// ── Ultimate lifecycle ───────────────────────────────────────────────────────

/** Begin an ultimate (charge already validated by World). */
export function startUlt(sim: Sim, f: Fighter): void {
  const spec = f.def.ultimate;
  const rt = beginAbility(f, 'ultimate', spec);
  f.state.ultCharge = 0;
  f.state.ultsUsed += 1;

  if (f.def.id === 'eagle') {
    // Death From Above: dive point aimed ahead; soar telegraphed as the windup.
    rt.px = aimX(f, DFA_DIVE_RANGE);
    rt.pz = aimZ(f, DFA_DIVE_RANGE);
    emitCastEvents(sim, f, rt, rt.px, rt.pz, spec.radius ?? 1.2, 0, spec.untargetableT ?? 0);
  } else if (f.def.id === 'mole') {
    rt.px = aimX(f, spec.range ?? 10);
    rt.pz = aimZ(f, spec.range ?? 10);
    emitCastEvents(sim, f, rt, rt.px, rt.pz, spec.radius ?? 4, 0, spec.windup);
  } else if (spec.arcDeg !== undefined && spec.arcDeg < 360 && spec.range !== undefined) {
    emitCastEvents(sim, f, rt, f.state.pos.x, f.state.pos.z, spec.range, spec.arcDeg, spec.windup);
  } else {
    emitCastEvents(sim, f, rt, f.state.pos.x, f.state.pos.z, spec.radius ?? spec.range ?? 8, spec.arcDeg ?? 360, spec.windup);
  }
}

/** Advance an active ultimate one tick. */
export function updateUlt(sim: Sim, f: Fighter, dt: number): void {
  const rt = f.ability;
  if (rt === null) return;
  f.movementOwned = true;
  f.state.actionT += dt;

  if (rt.phase === AbilityPhase.Windup) {
    if (f.def.id === 'eagle') {
      f.untargetable = true;
      f.state.pos.y = groundHeightAt(f.state.pos.x, f.state.pos.z) + 3;
    }
    rt.t += dt;
    const w = f.def.id === 'eagle' ? rt.spec.untargetableT ?? 0 : rt.spec.windup;
    if (rt.t >= w) {
      rt.phase = AbilityPhase.Active;
      rt.t = 0;
      activateUlt(sim, f, rt);
    }
    return;
  }

  if (rt.phase === AbilityPhase.Active) {
    activeUlt(sim, f, rt, dt);
    return;
  }

  // Recovery.
  rt.t += dt;
  const rec = rt.didHit ? LAND_RECOVER : rt.spec.recovery ?? LAND_RECOVER;
  if (rt.t >= rec) endAbility(sim, f);
}

function toRecovery(rt: AbilityRuntime): void {
  rt.phase = AbilityPhase.Recovery;
  rt.t = 0;
}

function activateUlt(sim: Sim, f: Fighter, rt: AbilityRuntime): void {
  const spec = rt.spec;
  switch (f.def.id) {
    case 'lion': {
      // King's Roar: 8 m AoE 100 + fear + feared-vuln; self speed.
      hitArea(sim, f, {
        shape: 'circle',
        cx: f.state.pos.x,
        cz: f.state.pos.z,
        cy: f.state.pos.y,
        yaw: f.state.yaw,
        range: spec.radius ?? 8,
        arcDeg: 360,
        heightTol: AOE_HEIGHT,
        base: spec.damage ?? 100,
        opts: ultOpts('stagger'),
        effects: spec.effects,
      });
      if (spec.selfBuffs !== undefined) for (const b of spec.selfBuffs) applyEffect(sim, f, f, b);
      rt.didHit = true;
      toRecovery(rt);
      return;
    }
    case 'gorilla': {
      // Primal Rampage: self buffs + CC-immunity + knockback basics; free to act.
      if (spec.selfBuffs !== undefined) for (const b of spec.selfBuffs) applyEffect(sim, f, f, b);
      f.rampageTimer = spec.duration ?? 6;
      f.rampageKnockback = spec.knockback ?? 2;
      endAbility(sim, f);
      return;
    }
    case 'panther': {
      // Night Prowl: stealth + speed; first attack is the bonus crit.
      if (spec.selfBuffs !== undefined) for (const b of spec.selfBuffs) applyEffect(sim, f, f, b);
      f.stealthCritPending = true;
      endAbility(sim, f);
      return;
    }
    case 'hippo': {
      // Colossal Chomp: 4 m / 130° cone, 250 + slow.
      rt.didHit = hitArea(sim, f, {
        shape: 'cone',
        cx: f.state.pos.x,
        cz: f.state.pos.z,
        cy: f.state.pos.y,
        yaw: f.state.yaw,
        range: spec.range ?? 4,
        arcDeg: spec.arcDeg ?? 130,
        heightTol: AOE_HEIGHT,
        base: spec.damage ?? 250,
        opts: ultOpts('stagger'),
        effects: spec.effects,
      });
      rt.didHit = true;
      toRecovery(rt);
      return;
    }
    case 'mole': {
      // Sinkhole: 4 m zone at the aim point, 150 + root.
      hitArea(sim, f, {
        shape: 'circle',
        cx: rt.px,
        cz: rt.pz,
        cy: groundHeightAt(rt.px, rt.pz),
        yaw: f.state.yaw,
        range: spec.radius ?? 4,
        arcDeg: 360,
        heightTol: AOE_HEIGHT,
        base: spec.damage ?? 150,
        opts: ultOpts('stagger'),
        effects: spec.effects,
        bonusVsRooted: spec.bonusVsRooted,
      });
      rt.didHit = true;
      toRecovery(rt);
      return;
    }
    case 'eagle': {
      // Death From Above: dive to the aim point, direct + splash.
      f.untargetable = false;
      f.state.pos.x = rt.px;
      f.state.pos.z = rt.pz;
      clampToWall(f);
      f.state.pos.y = groundHeightAt(f.state.pos.x, f.state.pos.z);
      const directHits = new Set<number>();
      const direct = hitArea(sim, f, {
        shape: 'circle',
        cx: f.state.pos.x,
        cz: f.state.pos.z,
        cy: f.state.pos.y,
        yaw: f.state.yaw,
        range: spec.radius ?? 1.2,
        arcDeg: 360,
        heightTol: AOE_HEIGHT,
        base: spec.damage ?? 240,
        opts: ultOpts('stagger'),
        once: directHits,
      });
      const splash = hitArea(sim, f, {
        shape: 'circle',
        cx: f.state.pos.x,
        cz: f.state.pos.z,
        cy: f.state.pos.y,
        yaw: f.state.yaw,
        range: spec.splashRadius ?? 3,
        arcDeg: 360,
        heightTol: AOE_HEIGHT,
        base: spec.splashDamage ?? 60,
        opts: ultOpts('stagger'),
        once: directHits,
      });
      rt.didHit = direct || splash;
      toRecovery(rt);
      return;
    }
    case 'rhino': {
      // Seismic Stampede: steerable CC-immune charge for `duration` s.
      rt.accum = spec.duration ?? 3;
      rt.didHit = true;
      f.ccImmuneChannel = true;
      return; // stays Active
    }
    case 'giraffe': {
      // Guillotine Spin: first of two sweeps now.
      rt.accum = 0;
      rt.counter = 1;
      rt.hitOnce.clear();
      hitArea(sim, f, {
        shape: 'circle',
        cx: f.state.pos.x,
        cz: f.state.pos.z,
        cy: f.state.pos.y,
        yaw: f.state.yaw,
        range: spec.range ?? 4.5,
        arcDeg: 360,
        heightTol: MOVE.heightOverlapGiraffe,
        base: spec.damage ?? 90,
        opts: ultOpts('stagger'),
        once: rt.hitOnce,
      });
      rt.didHit = true;
      return; // stays Active for the second sweep
    }
    case 'crocodile':
    case 'python': {
      // Grab lunge (Death Roll / Constrictor's Embrace): search for a target.
      rt.isGrab = true;
      rt.didHit = false;
      rt.accum = 0;
      return; // stays Active
    }
  }
}

function activeUlt(sim: Sim, f: Fighter, rt: AbilityRuntime, dt: number): void {
  const spec = rt.spec;
  switch (f.def.id) {
    case 'rhino':
      stampede(sim, f, rt, dt);
      return;
    case 'giraffe':
      guillotine(sim, f, rt, dt);
      return;
    case 'crocodile':
    case 'python':
      grabUlt(sim, f, rt, dt);
      return;
    default:
      // Should not reach; fail safe to recovery.
      void spec;
      toRecovery(rt);
      return;
  }
}

function stampede(sim: Sim, f: Fighter, rt: AbilityRuntime, dt: number): void {
  const spec = rt.spec;
  f.ccImmuneChannel = true;
  // Steer toward aim, capped at turnRateDeg.
  const maxTurn = (spec.turnRateDeg ?? 90) * DEG2RAD * dt;
  const curYaw = dirToYaw(rt.dirX, rt.dirZ);
  const newYaw = rotateToward(curYaw, f.intent.aimYaw, maxTurn);
  rt.dirX = Math.sin(newYaw);
  rt.dirZ = Math.cos(newYaw);
  f.state.yaw = newYaw;

  const step = STAMPEDE_SPEED * dt;
  // Break crates in the path first (Stampede plows through, §8).
  for (let i = 0; i < sim.crates.length; i++) {
    const c = sim.crates[i];
    if (!c.alive) continue;
    const dx = c.x - f.state.pos.x;
    const dz = c.z - f.state.pos.z;
    if (Math.sqrt(dx * dx + dz * dz) <= f.def.radius + 0.6 + step) sim.damageCrate(c, c.hp);
  }
  const cr = chargeStep(sim, f, step, false);
  // Run through fighters (once each): 180 + knockdown.
  for (let i = 0; i < sim.fighters.length; i++) {
    const t = sim.fighters[i];
    if (t === f || !t.state.alive || !isTargetable(t) || rt.hitOnce.has(t.id)) continue;
    const dx = t.state.pos.x - f.state.pos.x;
    const dz = t.state.pos.z - f.state.pos.z;
    if (Math.sqrt(dx * dx + dz * dz) <= f.def.radius + t.def.radius + CONTACT_PAD) {
      rt.hitOnce.add(t.id);
      const res = dealDamage(sim, f, t, spec.damage ?? 180, ultOpts('stagger'));
      if (res.hit && spec.effects !== undefined) for (const e of spec.effects) applyEffect(sim, f, t, e);
    }
  }
  rt.accum -= dt;
  if (rt.accum <= 0 || cr.stopped) {
    f.ccImmuneChannel = false;
    toRecovery(rt);
  }
}

function guillotine(sim: Sim, f: Fighter, rt: AbilityRuntime, dt: number): void {
  const spec = rt.spec;
  rt.accum += dt;
  const dur = spec.duration ?? 2;
  if (rt.counter === 1 && rt.accum >= dur * 0.5) {
    rt.counter = 2;
    rt.hitOnce.clear();
    hitArea(sim, f, {
      shape: 'circle',
      cx: f.state.pos.x,
      cz: f.state.pos.z,
      cy: f.state.pos.y,
      yaw: f.state.yaw,
      range: spec.range ?? 4.5,
      arcDeg: 360,
      heightTol: MOVE.heightOverlapGiraffe,
      base: spec.damage ?? 90,
      opts: ultOpts('stagger'),
      effects: spec.effects, // second sweep knocks down
      once: rt.hitOnce,
    });
  }
  if (rt.accum >= dur) toRecovery(rt);
}

function grabUlt(sim: Sim, f: Fighter, rt: AbilityRuntime, dt: number): void {
  const spec = rt.spec;
  if (!rt.didHit) {
    // Lunge forward searching for a target.
    const step = DASH_SPEED * dt;
    rt.accum += step;
    f.state.pos.x += rt.dirX * step;
    f.state.pos.z += rt.dirZ * step;
    clampToWall(f);
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
        f.incomingDamageReduction = spec.damageReduction ?? 0;
        rt.accum = 0; // reuse as roll elapsed
        t.interrupt();
        break;
      }
    }
    if (!rt.didHit && rt.accum >= (spec.range ?? 4)) {
      toRecovery(rt); // whiff
    }
    return;
  }
  // Rolling / wrapping the grabbed target.
  const t = sim.fighters[rt.targetId];
  const dur = spec.duration ?? 3;
  rt.accum += dt;
  f.state.action = 'grab';
  if (t !== undefined && t.state.alive) {
    t.movementOwned = true;
    t.state.grabbedById = f.id;
    t.state.action = 'grabbed';
    t.state.pos.x = f.state.pos.x + rt.dirX * (f.def.radius + t.def.radius);
    t.state.pos.z = f.state.pos.z + rt.dirZ * (f.def.radius + t.def.radius);
    t.state.pos.y = f.state.pos.y;
    t.staggerTimer = Math.max(t.staggerTimer, dur - rt.accum + 0.05); // stunned
    const dps = (spec.damage ?? 240) / dur;
    sim.applyBleedDamage(f, t, dps * dt);
  }
  if (rt.accum >= dur || t === undefined || !t.state.alive) {
    if (t !== undefined) {
      t.state.grabbedById = -1;
      t.movementOwned = false;
    }
    rt.targetId = -1;
    toRecovery(rt);
  }
}
