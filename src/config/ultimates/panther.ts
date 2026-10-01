/**
 * Panther ultimate spec — SHADOW EXECUTION (v1.3 Phase 2; imported by config/animals.ts).
 * The sim logic lives in src/sim/ultimates/panther.ts, the bot script in src/ai/ultScripts/panther.ts,
 * the rig timeline in src/render/animals/ultPose/panther.ts (all read {@link PANTHER_EXEC}).
 *
 * Sequence (seconds from cast): 0–0.35 melt into shadow (stealth fade; interruptible) ·
 * from 0.35 the panther is CC-immune and takes −60% damage · 5 shadow-step strikes 0.22 s apart
 * (each = `blink` + `ultimateStage`, 40 dmg, guard-piercing 50%, from a changing angle around
 * the victim) · a sixth step lands BEHIND them for the heavy finisher (85 dmg + 90 execute
 * bonus when the victim is below 35% HP) · ~1 s recovery, visible again, vulnerable.
 * Single-target total on an unblocked victim: 5 × 40 + 85 = 285 (375 with the execute bonus).
 */

import type { AbilitySpec } from '../animals';

/** Timeline + numbers shared by the sim, the bot script and the rig pose module. */
export const PANTHER_EXEC = {
  /** Melt into shadow (s). */
  windup: 0.35,
  /** Shadow-step strikes before the finisher. */
  strikes: 5,
  /** Blink-to-blink spacing (s); the finisher's blink follows the last strike after one more gap. */
  strikeGap: 0.22,
  /** Blink → claws land (s). */
  strikeImpactDelay: 0.08,
  /** Finisher blink → heavy strike lands (s), and the finisher beat length (s). */
  finisherImpactDelay: 0.16,
  finisherBeat: 0.4,
  /** Damage per strike / finisher, execute rule. */
  strikeDamage: 40,
  strikeBlockIgnore: 0.5,
  finisherDamage: 85,
  executeBelow: 0.35,
  executeBonus: 90,
  /** Damage taken while in shadow (−60%). */
  shadowReduction: 0.6,
  /** Recovery after the finisher (s); a broken sequence (victim gone) recovers this long. */
  recovery: 1.0,
  brokenRecovery: 0.5,
  /** Strike k lands from angle θ0 + strikeAngles[k] (rad) around the victim; θ0 = the panther's bearing at cast. */
  strikeAngles: [1.4, -2.1, 2.8, -0.9, 1.95],
  /** Distance from the victim's centre = victimR + pantherR + ringPad. */
  ringPad: 0.3,
  /** Reach (m beyond touching bodies) a strike still connects at (the victim may have shifted). */
  strikeReach: 1.5,
  /** Beat indices (`ultimateStage`): 0 = melt, 1..5 strikes, 6 finisher, 7 execute flash (only when it triggers). */
  stage: { melt: 0, strike0: 1, finisher: 6, execute: 7 },
} as const;

/** Seconds from cast to strike k's blink (k = 0..4) — and to the finisher blink at k = strikes. */
export function pantherBlinkTime(k: number): number {
  return PANTHER_EXEC.windup + k * PANTHER_EXEC.strikeGap;
}
/** Seconds from cast until the finisher beat ends (recovery begins). */
export const PANTHER_T_RECOVERY = pantherBlinkTime(PANTHER_EXEC.strikes) + PANTHER_EXEC.finisherBeat;
/** Seconds from cast until a full sequence ends. */
export const PANTHER_T_END = PANTHER_T_RECOVERY + PANTHER_EXEC.recovery;

export const PANTHER_ULTIMATE: AbilitySpec = {
  name: 'Shadow Execution',
  description:
    'Lock on within 11 m and melt into shadow (−60% damage taken, CC-immune). Five shadow-step strikes (40 each, half-piercing guard), then a heavy finisher from behind (85, +90 execute below 35% HP). No target: nothing is spent.',
  cooldown: 0,
  windup: PANTHER_EXEC.windup,
  damage: PANTHER_EXEC.strikeDamage,
  bonusDamage: PANTHER_EXEC.executeBonus, // execute bonus
  splashDamage: PANTHER_EXEC.finisherDamage, // heavy finisher
  hits: PANTHER_EXEC.strikes,
  range: 11,
  duration: PANTHER_T_END - PANTHER_EXEC.windup, // rig/actionDur only
  recovery: PANTHER_EXEC.recovery,
  damageReduction: PANTHER_EXEC.shadowReduction,
  ccImmune: true,
  targeting: { kind: 'lock', range: 11, coneDeg: 70, requireTarget: true },
};
