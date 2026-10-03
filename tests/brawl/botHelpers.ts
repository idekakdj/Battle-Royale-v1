/** Shared helpers for the bot tests: run real-data matches between bots headlessly. */
import type { AnimalId } from '../../src/core/types';
import type { BrawlDifficulty, BrawlIntent, BrawlSnapshot, StageId } from '../../src/brawl/types';
import { BrawlWorld } from '../../src/brawl/sim/BrawlWorld';
import { BrawlBot } from '../../src/brawl/ai/BrawlBot';

export interface DuelResult {
  winner: number;
  frames: number;
  kos: number;
  over: boolean;
}

export function duel(
  animals: AnimalId[],
  levels: BrawlDifficulty[],
  seed: number,
  opts: { stage?: StageId; stocks?: number; timeS?: number; onIntent?: (i: number, it: BrawlIntent, snap: BrawlSnapshot) => void } = {},
): DuelResult {
  const timeS = opts.timeS ?? 120;
  const w = new BrawlWorld(
    { stage: opts.stage ?? 'brokenColosseum', roster: animals.map((animal) => ({ animal, isPlayer: false })), difficulty: 4, stocks: opts.stocks ?? 2, timeLimitS: timeS },
    seed,
  );
  w.skipCountdown();
  const bots = animals.map((_, i) => new BrawlBot(i, levels[i], seed * 31 + i * 7919));
  let snap = w.snapshot();
  let kos = 0;
  const max = timeS * 60 + 300;
  while (!snap.matchOver && snap.frame < max) {
    for (let i = 0; i < bots.length; i++) {
      const it = bots[i].update(snap);
      opts.onIntent?.(i, it, snap);
      w.setIntent(i, it);
    }
    w.step();
    for (const e of w.drainEvents()) if (e.type === 'ko') kos++;
    snap = w.snapshot();
  }
  return { winner: snap.winnerId, frames: snap.frame - 180, kos, over: snap.matchOver };
}
