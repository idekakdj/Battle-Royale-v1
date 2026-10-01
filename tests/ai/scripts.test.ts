/**
 * v1.1 (WP-J) ability-script regressions (src/ai/scripts.ts).
 */

import { describe, it, expect } from 'vitest';
import { decideAbilities, type Situation, type AbilityWish } from '../../src/ai/scripts';
import { AI_TUNING, BOT_PROFILES } from '../../src/config/botProfiles';
import { mulberry32 } from '../../src/core/math';
import type { AnimalId, Difficulty } from '../../src/core/types';

function situation(animal: AnimalId, lvl: Difficulty, over: Partial<Situation>): Situation {
  return {
    animal,
    profile: BOT_PROFILES[lvl],
    rng: mulberry32(1),
    now: 10,
    hpFrac: 1,
    guardFrac: 1,
    specialReady: false,
    ultReady: true,
    ultHeldS: 0,
    retreating: false,
    hasTarget: true,
    tdist: 3,
    tHpFrac: 1,
    tGuardFrac: 1,
    targetHelpless: false,
    targetRooted: false,
    targetBlocking: false,
    targetCommitted: false,
    targetFleeing: false,
    targetIsolated: false,
    nearestEnemyDist: 3,
    enemiesNearSelf5: 1,
    enemiesNearSelf8: 1,
    enemiesNearTarget8: 1,
    wallBehindTarget: false,
    recentFinisher: false,
    aimYawToTarget: 0,
    aimYawAway: Math.PI,
    aimYawNearest: 0,
    ...over,
  };
}

function ult(s: Situation): boolean {
  const out: AbilityWish = { special: false, ult: false, aimYaw: 0 };
  decideAbilities(s, out);
  return out.ult;
}

describe('Veteran ranged ultimates can actually fire (v1.1 fix)', () => {
  // "After a finisher" implies melee range, outside these ults' gates, so
  // L3 eagles / moles / panthers used to (almost) never cast.
  it('eagle Death From Above on an isolated target at mid range', () => {
    expect(ult(situation('eagle', 3, { tdist: 7, targetIsolated: true }))).toBe(true);
  });

  it('mole Sinkhole on a fleeing target', () => {
    expect(ult(situation('mole', 3, { tdist: 6, targetFleeing: true }))).toBe(true);
  });

  it('panther Shadow Execution on a wounded (execute-range) or lonely target at mid range', () => {
    expect(ult(situation('panther', 3, { tdist: 9, tHpFrac: 0.4 }))).toBe(true);
    expect(ult(situation('panther', 3, { tdist: 9, targetIsolated: true }))).toBe(true);
    expect(ult(situation('panther', 3, { tdist: 9, tHpFrac: 1 }))).toBe(false); // healthy and guarded: waits for a window
    expect(ult(situation('panther', 3, { tdist: 12, tHpFrac: 0.4 }))).toBe(false); // out of the 11 m lock range
  });

  it('lion Royal Hunt on a soft / lonely target when not crowded; never into a crowd or at a runner', () => {
    expect(ult(situation('lion', 3, { tdist: 7, targetHelpless: true }))).toBe(true);
    expect(ult(situation('lion', 3, { tdist: 7, tHpFrac: 0.4 }))).toBe(true);
    expect(ult(situation('lion', 3, { tdist: 7, tHpFrac: 0.4, enemiesNearSelf8: 3 }))).toBe(false);
    expect(ult(situation('lion', 3, { tdist: 7, tHpFrac: 0.4, targetFleeing: true }))).toBe(false); // the pounce homes slowly
    expect(ult(situation('lion', 3, { tdist: 12, targetHelpless: true }))).toBe(false);
  });

  it('melee ults still wait for the finisher', () => {
    expect(ult(situation('crocodile', 3, { tdist: 2 }))).toBe(false);
    expect(ult(situation('crocodile', 3, { tdist: 2, recentFinisher: true }))).toBe(true);
  });
});

describe('ult patience (v1.1 economy)', () => {
  it(`an Apex hippo stops waiting for a perfect window after ${AI_TUNING.ultPatienceS} s`, () => {
    // v1.3 Riverlord's Flood: a lone, free target (nobody near it) is no window; another fighter near the target is.
    const lone = { enemiesNearTarget8: 0, enemiesNearSelf8: 0 };
    expect(ult(situation('hippo', 4, { tdist: 3, ultHeldS: 0, ...lone }))).toBe(false);
    expect(ult(situation('hippo', 4, { tdist: 3, ultHeldS: AI_TUNING.ultPatienceS + 0.1, ...lone }))).toBe(true);
  });

  it('…but never into a 3+-enemy bad trade', () => {
    expect(ult(situation('hippo', 4, { tdist: 3, ultHeldS: 30, enemiesNearSelf8: 3 }))).toBe(false);
  });

  it('…and never out of range', () => {
    expect(ult(situation('hippo', 4, { tdist: 12, ultHeldS: 30 }))).toBe(false);
  });

  it('a Cub notices a full charge only after its hesitation', () => {
    const wait = BOT_PROFILES[1].ultHesitateS;
    expect(wait).toBeGreaterThan(0);
    expect(ult(situation('lion', 1, { tdist: 4, ultHeldS: 0 }))).toBe(false);
    expect(ult(situation('lion', 1, { tdist: 4, ultHeldS: wait }))).toBe(true);
  });
});
