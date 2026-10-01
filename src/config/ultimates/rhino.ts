/**
 * Rhino ultimate spec (v1.3 per-animal config file, imported by config/animals.ts).
 * The sim logic lives in src/sim/ultimates/rhino.ts, the bot script in src/ai/ultScripts/rhino.ts, the rig
 * poses in src/render/animals/Rhino.ts (+ ultPose/rhino.ts), VFX/audio in src/render/ultFx/rhino.ts +
 * src/audio/ults/rhino.ts.
 *
 * SEISMIC STAMPEDE (v1.3): the rhino lowers its head and paws the sand (windup, turning to sight the lock),
 * then thunders off on a steerable, CC-immune charge (3 s, 12 m/s) that HOMES on the foe locked at the cast
 * (16 m, 50 deg cone; turn <= 110 deg/s) — without a lock it is steered by the aim as before. It GORES the
 * locked foe on contact (or, with no lock, the first fighter it hits): 120 damage and the victim is hoisted
 * 1.7 m up on the horn and carried along; slamming into a wall / pillar / column CRUSHES the carried foe
 * (+100, stun 1.2 s). Every other fighter in the path is swept for 60 and knocked down. Crates are smashed.
 *
 * Phases: Windup = paw + lowering (spec.windup), Active = the charge (then a short skid when it runs out),
 * Recovery = shake-off. Stage protocol (ultimateStage / snapshot ultStage):
 *   0 paw (cast)  1 charge  2 gore (victim on the horn)  3 crush (slammed into geometry)  4 skid / stop.
 */

import type { AbilitySpec } from '../animals';

/** Timeline + numbers of the ultimate (seconds / metres). Shared by the sim, the rig and the VFX. */
export const RHINO_STAMPEDE = {
  /** Windup: head lowers (rig) while the rhino turns to sight the lock, pawing the sand. */
  pawS: 0.8,
  lowerS: 0.35,
  /** Sighting turn rate during the windup (deg/s). */
  sightTurnDeg: 150,
  /** Charge. */
  speed: 12,
  rampS: 0.5,
  rampFloor: 0.35,
  chargeS: 3,
  /** Homing lock (same maths as selectLockTarget) and steering. */
  lockRange: 16,
  lockConeDeg: 50,
  homingTurnDeg: 110,
  freeTurnDeg: 90,
  /** Homing is dropped when the lock is farther than this (m). */
  leashM: 28,
  /** Gore: damage, how high the victim is hoisted on the horn (m) and how long the hoist takes (s). */
  goreDamage: 120,
  hoistAlt: 1.7,
  hoistS: 0.3,
  /** Distance of the hoisted victim's centre ahead of the rhino's body edge (m). */
  carryGap: 0.45,
  /** Crush against geometry while carrying: extra damage (unblockable) + stun (s). */
  crushDamage: 100,
  crushStunS: 1.2,
  /** Fighters swept in the path (not the gored one): damage + knockdown (s), once each. */
  sweepDamage: 60,
  sweepKnockdownS: 0.8,
  /** Timed-out charge: the carried victim is flung off the horn and knocked down for this long (s). */
  throwKnockdownS: 0.6,
  /** Skid to a halt after a charge that ran out (s), then the shake-off. */
  skidS: 0.45,
  recoveryS: 0.7,
} as const;

export const RHINO_ULTIMATE: AbilitySpec = {
  name: 'Seismic Stampede',
  description:
    'Lock a foe within 16 m and stampede for 3 s, CC-immune and homing on it (steer it yourself with no lock). Gores the first foe it reaches (120) and carries them on its horn; a wall or pillar crush adds 100 and a 1.2 s stun. Others in the path take 60 and fall.',
  cooldown: 0,
  windup: RHINO_STAMPEDE.pawS,
  duration: RHINO_STAMPEDE.chargeS,
  damage: RHINO_STAMPEDE.goreDamage,
  bonusDamage: RHINO_STAMPEDE.crushDamage,
  bonusEffects: [{ kind: 'stun', mag: 0, dur: RHINO_STAMPEDE.crushStunS }],
  splashDamage: RHINO_STAMPEDE.sweepDamage,
  moveSpeed: RHINO_STAMPEDE.speed,
  // Total reach of a full charge (12 m/s x 3 s); the lock reaches `targeting.range`.
  range: 36,
  turnRateDeg: RHINO_STAMPEDE.homingTurnDeg,
  recovery: RHINO_STAMPEDE.recoveryS,
  ccImmune: true,
  breaksCrates: true,
  effects: [{ kind: 'knockdown', mag: 0, dur: RHINO_STAMPEDE.sweepKnockdownS }],
  targeting: { kind: 'line', range: RHINO_STAMPEDE.lockRange, coneDeg: RHINO_STAMPEDE.lockConeDeg, width: 2.4 },
};
