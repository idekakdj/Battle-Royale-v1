/**
 * Hippo ultimate spec (v1.3 per-animal config file, imported by config/animals.ts).
 * The sim logic lives in src/sim/ultimates/hippo.ts (+ the persistent mud in src/sim/groundZones.ts), the bot
 * script in src/ai/ultScripts/hippo.ts, the rig poses in src/render/animals/Hippo.ts, VFX/audio in
 * src/render/ultFx/hippo.ts + src/audio/ults/hippo.ts.
 *
 * RIVERLORD'S FLOOD (v1.3): the hippo rears and GAPES, bellowing while the rectangle of the coming flood is
 * marked on the sand (11 m x 3.4 m along the aim). Both forefeet slam down and a WAVE surges along the path at
 * 14 m/s: everybody it passes is hit once (130, blockable, shoved 5 m along the line, staggered). The water
 * soaks away into a MUD POOL covering the whole path for ~5.5 s that slows every grounded fighter 40%
 * (the hippo itself wades through it unslowed: it is the river's lord).
 *
 * Phases: Windup = gape + bellow (spec.windup), Active = the slam and the surging wave, Recovery = heavy exhale.
 * Stage protocol (ultimateStage / snapshot ultStage): 0 = gape (cast), 1 = slam + surge, 2 = exhale (recovery).
 */

import type { AbilitySpec } from '../animals';

/** Timeline + geometry of the ultimate (seconds / metres). Shared by the sim, the rig and the VFX. */
export const HIPPO_FLOOD = {
  /** Gape-and-bellow windup (s): rear-up then the mouth cranks open. */
  windupS: 0.9,
  /** Part of the windup spent rearing up before the maw opens (rig only). */
  rearS: 0.4,
  /** Path geometry. */
  length: 11,
  width: 3.4,
  /** Shortest path the wave is allowed to have when the hippo faces a wall point blank (m). */
  minLength: 1.5,
  /** Wave speed along the path (m/s). */
  waveSpeed: 14,
  /** Damage per victim (once), shove along the path (m). The hit also staggers (shared ultimate reaction). */
  damage: 130,
  knockback: 5,
  /** Mud pool: lifetime from the slam (s; it is laid as the wave passes), slow fraction, grounded altitude. */
  mudS: 5.5,
  mudSlow: 0.4,
  /** The hippo's own slow fraction inside its mud (0 = wades through unaffected). */
  mudSlowOwner: 0,
  groundedAlt: 0.6,
  /** A slow buff lingers this long after leaving / expiring (s): the mud clings to the legs. */
  slowLingerS: 0.3,
  /** The last seconds of the pool (renderer fades the decals over this window). */
  mudFadeS: 1.0,
  /** Heavy exhale after the surge (s). */
  recoveryS: 0.7,
} as const;

/** Seconds the wave takes to sweep a path of `len` metres. */
export function floodSurgeS(len: number): number {
  return len / HIPPO_FLOOD.waveSpeed;
}

export const HIPPO_ULTIMATE: AbilitySpec = {
  name: "Riverlord's Flood",
  description:
    'Rear up and bellow for 0.9 s while an 11 m x 3.4 m path is marked, then slam: a flood surges along it at 14 m/s, hitting everyone once for 130 (blockable), shoving them 5 m and staggering, and leaves a mud pool for 5.5 s that slows grounded foes 40% (the Hippo is unaffected).',
  cooldown: 0,
  windup: HIPPO_FLOOD.windupS,
  damage: HIPPO_FLOOD.damage,
  range: HIPPO_FLOOD.length,
  knockback: HIPPO_FLOOD.knockback,
  duration: floodSurgeS(HIPPO_FLOOD.length),
  recovery: HIPPO_FLOOD.recoveryS,
  targeting: {
    kind: 'line',
    range: HIPPO_FLOOD.length,
    width: HIPPO_FLOOD.width,
    // Bots sidestep the marked path during the windup and keep out of the mud while it lasts.
    dodge: { mode: 'fixed', activeS: floodSurgeS(HIPPO_FLOOD.length) + HIPPO_FLOOD.mudS },
  },
};
