/**
 * Mole ultimate spec (v1.3 per-animal config file, imported by config/animals.ts).
 * The sim logic lives in src/sim/ultimates/mole.ts, the bot script in src/ai/ultScripts/mole.ts,
 * the rig poses in src/render/animals/Mole.ts, VFX/audio in src/render/ultFx/mole.ts + src/audio/ults/mole.ts.
 *
 * SINKHOLE VORTEX (v1.3): the mole digs in place (dirt spray), a TREMOR CRACK races along the ground
 * to the aimed zone while the mole tunnels beneath it (untargetable), surfaces at the pit's edge as the
 * ground collapses into a VORTEX PIT: for ~2 s it drags grounded fighters toward the centre and ticks
 * damage, then a collapse finale hits everyone inside and roots them. The mole's +25% vs rooted stays.
 *
 * Phases: Windup = dig + tunnelling crack (spec.windup), Active = the vortex, Recovery = slam + shake-off.
 * Stage protocol (ultimateStage / snapshot ultStage): 0 = dig/tunnel, 1 = vortex open (mole surfaced),
 * 2 = collapse (also the whole recovery).
 */

import type { AbilitySpec } from '../animals';

/** Timeline + geometry of the ultimate (seconds / metres). Shared by the sim, the rig and the VFX. */
export const MOLE_VORTEX = {
  /** Dig-in in place before the tunnel starts (the mole is untargetable from `hideAtS`). */
  digS: 0.4,
  hideAtS: 0.3,
  /** Crack race / underground travel from the mole to the pit. */
  crackS: 0.9,
  /** Vortex duration (s) and pull speed toward the centre (m/s, grounded fighters only). */
  vortexS: 2.0,
  pullSpeed: 5,
  /** Damage over time inside the pit: per second, applied in ticks of `tickS`. */
  tickDps: 30,
  tickS: 0.25,
  /** Collapse finale. */
  collapseDamage: 100,
  rootS: 2,
  /** Where the mole surfaces: this far outside the pit rim toward where it came from (m). */
  surfaceGap: 0.9,
  /** Shake-off recovery after the collapse slam (s). */
  recoveryS: 0.7,
  /** Victims count as "grounded" (pullable) at or below this altitude (m). */
  groundedAlt: 0.6,
} as const;

export const MOLE_ULTIMATE: AbilitySpec = {
  name: 'Sinkhole Vortex',
  description:
    'Burrow and send a tremor crack up to 10 m. The ground collapses into a 4.5 m vortex pit: for 2 s it drags grounded foes toward the centre (flyers are safe) and grinds them for 30 damage/s, then collapses for 100 damage and a 2 s root. The Mole deals +25% to rooted targets.',
  cooldown: 0,
  // Windup = dig-in + tremor crack (the caster is untargetable underground).
  windup: MOLE_VORTEX.digS + MOLE_VORTEX.crackS,
  damage: MOLE_VORTEX.collapseDamage,
  radius: 4.5,
  range: 10,
  duration: MOLE_VORTEX.vortexS,
  recovery: MOLE_VORTEX.recoveryS,
  bonusVsRooted: 0.25,
  effects: [{ kind: 'root', mag: 0, dur: MOLE_VORTEX.rootS }],
  targeting: {
    kind: 'ground',
    range: 10,
    radius: 4.5,
    // Bots leave the marked ground while the crack races in; the zone outlives the vortex + collapse.
    dodge: { mode: 'fixed', activeS: 2.2 },
  },
};
