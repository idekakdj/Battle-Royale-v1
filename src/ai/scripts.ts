/**
 * Per-animal ability decisions (BLUEPRINT §10 tables + Apex scripts).
 *
 * The brain fills one reusable {@link Situation} at each 10 Hz decision tick;
 * `decideAbilities` writes a reusable {@link AbilityWish}. Which logic runs is
 * governed ONLY by the profile's `specialUse` / `ultimateUse` modes — L1 rolls
 * randomly, L2 gap-closes, L3 adds escape/peel, L4 runs the full scripts.
 *
 * Range gates respect the sim's aimed-ability rule (WP-B integration note):
 * aimed ground-point abilities land at MAX RANGE along aimYaw, so e.g. lion
 * Pounce is only thrown when the target stands near the 8 m landing point.
 */

import type { AnimalId } from '../core/types';
import type { BotProfile } from '../config/botProfiles';
import type { Rng } from '../core/math';

export interface Situation {
  animal: AnimalId;
  profile: BotProfile;
  rng: Rng;
  now: number;

  // Self.
  hpFrac: number;
  guardFrac: number;
  specialReady: boolean;
  ultReady: boolean;
  retreating: boolean;

  // Target (best-known).
  hasTarget: boolean;
  tdist: number;
  tHpFrac: number;
  tGuardFrac: number;
  targetHelpless: boolean; // staggered / knocked down / grabbed / feared
  targetRooted: boolean;
  targetBlocking: boolean;
  /** Target is mid-special/ultimate (committed) — python Constrict punish. */
  targetCommitted: boolean;
  /** Target moving away from us faster than ~3 m/s (kiter) — mole Sinkhole. */
  targetFleeing: boolean;
  /** No other enemy within 8 m of the target. */
  targetIsolated: boolean;

  // Local density.
  nearestEnemyDist: number;
  enemiesNearSelf5: number;
  enemiesNearSelf8: number;
  enemiesNearTarget8: number;

  /** Rhino: geometry says a Lockdown Charge would slam target into wall/pillar. */
  wallBehindTarget: boolean;
  /** Own combo finisher landed within the last 2 s (Veteran ult trigger). */
  recentFinisher: boolean;

  /** Noisy yaw toward the target, provided by the brain. */
  aimYawToTarget: number;
  /** Noisy yaw away from the target (escape casts). */
  aimYawAway: number;
  /** Noisy yaw toward the nearest enemy (peel casts). */
  aimYawNearest: number;
}

export interface AbilityWish {
  special: boolean;
  ult: boolean;
  /** Aim to use for whichever edge fires. */
  aimYaw: number;
}

// ── Special-range gates ───────────────────────────────────────────────────────
// Aimed ground-point specials land at max range: gate = landing ± radius slack.

function specialGapGate(animal: AnimalId, d: number): boolean {
  switch (animal) {
    case 'lion':
      return d >= 6.8 && d <= 9.2; // Pounce lands at 8, hit radius 1.5
    case 'gorilla':
      return d >= 4.9 && d <= 9.1; // Leap lands at 7, AoE 2.5
    case 'crocodile':
      return d >= 3.2 && d <= 7.5; // 7 m dash then boosted Snap
    case 'hippo':
      return d >= 4 && d <= 11; // River Rush 11 m/s × 1.2 s
    case 'rhino':
      return d >= 5 && d <= 11; // Lockdown Charge up to 12 m
    case 'panther':
      return d >= 3.5 && d <= 7.5; // Shadow Dash 7 m through
    case 'mole':
      return d >= 4 && d <= 11; // Burrow approach (8.5 m/s ≤ 3 s)
    case 'eagle':
      return d <= 4.3; // Gale Burst 5 m cone (not a closer; in-range poke)
    case 'python':
      return d <= 2.7; // Coil Sweep 3 m, 360°
    case 'giraffe':
      return d <= 2.3; // Thunder Kick 2.5 m cone
    default:
      return false;
  }
}

/** Escape specials (L3 'escape' / L4 disengage): cast away from the target. */
function isEscapeSpecial(animal: AnimalId): boolean {
  return animal === 'panther' || animal === 'mole' || animal === 'crocodile' || animal === 'lion';
}

// ── Ultimate range gates (per-animal effective range) ────────────────────────

