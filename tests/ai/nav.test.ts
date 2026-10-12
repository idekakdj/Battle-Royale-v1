/**
 * v1.9 WP-O2: elevation-aware bot navigation on the Ocean Dome (src/ai/NavGrid.ts, src/ai/Navigator.ts).
 *
 * Unit tests pin the walkability grid and the A* (ramps are the only way up, drops are optional, the colosseum / jungle never build a
 * grid); the bot-state tests run real `World` + `BotManager` matches of one bot against an idle dummy parked on another level and
 * check that the bot climbs there instead of wedging at the cliffs.
 */

import { describe, it, expect } from 'vitest';
import { World } from '../../src/sim/World';
import { EventBus } from '../../src/core/EventBus';
import { BotManager } from '../../src/ai/BotManager';
import { Navigator, NAV_AI } from '../../src/ai/Navigator';
import {
  EDGE_DROP,
  NavSearch,
  getNavGrid,
  lineWalk,
  LINE_BLOCKED,
  LINE_DROP,
  LINE_OK,
  nearestWalkCell,
  cellX,
  cellZ,
} from '../../src/ai/NavGrid';
import type { Move2 } from '../../src/ai/Steering';
import { ANIMALS } from '../../src/config/animals';
import { COLOSSEUM_ARENA, JUNGLE_ARENA, OCEAN_ARENA as O, arenaGroundHeight } from '../../src/config/arenas';
import type { AnimalId, Difficulty, FighterIntent, MatchConfig } from '../../src/core/types';
import { ANIMAL_IDS } from '../../src/config/animals';
import { DT } from './helpers';

const IDLE: FighterIntent = { moveX: 0, moveZ: 0, aimYaw: 0, attack: false, block: false, special: false, ultimate: false, jump: false };

function pol(r: number, deg: number): { x: number; z: number } {
  const a = (deg * Math.PI) / 180;
  return { x: r * Math.cos(a), z: r * Math.sin(a) };
}

describe('Navigator is inactive on flat arenas', () => {
  it('colosseum and jungle: every call is a no-op (byte-identical behaviour)', () => {
    for (const arena of [COLOSSEUM_ARENA, JUNGLE_ARENA]) {
      const nav = new Navigator(arena, 0.9, 4);
      expect(nav.active).toBe(false);
      const out: Move2 = { x: 1, z: 0 };
      expect(nav.steer(out, 0, -10, 0, 10, 0, 'engage', 1)).toBe(false);
      expect(out).toEqual({ x: 1, z: 0 });
      expect(nav.terrainBlocked(-10, 0, 10, 0, 'engage', 1)).toBe(false);
      expect(nav.crossPenalty(0, 5, 5)).toBe(0);
      expect(nav.fleePoint(0, 0, 5, 5, out)).toBe(false);
    }
  });
});

