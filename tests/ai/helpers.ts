/**
 * WP-C test harness: run full headless bot-vs-bot matches (World + BotManager
 * ticked at 60 Hz), exactly the way WP-I will wire them.
 */

import { World } from '../../src/sim/World';
import { EventBus } from '../../src/core/EventBus';
import { BotManager } from '../../src/ai/BotManager';
import { ANIMAL_IDS } from '../../src/config/animals';
import type { AnimalId, Difficulty, GameEvent, MatchConfig } from '../../src/core/types';

export const DT = 1 / 60;

/** All-bot roster: the full 10-animal cast, nobody flagged as player. */
export function botRoster(): MatchConfig {
  return {
    roster: (ANIMAL_IDS as AnimalId[]).map((a) => ({ animal: a, isPlayer: false })),
    difficulty: 1,
  };
}

export interface MatchResult {
  ended: boolean;
  winnerId: number;
  /** Sim time (s) when matchEnd fired (excludes the 3 s countdown). */
  timeS: number;
  /** placement by fighter id (1 = winner, 10 = first death); -1 if unknown. */
  placements: number[];
  events: GameEvent[];
}

/**
 * Run one full match. `difficulty` drives every bot unless `perFighter`
 * overrides individual ids. Capped at `maxSimS` seconds of fight time.
 */
export function runMatch(
  seed: number,
  difficulty: Difficulty,
  perFighter?: readonly Difficulty[],
  maxSimS = 300,
  collectEvents = false,
): MatchResult {
  const cfg = botRoster();
  const bus = new EventBus();
  const events: GameEvent[] = [];
  const placements = new Array<number>(cfg.roster.length).fill(-1);
  let ended = false;
  let winnerId = -1;
  let endTime = -1;

  bus.on('death', (e) => {
    placements[e.targetId] = e.placement;
  });
  bus.on('matchEnd', (e) => {
    ended = true;
    winnerId = e.winnerId;
  });
  if (collectEvents) bus.onAny((e) => events.push(e));

  const world = new World(cfg, seed, bus);
  const bots = new BotManager(bus, difficulty, seed);
  if (perFighter !== undefined) {
    for (let i = 0; i < perFighter.length; i++) bots.setDifficulty(i, perFighter[i]);
  }

  const maxTicks = Math.ceil((maxSimS + 3.5) / DT); // + countdown slack
  for (let tick = 0; tick < maxTicks && !ended; tick++) {
    const snap = world.snapshot();
    bots.update(snap, DT);
    for (let id = 0; id < cfg.roster.length; id++) {
      world.setIntent(id, bots.getIntent(id));
    }
    world.step(DT);
    if (ended) endTime = world.snapshot().time;
  }
  if (ended && winnerId >= 0) placements[winnerId] = 1;

  return { ended, winnerId, timeS: endTime, placements, events };
}
