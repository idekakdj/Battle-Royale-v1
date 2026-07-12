/**
 * WP-C determinism: identical seeds ⇒ identical winner and placements
 * (mulberry32 only; zero Math.random in ai/).
 */

import { describe, it, expect } from 'vitest';
import { runMatch } from './helpers';

describe('bot determinism', () => {
  it('same seed twice → identical winner and placements', { timeout: 240_000 }, () => {
    const a = runMatch(777, 4);
    const b = runMatch(777, 4);
    expect(a.ended).toBe(true);
    expect(b.ended).toBe(true);
    expect(b.winnerId).toBe(a.winnerId);
    expect(b.placements).toEqual(a.placements);
    expect(b.timeS).toBeCloseTo(a.timeS, 6);
  });

  it('a different seed diverges (rng actually in use)', { timeout: 240_000 }, () => {
    const a = runMatch(777, 4);
    const c = runMatch(778, 4);
    expect(a.placements.join(',') === c.placements.join(',') && a.timeS === c.timeS).toBe(false);
  });
});
