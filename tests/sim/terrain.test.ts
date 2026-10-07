/**
 * v1.8 TerrainSystem (docs/JUNGLE-PLAN.md): moss slow + linger, the shallow pool (`inWater`, per-animal swim multiplier,
 * shoreline hysteresis), flyers / burrowed fighters unaffected, `splash` events, snapshot flags, the colosseum untouched.
 * Part 1 runs the system on a bare Sim (exact numbers); part 2 runs the real World on the jungle (locomotion, abilities,
 * ultimates and the mole's Burrow rule).
 */

import { describe, it, expect } from 'vitest';
import { Fighter } from '../../src/sim/Fighter';
import { TerrainSystem } from '../../src/sim/TerrainSystem';
import { ANIMALS, ANIMAL_IDS } from '../../src/config/animals';
import { COLOSSEUM_ARENA, JUNGLE_ARENA as J, JUNGLE_POOL_DEPTH, JUNGLE_POOL_RADIUS } from '../../src/config/arenas';
import { MOSS_SPEED_MULT, TERRAIN, splashStrength, waterSpeedMultiplier } from '../../src/config/terrain';
import type { AnimalId, FighterIntent, GameEvent, GameEventOf } from '../../src/core/types';
import { DT, disablePickups, liveWorld, makeSim, neutral } from './helpers';
import { minSurfaceDist, terrainDist } from '../config/arenaGeom';

const POOL = J.terrain.find((z) => z.kind === 'water')!;
const MOSS = J.terrain.filter((z) => z.kind === 'moss');
const M0 = MOSS[0]; // (6.8, -22.4) r 3.4 — nothing else near it
const R = JUNGLE_POOL_RADIUS;

type Splash = GameEventOf<'splash'>;
const splashes = (evs: GameEvent[]): Splash[] => evs.filter((e): e is Splash => e.type === 'splash');

function jf(id: number, animal: AnimalId, x: number, z: number, y = 0): Fighter {
  return new Fighter(id, animal, ANIMALS[animal], id === 0, { x, y, z }, 0, J);
}

/** A bare Sim + the jungle's TerrainSystem; `step(n)` runs n ticks of the system alone. */
function rig(...fs: Fighter[]) {
  const events: GameEvent[] = [];
  const sim = makeSim(fs, events);
  const ts = new TerrainSystem(J);
  return {
    sim,
    ts,
    events,
    step(n = 1): void {
      for (let i = 0; i < n; i++) ts.step(sim, DT);
    },
  };
}

