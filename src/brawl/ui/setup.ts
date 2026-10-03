/**
 * Champions League — the player's setup choice (pure data, no DOM): defaults, defensive parsing of
 * the stored `gk-brawl` value, the seeded roster builder and the BrawlMatchConfig builder.
 */

import { mulberry32 } from '../../core/math';
import type { AnimalId } from '../../core/types';
import { ANIMAL_IDS } from '../../config/animals';
import { STAGE_IDS } from '../types';
import type { BrawlDifficulty, BrawlMatchConfig, BrawlRosterEntry, StageId } from '../types';

export type BrawlOpponents = 1 | 2 | 3;
export type BrawlStocks = 1 | 2 | 3 | 4 | 5;
/** Time limit in minutes; 0 = no limit. */
export type BrawlTimeMin = 0 | 3 | 5 | 8;

export const BRAWL_TIME_OPTIONS: readonly BrawlTimeMin[] = [0, 3, 5, 8];
export const BRAWL_OPPONENT_OPTIONS: readonly BrawlOpponents[] = [1, 2, 3];
export const BRAWL_DIFFICULTY_OPTIONS: readonly BrawlDifficulty[] = [1, 2, 3, 4];
export const BRAWL_STOCK_OPTIONS: readonly BrawlStocks[] = [1, 2, 3, 4, 5];

/** Everything the setup screen decides (stored as `gk-brawl`). */
export interface BrawlSetupChoice {
  animal: AnimalId;
  stage: StageId;
  opponents: BrawlOpponents;
  difficulty: BrawlDifficulty;
  stocks: BrawlStocks;
  timeMin: BrawlTimeMin;
}

export const DEFAULT_BRAWL_STAGE: StageId = 'brokenColosseum';

/** Defaults; `animal` is overridden by the caller (the stored `gk-animal`). */
export function defaultBrawlSetup(animal: AnimalId = 'lion'): BrawlSetupChoice {
  return { animal, stage: DEFAULT_BRAWL_STAGE, opponents: 3, difficulty: 2, stocks: 3, timeMin: 5 };
}

function pick<T extends string | number>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(raw) ? (raw as T) : fallback;
}

/**
 * Parse a raw stored `gk-brawl` string into a valid choice. Never throws; every bad / missing field
 * falls back to `fallback` (default: {@link defaultBrawlSetup} with `fallbackAnimal`).
 */
export function parseBrawlSetup(raw: string | null | undefined, fallbackAnimal: AnimalId = 'lion'): BrawlSetupChoice {
  const base = defaultBrawlSetup(fallbackAnimal);
  if (typeof raw !== 'string' || raw.length === 0) return base;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return base;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return base;
  const p = parsed as Record<string, unknown>;
  return {
    animal: pick<AnimalId>(p.animal, ANIMAL_IDS, base.animal),
    stage: pick<StageId>(p.stage, STAGE_IDS, base.stage),
    opponents: pick<BrawlOpponents>(p.opponents, BRAWL_OPPONENT_OPTIONS, base.opponents),
    difficulty: pick<BrawlDifficulty>(p.difficulty, BRAWL_DIFFICULTY_OPTIONS, base.difficulty),
    stocks: pick<BrawlStocks>(p.stocks, BRAWL_STOCK_OPTIONS, base.stocks),
    timeMin: pick<BrawlTimeMin>(p.timeMin, BRAWL_TIME_OPTIONS, base.timeMin),
  };
}

/**
 * Roster: slot 0 = the player; `opponents` bots (1–3) with unique animals drawn from the
 * remaining nine by a seeded Fisher–Yates shuffle (deterministic per seed).
 */
export function buildRoster(playerAnimal: AnimalId, opponents: number, seed: number): BrawlRosterEntry[] {
  const pool = ANIMAL_IDS.filter((a) => a !== playerAnimal);
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = pool[i];
    pool[i] = pool[j];
    pool[j] = t;
  }
  const n = Math.max(1, Math.min(3, Math.floor(opponents) || 1));
  const roster: BrawlRosterEntry[] = [{ animal: playerAnimal, isPlayer: true }];
  for (let i = 0; i < n; i++) roster.push({ animal: pool[i], isPlayer: false });
  return roster;
}

export function buildMatchConfig(setup: BrawlSetupChoice, seed: number): BrawlMatchConfig {
  return {
    stage: setup.stage,
    roster: buildRoster(setup.animal, setup.opponents, seed),
    difficulty: setup.difficulty,
    stocks: setup.stocks,
    timeLimitS: setup.timeMin * 60,
  };
}

export function timeLabel(timeMin: BrawlTimeMin): string {
  return timeMin === 0 ? '∞' : `${timeMin} min`;
}