function ultGate(s: Situation): boolean {
  const d = s.tdist;
  switch (s.animal) {
    case 'lion':
      return d <= 7; // 8 m instant AoE roar
    case 'gorilla':
      return d <= 4; // self-buff — only worth it in melee
    case 'crocodile':
      return d <= 4.4; // 4 m grab lunge
    case 'hippo':
      return d <= 3.4; // 4 m cone after 1 s windup
    case 'rhino':
      return d <= 9; // 3 s steerable stampede
    case 'eagle':
      return d >= 5.6 && d <= 10.4; // DFA dives at 8 m along aim (splash 3)
    case 'panther':
      return d >= 5 && d <= 15; // Night Prowl = stealth approach tool
    case 'python':
      return d <= 4.8; // 5 m grab lunge
    case 'giraffe':
      return d <= 4; // 4.5 m spin
    case 'mole':
      return d >= 6.8 && d <= 13; // Sinkhole zone lands at 10 m, radius 4
    default:
      return false;
  }
}

/** AoE ults that pay off on clusters (Veteran trigger). */
function clusterUlt(s: Situation): boolean {
  switch (s.animal) {
    case 'lion':
      return s.enemiesNearSelf8 >= 2;
    case 'giraffe':
    case 'rhino':
    case 'hippo':
      return s.enemiesNearSelf5 >= 2;
    default:
      return false;
  }
}

// ── Public entry ─────────────────────────────────────────────────────────────

export function decideAbilities(s: Situation, out: AbilityWish): void {
  out.special = false;
  out.ult = false;
  out.aimYaw = s.aimYawToTarget;

  if (s.specialReady) decideSpecial(s, out);
  if (!out.special && s.ultReady) decideUltimate(s, out);
}

function decideSpecial(s: Situation, out: AbilityWish): void {
  const p = s.profile;
  switch (p.specialUse) {
    case 'randomOffCd':
      // Cub: small chance whenever off cooldown with someone vaguely near.
      if (s.hasTarget && s.tdist <= 12 && s.rng() < p.specialRandomChance) {
        out.special = true;
        out.aimYaw = s.aimYawToTarget;
      }
      return;

    case 'gapCloser':
      if (s.hasTarget && specialGapGate(s.animal, s.tdist)) {
        out.special = true;
        out.aimYaw = s.aimYawToTarget;
      }
      return;

    case 'gapCloseEscapePeel':
      // Escape: low HP + a mobility special → cast away from the target.
      if (s.retreating && isEscapeSpecial(s.animal) && s.nearestEnemyDist < 5) {
        out.special = true;
        out.aimYaw = s.aimYawAway;
        return;
      }
      // Peel: someone on top of us and the special hits at melee range.
      if (
        s.nearestEnemyDist <= 2.5 &&
        (s.animal === 'giraffe' || s.animal === 'python' || s.animal === 'eagle' || s.animal === 'gorilla')
      ) {
        out.special = true;
        out.aimYaw = s.aimYawNearest;
        return;
      }
      if (s.hasTarget && specialGapGate(s.animal, s.tdist)) {
        out.special = true;
        out.aimYaw = s.aimYawToTarget;
      }
      return;

    case 'fullScripts':
      decideSpecialApex(s, out);
      return;
  }
}