describe('NavGrid on the Ocean Dome', () => {
  const rad = ANIMALS.rhino.radius;
  const grid = getNavGrid(O, rad, 0.3);

  it('is cached per (arena, radius, margin)', () => {
    expect(getNavGrid(O, rad, 0.3)).toBe(grid);
    expect(getNavGrid(O, rad, 0)).not.toBe(grid);
  });

  it('ramp centrelines are walkable, level-edge cells next to a cliff are not', () => {
    // outer ramp at 0 deg: runs r 18.5 .. 24.5 along +x, z = 0
    for (const r of [19.5, 21, 23]) {
      const c = nearestWalkCell(grid, r, 0, 0);
      expect(c, `r=${r}`).toBeGreaterThanOrEqual(0);
      expect(Math.hypot(cellX(grid, c) - r, cellZ(grid, c) - 0)).toBeLessThan(0.6);
    }
    // 0.3 m from the terrace cliff at the foot of the terrace (r 19.3, 36 deg is between ramps): too close for a rhino
    const p = pol(19.3, 36);
    const c = nearestWalkCell(grid, p.x, p.z, 0);
    expect(c === -1 || Math.hypot(cellX(grid, c) - p.x, cellZ(grid, c) - p.z) > 0.4).toBe(true);
  });

  it('A* from the seabed to the plateau climbs both ramps, never steps up a cliff and takes no drop', () => {
    const s = new NavSearch(grid.n * grid.n);
    const start = nearestWalkCell(grid, 0, -24, 4);
    const goal = nearestWalkCell(grid, 0, 0, 4);
    expect(s.find(grid, start, goal, Infinity, false)).toBe(true);
    expect(s.hasDrop).toBe(false);
    const heights = new Set<number>();
    for (let i = 0; i < s.pathLen; i++) {
      const c = s.path[i];
      heights.add(Math.round(arenaGroundHeight(O, cellX(grid, c), cellZ(grid, c)) * 2) / 2);
      if (i > 0) {
        const p = s.path[i - 1];
        const up = grid.h[c] - grid.h[p];
        expect(up).toBeLessThanOrEqual(0.6);
        expect(up).toBeGreaterThan(-0.45);
      }
    }
    expect(heights.has(0)).toBe(true);
    expect(heights.has(1.5)).toBe(true);
    expect(heights.has(3)).toBe(true);
    // a detour: longer than the straight 24 m, but not absurdly so
    expect(s.pathMetres).toBeGreaterThan(30);
    expect(s.pathMetres).toBeLessThan(55);
  });

  it('drops are optional: planning from the plateau to the seabed is shorter with them, and they are real ledge edges', () => {
    const s = new NavSearch(grid.n * grid.n);
    const start = nearestWalkCell(grid, 0, 0, 4);
    const goal = nearestWalkCell(grid, 24, -10, 4);
    expect(s.find(grid, start, goal, Infinity, false)).toBe(true);
    const noDrop = s.pathMetres;
    expect(s.hasDrop).toBe(false);
    expect(s.find(grid, start, goal, 3, false)).toBe(true);
    expect(s.hasDrop).toBe(true);
    expect(s.pathMetres).toBeLessThan(noDrop);
    let drops = 0;
    for (let e = 0; e < grid.adjKind.length; e++) if (grid.adjKind[e] === EDGE_DROP) drops++;
    expect(drops).toBeGreaterThan(100);
  });

  it('lineWalk: flat ground is fine, a cliff blocks, a ledge needs allowDrop', () => {
    // seabed to seabed
    expect(lineWalk(grid, 24, -3, 24, 3, false, false)).toBe(LINE_OK);
    // seabed (r 24, 36 deg) straight towards the centre runs into the terrace cliff
    const a = pol(24, 36);
    const b = pol(14, 36);
    expect(lineWalk(grid, a.x, a.z, b.x, b.z, true, false)).toBe(LINE_BLOCKED);
    // terrace (r 14) straight out to the seabed: a 1.5 m ledge
    expect(lineWalk(grid, b.x, b.z, a.x, a.z, false, false)).toBe(LINE_BLOCKED);
    expect(lineWalk(grid, b.x, b.z, a.x, a.z, true, false)).toBe(LINE_DROP);
    // up the ramp at 0 degrees
    expect(lineWalk(grid, 23.5, 0, 17, 0, false, false)).toBe(LINE_OK);
  });
});