describe('TerrainSystem — moss', () => {
  it('slows a grounded fighter whose BODY overlaps a patch by exactly 35 %, and not one a hair outside', () => {
    const lion = jf(0, 'lion', M0.x + M0.radius + ANIMALS.lion.radius - 0.01, M0.z);
    const out = jf(1, 'lion', M0.x + M0.radius + ANIMALS.lion.radius + 0.01, M0.z);
    const r = rig(lion, out);
    r.step();
    expect(lion.onMoss).toBe(true);
    expect(lion.inWater).toBe(false);
    expect(lion.terrainSpeedMult).toBeCloseTo(0.65, 12);
    expect(lion.terrainSpeedMult).toBe(MOSS_SPEED_MULT);
    expect(out.onMoss).toBe(false);
    expect(out.terrainSpeedMult).toBe(1);
    expect(r.events).toHaveLength(0); // moss emits nothing
  });

  it('every animal is slowed equally on moss (no per-animal moss factor)', () => {
    const fs = ANIMAL_IDS.map((a, i) => jf(i, a, M0.x, M0.z));
    const r = rig(...fs);
    r.step();
    for (const f of fs) expect(f.terrainSpeedMult, f.def.id).toBeCloseTo(0.65, 12);
  });

  it('the slow lingers 0.4 s after the body leaves the patch, then drops', () => {
    const f = jf(0, 'gorilla', M0.x, M0.z);
    const r = rig(f);
    r.step();
    expect(f.terrainSpeedMult).toBeCloseTo(0.65, 12);
    f.state.pos.x = M0.x + M0.radius + 5; // well off the patch
    const ticks = Math.round(TERRAIN.moss.lingerS / DT);
    r.step(ticks - 2);
    expect(f.onMoss).toBe(false);
    expect(f.terrainSpeedMult).toBeCloseTo(0.65, 12); // still clinging
    r.step(4);
    expect(f.terrainSpeedMult).toBe(1);
    expect(f.mossLingerT).toBe(0);
  });

  it('re-entering the patch refreshes the linger', () => {
    const f = jf(0, 'lion', M0.x, M0.z);
    const r = rig(f);
    r.step();
    f.state.pos.x = M0.x + M0.radius + 5;
    r.step(15);
    f.state.pos.x = M0.x;
    r.step();
    expect(f.mossLingerT).toBe(TERRAIN.moss.lingerS);
    f.state.pos.x = M0.x + M0.radius + 5;
    r.step(20);
    expect(f.terrainSpeedMult).toBeCloseTo(0.65, 12); // 0.33 s since leaving: still < 0.4
  });

  it('flyers and high jumps are not slowed: unaffected above the grounded line, affected at or below it', () => {
    const eagle = jf(0, 'eagle', M0.x, M0.z, 1.6); // gliding height
    const high = jf(1, 'lion', M0.x, M0.z, TERRAIN.groundedAlt + 0.01);
    const low = jf(2, 'lion', M0.x + 0.2, M0.z, TERRAIN.groundedAlt);
    const r = rig(eagle, high, low);
    r.step(5);
    for (const f of [eagle, high]) {
      expect(f.onMoss, f.def.id).toBe(false);
      expect(f.terrainSpeedMult, f.def.id).toBe(1);
    }
    expect(low.onMoss).toBe(true);
    expect(low.terrainSpeedMult).toBeCloseTo(0.65, 12);
  });

  it('a jump off the patch frees the fighter at once (the linger is dropped while ungrounded)', () => {
    const f = jf(0, 'lion', M0.x, M0.z);
    const r = rig(f);
    r.step(3);
    expect(f.terrainSpeedMult).toBeCloseTo(0.65, 12);
    f.state.pos.y = 1.0;
    r.step();
    expect(f.terrainSpeedMult).toBe(1);
    expect(f.mossLingerT).toBe(0);
    f.state.pos.y = 0; // lands back on the patch: slowed again
    r.step();
    expect(f.terrainSpeedMult).toBeCloseTo(0.65, 12);
  });

  it('burrowed and untargetable fighters are unaffected', () => {
    const burrowed = jf(0, 'mole', M0.x, M0.z);
    burrowed.state.burrowT = 2;
    const ghost = jf(1, 'eagle', M0.x + 0.3, M0.z);
    ghost.untargetable = true;
    const r = rig(burrowed, ghost);
    r.step(3);
    for (const f of [burrowed, ghost]) {
      expect(f.onMoss, f.def.id).toBe(false);
      expect(f.terrainSpeedMult, f.def.id).toBe(1);
    }
  });
});

