/**
 * v1.8 WP-J2: bot terrain awareness (moss patches + the shallow pool of the Jungle Clearing).
 *
 * Unit tests pin the geometry of `TerrainSense` (path bending, exits, the soft wall, flight, patrol); the bot-state tests run real
 * `World` + `BotManager` scenarios on the jungle and read the sim's own `inWater` / `onMoss` flags. The colosseum has no terrain,
 * so there every method must be a no-op (its byte-identical behaviour is proven by the unchanged AI suites + the sweep / per-tick
 * hash baseline, see docs/BALANCE.md).
 */

import { describe, it, expect } from 'vitest';
import { World } from '../../src/sim/World';
import { EventBus } from '../../src/core/EventBus';
import { BotManager } from '../../src/ai/BotManager';
import { BotBrain } from '../../src/ai/BotBrain';
import { TerrainSense, TERRAIN_AI, GOOD_SWIMMER_MULT, POOR_SWIMMER_MULT } from '../../src/ai/TerrainSense';
import type { Move2 } from '../../src/ai/Steering';
import { BOT_PROFILES } from '../../src/config/botProfiles';
import { COLOSSEUM_ARENA, JUNGLE_ARENA as J } from '../../src/config/arenas';
import { ANIMAL_IDS, ANIMALS } from '../../src/config/animals';
import { waterSpeedMultiplier } from '../../src/config/terrain';
import type { AnimalId, Difficulty, MatchConfig } from '../../src/core/types';
import { disablePickups } from '../sim/helpers';
import { DT } from './helpers';

const POOL = J.terrain.find((z) => z.kind === 'water')!;

function sense(animal: AnimalId, level: Difficulty, arena = J, id = 0): TerrainSense {
  return new TerrainSense(arena, animal, level, id);
}

function mv(x = 0, z = 0): Move2 {
  return { x, z };
}

describe('TerrainSense — classification and knobs', () => {
  it('is inactive on the colosseum and every method is a no-op there', () => {
    const s = sense('giraffe', 4, COLOSSEUM_ARENA);
    expect(s.active).toBe(false);
    const out = mv(1, 0);
    expect(s.plan(out, 0, -12, 3, 12, 3)).toBe(false);
    expect(out).toEqual({ x: 1, z: 0 });
    expect(s.guard(out, 0, -8, 0, false)).toBe(false);
    expect(s.exitVector(out, 0, 0)).toBe(false);
    expect(s.wantsOut(true, true, true)).toBe(false);
    expect(s.inSlowTerrain(0, 0)).toBe(false);
    s.fleePlan(out, 0, 0, 0, 'lion');
    expect(out).toEqual({ x: 1, z: 0 });
    // the colosseum's no-contact drift is still the centre
    expect(s.driftPoint(10, 0)).toEqual({ x: 0, z: 0 });
    expect(s.driftPoint(2, 0)).toBeNull();
  });

  it('good / poor swimmers follow the swim attribute (croc, hippo, python good; giraffe, gorilla, rhino, eagle poor)', () => {
    const good = ANIMAL_IDS.filter((a) => sense(a as AnimalId, 4).goodSwimmer);
    const poor = ANIMAL_IDS.filter((a) => sense(a as AnimalId, 4).poorSwimmer);
    expect([...good].sort()).toEqual(['crocodile', 'hippo', 'python']);
    expect([...poor].sort()).toEqual(['eagle', 'giraffe', 'gorilla', 'rhino']);
    for (const a of ANIMAL_IDS as readonly AnimalId[]) {
      const m = waterSpeedMultiplier(a);
      expect(sense(a, 4).goodSwimmer).toBe(m >= GOOD_SWIMMER_MULT);
      expect(sense(a, 4).poorSwimmer).toBe(m < POOR_SWIMMER_MULT);
    }
  });

  it('the difficulty ladder is monotonic: L1 ignorant, L4 clever', () => {
    const L = [1, 2, 3, 4].map((d) => TERRAIN_AI[d as Difficulty]);
    expect(L[0]).toMatchObject({ detourWeight: 0, edgeHoldS: 0, exitIdle: false, fleeSmart: false, targetBias: 0 });
    for (let i = 1; i < 4; i++) {
      expect(L[i].detourWeight).toBeGreaterThanOrEqual(L[i - 1].detourWeight);
      expect(L[i].edgeHoldS).toBeGreaterThanOrEqual(L[i - 1].edgeHoldS);
      expect(L[i].targetBias).toBeGreaterThanOrEqual(L[i - 1].targetBias);
    }
    expect(L[1].edgeHoldS).toBe(0); // Fighters do not plan fights round terrain
    expect(L[2].fleeSmart && L[3].fleeSmart).toBe(true);
    expect(L[3].edgeHoldS).toBeGreaterThan(L[2].edgeHoldS);
  });
});

