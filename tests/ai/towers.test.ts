/**
 * v1.10 WP-H3 (docs/OCEAN-HEIGHTS-PLAN.md): bots on the Ocean Dome's UPPER tier - three 6.5 m towers reached by steep (0.39) ramps -
 * and the fall-damage rule (a landing after a drop of >= 3.4 m costs 50 HP).
 *
 *  - NavGrid: the deadly-edge distance field (`rimD`), a route to every tower pad for every body size, never a deadly drop on it;
 *  - the physical ramp seams: every animal (radius 0.5 - 1.2) walks each tower ramp centre line, seam to seam, into the tower without
 *    wedging and without a fall (real sim, no AI);
 *  - FallGuard: the last steering pass keeps a heading from carrying the body over a deadly edge (L1 / L2 blunder now and then);
 *  - real BotBrains climb to each tower pad and come down by the ramp again, with no fall at Veteran / Apex;
 *  - the pull towards the upper pads, and the cooldown that keeps a bot from camping up there.
 */

import { describe, it, expect } from 'vitest';
import { World } from '../../src/sim/World';
import { EventBus } from '../../src/core/EventBus';
import { BotManager } from '../../src/ai/BotManager';
import { FallGuard, FALL_AI } from '../../src/ai/FallGuard';
import { DROP_MAX, FALL_SAFETY_M, NavSearch, RIM_FAR, getNavGrid, nearestWalkCell, rimAt } from '../../src/ai/NavGrid';
import { ANIMALS, ANIMAL_IDS } from '../../src/config/animals';
import { COLOSSEUM_ARENA, OCEAN_ARENA as O, OCEAN_FALL_MIN_DROP, OCEAN_STACKS, arenaGroundHeight } from '../../src/config/arenas';
import type { AnimalId, Difficulty, FighterIntent, FighterState, GameEvent, MatchConfig } from '../../src/core/types';
import type { Move2 } from '../../src/ai/Steering';
import { addBuff } from '../../src/sim/StatusEffects';
import { DT } from './helpers';

const IDLE: FighterIntent = { moveX: 0, moveZ: 0, aimYaw: 0, attack: false, block: false, special: false, ultimate: false, jump: false };
const TOWER_PADS = [1, 2, 3];

function standing(x: number, z: number, vx = 0, vz = 0): FighterState {
  return { airborne: false, pos: { x, y: arenaGroundHeight(O, x, z), z }, vel: { x: vx, y: 0, z: vz } } as unknown as FighterState;
}

