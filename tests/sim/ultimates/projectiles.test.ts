import { describe, it, expect } from 'vitest';
import { liveWorld, makeFighter, makeSim, neutral, disablePickups, DT } from '../helpers';
import type { AnimalId, GameEvent, GameEventOf } from '../../../src/core/types';
import type { World } from '../../../src/sim/World';
import { ProjectileSystem, spawnProjectile } from '../../../src/sim/projectiles';
import type { ProjectileHit, ProjectileSpec } from '../../../src/sim/projectiles';
import { PILLARS, CRATES, WALL_RADIUS } from '../../../src/config/arena';

/**
 * Test lane: the line x = -12 (z from about -20 to +27) is free of pillars, crates,
 * fallen columns and the central dais, so a projectile flying along it only ever meets
 * what a test puts there (then the arena wall at z ≈ 27).
 */
const LX = -12;

function ofType<T extends GameEvent['type']>(events: GameEvent[], type: T): GameEventOf<T>[] {
  return events.filter((e): e is GameEventOf<T> => e.type === type);
}

function arena(animals: AnimalId[]): { world: World; events: GameEvent[] } {
  const events: GameEvent[] = [];
  const { world } = liveWorld(animals, 5, events);
  disablePickups(world);
  return { world, events };
}

function park(world: World, i: number, x: number, y: number, z: number): void {
  const f = world.fighters[i];
  f.state.pos = { x, y, z };
  f.state.vel = { x: 0, y: 0, z: 0 };
}

/** Park every fighter but the listed ones far from the lane. */
function parkAway(world: World, except: number[]): void {
  const spots = [
    [20, 20],
    [20, -20],
    [-20, -20],
  ];
  let k = 0;
  world.fighters.forEach((_f, i) => {
    if (except.includes(i)) return;
    const s = spots[k++ % spots.length];
    park(world, i, s[0], 0, s[1]);
  });
}

function stepN(world: World, n: number): void {
  for (let i = 0; i < n; i++) {
    for (const f of world.fighters) world.setIntent(f.id, neutral());
    world.step(DT);
  }
}

function boulder(over: Partial<ProjectileSpec> = {}): ProjectileSpec {
  return {
    kind: 'boulder',
    ownerId: 0,
    pos: { x: LX, y: 1.2, z: -10 },
    vel: { x: 0, y: 0, z: 18 },
    radius: 0.5,
    ...over,
  };
}

describe('projectile flight and snapshot', () => {
  it('flies straight, shows up in snapshot.projectiles; the list is empty when none exist', () => {
    const { world } = arena(['lion', 'hippo']);
    parkAway(world, []);
    expect(world.snapshot().projectiles).toEqual([]);
    const id = world.projectiles.spawn(boulder());
    expect(id).toBe(0);
    stepN(world, 10);
    const snap = world.snapshot().projectiles!;
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ id: 0, kind: 'boulder', ownerId: 0, radius: 0.5 });
    expect(snap[0].pos.x).toBeCloseTo(LX, 9);
    expect(snap[0].pos.z).toBeCloseTo(-10 + 18 * 10 * DT, 6);
    expect(snap[0].pos.y).toBeCloseTo(1.2, 9);
    expect(snap[0].vel).toEqual({ x: 0, y: 0, z: 18 });
  });

  it('gravity arcs the flight and it lands as a ground impact at ground height', () => {
    const { world, events } = arena(['lion', 'hippo']);
    parkAway(world, []);
    let hit: ProjectileHit | null = null;
    world.projectiles.spawn(
      boulder({
        pos: { x: LX, y: 2, z: -12 },
        vel: { x: 0, y: 4, z: 10 },
        gravity: 20,
        impactRadius: 2.5,
        onImpact: (_s, _p, h) => (hit = h),
      }),
    );
    stepN(world, 90);
    expect(world.projectiles.count).toBe(0);
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe('ground');
    expect(hit!.fighterId).toBe(-1);
    expect(hit!.pos.y).toBeCloseTo(0, 9);
    expect(hit!.pos.z).toBeGreaterThan(-12);
    const imp = ofType(events, 'projectileImpact');
    expect(imp).toHaveLength(1);
    expect(imp[0]).toMatchObject({ kind: 'boulder', radius: 2.5, ownerId: 0, hitId: -1 });
    expect(imp[0].pos.z).toBeCloseTo(hit!.pos.z, 9);
  });

  it('a fast small projectile does not tunnel through a thin body (sub-stepping)', () => {
    const { world, events } = arena(['lion', 'eagle']);
    parkAway(world, [1]);
    park(world, 1, LX, 0, 6); // eagle radius 0.55
    world.projectiles.spawn(boulder({ pos: { x: LX, y: 0.8, z: -6 }, vel: { x: 0, y: 0, z: 240 }, radius: 0.1 }));
    stepN(world, 6);
    expect(ofType(events, 'projectileImpact')[0]?.hitId).toBe(1);
  });
});