describe('TerrainSense.plan — path cost round the pool', () => {
  // Start west of the pool, goal east of it, the straight line crosses the pool 3 m north of its centre (a 11.5 m wet chord).
  const S = { x: -12, z: 3 };
  const G = { x: 12, z: 3 };

  function headingFor(animal: AnimalId, level: Difficulty): { bent: boolean; out: Move2 } {
    const out = mv(1, 0);
    const bent = sense(animal, level).plan(out, 0, S.x, S.z, G.x, G.z);
    return { bent, out };
  }

  it('Apex slow swimmers walk round the pool (heading bends toward the tangent, away from the water)', () => {
    for (const a of ['giraffe', 'gorilla', 'rhino'] as AnimalId[]) {
      const { bent, out } = headingFor(a, 4);
      expect(bent, a).toBe(true);
      expect(Math.hypot(out.x, out.z)).toBeCloseTo(1, 6);
      // the pool lies south-east of the line's start (centre at (0,0), line at z=+3): the detour passes NORTH of the pool
      expect(out.z, a).toBeGreaterThan(0.25);
    }
  });

  it('Apex crocodile swims straight through (cost ~1.05 per metre is cheaper than any detour)', () => {
    const { bent, out } = headingFor('crocodile', 4);
    expect(bent).toBe(false);
    expect(out).toEqual({ x: 1, z: 0 });
  });

  it('Cubs ignore the terrain entirely', () => {
    for (const a of ANIMAL_IDS as readonly AnimalId[]) {
      const { bent, out } = headingFor(a, 1);
      expect(bent, a).toBe(false);
      expect(out).toEqual({ x: 1, z: 0 });
    }
  });

  it('the better the swimmer, the less it detours (monotone in the swim attribute)', () => {
    const bends = (['crocodile', 'hippo', 'python', 'panther', 'mole', 'lion', 'rhino', 'gorilla', 'giraffe'] as AnimalId[]).map((a) => {
      const { bent, out } = headingFor(a, 4);
      return bent ? Math.abs(out.z) : 0;
    });
    for (let i = 1; i < bends.length; i++) expect(bends[i]).toBeGreaterThanOrEqual(bends[i - 1] - 1e-9);
    expect(bends[bends.length - 1]).toBeGreaterThan(bends[0]);
  });

  it('Fighters (L2) count half the cost: a clear detour is still taken by the slowest swimmer', () => {
    expect(headingFor('giraffe', 2).bent).toBe(true);
    expect(headingFor('crocodile', 2).bent).toBe(false);
  });

  it('a line that misses the pool is left alone', () => {
    const out = mv(0, 1);
    expect(sense('giraffe', 4).plan(out, 0, 14, -6, 14, 8)).toBe(false);
    expect(out).toEqual({ x: 0, z: 1 });
  });

  it('a moss patch on the path is walked round too, with a bigger bend for a line through its middle than for a graze', () => {
    // moss (5.1, 8.6) r 2.6 (+ the lion's body radius): through the middle vs a 0.3 m graze of its edge
    const through = mv(1, 0);
    expect(sense('lion', 4).plan(through, 0, -4, 8.6, 14, 8.6)).toBe(true);
    const graze = mv(1, 0);
    const lionR = ANIMALS.lion.radius;
    const zg = 8.6 + 2.6 + lionR - 0.3;
    expect(sense('lion', 4).plan(graze, 0, -4, zg, 14, zg)).toBe(true);
    expect(Math.abs(through.z)).toBeGreaterThan(Math.abs(graze.z));
    // Cubs walk straight across it
    const cub = mv(1, 0);
    expect(sense('lion', 1).plan(cub, 0, -4, 8.6, 14, 8.6)).toBe(false);
  });

  it('inside the pool with the goal outside: head for the cheapest rim point (slow swimmer leaves, croc just keeps going)', () => {
    const out = mv(1, 0);
    expect(sense('giraffe', 4).plan(out, 0, 2, 0, 20, 0)).toBe(true);
    expect(out.x).toBeGreaterThan(0.9); // east, toward the near rim in the goal's direction
    const out2 = mv(1, 0);
    expect(sense('giraffe', 4).plan(out2, 0, 2, 0, 0, 20)).toBe(true);
    expect(out2.z).toBeGreaterThan(0.5);
  });

  it('a goal inside the pool is not planned round (the fight decides)', () => {
    const out = mv(1, 0);
    expect(sense('giraffe', 4).plan(out, 0, -12, 0, 0, 0)).toBe(false);
    expect(out).toEqual({ x: 1, z: 0 });
  });
});

