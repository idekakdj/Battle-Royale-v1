/**
 * v1.8 HUD terrain chip model: "Swimming · NN % speed" / "Mossy ground · 65 % speed" for the LOCAL player, hidden otherwise and
 * never on the colosseum.
 */

import { describe, expect, it } from 'vitest';
import { ANIMAL_IDS, ANIMALS } from '../../src/config/animals';
import { MOSS_SPEED_MULT, waterSpeedMultiplier } from '../../src/config/terrain';
import { mossTagText, speedPercent, swimTagText, terrainTagText } from '../../src/ui/terrainTag';
import type { AnimalId } from '../../src/core/types';

const f = (animal: AnimalId, extra: { alive?: boolean; inWater?: boolean; onMoss?: boolean } = {}) => ({
  animal,
  alive: extra.alive ?? true,
  inWater: extra.inWater,
  onMoss: extra.onMoss,
});

describe('terrainTagText', () => {
  it('swimming: the animal\'s own water multiplier as a rounded percent', () => {
    for (const a of ANIMAL_IDS) {
      const pct = Math.round(waterSpeedMultiplier(a) * 100);
      expect(terrainTagText(f(a, { inWater: true }), 'jungle')).toBe(`Swimming · ${pct} % speed`);
      expect(swimTagText(a)).toBe(`Swimming · ${pct} % speed`);
    }
  });

  it('the swim percentages follow the plan ordering: crocodile best, giraffe worst, all within 30..100', () => {
    const pct = (a: AnimalId): number => Number(/(\d+) %/.exec(swimTagText(a))?.[1]);
    expect(pct('crocodile')).toBeGreaterThan(pct('hippo'));
    expect(pct('hippo')).toBeGreaterThan(pct('python'));
    expect(pct('python')).toBeGreaterThan(pct('panther'));
    expect(pct('panther')).toBeGreaterThan(pct('lion'));
    expect(pct('lion')).toBeGreaterThan(pct('rhino'));
    expect(pct('rhino')).toBeGreaterThan(pct('gorilla'));
    expect(pct('gorilla')).toBeGreaterThanOrEqual(pct('giraffe'));
    for (const a of ANIMAL_IDS) {
      expect(pct(a)).toBeGreaterThanOrEqual(30);
      expect(pct(a)).toBeLessThanOrEqual(100);
    }
  });

  it('moss: "Mossy ground · 65 % speed" (1 - the 35 % slow) for every animal', () => {
    expect(Math.round(MOSS_SPEED_MULT * 100)).toBe(65);
    expect(mossTagText()).toBe('Mossy ground · 65 % speed');
    for (const a of ANIMAL_IDS) expect(terrainTagText(f(a, { onMoss: true }), 'jungle')).toBe('Mossy ground · 65 % speed');
  });

  it('water wins over moss; plain ground is hidden', () => {
    expect(terrainTagText(f('lion', { inWater: true, onMoss: true }), 'jungle')).toBe(swimTagText('lion'));
    expect(terrainTagText(f('lion'), 'jungle')).toBeNull();
    expect(terrainTagText(f('lion', { inWater: false, onMoss: false }), 'jungle')).toBeNull();
  });

  it('is hidden on the colosseum whatever the flags say, and when the player is dead / unknown', () => {
    expect(terrainTagText(f('lion', { inWater: true }), 'colosseum')).toBeNull();
    expect(terrainTagText(f('lion', { onMoss: true }), 'colosseum')).toBeNull();
    expect(terrainTagText(f('lion', { inWater: true }), undefined)).toBeNull();
    expect(terrainTagText(f('lion', { inWater: true, alive: false }), 'jungle')).toBeNull();
    expect(terrainTagText(undefined, 'jungle')).toBeNull();
  });

  it('speedPercent rounds and clamps', () => {
    expect(speedPercent(0.624)).toBe(62);
    expect(speedPercent(0.625)).toBe(63);
    expect(speedPercent(1.4)).toBe(100);
    expect(speedPercent(-1)).toBe(0);
  });

  it('every animal has a swim aptitude behind the number (the tag is never NaN)', () => {
    for (const a of ANIMAL_IDS) {
      expect(Number.isFinite(ANIMALS[a].swim)).toBe(true);
      expect(swimTagText(a)).not.toContain('NaN');
    }
  });
});
