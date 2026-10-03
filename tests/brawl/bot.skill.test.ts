import { describe, it, expect } from 'vitest';
import type { AnimalId } from '../../src/core/types';
import type { BrawlDifficulty, StageId } from '../../src/brawl/types';
import { BrawlWorld } from '../../src/brawl/sim/BrawlWorld';
import { BrawlBot } from '../../src/brawl/ai/BrawlBot';
import { duel } from './botHelpers';

const POOL: AnimalId[] = ['lion', 'gorilla', 'crocodile', 'hippo', 'rhino', 'eagle', 'panther', 'python', 'giraffe', 'mole'];

/** Win rate of level `hi` against level `lo` over `n` matches (animals drawn from the roster, seats alternated). */
function versus(hi: BrawlDifficulty, lo: BrawlDifficulty, n: number, stage: StageId): number {
  let wins = 0;
  for (let g = 0; g < n; g++) {
    const a = POOL[g % POOL.length];
    const b = POOL[(g * 3 + 4) % POOL.length];
    const seat = g % 2;
    const r = duel(seat === 0 ? [a, b] : [b, a], seat === 0 ? [hi, lo] : [lo, hi], 500 + g, { stage, stocks: 2, timeS: 150 });
    if (r.winner === seat) wins++;
  }
  return wins / n;
}

describe('bots: skill ladder', () => {
  it('level 4 beats level 1 in at least 90 % of 10 matches', () => {
    expect(versus(4, 1, 10, 'brokenColosseum')).toBeGreaterThanOrEqual(0.9);
  });
  it('level 2 beats level 1 clearly (>= 70 % of 10 matches)', () => {
    expect(versus(2, 1, 10, 'brokenColosseum')).toBeGreaterThanOrEqual(0.7);
  });
  it('level 4 beats level 2 and level 3 beats level 2 (majority of 10)', () => {
    expect(versus(4, 2, 10, 'skyAqueduct')).toBeGreaterThanOrEqual(0.7);
    expect(versus(3, 2, 10, 'brokenColosseum')).toBeGreaterThanOrEqual(0.6);
  });
});

describe('bots: recovery', () => {
  const trials: { animal: AnimalId; x: number; y: number }[] = [];
  for (const animal of ['lion', 'eagle', 'panther', 'python', 'giraffe', 'mole'] as AnimalId[]) {
    for (const side of [-1, 1]) {
      trials.push({ animal, x: side * 14, y: -1 });
      trials.push({ animal, x: side * 13.5, y: -3 });
    }
  }
  for (const level of [3, 4] as BrawlDifficulty[]) {
    it(`level ${level}: returns to the stage in >= 80 % of off-stage trials`, () => {
      let ok = 0;
      for (const [k, t] of trials.entries()) {
        const w = new BrawlWorld({ stage: 'brokenColosseum', roster: [{ animal: t.animal, isPlayer: false }, { animal: 'lion', isPlayer: false }], difficulty: 4, stocks: 3, timeLimitS: 60 }, 40 + k);
        w.skipCountdown();
        w.debugPlace(1, -t.x * 0.2, 0);
        w.debugSetPercent(0, 130);
        w.debugPlace(0, t.x, t.y, 0, 0);
        const bot = new BrawlBot(0, level, 77 + k);
        let back = false;
        let snap = w.snapshot();
        for (let f = 0; f < 420 && !back; f++) {
          w.setIntent(0, bot.update(snap));
          w.step();
          snap = w.snapshot();
          const me = snap.fighters[0];
          if (!me.alive) break;
          if (me.grounded || me.action === 'ledgeHang') back = true;
        }
        if (back) ok++;
      }
      expect(ok / trials.length).toBeGreaterThanOrEqual(0.8);
    });
  }
});

describe('bots: no stalling', () => {
  for (const stage of ['brokenColosseum', 'skyAqueduct'] as StageId[]) {
    it(`${stage}: level 3/4 bots trade KOs instead of standing around`, () => {
      let withKo = 0;
      const pairs: [AnimalId, AnimalId][] = [
        ['python', 'giraffe'],
        ['hippo', 'gorilla'],
        ['mole', 'eagle'],
        ['lion', 'rhino'],
      ];
      for (const [k, [a, b]] of pairs.entries()) {
        const r = duel([a, b], [k % 2 ? 3 : 4, 4], 900 + k, { stage, stocks: 3, timeS: 240 });
        if (r.kos >= 2) withKo++;
      }
      expect(withKo).toBeGreaterThanOrEqual(3);
    });
  }
});