describe('TerrainSense.guard — the soft wall at the water\'s edge', () => {
  const rimX = -(POOL.radius + 0.6); // 0.6 m outside the pool's edge, west of the pool

  it('slides a poor swimmer along the shore instead of letting it walk in, then commits after the patience', () => {
    const s = sense('gorilla', 4);
    const patience = TERRAIN_AI[4].edgeHoldS;
    let t = 0;
    const out = mv(1, 0);
    expect(s.guard(out, t, rimX, 0, false)).toBe(true);
    expect(out).toEqual({ x: 0, z: 0 }); // heading straight in: nothing left but a hold
    // a diagonal approach keeps its along-shore component
    const diag = mv(Math.SQRT1_2, Math.SQRT1_2);
    expect(s.guard(diag, 0.1, rimX, 0, false)).toBe(true);
    expect(Math.abs(diag.x)).toBeLessThan(0.1);
    expect(diag.z).toBeGreaterThan(0.9);
    // patience runs out: the wall drops
    for (t = 0.2; t < patience - 0.05; t += 0.1) expect(s.guard(mv(1, 0), t, rimX, 0, false)).toBe(true);
    s.guard(mv(1, 0), patience + 0.05, rimX, 0, false);
    const free = mv(1, 0);
    expect(s.guard(free, patience + 0.2, rimX, 0, false)).toBe(false);
    expect(free).toEqual({ x: 1, z: 0 });
    // ... and stays down for the commit window, then comes back
    expect(s.guard(mv(1, 0), patience + 5, rimX, 0, false)).toBe(false);
    expect(s.guard(mv(1, 0), patience + 7, rimX, 0, false)).toBe(true);
  });

  it('never stops a good swimmer at the water (croc, hippo, python), nor a bot already in range', () => {
    for (const a of ['crocodile', 'hippo', 'python'] as AnimalId[]) {
      const out = mv(1, 0);
      expect(sense(a, 4).guard(out, 0, rimX, 0, false), a).toBe(false);
      expect(out, a).toEqual({ x: 1, z: 0 });
    }
    // a poor swimmer whose target is already in reach just stands (no walking into the water)
    const out = mv(1, 0);
    expect(sense('gorilla', 4).guard(out, 0, rimX, 0, true)).toBe(true);
    expect(out).toEqual({ x: 0, z: 0 });
  });

  it('Cubs and Fighters have no wall', () => {
    for (const d of [1, 2] as Difficulty[]) {
      const out = mv(1, 0);
      expect(sense('gorilla', d).guard(out, 0, rimX, 0, false)).toBe(false);
      expect(out).toEqual({ x: 1, z: 0 });
    }
  });

  it('moss is a soft wall for every animal from Veteran up (a short hold)', () => {
    const m = J.terrain.find((z) => z.kind === 'moss' && z.x === 5.1)!;
    const sx = m.x - (m.radius + 0.8 + 0.9); // just west of the patch, heading east into it
    for (const a of ['lion', 'crocodile', 'giraffe'] as AnimalId[]) {
      const out = mv(1, 0);
      expect(sense(a, 3).guard(out, 0, sx, m.z, false), a).toBe(true);
      expect(out, a).toEqual({ x: 0, z: 0 });
    }
  });
});

