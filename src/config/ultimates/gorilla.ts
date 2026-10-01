/**
 * Gorilla ultimate spec (v1.3 per-animal config file, imported by config/animals.ts).
 * The sim logic lives in src/sim/ultimates/gorilla.ts, the bot script in src/ai/ultScripts/gorilla.ts,
 * the rig poses in src/render/animals/Gorilla.ts (+ ultPose/gorilla.ts), VFX/audio in
 * src/render/ultFx/gorilla.ts + src/audio/ults/gorilla.ts.
 *
 * BOULDER HURL (v1.3): the gorilla drums its chest twice, rips a slab out of the ground, hoists it
 * overhead and HURLS it — a real arcing projectile (`spawnProjectile`, kind 'boulder'). The first fighter
 * it touches takes 200 (blockable) and is staggered; everyone within 2.5 m of the landing takes 60 splash;
 * it smashes crates. It flies at 18 m/s horizontally, so anything that moves out of its way (or is airborne
 * above it) is missed; a victim standing still, blocking or crowded gets hit.
 *
 * Aim: a `line` ultimate with a lock-assist cone (40°, no `requireTarget`: it can always be thrown along
 * the aim line). While the gorilla heaves, the dashed arc follows the locked foe; at RELEASE the landing point
 * freezes (a little predictive lead on a runner) and the boulder commits to it.
 *
 * Stage protocol (ultimateStage / snapshot ultStage; `dodge.mode: 'commit'` bots read these beats):
 *   0 = heaving / tracking (pos = the predicted landing point, every 0.1 s)   1 = RELEASED (pos = committed landing point)
 *   2 = the boulder landed (emitted from the projectile's impact, possibly after the gorilla's recovery ended).
 *
 * Interruption: the chest-beat + rip + hoist windup is uninterruptible (`ccImmuneChannel`, the old Primal
 * Rampage "the ape does not flinch" spirit); it drops at the release so the 0.6 s recovery can be punished.
 */

import type { AbilitySpec } from '../animals';

/** Timeline + geometry of the ultimate (seconds / metres). Shared by the sim, the rig, the VFX and the audio. */
export const GORILLA_HURL = {
  /** Windup: two chest beats, the rip, the hoist (the release happens at its end). */
  windupS: 1.0,
  /** Seconds after the cast at which the two fists land on the chest. */
  beatAt: [0.13, 0.31] as readonly number[],
  /** Seconds after the cast at which the slab tears free of the ground. */
  ripAt: 0.6,
  /** Recovery after the throw (s). */
  recoveryS: 0.6,
  /** Horizontal boulder speed (m/s) on a long throw. */
  speed: 18,
  /** Shortest flight time (s): a close throw is a slower, higher lob so there is always time to step out of it. */
  minFlightS: 0.75,
  /** Downward acceleration of the boulder (m/s²): a readable lob, not a laser. */
  gravity: 9,
  /** Collision / visual radius of the boulder (m). */
  boulderRadius: 0.65,
  /** Splash radius (m), also reported in the impact event. */
  impactRadius: 2.5,
  /** Where the boulder leaves the hands: metres ahead of the gorilla and height above its feet. */
  releaseForward: 1.0,
  releaseHeight: 2.3,
  /** Height above the ground the lob aims at (chest of a standing fighter, m). */
  aimHeight: 1.0,
  /** Shortest / longest horizontal throw the solver flies (m). */
  minThrow: 3,
  maxThrow: 18,
  /** Fraction of the victim's velocity × flight time the throw leads by (runners get clipped, strafers do not). */
  lead: 0.8,
  /** Yaw turn rate while heaving (rad/s): the gorilla keeps facing the foe / the aim. */
  turnRate: 7,
  /** Lock is kept while the foe stays within this many metres beyond the targeting range. */
  lockSlack: 3,
  /** `ultimateStage` 0 cadence while tracking (s). */
  trackEmitS: 0.1,
  /** Damage on the first fighter touched / splash on everyone else in `impactRadius`. */
  damage: 200,
  splashDamage: 60,
  /** Stagger on the direct victim when unblocked (s). */
  staggerS: 0.8,
} as const;

export const GORILLA_ULTIMATE: AbilitySpec = {
  name: 'Boulder Hurl',
  description:
    'Drums its chest, rips a slab from the ground and hurls it (18 m, arcing): the first fighter it touches takes 200 and is staggered, 60 splash within 2.5 m, smashes crates. Dodge by moving or jumping clear; uninterruptible while it heaves.',
  cooldown: 0,
  windup: GORILLA_HURL.windupS,
  damage: GORILLA_HURL.damage,
  splashDamage: GORILLA_HURL.splashDamage,
  splashRadius: GORILLA_HURL.impactRadius,
  radius: GORILLA_HURL.boulderRadius,
  range: GORILLA_HURL.maxThrow,
  moveSpeed: GORILLA_HURL.speed,
  recovery: GORILLA_HURL.recoveryS,
  breaksCrates: true,
  ccImmune: true,
  effects: [{ kind: 'stagger', mag: 0, dur: GORILLA_HURL.staggerS }],
  targeting: {
    kind: 'line',
    range: GORILLA_HURL.maxThrow,
    coneDeg: 40,
    width: 1.6,
    // Lock-assisted but never required: it can always be thrown down the aim line.
    // Bots only sidestep the COMMITTED landing point (after the release), not the heave.
    dodge: { mode: 'commit', activeS: 1.0, commitS: 1.4 },
  },
};
