import { describe, it, expect } from 'vitest';
import { dealDamage, updateGuard, setBlocking } from '../../src/sim/CombatSystem';
import { makeFighter, makeSim, DT } from './helpers';
import type { GameEvent } from '../../src/core/types';
import type { DamageOpts } from '../../src/sim/CombatSystem';

const basic: DamageOpts = { blockable: true, heavy: false, reaction: 'none', isBasic: true };

describe('guard break flow (§7.4)', () => {
  it('breaks at 0 guard → stagger + refill to 50% after the stagger', () => {
    const events: GameEvent[] = [];
    const a = makeFighter(0, 'lion', 0, 2, 0);
    const t = makeFighter(1, 'gorilla', 0, 0, 0);
    const sim = makeSim([a, t], events);
    t.blocking = true;
    t.state.guard = 10; // will be drained past 0
    dealDamage(sim, a, t, 100, basic);
    expect(events.some((e) => e.type === 'guardBreak')).toBe(true);
    expect(t.state.guard).toBe(0);
    expect(t.staggerTimer).toBeGreaterThan(1.4);
    expect(t.guardBreakRefillPending).toBe(true);

    t.staggerTimer = 0; // simulate the stagger ending
    updateGuard(t, DT);
    expect(t.state.guard).toBeCloseTo(t.state.maxGuard * 0.5, 5);
  });
});

describe('block perks (§7.4)', () => {
  it('rhino thorns damage a melee attacker who hits the block', () => {
    const a = makeFighter(0, 'lion', 0, 2, 0);
    const t = makeFighter(1, 'rhino', 0, 0, 0);
    const sim = makeSim([a, t]);
    t.blocking = true;
    dealDamage(sim, a, t, 80, basic);
    expect(a.state.hp).toBeCloseTo(1000 - 15, 5);
  });

  it('python stores a tension stack on a blocked hit', () => {
    const a = makeFighter(0, 'lion', 0, 2, 0);
    const t = makeFighter(1, 'python', 0, 0, 0);
    const sim = makeSim([a, t]);
    t.blocking = true;
    dealDamage(sim, a, t, 80, basic);
    expect(t.pythonTension).toBe(true);
  });

  it('panther perfect block auto-counters for 60', () => {
    const a = makeFighter(0, 'gorilla', 0, 2, 0);
    const t = makeFighter(1, 'panther', 0, 0, 0);
    const sim = makeSim([a, t]);
    sim.time = 0.1;
    t.blocking = true;
    t.blockStartTime = 0.0; // 0.1 s ago ≤ 0.2 s window
    dealDamage(sim, a, t, 40, basic);
    expect(a.state.hp).toBeCloseTo(1100 - 60, 5);
  });

  it('gorilla release-shove hits a frontal victim for 30', () => {
    const g = makeFighter(0, 'gorilla', 0, 0, 0);
    const victim = makeFighter(1, 'lion', 0, 2, 0);
    const sim = makeSim([g, victim]);
    g.intent.aimYaw = 0;
    setBlocking(sim, g, true);
    g.lastBlockedHitTime = sim.time; // just blocked a hit
    sim.time = 0.1; // release within 0.25 s
    setBlocking(sim, g, false);
    expect(victim.state.hp).toBeCloseTo(1000 - 30, 5);
  });

  it('mole gains +15% reduction while blocking stationary', () => {
    const a = makeFighter(0, 'lion', 0, 2, 0);
    const t = makeFighter(1, 'mole', 0, 0, 0);
    const sim = makeSim([a, t]);
    t.blocking = true; // velocity is zero → stationary
    // reduction 0.5 + 0.15 = 0.65 → dealt = 100 × 0.35
    expect(dealDamage(sim, a, t, 100, basic).dealt).toBeCloseTo(35, 5);
  });
});
