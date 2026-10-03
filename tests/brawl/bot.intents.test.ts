import { describe, it, expect } from 'vitest';
import type { AnimalId } from '../../src/core/types';
import type { BrawlDifficulty, BrawlIntent, BrawlSnapshot } from '../../src/brawl/types';
import { BrawlWorld } from '../../src/brawl/sim/BrawlWorld';
import { BrawlBot } from '../../src/brawl/ai/BrawlBot';
import { duel } from './botHelpers';

const KEYS = ['moveX', 'moveY', 'jump', 'jumpHeld', 'light', 'heavy', 'dodge'].sort();

function legal(it: BrawlIntent): boolean {
  if (Object.keys(it).sort().join() !== KEYS.join()) return false;
  if (!Number.isFinite(it.moveX) || !Number.isFinite(it.moveY)) return false;
  if (Math.abs(it.moveX) > 1 || Math.abs(it.moveY) > 1) return false;
  return [it.jump, it.jumpHeld, it.light, it.heavy, it.dodge].every((b) => typeof b === 'boolean');
}

describe('bots: legal intents', () => {
  const pairs: [AnimalId, AnimalId][] = [
    ['lion', 'gorilla'],
    ['eagle', 'python'],
    ['mole', 'giraffe'],
    ['hippo', 'panther'],
    ['crocodile', 'rhino'],
  ];
  for (const level of [1, 2, 3, 4] as BrawlDifficulty[]) {
    it(`level ${level}: never NaN / out of range / wrong shape, on both stages`, () => {
      let n = 0;
      pairs.forEach(([a, b], k) => {
        duel([a, b], [level, level], 100 + k, {
          stage: k % 2 === 0 ? 'brokenColosseum' : 'skyAqueduct',
          timeS: 40,
          onIntent: (_i, it) => {
            n++;
            if (!legal(it)) throw new Error(`illegal intent ${JSON.stringify(it)}`);
          },
        });
      });
      expect(n).toBeGreaterThan(5000);
    });
  }

  it('handles a 4-fighter free-for-all, dead fighters and a finished match', () => {
    const animals: AnimalId[] = ['lion', 'eagle', 'hippo', 'mole'];
    const w = new BrawlWorld({ stage: 'skyAqueduct', roster: animals.map((animal) => ({ animal, isPlayer: false })), difficulty: 4, stocks: 1, timeLimitS: 60 }, 5);
    const bots = animals.map((_, i) => new BrawlBot(i, 3, 5 + i));
    let snap = w.snapshot();
    for (let f = 0; f < 4000 && !snap.matchOver; f++) {
      bots.forEach((b, i) => {
        const it = b.update(snap);
        expect(legal(it)).toBe(true);
        w.setIntent(i, it);
      });
      w.step();
      snap = w.snapshot();
    }
    expect(legal(bots[0].update(snap))).toBe(true);
  });
});

describe('bots: determinism', () => {
  function stream(seed: number, level: BrawlDifficulty): string {
    const out: string[] = [];
    duel(['panther', 'rhino'], [level, level], seed, {
      timeS: 30,
      onIntent: (i, it) => out.push(`${i}:${it.moveX.toFixed(3)},${it.moveY.toFixed(3)},${+it.jump}${+it.jumpHeld}${+it.light}${+it.heavy}${+it.dodge}`),
    });
    return out.join('|');
  }
  for (const level of [1, 2, 3, 4] as BrawlDifficulty[]) {
    it(`level ${level}: same seed gives the identical intent stream, another seed differs`, () => {
      const a = stream(11, level);
      expect(stream(11, level)).toBe(a);
      expect(stream(12, level)).not.toBe(a);
    });
  }

  it('is a pure function of the snapshot stream: replaying recorded snapshots reproduces the intents', () => {
    const snaps: BrawlSnapshot[] = [];
    const first: BrawlIntent[] = [];
    const w = new BrawlWorld({ stage: 'brokenColosseum', roster: [{ animal: 'lion', isPlayer: false }, { animal: 'giraffe', isPlayer: false }], difficulty: 4, stocks: 2, timeLimitS: 30 }, 3);
    w.skipCountdown();
    const bot = new BrawlBot(0, 4, 9);
    const other = new BrawlBot(1, 4, 10);
    let snap = w.snapshot();
    for (let f = 0; f < 1500 && !snap.matchOver; f++) {
      snaps.push(snap);
      const it = bot.update(snap);
      first.push(it);
      w.setIntent(0, it);
      w.setIntent(1, other.update(snap));
      w.step();
      snap = w.snapshot();
    }
    const again = new BrawlBot(0, 4, 9);
    snaps.forEach((s, i) => expect(again.update(s)).toEqual(first[i]));
  });
});
