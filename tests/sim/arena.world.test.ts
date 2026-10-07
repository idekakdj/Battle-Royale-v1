/**
 * v1.8 arena plumbing through the sim: World carries `arena` (default colosseum) and every module reads walls,
 * colliders, crates, pads, spawns, ground height and trap placement from it — never from the module constants.
 */

import { describe, it, expect } from 'vitest';
import { World } from '../../src/sim/World';
import { EventBus } from '../../src/core/EventBus';
import { ANIMALS } from '../../src/config/animals';
import { COLOSSEUM_ARENA, JUNGLE_ARENA, spawnPositions } from '../../src/config/arenas';
import { PICKUP_PADS, PILLARS } from '../../src/config/arena';
import { clampToWall, groundHeightAt, resolveObstacles } from '../../src/sim/MovementSystem';
import { ProjectileSystem, spawnProjectile } from '../../src/sim/projectiles';
import { dirToYaw } from '../../src/core/math';
import type { AnimalId, GameEvent, MatchConfig } from '../../src/core/types';
import { DT, liveWorld, makeFighter, makeSim, neutral, disablePickups } from './helpers';

const TEN: AnimalId[] = ['lion', 'gorilla', 'crocodile', 'hippo', 'rhino', 'eagle', 'panther', 'python', 'giraffe', 'mole'];

function worldOn(arena: 'colosseum' | 'jungle' | undefined, animals: AnimalId[] = TEN, difficulty: 1 | 2 | 3 | 4 = 1, traps = false): World {
  const cfg: MatchConfig = { roster: animals.map((a, i) => ({ animal: a, isPlayer: i === 0 })), difficulty, arena };
  return new World(cfg, 42, new EventBus(), { traps });
}

describe('World arena selection', () => {
  it('defaults to the colosseum (no cfg.arena, or "colosseum")', () => {
    for (const a of [undefined, 'colosseum' as const]) {
      const w = worldOn(a);
      expect(w.arena).toBe(COLOSSEUM_ARENA);
      expect(w.staticObstacles).toHaveLength(PILLARS.length + 2);
      expect(w.crates).toHaveLength(12);
      for (const f of w.fighters) expect(f.arena).toBe(COLOSSEUM_ARENA);
    }
  });

  it('cfg.arena = "jungle" switches colliders, crates, pads and spawns to the jungle def', () => {
    const w = worldOn('jungle');
    expect(w.arena).toBe(JUNGLE_ARENA);
    expect(w.staticObstacles).toHaveLength(14 + 4);
    expect(w.staticObstacles.filter((o) => o.shape === 'circle')).toHaveLength(14);
    expect(w.staticObstacles.filter((o) => o.shape === 'segment')).toHaveLength(4);
    expect(w.crates).toHaveLength(12);
    expect(w.crates.map((c) => [c.x, c.z])).toEqual(JUNGLE_ARENA.crates.map((c) => [c.x, c.z]));
    const snap = w.snapshot();
    expect(snap.pickups.map((p) => [p.pos.x, p.pos.z])).toEqual(JUNGLE_ARENA.pickupPads.map((p) => [p.x, p.z]));
    for (const f of w.fighters) expect(f.arena).toBe(JUNGLE_ARENA);
  });

  it('colosseum pickups and spawns are unchanged; jungle fighters spawn on the jungle seats facing the centre', () => {
    const col = worldOn(undefined).snapshot();
    expect(col.pickups.map((p) => [p.pos.x, p.pos.z])).toEqual(PICKUP_PADS.map((p) => [p.x, p.z]));
    const spawns = spawnPositions(COLOSSEUM_ARENA, 10);
    col.fighters.forEach((f, i) => {
      expect(f.pos.x).toBe(spawns[i].x);
      expect(f.pos.z).toBe(spawns[i].z);
      expect(f.pos.y).toBe(0);
    });

    const jun = worldOn('jungle').snapshot();
    jun.fighters.forEach((f, i) => {
      expect(f.pos.x).toBe(JUNGLE_ARENA.spawns[i].x);
      expect(f.pos.z).toBe(JUNGLE_ARENA.spawns[i].z);
      expect(f.pos.y).toBe(0);
      expect(f.yaw).toBeCloseTo(dirToYaw(-f.pos.x, -f.pos.z), 9);
    });
  });

  it('a smaller roster on the jungle sits on evenly spaced seats', () => {
    const w = worldOn('jungle', ['lion', 'hippo']);
    expect([w.fighters[0].state.pos.x, w.fighters[0].state.pos.z]).toEqual([JUNGLE_ARENA.spawns[0].x, JUNGLE_ARENA.spawns[0].z]);
    expect([w.fighters[1].state.pos.x, w.fighters[1].state.pos.z]).toEqual([JUNGLE_ARENA.spawns[5].x, JUNGLE_ARENA.spawns[5].z]);
  });

  it('the Sim handed to systems exposes the arena (World and the test helper Sim)', () => {
    expect(worldOn('jungle').arena.id).toBe('jungle');
    expect(makeSim([makeFighter(0, 'lion', 0, 0)]).arena).toBe(COLOSSEUM_ARENA);
  });
});

