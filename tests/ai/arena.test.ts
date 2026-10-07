/**
 * v1.8: the bots read the arena they are given (BotManager -> BotBrain/Perception/Steering/DangerZones) instead of the
 * colosseum constants. Colosseum behaviour (the default) is pinned by the unchanged AI suites + the sweep baseline.
 */

import { describe, it, expect } from 'vitest';
import { World } from '../../src/sim/World';
import { EventBus } from '../../src/core/EventBus';
import { BotManager } from '../../src/ai/BotManager';
import { hasLineOfSight, Perception } from '../../src/ai/Perception';
import { avoidObstacles, groundY, lowWallDetour, type Move2 } from '../../src/ai/Steering';
import { DangerZones, makeExit } from '../../src/ai/dangerZones';
import { COLOSSEUM_ARENA, JUNGLE_ARENA as J } from '../../src/config/arenas';
import { PILLARS } from '../../src/config/arena';
import type { AnimalId, Difficulty, MatchConfig } from '../../src/core/types';
import { disablePickups } from '../sim/helpers';
import { DT } from './helpers';

describe('BotManager arena plumbing', () => {
  it('defaults to the colosseum; accepts an ArenaDef or an ArenaId; brains and perception share it', () => {
    const bus = new EventBus();
    expect(new BotManager(bus, 3, 1).arena).toBe(COLOSSEUM_ARENA);
    expect(new BotManager(bus, 3, 1, J).arena).toBe(J);
    expect(new BotManager(bus, 3, 1, 'jungle').arena).toBe(J);
    expect(new BotManager(bus, 3, 1, 'colosseum').arena).toBe(COLOSSEUM_ARENA);
    const p = new Perception(1, 0.2, J);
    expect(p.arena).toBe(J);
    expect(p.zones.arena).toBe(J);
    expect(new Perception(1, 0.2).arena).toBe(COLOSSEUM_ARENA);
  });
});

describe('line of sight uses the arena blockers', () => {
  const tree = J.circles[3]; // (4.1, -15.9) r 1.3

  it('a jungle trunk occludes; the same line is open in the colosseum', () => {
    expect(hasLineOfSight(tree.x - 5, tree.z, tree.x + 5, tree.z, J)).toBe(false);
    expect(hasLineOfSight(tree.x - 5, tree.z + 4, tree.x + 5, tree.z + 4, J)).toBe(true); // passes beside it
    expect(hasLineOfSight(tree.x - 5, tree.z, tree.x + 5, tree.z, COLOSSEUM_ARENA)).toBe(true);
  });

  it('a colosseum pillar occludes only in the colosseum (default arena argument = colosseum)', () => {
    const p = PILLARS[0]; // (15, 0)
    expect(hasLineOfSight(p.x - 4, p.z, p.x + 4, p.z)).toBe(false);
    expect(hasLineOfSight(p.x - 4, p.z, p.x + 4, p.z, COLOSSEUM_ARENA)).toBe(false);
    expect(hasLineOfSight(p.x - 4, p.z, p.x + 4, p.z, J)).toBe(true);
  });

  it('logs and crates never occlude (only tall round blockers do)', () => {
    const log = J.segments[0];
    const mx = (log.ax + log.bx) / 2;
    const mz = (log.az + log.bz) / 2;
    expect(hasLineOfSight(mx - 3, mz - 3, mx + 3, mz + 3, J)).toBe(true);
  });
});

