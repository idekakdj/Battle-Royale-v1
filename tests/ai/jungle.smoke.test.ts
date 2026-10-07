/**
 * v1.8 WP-J2: jungle bot smoke across every difficulty and a fresh set of seeds (J1b's `tests/sim/jungle.smoke.test.ts` covers seeds
 * 1-4). Full 10-bot matches on the Jungle Clearing with the terrain-aware brains: no stalls, nobody stuck in a trunk or log, no NaN,
 * every match ends, bots never hop through the pool, and nobody (except a fast swimmer) parks idle in the water or on moss.
 * `JUNGLE_REPORT=1` prints the per-run numbers.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { World } from '../../src/sim/World';
import { EventBus } from '../../src/core/EventBus';
import { BotManager } from '../../src/ai/BotManager';
import { ANIMAL_IDS } from '../../src/config/animals';
import { JUNGLE_ARENA as J } from '../../src/config/arenas';
import { waterSpeedMultiplier } from '../../src/config/terrain';
import { GOOD_SWIMMER_MULT } from '../../src/ai/TerrainSense';
import { mulberry32 } from '../../src/core/math';
import type { AnimalId, Difficulty, MatchConfig } from '../../src/core/types';
import { surfaceDist } from '../config/arenaGeom';

const DT = 1 / 60;
const LEVELS: Difficulty[] = [1, 2, 3, 4];
const SEEDS = [11, 12, 13, 14];
const MAX_SIM_S = 300;
const STALL_FRAMES = 300;
/** Frames a non-fast-swimmer may stand motionless in water / on moss (L2+) before it counts as parked. */
const PARKED_FRAMES = 300;

interface Report {
  seed: number;
  level: Difficulty;
  ended: boolean;
  timeS: number;
  nan: string | null;
  freeIntrusion: number;
  worstStuckFrames: number;
  worstStall: number;
  hopsInWater: number;
  worstParked: number;
  /** Share of all bot-seconds spent in water / on moss. */
  waterShare: number;
  mossShare: number;
}

function shuffled(seed: number): AnimalId[] {
  const order = [...(ANIMAL_IDS as readonly AnimalId[])];
  const rng = mulberry32(seed ^ 0x9e3779b9);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

function play(seed: number, level: Difficulty): Report {
  const animals = shuffled(seed * 17 + level);
  const cfg: MatchConfig = { roster: animals.map((a) => ({ animal: a, isPlayer: false })), difficulty: level, arena: 'jungle' };
  const bus = new EventBus();
  let ended = false;
  bus.on('matchEnd', () => {
    ended = true;
  });
  const world = new World(cfg, seed * 1000 + level, bus);
  const bots = new BotManager(bus, level, seed * 1000 + level, world.arena);
  const n = animals.length;
  const rep: Report = { seed, level, ended: false, timeS: 0, nan: null, freeIntrusion: -Infinity, worstStuckFrames: 0, worstStall: 0, hopsInWater: 0, worstParked: 0, waterShare: 0, mossShare: 0 };
  const ax = new Float64Array(n);
  const az = new Float64Array(n);
  const since = new Int32Array(n);
  const inside = new Int32Array(n);
  const parked = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    ax[i] = world.fighters[i].state.pos.x;
    az[i] = world.fighters[i].state.pos.z;
  }
  const wasWet = new Array<boolean>(n).fill(false);
  let aliveFrames = 0;
  let waterFrames = 0;
  let mossFrames = 0;
  const maxTicks = Math.ceil((MAX_SIM_S + 3.5) / DT);
  for (let tick = 0; tick < maxTicks && !ended; tick++) {
    for (let id = 0; id < n; id++) wasWet[id] = world.fighters[id].inWater;
    bots.update(world.snapshot(), DT);
    for (let id = 0; id < n; id++) world.setIntent(id, bots.getIntent(id));
    world.step(DT);
    if (world.time <= 0) continue;
    for (let i = 0; i < n; i++) {
      const f = world.fighters[i];
      const s = f.state;
      if (!s.alive) continue;
      aliveFrames++;
      if (f.inWater) waterFrames++;
      if (f.onMoss) mossFrames++;
      if (!Number.isFinite(s.pos.x + s.pos.y + s.pos.z + s.vel.x + s.vel.z + s.hp + s.guard) && rep.nan === null) rep.nan = `tick ${tick} fighter ${i} (${s.animal})`;
      const r = f.def.radius;
      let pen = -Infinity;
      if (s.pos.y < 1.0 && s.burrowT <= 0) {
        for (const t of J.circles) pen = Math.max(pen, t.radius + r - Math.hypot(s.pos.x - t.x, s.pos.z - t.z));
        for (const l of J.segments) if (s.pos.y < l.height - 0.05) pen = Math.max(pen, r - surfaceDist(l, s.pos.x, s.pos.z));
      }
      const free = !f.movementOwned && s.grabbedById === -1 && f.ability === null && f.knockTimer <= 0;
      if (free) rep.freeIntrusion = Math.max(rep.freeIntrusion, pen);
      if (pen > 0.3) {
        if (++inside[i] > rep.worstStuckFrames) rep.worstStuckFrames = inside[i];
      } else inside[i] = 0;
      const wants = Math.hypot(f.intent.moveX, f.intent.moveZ) > 0.5;
      const mobile = s.action === 'run' || s.action === 'idle';
      if (!wants || !mobile || Math.hypot(s.pos.x - ax[i], s.pos.z - az[i]) > 0.75) {
        ax[i] = s.pos.x;
        az[i] = s.pos.z;
        since[i] = 0;
      } else if (++since[i] > rep.worstStall) rep.worstStall = since[i];
      // the intent was written while the bot stood where it stood BEFORE this tick's step
      if (wasWet[i] && f.intent.jump && s.animal !== 'eagle') rep.hopsInWater++;
      // parked: standing still (no move intent, nothing in swing) in slow terrain. Fast swimmers may idle in the pool.
      const fastSwimmer = waterSpeedMultiplier(s.animal) >= GOOD_SWIMMER_MULT && f.inWater && !f.onMoss;
      const still = Math.hypot(f.intent.moveX, f.intent.moveZ) < 0.05 && s.action === 'idle';
      if ((f.inWater || f.onMoss) && still && !fastSwimmer && level >= 2) {
        if (++parked[i] > rep.worstParked) rep.worstParked = parked[i];
      } else parked[i] = 0;
    }
  }
  rep.ended = ended;
  rep.timeS = world.time;
  rep.waterShare = waterFrames / Math.max(1, aliveFrames);
  rep.mossShare = mossFrames / Math.max(1, aliveFrames);
  return rep;
}

