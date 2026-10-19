/**
 * v1.9 ability movement on a height field: charges, burrows and carries stop at a cliff (no teleport up), follow ramps, and
 * everything that moves a fighter ends with it standing on a real ground height.
 */

import { describe, it, expect } from 'vitest';
import { OCEAN_ARENA as O, arenaGroundHeight } from '../../src/config/arenas';
import { DT, liveWorld, neutral, disablePickups } from './helpers';

/**
 * v1.10: the west axis of the v1.9 tests is a sea-stack now. These tests use the PLAIN RAY (308 degrees: seabed -> terrace rim at r = 19 and
 * terrace -> plateau rim at r = 8 with no ramp, tower or cover on the way; asserted in tests/config/ocean.layout.test.ts). 'inward' = toward the centre.
 */
const TH = (308 * Math.PI) / 180;
const U = { x: Math.cos(TH), z: Math.sin(TH) };
const at = (r: number) => ({ x: U.x * r, z: U.z * r });
const YAW_IN = Math.atan2(-U.x, -U.z); // direction (sin yaw, cos yaw)
const radial = (p: { x: number; z: number }): number => Math.hypot(p.x, p.z);

describe('abilities on the Ocean Dome', () => {
  it('a rhino Lockdown Charge into the terrace cliff stops at the foot of it (y stays 0), up a ramp it climbs', () => {
    // on the plain ray (308°) there is no ramp: charge inward into the terrace rim at r = 19
    {
      const { world } = liveWorld(['rhino', 'hippo'], 7, [], { arena: 'ocean' });
      disablePickups(world);
      const c = world.fighters[0];
      c.state.pos = { ...at(25), y: 0 };
      c.state.yaw = YAW_IN;
      world.fighters[1].state.pos = { x: 25, y: 0, z: 25 };
      c.state.specialCd = 0;
      const press = { ...neutral(), special: true, aimYaw: YAW_IN };
      world.setIntent(0, press);
      world.setIntent(1, neutral());
      world.step(DT);
      for (let i = 0; i < 120; i++) {
        world.setIntent(0, { ...neutral(), aimYaw: YAW_IN });
        world.setIntent(1, neutral());
        world.step(DT);
        expect(c.state.pos.y).toBe(0);
      }
      expect(radial(c.state.pos)).toBeGreaterThanOrEqual(19 + c.def.radius - 0.05);
      expect(radial(c.state.pos)).toBeLessThan(25.5);
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
    c.state.pos = { ...at(23), y: 0 };
    world.fighters[1].state.pos = { x: 25, y: 0, z: 25 };
    c.state.specialCd = 0;
    world.setIntent(0, { ...neutral(), special: true });
    world.setIntent(1, neutral());
    world.step(DT);
    for (let i = 0; i < 90; i++) {
      world.setIntent(0, { ...neutral(), moveX: -U.x, moveZ: -U.z });
      world.setIntent(1, neutral());
      world.step(DT);
    }
    expect(c.untargetable).toBe(true); // still underground
    expect(radial(c.state.pos)).toBeGreaterThanOrEqual(19 + c.def.radius - 0.05);
    expect(radial(c.state.pos)).toBeLessThan(21.5);
    expect(c.state.pos.y).toBe(0);
  });

  it('knockback into the dome wall and the cliff at once (a corner) neither tunnels nor sinks the fighter', () => {
    const { world } = liveWorld(['lion', 'gorilla'], 3, [], { arena: 'ocean' });
    disablePickups(world);
    const f = world.fighters[0];
    f.state.pos = { ...at(22), y: 0 };
    world.fighters[1].state.pos = { x: 25, y: 0, z: 25 };
    f.setKnockback(-U.x, -U.z, 12);
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
    // four fighters shoved around on the terrace, next to its pad in the big south-east pocket
    const pad = O.pickupPads.find((p) => arenaGroundHeight(O, p.x, p.z) === 1.5) as { x: number; z: number };
    const spots: [number, number, number][] = [
      [pad.x, pad.z, 1.5],
      [pad.x, pad.z + 1.4, 1.5],
      [pad.x, pad.z - 1.4, 1.5],
      [pad.x + 1.5, pad.z + 0.3, 1.5],
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