describe('NavGrid: deadly edges', () => {
  const grid = getNavGrid(O, ANIMALS.rhino.radius, 0.3);

  it('the Ocean has a fall rule: a drop of minDrop - 0.4 m counts as deadly; the flat arenas have none', () => {
    expect(grid.deadly).toBeCloseTo(OCEAN_FALL_MIN_DROP - FALL_SAFETY_M, 9);
    expect(DROP_MAX).toBeLessThan(OCEAN_FALL_MIN_DROP); // no planned ledge drop is ever a fall
    expect(COLOSSEUM_ARENA.hazards?.fallDamage).toBeUndefined();
  });

  it('rimD: ~0 at a tower rim, grows towards the tower centre, far on the plateau and the seabed; ramp sides are rims too', () => {
    for (const s of OCEAN_STACKS) {
      const centre = rimAt(grid, s.x, s.z);
      const nearRim = rimAt(grid, s.x + Math.cos((s.deg * Math.PI) / 180) * (s.radius - 0.3), s.z + Math.sin((s.deg * Math.PI) / 180) * (s.radius - 0.3));
      expect(nearRim, `tower ${s.deg}`).toBeLessThan(0.8);
      expect(centre, `tower ${s.deg}`).toBeGreaterThan(1.5);
      expect(centre).toBeLessThan(RIM_FAR + 1e-9);
    }
    expect(rimAt(grid, 0, 0)).toBe(RIM_FAR); // the plateau is 1.5 m above the terrace: not deadly
    expect(rimAt(grid, 24, -3)).toBe(RIM_FAR); // the seabed
    // the upper half of a causeway: its sides drop 3+ m
    const c = OCEAN_STACKS[1]; // tower at 180 deg: the causeway runs along the x axis towards the plateau
    expect(rimAt(grid, c.x + 5.2, c.z + 1.8)).toBeLessThan(1.0);
  });

  it('a route exists from the seabed to every tower pad for every body size and berth, climbs only ramps and never drops', () => {
    for (const r of [0.5, 0.7, 0.9, 1.15, 1.2]) {
      for (const m of [0, 0.15, 0.3]) {
        const g = getNavGrid(O, r, m);
        const search = new NavSearch(g.n * g.n);
        for (const seat of [0, 3, 6]) {
          const a = ((270 + seat * 36) * Math.PI) / 180;
          const start = nearestWalkCell(g, 24 * Math.cos(a), 24 * Math.sin(a), 4, 0);
          for (const pad of TOWER_PADS) {
            const p = O.pickupPads[pad];
            const goal = nearestWalkCell(g, p.x, p.z, 6, arenaGroundHeight(O, p.x, p.z));
            expect(search.find(g, start, goal, Infinity, false), `r ${r} m ${m} seat ${seat} pad ${pad}`).toBe(true);
            expect(search.hasDrop).toBe(false);
            let high = 0;
            for (let i = 1; i < search.pathLen; i++) {
              const up = g.h[search.path[i]] - g.h[search.path[i - 1]];
              expect(up).toBeLessThanOrEqual(0.6);
              expect(-up).toBeLessThan(DROP_MAX);
              if (g.h[search.path[i]] > 5.8) high++;
            }
            expect(high).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});

/** The tower ramps, from the pieces of the height field: [low end, lower piece's high end, top piece's high end, tower centre]. */
function towerRoutes(): { name: string; pts: { x: number; z: number }[]; dir: { x: number; z: number } }[] {
  const out: { name: string; pts: { x: number; z: number }[]; dir: { x: number; z: number } }[] = [];
  const hf = O.heightfield ?? [];
  for (let i = 0; i < hf.length - 1; i++) {
    const lower = hf[i];
    const top = hf[i + 1];
    if (lower.kind !== 'ramp' || top.kind !== 'ramp' || top.h1 !== 6.5 || lower.h1 >= 6.4 || lower.h1 < 5.8) continue;
    const a = (lower.dirDeg * Math.PI) / 180;
    const d = { x: Math.cos(a), z: Math.sin(a) };
    const half = lower.length / 2;
    const tHalf = top.length / 2;
    const tower = OCEAN_STACKS.reduce((best, s) => (Math.hypot(top.x - s.x, top.z - s.z) < Math.hypot(top.x - best.x, top.z - best.z) ? s : best));
    out.push({
      name: `${lower.h0 === 3 ? 'causeway' : 'chord'} to tower ${tower.deg}`,
      dir: d,
      pts: [
        { x: lower.x - d.x * (half - 1.0), z: lower.z - d.z * (half - 1.0) }, // 1 m up the foot
        { x: lower.x + d.x * half, z: lower.z + d.z * half },
        { x: top.x + d.x * tHalf, z: top.z + d.z * tHalf },
        { x: tower.x, z: tower.z },
      ],
    });
  }
  return out;
}

describe('ramp seams: every animal walks each tower ramp centre line into the tower (real sim)', () => {
  const routes = towerRoutes();
  it('the five tower ramps are found (3 causeways + 2 chords)', () => {
    expect(routes.map((r) => r.name).sort()).toEqual([
      'causeway to tower 180',
      'causeway to tower 288',
      'causeway to tower 72',
      'chord to tower 180',
      'chord to tower 72',
    ]);
  });

  for (const animal of ANIMAL_IDS as readonly AnimalId[]) {
    it(`${animal} (radius ${ANIMALS[animal].radius})`, () => {
      for (const route of routes) {
        const cfg: MatchConfig = {
          roster: [
            { animal, isPlayer: true },
            { animal: 'lion', isPlayer: true },
          ],
          difficulty: 3,
          arena: 'ocean',
        };
        const events: GameEvent[] = [];
        const bus = new EventBus();
        bus.onAny((e) => events.push(e));
        const world = new World(cfg, 7, bus, { traps: false, serpent: { chance: 0, intervalS: 1e9 } });
        for (let i = 0; i < 190; i++) world.step(DT);
        const me = world.fighters[0].state;
        const other = world.fighters[1].state;
        other.pos.x = 0;
        other.pos.z = 0;
        other.pos.y = arenaGroundHeight(O, 0, 0);
        me.pos.x = route.pts[0].x;
        me.pos.z = route.pts[0].z;
        me.pos.y = arenaGroundHeight(O, me.pos.x, me.pos.z);
        world.fighters[0].lastGroundY = me.pos.y;
        let wp = 1;
        let ax = me.pos.x;
        let az = me.pos.z;
        let stall = 0;
        let worst = 0;
        let top = false;
        for (let tick = 0; tick < 60 * 16 && !top; tick++) {
          const w = route.pts[wp];
          let dx = w.x - me.pos.x;
          let dz = w.z - me.pos.z;
          if (Math.hypot(dx, dz) < 0.5 && wp < route.pts.length - 1) {
            wp++;
            dx = route.pts[wp].x - me.pos.x;
            dz = route.pts[wp].z - me.pos.z;
          }
          const l = Math.hypot(dx, dz) || 1;
          world.setIntent(0, { ...IDLE, moveX: dx / l, moveZ: dz / l, aimYaw: Math.atan2(dx, dz) });
          world.setIntent(1, IDLE);
          world.step(DT);
          if (Math.hypot(me.pos.x - ax, me.pos.z - az) > 0.75) {
            ax = me.pos.x;
            az = me.pos.z;
            stall = 0;
          } else if (++stall > worst) worst = stall;
          top = me.pos.y > 6.4 && Math.hypot(me.pos.x - route.pts[3].x, me.pos.z - route.pts[3].z) < 1.5;
        }
        expect(top, `${route.name}: stopped at y ${me.pos.y.toFixed(2)} (${me.pos.x.toFixed(1)}, ${me.pos.z.toFixed(1)})`).toBe(true);
        expect(worst, `${route.name}: longest stall`).toBeLessThan(30);
        expect(events.some((e) => e.type === 'fall'), `${route.name}: fell`).toBe(false);
      }
    });
  }
});

describe('FallGuard', () => {
  const tower = OCEAN_STACKS[1]; // 180 deg, centre (-19, 0), radius 3.6, top 6.5

  it('is inactive on the colosseum', () => {
    const g = new FallGuard(COLOSSEUM_ARENA, 0.9, 4, 1);
    expect(g.active).toBe(false);
    const mv: Move2 = { x: 1, z: 0 };
    expect(g.guard(mv, 0, standing(0, 0))).toBe(false);
    expect(mv).toEqual({ x: 1, z: 0 });
  });

  it('an Apex at the rim, heading outward, is turned along the rim / back onto the platform; heading inward is untouched', () => {
    const g = new FallGuard(O, 0.9, 4, 1);
    const sx = tower.x - 2.9; // 0.7 m inside the rim on the outer (seabed) side
    const out: Move2 = { x: -1, z: 0 };
    expect(g.guard(out, 0, standing(sx, 0, -3, 0))).toBe(true);
    expect(g.deflected).toBe(true);
    // the new heading is free of a deadly drop for the next 2 m
    for (let s = 0.5; s <= 1.5; s += 0.5) {
      const y = arenaGroundHeight(O, sx + out.x * s, out.z * s);
      expect(6.5 - y, `s ${s}`).toBeLessThan(3.0);
    }
    const inward: Move2 = { x: 1, z: 0 };
    expect(g.guard(inward, 1, standing(sx, 0, 3, 0))).toBe(false);
    expect(inward).toEqual({ x: 1, z: 0 });
  });

  it('on the open plateau and the seabed it never interferes', () => {
    const g = new FallGuard(O, 0.9, 4, 1);
    for (const [x, z] of [
      [2, 2],
      [24, -3],
      [10, 0],
    ]) {
      const mv: Move2 = { x: 0.6, z: 0.8 };
      expect(g.guard(mv, 0, standing(x, z, 3, 3))).toBe(false);
    }
  });

  it('a Cub (blunder 0.3) now and then walks on over the edge; an Apex never does', () => {
    const sx = tower.x - 3.0;
    let cubWalked = 0;
    let cubTurned = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const cub = new FallGuard(O, 0.9, 1, seed);
      const mv: Move2 = { x: -1, z: 0 };
      if (cub.guard(mv, 5, standing(sx, 0, -3, 0))) cubTurned++;
      else cubWalked++;
      const apex = new FallGuard(O, 0.9, 4, seed);
      const mv2: Move2 = { x: -1, z: 0 };
      expect(apex.guard(mv2, 5, standing(sx, 0, -3, 0))).toBe(true);
    }
    expect(FALL_AI[1].blunderChance).toBeGreaterThan(FALL_AI[2].blunderChance);
    expect(FALL_AI[3].blunderChance + FALL_AI[4].blunderChance).toBe(0);
    expect(cubWalked).toBeGreaterThanOrEqual(8);
    expect(cubTurned).toBeGreaterThanOrEqual(25);
  });

  it('dropAhead: a charge across the tower top towards the rim is held back, one along the middle is not, the plateau never', () => {
    const g = new FallGuard(O, 1.2, 4, 1);
    const me = standing(tower.x + 1.2, 0);
    // aim -x (yaw = atan2(dx, dz) = -pi/2): 12 m from 1.2 m inside the +x side runs over the far rim
    expect(g.dropAhead(me, -Math.PI / 2, 12)).toBe(true);
    expect(g.dropAhead(me, -Math.PI / 2, 2)).toBe(false);
    expect(g.dropAhead(me, Math.PI / 2, 0)).toBe(false); // an ability that does not move the caster
    expect(g.dropAhead(standing(0, 0), 0, 12)).toBe(false);
  });
});

interface Run {
  reached: number;
  falls: number;
  worstStall: number;
  maxY: number;
  end: { x: number; y: number; z: number };
  events: GameEvent[];
}

/**
 * One bot (via BotManager) against an idle dummy: the bot starts at `from` (default its seabed seat), the dummy stands at `to`.
 * Stops when the bot is within reach of the dummy on its level.
 */
function runBot(
  animal: AnimalId,
  level: Difficulty,
  seed: number,
  to: { x: number; z: number },
  from?: { x: number; z: number },
  maxS = 40,
): Run {
  const cfg: MatchConfig = {
    roster: [
      { animal, isPlayer: false },
      { animal: 'rhino', isPlayer: true },
    ],
    difficulty: level,
    arena: 'ocean',
  };
  const bus = new EventBus();
  const events: GameEvent[] = [];
  bus.onAny((e) => events.push(e));
  const world = new World(cfg, seed, bus, { traps: false, serpent: { chance: 0, intervalS: 1e9 } });
  const bots = new BotManager(bus, level, seed, world.arena);
  const bot = world.fighters[0].state;
  const dummy = world.fighters[1].state;
  dummy.pos.x = to.x;
  dummy.pos.z = to.z;
  dummy.pos.y = arenaGroundHeight(O, to.x, to.z);
  dummy.hp = dummy.maxHp = 1e6;
  if (from !== undefined) {
    bot.pos.x = from.x;
    bot.pos.z = from.z;
    bot.pos.y = arenaGroundHeight(O, from.x, from.z);
    world.fighters[0].lastGroundY = bot.pos.y;
  }
  let ax = bot.pos.x;
  let az = bot.pos.z;
  let stall = 0;
  let worstStall = 0;
  let maxY = 0;
  let reached = -1;
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
    if (Math.abs(bot.pos.y - dummy.pos.y) < 0.3 && Math.hypot(bot.pos.x - to.x, bot.pos.z - to.z) < ANIMALS[animal].range + 2.5) {
      reached = world.time;
      break;
    }
  }
  return {
    reached,
    falls: events.filter((e) => e.type === 'fall').length,
    worstStall,
    maxY,
    end: { x: bot.pos.x, y: bot.pos.y, z: bot.pos.z },
    events,
  };
}

describe('bots climb to the towers by the ramps (real BotBrains)', () => {
  const cases: [AnimalId, Difficulty][] = [
    ['hippo', 3],
    ['rhino', 4],
    ['giraffe', 2],
    ['mole', 3],
    ['panther', 4],
  ];
  for (const [animal, level] of cases) {
    it(`${animal} (L${level}) reaches a dummy on each tower top: no fall, no wedge`, () => {
      for (const pad of TOWER_PADS) {
        const p = O.pickupPads[pad];
        const r = runBot(animal, level, 300 + pad + level, p, undefined, 40);
        expect(r.reached, `pad ${pad}: maxY ${r.maxY.toFixed(1)}, ended (${r.end.x.toFixed(1)}, ${r.end.y.toFixed(1)}, ${r.end.z.toFixed(1)})`).toBeGreaterThan(0);
        expect(r.maxY).toBeGreaterThan(6.0);
        expect(r.falls, `pad ${pad}`).toBe(0);
        expect(r.worstStall, `pad ${pad}`).toBeLessThan(120);
      }
    }, 60000);
  }

  it('a Cub also gets up there (late re-plans, no berth)', () => {
    const r = runBot('lion', 1, 5, O.pickupPads[2], undefined, 60);
    expect(r.reached, `maxY ${r.maxY.toFixed(1)} fell ${r.falls}`).toBeGreaterThan(0);
    expect(r.worstStall).toBeLessThan(300);
  }, 60000);
});

describe('bots come down by the ramp, never by the edge (Veteran / Apex)', () => {
  for (const level of [3, 4] as Difficulty[]) {
    it(`L${level}: from each tower top to a dummy at its foot on the seabed - no fall`, () => {
      for (const pad of TOWER_PADS) {
        const s = OCEAN_STACKS[pad - 1];
        // the dummy waits on the seabed just outside the tower: straight down is a 6.5 m drop, the ramp is 50 m away
        const a = (s.deg * Math.PI) / 180;
        const to = { x: Math.cos(a) * 26, z: Math.sin(a) * 26 };
        const r = runBot(level === 3 ? 'lion' : 'gorilla', level, 40 + pad, to, { x: s.x, z: s.z }, 45);
        expect(r.falls, `pad ${pad}: ended (${r.end.x.toFixed(1)}, ${r.end.y.toFixed(1)}, ${r.end.z.toFixed(1)})`).toBe(0);
        expect(r.reached, `pad ${pad}`).toBeGreaterThan(0);
        expect(r.worstStall).toBeLessThan(120);
      }
    }, 90000);
  }

  it('a bot standing 0.5 m from the rim with its foe 3 m below walks away from the edge (L3 / L4)', () => {
    for (const level of [3, 4] as Difficulty[]) {
      const s = OCEAN_STACKS[1]; // 180 deg: outside the tower is the seabed
      const r = runBot('hippo', level, 9, { x: s.x - 6.2, z: 0 }, { x: s.x - 3.1, z: 0 }, 8);
      expect(r.falls, `L${level}`).toBe(0);
    }
  }, 60000);
});

describe('the pull towards the upper pads', () => {
  /** A bot hurt to 90 % with every pad but one tower pad switched off and its only foe in stealth: does it pick the pad up? */
  function pickedUp(level: Difficulty, seed: number): boolean {
    const cfg: MatchConfig = {
      roster: [
        { animal: 'lion', isPlayer: false },
        { animal: 'panther', isPlayer: true },
      ],
      difficulty: level,
      arena: 'ocean',
    };
    const bus = new EventBus();
    let got = false;
    bus.on('pickup', (e) => {
      if (e.fighterId === 0 && e.pos.y > 6) got = true;
    });
    const world = new World(cfg, seed, bus, { traps: false, serpent: { chance: 0, intervalS: 1e9 } });
    const w = world as unknown as { pickups: { id: number; active: boolean; respawnT: number }[] };
    for (const p of w.pickups) {
      if (p.id !== 3) {
        p.active = false;
        p.respawnT = 1e9;
      }
    }
    const bots = new BotManager(bus, level, seed, world.arena);
    const bot = world.fighters[0].state;
    bot.hp = bot.maxHp * 0.9; // wants a heal; the L2-L4 policies take any pad of the right kind
    addBuff(world.fighters[1], 'stealth', 0, 1e6); // the only other fighter is invisible to the bot: nothing to fight, so it collects pads
    world.fighters[1].state.pos.x = -24;
    world.fighters[1].state.pos.z = 0;
    world.fighters[1].state.pos.y = 0;
    for (let tick = 0; tick < 60 * 40 && !got; tick++) {
      bots.update(world.snapshot(), DT);
      world.setIntent(0, bots.getIntent(0));
      world.setIntent(1, IDLE);
      world.step(DT);
    }
    return got;
  }

  it('Veteran and Apex climb for a tower pad when it is quiet; a Cub (pickups ignored) does not', () => {
    let l1 = 0;
    let l3 = 0;
    let l4 = 0;
    for (let seed = 1; seed <= 4; seed++) {
      if (pickedUp(1, seed)) l1++;
      if (pickedUp(3, seed)) l3++;
      if (pickedUp(4, seed)) l4++;
    }
    expect(l1).toBe(0);
    expect(l3).toBeGreaterThanOrEqual(2);
    expect(l4).toBeGreaterThanOrEqual(2);
  }, 120000);
});