describe('ground height and the dais', () => {
  it('colosseum: the dais lifts fighters at the centre; jungle: flat ground, no dais', () => {
    const col = worldOn(undefined, ['lion', 'hippo']);
    expect(groundHeightAt(0, 0, col.arena)).toBeCloseTo(0.6, 9);
    const jun = worldOn('jungle', ['lion', 'hippo']);
    expect(groundHeightAt(0, 0, jun.arena)).toBe(0);
    // a fighter dropped at the jungle centre stays at y = 0 (no 0.6 m hump in the pool)
    const f = jun.fighters[0];
    f.state.pos = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 200; i++) jun.step(DT);
    expect(f.state.pos.y).toBe(0);
    const f2 = col.fighters[0];
    f2.state.pos = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 200; i++) col.step(DT);
    expect(f2.state.pos.y).toBeCloseTo(0.6, 6);
  });
});

describe('wall clamp reads the arena', () => {
  it('clampToWall uses the fighter\'s arena wall radius', () => {
    const f = makeFighter(0, 'lion', 29.9, 0);
    expect(clampToWall(f)).toBe(true);
    expect(Math.hypot(f.state.pos.x, f.state.pos.z)).toBeCloseTo(JUNGLE_ARENA.wallRadius - f.def.radius, 6);
  });

  it('a World fighter shoved through the jungle wall is clamped back inside', () => {
    const { world } = liveWorld(['lion', 'hippo'], 3, [], { arena: 'jungle' });
    const f = world.fighters[0];
    f.state.pos = { x: 40, y: 0, z: 0 };
    world.step(DT);
    expect(Math.hypot(f.state.pos.x, f.state.pos.z)).toBeLessThanOrEqual(30 - f.def.radius + 1e-6);
  });
});

describe('obstacle collisions use the arena (jungle trees and logs)', () => {
  const tree = JUNGLE_ARENA.circles[0];

  it('a grounded fighter inside a tree trunk is pushed out; the colosseum has no tree there', () => {
    const { world } = liveWorld(['hippo', 'lion'], 3, [], { arena: 'jungle' });
    const f = world.fighters[0];
    f.state.pos = { x: tree.x + 0.3, y: 0, z: tree.z };
    resolveObstacles(world, f, false);
    expect(Math.hypot(f.state.pos.x - tree.x, f.state.pos.z - tree.z)).toBeGreaterThanOrEqual(tree.radius + f.def.radius - 1e-6);

    const col = liveWorld(['hippo', 'lion'], 3, [], {}).world;
    const g = col.fighters[0];
    g.state.pos = { x: tree.x + 0.3, y: 0, z: tree.z };
    resolveObstacles(col, g, false);
    expect(g.state.pos.x).toBeCloseTo(tree.x + 0.3, 9); // colosseum: nothing there
  });

  it('the pillar positions of the colosseum are NOT obstacles in the jungle', () => {
    const { world } = liveWorld(['hippo', 'lion'], 3, [], { arena: 'jungle' });
    const f = world.fighters[0];
    f.state.pos = { x: PILLARS[3].x, y: 0, z: PILLARS[3].z }; // (-15, 0)
    const before = { ...f.state.pos };
    resolveObstacles(world, f, false);
    expect(f.state.pos.x).toBeCloseTo(before.x, 9);
    expect(f.state.pos.z).toBeCloseTo(before.z, 9);
  });

  it('trees block flyers too (12 m tall): an eagle at 4 m altitude is still pushed out; burrowing ignores them', () => {
    const { world } = liveWorld(['eagle', 'lion'], 3, [], { arena: 'jungle' });
    const e = world.fighters[0];
    e.state.pos = { x: tree.x + 0.2, y: 4, z: tree.z };
    resolveObstacles(world, e, false);
    expect(Math.hypot(e.state.pos.x - tree.x, e.state.pos.z - tree.z)).toBeGreaterThanOrEqual(tree.radius + e.def.radius - 1e-6);
    const m = world.fighters[1];
    m.state.pos = { x: tree.x + 0.2, y: 0, z: tree.z };
    resolveObstacles(world, m, true); // ignoreObstacles (burrowed mole)
    expect(m.state.pos.x).toBeCloseTo(tree.x + 0.2, 9);
  });

  it('logs are jumpable: blocked on the ground, passable above their 0.9 m top', () => {
    const { world } = liveWorld(['lion', 'gorilla'], 3, [], { arena: 'jungle' });
    const log = JUNGLE_ARENA.segments[0];
    const mx = (log.ax + log.bx) / 2;
    const mz = (log.az + log.bz) / 2;
    const f = world.fighters[0];
    f.state.pos = { x: mx, y: 0, z: mz };
    resolveObstacles(world, f, false);
    const off = Math.hypot(f.state.pos.x - mx, f.state.pos.z - mz);
    expect(off).toBeGreaterThanOrEqual(log.thickness / 2 + f.def.radius - 0.02); // pushed clear of the log
    const g = world.fighters[1];
    g.state.pos = { x: mx, y: 1.2, z: mz };
    resolveObstacles(world, g, false);
    expect(g.state.pos.x).toBeCloseTo(mx, 9); // above the log: not pushed
  });

  it('crates come from the arena: smashing one emits crateBreak at the jungle crate position and removes its collider', () => {
    const events: GameEvent[] = [];
    const { world } = liveWorld(['hippo', 'lion'], 3, events, { arena: 'jungle' });
    const c0 = JUNGLE_ARENA.crates[0];
    const f = world.fighters[0];
    f.state.pos = { x: c0.x + 0.2, y: 0, z: c0.z + 0.2 };
    resolveObstacles(world, f, false);
    expect(Math.abs(f.state.pos.x - c0.x) >= f.def.radius + 0.5 - 1e-6 || Math.abs(f.state.pos.z - c0.z) >= f.def.radius + 0.5 - 1e-6).toBe(true);
    world.damageCrate(world.crates[0], 999);
    const ev = events.find((e) => e.type === 'crateBreak');
    expect(ev).toMatchObject({ type: 'crateBreak', crateId: 0, pos: { x: c0.x, z: c0.z } });
    for (const c of world.crates) world.damageCrate(c, 999); // clear the whole pile
    f.state.pos = { x: c0.x, y: 0, z: c0.z };
    resolveObstacles(world, f, false);
    expect(f.state.pos.x).toBeCloseTo(c0.x, 9); // destroyed: no collision
  });
});