/** Apex per-animal special scripts (§10). */
function decideSpecialApex(s: Situation, out: AbilityWish): void {
  if (!s.hasTarget) return;
  const d = s.tdist;
  out.aimYaw = s.aimYawToTarget;

  switch (s.animal) {
    case 'lion':
      // Pounce → full combo (combo follows naturally once on top).
      out.special = specialGapGate('lion', d);
      return;
    case 'gorilla':
      // Leap-slam onto the target or peel a diver.
      if (s.nearestEnemyDist <= 2.2 && s.hpFrac < 0.6) {
        out.special = true;
        out.aimYaw = s.aimYawNearest;
        return;
      }
      out.special = specialGapGate('gorilla', d);
      return;
    case 'crocodile':
      // Ambush Lunge → boosted Snap (brain presses attack in the 1 s window).
      out.special = specialGapGate('crocodile', d) && !s.targetBlocking;
      return;
    case 'hippo':
      out.special = specialGapGate('hippo', d);
      return;
    case 'rhino':
      // Angle Lockdown Charge to slam the carried target into geometry.
      if (s.wallBehindTarget && d >= 2.5 && d <= 10) {
        out.special = true;
        return;
      }
      // Otherwise still a decent closer, used sparingly.
      out.special = d >= 6.5 && d <= 11 && s.rng() < 0.35;
      return;
    case 'eagle':
      // Gale Burst as combo-exit / peel (hit-and-run handled by the brain).
      if (s.nearestEnemyDist <= 3.8 && (s.retreating || s.guardFrac < 0.5)) {
        out.special = true;
        out.aimYaw = s.aimYawNearest;
        return;
      }
      out.special = d <= 4.3 && s.rng() < 0.5;
      return;
    case 'panther':
      // Dash out after work is done, or dash through to reset the combo.
      if (s.retreating && s.nearestEnemyDist < 5) {
        out.special = true;
        out.aimYaw = s.aimYawAway;
        return;
      }
      out.special = specialGapGate('panther', d) && !s.targetBlocking;
      return;
    case 'python':
      // Coil Sweep punishes anyone who closes in.
      out.special = s.nearestEnemyDist <= 2.7;
      if (out.special) out.aimYaw = s.aimYawNearest;
      return;
    case 'giraffe':
      // Thunder Kick peels pursuers off max-range spacing.
      out.special = s.nearestEnemyDist <= 2.4;
      if (out.special) out.aimYaw = s.aimYawNearest;
      return;
    case 'mole':
      // Burrow-ambush loop: approach underground, erupt beneath them.
      out.special = specialGapGate('mole', d) || (s.retreating && s.nearestEnemyDist < 4);
      if (s.retreating) out.aimYaw = s.aimYawAway;
      return;
  }
}

function decideUltimate(s: Situation, out: AbilityWish): void {
  if (!s.hasTarget) return;
  const p = s.profile;
  out.aimYaw = s.aimYawToTarget;

  switch (p.ultimateUse) {
    case 'enemyWithinRange':
      // Cub: fire on charge whenever an enemy is inside the flat range gate.
      out.ult = s.tdist <= p.ultimateRangeM && ultGate(s);
      return;

    case 'targetInUltRange':
      out.ult = ultGate(s);
      return;

    case 'afterFinisherOrCluster':
      out.ult = (s.recentFinisher && ultGate(s)) || clusterUlt(s);
      return;

    case 'optimalWindows':
      decideUltimateApex(s, out);
      return;
  }
}

/** Apex ults: helpless targets, saves vs bad trades (§10). */
function decideUltimateApex(s: Situation, out: AbilityWish): void {
  // Bad trade: outnumbered around self — save the charge.
  if (s.enemiesNearSelf8 >= 3) return;

  const helpless = s.targetHelpless || s.targetRooted;

  switch (s.animal) {
    case 'lion':
      out.ult = (s.enemiesNearSelf8 >= 2 && s.tdist <= 7) || (helpless && s.tdist <= 7);
      return;
    case 'gorilla':
      // Rampage when the target's guard is nearly cracked (§10: guard <35%).
      out.ult = s.tdist <= 4 && (s.tGuardFrac < 0.35 || helpless);
      return;
    case 'crocodile':
      out.ult = ultGate(s) && (helpless || s.tHpFrac <= 0.4);
      return;
    case 'hippo':
      // Chomp on guard-break (1 s windup fits inside the 1.5 s stagger).
      out.ult = ultGate(s) && helpless;
      return;
    case 'rhino':
      out.ult = (s.enemiesNearSelf8 >= 2 && s.tdist <= 9) || (helpless && s.tdist <= 8);
      return;
    case 'eagle':
      // DFA on isolated or helpless targets near the 8 m dive point.
      out.ult = ultGate(s) && (helpless || (s.targetIsolated && s.tHpFrac <= 0.55));
      return;
    case 'panther':
      // Night Prowl as the approach tool when healthy; backstab crit follows.
      out.ult = ultGate(s) && s.hpFrac > 0.4 && !s.targetHelpless;
      return;
    case 'python':
      // Constrict punishes committed specials and helpless targets.
      out.ult = s.tdist <= 4.8 && (s.targetCommitted || helpless || s.tHpFrac <= 0.35);
      return;
    case 'giraffe':
      out.ult = s.enemiesNearSelf5 >= 2 || (helpless && s.tdist <= 4);
      return;
    case 'mole':
      // Sinkhole on kiters and rooted/staggered targets near the 10 m point.
      out.ult = ultGate(s) && (s.targetFleeing || helpless || s.targetBlocking);
      return;
  }
}
