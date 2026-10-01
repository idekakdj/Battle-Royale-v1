/**
 * Crocodile ultimate spec (v1.3 per-animal config file, imported by config/animals.ts).
 * The sim logic lives in src/sim/ultimates/crocodile.ts, the bot script in src/ai/ultScripts/crocodile.ts,
 * the rig poses in src/render/animals/Crocodile.ts (+ ultPose/crocodile.ts), the VFX in
 * src/render/ultFx/crocodile.ts and the audio in src/audio/ults/crocodile.ts.
 *
 * DEATH ROLL (v1.3 rework, lock-on): a low, explosive burst lunge at the locked foe,
 * then clamp -> drag -> THREE full death-roll revolutions -> toss.
 * Total 300 = bite (`CROC.biteDamage`) + roll drain (unblockable DoT over `duration`) +
 * toss (`CROC.tossDamage`). The victim is held + stunned from the clamp until the toss;
 * the Crocodile takes `damageReduction` less damage from the clamp until the toss.
 */

import type { AbilitySpec } from '../animals';

/** `ultimateStage` beat indices the sim emits and the rig / VFX / audio key off. */
export const CROC_STAGE = {
  /** Windup: crouch + hiss, the lunge line TRACKS the victim (implicit: stage 0 while winding up). */
  CROUCH: 0,
  /** Windup, ~65%: line committed (direction frozen). `pos` = lunge end point. */
  COMMIT: 1,
  /** Active: the burst lunge leaves the ground. */
  LUNGE: 2,
  /** Contact: jaws shut on the victim (`pos` = victim). */
  CLAMP: 3,
  /** The croc backs away hauling the victim. */
  DRAG: 4,
  /** Death-roll revolutions 1..3 (one beat each). */
  ROLL1: 5,
  ROLL2: 6,
  ROLL3: 7,
  /** Release: the victim is thrown (`pos` = victim). */
  TOSS: 8,
  /** Lunge found nothing: slide + recovery (whiff). */
  WHIFF: 9,
} as const;

/** Numbers that are not part of the generic AbilitySpec. */
export const CROC = {
  /** Fraction of the windup after which the lunge direction is frozen (before that the croc tracks the victim). */
  commitFrac: 0.65,
  /** Windup tracking turn rate (rad/s). */
  turnRate: 5.2,
  /** Extra lunge distance beyond `range` (m) so a target at the edge of the cone can still be clamped. */
  overshoot: 1,
  /** Extra body reach on top of the contact pad while lunging (m): a burst of jaws and shoulders, wider than the body. */
  lungeReach: 0.35,
  /** Victim closer than this altitude is caught; a foe hopping above it is jumped over (m). */
  hopClearance: 0.85,
  /** Clamp bite (unblockable, heavy). */
  biteDamage: 30,
  /** Toss impact (unblockable). */
  tossDamage: 30,
  /** Jaws-shut hold before the drag starts (s). */
  clampT: 0.28,
  /** Drag: duration (s) and how far the croc backs up (m). */
  dragT: 0.42,
  dragDist: 1.5,
  /** Whiff slide: duration (s), starting speed (m/s). */
  slideT: 0.45,
  slideSpeed: 9,
  /** Recovery after a toss (s). */
  tossRecovery: 0.5,
  /** Stagger given to the tossed victim (s). */
  tossStagger: 0.5,
  /** Victim orbit radius around the croc's long axis while rolling (m) and lift above the ground (m). */
  orbitR: 0.55,
  orbitLift: 0.5,
} as const;

/**
 * Cumulative roll angle (radians) at normalised roll progress `u` (0..1) for `hits` full
 * revolutions: eased at both ends, near-linear in the middle. Shared by the sim (victim orbit)
 * and the rig (body roll) so the two agree exactly; `crocRollAngle(1, n) === n * 2π`.
 */
export function crocRollAngle(u: number, hits = 3): number {
  const x = u < 0 ? 0 : u > 1 ? 1 : u;
  const g = 0.4 * x + 0.6 * (x * x * (3 - 2 * x));
  return g * hits * Math.PI * 2;
}

export const CROCODILE_ULTIMATE: AbilitySpec = {
  name: 'Death Roll',
  description:
    'Lock on within 7 m: burst-lunge, clamp, drag and thrash the victim through 3 death rolls for 300 unblockable damage (held, stunned; you take 50% less), then toss them 3 m. Miss the lunge line and you slide for 1 s.',
  cooldown: 0,
  windup: 0.55,
  range: 7,
  damage: 300,
  duration: 2.5,
  hits: 3,
  knockback: 3,
  moveSpeed: 30,
  grab: true,
  damageReduction: 0.5,
  recovery: 1,
  effects: [{ kind: 'stun', mag: 0, dur: 3.2 }],
  targeting: {
    kind: 'lock',
    range: 7,
    coneDeg: 60,
    requireTarget: true,
    // Bots at Veteran/Apex leave the victim's cast position while the lunge line is still tracking.
    dodge: { mode: 'fixed', activeS: 0.4, radius: 1.6 },
  },
};
