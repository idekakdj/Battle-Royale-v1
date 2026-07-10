/**
 * Combat — the single implementation of the damage pipeline (BLUEPRINT §7.1),
 * block/guard (§7.4), 3-hit combos + ult charge (§7.2/§7.3) and hit reactions
 * (§7.3). `dealDamage` is the one entry point every basic AND ability hit flows
 * through, so §7.1 is honoured everywhere.
 */

import type { Fighter, Sim } from './Fighter';
import { DAMAGE, GUARD, REACT, COMBO, ULT, MOVE } from '../config/balance';
import { SHOVE_RANGE, SHOVE_ARC_DEG } from './simTuning';
import { clamp01 } from '../core/math';
import { isBehind, inFrontArc, meleeArcHit, coneHit, circleHit } from './hitbox';
import {
  hasBuff,
  removeBuff,
  addBuff,
  dmgTakenMult,
  atkSpeedMult,
  applyEffect,
  applyKnockback,
} from './StatusEffects';

/** Options controlling one pass through the damage pipeline. */
export interface DamageOpts {
  /** Can the target's block reduce this? (grabs/DoT are false.) */
  blockable: boolean;
  /** hit-event `heavy` flag (finishers/specials/ults). */
  heavy: boolean;
  /** Hit reaction on an unblocked hit. */
  reaction: 'none' | 'flinch' | 'stagger';
  /** Basic melee (enables rhino thorns / python tension against the blocker). */
  isBasic: boolean;
  /** Fraction of the target's block reduction ignored (eagle Beak Pierce 0.5). */
  blockIgnore?: number;
  /** Conditional damage multiplier (ambush 1.6, tension 1.3, rooted 1.25…). */
  dmgMult?: number;
  /** Flat pre-multiplier bonus (panther stealth crit +200). */
  flatBonus?: number;
  /** Allow panther backstab passive (default true). */
  allowBackstab?: boolean;
  /** Knockback applied on an unblocked hit (m) — gorilla Rampage basics. */
  knockbackOnHit?: number;
}

export interface DamageResult {
  dealt: number;
  blocked: boolean;
  hit: boolean;
}

const RESULT: DamageResult = { dealt: 0, blocked: false, hit: false };

function isStationary(f: Fighter): boolean {
  return Math.abs(f.state.vel.x) < 0.1 && Math.abs(f.state.vel.z) < 0.1;
}

/**
 * Run the full §7.1 damage pipeline from `attacker` onto `target`, applying
 * block, guard drain, guard-break, stats, events and hit reactions. Returns the
 * hp actually removed and whether it was blocked.
 */
export function dealDamage(sim: Sim, attacker: Fighter, target: Fighter, base: number, o: DamageOpts): DamageResult {
  RESULT.dealt = 0;
  RESULT.blocked = false;
  RESULT.hit = false;
  if (!target.state.alive) return RESULT;

  let dmg = base + (o.flatBonus ?? 0);

  // Attacker rage (§7.1).
  if (hasBuff(attacker, 'rage')) dmg *= DAMAGE.rageMult;

  // Panther backstab passive.
  const allowBackstab = o.allowBackstab !== false;
  const back = attacker.def.perks.backstabMult;
  if (allowBackstab && back !== undefined && isBehind(target, attacker.x, attacker.z, attacker.def.perks.backstabArcDeg ?? DAMAGE.backstabArcDeg)) {
    dmg *= back;
  }

  // Conditional multipliers (ambush / tension / rooted / stealth-speed etc.).
  if (o.dmgMult !== undefined) dmg *= o.dmgMult;

  // Crowd's Bloodlust.
  dmg *= sim.bloodlustMult;

  // Target vulnerability.
  if (target.staggerTimer > 0) dmg *= DAMAGE.staggeredVulnMult;
  dmg *= dmgTakenMult(target); // feared-vuln & other dmgTakenUp buffs
  if (hasBuff(target, 'armorUp')) dmg *= DAMAGE.armorUpMult;

  // Grabber damage reduction (croc Death Roll / python Embrace).
  if (target.incomingDamageReduction > 0) dmg *= 1 - target.incomingDamageReduction;

  // Block check (§7.1 / §7.4).
  const blocking =
    o.blockable && target.blocking && target.state.guard > 0 && inFrontArc(target, attacker.x, attacker.z, GUARD.blockArcDeg);

  if (blocking) {
    let reduction = target.def.blockReduction;
    if (target.def.perks.stationaryBlockBonus !== undefined && isStationary(target)) {
      reduction += target.def.perks.stationaryBlockBonus;
    }
    if (o.blockIgnore !== undefined) reduction *= 1 - o.blockIgnore;
    reduction = clamp01(reduction);
    const dealt = dmg * (1 - reduction);
    const drain = dmg * GUARD.drainFactor;
    target.state.guard = Math.max(0, target.state.guard - drain);
    target.state.damageBlocked += dmg - dealt;
    target.state.guardRegenDelay = GUARD.regenDelay;
    target.lastBlockedHitTime = sim.time;

    handleBlockPerks(sim, attacker, target, o.isBasic);

    sim.dealHp(attacker, target, dealt);
    sim.emit({ type: 'blocked', attackerId: attacker.id, targetId: target.id, damage: Math.round(dealt), pos: cloneXZ(target) });

    if (target.state.guard <= 0) guardBreak(sim, target);

    RESULT.dealt = dealt;
    RESULT.blocked = true;
    RESULT.hit = true;
    return RESULT;
  }

  // Unblocked.
  sim.dealHp(attacker, target, dmg);
  sim.emit({ type: 'hit', attackerId: attacker.id, targetId: target.id, damage: Math.round(dmg), pos: cloneXZ(target), heavy: o.heavy });
  if (o.reaction !== 'none') applyReaction(target, o.reaction);
  if (o.knockbackOnHit !== undefined && o.knockbackOnHit > 0) applyKnockback(target, attacker.x, attacker.z, o.knockbackOnHit);

  RESULT.dealt = dmg;
  RESULT.blocked = false;
  RESULT.hit = true;
  return RESULT;
}