describe('steering uses the arena', () => {
  const tree = J.circles[3]; // (4.1, -15.9) r 1.3

  it('bends away from a jungle trunk straight ahead; leaves a colosseum-pillar spot alone', () => {
    const out: Move2 = { x: 0, z: -1 }; // walking -z toward the trunk from 3 m north of it
    avoidObstacles(out, tree.x + 0.2, tree.z + 3.2, 0.8, [], false, J);
    expect(Math.abs(out.x)).toBeGreaterThan(0.2); // swerved sideways
    const free: Move2 = { x: 1, z: 0 };
    avoidObstacles(free, PILLARS[0].x - 2.5, PILLARS[0].z, 0.8, [], false, J);
    expect(free.x).toBeCloseTo(1, 6); // no pillar in the jungle
    expect(Math.abs(free.z)).toBeLessThan(1e-9);
    const hit: Move2 = { x: 1, z: 0 };
    avoidObstacles(hit, PILLARS[0].x - 2.5, PILLARS[0].z, 0.8, [], false, COLOSSEUM_ARENA);
    expect(hit.x).toBeLessThan(1);
  });

  it('the arena wall radius drives the inward pull', () => {
    const out: Move2 = { x: 1, z: 0 };
    avoidObstacles(out, 28.2, 0, 0.8, [], false, J);
    expect(out.x).toBeLessThan(0.9); // pulled back from the wall
  });

  it('lowWallDetour walks round a log tip but ignores the colosseum columns in the jungle', () => {
    const log = J.segments[2]; // (-7.3,-8.7) -> (-3,-8.7)
    const m: Move2 = { x: 0, z: 0 };
    expect(lowWallDetour(m, log.ax + 2, log.az + 2.5, log.ax + 2, log.az - 2.5, 0.8, J)).toBe(true);
    const n: Move2 = { x: 0, z: 0 };
    expect(lowWallDetour(n, log.ax + 2, log.az + 2.5, log.ax + 2, log.az - 2.5, 0.8, COLOSSEUM_ARENA)).toBe(false);
  });

  it('ground height: the dais top in the colosseum, flat in the jungle', () => {
    expect(groundY(0, 0, COLOSSEUM_ARENA)).toBeCloseTo(0.6, 9);
    expect(groundY(0, 0, J)).toBe(0);
    expect(groundY(10, 3, COLOSSEUM_ARENA)).toBe(0);
  });
});

describe('danger-zone exits stay clear of the arena blockers', () => {
  it('an exit never lands inside a jungle trunk', () => {
    const tree = J.circles[3];
    for (const arena of [J, COLOSSEUM_ARENA]) {
      const zs = new DangerZones(arena);
      // a big zone centred on the trunk's west side pushes the bot toward the trunk
      zs.registerZone({ key: 1, shape: 'circle', ax: tree.x - 1.5, az: tree.z, r: 3, knownAt: 0, expiresAt: 9 });
      const out = makeExit();
      expect(zs.nearestExit(tree.x - 1.5, tree.z, 0.8, 0, out)).toBe(true);
      if (arena === J) expect(Math.hypot(out.x - tree.x, out.z - tree.z)).toBeGreaterThanOrEqual(tree.radius + 0.8 + 0.2 - 1e-6);
    }
  });
});

describe('bots fight round a tree trunk (the pillar-style obstacle steering)', () => {
  const tree = J.circles[3]; // (4.1, -15.9) r 1.3: open ground all round it

  function duel(difficulty: Difficulty, a: AnimalId, b: AnimalId): number {
    const cfg: MatchConfig = { roster: [a, b].map((x) => ({ animal: x, isPlayer: false })), difficulty, arena: 'jungle' };
    const bus = new EventBus();
    const world = new World(cfg, 9, bus, { traps: false });
    disablePickups(world);
    const gap = 4.2; // each side of the trunk: the straight line between them runs through it
    world.fighters[0].state.pos = { x: tree.x - gap, y: 0, z: tree.z };
    world.fighters[1].state.pos = { x: tree.x + gap, y: 0, z: tree.z };
    const bots = new BotManager(bus, difficulty, 9, world.arena);
    let firstDamage = -1;
    bus.on('hit', () => {
      if (firstDamage < 0) firstDamage = world.time;
    });
    bus.on('blocked', () => {
      if (firstDamage < 0) firstDamage = world.time;
    });
    for (let tick = 0; tick < Math.ceil(30 / DT) && firstDamage < 0; tick++) {
      bots.update(world.snapshot(), DT);
      for (let id = 0; id < 2; id++) world.setIntent(id, bots.getIntent(id));
      world.step(DT);
    }
    return firstDamage;
  }

  it('two bots on opposite sides of a trunk close in and trade blows (Cub and Apex)', () => {
    for (const lvl of [1, 4] as Difficulty[]) {
      const t = duel(lvl, 'hippo', 'rhino');
      expect(t, `L${lvl}`).toBeGreaterThanOrEqual(0);
      expect(t, `L${lvl}`).toBeLessThan(15);
    }
  });
});
