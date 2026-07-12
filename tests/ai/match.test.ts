/**
 * WP-C acceptance (BLUEPRINT §14): 10 bots fight to matchEnd < 240 s sim-time
 * with no errors, at both L1 (Cub) and L4 (Apex).
 */

import { describe, it, expect } from 'vitest';
import { runMatch } from './helpers';

describe('full bot matches reach matchEnd (< 240 s sim time)', () => {
  it('10 Cub (L1) bots finish a match', { timeout: 120_000 }, () => {
    const r = runMatch(101, 1);
    expect(r.ended).toBe(true);
    expect(r.timeS).toBeGreaterThan(0);
    expect(r.timeS).toBeLessThan(240);
    expect(r.winnerId).toBeGreaterThanOrEqual(0);
    // Placements 1..10 all assigned exactly once.
    const sorted = [...r.placements].sort((a, b) => a - b);
    expect(sorted).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('10 Apex (L4) bots finish a match', { timeout: 120_000 }, () => {
    const r = runMatch(202, 4);
    expect(r.ended).toBe(true);
    expect(r.timeS).toBeGreaterThan(0);
    expect(r.timeS).toBeLessThan(240);
    expect(r.winnerId).toBeGreaterThanOrEqual(0);
    const sorted = [...r.placements].sort((a, b) => a - b);
    expect(sorted).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
