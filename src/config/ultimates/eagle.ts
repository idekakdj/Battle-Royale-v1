/**
 * Eagle ultimate spec (v1.3 per-animal config file, imported by config/animals.ts).
 * The sim logic lives in src/sim/ultimates/eagle.ts, the bot script in src/ai/ultScripts/eagle.ts,
 * the rig poses in src/render/animals/Eagle.ts, VFX/audio in src/render/ultFx/eagle.ts + src/audio/ults/eagle.ts.
 *
 * DEATH FROM ABOVE (v1.3, "stoop"): the eagle rockets up out of sight (untargetable), a red RETICLE
 * appears under the locked victim and TRACKS them (lagging), then COMMITS (fixed circle, solid
 * warning: leave it to dodge), then the eagle stoops onto the committed point. Whiff = long recovery.
 *
 * Stage protocol (ultimateStage / snapshot ultStage): 0 = reticle tracking (from cast, through the
 * ascent and the high hold), 1 = committed (the stoop is the second half of stage 1), 2 = impact
 * (also the whole recovery). `dodge.mode: 'commit'` bots read exactly these beats.
 */

import type { AbilitySpec } from '../animals';

/** Timeline + geometry of the ultimate (seconds / metres). Shared by the sim, the rig and the VFX. */
export const EAGLE_DFA = {
  /** Powered spiral climb out of sight (the ability's windup / untargetable ascent). */
  ascentS: 0.8,
  /** High circling hold while the reticle tracks the victim (after the ascent). */
  trackS: 1.2,
  /** Solid committed warning before the stoop begins. */
  commitS: 0.5,
  /** Altitude of the hold (m). */
  holdAlt: 20,
  /** Circling radius around the reticle during the hold (m) and angular rate (rad/s). */
  orbitRadius: 6.5,
  orbitRate: 1.15,
  /** Corkscrew of the ascent: helix radius (m) and number of turns. */
  helixRadius: 1.25,
  helixTurns: 1.5,
  /** Reticle lag: time constant (s) of the exponential follow of the victim. */
  trackLagS: 0.24,
  /** ultimateStage-0 cadence while the reticle moves (s). */
  trackEmitS: 0.1,
  /** Stoop speed (m/s) and its short launch ramp (s). */
  diveSpeed: 25,
  diveRampS: 0.12,
  /** Direct-hit circle radius (m, padded by the victim's body like every AoE) = the drawn reticle. */
  directRadius: 1.4,
} as const;

export const EAGLE_ULTIMATE: AbilitySpec = {
  name: 'Death From Above',
  description:
    'Lock a foe within 16 m: the Eagle spirals out of sight, a red reticle tracks them for 1.2 s, then commits for 0.5 s (leave the circle to dodge). The stoop lands for 240 damage (1.4 m circle) and 60 splash (3 m). 1 s recovery on a whiff.',
  cooldown: 0,
  windup: 0,
  untargetableT: EAGLE_DFA.ascentS,
  damage: 240,
  radius: EAGLE_DFA.directRadius,
  splashDamage: 60,
  splashRadius: 3,
  recovery: 1,
  targeting: {
    kind: 'lock',
    range: 16,
    coneDeg: 90,
    requireTarget: true,
    // Bots sidestep the COMMITTED circle only (tracking is not dodged). commitS covers the 0.5 s warning + the stoop.
    dodge: { mode: 'commit', activeS: 2.6, commitS: 1.7, radius: EAGLE_DFA.directRadius },
  },
};
