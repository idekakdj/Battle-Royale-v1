/**
 * Champions League bots — tuning tables.
 *
 *  - `LEVELS`: what each difficulty can perceive and do (plan §7 table).
 *  - `TACTICS`: per-animal fighting style (preferred range, kill move, approach tool, recovery pattern,
 *    safe-vs-risky move picks). The planner derives everything geometric from the move data; this table
 *    only biases it toward the animal's identity.
 */

import type { AnimalId } from '../../core/types';
import type { BrawlDifficulty, MoveId } from '../types';

export interface LevelParams {
  level: BrawlDifficulty;
  /** Reaction delay range (frames); the opponents are seen this far in the past. */
  delay: [number, number];
  /** Frames between decision ticks while fighting (the planner is cheap-skipped when far away). */
  think: number;
  /** Extrapolate opponents' motion across the reaction delay (a player compensates for lag). */
  extrap: boolean;
  /** Subtract the delay from perceived frame data (remaining recovery, impact time). */
  adjust: boolean;
  /** 0 = mash Light, 1 = heuristic move choice, 2 = frame-data planner. */
  engine: 0 | 1 | 2;
  /** Std-dev of the distance misjudgement (m). */
  noise: number;
  /** Chance to dodge a recognised incoming hit. */
  dodge: number;
  /** Directional influence: 0 none, 1 crude, 2 trajectory-aware. */
  di: 0 | 1 | 2;
  /** Recovery: 0 fumble, 1 greedy rules, 2 planned (jump/Heavy-Up timing simulated), 3 planned + mix-ups. */
  recovery: 0 | 1 | 2 | 3;
  /** Per-tick chance a recovery input is dropped / mistimed. */
  recoveryMiss: number;
  /** Chance to take an obvious whiff punish. */
  punish: number;
  /** Chance to respect platform edges and not chase off stage. */
  edgeSafe: number;
  edgeGuard: boolean;
  combos: boolean;
  ledgeTrap: boolean;
  stagePlay: boolean;
  /** Move-choice randomness (0 = always best). */
  mix: number;
  /** Base aggression (willingness to start attacks / approach). */
  aggression: number;
}

export const LEVELS: Record<BrawlDifficulty, LevelParams> = {
  1: {
    level: 1,
    delay: [24, 32],
    think: 6,
    extrap: false,
    adjust: false,
    engine: 0,
    noise: 0.9,
    dodge: 0,
    di: 0,
    recovery: 0,
    recoveryMiss: 0.5,
    punish: 0,
    edgeSafe: 0,
    edgeGuard: false,
    combos: false,
    ledgeTrap: false,
    stagePlay: false,
    mix: 1,
    aggression: 0.5,
  },
  2: {
    level: 2,
    delay: [14, 20],
    think: 4,
    extrap: false,
    adjust: false,
    engine: 1,
    noise: 0.45,
    dodge: 0.22,
    di: 1,
    recovery: 1,
    recoveryMiss: 0.07,
    punish: 0.45,
    edgeSafe: 0.6,
    edgeGuard: false,
    combos: false,
    ledgeTrap: false,
    stagePlay: false,
    mix: 0.5,
    aggression: 0.65,
  },
  3: {
    level: 3,
    delay: [8, 12],
    think: 2,
    extrap: true,
    adjust: true,
    engine: 2,
    noise: 0.15,
    dodge: 0.6,
    di: 2,
    recovery: 2,
    recoveryMiss: 0.02,
    punish: 0.85,
    edgeSafe: 0.9,
    edgeGuard: true,
    combos: true,
    ledgeTrap: false,
    stagePlay: true,
    mix: 0.2,
    aggression: 0.8,
  },
  4: {
    level: 4,
    delay: [4, 6],
    think: 1,
    extrap: true,
    adjust: true,
    engine: 2,
    noise: 0.05,
    dodge: 0.85,
    di: 2,
    recovery: 3,
    recoveryMiss: 0.005,
    punish: 1,
    edgeSafe: 1,
    edgeGuard: true,
    combos: true,
    ledgeTrap: true,
    stagePlay: true,
    mix: 0.08,
    aggression: 0.9,
  },
};

export type ApproachTool = 'run' | 'jumpIn' | 'dash' | 'wait';
export type RecoveryPattern = 'ledge' | 'high' | 'glide' | 'blink';

