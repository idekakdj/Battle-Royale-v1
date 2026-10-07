/**
 * v1.8 WP-J2: the anti hop-chain rule (`TERRAIN.wetJumpMult`). A held-jump spam used to cross the pool in about half the walking time
 * (70 % of a normal 1.2 m hop is above the 0.6 m grounded line, where terrain does not slow), so a jump out of water / moss is now a
 * small hop whose apex stays below the grounded line. Off terrain the jump is exactly the old one (colosseum identity).
 */

import { describe, it, expect } from 'vitest';
import { liveWorld } from './helpers';
import { MOVE } from '../../src/config/balance';
import { TERRAIN } from '../../src/config/terrain';
import { COLOSSEUM_ARENA, JUNGLE_ARENA as J } from '../../src/config/arenas';
import { ANIMAL_IDS } from '../../src/config/animals';
import type { AnimalId, FighterIntent } from '../../src/core/types';

const DT = 1 / 60;
const POOL = J.terrain.find((z) => z.kind === 'water')!;
const MOSS = J.terrain.find((z) => z.kind === 'moss' && z.x === 6.8)!; // (6.8, -22.4) r 3.4: nothing else near it

function intent(over: Partial<FighterIntent>): FighterIntent {
  return { moveX: 0, moveZ: 0, aimYaw: 0, attack: false, block: false, special: false, ultimate: false, jump: false, ...over };
}

/** Time (s) to run `dist` metres along +x from `x0` at z, walking or tapping jump every 0.72 s. */
function runTime(animal: AnimalId, x0: number, z: number, x1: number, hop: boolean): number {
  const { world } = liveWorld([animal, 'lion'], 3, [], { arena: 'jungle' });
  const f = world.fighters[0];
  world.fighters[1].state.pos = { x: -28, y: 0, z: -2 };
  f.state.pos = { x: x0, y: 0, z };
  let t = 0;
  for (let i = 0; i < 60 * 30; i++) {
    world.setIntent(0, intent({ moveX: 1, aimYaw: Math.PI / 2, jump: hop && (t % 0.72) / 0.72 < 0.08 }));
    world.setIntent(1, intent({}));
    world.step(DT);
    t += DT;
    if (f.state.pos.x >= x1) return t;
  }
  return Infinity;
}

describe('wet jump: no hop-chaining through slow terrain', () => {
  it('the wet launch apex stays below the grounded line, the dry one does not', () => {
    const apex = (v: number): number => (v * v) / (2 * MOVE.gravity);
    expect(apex(MOVE.jumpVelocity * TERRAIN.wetJumpMult)).toBeLessThan(TERRAIN.groundedAlt);
    expect(apex(MOVE.jumpVelocity)).toBeGreaterThan(TERRAIN.groundedAlt);
    expect(TERRAIN.wetJumpMult).toBeGreaterThan(0.3);
    expect(TERRAIN.wetJumpMult).toBeLessThan(1);
  });

  it('a jump launched in the pool or on moss is the small hop; a jump on dry ground is unchanged', () => {
    for (const where of ['water', 'moss', 'dry'] as const) {
      const { world } = liveWorld(['lion', 'giraffe'], 3, [], { arena: 'jungle' });
      const f = world.fighters[0];
      world.fighters[1].state.pos = { x: -28, y: 0, z: -2 };
      f.state.pos = where === 'water' ? { x: 0, y: 0, z: 0 } : where === 'moss' ? { x: MOSS.x, y: 0, z: MOSS.z } : { x: -15, y: 0, z: 15 };
      world.setIntent(0, intent({}));
      world.step(DT * 3);
      expect(f.terrainSpeedMult < 1, where).toBe(where !== 'dry');
      world.setIntent(0, intent({ jump: true }));
      let peak = 0;
      for (let i = 0; i < 70; i++) {
        world.step(DT);
        peak = Math.max(peak, f.state.pos.y);
      }
      if (where === 'dry') expect(peak).toBeGreaterThan(1.1);
      else {
        expect(peak, where).toBeLessThan(TERRAIN.groundedAlt);
        expect(peak, where).toBeGreaterThan(0.2);
      }
    }
  });

  it('hop-spamming across the pool gains almost nothing over walking (every non-flying animal, <= 1.2x)', () => {
    for (const a of ANIMAL_IDS as readonly AnimalId[]) {
      if (a === 'eagle') continue;
      // start 1.5 m outside the pool on the clear +x side, end 1.5 m past the far rim: 16 m with 13 m of water
      const x0 = POOL.x - POOL.radius - 1.5;
      const x1 = POOL.x + POOL.radius + 1.5;
      // the west side has a trunk at (-9.5,-0.3): run along z = 4 instead (clear of trunks, logs and moss)
      const walk = runTime(a, x0, 4, x1, false);
      const hop = runTime(a, x0, 4, x1, true);
      expect(walk, a).toBeLessThan(40);
      expect(hop, a).toBeGreaterThan(walk / 1.2);
    }
  });

  it('hop-spamming over a moss patch gains little too (<= 1.15x)', () => {
    for (const a of ['lion', 'giraffe', 'mole', 'rhino'] as AnimalId[]) {
      const walk = runTime(a, MOSS.x - MOSS.radius - 3, MOSS.z, MOSS.x + MOSS.radius + 3, false);
      const hop = runTime(a, MOSS.x - MOSS.radius - 3, MOSS.z, MOSS.x + MOSS.radius + 3, true);
      expect(hop, a).toBeGreaterThan(walk / 1.15);
    }
  });

  it('the colosseum jump is untouched (full launch speed, 1.2 m apex)', () => {
    const { world } = liveWorld(['lion', 'giraffe'], 3, []);
    expect(world.arena).toBe(COLOSSEUM_ARENA);
    const f = world.fighters[0];
    world.fighters[1].state.pos = { x: -20, y: 0, z: 5 };
    f.state.pos = { x: 5, y: 0, z: 5 };
    world.setIntent(0, intent({ jump: true }));
    let peak = 0;
    for (let i = 0; i < 70; i++) {
      world.step(DT);
      peak = Math.max(peak, f.state.pos.y);
    }
    expect(peak).toBeGreaterThan(1.15);
    expect(peak).toBeLessThan(1.3);
  });
});
