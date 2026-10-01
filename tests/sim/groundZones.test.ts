/**
 * Persistent ground zones (v1.3 hippo mud): geometry, growth, expiry, owner immunity, slow refresh/linger and
 * determinism, tested on a bare Sim and on the real World hook.
 */

import { describe, it, expect } from 'vitest';
import { makeFighter, makeSim, liveWorld, DT } from './helpers';
import { GroundZoneSystem, spawnGroundZone, zoneExtent, zoneOverlaps, type GroundZoneSpec } from '../../src/sim/groundZones';
import { addBuff, getBuff, tickBuffs } from '../../src/sim/StatusEffects';
import type { Sim } from '../../src/sim/Fighter';

const POOL: GroundZoneSpec = { kind: 'mud', ownerId: 0, ax: 0, az: 0, dx: 0, dz: 1, len: 10, halfWidth: 1.7, growS: 1, lifeS: 4, slow: 0.4, ownerSlow: 0, slowLingerS: 0.3 };

function simWith(zs: GroundZoneSystem, ...animals: ('hippo' | 'lion' | 'eagle')[]): { sim: Sim & { groundZones: GroundZoneSystem }; fs: ReturnType<typeof makeFighter>[] } {
  const fs = animals.map((a, i) => makeFighter(i, a, 0, 5, 0));
  const sim = makeSim(fs) as Sim & { groundZones: GroundZoneSystem };
  (sim as unknown as { groundZones: GroundZoneSystem }).groundZones = zs;
  return { sim, fs };
}

/** One sim tick as World does it: buffs first, then the zones. */
function tick(sim: Sim & { groundZones: GroundZoneSystem }, dt = DT): void {
  for (const f of sim.fighters) tickBuffs(sim, f, dt);
  sim.groundZones.update(sim, dt);
}

describe('groundZones — geometry', () => {
  it('normalises the direction, grows along the path and tests body circles against the laid rectangle', () => {
    const zs = new GroundZoneSystem();
    zs.spawn({ ...POOL, dx: 0, dz: 3 });
    const z = zs.list[0];
    expect(z.dz).toBeCloseTo(1, 9);
    expect(zoneExtent(z)).toBe(0);
    z.age = 0.5;
    expect(zoneExtent(z)).toBeCloseTo(5, 9);
    expect(zoneOverlaps(z, 0, 4, 0.5)).toBe(true);
    expect(zoneOverlaps(z, 0, 6, 0.5)).toBe(false); // not laid yet
    expect(zoneOverlaps(z, 1.7 + 0.4, 2, 0.5)).toBe(true); // body reaches the edge
    expect(zoneOverlaps(z, 1.7 + 0.6, 2, 0.5)).toBe(false);
    expect(zoneOverlaps(z, 0, -0.4, 0.5)).toBe(true); // a body overlapping the start
    expect(zoneOverlaps(z, 0, -0.6, 0.5)).toBe(false);
    z.age = 1;
    expect(zoneOverlaps(z, 0, 10.4, 0.5)).toBe(true);
    expect(zoneOverlaps(z, 0, 10.6, 0.5)).toBe(false);
    expect(zs.zonesAt(0, 9, 0.5)).toHaveLength(1);
    expect(zs.zonesAt(0, 9, 0.5, 'mud')).toHaveLength(1);
  });

  it('an instant zone (growS 0) is fully laid at once', () => {
    const zs = new GroundZoneSystem();
    zs.spawn({ ...POOL, growS: 0 });
    expect(zoneExtent(zs.list[0])).toBe(10);
  });
});

