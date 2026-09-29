/**
 * v1.1 regression tests for bot stalls found by the balance sweep (WP-J).
 * Each scenario used to run to the 300 s cap without a death:
 *  1. low-wall standoff — two bots on opposite sides of a fallen column slid
 *     along it forever (the feelers only bend the path locally), and big
 *     bodies wedged in the crate-pile/column gap stayed pinned there;
 *  2. retreat with nothing to flee from — a wounded bot with no heal pad and
 *     no perceived enemy picked "retreat" and stood idle forever;
 *  3. endless kite — a wounded bot as fast as its pursuer kited for minutes
 *     (bloodlust damping alone never overturned the goal hysteresis).
 */

import { describe, it, expect } from 'vitest';
import { World } from '../../src/sim/World';
import { EventBus } from '../../src/core/EventBus';
import { BotManager } from '../../src/ai/BotManager';
import { FALLEN_COLUMNS } from '../../src/config/arena';
import { disablePickups } from '../sim/helpers';
import type { AnimalId, Difficulty, MatchConfig } from '../../src/core/types';
import { DT } from './helpers';

interface Spot {
  animal: AnimalId;
  x: number;
  z: number;
  /** Starting HP fraction (default 1). */
  hpFrac?: number;
}

interface DuelResult {
  /** Fight time (s) of the first damage event, -1 if none. */
  firstDamageS: number;
  /** Fight time (s) of the first death, -1 if none within the cap. */
  firstDeathS: number;
}

/** Two bots placed by hand (pickups off), run until the first death or `maxS`. */
function duel(spots: readonly Spot[], difficulty: Difficulty, maxS: number, seed = 11): DuelResult {
  const cfg: MatchConfig = { roster: spots.map((s) => ({ animal: s.animal, isPlayer: false })), difficulty };
  const bus = new EventBus();
  const world = new World(cfg, seed, bus);
  disablePickups(world);
  spots.forEach((s, i) => {
    const f = world.fighters[i];
    f.state.pos = { x: s.x, y: 0, z: s.z };
    f.state.hp = f.state.maxHp * (s.hpFrac ?? 1);
  });
  const bots = new BotManager(bus, difficulty, seed);
  const res: DuelResult = { firstDamageS: -1, firstDeathS: -1 };
  bus.on('hit', () => {
    if (res.firstDamageS < 0) res.firstDamageS = world.time;
  });
  bus.on('blocked', () => {
    if (res.firstDamageS < 0) res.firstDamageS = world.time;
  });
  bus.on('death', () => {
    if (res.firstDeathS < 0) res.firstDeathS = world.time;
  });
  const maxTicks = Math.ceil((maxS + 3) / DT);
  for (let tick = 0; tick < maxTicks && res.firstDeathS < 0; tick++) {
    bots.update(world.snapshot(), DT);
    for (let id = 0; id < spots.length; id++) world.setIntent(id, bots.getIntent(id));
    world.step(DT);
  }
  return res;
}

/** Points `off` metres either side of fallen column `i`'s midpoint. */
function acrossColumn(i: number, off: number): { ax: number; az: number; bx: number; bz: number } {
  const w = FALLEN_COLUMNS[i];
  const mx = (w.ax + w.bx) / 2;
  const mz = (w.az + w.bz) / 2;
  const ex = w.bx - w.ax;
  const ez = w.bz - w.az;
  const len = Math.hypot(ex, ez);
  const nx = -ez / len;
  const nz = ex / len;
  return { ax: mx - nx * off, az: mz - nz * off, bx: mx + nx * off, bz: mz + nz * off };
}

describe('v1.1 bot stall regressions', () => {
  it('Cub bots on opposite sides of a fallen column walk round it and fight', () => {
    // Cubs never jump (strafeSkill 0), so the only way to the foe is round a tip.
    const p = acrossColumn(0, 2.5);
    const r = duel(
      [
        { animal: 'hippo', x: p.ax, z: p.az },
        { animal: 'rhino', x: p.bx, z: p.bz },
      ],
      1,
      40,
    );
    expect(r.firstDamageS).toBeGreaterThanOrEqual(0);
    expect(r.firstDamageS).toBeLessThan(8);
  });

  it('big bodies wedged between a crate pile and a column smash or sidestep out', () => {
    // Column 2 and the (7,−7) crate pile leave a gap narrower than a rhino:
    // chasing round the column used to pin both bots there for good.
    const p = acrossColumn(1, 2.5);
    const r = duel(
      [
        { animal: 'rhino', x: p.ax, z: p.az },
        { animal: 'hippo', x: p.bx, z: p.bz },
      ],
      1,
      40,
    );
    expect(r.firstDamageS).toBeGreaterThanOrEqual(0);
    expect(r.firstDamageS).toBeLessThan(20);
  });

  it('wounded Apex bots with no heal and no foe in sight go looking instead of idling', () => {
    // Pillars at (±15, 0) block line of sight along the x-axis; both start at
    // 25% HP (below the 35% retreat threshold) with every pickup disabled.
    const r = duel(
      [
        { animal: 'crocodile', x: -27.5, z: 0.4, hpFrac: 0.25 },
        { animal: 'gorilla', x: 27.5, z: 0.4, hpFrac: 0.25 },
      ],
      4,
      120,
    );
    expect(r.firstDamageS).toBeGreaterThanOrEqual(0);
    expect(r.firstDeathS).toBeGreaterThanOrEqual(0);
  });

  it('a wounded kiter as fast as its pursuer turns and fights (retreat budget)', () => {
    // Lion (6.5 m/s) at 20% HP vs a full-HP rhino (5.0 m/s), no heal pads:
    // the lion used to kite along the wall until the 300 s cap.
    const r = duel(
      [
        { animal: 'lion', x: 0, z: -20, hpFrac: 0.2 },
        { animal: 'rhino', x: 0, z: -12 },
      ],
      3,
      90,
    );
    expect(r.firstDeathS).toBeGreaterThanOrEqual(0);
    expect(r.firstDeathS).toBeLessThan(90);
  });
});
