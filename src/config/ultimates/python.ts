/**
 * Python ultimate spec (v1.3 per-animal config file, imported by config/animals.ts).
 * The sim logic lives in src/sim/ultimates/python.ts, the bot script in src/ai/ultScripts/python.ts,
 * the rig poses in src/render/animals/Python.ts (+ ultPose/python.ts), the VFX in
 * src/render/ultFx/python.ts and the audio in src/audio/ults/python.ts.
 *
 * COIL SNARE (v1.3 rework, lock-on): rear and hiss; a coil TETHER lashes out along the aim
 * (fast projectile line, dodgeable sideways or by jumping it), snares the first foe on the line,
 * YANKS them all the way to the python, then binds and squeezes (held + stunned, python takes
 * `damageReduction` less) and finishes with a crush.
 * Total 260 = snare 20 + squeeze drain (unblockable DoT over `duration`) + crush 40.
 */

import type { AbilitySpec } from '../animals';

/** `ultimateStage` beat indices the sim emits and the rig / VFX / audio key off. */
export const PYTHON_STAGE = {
  /** Windup: rear up + hiss; the tether aim TRACKS the victim (implicit: stage 0). */
  REAR: 0,
  /** Windup, ~65%: aim frozen. `pos` = tether end point. */
  COMMIT: 1,
  /** Active: the tether is launched. */
  LASH: 2,
  /** The tether landed: snap flash and the yank begins (`pos` = victim). */
  SNARE: 3,
  /** Squeeze pulses / wrap tightening 1..4 (one beat each; `pos` = victim). */
  WRAP1: 4,
  WRAP2: 5,
  WRAP3: 6,
  WRAP4: 7,
  /** Final crush and release (`pos` = victim). */
  CRUSH: 8,
  /** The tether found nothing: it snaps back, the python recovers. */
  WHIFF: 9,
} as const;

/** Numbers that are not part of the generic AbilitySpec. */
export const PYTHON = {
  /** Fraction of the windup after which the tether aim is frozen. */
  commitFrac: 0.65,
  /** Windup tracking turn rate (rad/s). */
  turnRate: 4.4,
  /** Extra tether length beyond `range` (m). */
  overshoot: 1.2,
  /** Tether flight speed (m/s) — ~0.3 s across 9 m. */
  tetherSpeed: 32,
  /** Tether half-width for contact (m) and chest height (m). */
  tetherRadius: 0.4,
  /** A foe higher than this above the ground is jumped over (m). */
  hopClearance: 0.7,
  /** Snare impact (unblockable, heavy). */
  snareDamage: 20,
  /** Yank duration bounds (s) and speed used to size it (m/s). */
  yankMinT: 0.26,
  yankMaxT: 0.5,
  yankSpeed: 18,
  /** Gap kept between the bodies when the yank ends (m). */
  bindGap: 0.15,
  /** Squeeze pulses (wrap stages) and the crush. */
  pulses: 4,
  crushDamage: 40,
  /** Stagger the released victim keeps (s). */
  crushStagger: 0.45,
  /** Whiff: seconds the tether takes to retract before recovery starts. */
  retractT: 0.28,
  /** Recovery after the crush (s). */
  crushRecovery: 0.45,
} as const;

export const PYTHON_ULTIMATE: AbilitySpec = {
  name: 'Coil Snare',
  description:
    'Lock on within 9 m and lash a coil tether (slip sideways or jump to escape). It snares the first foe, yanks them in, then constricts for 260 unblockable damage while they are held and stunned (you take 30% less), ending with a crush.',
  cooldown: 0,
  windup: 0.6,
  range: 9,
  damage: 260,
  duration: 2.6,
  hits: 4,
  moveSpeed: 32,
  grab: true,
  damageReduction: 0.3,
  recovery: 0.85,
  effects: [{ kind: 'stun', mag: 0, dur: 3.2 }],
  targeting: {
    kind: 'lock',
    range: 9,
    coneDeg: 60,
    requireTarget: true,
    // The tether line dodge: bots at Veteran/Apex leave the victim's cast position during the windup.
    dodge: { mode: 'fixed', activeS: 0.35, radius: 1.6 },
  },
};
