/**
 * Giraffe ultimate spec (v1.3 per-animal config file, imported by config/animals.ts).
 * The sim logic lives in src/sim/ultimates/giraffe.ts, the bot script in src/ai/ultScripts/giraffe.ts,
 * the rig poses in src/render/animals/Giraffe.ts (+ ultPose/giraffe.ts), VFX/audio in
 * src/render/ultFx/giraffe.ts + src/audio/ults/giraffe.ts.
 *
 * TIMBER FALL (v1.3, was Guillotine Spin): lock a foe within 7.5 m; the giraffe rears its neck far back
 * while creeping in, a ground circle under the victim TRACKS them (lagging) and then COMMITS (fixed circle:
 * walk out of it to dodge); the neck then comes down like a felled tree. Everyone touching the committed
 * circle takes 230 and is stunned for 1 s; everyone else in the shock ring takes 50 and staggers. A whiff
 * leaves the giraffe a long 0.9 s recovery, head down at the crater.
 *
 * Stage protocol (ultimateStage / snapshot ultStage; `dodge.mode: 'commit'` bots read these beats):
 *   0 = circle tracking (from the cast; pos = the lagging centre, every 0.1 s)   1 = COMMITTED (pos = the fixed centre;
 *   also the whole slam swing)   2 = IMPACT (also the whole recovery).
 *
 * Interruption: interruptible while the circle is still tracking (a stun / stagger cancels it, charge is
 * spent); CC-immune from the commit on (`ccImmuneChannel`), so the committed 0.5 s is a pure dodge test.
 */

import type { AbilitySpec } from '../animals';

/** Timeline + geometry of the ultimate (seconds / metres). Shared by the sim, the rig, the VFX and the audio. */
export const GIRAFFE_TIMBER = {
  /** Windup: the tracking half + the committed half. The slam is the active phase after it. */
  windupS: 1.1,
  /** The circle follows the victim (lagging) for this long, then commits. */
  trackS: 0.6,
  /** Committed warning before the neck comes down (= windupS - trackS). */
  commitS: 0.5,
  /** The neck's downswing (active phase); the hit lands at its end. */
  slamS: 0.14,
  /** Whiff recovery (s); a hit recovers faster. */
  recoveryS: 0.9,
  hitRecoveryS: 0.65,
  /** Reticle lag: time constant (s) of the exponential follow of the victim. */
  trackLagS: 0.2,
  /** `ultimateStage` 0 cadence while tracking (s). */
  trackEmitS: 0.1,
  /** Direct-hit circle radius (m; bodies overlapping it are hit) = the drawn reticle. */
  directRadius: 1.6,
  /** Shock ring radius (m) around the impact for everyone else. */
  shockRadius: 2.2,
  /** How far from the impact the head lands (m): the giraffe creeps in until it is this close. */
  reach: 3.1,
  /** Creeping speed while rearing (m/s) and its ease-in (s). */
  approachSpeed: 4.4,
  approachRampS: 0.3,
  /** Yaw turn rate while rearing (rad/s). */
  turnRate: 6,
  /** Damage: direct / shock ring; stun on the direct victim (s). */
  damage: 230,
  shockDamage: 50,
  stunS: 1.0,
} as const;

export const GIRAFFE_ULTIMATE: AbilitySpec = {
  name: 'Timber Fall',
  description:
    'Lock a foe within 7.5 m: the Giraffe rears its neck back while a circle tracks them, then commits (leave it to dodge). The neck-hammer slam deals 230 and a 1 s stun; others within 2.2 m take 50 and stagger. 0.9 s recovery on a whiff.',
  cooldown: 0,
  windup: GIRAFFE_TIMBER.windupS,
  damage: GIRAFFE_TIMBER.damage,
  radius: GIRAFFE_TIMBER.directRadius,
  splashDamage: GIRAFFE_TIMBER.shockDamage,
  splashRadius: GIRAFFE_TIMBER.shockRadius,
  recovery: GIRAFFE_TIMBER.recoveryS,
  range: 7.5,
  effects: [{ kind: 'stun', mag: 0, dur: GIRAFFE_TIMBER.stunS }],
  targeting: {
    kind: 'lock',
    range: 7.5,
    coneDeg: 70,
    requireTarget: true,
    // Bots sidestep the COMMITTED circle only. commitS covers the 0.5 s warning + the slam swing.
    dodge: { mode: 'commit', activeS: 1.2, commitS: 0.8, radius: GIRAFFE_TIMBER.directRadius },
  },
};
