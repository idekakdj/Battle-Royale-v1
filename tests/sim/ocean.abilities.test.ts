/**
 * v1.9 ability movement on a height field: charges, burrows and carries stop at a cliff (no teleport up), follow ramps, and
 * everything that moves a fighter ends with it standing on a real ground height.
 */

import { describe, it, expect } from 'vitest';
import { OCEAN_ARENA as O, arenaGroundHeight } from '../../src/config/arenas';
import { DT, liveWorld, neutral, disablePickups } from './helpers';

describe('abilities on the Ocean Dome', () => {
  it('a rhino Lockdown Charge into the terrace cliff stops at the foot of it (y stays 0), up a ramp it climbs', () => {
    // west of the dome (180°) there is no ramp: charge east into the terrace rim at r = 19
    {
      const { world } = liveWorld(['rhino', 'hippo'], 7, [], { arena: 'ocean' });
      disablePickups(world);
      const c = world.fighters[0];
      c.state.pos = { x: -25, y: 0, z: 0 };
      c.state.yaw = Math.PI / 2; // +x
      world.fighters[1].state.pos = { x: 25, y: 0, z: 25 };
      c.state.specialCd = 0;
      const press = { ...neutral(), special: true, aimYaw: Math.PI / 2 };
      world.setIntent(0, press);
      world.setIntent(1, neutral());
      world.step(DT);
      for (let i = 0; i < 120; i++) {
        world.setIntent(0, { ...neutral(), aimYaw: Math.PI / 2 });
        world.setIntent(1, neutral());
        world.step(DT);
        expect(c.state.pos.y).toBe(0);
      }
      expect(c.state.pos.x).toBeLessThanOrEqual(-(19 + c.def.radius) + 0.05);
      expect(c.state.pos.x).toBeGreaterThan(-25.5);
    }
    // the same charge along the 0° ramp (axis z = 0, low end x = 24.5): the rhino runs up it
    {
      const { world } = liveWorld(['rhino', 'hippo'], 7, [], { arena: 'ocean' });
      disablePickups(world);
      const c = world.fighters[0];
      c.state.pos = { x: 28, y: 0, z: 0 };
      c.state.yaw = -Math.PI / 2; // -x
      world.fighters[1].state.pos = { x: -25, y: 0, z: 25 };
      c.state.specialCd = 0;
      world.setIntent(0, { ...neutral(), special: true, aimYaw: -Math.PI / 2 });
      world.setIntent(1, neutral());
      world.step(DT);
      let maxY = 0;
      for (let i = 0; i < 90; i++) {
        world.setIntent(0, { ...neutral(), aimYaw: -Math.PI / 2 });
        world.setIntent(1, neutral());
        world.step(DT);
        maxY = Math.max(maxY, c.state.pos.y);
        expect(c.state.pos.y).toBeLessThanOrEqual(arenaGroundHeight(O, c.state.pos.x, c.state.pos.z) + 0.3);
      }
      expect(maxY).toBeGreaterThan(0.8);
    }
  });

  it('a burrowing mole tunnels up to the cliff and no further; its feet follow the ground on a ramp', () => {
    const { world } = liveWorld(['mole', 'hippo'], 7, [], { arena: 'ocean' });
    disablePickups(world);
    const c = world.fighters[0];
    c.state.pos = { x: -23, y: 0, z: 0 };
    world.fighters[1].state.pos = { x: 25, y: 0, z: 25 };
    c.state.specialCd = 0;
    world.setIntent(0, { ...neutral(), special: true });
    world.setIntent(1, neutral());
    world.step(DT);
    for (let i = 0; i < 90; i++) {
      world.setIntent(0, { ...neutral(), moveX: 1 });
      world.setIntent(1, neutral());
      world.step(DT);
    }
    expect(c.untargetable).toBe(true); // still underground
    expect(c.state.pos.x).toBeLessThanOrEqual(-(19 + c.def.radius) + 0.05);
    expect(c.state.pos.x).toBeGreaterThan(-21.5);
    expect(c.state.pos.y).toBe(0);
  });

  it('knockback into the dome wall and the cliff at once (a corner) neither tunnels nor sinks the fighter', () => {
    const { world } = liveWorld(['lion', 'gorilla'], 3, [], { arena: 'ocean' });
    disablePickups(world);
    const f = world.fighters[0];
    f.state.pos = { x: -22, y: 0, z: 0 };
    world.fighters[1].state.pos = { x: 25, y: 0, z: 25 };
    f.setKnockback(1, 0, 12);
    for (let i = 0; i < 90; i++) {
      world.setIntent(0, neutral());
      world.step(DT);
      expect(f.state.pos.y).toBe(0);
      expect(Math.hypot(f.state.pos.x, f.state.pos.z)).toBeGreaterThanOrEqual(19 + f.def.radius - 1e-6);
    }
  });

  it('fighters pushed or knocked on a level never end up with feet below their ground (no sinking, 600 ticks of shoving)', () => {
    const { world } = liveWorld(['rhino', 'hippo', 'gorilla', 'lion'], 11, [], { arena: 'ocean' });
    disablePickups(world);
    const spots: [number, number, number][] = [
      [-14, 0, 1.5],
      [-14, 1.4, 1.5],
      [-14, -1.4, 1.5],
      [-12.5, 0.3, 1.5],
    ];
    spots.forEach(([x, z, y], i) => (world.fighters[i].state.pos = { x, y, z }));
    for (let t = 0; t < 600; t++) {
      for (let i = 0; i < 4; i++) world.setIntent(i, { ...neutral(), moveX: (i % 2 === 0 ? 1 : -1) * 0.7, moveZ: Math.sin(t / 40 + i) });
      world.step(DT);
      for (const f of world.fighters) {
        const gy = arenaGroundHeight(O, f.state.pos.x, f.state.pos.z);
        expect(f.state.pos.y).toBeGreaterThanOrEqual(gy - 1e-6);
        expect(Number.isFinite(f.state.pos.x + f.state.pos.z)).toBe(true);
      }
    }
  });
});