describe('Navigator.steer on the Ocean Dome', () => {
  it('heads for the ramp, not at the cliff, when the target is on the terrace behind it; straight when the line is clear', () => {
    const nav = new Navigator(O, ANIMALS.lion.radius, 3);
    expect(nav.active).toBe(true);
    const from = pol(24, 36);
    const goal = pol(14, 36);
    const out: Move2 = { x: 0, z: 0 };
    expect(nav.steer(out, 0, from.x, from.z, goal.x, goal.z, 'engage', 1)).toBe(true);
    const toGoal = { x: goal.x - from.x, z: goal.z - from.z };
    const l = Math.hypot(toGoal.x, toGoal.z);
    const dot = (out.x * toGoal.x + out.z * toGoal.z) / l;
    expect(dot).toBeLessThan(0.97); // not a straight seek into the cliff
    expect(nav.following).toBe(true);
    expect(nav.pathMetres).toBeGreaterThan(l);
    // same level, clear line: the brain keeps its own straight-line steering
    const nav2 = new Navigator(O, ANIMALS.lion.radius, 3);
    const out2: Move2 = { x: 0.3, z: 0.4 };
    expect(nav2.steer(out2, 0, 24, -3, 24, 3, 'engage', 1)).toBe(false);
    expect(out2).toEqual({ x: 0.3, z: 0.4 });
  });

  it('a hurt Veteran / Apex does not plan a drop off a ledge (healthy bots and Cubs do)', () => {
    const top = pol(14, 36);
    const below = pol(24, 36);
    const apex = new Navigator(O, ANIMALS.lion.radius, 4);
    const cub = new Navigator(O, ANIMALS.lion.radius, 1);
    expect(apex.dropAllowed('engage', 0.3)).toBe(false);
    expect(apex.dropAllowed('engage', 0.9)).toBe(true);
    expect(cub.dropAllowed('engage', 0.1)).toBe(true);
    expect(apex.terrainBlocked(top.x, top.z, below.x, below.z, 'engage', 0.9)).toBe(false); // healthy: walks off the ledge
    expect(apex.terrainBlocked(top.x, top.z, below.x, below.z, 'engage', 0.3)).toBe(true); // hurt: goes round by a ramp
    expect(apex.dropAllowed('flee', 0.1)).toBe(true); // running away may always drop
  });

  it('level ladder: L1 re-plans late with no margin, L4 re-plans fast with a berth; cross-level targets cost metres from L2 up', () => {
    expect(NAV_AI[1].replanS).toBeGreaterThan(NAV_AI[2].replanS);
    expect(NAV_AI[2].replanS).toBeGreaterThan(NAV_AI[4].replanS);
    expect(NAV_AI[1].margin).toBe(0);
    expect(NAV_AI[4].margin).toBeGreaterThan(0);
    const t = pol(14, 36); // terrace
    const costs = ([1, 2, 3, 4] as Difficulty[]).map((d) => new Navigator(O, 0.7, d).crossPenalty(0, t.x, t.z));
    expect(costs[0]).toBe(0);
    expect(costs[1]).toBeGreaterThan(0);
    expect(costs[2]).toBeGreaterThan(costs[1]);
    expect(new Navigator(O, 0.7, 4).crossPenalty(1.5, t.x, t.z)).toBe(0); // same level
  });
});

/** One bot against an idle dummy: the bot spawns on the seabed, the dummy is parked at (px, pz) on another level. */
function climbs(animal: AnimalId, level: Difficulty, px: number, pz: number, seed: number, maxS = 30): { reached: boolean; worstStall: number; maxY: number; t: number } {
  const cfg: MatchConfig = {
    roster: [
      { animal, isPlayer: false },
      { animal: 'rhino', isPlayer: true },
    ],
    difficulty: level,
    arena: 'ocean',
  };
  const bus = new EventBus();
  const world = new World(cfg, seed, bus, { traps: false, serpent: { chance: 0, intervalS: 1e9 } });
  const bots = new BotManager(bus, level, seed, world.arena);
  const bot = world.fighters[0].state;
  const dummy = world.fighters[1].state;
  dummy.pos.x = px;
  dummy.pos.z = pz;
  dummy.pos.y = arenaGroundHeight(O, px, pz);
  dummy.hp = dummy.maxHp = 1e6; // never dies
  let ax = bot.pos.x;
  let az = bot.pos.z;
  let stall = 0;
  let worstStall = 0;
  let maxY = 0;
  let t = 0;
  const targetY = dummy.pos.y;
  for (let tick = 0; tick < Math.ceil((maxS + 3.5) / DT); tick++) {
    bots.update(world.snapshot(), DT);
    world.setIntent(0, bots.getIntent(0));
    world.setIntent(1, IDLE);
    world.step(DT);
    if (world.time <= 0) continue;
    maxY = Math.max(maxY, bot.pos.y);
    const wants = Math.hypot(bots.getIntent(0).moveX, bots.getIntent(0).moveZ) > 0.5 && (bot.action === 'run' || bot.action === 'idle');
    if (!wants || Math.hypot(bot.pos.x - ax, bot.pos.z - az) > 0.75) {
      ax = bot.pos.x;
      az = bot.pos.z;
      stall = 0;
    } else if (++stall > worstStall) worstStall = stall;
    const onLevel = Math.abs(bot.pos.y - targetY) < 0.3;
    if (onLevel && Math.hypot(bot.pos.x - px, bot.pos.z - pz) < ANIMALS[animal].range + 2.5) {
      t = world.time;
      return { reached: true, worstStall, maxY, t };
    }
  }
  return { reached: false, worstStall, maxY, t: world.time };
}