describe('projectile vs fighters', () => {
  it('stops at the FIRST fighter it touches and reports it', () => {
    const { world, events } = arena(['lion', 'hippo', 'rhino']);
    parkAway(world, [1, 2]);
    park(world, 1, LX, 0, 0); // hippo, nearer
    park(world, 2, LX, 0, 6); // rhino behind it
    const hits: ProjectileHit[] = [];
    world.projectiles.spawn(boulder({ pos: { x: LX, y: 1.0, z: -8 }, onImpact: (_s, _p, h) => hits.push(h) }));
    stepN(world, 40);
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe('fighter');
    expect(hits[0].fighterId).toBe(1);
    const imp = ofType(events, 'projectileImpact');
    expect(imp).toHaveLength(1);
    expect(imp[0].hitId).toBe(1);
    expect(world.projectiles.count).toBe(0);
  });

  it('never hits its owner (owner exclusion) but does hit others', () => {
    const { world, events } = arena(['lion', 'hippo']);
    parkAway(world, [0]);
    park(world, 0, LX, 0, 0);
    // Spawned inside the owner's body, flying away along the lane until the wall.
    world.projectiles.spawn(boulder({ ownerId: 0, pos: { x: LX, y: 1.0, z: 0 }, vel: { x: 0, y: 0, z: 12 } }));
    stepN(world, 200);
    const imp = ofType(events, 'projectileImpact');
    expect(imp).toHaveLength(1);
    expect(imp[0].hitId).toBe(-1);
    expect(world.projectiles.count).toBe(0);

    // The same shot from another owner does hit that fighter.
    const w2 = arena(['lion', 'hippo']);
    parkAway(w2.world, [0]);
    park(w2.world, 0, LX, 0, 0);
    w2.world.projectiles.spawn(boulder({ ownerId: 1, pos: { x: LX, y: 1.0, z: -6 } }));
    stepN(w2.world, 30);
    expect(ofType(w2.events, 'projectileImpact')[0]?.hitId).toBe(0);
  });

  it('a fighter above the flight height (flier / jump apex) is missed; a burrowed one is skipped', () => {
    const { world, events } = arena(['lion', 'eagle', 'mole']);
    parkAway(world, [1, 2]);
    park(world, 1, LX, 4.5, 0); // eagle soaring well above the shot
    park(world, 2, LX, 0, 2);
    world.fighters[2].untargetable = true; // burrowed mole right behind it
    world.projectiles.spawn(boulder({ pos: { x: LX, y: 0.9, z: -3 }, vel: { x: 0, y: 0, z: 16 } }));
    stepN(world, 140);
    const imp = ofType(events, 'projectileImpact');
    expect(imp).toHaveLength(1);
    expect(imp[0].hitId).toBe(-1); // flew on to the wall instead
    expect(imp[0].pos.z).toBeGreaterThan(20);
  });

  it('dead fighters are ignored', () => {
    const { world, events } = arena(['lion', 'hippo', 'rhino']); // a third fighter keeps the match going
    parkAway(world, [1]);
    park(world, 1, LX, 0, 0);
    world.fighters[1].state.alive = false;
    world.projectiles.spawn(boulder({ pos: { x: LX, y: 1.0, z: -6 } }));
    stepN(world, 140);
    const imp = ofType(events, 'projectileImpact');
    expect(imp).toHaveLength(1);
    expect(imp[0].hitId).toBe(-1);
  });
});