describe('TerrainSense — flight, exits, patrol and targeting', () => {
  it('a hurt crocodile flees THROUGH the pool away from a gorilla; a giraffe never does', () => {
    // fleeing east from a pursuer in the west; the pool is dead ahead
    const croc = mv(1, 0);
    sense('crocodile', 3).fleePlan(croc, 0, -9, 0, 'gorilla');
    expect(croc.x).toBeGreaterThan(0.95); // straight at the pool's far side
    // a giraffe fleeing from a lion with the pool ahead bends round it
    const gir = mv(1, 0);
    sense('giraffe', 3).fleePlan(gir, 0, -9, 1.5, 'lion');
    expect(Math.abs(gir.z)).toBeGreaterThan(0.15);
    // a croc does not make a 'through the pool' flight from another good swimmer
    const croc2 = mv(1, 0);
    sense('crocodile', 3).fleePlan(croc2, 0, -9, 1.5, 'hippo');
    expect(croc2.x).toBeGreaterThan(0.9);
  });

  it('fleePlan does nothing for Cubs and Fighters', () => {
    for (const d of [1, 2] as Difficulty[]) {
      const out = mv(1, 0);
      sense('giraffe', d).fleePlan(out, 0, -9, 1.5, 'lion');
      expect(out).toEqual({ x: 1, z: 0 });
    }
  });

  it('exitVector points radially out of the pool (and out of a moss patch)', () => {
    const out = mv(0, 0);
    const s = sense('rhino', 4);
    expect(s.exitVector(out, 3, 0)).toBe(true);
    expect(out.x).toBeCloseTo(1, 6);
    expect(s.exitVector(out, 0, -4)).toBe(true);
    expect(out.z).toBeCloseTo(-1, 6);
    const m = J.terrain.find((z) => z.kind === 'moss' && z.x === 5.1)!;
    expect(s.exitVector(out, m.x + 0.5, m.z)).toBe(true);
    expect(out.x).toBeGreaterThan(0.9);
    expect(s.exitVector(out, -15, 15)).toBe(false); // dry
  });

  it('wantsOut: moss is always left, the pool by everyone but a healthy fast swimmer', () => {
    expect(sense('lion', 4).wantsOut(false, true, false)).toBe(true);
    expect(sense('lion', 4).wantsOut(true, false, false)).toBe(true);
    expect(sense('crocodile', 4).wantsOut(true, false, false)).toBe(false);
    expect(sense('crocodile', 4).wantsOut(true, false, true)).toBe(true); // hurt: never idle in the pool
    expect(sense('lion', 1).wantsOut(true, true, true)).toBe(false); // Cubs stay put
  });

  it('the no-contact drift rallies on a dry ring round the pool and patrols it (alternating direction by id)', () => {
    const ring = POOL.radius + 3.4;
    const s0 = sense('lion', 4, J, 0);
    const s1 = sense('lion', 4, J, 1);
    // far away: head for the ring along the same bearing
    const far = s0.driftPoint(0, 25)!;
    expect(Math.hypot(far.x, far.z)).toBeGreaterThan(ring - 1.2);
    expect(Math.hypot(far.x, far.z)).toBeLessThan(ring + 1.2);
    // on the ring: a patrol point further round, opposite ways for even and odd ids
    const on = { x: 0, z: ring };
    const p0 = s0.driftPoint(on.x, on.z)!;
    const p1 = s1.driftPoint(on.x, on.z)!;
    expect(Math.sign(p0.x)).toBe(-Math.sign(p1.x));
    // never inside the pool, a trunk or a moss patch
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const p = s0.driftPoint(Math.cos(a) * ring, Math.sin(a) * ring)!;
      expect(Math.hypot(p.x - POOL.x, p.z - POOL.z)).toBeGreaterThan(POOL.radius + 1);
      for (const t of J.circles) expect(Math.hypot(p.x - t.x, p.z - t.z)).toBeGreaterThan(t.radius + 0.8);
      for (const m of J.terrain.filter((z) => z.kind === 'moss')) expect(Math.hypot(p.x - m.x, p.z - m.z)).toBeGreaterThan(m.radius + 0.8);
    }
  });

  it('target bias: poor swimmers dislike a target in the pool, good swimmers like a slow swimmer in it (L3+ only)', () => {
    const base = { inWater: true, onMoss: false } as unknown as Parameters<TerrainSense['targetBias']>[0];
    const gorillaInPool = { ...base, animal: 'gorilla' } as typeof base;
    const crocInPool = { ...base, animal: 'crocodile' } as typeof base;
    expect(sense('rhino', 4).targetBias(gorillaInPool)).toBeLessThan(0);
    expect(sense('rhino', 4).targetBias({ ...gorillaInPool, inWater: false } as typeof base)).toBe(0);
    expect(sense('crocodile', 4).targetBias(gorillaInPool)).toBeGreaterThan(0);
    expect(sense('crocodile', 4).targetBias(crocInPool)).toBe(0);
    expect(sense('rhino', 2).targetBias(gorillaInPool)).toBe(0);
    expect(sense('rhino', 1).targetBias(gorillaInPool)).toBe(0);
    expect(sense('rhino', 4, COLOSSEUM_ARENA).targetBias(gorillaInPool)).toBe(0);
  });
});

