/**
 * The roster — 10 animal gladiators (BLUEPRINT §8). This is the binding data
 * table: every stat, combo number, ability magnitude, block value, and status
 * effect from §8 lives here as typed, sim-readable data (kind tags + magnitudes)
 * so no system hard-codes balance numbers (BLUEPRINT §2, §15).
 *
 * WP-B reads combat/ability numbers; WP-F reads presentation (pips, lore, prose).
 */

import type { AnimalId, UltTargetKind } from '../core/types';
import { LION_ULTIMATE } from './ultimates/lion';
import { GORILLA_ULTIMATE } from './ultimates/gorilla';
import { CROCODILE_ULTIMATE } from './ultimates/crocodile';
import { HIPPO_ULTIMATE } from './ultimates/hippo';
import { RHINO_ULTIMATE } from './ultimates/rhino';
import { EAGLE_ULTIMATE } from './ultimates/eagle';
import { PANTHER_ULTIMATE } from './ultimates/panther';
import { PYTHON_ULTIMATE } from './ultimates/python';
import { GIRAFFE_ULTIMATE } from './ultimates/giraffe';
import { MOLE_ULTIMATE } from './ultimates/mole';

/** The kinds of status/positional effect an ability or finisher can apply. */
export type EffectKind =
  | 'slow' // move ×(1 − mag)
  | 'bleed' // total `mag` damage over `dur` (unblockable)
  | 'fear' // forced flee, no actions
  | 'root' // cannot move, can act
  | 'blind' // aim penalty (bots) / dirt overlay (player)
  | 'stun' // no actions
  | 'stagger' // interrupt + no actions (short)
  | 'knockback' // pushed `mag` metres from source
  | 'knockup' // launched up then down for `dur`
  | 'knockdown' // knocked down for `dur`
  | 'disarm' // cannot attack for `dur`
  | 'dmgTakenUp' // takes ×(1 + mag) damage
  | 'speedUp' // move ×(1 + mag)
  | 'atkSpeedUp' // attack rate ×(1 + mag)
  | 'dmgUp' // deals ×(1 + mag) damage
  | 'stealth'; // 85% transparent; bots lose target lock

/**
 * A single applied effect. `mag` units depend on `kind`:
 *  - slow/dmgTakenUp/speedUp/atkSpeedUp/dmgUp → fraction (e.g. 0.15 = 15%)
 *  - bleed → total damage dealt over `dur`
 *  - knockback → metres
 *  - fear/root/blind/stun/stagger/knockup/knockdown/disarm/stealth → mag unused (0)
 * `dur` is seconds (0 for instant/positional-only effects).
 */
export interface EffectSpec {
  kind: EffectKind;
  mag: number;
  dur: number;
}

/** Finisher (3rd combo hit) metadata; only some animals add an effect (§8). */
export interface FinisherSpec {
  /** Named only where §8 names it (lion, gorilla, croc, rhino, eagle, giraffe, mole). */
  name?: string;
  description?: string;
  /** AoE radius (m) for area finishers (gorilla 2.5). */
  radius?: number;
  /** Cone length (m) for cone finishers (mole Dirt Slinger 3). */
  coneRange?: number;
  /** Cone full angle (deg) if specified. */
  coneArcDeg?: number;
  /** Effects applied on the finisher hit. */
  effects?: readonly EffectSpec[];
  /** Eagle Beak Pierce: fraction of the target's block reduction ignored. */
  blockIgnore?: number;
  /** Rhino Horn Fling: launch distance (m). */
  launch?: number;
}

/**
 * v1.3 AI hook: how bots see this ultimate's targeted area as a danger zone (see
 * docs/ultimates/ai-hooks.md and src/ai/dangerZones.ts). Without it bots ignore the
 * ultimate's `ultimateTarget` event (today's behaviour).
 *  - `mode: 'fixed'`  the zone is fixed from the `ultimateTarget` event for `windup + activeS` s.
 *  - `mode: 'commit'` a tracking reticle: the zone follows `ultimateStage` beats — stage 0 =
 *                       still tracking (not dodged yet), stage 1 = committed at `pos` (dodge now,
 *                       lasts `commitS`), stage >= 2 = over.
 */