describe('TerrainSystem — the shallow pool', () => {
  it('sets inWater when the CENTRE is inside the disc, with the per-animal swim multiplier', () => {
    const fs = ANIMAL_IDS.map((a, i) => jf(i, a, POOL.x + 0.1 * i, POOL.z));
    const r = rig(...fs);
    r.step();
    for (const f of fs) {
      expect(f.inWater, f.def.id).toBe(true);
      expect(f.onMoss, f.def.id).toBe(false);
      expect(f.terrainSpeedMult, f.def.id).toBe(waterSpeedMultiplier(f.def.id as AnimalId));
      expect(f.terrainSpeedMult, f.def.id).toBeGreaterThanOrEqual(0.3);
      expect(f.terrainSpeedMult, f.def.id).toBeLessThanOrEqual(1);
    }
    // the body edge touching the water is not enough: only the centre counts
    const edge = jf(0, 'hippo', POOL.x + R + 1.0, POOL.z); // body (1.2) reaches into the pool, centre outside
    const r2 = rig(edge);
    r2.step();
    expect(edge.inWater).toBe(false);
    expect(edge.terrainSpeedMult).toBe(1);
  });

  it('shoreline hysteresis: enters at R, only leaves beyond R + 0.15, no flicker, one splash each way', () => {
    const f = jf(0, 'lion', POOL.x + R + 0.05, POOL.z); // just outside
    const r = rig(f);
    r.step();
    expect(f.inWater).toBe(false);
    f.state.pos.x = POOL.x + R - 0.01; // steps in
    r.step();
    expect(f.inWater).toBe(true);
    // wobble around the shoreline inside the hysteresis band: stays in
    for (const dx of [0.05, 0.12, 0.02, 0.14, 0.09]) {
      f.state.pos.x = POOL.x + R + dx;
      r.step();
      expect(f.inWater, `dx ${dx}`).toBe(true);
    }
    f.state.pos.x = POOL.x + R + TERRAIN.water.shorelineHysteresis + 0.02; // past the band: out
    r.step();
    expect(f.inWater).toBe(false);
    // and coming back needs R again, not R + band
    f.state.pos.x = POOL.x + R + 0.1;
    r.step();
    expect(f.inWater).toBe(false);
    const sp = splashes(r.events);
    expect(sp.map((s) => s.entering)).toEqual([true, false]);
  });

  it('emits one splash when entering and one when leaving, at the water surface, with a strength from the speed', () => {
    // 6 m/s in, 7 m/s out, moved by exactly speed × dt per tick (the strength uses the larger of velocity and displacement)
    const f = jf(0, 'panther', POOL.x + R + 0.05, POOL.z);
    f.state.vel.x = -6;
    const r = rig(f);
    r.step();
    expect(r.events).toHaveLength(0);
    f.state.pos.x -= 6 * DT; // R - 0.05: inside
    r.step();
    f.state.vel.x = 7;
    f.state.pos.x += 7 * DT; // R + 0.067: inside the hysteresis band, still wading
    r.step();
    expect(f.inWater).toBe(true);
    f.state.pos.x += 7 * DT; // R + 0.183: out
    r.step();
    r.step(5);
    const sp = splashes(r.events);
    expect(sp).toHaveLength(2);
    expect(sp[0]).toMatchObject({ type: 'splash', fighterId: 0, entering: true });
    expect(sp[0].strength).toBeCloseTo(splashStrength(6, 0), 9);
    expect(sp[0].pos.y).toBe(JUNGLE_POOL_DEPTH);
    expect(sp[0].pos.x).toBeCloseTo(POOL.x + R + 0.05 - 6 * DT, 12);
    expect(sp[1]).toMatchObject({ type: 'splash', fighterId: 0, entering: false });
    expect(sp[1].strength).toBeCloseTo(splashStrength(7, 0), 9);
    // a faster, harder entry splashes harder
    expect(splashStrength(7, 0)).toBeGreaterThan(splashStrength(0, 0));
  });

  it('ability-driven entries (vel stays 0) use the real displacement: a lunge into the pool splashes hard', () => {
    const f = jf(0, 'crocodile', POOL.x + R + 0.5, POOL.z);
    const r = rig(f);
    r.step();
    f.state.pos.x -= 14 * DT * 4; // a 14 m/s dash covers 0.93 m per tick; two ticks to get in
    r.step();
    f.state.pos.x -= 14 * DT;
    r.step();
    expect(f.state.vel.x).toBe(0);
    const sp = splashes(r.events);
    expect(sp).toHaveLength(1);
    expect(sp[0].entering).toBe(true);
    expect(sp[0].strength).toBeGreaterThan(0.6);
    expect(sp[0].strength).toBeLessThanOrEqual(1);
  });

  it('landing from a jump into the pool is an ENTERING splash, harder than walking in', () => {
    const jumper = jf(0, 'lion', POOL.x, POOL.z, TERRAIN.groundedAlt + 5.5 * DT);
    jumper.state.airborne = true;
    jumper.state.vel.y = -5.5;
    const r = rig(jumper);
    r.step();
    expect(jumper.inWater).toBe(false); // still just above the grounded line
    jumper.state.pos.y = TERRAIN.groundedAlt; // fell through it
    r.step();
    expect(jumper.inWater).toBe(true);
    const sp = splashes(r.events);
    expect(sp).toHaveLength(1);
    expect(sp[0].entering).toBe(true);
    expect(sp[0].strength).toBeGreaterThan(splashStrength(6.5, 0));
    expect(sp[0].strength).toBeCloseTo(splashStrength(0, 5.5), 9);
  });

  it('jumping out of the pool leaves the water (leaving splash); flyers over the pool are not in it', () => {
    const f = jf(0, 'lion', POOL.x, POOL.z);
    const eagle = jf(1, 'eagle', POOL.x + 1, POOL.z, 1.6);
    const r = rig(f, eagle);
    r.step();
    expect(f.inWater).toBe(true);
    expect(eagle.inWater).toBe(false);
    f.state.pos.y = 1.0;
    f.state.vel.y = 4;
    r.step();
    expect(f.inWater).toBe(false);
    expect(f.terrainSpeedMult).toBe(1);
    const sp = splashes(r.events);
    expect(sp.map((s) => [s.fighterId, s.entering])).toEqual([[0, true], [0, false]]);
  });

  it('burrowing / dying inside the pool clears the flags silently (no splash)', () => {
    const mole = jf(0, 'mole', POOL.x, POOL.z);
    const victim = jf(1, 'lion', POOL.x + 2, POOL.z);
    const r = rig(mole, victim);
    r.step();
    expect(splashes(r.events)).toHaveLength(2);
    r.events.length = 0;
    mole.state.burrowT = 2; // underground
    victim.state.alive = false;
    r.step();
    expect(mole.inWater).toBe(false);
    expect(mole.terrainSpeedMult).toBe(1);
    expect(victim.inWater).toBe(false);
    expect(victim.terrainSpeedMult).toBe(1);
    expect(r.events).toHaveLength(0);
    mole.state.burrowT = 0; // surfaces in the pool: wading again (an entering splash)
    r.step();
    expect(mole.inWater).toBe(true);
    expect(splashes(r.events).map((s) => s.entering)).toEqual([true]);
  });

  it('is deterministic: the same inputs give the same flags, multipliers and events', () => {
    const run = (): string => {
      const fs = ANIMAL_IDS.map((a, i) => jf(i, a, -9 + 2 * i, -3 + (i % 4)));
      const r = rig(...fs);
      let h = '';
      for (let t = 0; t < 300; t++) {
        for (const f of fs) {
          f.state.pos.x += 0.06 * (f.id % 2 === 0 ? 1 : -1);
          f.state.pos.z += 0.03 * Math.sin(t * 0.1 + f.id);
          f.state.vel.x = 4;
        }
        r.step();
        h += fs.map((f) => `${f.inWater ? 1 : 0}${f.onMoss ? 1 : 0}${f.terrainSpeedMult.toFixed(6)}`).join(',') + ';';
      }
      return h + JSON.stringify(r.events);
    };
    expect(run()).toBe(run());
  });
});

