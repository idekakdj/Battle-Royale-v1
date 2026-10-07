/**
 * v1.8 map plumbing for an OFFLINE match: `startMatch(animal, difficulty, arena)` → `MatchController({arena})` → `LocalSimDriver`
 * → `World` + `BotManager` + seating. (The controller itself needs WebGL; the sim seam below it is what carries the arena.)
 * A colosseum match must behave EXACTLY as before.
 */

import { describe, expect, it } from 'vitest';
import { EventBus } from '../../src/core/EventBus';
import { World } from '../../src/sim/World';
import { BotManager } from '../../src/ai/BotManager';
import { LocalSimDriver } from '../../src/match/SimDriver';
import { seatPositions, seatRoster } from '../../src/match/seating';
import { COLOSSEUM_ARENA, JUNGLE_ARENA } from '../../src/config/arenas';
import type { WorldSnapshot } from '../../src/core/types';

const DT = 1 / 60;
const SEED = 424242;

function run(driver: LocalSimDriver, ticks: number): WorldSnapshot {
  for (let i = 0; i < ticks; i++) driver.tick(DT, null);
  return driver.snapshot();
}

/** The pre-1.8 path, written out by hand (what LocalSimDriver did before the arena parameter existed). */
function legacySnapshot(animal: 'lion', difficulty: 1 | 2 | 3 | 4, seed: number, ticks: number): WorldSnapshot {
  const bus = new EventBus();
  const roster = seatRoster(animal, seed);
  const world = new World({ roster, difficulty }, seed, bus);
  const bots = new BotManager(bus, difficulty, seed);
  let snap = world.snapshot();
  for (let t = 0; t < ticks; t++) {
    bots.update(snap, DT);
    for (let id = 1; id < roster.length; id++) world.setIntent(id, bots.getIntent(id));
    world.step(DT);
    snap = world.snapshot();
  }
  return snap;
}

describe('LocalSimDriver arena plumbing', () => {
  it('defaults to the colosseum', () => {
    const d = new LocalSimDriver({ animal: 'lion', difficulty: 2, seed: SEED });
    expect(d.arena).toBe('colosseum');
    expect(d.world.arena).toBe(COLOSSEUM_ARENA);
  });

  it('arena "jungle" builds a jungle World, jungle seating and jungle bots', () => {
    const d = new LocalSimDriver({ animal: 'crocodile', difficulty: 3, seed: SEED, arena: 'jungle' });
    expect(d.arena).toBe('jungle');
    expect(d.world.arena).toBe(JUNGLE_ARENA);
    expect(d.roster).toHaveLength(10);
    expect(d.roster[0]).toMatchObject({ animal: 'crocodile', isPlayer: true });
    // fighters start on the jungle's seats, not the colosseum ring
    const seats = seatPositions(10, JUNGLE_ARENA);
    const snap = d.snapshot();
    snap.fighters.forEach((f, i) => {
      expect(f.pos.x).toBeCloseTo(seats[i].x, 3);
      expect(f.pos.z).toBeCloseTo(seats[i].z, 3);
    });
    // and the match runs (bots included) without throwing
    const after = run(d, 600);
    expect(after.fighters).toHaveLength(10);
    expect(after.fighters.every((f) => Number.isFinite(f.pos.x) && Number.isFinite(f.pos.z))).toBe(true);
  });

  it('the same seed seats the same roster on both maps (only the geometry differs)', () => {
    const a = new LocalSimDriver({ animal: 'lion', difficulty: 2, seed: SEED, arena: 'colosseum' });
    const b = new LocalSimDriver({ animal: 'lion', difficulty: 2, seed: SEED, arena: 'jungle' });
    expect(b.roster.map((r) => r.animal)).toEqual(a.roster.map((r) => r.animal));
  });

  it('a colosseum match is IDENTICAL to the pre-1.8 path (no arena / explicit colosseum / hand-built World), tick for tick', () => {
    const ticks = 900;
    const none = JSON.stringify(run(new LocalSimDriver({ animal: 'lion', difficulty: 3, seed: SEED }), ticks));
    const explicit = JSON.stringify(run(new LocalSimDriver({ animal: 'lion', difficulty: 3, seed: SEED, arena: 'colosseum' }), ticks));
    const legacy = JSON.stringify(legacySnapshot('lion', 3, SEED, ticks));
    expect(explicit).toBe(none);
    expect(legacy).toBe(none);
  });

  it('a jungle match differs from the colosseum one (different seats at least)', () => {
    const c = new LocalSimDriver({ animal: 'lion', difficulty: 3, seed: SEED });
    const j = new LocalSimDriver({ animal: 'lion', difficulty: 3, seed: SEED, arena: 'jungle' });
    expect(JSON.stringify(c.snapshot().fighters.map((f) => f.pos))).not.toBe(JSON.stringify(j.snapshot().fighters.map((f) => f.pos)));
  });

  it('player 0 on the jungle can wade into the pool: terrain flags reach the snapshot (inWater) and the splash event fires', () => {
    const d = new LocalSimDriver({ animal: 'crocodile', difficulty: 1, seed: SEED, arena: 'jungle' });
    const splashes: boolean[] = [];
    d.bus.on('splash', (e) => {
      if (e.fighterId === 0) splashes.push(e.entering);
    });
    let wet = false;
    for (let i = 0; i < 60 * 25 && !wet; i++) {
      const me = d.snapshot().fighters[0]; // seat 0 is due south (+z); the pool is at the centre
      d.tick(DT, { moveX: -me.pos.x * 0.2, moveZ: -me.pos.z, aimYaw: 0, attack: false, block: false, special: false, ultimate: false, jump: false });
      if (d.snapshot().fighters[0].inWater === true) wet = true;
    }
    expect(wet).toBe(true);
    expect(splashes[0]).toBe(true);
  });
});
