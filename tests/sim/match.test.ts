import { describe, it, expect } from 'vitest';
import { World } from '../../src/sim/World';
import { EventBus } from '../../src/core/EventBus';
import { ANIMAL_IDS } from '../../src/config/animals';
import type { AnimalId, GameEvent, MatchConfig } from '../../src/core/types';
import { liveWorld, DT } from './helpers';

const ROSTER = ANIMAL_IDS as AnimalId[];

describe('countdown exposure (integration note)', () => {
  it('reports negative time during the frozen countdown, ≥0 after FIGHT', () => {
    const cfg: MatchConfig = { roster: ROSTER.map((a, i) => ({ animal: a, isPlayer: i === 0 })), difficulty: 1 };
    const world = new World(cfg, 1, new EventBus());
    expect(world.snapshot().time).toBeCloseTo(-3, 2);
    expect(world.countdown).toBeCloseTo(3, 2);
    for (let i = 0; i < 60; i++) world.step(DT); // 1 s of countdown
    expect(world.snapshot().time).toBeLessThan(0);
    for (let i = 0; i < 150; i++) world.step(DT); // past 3 s total
    expect(world.snapshot().time).toBeGreaterThanOrEqual(0);
  });
});

describe("Crowd's Bloodlust ramp (§6)", () => {
  it('is ×1.25 at 120 s and ×1.5 at 150 s', () => {
    const { world } = liveWorld(ROSTER, 1);
    while (world.snapshot().time < 120) world.step(DT);
    expect(world.snapshot().bloodlustMult).toBeCloseTo(1.25, 5);
    while (world.snapshot().time < 150) world.step(DT);
    expect(world.snapshot().bloodlustMult).toBeCloseTo(1.5, 5);
  });
});

describe('deaths, placements & win (§6)', () => {
  it('assigns 10th to the first death down to the winner and emits matchEnd', () => {
    const events: GameEvent[] = [];
    const { world } = liveWorld(ROSTER, 1, events);
    const placements: number[] = [];
    world.bus.on('death', (e) => placements.push(e.placement));

    // Credit fighter 0 with the first kill, then eliminate 1..9 in order.
    world.fighters[1].lastAttackerId = 0;
    for (let k = 1; k <= 9; k++) {
      world.fighters[k].state.hp = 0;
      world.step(DT);
    }
    expect(placements).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2]);
    expect(world.fighters[0].state.kills).toBe(1);
    expect(world.snapshot().matchOver).toBe(true);
    expect(world.snapshot().winnerId).toBe(0);
    expect(events.some((e) => e.type === 'matchEnd')).toBe(true);
  });
});
