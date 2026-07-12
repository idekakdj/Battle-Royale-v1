/**
 * WP-C acceptance (BLUEPRINT §14): L4-driven fighters must win ≥ 80% of 20
 * seeded mixed-lobby matches vs L1-driven fighters. 5 Apex + 5 Cub per lobby
 * with the fixed 10-animal split; which HALF of the roster is Apex alternates
 * across seeds so every animal plays both sides.
 */

import { describe, it, expect } from 'vitest';
import type { Difficulty } from '../../src/core/types';
import { runMatch } from './helpers';

const RUNS = 20;

describe('L4 vs L1 skill check (§14 acceptance)', () => {
  it(`Apex-driven fighters win ≥ 80% of ${RUNS} seeded mixed lobbies`, { timeout: 600_000 }, () => {
    let l4Wins = 0;
    const durations: number[] = [];
    for (let run = 0; run < RUNS; run++) {
      const seed = 5000 + run * 37;
      // Even runs: even fighter ids are Apex; odd runs: odd ids are Apex.
      const perFighter: Difficulty[] = [];
      for (let id = 0; id < 10; id++) {
        perFighter.push((id % 2 === run % 2 ? 4 : 1) as Difficulty);
      }
      const r = runMatch(seed, 1, perFighter);
      expect(r.ended).toBe(true);
      durations.push(r.timeS);
      if (r.winnerId >= 0 && perFighter[r.winnerId] === 4) l4Wins++;
    }
    const rate = l4Wins / RUNS;
    // Surfaced in the vitest output for the report.
    console.info(
      `[WP-C skill] L4 win rate ${(rate * 100).toFixed(0)}% (${l4Wins}/${RUNS}); ` +
        `match durations ${Math.min(...durations).toFixed(1)}–${Math.max(...durations).toFixed(1)} s`,
    );
    expect(rate).toBeGreaterThanOrEqual(0.8);
  });
});
