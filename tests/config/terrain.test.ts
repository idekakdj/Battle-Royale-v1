/**
 * v1.8 terrain tuning (config/terrain.ts + `AnimalDef.swim`): the documented numbers, the swim ordering of the Jungle plan and the
 * water-multiplier formula are pinned here, so a retune is a conscious change.
 */

import { describe, it, expect } from 'vitest';
import { ANIMALS, ANIMAL_IDS } from '../../src/config/animals';
import {
  MOSS_SPEED_MULT,
  TERRAIN,
  WATER_BLOCKED_SPECIALS,
  splashStrength,
  waterMultFromSwim,
  waterSpeedMultiplier,
} from '../../src/config/terrain';
import { JUNGLE_ARENA } from '../../src/config/arenas';
import type { AnimalId } from '../../src/core/types';

/** Plan ordering (docs/JUNGLE-PLAN.md): crocodile >> hippo > python > panther > mole ~ lion > eagle > rhino > gorilla > giraffe. */
const ORDER: readonly AnimalId[] = ['crocodile', 'hippo', 'python', 'panther', 'mole', 'lion', 'eagle', 'rhino', 'gorilla', 'giraffe'];

describe('terrain numbers (plan)', () => {
  it('pins the documented constants', () => {
    expect(TERRAIN.moss.slow).toBe(0.35);
    expect(TERRAIN.moss.lingerS).toBe(0.4);
    expect(TERRAIN.groundedAlt).toBe(0.6);
    expect(TERRAIN.water.shorelineHysteresis).toBe(0.15);
    expect(TERRAIN.water.multMin).toBe(0.3);
    expect(TERRAIN.water.multMax).toBe(1);
    expect(MOSS_SPEED_MULT).toBeCloseTo(0.65, 12);
    expect(WATER_BLOCKED_SPECIALS).toEqual(['mole']);
  });

  it('the pool is shallow: the grounded line sits at the visible water depth (nobody can go under)', () => {
    const pool = JUNGLE_ARENA.terrain.find((z) => z.kind === 'water');
    expect(pool?.depth).toBeDefined();
    expect(pool?.depth as number).toBeLessThan(0.6);
    expect(TERRAIN.groundedAlt).toBeGreaterThanOrEqual(pool?.depth as number);
  });
});

describe('swim attribute and water speed multiplier', () => {
  it('every animal has a swim aptitude in [0, 1]', () => {
    for (const id of ANIMAL_IDS) {
      const s = ANIMALS[id].swim;
      expect(typeof s, id).toBe('number');
      expect(s, id).toBeGreaterThanOrEqual(0);
      expect(s, id).toBeLessThanOrEqual(1);
    }
  });

  it('the multiplier of every animal is within [0.3, 1.0]', () => {
    for (const id of ANIMAL_IDS) {
      const m = waterSpeedMultiplier(id);
      expect(m, id).toBeGreaterThanOrEqual(0.3);
      expect(m, id).toBeLessThanOrEqual(1.0);
      expect(waterSpeedMultiplier(ANIMALS[id]), id).toBe(m); // by def or by id
    }
  });

  it('pins the plan ordering: crocodile >> hippo > python > panther > mole ~ lion > eagle > rhino > gorilla > giraffe', () => {
    const m = ORDER.map((id) => waterSpeedMultiplier(id));
    for (let i = 1; i < m.length; i++) expect(m[i - 1], `${ORDER[i - 1]} > ${ORDER[i]}`).toBeGreaterThan(m[i]);
    // crocodile is far ahead of everybody (the pool is its home), mole and lion are close
    expect(m[0] - m[1]).toBeGreaterThan(0.05);
    expect(m[0]).toBeGreaterThanOrEqual(0.9);
    expect(Math.abs(waterSpeedMultiplier('mole') - waterSpeedMultiplier('lion'))).toBeLessThan(0.1);
    // the same ordering holds for the raw swim attribute
    for (let i = 1; i < ORDER.length; i++) expect(ANIMALS[ORDER[i - 1]].swim).toBeGreaterThan(ANIMALS[ORDER[i]].swim);
  });

  it('is close to the plan starting values (0.95 / 0.85 / 0.75 / 0.6 / 0.55 / 0.5 / 0.45 / 0.4 / 0.35 / 0.35 of land speed)', () => {
    const plan = [0.95, 0.85, 0.75, 0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.35];
    ORDER.forEach((id, i) => expect(Math.abs(waterSpeedMultiplier(id) - plan[i]), id).toBeLessThanOrEqual(0.04));
  });

  it('the formula is linear in swim and clamps garbage', () => {
    expect(waterMultFromSwim(0)).toBeCloseTo(0.3, 12);
    expect(waterMultFromSwim(1)).toBeCloseTo(1, 12);
    expect(waterMultFromSwim(0.5)).toBeCloseTo(0.65, 12);
    expect(waterMultFromSwim(-3)).toBeCloseTo(0.3, 12);
    expect(waterMultFromSwim(7)).toBeCloseTo(1, 12);
    expect(waterMultFromSwim(Number.NaN)).toBeCloseTo(0.3, 12);
  });

  it('absolute water speed: the crocodile swims about as fast as it runs, a giraffe wades at under a third of the lion', () => {
    const abs = (id: AnimalId): number => ANIMALS[id].speed * waterSpeedMultiplier(id);
    expect(abs('crocodile') / ANIMALS.crocodile.speed).toBeGreaterThan(0.9);
    expect(abs('giraffe')).toBeLessThan(abs('crocodile') / 2.5);
    expect(abs('giraffe')).toBeLessThan(2.1);
  });
});

describe('splash strength', () => {
  it('is within [0, 1], grows with horizontal and vertical speed, and is never 0 (a standing plop is audible)', () => {
    expect(splashStrength(0, 0)).toBeGreaterThan(0);
    expect(splashStrength(0, 0)).toBeLessThan(0.3);
    let prev = splashStrength(0, 0);
    for (let v = 0.5; v <= 12; v += 0.5) {
      const s = splashStrength(v, 0);
      expect(s).toBeGreaterThanOrEqual(prev);
      expect(s).toBeLessThanOrEqual(1);
      prev = s;
    }
    expect(splashStrength(6, 5)).toBeGreaterThan(splashStrength(6, 0));
    expect(splashStrength(100, 100)).toBe(1);
    expect(splashStrength(-6, -5)).toBe(splashStrength(6, 5)); // direction does not matter
    expect(splashStrength(Number.NaN, 0)).toBe(0);
  });
});
