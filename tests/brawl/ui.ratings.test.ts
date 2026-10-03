import { describe, expect, it } from 'vitest';
import { ANIMAL_IDS } from '../../src/config/animals';
import { MOVESETS } from '../../src/brawl/data';
import { bestKillPercent, powerFromKillPercent, uiRatings } from '../../src/brawl/ui/ratingsUi';

describe('setup screen mini stat bars', () => {
  it('maps kill percent to power: 85% = full, 150%+ = empty, never-kills = empty', () => {
    expect(powerFromKillPercent(85)).toBe(1);
    expect(powerFromKillPercent(60)).toBe(1);
    expect(powerFromKillPercent(150)).toBe(0);
    expect(powerFromKillPercent(300)).toBe(0);
    expect(powerFromKillPercent(Infinity)).toBe(0);
    expect(powerFromKillPercent(117.5)).toBeCloseTo(0.5, 5);
  });

  it('every animal gets five bars in 0..1 and the roster spreads out on each axis', () => {
    const rows = ANIMAL_IDS.map((a) => uiRatings(MOVESETS[a]));
    for (const r of rows) {
      for (const k of ['weight', 'speed', 'reach', 'recovery', 'power'] as const) {
        expect(r[k]).toBeGreaterThanOrEqual(0);
        expect(r[k]).toBeLessThanOrEqual(1);
      }
    }
    for (const k of ['weight', 'speed', 'recovery', 'power'] as const) {
      const vals = rows.map((r) => r[k]);
      expect(Math.max(...vals) - Math.min(...vals)).toBeGreaterThan(0.3);
    }
  });

  it('heavy hitters have more power than light skirmishers, and a lighter animal has less weight', () => {
    expect(uiRatings(MOVESETS.gorilla).power).toBeGreaterThan(uiRatings(MOVESETS.eagle).power);
    expect(uiRatings(MOVESETS.hippo).weight).toBeGreaterThan(uiRatings(MOVESETS.mole).weight);
    expect(uiRatings(MOVESETS.eagle).recovery).toBeGreaterThan(uiRatings(MOVESETS.hippo).recovery);
    expect(Number.isFinite(bestKillPercent(MOVESETS.lion))).toBe(true);
  });

  it('is cached per animal', () => {
    expect(uiRatings(MOVESETS.lion)).toBe(uiRatings(MOVESETS.lion));
  });
});
