import { describe, it, expect } from 'vitest';
import { locomote, resolveObstacles, clampToWall } from '../../src/sim/MovementSystem';
import { makeFighter, makeSim, DT } from './helpers';
import { PILLARS, WALL_RADIUS } from '../../src/config/arena';

describe('movement & collision (§7.8)', () => {
  it('clamps a fighter inside the arena wall', () => {
    const f = makeFighter(0, 'lion', 100, 0, 0);
    clampToWall(f);
    expect(Math.hypot(f.state.pos.x, f.state.pos.z)).toBeCloseTo(WALL_RADIUS - f.def.radius, 4);
  });

  it('stops a knockback impulse at the wall', () => {
    const f = makeFighter(0, 'lion', 29, 0, 0);
    const sim = makeSim([f]);
    f.setKnockback(1, 0, 10); // 10 m outward, but the wall is at 30
    for (let i = 0; i < 30; i++) locomote(sim, f, DT);
    expect(f.state.pos.x).toBeLessThanOrEqual(WALL_RADIUS - f.def.radius + 1e-4);
  });

  it('accelerates toward an intent direction', () => {
    const f = makeFighter(0, 'lion', 0, 0, 0);
    const sim = makeSim([f]);
    f.intent.moveZ = 1;
    for (let i = 0; i < 60; i++) locomote(sim, f, DT);
    expect(f.state.pos.z).toBeGreaterThan(1);
    expect(f.state.vel.z).toBeGreaterThan(0);
  });

  it('pushes a fighter out of a pillar', () => {
    const pillar = PILLARS[0];
    const f = makeFighter(0, 'lion', pillar.x, pillar.z, 0);
    const sim = makeSim([f], [], [pillar]);
    resolveObstacles(sim, f, false);
    const d = Math.hypot(f.state.pos.x - pillar.x, f.state.pos.z - pillar.z);
    expect(d).toBeGreaterThanOrEqual(pillar.radius + f.def.radius - 1e-3);
  });
});