function cloneXZ(f: Fighter): { x: number; y: number; z: number } {
  return { x: f.state.pos.x, y: f.state.pos.y, z: f.state.pos.z };
}

/** Block-perk reactions triggered by a successfully blocked hit (§7.4). */
function handleBlockPerks(sim: Sim, attacker: Fighter, target: Fighter, isBasic: boolean): void {
  const perks = target.def.perks;

  // Python tension: store a stack for the next strike.
  if (perks.tensionBonus !== undefined) target.pythonTension = true;

  // Rhino thorns: melee attackers hitting the block take thorn damage.
  if (perks.thornDamage !== undefined && isBasic && attacker.state.alive) {
    sim.dealHp(target, attacker, perks.thornDamage);
    sim.emit({ type: 'hit', attackerId: target.id, targetId: attacker.id, damage: perks.thornDamage, pos: cloneXZ(attacker), heavy: false });
  }

  // Panther perfect-block counter.
  if (perks.perfectBlockCounter !== undefined && sim.time - target.blockStartTime <= perks.perfectBlockCounter.window) {
    dealDamage(sim, target, attacker, perks.perfectBlockCounter.damage, {
      blockable: false,
      heavy: true,
      reaction: 'stagger',
      isBasic: false,
      allowBackstab: false,
    });
  }
}

/** Guard break (§7.4): stagger 1.5 s + vuln, refill to 50% after it ends. */
export function guardBreak(sim: Sim, target: Fighter): void {
  target.state.guard = 0;
  target.blocking = false;
  target.staggerTimer = Math.max(target.staggerTimer, GUARD.breakStagger);
  target.guardBreakRefillPending = true;
  target.interrupt();
  sim.emit({ type: 'guardBreak', targetId: target.id, pos: cloneXZ(target) });
}

/** Apply a flinch or stagger reaction (blocking already excluded, §7.3). */
export function applyReaction(target: Fighter, kind: 'flinch' | 'stagger'): void {
  if (target.ccImmune) return;
  if (kind === 'flinch') {
    if (!target.swinging && target.ability === null && !target.blocking && target.staggerTimer <= 0 && target.knockdownTimer <= 0) {
      target.hitstunTimer = Math.max(target.hitstunTimer, REACT.flinch);
    }
  } else {
    target.staggerTimer = Math.max(target.staggerTimer, REACT.finisherStagger);
    target.interrupt();
  }
}

// ── Block engage / guard regen (§7.4) ────────────────────────────────────────

/** Engage or release block, honouring the gorilla parry-shove release window. */
export function setBlocking(sim: Sim, f: Fighter, desired: boolean): void {
  if (desired && !f.blocking) {
    f.blocking = true;
    f.blockStartTime = sim.time;
    f.state.yaw = f.intent.aimYaw;
  } else if (!desired && f.blocking) {
    f.blocking = false;
    const shove = f.def.perks.parryShove;
    if (shove !== undefined && sim.time - f.lastBlockedHitTime <= shove.window) {
      doShove(sim, f, shove.damage, shove.knockback);
    }
  }
}

