/**
 * Bot AI difficulty profiles (BLUEPRINT §10). WP-C reads these; every parameter
 * is data-driven so difficulty scales reaction/accuracy/decision quality only —
 * never stats or cooldowns ("no cheating at any level", §10).
 */

import type { Difficulty } from '../core/types';

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
}

export const BOT_PROFILES: Record<Difficulty, BotProfile> = {
  1: {
    difficulty: 1,
    label: 'CUB',
    displayName: 'Cub',
    tagline: 'Learns to walk',
    description: 'Wanders toward the nearest foe and swings. Slow to react, hesitant between swings, wild aim, ignores pickups and never retreats.',
    behaviors: [
      'Chases the nearest fighter',
      'Slow reactions (600 ms), wild aim',
      'Hesitant single swings, rarely blocks',
      'Never retreats or grabs pickups',
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
  },
  2: {
    difficulty: 2,
    label: 'FIGHTER',
    displayName: 'Fighter',
    tagline: 'Blocks and chases',
    description: 'Blocks telegraphed hits, chains short combos, uses specials to close, and seeks heals when hurt.',
    behaviors: [
      'Blocks telegraphs (25%)',
      '2-hit combos',
      'Gap-closer specials, ult when in range',
      'Heal-seeks below 40% HP; grabs nearby pickups',
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
  },
  3: {
    difficulty: 3,
    label: 'VETERAN',
    displayName: 'Veteran',
    tagline: 'Combos, kites, times ultimates',
    description: 'Full combos, times ultimates after finishers or on clusters, kites when low, punishes whiffs, and works pickups proactively.',
    behaviors: [
      'Blocks telegraphs (55%), reads spacing',
      'Full 3-hit combos, punishes whiffs',
      'Specials to close, escape and peel',
      'Kites below 35% HP; targets lowest HP within 14 m',
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
  },
  4: {
    difficulty: 4,
    label: 'APEX',
    displayName: 'Apex',
    tagline: 'Reads you. Punishes everything.',
    description: 'Reads the player: near-instant reactions, perfect-block attempts, feints, full per-animal ability scripts, optimal ults on helpless targets, and retreat-heal-reengage loops that avoid 2v1s.',
    behaviors: [
      'Near-instant reactions (150 ms), pinpoint aim',
      'Perfect-block counters, feints, baits blocks',
      'Full per-animal special/ult scripts on optimal windows',
      'Retreat-heal-reengage loops; avoids 2v1s; contests & denies pickups',
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
} as const;