// ── Bot-state scenarios (World + BotManager on the jungle) ───────────────────

interface Scene {
  world: World;
  bots: BotManager;
  step(): void;
  /** Fighter 0 = the bot under test, fighter 1 = an idle human-controlled dummy. */
  bot: World['fighters'][number];
  dummy: World['fighters'][number];
}

function scene(animal: AnimalId, level: Difficulty, botPos: { x: number; z: number }, dummyPos: { x: number; z: number }, dummyAnimal: AnimalId = 'lion'): Scene {
  const cfg: MatchConfig = {
    roster: [
      { animal, isPlayer: false },
      { animal: dummyAnimal, isPlayer: true },
    ],
    difficulty: level,
    arena: 'jungle',
  };
  const bus = new EventBus();
  const world = new World(cfg, 7, bus, { traps: false });
  disablePickups(world);
  world.fighters[0].state.pos = { x: botPos.x, y: 0, z: botPos.z };
  world.fighters[1].state.pos = { x: dummyPos.x, y: 0, z: dummyPos.z };
  const bots = new BotManager(bus, level, 7, world.arena);
  return {
    world,
    bots,
    bot: world.fighters[0],
    dummy: world.fighters[1],
    step() {
      bots.update(world.snapshot(), DT);
      world.setIntent(0, bots.getIntent(0));
      world.step(DT);
    },
  };
}

/** Seconds (sim time after the countdown) the bot spends inWater over `seconds`. */
function wetTime(animal: AnimalId, level: Difficulty, botPos: { x: number; z: number }, dummyPos: { x: number; z: number }, seconds: number): number {
  const sc = scene(animal, level, botPos, dummyPos);
  let wet = 0;
  const n = Math.ceil((seconds + 3.2) / DT);
  for (let i = 0; i < n; i++) {
    sc.step();
    if (sc.world.time > 0 && sc.bot.inWater) wet += DT;
  }
  return wet;
}