describe('TerrainSystem — the colosseum has no terrain', () => {
  it('is inactive, touches nothing and emits nothing', () => {
    const ts = new TerrainSystem(COLOSSEUM_ARENA);
    expect(ts.active).toBe(false);
    const f = jf(0, 'lion', 0, 0);
    f.inWater = true; // would be cleared if the system ran; an inactive system never writes
    const events: GameEvent[] = [];
    ts.step(makeSim([f], events), DT);
    expect(f.inWater).toBe(true);
    expect(events).toHaveLength(0);
    expect(new TerrainSystem(J).active).toBe(true);
  });

  it('colosseum snapshots never carry the flags', () => {
    const { world } = liveWorld(['lion', 'crocodile', 'hippo', 'eagle'], 5, [], { arena: 'colosseum' });
    for (let t = 0; t < 600; t++) {
      world.setIntent(0, { ...neutral(), moveX: Math.sin(t / 50), moveZ: Math.cos(t / 40) });
      world.step(DT);
    }
    const snap = world.snapshot();
    for (const f of snap.fighters) {
      expect('inWater' in f).toBe(false);
      expect('onMoss' in f).toBe(false);
    }
    expect(world.terrain.active).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part 2: the real World on the jungle.
// ─────────────────────────────────────────────────────────────────────────────

function jungle(animals: AnimalId[], seed = 11) {
  const events: GameEvent[] = [];
  const { world } = liveWorld(animals, seed, events, { arena: 'jungle' });
  disablePickups(world);
  return { world, events };
}

function put(world: ReturnType<typeof jungle>['world'], id: number, x: number, z: number, yaw = 0): void {
  const f = world.fighters[id];
  f.state.pos.x = x;
  f.state.pos.z = z;
  f.state.pos.y = 0;
  f.state.vel.x = 0;
  f.state.vel.y = 0;
  f.state.vel.z = 0;
  f.state.yaw = yaw;
  f.state.airborne = false;
}

/**
 * Park everybody except `except` in open jungle floor well away from the test corridors (WET: z = 0 through the pool;
 * DRY: z = 5 west of the trees). `geometry` below asserts the spots / corridors really are clear.
 */
const PARK: readonly (readonly [number, number])[] = [
  [-7, 22],
  [-12, -12],
  [-4, 25],
  [11, -6.5],
];
function parkOthers(world: ReturnType<typeof jungle>['world'], except: number[]): void {
  let k = 0;
  for (const f of world.fighters) if (!except.includes(f.id)) put(world, f.id, PARK[k][0], PARK[k++][1]);
}

function runIntent(world: ReturnType<typeof jungle>['world'], id: number, intent: Partial<FighterIntent>, ticks: number): void {
  for (let t = 0; t < ticks; t++) {
    world.setIntent(id, { ...neutral(), ...intent });
    world.step(DT);
  }
}

describe('World + terrain — ordinary locomotion speed', () => {
  it('every animal wades through the pool at land speed × its water multiplier', () => {
    for (const a of ANIMAL_IDS) {
      const { world } = jungle([a, a === 'lion' ? 'gorilla' : 'lion']);
      parkOthers(world, [0]);
      put(world, 0, -6.0, 0);
      runIntent(world, 0, { moveX: 1, aimYaw: Math.PI / 2 }, 30);
      const f = world.fighters[0];
      expect(f.inWater, a).toBe(true);
      expect(Math.hypot(f.state.vel.x, f.state.vel.z), a).toBeCloseTo(ANIMALS[a].speed * waterSpeedMultiplier(a), 6);
      expect(f.state.pos.x, `${a} stays inside the pool`).toBeLessThan(R);
    }
  });

  it('moss slows ordinary running by 35 % (and does nothing off the patch)', () => {
    const { world } = jungle(['lion', 'gorilla']);
    parkOthers(world, [0]);
    put(world, 0, M0.x, M0.z);
    runIntent(world, 0, { moveX: -1, aimYaw: -Math.PI / 2 }, 20);
    const f = world.fighters[0];
    expect(f.onMoss).toBe(true);
    expect(Math.hypot(f.state.vel.x, f.state.vel.z)).toBeCloseTo(ANIMALS.lion.speed * 0.65, 6);
    // dry ground: full speed
    put(world, 0, -15, -3);
    runIntent(world, 0, { moveX: -1, aimYaw: -Math.PI / 2 }, 60);
    expect(f.terrainSpeedMult).toBe(1);
    expect(Math.hypot(f.state.vel.x, f.state.vel.z)).toBeCloseTo(ANIMALS.lion.speed, 6);
  });

  it('the snapshot carries the flags (only while true) and a splash is emitted when the fighter walks in', () => {
    const { world, events } = jungle(['lion', 'gorilla']);
    parkOthers(world, [0]);
    put(world, 0, -R - 1.5, 0);
    runIntent(world, 0, { moveX: 1, aimYaw: Math.PI / 2 }, 6);
    expect(world.snapshot().fighters[0].inWater).toBeUndefined();
    runIntent(world, 0, { moveX: 1, aimYaw: Math.PI / 2 }, 30);
    const s = world.snapshot();
    expect(s.fighters[0].inWater).toBe(true);
    expect(s.fighters[0].onMoss).toBeUndefined();
    expect(s.fighters[1].inWater).toBeUndefined();
    const sp = splashes(events).filter((e) => e.fighterId === 0);
    expect(sp).toHaveLength(1);
    expect(sp[0].entering).toBe(true);
    expect(sp[0].strength).toBeGreaterThan(0.2);
  });

  it('a real jump into the pool splashes on landing (entering) and the flag settles', () => {
    const { world, events } = jungle(['lion', 'gorilla']);
    parkOthers(world, [0]);
    put(world, 0, 0, 0);
    world.fighters[0].state.pos.y = 2.2;
    world.fighters[0].state.airborne = true;
    runIntent(world, 0, {}, 40);
    const f = world.fighters[0];
    expect(f.state.pos.y).toBe(0);
    expect(f.inWater).toBe(true);
    const sp = splashes(events).filter((e) => e.fighterId === 0);
    expect(sp.map((s) => s.entering)).toEqual([true]);
    expect(sp[0].strength).toBeGreaterThan(0.45);
  });
});

describe('World + terrain — pounce splash', () => {
  it('a lion pouncing from the shore into the pool makes a hard entering splash', () => {
    const { world, events } = jungle(['lion', 'gorilla']);
    parkOthers(world, [0]);
    put(world, 0, 0, -12, 0); // yaw 0 = +z: the 8 m pounce lands inside the pool
    runIntent(world, 0, {}, 2);
    events.length = 0;
    for (let t = 0; t < 90; t++) {
      world.setIntent(0, { ...neutral(), special: t === 0, aimYaw: 0 });
      world.step(DT);
    }
    const f = world.fighters[0];
    expect(f.inWater).toBe(true);
    const mine = splashes(events).filter((e) => e.fighterId === 0);
    expect(mine.map((e) => e.entering)).toEqual([true]);
    expect(mine[0].strength).toBeGreaterThan(0.5);
  });
});

describe('World + terrain — abilities and ultimates keep their own speed', () => {
  /** Run `ticks` of a special from a spot and return the distance travelled and the ticks the ability ran. */
  function special(animal: AnimalId, x: number, z: number, yaw: number): { dist: number; ticks: number; inWaterAtStart: boolean } {
    const { world } = jungle([animal, 'gorilla']);
    parkOthers(world, [0]);
    put(world, 0, x, z, yaw);
    runIntent(world, 0, {}, 2);
    const f = world.fighters[0];
    const inWaterAtStart = f.inWater;
    const x0 = f.state.pos.x;
    const z0 = f.state.pos.z;
    let ticks = 0;
    for (let t = 0; t < 120; t++) {
      world.setIntent(0, { ...neutral(), special: t === 0, aimYaw: yaw });
      world.step(DT);
      if (f.ability !== null) ticks++;
      else if (t > 0) break;
    }
    return { dist: Math.hypot(f.state.pos.x - x0, f.state.pos.z - z0), ticks, inWaterAtStart };
  }

  // Wet start: just inside the pool's west shore, casting east across it. Dry start: a clear stretch of jungle floor with the
  // same heading. Both lanes are open (no trunk / log / moss) for the 14 m ahead.
  const WET = { x: -6.0, z: 0, yaw: Math.PI / 2 };
  const DRY = { x: -21, z: 5, yaw: Math.PI / 2 };

  it('geometry: both lanes and every parking spot are open ground', () => {
    for (const lane of [WET, DRY]) {
      for (let d = 2; d <= 13.5; d += 0.5) {
        // the widest animal here is the hippo (body radius 1.2): its whole body fits through
        expect(minSurfaceDist(J.solids, lane.x + d, lane.z), `lane z=${lane.z} d=${d}`).toBeGreaterThan(1.3);
      }
    }
    for (const t of MOSS) for (let d = 0; d <= 13; d += 0.5) expect(terrainDist(t, DRY.x + d, DRY.z)).toBeGreaterThan(1.5);
    for (const [x, z] of PARK) {
      expect(minSurfaceDist(J.solids, x, z)).toBeGreaterThan(1.5);
      for (const t of J.terrain) expect(terrainDist(t, x, z)).toBeGreaterThan(1);
    }
  });

  it.each(['lion', 'crocodile', 'hippo', 'panther', 'gorilla', 'rhino'] as AnimalId[])(
    '%s special: identical distance and duration in the water and on dry ground',
    (a) => {
      const wet = special(a, WET.x, WET.z, WET.yaw);
      const dry = special(a, DRY.x, DRY.z, DRY.yaw);
      expect(wet.inWaterAtStart).toBe(true);
      expect(dry.inWaterAtStart).toBe(false);
      expect(wet.dist).toBeGreaterThan(2); // it really moved
      expect(wet.ticks).toBe(dry.ticks);
      expect(wet.dist).toBeCloseTo(dry.dist, 6);
    },
  );

  it('the rhino Seismic Stampede keeps its 12 m/s charge speed while crossing the pool', () => {
    const { world } = jungle(['rhino', 'gorilla']);
    parkOthers(world, [0]);
    put(world, 0, -6.3, 0, Math.PI / 2);
    runIntent(world, 0, {}, 2);
    const f = world.fighters[0];
    expect(f.inWater).toBe(true);
    f.state.ultCharge = 100;
    let maxStep = 0;
    let inWaterCharging = 0;
    let prevX = f.state.pos.x;
    let prevZ = f.state.pos.z;
    for (let t = 0; t < 150; t++) {
      world.setIntent(0, { ...neutral(), ultimate: t === 0, aimYaw: Math.PI / 2, moveX: 1 });
      world.step(DT);
      const step = Math.hypot(f.state.pos.x - prevX, f.state.pos.z - prevZ) / DT;
      prevX = f.state.pos.x;
      prevZ = f.state.pos.z;
      if (f.ability !== null && f.ability.kind === 'ultimate' && f.inWater) {
        inWaterCharging++;
        if (step > maxStep) maxStep = step;
      }
    }
    expect(inWaterCharging).toBeGreaterThan(10);
    // 12 m/s charge (after a 0.5 s ramp) — never throttled to the rhino's 0.40 swim multiplier (≈ 2 m/s)
    expect(maxStep).toBeGreaterThan(8);
  });

  it('knockback in the water is not scaled by the swim multiplier', () => {
    const run = (x: number, z: number): number => {
      const { world } = jungle(['giraffe', 'gorilla']);
      parkOthers(world, [0]);
      put(world, 0, x, z, 0);
      runIntent(world, 0, {}, 2);
      const f = world.fighters[0];
      f.setKnockback(1, 0, 3);
      const x0 = f.state.pos.x;
      runIntent(world, 0, {}, 20);
      return f.state.pos.x - x0;
    };
    const wet = run(-4, 0);
    const dry = run(-21, 5);
    expect(wet).toBeGreaterThan(2.5);
    expect(wet).toBeCloseTo(dry, 6);
  });
});

describe("World + terrain — the mole's Burrow fizzles in the water", () => {
  function press(world: ReturnType<typeof jungle>['world'], id: number, ticks: number): void {
    for (let t = 0; t < ticks; t++) {
      world.setIntent(id, { ...neutral(), special: t === 0 });
      world.step(DT);
    }
  }

  it('does nothing while the mole is inWater: no cast, no cooldown, no animation, no event; works on dry land', () => {
    const { world, events } = jungle(['mole', 'gorilla']);
    parkOthers(world, [0]);
    put(world, 0, 0, 0);
    runIntent(world, 0, {}, 2);
    const mole = world.fighters[0];
    expect(mole.inWater).toBe(true);
    expect(mole.state.specialCd).toBe(0);
    events.length = 0;
    press(world, 0, 90);
    expect(mole.ability).toBeNull();
    expect(mole.state.specialCd).toBe(0); // cooldown refunded (never spent)
    expect(mole.state.burrowT).toBe(0);
    expect(mole.untargetable).toBe(false);
    expect(mole.state.action).not.toBe('burrowed');
    expect(events.filter((e) => e.type === 'special' || e.type === 'telegraph')).toHaveLength(0);
    // out of the pool the same key works
    put(world, 0, -15, -3);
    runIntent(world, 0, {}, 2);
    expect(mole.inWater).toBe(false);
    events.length = 0;
    press(world, 0, 40);
    expect(events.filter((e) => e.type === 'special')).toHaveLength(1);
    expect(mole.ability).not.toBeNull();
    expect(mole.state.action).toBe('burrowed');
    runIntent(world, 0, { moveX: 0 }, 400); // the cast runs its course (the cooldown is paid when it ends)
    expect(mole.ability).toBeNull();
    expect(mole.state.specialCd).toBeGreaterThan(0);
  });

  it('the fizzle falls through to the normal block / attack logic (an attack pressed with it still swings)', () => {
    const { world } = jungle(['mole', 'gorilla']);
    parkOthers(world, [0]);
    put(world, 0, 0, 0);
    runIntent(world, 0, {}, 2);
    world.setIntent(0, { ...neutral(), special: true, attack: true });
    world.step(DT);
    expect(world.fighters[0].swinging).toBe(true);
  });

  it('other animals still use their specials in the water (only the mole is blocked)', () => {
    for (const a of ['lion', 'hippo', 'crocodile', 'python', 'eagle', 'giraffe'] as AnimalId[]) {
      const { world, events } = jungle([a, 'gorilla']);
      parkOthers(world, [0]);
      put(world, 0, -2, 0);
      runIntent(world, 0, {}, 2);
      expect(world.fighters[0].inWater, a).toBe(true);
      events.length = 0;
      press(world, 0, 5);
      expect(events.filter((e) => e.type === 'special' && e.fighterId === 0), a).toHaveLength(1);
      expect(world.fighters[0].ability, a).not.toBeNull();
    }
  });

  it('a mole burrowed on land may tunnel into the pool and surface there (the rule only stops STARTING a burrow in water)', () => {
    const { world } = jungle(['mole', 'gorilla']);
    parkOthers(world, [0]);
    put(world, 0, -R - 2.5, 0, Math.PI / 2);
    runIntent(world, 0, {}, 2);
    for (let t = 0; t < 300; t++) {
      world.setIntent(0, { ...neutral(), special: t === 0, moveX: 1, aimYaw: Math.PI / 2 });
      world.step(DT);
      if (world.fighters[0].state.burrowT > 0) expect(world.fighters[0].inWater).toBe(false);
    }
    expect(world.fighters[0].state.pos.x).toBeGreaterThan(-R - 2.5);
  });
});