export interface UltDodge {
  mode: 'fixed' | 'commit';
  /** Seconds the hazard stays after the windup ends (fixed) — default 0.3. */
  activeS?: number;
  /** Seconds a committed reticle stays dangerous after its commit beat — default 0.6. */
  commitS?: number;
  /** Lock kinds: zone radius around the victim (m) — default 1.6. */
  radius?: number;
}

/**
 * v1.3 declarative ultimate targeting (resolved by `sim/ultimates/targeting.ts`
 * at cast time from `aimYaw`; previewed by the HUD via `previewUltTarget`).
 *  - `kind`         lock | line | ground | self (see {@link UltTargetKind})
 *  - `range`        lock: max reach to the victim's body; line: path length;
 *                   ground: max distance of the zone centre; self: informational reach
 *  - `coneDeg`      full angle of the aim cone for lock candidates (default 70);
 *                   on line/ground it turns on lock-assist (snap to a foe inside the cone)
 *  - `width`        line: full path width (m)
 *  - `radius`       ground: zone radius; self: AoE radius (m)
 *  - `requireTarget` cast fizzles (no charge spent) when no valid target exists
 *  - `hitsAir`      also targets fighters above the ground-reach altitude (soaring eagle)
 */
export interface UltTargeting {
  kind: UltTargetKind;
  range: number;
  coneDeg?: number;
  width?: number;
  radius?: number;
  requireTarget?: boolean;
  hitsAir?: boolean;
  /** AI: treat the targeted area as a danger zone bots dodge (see {@link UltDodge}). */
  dodge?: UltDodge;
}

/**
 * A special or ultimate ability. Many fields are optional — each ability sets
 * only the numbers §8 gives it. `cooldown` is 0 for ultimates (charge-gated).
 */
export interface AbilitySpec {
  name: string;
  description: string;
  /** Cooldown (s); starts when the ability ends (specials). Ultimates: 0. */
  cooldown: number;
  /** Telegraph windup (s); 0 = instant / handled by an untargetable phase. */
  windup: number;
  /** Primary direct/impact damage. */
  damage?: number;
  /** Conditional secondary damage (rhino slam +60; used with bonusEffects). */
  bonusDamage?: number;
  /** Splash damage in a secondary radius (eagle DFA 60). */
  splashDamage?: number;
  /** Impact / AoE radius (m). */
  radius?: number;
  /** Secondary splash radius (m). */
  splashRadius?: number;
  /** Reach / leap-to / dash / lunge distance or cone length (m). */
  range?: number;
  /** Cone full angle (deg); 360 for full sweeps. */
  arcDeg?: number;
  /** Charge / dash / burrow speed (m/s). */
  moveSpeed?: number;
  /** Max channel/charge time (s): hippo 1.2, burrow 3. */
  maxTime?: number;
  /** Active-effect duration (s): rampage 6, stampede 3, grab/roll 2.5, wrap 3. */
  duration?: number;
  /** Steer rate for steerable charges (deg/s): rhino stampede 90. */
  turnRateDeg?: number;
  /** Whiff recovery (s): croc/eagle 1. */
  recovery?: number;
  /** Caster untargetable window (s): eagle soar 1.5, burrow 3. */
  untargetableT?: number;
  /** Number of hits (giraffe Guillotine 2). */
  hits?: number;
  /** Knockback distance applied to targets (m). */
  knockback?: number;
  /** Caster is CC-immune during the ability. */
  ccImmune?: boolean;
  /** Damage reduction on the caster while active (fraction): croc 0.5, python 0.3. */
  damageReduction?: number;
  /** Ability grabs the target (croc Death Roll, python Embrace). */
  grab?: boolean;
  /** Ability carries the target along a charge (rhino Lockdown). */
  carry?: boolean;
  /** Resets the caster's combo to hit1 (panther Shadow Dash). */
  resetCombo?: boolean;
  /** Breaks crates it passes through (rhino Stampede). */
  breaksCrates?: boolean;
  /** Effects applied to targets on hit. */
  effects?: readonly EffectSpec[];
  /** Effects applied on the conditional bonus (rhino slam stun). */
  bonusEffects?: readonly EffectSpec[];
  /** Buffs applied to the caster on cast. */
  selfBuffs?: readonly EffectSpec[];
  /** Follow-up damage bonus (croc Ambush next Snap +0.60 = +60%). */
  followupBonus?: number;
  /** Window (s) for the follow-up bonus (croc 1). */
  followupWindow?: number;
  /** Extra damage fraction vs rooted targets (mole Sinkhole +0.25). */
  bonusVsRooted?: number;
  /** v1.3: ultimate targeting block (ultimates only; see {@link UltTargeting}). */
  targeting?: UltTargeting;
}