describe('bots across the jungle pool (World + BotManager)', () => {
  const west = { x: -14, z: 4 };
  const east = { x: 11, z: 4 };

  it('an Apex gorilla walks round the pool to reach a target on the far side; a Cub wades straight through', () => {
    const apex = wetTime('gorilla', 4, west, east, 7);
    const cub = wetTime('gorilla', 1, west, east, 7);
    expect(apex).toBeLessThan(0.3);
    expect(cub).toBeGreaterThan(1.5);
  });

  it('levels are ordered: the more skilled the bot, the less it wades on the same errand (giraffe)', () => {
    const t = ([1, 2, 3, 4] as Difficulty[]).map((d) => wetTime('giraffe', d, west, east, 9));
    expect(t[0]).toBeGreaterThan(t[3] + 1);
    expect(t[1]).toBeGreaterThan(t[3]);
    expect(t[2]).toBeLessThan(1.0);
    expect(t[3]).toBeLessThan(1.0);
  });

  it('an Apex crocodile crosses the pool (swimming costs it ~5 %)', () => {
    expect(wetTime('crocodile', 4, west, east, 6)).toBeGreaterThan(1.5);
  });

  it('a Veteran/Apex gorilla halts at the shore while its target stands in the pool, then commits after its patience', () => {
    for (const level of [3, 4] as Difficulty[]) {
      const patience = TERRAIN_AI[level].edgeHoldS;
      const sc = scene('gorilla', level, { x: 0, z: -13 }, { x: 0, z: 0 });
      let firstWet = -1;
      let firstHit = -1;
      sc.world.bus.on('hit', () => {
        if (firstHit < 0) firstHit = sc.world.time;
      });
      for (let i = 0; i < Math.ceil(20 / DT); i++) {
        sc.step();
        if (firstWet < 0 && sc.bot.inWater) firstWet = sc.world.time;
        if (firstHit >= 0) break;
      }
      // reaches the shore in ~1.5 s, waits `patience`, then wades in: nowhere near the water before that
      expect(firstWet, `L${level}`).toBeGreaterThan(patience + 0.5);
      expect(firstWet, `L${level}`).toBeLessThan(patience + 9);
      expect(firstHit, `L${level}`).toBeGreaterThan(firstWet);
    }
    // the Cub walks straight in
    const cub = scene('gorilla', 1, { x: 0, z: -13 }, { x: 0, z: 0 });
    let wet = -1;
    for (let i = 0; i < Math.ceil(8 / DT) && wet < 0; i++) {
      cub.step();
      if (cub.bot.inWater) wet = cub.world.time;
    }
    expect(wet).toBeGreaterThan(0);
    expect(wet).toBeLessThan(4);
  });

  it('a crocodile does not hold at the shore: it swims in to its target at once', () => {
    const sc = scene('crocodile', 4, { x: 0, z: -13 }, { x: 0, z: 0 });
    let wet = -1;
    for (let i = 0; i < Math.ceil(8 / DT) && wet < 0; i++) {
      sc.step();
      if (sc.bot.inWater) wet = sc.world.time;
    }
    expect(wet).toBeGreaterThan(0);
    expect(wet).toBeLessThan(3.5);
  });

  it('a slow swimmer standing in the pool with nobody to fight wades out (Veteran / Apex)', () => {
    for (const level of [3, 4] as Difficulty[]) {
      // the dummy is hidden behind a tree at (-9.5,-0.3), so the bot has no live target while standing in the pool
      const sc = scene('rhino', level, { x: 1, z: 3 }, { x: -12.3, z: -0.6 });
      let left = -1;
      for (let i = 0; i < Math.ceil(12 / DT); i++) {
        sc.step();
        if (sc.world.time > 0 && !sc.bot.inWater && left < 0) left = sc.world.time;
      }
      expect(left, `L${level}`).toBeGreaterThan(0);
      expect(left, `L${level}`).toBeLessThan(6);
    }
  });

  it('bots never press jump while wading (no hop-chaining across the pool)', () => {
    let hops = 0;
    let wetTicks = 0;
    for (const a of ['gorilla', 'giraffe', 'lion', 'mole'] as AnimalId[]) {
      for (const level of [1, 2, 3, 4] as Difficulty[]) {
        const sc = scene(a, level, west, east);
        for (let i = 0; i < Math.ceil(12 / DT); i++) {
          sc.step();
          if (sc.bot.inWater) {
            wetTicks++;
            if (sc.bots.getIntent(0).jump) hops++;
          }
        }
      }
    }
    expect(wetTicks).toBeGreaterThan(100);
    expect(hops).toBe(0);
  });
});

describe('bot brains on the colosseum carry no terrain state', () => {
  it('the TerrainSense of a colosseum brain is inactive and changes nothing', () => {
    const b = new BotBrain(1, 'lion', BOT_PROFILES[4], 5, COLOSSEUM_ARENA) as unknown as { sense: TerrainSense };
    expect(b.sense.active).toBe(false);
    const j = new BotBrain(1, 'lion', BOT_PROFILES[4], 5, J) as unknown as { sense: TerrainSense };
    expect(j.sense.active).toBe(true);
  });
});