function doShove(sim: Sim, f: Fighter, damage: number, knockback: number): void {
  for (let i = 0; i < sim.fighters.length; i++) {
    const t = sim.fighters[i];
    if (t === f || !t.state.alive) continue;
    if (coneHit(f.x, f.state.pos.z, f.state.pos.y, f.state.yaw, SHOVE_RANGE, SHOVE_ARC_DEG, t, MOVE.heightOverlap)) {
      const res = dealDamage(sim, f, t, damage, { blockable: false, heavy: true, reaction: 'stagger', isBasic: false });
      if (res.hit) applyKnockback(t, f.x, f.state.pos.z, knockback);
    }
  }
}

/** Guard regen + post-guard-break refill (§7.4). Call once per tick. */
export function updateGuard(f: Fighter, dt: number): void {
  if (f.guardBreakRefillPending && f.staggerTimer <= 0) {
    f.state.guard = f.state.maxGuard * GUARD.breakRefill;
    f.guardBreakRefillPending = false;
  }
  if (f.state.guardRegenDelay <= 0 && f.state.guard < f.state.maxGuard) {
    f.state.guard = Math.min(f.state.maxGuard, f.state.guard + GUARD.regenPerSec * dt);
  }
}

// ── 3-hit combo (§7.2 / §7.3) ────────────────────────────────────────────────

function swingDuration(f: Fighter): number {
  return 1 / (f.def.attackRate * atkSpeedMult(f));
}

function startSwing(f: Fighter, step: 0 | 1 | 2): void {
  f.swinging = true;
  f.hasHitThisSwing = false;
  f.chainQueued = false;
  f.state.comboIndex = step;
  f.state.action = step === 0 ? 'attack1' : step === 1 ? 'attack2' : 'attack3';
  f.state.actionT = 0;
  f.state.actionDur = swingDuration(f);
  f.state.yaw = f.intent.aimYaw;
  f.state.comboWindow = 0;
  f.sinceSwingEnd = 999;
}

/** Handle an attack edge: start a swing, or queue the next combo step (§7.2). */
export function tryStartSwing(f: Fighter): void {
  if (f.blocking || f.isDisabled() || f.ability !== null || f.state.airborne || f.disarmTimer > 0 || f.hitstunTimer > 0) return;
  if (f.swinging) {
    // Queue only during the last `chainWindowFraction` of the swing.
    if (f.state.actionT >= f.state.actionDur * (1 - COMBO.chainWindowFraction) && f.state.comboIndex < 2) {
      f.chainQueued = true;
    }
    return;
  }
  // Not swinging: continue combo if within the post-swing window, else fresh.
  const step: 0 | 1 | 2 = f.sinceSwingEnd <= COMBO.chainWindowAfter ? f.nextComboStep : 0;
  startSwing(f, step);
}

/** Advance an in-progress swing; apply the impact at 55% and handle chaining. */
export function updateSwing(sim: Sim, f: Fighter, dt: number): void {
  if (!f.swinging) {
    f.sinceSwingEnd += dt;
    f.state.comboWindow = Math.max(0, COMBO.chainWindowAfter - f.sinceSwingEnd);
    if (f.sinceSwingEnd > COMBO.resetTime) f.nextComboStep = 0;
    return;
  }
  f.state.actionT += dt;
  const impactAt = f.state.actionDur * COMBO.impactFraction;
  if (!f.hasHitThisSwing && f.state.actionT >= impactAt) {
    f.hasHitThisSwing = true;
    resolveSwingHit(sim, f);
  }
  if (f.state.actionT >= f.state.actionDur * (1 - COMBO.chainWindowFraction)) {
    f.state.comboWindow = f.state.actionDur - f.state.actionT + COMBO.chainWindowAfter;
  }
  if (f.state.actionT >= f.state.actionDur) {
    const step = f.state.comboIndex;
    if (f.chainQueued && step < 2) {
      startSwing(f, (step + 1) as 0 | 1 | 2);
    } else {
      f.swinging = false;
      f.sinceSwingEnd = 0;
      f.nextComboStep = (step < 2 ? step + 1 : 0) as 0 | 1 | 2;
    }
  }
}

