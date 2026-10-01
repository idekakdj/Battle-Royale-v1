/**
 * Bot AI difficulty profiles (BLUEPRINT §10). WP-C reads these; every parameter
 * is data-driven so difficulty scales reaction/accuracy/decision quality only —
 * never stats or cooldowns ("no cheating at any level", §10).
 */

import type { Difficulty } from '../core/types';
import { TRAP_COUNT_BY_DIFFICULTY } from './traps';

/** How a bot decides to spend its per-animal special. */
export type SpecialUseMode =
  | 'randomOffCd' // Cub: small chance whenever off cooldown
  | 'gapCloser' // Fighter: only to close distance
  | 'gapCloseEscapePeel' // Veteran: close, escape, and peel
  | 'fullScripts'; // Apex: full per-animal scripts (§10)

/** How a bot decides to spend its ultimate. */
export type UltimateUseMode =
  | 'enemyWithinRange' // Cub: on charge if an enemy is within {@link BotProfile.ultimateRangeM}
  | 'targetInUltRange' // Fighter: when the target sits in the ult's effective range
  | 'afterFinisherOrCluster' // Veteran: after landing a finisher, or ≥2 enemies in AoE
  | 'optimalWindows'; // Apex: staggered/guard-broken/rooted targets; saves vs bad trades

/** How aggressively a bot pursues pickups. */
export type PickupPolicy =
  | 'ignore' // Cub
  | 'ifWithinRange' // Fighter: only if within {@link BotProfile.pickupRangeM}
  | 'proactiveWhenSafe' // Veteran
  | 'contestAndDeny'; // Apex: contests and denies (grabs heal when enemy is low)

/** How a bot picks whom to fight. */
export type TargetPolicy =
  | 'nearest' // Cub & Fighter
  | 'lowestHpInRangeElseNearest' // Veteran: lowest HP within {@link BotProfile.targetScanRangeM}
  | 'weighted'; // Apex: low HP, isolated, staggered; avoids clusters

/**
 * v1.2 arena-trap handling (bots read `snapshot.traps`; plates are visible to
 * everyone, so this is not cheating):
 *  - `ignore`  Cub: walks straight over plates and stands in fire.
 *  - `soft`    Fighter: steps out of active hazards, sidesteps plates squarely ahead.
 *  - `route`   Veteran: routes around armed plates, never lingers in a hazard.
 *  - `exploit` Apex: as `route`, and stops chasing a target into an active hazard
 *              (lets the hazard do the work instead).
 */
export type TrapAwareness = 'ignore' | 'soft' | 'route' | 'exploit';

/**
 * v1.3 enemy-ultimate danger-zone dodging (src/ai/dangerZones.ts; only ultimates whose
 * spec sets `targeting.dodge` create zones):
 *  - `never`    Cub: never dodges.
 *  - `lazy`     Fighter: leaves a zone only after seeing it for one more reaction time
 *               and only when an exit is under 2 m away.
 *  - `reliable` Veteran: leaves any zone it stands in as soon as it perceives it.
 *  - `strict`   Apex: as `reliable`, and never walks into an active zone.
 */
export type UltDodge = 'never' | 'lazy' | 'reliable' | 'strict';

/**
 * v1.2 eagle soar use:
 *  - `none`       no deliberate soar (the hit-and-run hop still glides).
 *  - `defensive`  Veteran/Apex: soars over incoming telegraphs and when hurt,
 *                 then releases over an enemy to land the slam.
 */
export type SoarUse = 'none' | 'defensive';

/** Retreat / kite behavior. */
export type RetreatMode = 'never' | 'healSeek' | 'kite' | 'kiteAdvanced';

export interface RetreatProfile {
  mode: RetreatMode;
  /** HP fraction (0..1) at/below which retreat kicks in; 0 for `never`. */
  hpThreshold: number;
  /** Avoid engaging into 2v1s / clusters (Apex). */
  avoidMultiTarget: boolean;
  /** Break line of sight behind pillars while disengaging (Apex). */
  losBreak: boolean;
}

export interface BotProfile {
  difficulty: Difficulty;

