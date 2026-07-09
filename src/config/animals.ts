/**
 * The roster — 10 animal gladiators (BLUEPRINT §8). This is the binding data
 * table: every stat, combo number, ability magnitude, block value, and status
 * effect from §8 lives here as typed, sim-readable data (kind tags + magnitudes)
 * so no system hard-codes balance numbers (BLUEPRINT §2, §15).
 *
 * WP-B reads combat/ability numbers; WP-F reads presentation (pips, lore, prose).
 */

import type { AnimalId } from '../core/types';

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
  /** First-attack-from-stealth bonus damage (panther Night Prowl 200). */
  stealthBonusDamage?: number;
  /** Extra damage fraction vs rooted targets (mole Sinkhole +0.25). */
  bonusVsRooted?: number;
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
  /** Eagle: air glide (hold Space in air). */
  glide?: { duration: number; speed: number; cooldown: number };
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
  /** Basic-attack reach (m from center). */
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
const ULT_WINDUP = 0.5;

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
    range: 2.2,
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
      description: 'Leap up to 8 m to the aim point; landing hit deals 60 and knocks down 0.5 s (1.5 m radius).',
      cooldown: 7,
      windup: SPECIAL_WINDUP,
      damage: 60,
      range: 8,
      radius: 1.5,
      effects: [{ kind: 'knockdown', mag: 0, dur: 0.5 }],
    },
    ultimate: {
      name: "King's Roar",
      description: 'Instant 8 m roar: 100 damage and fear 2 s; feared foes take +20% damage for 5 s; the Lion gains +20% speed for 5 s.',
      cooldown: 0,
      windup: 0,
      damage: 100,
      radius: 8,
      effects: [
        { kind: 'fear', mag: 0, dur: 2 },
        { kind: 'dmgTakenUp', mag: 0.2, dur: 5 },
      ],
      selfBuffs: [{ kind: 'speedUp', mag: 0.2, dur: 5 }],
    },
    perks: {},
  },

  gorilla: {
    id: 'gorilla',
    displayName: 'Gorilla',
    title: 'The Silverback',
    loreLine: 'A silverback wields roughly ten times the upper-body strength of a man.',
    accent: '#6B7280',
    hp: 1100,
    speed: 5.8,
    radius: 0.8,
    combo: [80, 80, 110],
    attackRate: 1.2,
    range: 2.3,
    arcDeg: 110,
    blockReduction: 0.7,
    guardMax: 130,
    approxDps: 108,
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
      description: 'Jump-slam at an aim point up to 7 m: 75 AoE damage (2.5 m) and 4 m knockback.',
      cooldown: 8,
      windup: SPECIAL_WINDUP,
      damage: 75,
      range: 7,
      radius: 2.5,
      knockback: 4,
    },
    ultimate: {
      name: 'Primal Rampage',
      description: 'For 6 s: +40% attack speed, +25% damage, basic hits knock back 2 m, immune to flinch and stagger.',
      cooldown: 0,
      windup: ULT_WINDUP,
      duration: 6,
      knockback: 2,
      ccImmune: true,
      selfBuffs: [
        { kind: 'atkSpeedUp', mag: 0.4, dur: 6 },
        { kind: 'dmgUp', mag: 0.25, dur: 6 },
      ],
    },
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
    hp: 1150,
    speed: 5.2,
    radius: 0.9,
    combo: [75, 75, 120],
    attackRate: 1.1,
    range: 2.4,
    arcDeg: 90,
    blockReduction: 0.72,
    guardMax: 120,
    approxDps: 111,
    statPips: { hp: 4, atk: 4, def: 4, spd: 2, rng: 2 },
    difficultyTag: 'Medium',
    finisher: {
      name: 'Jaw Crush',
      description: 'Finisher inflicts bleed for 30 damage over 3 s.',
      effects: [{ kind: 'bleed', mag: 30, dur: 3 }],
    },
    special: {
      name: 'Ambush Lunge',
      description: 'Low 7 m dash; the next Snap within 1 s deals +60%.',
      cooldown: 7,
      windup: SPECIAL_WINDUP,
      range: 7,
      followupBonus: 0.6,
      followupWindow: 1,
    },
    ultimate: {
      name: 'Death Roll',
      description: 'Lunge 4 m; on hit, grab and roll for 2.5 s dealing 260 damage while the target is stunned; the Crocodile takes 50% reduced damage during the roll. On a miss, 1 s recovery.',
      cooldown: 0,
      windup: ULT_WINDUP,
      range: 4,
      damage: 260,
      duration: 2.5,
      grab: true,
      damageReduction: 0.5,
      recovery: 1,
      effects: [{ kind: 'stun', mag: 0, dur: 2.5 }],
    },
    perks: {},
  },

  hippo: {
    id: 'hippo',
    displayName: 'Hippo',
    title: 'The Riverlord',
    loreLine: 'The deadliest large land mammal in Africa, sprinting 30 km/h behind a barrel of hide.',
    accent: '#9C7B8D',
    hp: 1300,
    speed: 4.8,
    radius: 1.2,
    combo: [85, 85, 120],
    attackRate: 1.0,
    range: 2.6,
    arcDeg: 130,
    blockReduction: 0.75,
    guardMax: 140,
    approxDps: 97,
    statPips: { hp: 5, atk: 4, def: 5, spd: 1, rng: 2 },
    difficultyTag: 'Easy',
    finisher: {},
    special: {
      name: 'River Rush',
      description: 'Charge at 11 m/s for up to 1.2 s; impact deals 80 damage and 4 m knockback.',
      cooldown: 8,
      windup: SPECIAL_WINDUP,
      damage: 80,
      moveSpeed: 11,
      maxTime: 1.2,
      knockback: 4,
    },
    ultimate: {
      name: 'Colossal Chomp',
      description: '1.0 s windup, then a 4 m / 130° cone: 250 damage and 30% slow for 2 s.',
      cooldown: 0,
      windup: 1.0,
      damage: 250,
      range: 4,
      arcDeg: 130,
      effects: [{ kind: 'slow', mag: 0.3, dur: 2 }],
    },
    perks: {},
  },

  rhino: {
    id: 'rhino',
    displayName: 'Rhino',
    title: 'The Battering Ram',
    loreLine: 'Charges at 50 km/h and drives home a horn of solid keratin behind plate-like skin.',
    accent: '#8A8D91',
    hp: 1250,
    speed: 5.0,
    radius: 1.15,
    combo: [80, 80, 115],
    attackRate: 1.05,
    range: 2.6,
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
      description: 'Charge at 12 m/s up to 12 m for 100 damage and carry; if the carried target is stopped by a wall or obstacle, +60 damage and 1 s stun.',
      cooldown: 9,
      windup: SPECIAL_WINDUP,
      damage: 100,
      moveSpeed: 12,
      range: 12,
      carry: true,
      bonusDamage: 60,
      bonusEffects: [{ kind: 'stun', mag: 0, dur: 1 }],
    },
    ultimate: {
      name: 'Seismic Stampede',
      description: '3 s steerable charge (turn ≤90°/s), CC-immune, breaking crates and dealing 180 damage plus a knockdown to each fighter run through (once per target).',
      cooldown: 0,
      windup: ULT_WINDUP,
      duration: 3,
      damage: 180,
      turnRateDeg: 90,
      ccImmune: true,
      breaksCrates: true,
      effects: [{ kind: 'knockdown', mag: 0, dur: 0.8 }],
    },
    perks: {
      thornDamage: 15,
    },
  },

  eagle: {
    id: 'eagle',
    displayName: 'Eagle',
    title: 'The Sky Terror',
    loreLine: 'Stoops at over 240 km/h to strike with crushing talons.',
    accent: '#B45309',
    hp: 700,
    speed: 7.2,
    radius: 0.55,
    combo: [65, 65, 85],
    attackRate: 1.7,
    range: 2.0,
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
    ultimate: {
      name: 'Death From Above',
      description: 'Soar untargetable for 1.5 s, then dive at the aim point: 240 direct damage (1.2 m) and 60 splash (3 m). 1 s recovery on a whiff.',
      cooldown: 0,
      windup: 0,
      untargetableT: 1.5,
      damage: 240,
      radius: 1.2,
      splashDamage: 60,
      splashRadius: 3,
      recovery: 1,
    },
    perks: {
      blockMoveMult: 1.2,
      glide: { duration: 2.5, speed: 8, cooldown: 5 },
    },
  },

  panther: {
    id: 'panther',
    displayName: 'Panther',
    title: 'The Shadow',
    loreLine: 'A melanistic leopard that kills from ambush in near-total shadow.',
    accent: '#35294A',
    hp: 750,
    speed: 7.0,
    radius: 0.65,
    combo: [60, 60, 80],
    attackRate: 1.8,
    range: 2.1,
    arcDeg: 110,
    blockReduction: 0.5,
    guardMax: 90,
    approxDps: 120,
    statPips: { hp: 2, atk: 5, def: 2, spd: 5, rng: 2 },
    difficultyTag: 'Hard',
    finisher: {},
    special: {
      name: 'Shadow Dash',
      description: 'Dash 7 m through enemies for 50 pass-through damage; resets the combo to hit1.',
      cooldown: 6,
      windup: SPECIAL_WINDUP,
      damage: 50,
      range: 7,
      resetCombo: true,
    },
    ultimate: {
      name: 'Night Prowl',
      description: '5 s stealth with +30% speed; the first attack from stealth deals 200 bonus crit damage and breaks stealth.',
      cooldown: 0,
      windup: 0,
      duration: 5,
      stealthBonusDamage: 200,
      selfBuffs: [
        { kind: 'stealth', mag: 0, dur: 5 },
        { kind: 'speedUp', mag: 0.3, dur: 5 },
      ],
    },
    perks: {
      backstabMult: 1.25,
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
    hp: 850,
    speed: 5.4,
    radius: 0.7,
    combo: [75, 75, 95],
    attackRate: 1.25,
    range: 3.2,
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
    ultimate: {
      name: "Constrictor's Embrace",
      description: 'Grab lunge 5 m: wrap for 3 s dealing 240 damage while the target is stunned; the Python takes 30% less damage while constricting.',
      cooldown: 0,
      windup: ULT_WINDUP,
      range: 5,
      damage: 240,
      duration: 3,
      grab: true,
      damageReduction: 0.3,
      effects: [{ kind: 'stun', mag: 0, dur: 3 }],
    },
    perks: {
      tensionBonus: 0.3,
    },
  },

  giraffe: {
    id: 'giraffe',
    displayName: 'Giraffe',
    title: 'The High Tower',
    loreLine: 'Settles necking duels with skull-swung blows; a single kick can kill a lion.',
    accent: '#E0B04B',
    hp: 1050,
    speed: 6.2,
    radius: 0.9,
    combo: [85, 85, 110],
    attackRate: 0.95,
    range: 4.0,
    arcDeg: 140,
    blockReduction: 0.55,
    guardMax: 110,
    approxDps: 89,
    statPips: { hp: 4, atk: 3, def: 3, spd: 3, rng: 5 },
    difficultyTag: 'Medium',
    finisher: {
      name: 'Skull Hammer',
      description: 'Finisher swings the skull down like a hammer.',
    },
    special: {
      name: 'Thunder Kick',
      description: '2.5 m / 60° kick toward the aim point: 120 damage and 6 m knockback (usable as a peel).',
      cooldown: 8,
      windup: SPECIAL_WINDUP,
      damage: 120,
      range: 2.5,
      arcDeg: 60,
      knockback: 6,
    },
    ultimate: {
      name: 'Guillotine Spin',
      description: 'Two 360° neck sweeps over 2 s (4.5 m): 90 damage each; the second sweep knocks down.',
      cooldown: 0,
      windup: ULT_WINDUP,
      duration: 2,
      damage: 90,
      range: 4.5,
      arcDeg: 360,
      hits: 2,
      effects: [{ kind: 'knockdown', mag: 0, dur: 0.8 }],
    },
    perks: {},
  },

  mole: {
    id: 'mole',
    displayName: 'Mole',
    title: 'The Undertaker',
    loreLine: 'Nearly blind, it tunnels 18 m an hour with shovel-like forelimbs.',
    accent: '#7B5B3F',
    hp: 800,
    speed: 5.6,
    radius: 0.5,
    combo: [60, 60, 75],
    attackRate: 1.6,
    range: 1.7,
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
      cooldown: 9,
      windup: SPECIAL_WINDUP,
      damage: 80,
      radius: 1.5,
      moveSpeed: 8.5,
      maxTime: 3,
      untargetableT: 3,
      effects: [{ kind: 'knockup', mag: 0, dur: 0.8 }],
    },
    ultimate: {
      name: 'Sinkhole',
      description: '4 m zone at the aim point (≤10 m) with a 1 s telegraph, then 150 damage and root 2 s; the Mole deals +25% to rooted targets.',
      cooldown: 0,
      windup: 1.0,
      damage: 150,
      radius: 4,
      range: 10,
      bonusVsRooted: 0.25,
      effects: [{ kind: 'root', mag: 0, dur: 2 }],
    },
    perks: {
      stationaryBlockBonus: 0.15,
    },
  },
};
