import { describe, it, expect } from 'vitest';
import { dealDamage } from '../../src/sim/CombatSystem';
import { addBuff } from '../../src/sim/StatusEffects';
import { makeFighter, makeSim } from './helpers';
import type { GameEvent } from '../../src/core/types';
import type { DamageOpts } from '../../src/sim/CombatSystem';

const basic: DamageOpts = { blockable: true, heavy: false, reaction: 'none', isBasic: true };

describe('damage pipeline (§7.1)', () => {
  it('applies flat base damage with no modifiers', () => {
    const a = makeFighter(0, 'lion', 0, 0, 0);
    const t = makeFighter(1, 'gorilla', 0, 2, 0);
    const sim = makeSim([a, t]);
    const r = dealDamage(sim, a, t, 70, basic);
    expect(r.blocked).toBe(false);
    expect(r.dealt).toBeCloseTo(70, 5);
    expect(t.state.hp).toBeCloseTo(1100 - 70, 5);
  });

  it('applies rage ×1.25', () => {
    const a = makeFighter(0, 'lion', 0, 0, 0);
    const t = makeFighter(1, 'gorilla', 0, 2, 0);
    const sim = makeSim([a, t]);
    addBuff(a, 'rage', 0.25, 8);
    expect(dealDamage(sim, a, t, 70, basic).dealt).toBeCloseTo(87.5, 5);
  });

  it('multiplies by bloodlust', () => {
    const a = makeFighter(0, 'lion', 0, 0, 0);
    const t = makeFighter(1, 'gorilla', 0, 2, 0);
    const sim = makeSim([a, t]);
    sim.bloodlustMult = 1.5;
    expect(dealDamage(sim, a, t, 70, basic).dealt).toBeCloseTo(105, 5);
  });

  it('applies staggered vulnerability ×1.25', () => {
    const a = makeFighter(0, 'lion', 0, 0, 0);
    const t = makeFighter(1, 'gorilla', 0, 2, 0);
    const sim = makeSim([a, t]);
    t.staggerTimer = 1;
    expect(dealDamage(sim, a, t, 100, basic).dealt).toBeCloseTo(125, 5);
  });

  it('panther backstab ×1.25 only from the rear arc', () => {
    const behind = makeFighter(0, 'panther', 0, -2, 0); // behind a +Z-facing target
    const front = makeFighter(2, 'panther', 0, 2, 0);
    const t = makeFighter(1, 'gorilla', 0, 0, 0); // faces +Z
    const sim = makeSim([behind, t, front]);
    expect(dealDamage(sim, behind, t, 60, basic).dealt).toBeCloseTo(75, 5);
    t.state.hp = 1100;
    expect(dealDamage(sim, front, t, 60, basic).dealt).toBeCloseTo(60, 5);
  });
});

describe('block math (§7.1/§7.4)', () => {
  it('reduces by blockReduction and drains guard when blocking frontally', () => {
    const a = makeFighter(0, 'lion', 0, 2, 0); // in front of target (target faces +Z)
    const t = makeFighter(1, 'gorilla', 0, 0, 0);
    const sim = makeSim([a, t]);
    t.blocking = true;
    const r = dealDamage(sim, a, t, 100, basic);
    expect(r.blocked).toBe(true);
    expect(r.dealt).toBeCloseTo(30, 5); // 100 × (1 − 0.7)
    expect(t.state.guard).toBeCloseTo(130 - 45, 5); // drain 100 × 0.45
    expect(t.state.damageBlocked).toBeCloseTo(70, 5);
  });

  it('does not block a hit from outside the frontal 150° arc', () => {
    const a = makeFighter(0, 'lion', 0, -2, 0); // behind
    const t = makeFighter(1, 'gorilla', 0, 0, 0);
    const sim = makeSim([a, t]);
    t.blocking = true;
    const r = dealDamage(sim, a, t, 100, basic);
    expect(r.blocked).toBe(false);
    expect(r.dealt).toBeCloseTo(100, 5);
  });

  it('eagle Beak Pierce ignores 50% of block reduction', () => {
    const a = makeFighter(0, 'eagle', 0, 2, 0);
    const t = makeFighter(1, 'gorilla', 0, 0, 0);
    const sim = makeSim([a, t]);
    t.blocking = true;
    // effective reduction 0.7 × (1 − 0.5) = 0.35 → dealt = 100 × 0.65
    const r = dealDamage(sim, a, t, 100, { ...basic, blockIgnore: 0.5 });
    expect(r.dealt).toBeCloseTo(65, 5);
  });

  it('emits a blocked event when blocked and a hit event otherwise', () => {
    const events: GameEvent[] = [];
    const a = makeFighter(0, 'lion', 0, 2, 0);
    const t = makeFighter(1, 'gorilla', 0, 0, 0);
    const sim = makeSim([a, t], events);
    t.blocking = true;
    dealDamage(sim, a, t, 100, basic);
    t.blocking = false;
    dealDamage(sim, a, t, 100, basic);
    expect(events.some((e) => e.type === 'blocked')).toBe(true);
    expect(events.some((e) => e.type === 'hit')).toBe(true);
  });
});