  // UI presentation (BLUEPRINT §12, difficulty select cards).
  /** All-caps card label, e.g. "CUB". */
  label: string;
  /** Title-case display name, e.g. "Cub". */
  displayName: string;
  /** One-line tagline for the card. */
  tagline: string;
  /** Paragraph description of the tier's play style. */
  description: string;
  /** Concrete behaviors listed on the difficulty card (from §10). */
  behaviors: readonly string[];

  // Perception / accuracy.
  /** Reaction latency (ms) before buffered perception reaches the brain. */
  reactionMs: number;
  /** Aim-error standard deviation (degrees), applied as gaussian noise. */
  aimErrorDeg: number;

  // Defense.
  /** Probability (0..1) of blocking a telegraphed incoming attack. */
  blockOnTelegraphChance: number;
  /** Attempts perfect-block timing windows (panther counter etc.). */
  perfectBlockTry: boolean;

  // Offense.
  /** Max basic-combo depth the bot will chain (1..3). */
  comboDepth: 1 | 2 | 3;
  /**
   * Hesitation between swings (v1.1), as a multiple of the animal's own swing
   * duration: after pressing attack the bot waits `swing × (1 + this)` before
   * pressing again. 0 = presses as fast as the combo timing allows. Scaling
   * with the swing keeps every animal's relative DPS intact — the Cub is just
   * slower on the trigger, like a new player. A decision knob, not a stat.
   */
  swingPauseMult: number;
  /** Uses feints (start swing, hold, punish whiff) — Apex only. */
  feints: boolean;
  /** Punishes a whiffed enemy swing with an attack. */
  whiffPunish: boolean;
  /** Baits enemy blocks to drain their guard (Apex). */
  baitsBlocks: boolean;

  // Ability usage.
  specialUse: SpecialUseMode;
  /** Chance per opportunity for `randomOffCd` specials (Cub). */
  specialRandomChance: number;
  ultimateUse: UltimateUseMode;
  /** Enemy range gate (m) for the simple `enemyWithinRange` ult mode (Cub). */
  ultimateRangeM: number;
  /** Seconds a full ult charge sits before this tier notices it (v1.1; Cub). */
  ultHesitateS: number;

  // Positioning & survival.
  retreat: RetreatProfile;
  pickupPolicy: PickupPolicy;
  /** Range (m) for the `ifWithinRange` pickup policy (Fighter). */
  pickupRangeM: number;
  targetPolicy: TargetPolicy;
  /** Scan range (m) for HP-aware target policies (Veteran/Apex). */
  targetScanRangeM: number;
  /** Strafe / orbit skill, 0 (never) … 1 (orbits at max range with spacing). */
  strafeSkill: number;

  // v1.2.
  /** How the bot handles arena traps. */
  trapAwareness: TrapAwareness;
  /** v1.3: how the bot dodges enemy-ultimate danger zones. */
  ultDodge: UltDodge;
  /** Eagle only: deliberate soar use. */
  soarUse: SoarUse;
}

/** "N arena traps - ..." difficulty-card line. */
function trapLine(d: Difficulty, how: string): string {
  const n = TRAP_COUNT_BY_DIFFICULTY[d];
  return `${n} arena trap${n === 1 ? '' : 's'}: ${how}`;
}