describe('groundZones — slow, owner, altitude', () => {
  it('slows everyone but the owner (ownerSlow 0); the owner may be given a weaker slow', () => {
    const zs = new GroundZoneSystem();
    const { sim, fs } = simWith(zs, 'hippo', 'lion');
    fs[0].state.pos = { x: 0, y: 0, z: 2 };
    fs[1].state.pos = { x: 0, y: 0, z: 4 };
    zs.spawn({ ...POOL, growS: 0 });
    tick(sim);
    expect(getBuff(fs[0], 'slow')).toBeUndefined();
    expect(getBuff(fs[1], 'slow')?.mag).toBeCloseTo(0.4, 9);
    zs.clear();
    zs.spawn({ ...POOL, growS: 0, ownerSlow: 0.2 });
    tick(sim);
    expect(getBuff(fs[0], 'slow')?.mag).toBeCloseTo(0.2, 9);
  });

  it('only fighters low enough are slowed, and dead / untargetable ones are skipped', () => {
    const zs = new GroundZoneSystem();
    const { sim, fs } = simWith(zs, 'hippo', 'lion', 'eagle');
    zs.spawn({ ...POOL, growS: 0 });
    fs[1].state.pos = { x: 0, y: 1.0, z: 6 }; // jumping above 0.6 m
    fs[2].state.pos = { x: 0.5, y: 0, z: 6 };
    fs[2].untargetable = true; // burrowed / soaring
    tick(sim);
    expect(getBuff(fs[1], 'slow')).toBeUndefined();
    expect(getBuff(fs[2], 'slow')).toBeUndefined();
    fs[2].untargetable = false;
    fs[2].state.alive = false;
    tick(sim);
    expect(getBuff(fs[2], 'slow')).toBeUndefined();
  });

  it('refreshes the buff each tick, lets it linger, and never weakens a stronger slow', () => {
    const zs = new GroundZoneSystem();
    const { sim, fs } = simWith(zs, 'hippo', 'lion');
    fs[1].state.pos = { x: 0, y: 0, z: 4 };
    zs.spawn({ ...POOL, growS: 0 });
    for (let i = 0; i < 30; i++) tick(sim);
    expect(getBuff(fs[1], 'slow')?.t).toBeLessThan(0.05); // refreshed, not aging out
    fs[1].state.pos = { x: 10, y: 0, z: 4 };
    for (let i = 0; i < 10; i++) tick(sim); // 0.17 s: still clinging
    expect(getBuff(fs[1], 'slow')).toBeDefined();
    for (let i = 0; i < 12; i++) tick(sim); // past 0.3 s
    expect(getBuff(fs[1], 'slow')).toBeUndefined();
    addBuff(fs[1], 'slow', 0.7, 2);
    fs[1].state.pos = { x: 0, y: 0, z: 4 };
    tick(sim);
    expect(getBuff(fs[1], 'slow')?.mag).toBeCloseTo(0.7, 9);
  });
});

describe('groundZones — lifetime and determinism', () => {
  it('expires at lifeS and is compacted out of the list (order preserved)', () => {
    const zs = new GroundZoneSystem();
    const { sim } = simWith(zs, 'hippo', 'lion');
    const a = zs.spawn({ ...POOL, lifeS: 1 });
    const b = zs.spawn({ ...POOL, lifeS: 2 });
    const c = zs.spawn({ ...POOL, lifeS: 3 });
    for (let i = 0; i < 61; i++) tick(sim);
    expect(zs.list.map((z) => z.id)).toEqual([b, c]);
    for (let i = 0; i < 60; i++) tick(sim);
    expect(zs.list.map((z) => z.id)).toEqual([c]);
    for (let i = 0; i < 60; i++) tick(sim);
    expect(zs.count).toBe(0);
    expect(a).toBe(0);
  });

  it('spawnGroundZone is a harmless no-op on a Sim without the system', () => {
    const sim = makeSim([makeFighter(0, 'hippo', 0, 0)]);
    expect(spawnGroundZone(sim, POOL)).toBe(-1);
  });

  it('World owns the system, ticks it, and two identical runs agree', () => {
    const run = (): string => {
      const { world } = liveWorld(['hippo', 'lion'], 5);
      expect(world.groundZones).toBeDefined();
      world.fighters[1].state.pos = { x: 0, y: 0, z: 5 };
      world.groundZones.spawn({ ...POOL, growS: 0.5, lifeS: 2 });
      const out: string[] = [];
      for (let i = 0; i < 180; i++) {
        world.step(DT);
        out.push(`${world.groundZones.count}:${getBuff(world.fighters[1], 'slow')?.mag ?? 0}:${world.fighters[1].state.pos.z.toFixed(4)}`);
      }
      return out.join('|');
    };
    const a = run();
    expect(a).toBe(run());
    expect(a.startsWith('1:')).toBe(true);
    expect(a.endsWith('0:0:5.0000')).toBe(true);
  });
});
