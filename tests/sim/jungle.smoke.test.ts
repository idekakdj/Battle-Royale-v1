/**
 * v1.8 headless jungle smoke: full 10-fighter bot matches on the Jungle Clearing at every difficulty, for several
 * seeds. Checks the foundation only (J1a): no crash / NaN, matches end, nobody ends up inside a tree or log, traps
 * placed at every difficulty obey the arena's exclusions, and no bot stalls for 300+ frames. Deep jungle bot
 * behaviour (terrain awareness) is WP-J2; here the bots merely steer round trees like round pillars.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { World } from '../../src/sim/World';
import { EventBus } from '../../src/core/EventBus';
import { BotManager } from '../../src/ai/BotManager';
import { ANIMAL_IDS } from '../../src/config/animals';
import { JUNGLE_ARENA as J } from '../../src/config/arenas';
import { TRAP_COUNT_BY_DIFFICULTY, TRAP_MAX_RADIUS } from '../../src/config/traps';
import { trapPlacementFor } from '../../src/sim/TrapSystem';
import { mulberry32 } from '../../src/core/math';
import type { AnimalId, Difficulty, MatchConfig } from '../../src/core/types';
import { surfaceDist, terrainDist } from '../config/arenaGeom';

const DT = 1 / 60;
const LEVELS: Difficulty[] = [1, 2, 3, 4];
const SEEDS = [1, 2, 3, 4];
const MAX_SIM_S = 300;
const STALL_FRAMES = 300;

interface Report {
  seed: number;
  level: Difficulty;
  ended: boolean;
  timeS: number;
  nan: string | null;
  /** Worst penetration (m) into a tree trunk / log by a FREE fighter (not grabbed, no ability or forced move running; >0 = inside). */
  freeIntrusion: number;
  /** Longest run of consecutive frames one fighter spent more than 0.3 m inside a trunk or log (any state). */
  worstStuckFrames: number;
  /** Largest number of consecutive frames a bot tried to move but made no headway. */
  worstStall: number;
  traps: { x: number; z: number }[];
  trapKinds: string[];
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
  const animals = shuffled(seed * 31 + level);
  const cfg: MatchConfig = { roster: animals.map((a) => ({ animal: a, isPlayer: false })), difficulty: level, arena: 'jungle' };
  const bus = new EventBus();
  let ended = false;
  bus.on('matchEnd', () => {
    ended = true;
  });
  const world = new World(cfg, seed * 1000 + level, bus);
  expect(world.arena).toBe(J);
  const bots = new BotManager(bus, level, seed * 1000 + level, world.arena);
  const n = animals.length;
  const rep: Report = {
    seed,
    level,
    ended: false,
    timeS: 0,
    nan: null,
    freeIntrusion: -Infinity,
    worstStuckFrames: 0,
    worstStall: 0,
    traps: world.traps.map((t) => ({ x: t.pos.x, z: t.pos.z })),
    trapKinds: world.traps.map((t) => t.kind),
  };
  // stall tracking: anchor position + frames spent "trying to move" without leaving a 0.75 m disc
  const ax = new Float64Array(n);
  const az = new Float64Array(n);
  const since = new Int32Array(n);
  const inside = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    ax[i] = world.fighters[i].state.pos.x;
    az[i] = world.fighters[i].state.pos.z;
  }
  const maxTicks = Math.ceil((MAX_SIM_S + 3.5) / DT);
  for (let tick = 0; tick < maxTicks && !ended; tick++) {
    bots.update(world.snapshot(), DT);
    for (let id = 0; id < n; id++) world.setIntent(id, bots.getIntent(id));
    world.step(DT);
    if (world.time <= 0) continue; // countdown
    for (let i = 0; i < n; i++) {
      const f = world.fighters[i];
      const s = f.state;
      if (!s.alive) continue;
      if (!Number.isFinite(s.pos.x + s.pos.y + s.pos.z + s.vel.x + s.vel.z + s.hp + s.guard) && rep.nan === null) {
        rep.nan = `tick ${tick} fighter ${i} (${s.animal})`;
      }
      const r = f.def.radius;
      // Penetration into the deepest tree trunk / log this fighter is touching at body height.
      let pen = -Infinity;
      if (s.pos.y < 1.0 && s.burrowT <= 0) {
        for (const t of J.circles) pen = Math.max(pen, t.radius + r - Math.hypot(s.pos.x - t.x, s.pos.z - t.z));
        for (const l of J.segments) if (s.pos.y < l.height - 0.05) pen = Math.max(pen, r - surfaceDist(l, s.pos.x, s.pos.z));
      }
      const free = !f.movementOwned && s.grabbedById === -1 && f.ability === null && f.knockTimer <= 0;
      if (free) rep.freeIntrusion = Math.max(rep.freeIntrusion, pen);
      if (pen > 0.3) {
        if (++inside[i] > rep.worstStuckFrames) rep.worstStuckFrames = inside[i];
      } else {
        inside[i] = 0;
      }
      // stall: wants to move, free to act, but stays within 0.75 m of its anchor
      const wants = Math.hypot(f.intent.moveX, f.intent.moveZ) > 0.5;
      const mobile = s.action === 'run' || s.action === 'idle';
      if (!wants || !mobile || Math.hypot(s.pos.x - ax[i], s.pos.z - az[i]) > 0.75) {
        ax[i] = s.pos.x;
        az[i] = s.pos.z;
        since[i] = 0;
      } else if (++since[i] > rep.worstStall) {
        rep.worstStall = since[i];
      }
    }
  }
  rep.ended = ended;
  rep.timeS = world.time;
  return rep;
}

