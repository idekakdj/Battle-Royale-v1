import { describe, expect, it } from 'vitest';
import { ALL_ANIMALS, seatRoster } from '../../src/match/seating';

const order = (seed: number, animal: (typeof ALL_ANIMALS)[number] = 'lion'): string =>
  seatRoster(animal, seed)
    .map((r) => r.animal)
    .join(',');

describe('seatRoster', () => {
  it('is deterministic for a seed', () => {
    expect(order(12345)).toBe(order(12345));
    expect(order(Date.UTC(2026, 8, 29), 'mole')).toBe(order(Date.UTC(2026, 8, 29), 'mole'));
  });

  it('seats the player first and all ten animals exactly once', () => {
    for (const animal of ALL_ANIMALS) {
      const r = seatRoster(animal, 777);
      expect(r).toHaveLength(10);
      expect(r[0]).toEqual({ animal, isPlayer: true });
      expect(r.slice(1).every((e) => !e.isPlayer && e.animal !== animal)).toBe(true);
      expect(new Set(r.map((e) => e.animal)).size).toBe(10);
      expect([...r.map((e) => e.animal)].sort()).toEqual([...ALL_ANIMALS].sort());
    }
  });

  it('gives different neighbours for different seeds', () => {
    const seen = new Set<string>();
    for (let s = 1; s <= 20; s++) seen.add(order(s * 7919));
    expect(seen.size).toBeGreaterThan(15);
    expect(order(1)).not.toBe(order(2));
  });

  it('handles large (Date.now()-sized) seeds', () => {
    const r = seatRoster('giraffe', 1_790_000_000_000);
    expect(new Set(r.map((e) => e.animal)).size).toBe(10);
  });
});
