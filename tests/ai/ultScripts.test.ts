/**
 * v1.3 — the per-animal bot ultimate scripts (src/ai/ultScripts/*) and how
 * `decideAbilities` dispatches to them.
 *
 * All ten ultimates were redesigned in v1.3 (each has its own gates/windows, covered by
 * tests/sim/ultimates/<animal>.test.ts), so the old "identical to the frozen v1.2 monolith"
 * oracle was retired. What stays is the registry contract and the dispatch invariants of
 * the four bot profile modes, checked against the live registry on a large seeded sweep.
 */

import { describe, it, expect } from 'vitest';
import { decideAbilities, type Situation, type AbilityWish } from '../../src/ai/scripts';
import { ULT_SCRIPTS } from '../../src/ai/ultScripts';
import { AI_TUNING, BOT_PROFILES } from '../../src/config/botProfiles';
import { ANIMAL_IDS } from '../../src/config/animals';
import { mulberry32 } from '../../src/core/math';
import type { AnimalId, Difficulty } from '../../src/core/types';

// ── Situation sampling ───────────────────────────────────────────────────────

function sample(rng: () => number, animal: AnimalId, lvl: Difficulty): Situation {
  const bool = (): boolean => rng() < 0.4;
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];
  return {
    animal,
    profile: BOT_PROFILES[lvl],
    rng: mulberry32(1),
    now: 10,
    hpFrac: pick([0.2, 0.4, 0.41, 0.7, 1]),
    guardFrac: pick([0.2, 1]),
    specialReady: false,
    ultReady: true,
    ultHeldS: pick([0, 1, AI_TUNING.ultPatienceS, AI_TUNING.ultPatienceS + 3, BOT_PROFILES[lvl].ultHesitateS]),
    retreating: bool(),
    hasTarget: rng() < 0.93,
    tdist: rng() * 16,
    tHpFrac: pick([0.1, 0.35, 0.4, 0.55, 0.9]),
    tGuardFrac: pick([0.1, 0.34, 0.36, 0.9]),
    targetHelpless: bool(),
    targetRooted: bool(),
    targetBlocking: bool(),
    targetCommitted: bool(),
    targetFleeing: bool(),
    targetIsolated: bool(),
    nearestEnemyDist: rng() * 10,
    enemiesNearSelf5: Math.floor(rng() * 4),
    enemiesNearSelf8: Math.floor(rng() * 5),
    enemiesNearTarget8: Math.floor(rng() * 4),
    wallBehindTarget: bool(),
    recentFinisher: bool(),
    aimYawToTarget: 0,
    aimYawAway: Math.PI,
    aimYawNearest: 0,
  };
}

function decide(s: Situation): boolean {
  const out: AbilityWish = { special: false, ult: false, aimYaw: 0 };
  decideAbilities(s, out);
  return out.ult;
}

describe('per-animal ultimate scripts (v1.3 registry)', () => {
  it('registers a script for every animal', () => {
    for (const id of ANIMAL_IDS) {
      const sc = ULT_SCRIPTS[id];
      expect(sc, id).toBeDefined();
      expect(typeof sc.gate).toBe('function');
      expect(typeof sc.apex).toBe('function');
    }
    expect(Object.keys(ULT_SCRIPTS).sort()).toEqual([...ANIMAL_IDS].sort());
  });

  it('ranged ults are exactly eagle / giraffe / gorilla / lion / mole / panther / python; cluster ults exactly gorilla / rhino / hippo (the lion hunt and the giraffe slam are single-target)', () => {
    const ranged = ANIMAL_IDS.filter((a) => ULT_SCRIPTS[a].ranged === true).sort();
    expect(ranged).toEqual(['eagle', 'giraffe', 'gorilla', 'lion', 'mole', 'panther', 'python']);
    const cluster = ANIMAL_IDS.filter((a) => ULT_SCRIPTS[a].cluster !== undefined).sort();
    expect(cluster).toEqual(['gorilla', 'hippo', 'rhino']);
  });
});

describe('decideAbilities dispatches to the registry (all profile modes)', () => {
  for (const lvl of [1, 2, 3, 4] as Difficulty[]) {
    const SAMPLES = 2000;

    it(`L${lvl}: never casts without a target, without a charge, or into a lock-target fizzle (${SAMPLES} samples/animal)`, () => {
      const rng = mulberry32(777 + lvl);
      for (const animal of ANIMAL_IDS) {
        for (let i = 0; i < SAMPLES; i++) {
          const s = sample(rng, animal, lvl);
          expect(decide({ ...s, hasTarget: false }), `${animal} no target`).toBe(false);
          expect(decide({ ...s, ultReady: false }), `${animal} not ready`).toBe(false);
          expect(decide({ ...s, ultTargetValid: false }), `${animal} invalid lock target`).toBe(false);
        }
      }
    });

    it(`L${lvl}: the profile mode's contract holds against the live scripts (${SAMPLES} samples/animal)`, () => {
      const rng = mulberry32(1234 + lvl);
      const p = BOT_PROFILES[lvl];
      let casts = 0;
      let holds = 0;
      for (const animal of ANIMAL_IDS) {
        const sc = ULT_SCRIPTS[animal];
        for (let i = 0; i < SAMPLES; i++) {
          const s = sample(rng, animal, lvl);
          const got = decide(s);
          if (!s.hasTarget) {
            expect(got, `${animal} no target`).toBe(false);
            continue;
          }
          const tag = `${animal} L${lvl}`;
          switch (p.ultimateUse) {
            case 'enemyWithinRange': {
              const want = s.ultHeldS >= p.ultHesitateS && s.tdist <= p.ultimateRangeM && sc.gate(s);
              expect(got, tag).toBe(want);
              break;
            }
            case 'targetInUltRange':
              expect(got, tag).toBe(sc.gate(s));
              break;
            case 'afterFinisherOrCluster':
              // Any cast is the gate (finisher / ranged window / patience) or a cluster trade; patience always fires in range.
              if (got) expect(sc.gate(s) || sc.cluster?.(s) === true, tag).toBe(true);
              if (s.ultHeldS >= AI_TUNING.ultPatienceS && sc.gate(s)) expect(got, `${tag} patience`).toBe(true);
              break;
            case 'optimalWindows':
              // Outnumbered (3+ around self) saves the charge; patience always fires in range otherwise.
              if (s.enemiesNearSelf8 >= 3) expect(got, `${tag} bad trade`).toBe(false);
              else if (s.ultHeldS >= AI_TUNING.ultPatienceS && sc.gate(s)) expect(got, `${tag} patience`).toBe(true);
              break;
          }
          if (got) casts++;
          else holds++;
        }
      }
      // The sweep exercises both branches (a script that never casts, or always casts, would be broken).
      expect(casts).toBeGreaterThan(50);
      expect(holds).toBeGreaterThan(50);
    });
  }
});