const reports: Report[] = [];
beforeAll(() => {
  for (const level of LEVELS) for (const seed of SEEDS) reports.push(play(seed, level));
  if (process.env.JUNGLE_REPORT === '1') {
    for (const r of reports) {
      console.log(
        `L${r.level} seed ${r.seed}: ended=${r.ended} t=${r.timeS.toFixed(0)}s stall=${r.worstStall} stuck=${r.worstStuckFrames} intr=${r.freeIntrusion.toFixed(2)} hops=${r.hopsInWater} parked=${r.worstParked} water=${(100 * r.waterShare).toFixed(1)}% moss=${(100 * r.mossShare).toFixed(1)}%`,
      );
    }
  }
}, 600_000);

describe('terrain-aware bots on the jungle (10 bots, every difficulty, fresh seeds)', () => {
  it('ran every seed at every level', () => {
    expect(reports).toHaveLength(LEVELS.length * SEEDS.length);
  });

  it('no NaN, every match ends well inside the cap', () => {
    for (const r of reports) {
      expect(r.nan, `seed ${r.seed} L${r.level}`).toBeNull();
      expect(r.ended, `seed ${r.seed} L${r.level} timed out`).toBe(true);
      expect(r.timeS).toBeLessThan(MAX_SIM_S);
    }
  });

  it('nobody is stuck in a trunk or a log, and no bot stalls for 300+ frames', () => {
    for (const r of reports) {
      expect(r.freeIntrusion, `seed ${r.seed} L${r.level}`).toBeLessThan(0.4); // a 3-frame transient at the end of a pounce can reach ~0.3 m
      expect(r.worstStuckFrames, `stuck, seed ${r.seed} L${r.level}`).toBeLessThan(60);
      expect(r.worstStall, `stall, seed ${r.seed} L${r.level}`).toBeLessThan(STALL_FRAMES);
    }
  });

  it('bots never hop through the water', () => {
    for (const r of reports) expect(r.hopsInWater, `seed ${r.seed} L${r.level}`).toBe(0);
  });

  it('Fighters and up never park motionless in the pool or on moss (fast swimmers may idle in the pool)', () => {
    for (const r of reports.filter((x) => x.level >= 2)) expect(r.worstParked, `seed ${r.seed} L${r.level}`).toBeLessThan(PARKED_FRAMES);
  });

  it('Veteran / Apex bots keep out of slow terrain: on average <= 11 % of bot-time in the water and <= 6 % on moss (no match above 20 % / 12 %)', () => {
    for (const level of [3, 4] as Difficulty[]) {
      const rs = reports.filter((x) => x.level === level);
      const avg = (f: (r: Report) => number): number => rs.reduce((a, r) => a + f(r), 0) / rs.length;
      expect(avg((r) => r.waterShare), `L${level} water`).toBeLessThan(0.11);
      expect(avg((r) => r.mossShare), `L${level} moss`).toBeLessThan(0.06);
      for (const r of rs) {
        expect(r.waterShare, `seed ${r.seed} L${r.level}`).toBeLessThan(0.2);
        expect(r.mossShare, `seed ${r.seed} L${r.level}`).toBeLessThan(0.12);
      }
    }
  });
});