describe('projectile vs geometry', () => {
  it('stops at a pillar', () => {
    const { world, events } = arena(['lion', 'hippo']);
    parkAway(world, []);
    const pillar = PILLARS[0]; // (15, 0)
    let hit: ProjectileHit | null = null;
    world.projectiles.spawn(boulder({ pos: { x: pillar.x - 8, y: 1.0, z: pillar.z }, vel: { x: 20, y: 0, z: 0 }, onImpact: (_s, _p, h) => (hit = h) }));
    stepN(world, 30);
    expect(hit!.kind).toBe('obstacle');
    expect(hit!.pos.x).toBeLessThan(pillar.x);
    expect(hit!.pos.x).toBeGreaterThan(pillar.x - pillar.radius - 0.5 - 0.3);
    expect(ofType(events, 'projectileImpact')).toHaveLength(1);
  });

  it('breaks a crate it hits (and stops there); leaves it when told not to break', () => {
    const { world, events } = arena(['lion', 'hippo']);
    parkAway(world, []);
    const crate = CRATES[0]; // cluster at (7,7)
    expect(world.crates[0].alive).toBe(true);
    let hit: ProjectileHit | null = null;
    world.projectiles.spawn(boulder({ pos: { x: crate.x, y: 0.6, z: crate.z - 6 }, vel: { x: 0, y: 0, z: 18 }, onImpact: (_s, _p, h) => (hit = h) }));
    stepN(world, 40);
    expect(hit!.kind).toBe('crate');
    expect(world.crates[0].alive).toBe(false);
    expect(ofType(events, 'crateBreak').map((e) => e.crateId)).toContain(0);

    const w2 = arena(['lion', 'hippo']).world;
    parkAway(w2, []);
    w2.projectiles.spawn(boulder({ breaksCrates: false, pos: { x: crate.x, y: 0.6, z: crate.z - 6 }, vel: { x: 0, y: 0, z: 18 } }));
    stepN(w2, 40);
    expect(w2.crates[0].alive).toBe(true);
    expect(w2.projectiles.count).toBe(0); // still stopped by it
  });

  it('stops at the arena wall', () => {
    const { world } = arena(['lion', 'hippo']);
    parkAway(world, []);
    let hit: ProjectileHit | null = null;
    world.projectiles.spawn(boulder({ pos: { x: LX, y: 1.0, z: 19 }, vel: { x: 0, y: 0, z: 20 }, onImpact: (_s, _p, h) => (hit = h) }));
    stepN(world, 30);
    expect(hit!.kind).toBe('wall');
    expect(Math.hypot(hit!.pos.x, hit!.pos.z)).toBeGreaterThan(WALL_RADIUS - 1.2);
  });

  it('expires silently after maxLife (callback yes, event no)', () => {
    const { world, events } = arena(['lion', 'hippo']);
    parkAway(world, []);
    const kinds: string[] = [];
    world.projectiles.spawn(boulder({ pos: { x: LX, y: 3, z: -2 }, vel: { x: 0, y: 0, z: 1 }, maxLife: 0.1, onImpact: (_s, _p, h) => kinds.push(h.kind) }));
    stepN(world, 10);
    expect(kinds).toEqual(['expired']);
    expect(ofType(events, 'projectileImpact')).toHaveLength(0);
    expect(world.projectiles.count).toBe(0);
  });
});

describe('projectile system plumbing', () => {
  it('ids are sequential; a projectile spawned from an impact callback survives compaction', () => {
    const { world } = arena(['lion', 'hippo']);
    parkAway(world, []);
    const child = boulder({ pos: { x: LX, y: 3, z: 0 }, vel: { x: 0, y: 0, z: 2 }, ownerId: 0 });
    // First projectile dies on the ground at once and spawns a child; second keeps flying.
    world.projectiles.spawn(boulder({ pos: { x: LX, y: 0.2, z: -5 }, vel: { x: 0, y: 0, z: 0 }, onImpact: (sim) => void spawnProjectile(sim, child) }));
    world.projectiles.spawn(boulder({ pos: { x: LX, y: 3, z: 5 }, vel: { x: 0, y: 0, z: 1 } }));
    stepN(world, 1);
    const snap = world.snapshot().projectiles!;
    expect(snap.map((p) => p.id).sort()).toEqual([1, 2]);
  });

  it('spawnProjectile is a no-op (-1) on a Sim without a projectile system', () => {
    const f = makeFighter(0, 'lion', 0, 0, 0);
    const sim = makeSim([f]);
    expect(spawnProjectile(sim, boulder())).toBe(-1);
  });

  it('a standalone ProjectileSystem steps against a minimal Sim', () => {
    const shooter = makeFighter(0, 'gorilla', LX, 0, 0);
    const victim = makeFighter(1, 'hippo', LX, 10, 0);
    const events: GameEvent[] = [];
    const sim = makeSim([shooter, victim], events);
    const ps = new ProjectileSystem();
    ps.spawn(boulder({ pos: { x: LX, y: 1, z: 2 } }));
    for (let i = 0; i < 40; i++) ps.update(sim, DT);
    expect(ps.count).toBe(0);
    expect(ofType(events, 'projectileImpact')[0].hitId).toBe(1);
    ps.spawn(boulder());
    ps.clear();
    expect(ps.count).toBe(0);
  });

  it('is deterministic: identical worlds produce identical projectile snapshots', () => {
    const run = (): string => {
      const { world } = arena(['lion', 'hippo', 'eagle']);
      park(world, 0, 5, 0, -5);
      park(world, 1, -6, 0, 8);
      park(world, 2, 2, 1.6, 12);
      world.projectiles.spawn(boulder({ pos: { x: 0, y: 2.5, z: -12 }, vel: { x: 1.5, y: 3, z: 14 }, gravity: 12 }));
      world.projectiles.spawn(boulder({ ownerId: 2, pos: { x: 6, y: 2, z: 14 }, vel: { x: -5, y: 2, z: -12 }, gravity: 9, radius: 0.7 }));
      const out: unknown[] = [];
      for (let i = 0; i < 80; i++) {
        stepN(world, 1);
        out.push(world.snapshot().projectiles);
      }
      return JSON.stringify(out);
    };
    expect(run()).toBe(run());
  });
});