export interface AnimalTactics {
  /** Preferred neutral spacing (m between feet centres). */
  range: number;
  /** The animal's KO move. */
  killMove: MoveId;
  /** Percent (on a mid-weight victim) from which the bot hunts the kill move; derived from data when 0. */
  killPct: number;
  /** How it closes the gap. */
  approach: ApproachTool;
  /** Chance per decision tick to jump in at mid range (approach 'jumpIn'). */
  jumpIn: number;
  /** Neutral pokes, best first (used when the opponent is actionable). */
  pokes: MoveId[];
  /** Multiplicative preference per move (> 1 favoured, < 1 avoided in neutral). */
  bias: Partial<Record<MoveId, number>>;
  /** Moves too slow/unsafe to throw at an actionable opponent (they are still used to punish or kill). */
  risky: MoveId[];
  /** How it gets back: aim for the ledge, return high over the stage, glide, or blink (invulnerable leap). */
  recovery: RecoveryPattern;
  /** Aerial moves it likes to use in the air. */
  aerials: MoveId[];
}

export const TACTICS: Record<AnimalId, AnimalTactics> = {
  lion: {
    range: 1.7,
    killMove: 'heavyS',
    killPct: 0,
    approach: 'run',
    jumpIn: 0.08,
    pokes: ['lightS', 'lightN', 'lightU'],
    bias: { lightS: 1.1, heavyN: 0.8 },
    risky: ['heavyS', 'heavyN', 'heavyD'],
    recovery: 'ledge',
    aerials: ['lightN', 'lightS', 'heavyD'],
  },
  gorilla: {
    range: 2.0,
    killMove: 'heavyS',
    killPct: 0,
    approach: 'run',
    jumpIn: 0.03,
    pokes: ['lightS', 'lightN', 'lightD'],
    bias: { heavyS: 1.25, heavyN: 1.2 },
    risky: ['heavyD'],
    recovery: 'high',
    aerials: ['lightN', 'heavyD'],
  },
  crocodile: {
    range: 2.2,
    killMove: 'heavyS',
    killPct: 0,
    approach: 'run',
    jumpIn: 0.02,
    pokes: ['lightN', 'lightD', 'lightS'],
    bias: { lightD: 1.15, lightN: 1.1 },
    risky: ['heavyS', 'heavyD'],
    recovery: 'high',
    aerials: ['lightN', 'heavyD'],
  },
  hippo: {
    range: 2.0,
    killMove: 'heavyN',
    killPct: 0,
    approach: 'run',
    jumpIn: 0.01,
    pokes: ['lightN', 'lightS', 'lightD'],
    bias: { heavyN: 1.3, heavyS: 1.2 },
    risky: ['heavyD'],
    recovery: 'high',
    aerials: ['lightN', 'heavyD'],
  },
  rhino: {
    range: 2.2,
    killMove: 'heavyS',
    killPct: 0,
    approach: 'dash',
    jumpIn: 0.02,
    pokes: ['lightS', 'lightN', 'lightD'],
    bias: { heavyS: 1.3, heavyN: 0.9 },
    risky: ['heavyD'],
    recovery: 'high',
    aerials: ['lightN', 'heavyD'],
  },
  eagle: {
    range: 1.5,
    killMove: 'heavyS',
    killPct: 0,
    approach: 'jumpIn',
    jumpIn: 0.35,
    pokes: ['lightN', 'lightS', 'lightU'],
    bias: { lightN: 1.2, heavyN: 0.9 },
    risky: ['heavyS', 'heavyN'],
    recovery: 'glide',
    aerials: ['lightN', 'lightS', 'heavyS', 'heavyD', 'lightD'],
  },
  panther: {
    range: 1.5,
    killMove: 'heavyS',
    killPct: 0,
    approach: 'dash',
    jumpIn: 0.15,
    pokes: ['lightN', 'lightS', 'lightU'],
    bias: { lightN: 1.2, lightS: 1.1 },
    risky: ['heavyN', 'heavyD'],
    recovery: 'blink',
    aerials: ['lightN', 'lightS', 'heavyD'],
  },
  python: {
    range: 2.8,
    killMove: 'heavyS',
    killPct: 0,
    approach: 'wait',
    jumpIn: 0.02,
    pokes: ['lightS', 'lightN', 'lightD'],
    bias: { lightS: 1.25, lightN: 1.1 },
    risky: ['heavyS', 'heavyD'],
    recovery: 'ledge',
    aerials: ['lightN', 'lightS'],
  },
  giraffe: {
    range: 2.8,
    killMove: 'heavyS',
    killPct: 0,
    approach: 'wait',
    jumpIn: 0.02,
    pokes: ['lightN', 'lightS', 'lightU'],
    bias: { lightN: 1.15, heavyS: 1.1 },
    risky: ['heavyD', 'heavyN'],
    recovery: 'ledge',
    aerials: ['lightN', 'lightS', 'heavyD'],
  },
  mole: {
    range: 1.0,
    killMove: 'heavyS',
    killPct: 0,
    approach: 'run',
    jumpIn: 0.1,
    pokes: ['lightN', 'lightS', 'lightD'],
    bias: { lightN: 1.2, heavyD: 1.1 },
    risky: ['heavyN'],
    recovery: 'ledge',
    aerials: ['lightN', 'lightS', 'heavyD'],
  },
};