export const BOT_PROFILES: Record<Difficulty, BotProfile> = {
  1: {
    difficulty: 1,
    label: 'CUB',
    displayName: 'Cub',
    tagline: 'Learns to walk',
    description: `Wanders toward the nearest foe and swings. Slow to react, hesitant between swings, wild aim, ignores pickups and never retreats. The arena hides ${TRAP_COUNT_BY_DIFFICULTY[1]} traps, and Cubs blunder straight into them.`,
    behaviors: [
      'Chases the nearest fighter',
      'Slow reactions (600 ms), wild aim',
      'Hesitant single swings, rarely blocks',
      'Never retreats or grabs pickups',
      trapLine(1, 'Cubs walk right over them'),
    ],
    reactionMs: 600,
    aimErrorDeg: 25,
    blockOnTelegraphChance: 0.05,
    perfectBlockTry: false,
    comboDepth: 1,
    swingPauseMult: 2.0,
    feints: false,
    whiffPunish: false,
    baitsBlocks: false,
    specialUse: 'randomOffCd',
    specialRandomChance: 0.03,
    ultimateUse: 'enemyWithinRange',
    ultimateRangeM: 10,
    ultHesitateS: 3,
    retreat: { mode: 'never', hpThreshold: 0, avoidMultiTarget: false, losBreak: false },
    pickupPolicy: 'ignore',
    pickupRangeM: 0,
    targetPolicy: 'nearest',
    targetScanRangeM: 0,
    strafeSkill: 0.0,
    trapAwareness: 'ignore',
    ultDodge: 'never',
    soarUse: 'none',
  },
  2: {
    difficulty: 2,
    label: 'FIGHTER',
    displayName: 'Fighter',
    tagline: 'Blocks and chases',
    description: `Blocks telegraphed hits, chains short combos, uses specials to close, and seeks heals when hurt. ${TRAP_COUNT_BY_DIFFICULTY[2]} arena traps; Fighters step out of fire and spikes but don't plan around the plates.`,
    behaviors: [
      'Blocks telegraphs (25%)',
      '2-hit combos',
      'Gap-closer specials, ult when in range',
      'Heal-seeks below 40% HP; grabs nearby pickups',
      trapLine(2, 'steps out of active hazards'),
    ],
    reactionMs: 400,
    aimErrorDeg: 15,
    blockOnTelegraphChance: 0.25,
    perfectBlockTry: false,
    comboDepth: 2,
    swingPauseMult: 0,
    feints: false,
    whiffPunish: false,
    baitsBlocks: false,
    specialUse: 'gapCloser',
    specialRandomChance: 0,
    ultimateUse: 'targetInUltRange',
    ultimateRangeM: 0,
    ultHesitateS: 0,
    retreat: { mode: 'healSeek', hpThreshold: 0.4, avoidMultiTarget: false, losBreak: false },
    pickupPolicy: 'ifWithinRange',
    pickupRangeM: 8,
    targetPolicy: 'nearest',
    targetScanRangeM: 0,
    strafeSkill: 0.3,
    trapAwareness: 'soft',
    ultDodge: 'lazy',
    soarUse: 'none',
  },
  3: {
    difficulty: 3,
    label: 'VETERAN',
    displayName: 'Veteran',
    tagline: 'Combos, kites, times ultimates',
    description: `Full combos, times ultimates after finishers or on clusters, kites when low, punishes whiffs, and works pickups proactively. ${TRAP_COUNT_BY_DIFFICULTY[3]} arena traps, and Veterans route around the plates.`,
    behaviors: [
      'Blocks telegraphs (55%), reads spacing',
      'Full 3-hit combos, punishes whiffs',
      'Specials to close, escape and peel',
      'Kites below 35% HP; targets lowest HP within 14 m',
      trapLine(3, 'routes around plates, never lingers in a hazard'),
    ],
    reactionMs: 250,
    aimErrorDeg: 8,
    blockOnTelegraphChance: 0.55,
    perfectBlockTry: false,
    comboDepth: 3,
    swingPauseMult: 0,
    feints: false,
    whiffPunish: true,
    baitsBlocks: false,
    specialUse: 'gapCloseEscapePeel',
    specialRandomChance: 0,
    ultimateUse: 'afterFinisherOrCluster',
    ultimateRangeM: 0,
    ultHesitateS: 0,
    retreat: { mode: 'kite', hpThreshold: 0.35, avoidMultiTarget: false, losBreak: false },
    pickupPolicy: 'proactiveWhenSafe',
    pickupRangeM: 0,
    targetPolicy: 'lowestHpInRangeElseNearest',
    targetScanRangeM: 14,
    strafeSkill: 0.7,
    trapAwareness: 'route',
    ultDodge: 'reliable',
    soarUse: 'defensive',
  },
  4: {
    difficulty: 4,
    label: 'APEX',
    displayName: 'Apex',
    tagline: 'Reads you. Punishes everything.',
    description: `Reads the player: near-instant reactions, perfect-block attempts, feints, full per-animal ability scripts, optimal ults on helpless targets, and retreat-heal-reengage loops that avoid 2v1s. ${TRAP_COUNT_BY_DIFFICULTY[4]} arena traps, and Apex bots are happy to let you chase them into the fire.`,
    behaviors: [
      'Near-instant reactions (150 ms), pinpoint aim',
      'Perfect-block counters, feints, baits blocks',
      'Full per-animal special/ult scripts on optimal windows',
      'Retreat-heal-reengage loops; avoids 2v1s; contests & denies pickups',
      trapLine(4, 'dodged with ease and used against you'),
    ],
    reactionMs: 150,
    aimErrorDeg: 3,
    blockOnTelegraphChance: 0.8,
    perfectBlockTry: true,
    comboDepth: 3,
    swingPauseMult: 0,
    feints: true,
    whiffPunish: true,
    baitsBlocks: true,
    specialUse: 'fullScripts',
    specialRandomChance: 0,
    ultimateUse: 'optimalWindows',
    ultimateRangeM: 0,
    ultHesitateS: 0,
    retreat: { mode: 'kiteAdvanced', hpThreshold: 0.35, avoidMultiTarget: true, losBreak: true },
    pickupPolicy: 'contestAndDeny',
    pickupRangeM: 0,
    targetPolicy: 'weighted',
    targetScanRangeM: 14,
    strafeSkill: 1.0,
    trapAwareness: 'exploit',
    ultDodge: 'strict',
    soarUse: 'defensive',
  },
};