function resolveSwingHit(sim: Sim, f: Fighter): void {
  const step = f.state.comboIndex;
  const isFinisher = step === 2;
  const base = f.def.combo[step];
  const heightTol = f.def.id === 'giraffe' ? MOVE.heightOverlapGiraffe : MOVE.heightOverlap;

  // Conditional damage bonuses consumed by this strike.
  let dmgMult = 1;
  let flatBonus = 0;
  if (f.def.id === 'crocodile' && f.ambushBonusTimer > 0 && f.def.special.followupBonus !== undefined) {
    dmgMult *= 1 + f.def.special.followupBonus;
    f.ambushBonusTimer = 0;
  }
  if (f.def.id === 'python' && f.pythonTension && f.def.perks.tensionBonus !== undefined) {
    dmgMult *= 1 + f.def.perks.tensionBonus;
    f.pythonTension = false;
  }
  if (f.def.id === 'panther' && f.stealthCritPending) {
    flatBonus += f.def.ultimate.stealthBonusDamage ?? 0;
    f.stealthCritPending = false;
    removeBuff(f, 'stealth');
  }
  const kb = f.rampageKnockback;
  const blockIgnore = isFinisher ? f.def.finisher.blockIgnore : undefined;

  let landedAny = false;
  let landedUnblocked = false;

  // Gorilla finisher is a 2.5 m slam (radius), not the normal arc (§8).
  const gorillaSlam = isFinisher && f.def.id === 'gorilla' && f.def.finisher.radius !== undefined;

  for (let i = 0; i < sim.fighters.length; i++) {
    const t = sim.fighters[i];
    if (t === f || !t.state.alive) continue;
    const hit = gorillaSlam
      ? circleHit(f.x, f.state.pos.z, f.state.pos.y, f.def.finisher.radius as number, t, heightTol)
      : meleeArcHit(f, t, f.def.range, f.def.arcDeg, heightTol);
    if (!hit) continue;
    const res = dealDamage(sim, f, t, base, {
      blockable: true,
      heavy: isFinisher,
      reaction: isFinisher ? 'stagger' : 'flinch',
      isBasic: true,
      dmgMult,
      flatBonus,
      blockIgnore,
      knockbackOnHit: kb > 0 ? kb : undefined,
    });
    if (res.hit) {
      landedAny = true;
      if (!res.blocked) landedUnblocked = true;
      if (isFinisher) applyFinisherEffects(sim, f, t, res.blocked);
    }
  }

  // Basic swings damage crates within the arc (crates are attackable, §9).
  for (let i = 0; i < sim.crates.length; i++) {
    const c = sim.crates[i];
    if (!c.alive) continue;
    const dx = c.x - f.x;
    const dz = c.z - f.state.pos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist <= f.def.range + 0.5) sim.damageCrate(c, base);
  }

  // Ult charge on landed basics only (§7.2), halved when only chip/blocked.
  if (landedAny) {
    const gain = step === 2 ? ULT.gainFinisher : step === 0 ? ULT.gainHit1 : ULT.gainHit2;
    const grant = landedUnblocked ? gain : gain * ULT.blockedGainMult;
    f.state.ultCharge = Math.min(ULT.max, f.state.ultCharge + grant);
  }

  if (isFinisher) sim.emit({ type: 'comboFinisher', fighterId: f.id });
}

/** Finisher-specific side effects (§8): bleed, slow, launch, mini-stagger, blind. */
function applyFinisherEffects(sim: Sim, f: Fighter, target: Fighter, blocked: boolean): void {
  const fin = f.def.finisher;
  // Rhino Horn Fling launch (a knockback).
  if (fin.launch !== undefined && !blocked) applyKnockback(target, f.x, f.state.pos.z, fin.launch);
  if (fin.effects !== undefined) {
    for (let i = 0; i < fin.effects.length; i++) {
      const e = fin.effects[i];
      // Bleed is unblockable; other CC only lands on an unblocked finisher.
      if (blocked && e.kind !== 'bleed') continue;
      applyEffect(sim, f, target, e);
    }
  }
  // Mole Dirt Slinger: blind everyone in a 3 m cone (already applied above to the
  // arc target; extend the blind to the wider cone).
  if (f.def.id === 'mole' && fin.coneRange !== undefined) {
    for (let i = 0; i < sim.fighters.length; i++) {
      const t = sim.fighters[i];
      if (t === f || !t.state.alive) continue;
      if (coneHit(f.x, f.state.pos.z, f.state.pos.y, f.state.yaw, fin.coneRange, fin.coneArcDeg ?? f.def.arcDeg, t, MOVE.heightOverlap)) {
        addBuff(t, 'blind', 0, 1);
      }
    }
  }
}