const reports: Report[] = [];
beforeAll(() => {
  for (const level of LEVELS) for (const seed of SEEDS) reports.push(play(seed, level));
  if (process.env.JUNGLE_REPORT === '1') {
    for (const r of reports) {
      console.log(`L${r.level} seed ${r.seed}: ended=${r.ended} t=${r.timeS.toFixed(0)}s stall=${r.worstStall} stuck=${r.worstStuckFrames} freeIntrusion=${r.freeIntrusion.toFixed(3)} traps=${r.traps.length}`);
    }
  }
}, 600_000);

describe('jungle headless smoke (10 bots, every difficulty, several seeds)', () => {
  it('ran every seed at every level', () => {
    expect(reports).toHaveLength(LEVELS.length * SEEDS.length);
  });

  it('no crash and no NaN in any fighter state', () => {
    for (const r of reports) expect(r.nan, `seed ${r.seed} L${r.level}`).toBeNull();
  });

  it('every match ends (no timeouts) well inside the 300 s cap', () => {
    for (const r of reports) {
      expect(r.ended, `seed ${r.seed} L${r.level} timed out`).toBe(true);
      expect(r.timeS).toBeLessThan(MAX_SIM_S);
    }
  });

  it('nobody is stuck inside a tree trunk or a log (a free fighter is always pushed out; forced moves resolve within 1 s)', () => {
    for (const r of reports) {
      expect(r.freeIntrusion, `free fighter, seed ${r.seed} L${r.level}`).toBeLessThan(0.25);
      expect(r.worstStuckFrames, `stuck, seed ${r.seed} L${r.level}`).toBeLessThan(60);
    }
  });

  it('bots do not stall for 300+ frames while trying to move', () => {
    for (const r of reports) expect(r.worstStall, `seed ${r.seed} L${r.level}`).toBeLessThan(STALL_FRAMES);
  });

  it('traps placed at every difficulty obey the jungle exclusions (not in water/moss, clear of every solid)', () => {
    const R = TRAP_MAX_RADIUS;
    const P = trapPlacementFor(J);
    for (const r of reports) {
      expect(r.traps.length, `seed ${r.seed} L${r.level}`).toBe(TRAP_COUNT_BY_DIFFICULTY[r.level]);
      for (const t of r.traps) {
        for (const z of J.terrain) expect(terrainDist(z, t.x, t.z) - R).toBeGreaterThanOrEqual(J.trapRules.terrainClear - 1e-6);
        for (const ob of J.solids) expect(surfaceDist(ob, t.x, t.z) - R).toBeGreaterThanOrEqual(P.obstacleClear - 1e-6);
        expect(Math.hypot(t.x, t.z)).toBeGreaterThanOrEqual(P.minRadius - 1e-6);
        expect(Math.hypot(t.x, t.z)).toBeLessThanOrEqual(P.maxRadius + 1e-6);
      }
    }
  });

});