/** Per-animal passive perks and block quirks (§8). */
export interface AnimalPerks {
  /** Panther: damage multiplier when attacking from the rear arc. */
  backstabMult?: number;
  /** Panther: rear-arc full angle (deg) that counts as "behind". */
  backstabArcDeg?: number;
  /** Eagle: move-speed multiplier while blocking (overrides global 0.5). */
  blockMoveMult?: number;
  /** Mole: extra block reduction while stationary (added to blockReduction). */
  stationaryBlockBonus?: number;
  /** Rhino: thorn damage returned to melee attackers who hit the block. */
  thornDamage?: number;
  /** Gorilla: release-block parry-shove. */
  parryShove?: { window: number; damage: number; knockback: number };
  /** Panther: perfect-block auto-counter. */
  perfectBlockCounter?: { window: number; damage: number };
  /** Python: bonus fraction on the next strike after a blocked hit (one stack). */
  tensionBonus?: number;
  /**
   * Eagle: air glide (hold Space in air). `duration` is the total flight time
   * (glide + climb + hover); `cooldown` starts when the eagle lands again.
   */
  glide?: { duration: number; speed: number; cooldown: number };
  /**
   * Eagle v1.2: keep holding Space while gliding to climb ("soar") out of
   * ground reach; landing from height slams nearby foes (BLUEPRINT §7.8).
   */
  soar?: SoarSpec;
}

/**
 * Eagle soar + landing slam (v1.2, BLUEPRINT §7.8). Altitudes are metres above
 * the ground under the eagle.
 */
export interface SoarSpec {
  /** Cruise altitude of the plain glide (m). */
  glideHeight: number;
  /** Seconds of gliding before holding Space starts the climb. */
  climbDelay: number;
  /** Climb rate toward {@link maxHeight} (m/s). */
  climbRate: number;
  /** Vertical acceleration used to ease climb/level-off (m/s²). */
  climbAccel: number;
  /** Ceiling of the climb (m). */
  maxHeight: number;
  /** Above this altitude the eagle cannot attack, block, use its special or ultimate. */
  attackLockHeight: number;
  /** Controlled-descent terminal fall speed after the flight ends (m/s). */
  descentMaxSpeed: number;
  /** A touchdown after peaking at or above this altitude triggers the landing slam (m). */
  landMinHeight: number;
  /** Landing slam damage = base + perMetre × peak altitude, capped at `cap`. */
  landDamageBase: number;
  landDamagePerMetre: number;
  landDamageCap: number;
  /** Landing slam radius (m, padded by target body radius like other AoEs). */
  landRadius: number;
  /** Landing slam radial knockback (m). */
  landKnockback: number;
  /** Seconds the eagle cannot act or move after a slam landing. */
  landRecovery: number;
}

/** Character-select stat pips, each 1–5 (§8 cards). */
export interface StatPips {
  hp: number;
  atk: number;
  def: number;
  spd: number;
  rng: number;
}