describe('bots climb to a target on another level instead of wedging at the cliffs', () => {
  const cases: [AnimalId, Difficulty][] = [
    ['lion', 2],
    ['rhino', 3],
    ['hippo', 4],
    ['giraffe', 3],
    ['mole', 4],
    ['python', 2],
  ];
  for (const [animal, level] of cases) {
    it(`${animal} (L${level}) reaches a dummy on the centre plateau`, () => {
      const r = climbs(animal, level, 2, -1, 11 + level);
      expect(r.reached, `maxY ${r.maxY.toFixed(2)} t ${r.t.toFixed(1)}`).toBe(true);
      expect(r.maxY).toBeGreaterThan(2.9);
      expect(r.worstStall).toBeLessThan(120);
    });
  }

  it('a Cub also gets there (late re-plans, no berth: slower, but it climbs)', () => {
    const r = climbs('lion', 1, -2, 2, 5, 45);
    expect(r.reached, `maxY ${r.maxY.toFixed(2)} t ${r.t.toFixed(1)}`).toBe(true);
    expect(r.worstStall).toBeLessThan(300);
  });

  it('reaches a dummy on the terrace too (one ramp)', () => {
    const p = pol(14, 190);
    const r = climbs('panther', 3, p.x, p.z, 9);
    expect(r.reached, `maxY ${r.maxY.toFixed(2)}`).toBe(true);
    expect(r.maxY).toBeGreaterThan(1.4);
    expect(r.maxY).toBeLessThan(2.9);
  });

  it('target scoring: a Veteran prefers the foe on its own level over a nearer-by-air foe up a cliff', () => {
    // pure geometry of the penalty: 12 m away across a level is worth more than a 4 m longer foe on the same level
    const nav = new Navigator(O, 0.7, 3);
    const same = pol(24, 0); // seabed, 0 m up
    const up = pol(14, 40); // terrace
    expect(nav.crossPenalty(0, same.x, same.z)).toBe(0);
    expect(nav.crossPenalty(0, up.x, up.z)).toBeGreaterThanOrEqual(7);
  });

  it('ANIMALS radii used by the grid cache are real (sanity)', () => {
    for (const a of Object.keys(ANIMALS) as AnimalId[]) expect(ANIMALS[a].radius).toBeGreaterThan(0.4);
  });
});

describe('determinism on the Ocean Dome (navigation + serpent dodging use only the seeded streams)', () => {
  function run(seed: number, level: Difficulty): number {
    const cfg: MatchConfig = { roster: (ANIMAL_IDS as readonly AnimalId[]).map((a) => ({ animal: a, isPlayer: false })), difficulty: level, arena: 'ocean' };
    const bus = new EventBus();
    const world = new World(cfg, seed, bus, { serpent: { intervalS: 5, chance: 1, firstAtS: 3 } });
    const bots = new BotManager(bus, level, seed, world.arena);
    let h = 2166136261 >>> 0;
    for (let tick = 0; tick < 1500; tick++) {
      bots.update(world.snapshot(), DT);
      for (let id = 0; id < cfg.roster.length; id++) world.setIntent(id, bots.getIntent(id));
      world.step(DT);
      for (const f of world.fighters) {
        h = Math.imul(h ^ Math.round(f.state.pos.x * 1000), 16777619) >>> 0;
        h = Math.imul(h ^ Math.round(f.state.pos.z * 1000), 16777619) >>> 0;
        h = Math.imul(h ^ Math.round(f.state.hp), 16777619) >>> 0;
      }
    }
    return h;
  }
  it('the same seed gives the same match, a different seed a different one', () => {
    for (const lvl of [2, 4] as Difficulty[]) {
      expect(run(5, lvl)).toBe(run(5, lvl));
      expect(run(5, lvl)).not.toBe(run(6, lvl));
    }
  });
});