/**
 * Shared AI tuning constants (BLUEPRINT §10). All difficulties share the same
 * decision architecture; only the per-tier {@link BOT_PROFILES} differ.
 */
export const AI_TUNING = {
  /** Utility scores are re-evaluated at this rate. */
  decisionHz: 10,
  /** The currently-selected goal gets this score bonus (hysteresis). */
  currentGoalBonus: 0.15,
  /** Only switch target when a new one scores at least this fraction higher. */
  targetSwitchMargin: 0.25,
  /**
   * v1.1 anti-stall: longest continuous retreat (s) with no heal pad to run to.
   * After it the bot turns and fights for {@link AI_TUNING.reengageS} — a
   * wounded fighter as fast as its pursuer used to kite until the 300 s cap.
   */
  retreatMaxS: 4,
  /** Forced re-engage window (s) after a retreat hit {@link AI_TUNING.retreatMaxS}. */
  reengageS: 5,
  /** Bloodlust multiplier at/above which retreat & pickup detours are damped. */
  bloodlustDampAt: 1.5,
  /** Bloodlust multiplier at/above which bots stop retreating altogether. */
  bloodlustNoRetreatAt: 1.75,
  /**
   * v1.1 ult economy: once an ult has been held this long (s), Veteran/Apex
   * drop their "perfect window" conditions and cast whenever the target is in
   * the ult's effective range (Apex still refuses 3+-enemy bad trades).
   */
  ultPatienceS: 6,
  /** v1.1 unstick: displacement is sampled over this window (s) while travelling … */
  stuckWindowS: 1.0,
  /** … and a move shorter than this (m) counts as stuck. */
  stuckMinMoveM: 0.6,
  /** Stuck next to a crate: swing at it for this long (s) — crates break (§9). */
  smashS: 0.9,
  /** Stuck elsewhere: sidestep (and hop) for this long (s). */
  unstickS: 0.7,
  /**
   * v1.2 eagle soar (Veteran/Apex, `soarUse: 'defensive'`). A telegraph with
   * at least this windup (s) covering the eagle triggers a soar — jump +
   * climb above ground reach takes ≈ 0.65 s plus reaction, so only long
   * windups (Colossal Chomp, Sinkhole, Death From Above) are dodgeable.
   */
  soarDodgeMinWindupS: 0.8,
  /** Soar when below this HP fraction with a foe within 4 m. */
  soarHurtHp: 0.35,
  /** Apex only: soar out of a pile-up of at least this many foes within 5 m. */
  soarMobbedCount: 4,
  /** Seconds spent flying away from the threat before homing onto a foe. */
  soarEscapeS: 1.2,
  /** Release Space when within this horizontal distance (m) of the landing target. */
  soarReleaseDistM: 2.2,
  /** Release this long (s) before the flight time runs out (never hover to the limit). */
  soarReleaseMarginS: 0.4,
} as const;