export interface AnimalDef {
  id: AnimalId;
  displayName: string;
  /** Epithet, e.g. "The King". */
  title: string;
  /** One sentence tying the kit to the real animal. */
  loreLine: string;
  /** UI + model tint accent (hex). */
  accent: string;

  // Core combat stats (§8 table).
  hp: number;
  speed: number;
  radius: number;
  /** [hit1, hit2, finisher] basic-combo damage. */
  combo: readonly [number, number, number];
  /** Swings per second; swing duration = 1 / attackRate. */
  attackRate: number;
  /**
   * Basic-attack reach (m): from the attacker's centre to the nearest point of
   * the target's BODY (v1.2 sector–circle test — the swing hits any body that
   * pokes into the sector, so effective centre-to-centre reach = range + the
   * target's radius; v1.1 measured to the target's centre, ranges were +0.7).
   */
  range: number;
  /** Basic-attack arc, full angle (deg). */
  arcDeg: number;
  /** Block damage reduction, 0..1. */
  blockReduction: number;
  /** Max guard. */
  guardMax: number;
  /** Approximate DPS (reference only). */
  approxDps: number;

  // Presentation / metadata.
  statPips: StatPips;
  difficultyTag: 'Easy' | 'Medium' | 'Hard';

  // Abilities.
  finisher: FinisherSpec;
  special: AbilitySpec;
  ultimate: AbilitySpec;
  perks: AnimalPerks;
}

/**
 * Telegraph windups. §8 states exact windups only for hippo Colossal Chomp
 * (1.0 s), mole Sinkhole (1.0 s) and lion King's Roar (instant); §7.5/§7.6
 * require a telegraph but leave the rest to tuning. These v1 defaults fill that
 * gap and are the single place to retune it.
 */
const SPECIAL_WINDUP = 0.35;
// ULT_WINDUP (0.5 s) now lives in ./ultimates/shared; ultimate specs are per-animal files in ./ultimates/.

/** Roster order (§8 numbering); used for the 5×2 character-select grid. */
export const ANIMAL_IDS: readonly AnimalId[] = [
  'lion',
  'gorilla',
  'crocodile',
  'hippo',
  'rhino',
  'eagle',
  'panther',
  'python',
  'giraffe',
  'mole',
];

