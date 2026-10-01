/**
 * Lion ultimate spec — ROYAL HUNT (v1.3 Phase 2; imported by config/animals.ts).
 * The sim logic lives in src/sim/ultimates/lion.ts, the bot script in src/ai/ultScripts/lion.ts,
 * the rig timeline in src/render/animals/ultPose/lion.ts (all read {@link LION_HUNT}).
 *
 * Sequence (seconds from cast): 0–0.55 eye-lock + coil (interruptible) · 0.55–1.05 bounding
 * pounce (CC-immune from here on) · landing pins the victim (65, knockdown) · 4 guard-piercing
 * maul strikes 0.3 s apart (48 each; one `ultimateStage` per strike) · face-to-face roar that
 * MARKS the victim (+20% damage taken 6 s, 35 dmg, stagger) and gives the lion +20% speed 4 s ·
 * 0.45 s settle. A pounce that misses (victim out of reach / jumped) recovers for 0.9 s.
 * Single-target total on an unblocked victim: 65 + 4×48 + 35 = 292 (+ the mark's follow-up).
 */

import type { AbilitySpec } from '../animals';

/** Timeline + numbers shared by the sim, the bot script and the rig pose module. */
export const LION_HUNT = {
  /** Eye-lock / coil (s). The reticle tracks the victim; the landing point homes on them. */
  windup: 0.55,
  /** Pounce flight time (s). */
  leapT: 0.5,
  /** Max speed (m/s) the landing point may slide toward the victim (windup + first 75% of the flight). */
  homingSpeed: 3.2,
  /** Peak height of the leap arc = base + perMetre × distance (capped). */
  leapPeakBase: 1.4,
  leapPeakPerM: 0.09,
  leapPeakMax: 2.7,
  /** Landing point sits this fraction of (lionR + victimR) short of the victim's centre. */
  landOffsetFrac: 0.75,
  /** Extra reach (m, beyond touching bodies) at which the landing still pins the victim. */
  landReach: 0.95,
  /** Strike k starts at firstStrike + k × strikeGap after touchdown; damage lands `impactDelay` later. */
  firstStrike: 0.2,
  strikeGap: 0.3,
  impactDelay: 0.09,
  /** Roar starts this long after touchdown (= last strike start 1.1 s + 0.34 s); its hit lands `roarImpactDelay` later. */
  roarLead: 1.44,
  roarImpactDelay: 0.16,
  /** Roar hold (rear-up) before the settle (s). */
  roarHold: 0.55,
  /** Settle after the roar (s); a full sequence recovers this long. */
  recovery: 0.45,
  /** Victim stays down this long after touchdown (fall + hold + rise over the roar). */
  pinTotal: 2.0,
  /** Roar hit (damage, unblockable) and its stagger. */
  roarDamage: 35,
  roarStagger: 0.7,
  /** Number of maul strikes. */
  strikes: 4,
  /** Beat indices (`ultimateStage`). */
  stage: { lock: 0, leap: 1, pin: 2, strike0: 3, roar: 7 },
} as const;

/** Seconds from cast to touchdown. */
export const LION_T_LAND = LION_HUNT.windup + LION_HUNT.leapT;
/** Seconds from cast to the roar beat. */
export const LION_T_ROAR = LION_T_LAND + LION_HUNT.roarLead;
/** Seconds from cast until a full sequence ends. */
export const LION_T_END = LION_T_ROAR + LION_HUNT.roarHold + LION_HUNT.recovery;

export const LION_ULTIMATE: AbilitySpec = {
  name: 'Royal Hunt',
  description:
    'Lock eyes within 12 m and pounce (65, pinned), then four guard-piercing maul strikes (48 each) while CC-immune, ending in a roar (35, stagger) that marks the victim for +20% damage taken (6 s) and gives you +20% speed (4 s). No target: nothing is spent.',
  cooldown: 0,
  windup: LION_HUNT.windup,
  damage: 65, // pounce
  bonusDamage: 48, // per maul strike
  hits: LION_HUNT.strikes,
  range: 12,
  radius: 1.9,
  duration: LION_T_END - LION_HUNT.windup, // rig/actionDur only
  recovery: 0.9, // whiff recovery (pounce missed)
  ccImmune: true, // from the pounce to the end of the sequence
  effects: [{ kind: 'stagger', mag: 0, dur: LION_HUNT.roarStagger }], // the roar
  bonusEffects: [{ kind: 'dmgTakenUp', mag: 0.2, dur: 6 }], // the mark
  selfBuffs: [{ kind: 'speedUp', mag: 0.2, dur: 4 }],
  targeting: { kind: 'lock', range: 12, coneDeg: 70, requireTarget: true },
};