describe('pickups and projectiles use the arena', () => {
  it('standing on a jungle pad collects that pad', () => {
    const events: GameEvent[] = [];
    const { world } = liveWorld(['lion', 'hippo'], 3, events, { arena: 'jungle' });
    const pad = JUNGLE_ARENA.pickupPads[2];
    const f = world.fighters[0];
    f.state.pos = { x: pad.x, y: 0, z: pad.z };
    world.setIntent(0, neutral());
    world.step(DT);
    const pk = events.find((e) => e.type === 'pickup');
    expect(pk).toBeDefined();
    expect(pk).toMatchObject({ type: 'pickup', fighterId: 0, pos: { x: pad.x, z: pad.z } });

    // …and only there: the same fighter far from every pad collects nothing
    events.length = 0;
    f.state.pos = { x: -27, y: 0, z: 0 };
    world.step(DT);
    expect(events.filter((e) => e.type === 'pickup')).toHaveLength(0);
  });

  it('a projectile stops at a jungle tree trunk and at the jungle wall', () => {
    const { world } = liveWorld(['lion', 'hippo'], 3, [], { arena: 'jungle' });
    disablePickups(world);
    world.fighters[0].state.pos = { x: -28, y: 0, z: -28 }; // park out of the way
    world.fighters[1].state.pos = { x: 28, y: 0, z: -28 };
    const tree = JUNGLE_ARENA.circles[1]; // (-9.5, -0.3) r 1.5
    const hits: string[] = [];
    const ps = new ProjectileSystem();
    (world as unknown as { projectiles: ProjectileSystem }).projectiles = ps; // readonly in the type only
    spawnProjectile(world, {
      kind: 'boulder',
      ownerId: 0,
      pos: { x: tree.x, y: 1.2, z: tree.z - 8 },
      vel: { x: 0, y: 0, z: 20 },
      radius: 0.5,
      onImpact: (_s, _p, h) => hits.push(h.kind),
    });
    for (let i = 0; i < 60; i++) world.step(DT);
    expect(hits).toEqual(['obstacle']);

    const ps2 = new ProjectileSystem();
    (world as unknown as { projectiles: ProjectileSystem }).projectiles = ps2;
    spawnProjectile(world, {
      kind: 'boulder',
      ownerId: 0,
      pos: { x: -2, y: 1.2, z: -28 }, // lane x = -2 only meets the south wall
      vel: { x: 0, y: 0, z: -20 },
      radius: 0.5,
      onImpact: (_s, _p, h) => hits.push(h.kind),
    });
    for (let i = 0; i < 40; i++) world.step(DT);
    expect(hits).toEqual(['obstacle', 'wall']);
  });
});

describe('locomotion in the jungle', () => {
  it('a fighter walking at a tree is stopped by it (steady-state outside the trunk)', () => {
    const { world } = liveWorld(['hippo', 'lion'], 3, [], { arena: 'jungle' });
    disablePickups(world);
    const tree = JUNGLE_ARENA.circles[3]; // (4.1, -15.9) r 1.3
    const f = world.fighters[0];
    f.state.pos = { x: tree.x, y: 0, z: tree.z + 6 };
    world.fighters[1].state.pos = { x: -28, y: 0, z: 10 };
    for (let i = 0; i < 180; i++) {
      world.setIntent(0, { ...neutral(), moveX: 0, moveZ: -1, aimYaw: Math.PI });
      world.setIntent(1, neutral());
      world.step(DT);
    }
    expect(Math.hypot(f.state.pos.x - tree.x, f.state.pos.z - tree.z)).toBeGreaterThanOrEqual(tree.radius + ANIMALS.hippo.radius - 0.02);
    expect(f.state.pos.z).toBeGreaterThan(tree.z); // never passed through
  });
});