export const ANIMALS: Record<AnimalId, AnimalDef> = {
  lion: {
    id: 'lion',
    displayName: 'Lion',
    title: 'The King',
    loreLine: 'Apex pride hunter whose roar carries up to 8 km across the savanna.',
    accent: '#D9A441',
    hp: 1000,
    speed: 6.5,
    radius: 0.7,
    combo: [70, 70, 95],
    attackRate: 1.4,
    range: 1.5,
    arcDeg: 120,
    blockReduction: 0.6,
    guardMax: 100,
    approxDps: 110,
    statPips: { hp: 3, atk: 4, def: 3, spd: 4, rng: 3 },
    difficultyTag: 'Easy',
    finisher: {
      name: 'Maul Bite',
      description: 'Finisher slows the target 15% for 1.5 s.',
      effects: [{ kind: 'slow', mag: 0.15, dur: 1.5 }],
    },
    special: {
      name: 'Pounce',
      description: 'Leap onto the foe you aim at (up to 8 m); the landing hit deals 60 and knocks down 0.5 s (1.5 m radius).',
      cooldown: 7,
      windup: SPECIAL_WINDUP,
      damage: 60,
      range: 8,
      radius: 1.5,
      effects: [{ kind: 'knockdown', mag: 0, dur: 0.5 }],
    },
    ultimate: LION_ULTIMATE,
    perks: {},
  },

  gorilla: {
    id: 'gorilla',
    displayName: 'Gorilla',
    title: 'The Silverback',
    loreLine: 'A silverback wields roughly ten times the upper-body strength of a man.',
    accent: '#6B7280',
    hp: 1150,
    speed: 5.8,
    radius: 0.8,
    combo: [80, 80, 110],
    attackRate: 1.25,
    range: 1.6,
    arcDeg: 110,
    blockReduction: 0.7,
    guardMax: 130,
    approxDps: 113,
    statPips: { hp: 4, atk: 4, def: 4, spd: 3, rng: 2 },
    difficultyTag: 'Medium',
    finisher: {
      name: 'Double-Fist Slam',
      description: 'Finisher is a 2.5 m slam with a 0.4 s mini-stagger.',
      radius: 2.5,
      effects: [{ kind: 'stagger', mag: 0, dur: 0.4 }],
    },
    special: {
      name: 'Silverback Leap',
      description: 'Jump-slam onto the foe you aim at (up to 7 m): 75 AoE damage (2.5 m) and 4 m knockback.',
      cooldown: 8,
      windup: SPECIAL_WINDUP,
      damage: 75,
      range: 7,
      radius: 2.5,
      knockback: 4,
    },
    ultimate: GORILLA_ULTIMATE,
    perks: {
      parryShove: { window: 0.25, damage: 30, knockback: 4 },
    },
  },

  crocodile: {
    id: 'crocodile',
    displayName: 'Crocodile',
    title: 'The Ambusher',
    loreLine: 'Armored in bony scutes, it bites at 3,700 psi and drowns prey with a death roll.',
    accent: '#4F7942',
    hp: 1250,
    speed: 5.6,
    radius: 0.9,
    combo: [80, 80, 125],
    attackRate: 1.2,
    range: 1.9,
    arcDeg: 100,
    blockReduction: 0.75,
    guardMax: 140,
    approxDps: 114,
    statPips: { hp: 5, atk: 4, def: 4, spd: 3, rng: 2 },
    difficultyTag: 'Medium',
    finisher: {
      name: 'Jaw Crush',
      description: 'Finisher inflicts bleed for 45 damage over 3 s (ignores block).',
      effects: [{ kind: 'bleed', mag: 45, dur: 3 }],
    },
    special: {
      name: 'Ambush Lunge',
      description: 'Low dash up to 7 m that stops at the first foe it reaches; the next Snap within 1 s deals +100%.',
      cooldown: 6,
      windup: SPECIAL_WINDUP,
      range: 7,
      followupBonus: 1.0,
      followupWindow: 1,
    },
    ultimate: CROCODILE_ULTIMATE,
    perks: {},
  },

  hippo: {
    id: 'hippo',
    displayName: 'Hippo',
    title: 'The Riverlord',
    loreLine: 'The deadliest large land mammal in Africa, sprinting 30 km/h behind a barrel of hide.',
    accent: '#9C7B8D',
    hp: 1250,
    speed: 5.7,
    radius: 1.2,
    combo: [75, 75, 140],
    attackRate: 1.05,
    range: 2.15,
    arcDeg: 100,
    blockReduction: 0.85,
    guardMax: 180,
    approxDps: 102,
    statPips: { hp: 5, atk: 4, def: 5, spd: 2, rng: 2 },
    difficultyTag: 'Easy',
    finisher: {},
    special: {
      name: 'River Rush',
      description: 'Charge at 11 m/s for up to 1.2 s; impact deals 95 damage and 2.5 m knockback.',
      cooldown: 6,
      windup: SPECIAL_WINDUP,
      damage: 95,
      moveSpeed: 11,
      maxTime: 1.2,
      knockback: 2.5,
    },
    ultimate: HIPPO_ULTIMATE,
    perks: {},
  },

  rhino: {
    id: 'rhino',
    displayName: 'Rhino',
    title: 'The Battering Ram',
    loreLine: 'Charges at 50 km/h and drives home a horn of solid keratin behind plate-like skin.',
    accent: '#8A8D91',
    hp: 1200,
    speed: 5.0,
    radius: 1.15,
    combo: [80, 80, 115],
    attackRate: 1.05,
    range: 2.15,
    arcDeg: 100,
    blockReduction: 0.7,
    guardMax: 130,
    approxDps: 96,
    statPips: { hp: 5, atk: 3, def: 5, spd: 2, rng: 2 },
    difficultyTag: 'Easy',
    finisher: {
      name: 'Horn Fling',
      description: 'Finisher launches the target 3 m.',
      launch: 3,
    },
    special: {
      name: 'Lockdown Charge',
      description: 'Charge at 12 m/s up to 12 m for 90 damage and carry; if the carried target is stopped by a wall or obstacle, +60 damage and 1 s stun.',
      cooldown: 8,
      windup: SPECIAL_WINDUP,
      damage: 90,
      moveSpeed: 12,
      range: 12,
      carry: true,
      bonusDamage: 60,
      bonusEffects: [{ kind: 'stun', mag: 0, dur: 1 }],
    },
    ultimate: RHINO_ULTIMATE,
    perks: {
      thornDamage: 15,
    },
  },

  eagle: {
    id: 'eagle',
    displayName: 'Eagle',
    title: 'The Sky Terror',
    loreLine: 'Soars out of reach on the thermals, then stoops at over 240 km/h to strike with crushing talons.',
    accent: '#B45309',
    hp: 760,
    speed: 7.2,
    radius: 0.55,
    combo: [65, 65, 85],
    attackRate: 1.7,
    range: 1.3,
    arcDeg: 100,
    blockReduction: 0.45,
    guardMax: 80,
    approxDps: 122,
    statPips: { hp: 1, atk: 5, def: 1, spd: 5, rng: 2 },
    difficultyTag: 'Hard',
    finisher: {
      name: 'Beak Pierce',
      description: 'Finisher ignores 50% of the target’s block reduction.',
      blockIgnore: 0.5,
    },
    special: {
      name: 'Gale Burst',
      description: '5 m / 90° cone: 45 damage, 5 m pushback and 0.5 s disarm.',
      cooldown: 7,
      windup: SPECIAL_WINDUP,
      damage: 45,
      range: 5,
      arcDeg: 90,
      knockback: 5,
      effects: [{ kind: 'disarm', mag: 0, dur: 0.5 }],
    },
    ultimate: EAGLE_ULTIMATE,
    perks: {
      blockMoveMult: 1.2,
      glide: { duration: 4, speed: 8, cooldown: 8 },
      soar: {
        glideHeight: 1.6,
        climbDelay: 0.15,
        climbRate: 4,
        climbAccel: 20,
        maxHeight: 6.5,
        attackLockHeight: 3.2,
        descentMaxSpeed: 10,
        landMinHeight: 3.0,
        landDamageBase: 20,
        landDamagePerMetre: 3,
        landDamageCap: 40,
        landRadius: 3.2,
        landKnockback: 2,
        landRecovery: 0.4,
      },
    },
  },

  panther: {
    id: 'panther',
    displayName: 'Panther',
    title: 'The Shadow',
    loreLine: 'A melanistic leopard that kills from ambush in near-total shadow.',
    accent: '#35294A',
    hp: 875,
    speed: 7.0,
    radius: 0.65,
    combo: [62, 62, 85],
    attackRate: 1.8,
    range: 1.4,
    arcDeg: 110,
    blockReduction: 0.5,
    guardMax: 90,
    approxDps: 125,
    statPips: { hp: 2, atk: 5, def: 2, spd: 5, rng: 2 },
    difficultyTag: 'Hard',
    finisher: {},
    special: {
      name: 'Shadow Dash',
      description: 'Dash 7 m through enemies for 60 pass-through damage; resets the combo to hit1.',
      cooldown: 6,
      windup: SPECIAL_WINDUP,
      damage: 60,
      range: 7,
      resetCombo: true,
    },
    ultimate: PANTHER_ULTIMATE,
    perks: {
      backstabMult: 1.3,
      backstabArcDeg: 75,
      perfectBlockCounter: { window: 0.2, damage: 60 },
    },
  },

  python: {
    id: 'python',
    displayName: 'Python',
    title: 'The Constrictor',
    loreLine: 'An ambush constrictor that strikes at long reach and squeezes the breath from its prey.',
    accent: '#557C3E',
    hp: 880,
    speed: 5.4,
    radius: 0.7,
    combo: [75, 75, 95],
    attackRate: 1.25,
    range: 2.2,
    arcDeg: 50,
    blockReduction: 0.55,
    guardMax: 100,
    approxDps: 102,
    statPips: { hp: 2, atk: 4, def: 3, spd: 3, rng: 4 },
    difficultyTag: 'Medium',
    finisher: {},
    special: {
      name: 'Coil Sweep',
      description: '360° sweep at 3 m: 60 damage and 30% slow for 2 s.',
      cooldown: 7,
      windup: SPECIAL_WINDUP,
      damage: 60,
      range: 3,
      arcDeg: 360,
      effects: [{ kind: 'slow', mag: 0.3, dur: 2 }],
    },
    ultimate: PYTHON_ULTIMATE,
    perks: {
      tensionBonus: 0.3,
    },
  },

  giraffe: {
    id: 'giraffe',
    displayName: 'Giraffe',
    title: 'The High Tower',
    loreLine: 'Settles necking duels with slow, skull-swung blows; a single kick can kill a lion.',
    accent: '#E0B04B',
    hp: 930,
    speed: 6.0,
    radius: 0.9,
    combo: [80, 80, 110],
    attackRate: 0.85,
    range: 2.7,
    arcDeg: 100,
    blockReduction: 0.55,
    guardMax: 110,
    approxDps: 77,
    statPips: { hp: 3, atk: 3, def: 3, spd: 3, rng: 5 },
    difficultyTag: 'Medium',
    finisher: {
      name: 'Skull Hammer',
      description: 'Finisher swings the skull down like a hammer.',
    },
    special: {
      name: 'Thunder Kick',
      description: '2.5 m / 60° kick toward the aim point: 120 damage and 5 m knockback (usable as a peel).',
      cooldown: 8,
      windup: SPECIAL_WINDUP,
      damage: 120,
      range: 2.5,
      arcDeg: 60,
      knockback: 5,
    },
    ultimate: GIRAFFE_ULTIMATE,
    perks: {},
  },

  mole: {
    id: 'mole',
    displayName: 'Mole',
    title: 'The Undertaker',
    loreLine: 'Nearly blind, it tunnels 18 m an hour with shovel-like forelimbs.',
    accent: '#7B5B3F',
    hp: 850,
    speed: 5.6,
    radius: 0.5,
    combo: [60, 60, 75],
    attackRate: 1.6,
    range: 1.3,
    arcDeg: 120,
    blockReduction: 0.5,
    guardMax: 95,
    approxDps: 104,
    statPips: { hp: 2, atk: 3, def: 2, spd: 4, rng: 1 },
    difficultyTag: 'Hard',
    finisher: {
      name: 'Dirt Slinger',
      description: 'Finisher throws dirt in a 3 m cone, blinding for 1 s.',
      coneRange: 3,
      effects: [{ kind: 'blind', mag: 0, dur: 1 }],
    },
    special: {
      name: 'Burrow',
      description: 'Go underground up to 3 s (untargetable, 8.5 m/s, passes under obstacles); emerging erupts for 80 damage and a 0.8 s knock-up (1.5 m).',
      cooldown: 8,
      windup: SPECIAL_WINDUP,
      damage: 80,
      radius: 1.5,
      moveSpeed: 8.5,
      maxTime: 3,
      untargetableT: 3,
      effects: [{ kind: 'knockup', mag: 0, dur: 0.8 }],
    },
    ultimate: MOLE_ULTIMATE,
    perks: {
      stationaryBlockBonus: 0.15,
    },
  },
};
