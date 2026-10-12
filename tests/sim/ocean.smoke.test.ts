/**
 * v1.9 headless Ocean Dome smoke (WP-O1a): full 10-fighter bot matches on the three levels, every difficulty, several seeds.
 * Foundation checks only: no crash / NaN, every fighter's y is a real ground height (never sunk into a level, never stranded in the
 * air), nobody ends up inside a solid or deep inside a cliff, traps obey the level rules. Since WP-O2 the bots plan A* paths over the ramps and
 * dodge the serpent, so stalls stay under 300 frames and every match ends (OCEAN_REPORT=1 prints the per-match numbers). A death by the serpent is legitimate.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { World } from '../../src/sim/World';
import { EventBus } from '../../src/core/EventBus';
import { BotManager } from '../../src/ai/BotManager';
import { ANIMAL_IDS } from '../../src/config/animals';
import { OCEAN_ARENA as O, arenaGroundHeight, arenaNearestCliff, arenaSlopeAt, arenaStepLimit } from '../../src/config/arenas';
import { TRAP_COUNT_BY_DIFFICULTY } from '../../src/config/traps';
import { mulberry32 } from '../../src/core/math';
import type { AnimalId, Difficulty, MatchConfig } from '../../src/core/types';

const DT = 1 / 60;
const LEVELS: Difficulty[] = [1, 2, 3, 4];
const SEEDS = [1, 2, 3];
const MAX_SIM_S = 200;

interface Report {
  seed: number;
  level: Difficulty;
  ended: boolean;
  timeS: number;
  nan: string | null;
  /** Worst |y - ground| of a grounded, free fighter (m). */
  worstSeatError: number;
  /** Highest altitude above the local ground a non-eagle fighter reached (m). */
  worstAltitude: number;
  /** Worst penetration (m) into a solid by a FREE fighter at body height. */
  freeIntrusion: number;
  /** Worst depth (m) a FREE grounded fighter's body circle sank into a cliff. */
  worstCliffPen: number;
  /** Longest run of frames one fighter tried to move but stayed within 0.75 m. */
  worstStall: number;
  /** Which levels fighters stood on (ground heights) over the whole match. */
  levelsSeen: Set<number>;
  seatDebug: string;
  solidDebug: string;
  /** Longest run of frames a bot was pressed against a cliff while its intent pointed away from it. */
  worstWedged: number;
  traps: { y: number }[];
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
  const cfg: MatchConfig = { roster: animals.map((a) => ({ animal: a, isPlayer: false })), difficulty: level, arena: 'ocean' };
  const bus = new EventBus();
  let ended = false;
  bus.on('matchEnd', () => {
    ended = true;
  });
  const world = new World(cfg, seed * 1000 + level, bus);
  expect(world.arena).toBe(O);
  const bots = new BotManager(bus, level, seed * 1000 + level, world.arena);
  const n = animals.length;
  const rep: Report = {
    seed,
    level,
    ended: false,
    timeS: 0,
    nan: null,
    worstSeatError: 0,
    worstAltitude: 0,
    freeIntrusion: -Infinity,
    worstCliffPen: -Infinity,
    worstStall: 0,
    levelsSeen: new Set(),
    seatDebug: '',
    solidDebug: '',
    worstWedged: 0,
    traps: world.traps.map((t) => ({ y: t.pos.y })),
  };
  const ax = new Float64Array(n);
  const az = new Float64Array(n);
  const since = new Int32Array(n);
  const wedged = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    ax[i] = world.fighters[i].state.pos.x;
    az[i] = world.fighters[i].state.pos.z;
  }
  const hit = { d: 0, nx: 0, nz: 0 };
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
      if (!Number.isFinite(s.pos.x + s.pos.y + s.pos.z + s.vel.x + s.vel.y + s.vel.z + s.hp + s.guard) && rep.nan === null) {
        rep.nan = `tick ${tick} fighter ${i} (${s.animal})`;
      }
      const gy = arenaGroundHeight(O, s.pos.x, s.pos.z);
      const alt = s.pos.y - gy;
      const free = !f.movementOwned && s.grabbedById === -1 && f.ability === null && f.knockTimer <= 0 && s.glideT <= 0 && !f.soarDescending;
      if (s.animal !== 'eagle') rep.worstAltitude = Math.max(rep.worstAltitude, alt); // (the eagle's ultimate climbs to ~20 m)
      if (free && !s.airborne) {
        if (arenaSlopeAt(O, s.pos.x, s.pos.z) === 0) rep.levelsSeen.add(gy);
        if (Math.abs(alt) > rep.worstSeatError) {
          rep.worstSeatError = Math.abs(alt);
          rep.seatDebug = `tick ${tick} ${s.animal} y=${s.pos.y.toFixed(3)} gy=${gy.toFixed(3)} action=${s.action} vy=${s.vel.y.toFixed(2)} pos=${s.pos.x.toFixed(2)},${s.pos.z.toFixed(2)} ability=${f.ability !== null}`;
        }
      }
      if (free && s.burrowT <= 0) {
        const r = f.def.radius;
        // deepest overlap with a solid at body height (relative to the solid's own base)
        let pen = -Infinity;
        for (const c of O.circles) if (s.pos.y < (c.baseY ?? 0) + c.height) pen = Math.max(pen, c.radius + r - Math.hypot(s.pos.x - c.x, s.pos.z - c.z));
        for (const c of O.crates) {
          const live = world.crates[O.crates.indexOf(c)];
          if (live !== undefined && live.alive && s.pos.y < (c.baseY ?? 0) + c.height) {
            const dx = Math.max(0, Math.abs(s.pos.x - c.x) - c.halfX);
            const dz = Math.max(0, Math.abs(s.pos.z - c.z) - c.halfZ);
            pen = Math.max(pen, r - Math.hypot(dx, dz));
          }
        }
        if (pen > rep.freeIntrusion) {
          rep.freeIntrusion = pen;
          rep.solidDebug = `tick ${tick} ${s.animal} y=${s.pos.y.toFixed(2)} pos=${s.pos.x.toFixed(2)},${s.pos.z.toFixed(2)} action=${s.action}`;
        }
        // cliff penetration of the body circle, and 'wedged' = pressed against a cliff although the bot wants to go AWAY from it
        // (a fighter that is FALLING off a ledge may hang over the wall it just left until it lands; grounded bodies are always clear of cliffs)
        if (!s.airborne && arenaNearestCliff(O, s.pos.x, s.pos.z, arenaStepLimit(s.pos.y, gy), hit)) {
          rep.worstCliffPen = Math.max(rep.worstCliffPen, r - hit.d);
          const away = f.intent.moveX * hit.nx + f.intent.moveZ * hit.nz;
          const speed = Math.hypot(s.vel.x, s.vel.z);
          if (hit.d - r < 0.3 && away > 0.5 && speed < 0.5 && f.rootTimer <= 0 && f.hitstunTimer <= 0 && (s.action === 'run' || s.action === 'idle')) {
            if (++wedged[i] > rep.worstWedged) rep.worstWedged = wedged[i];
          } else wedged[i] = 0;
        } else wedged[i] = 0;
      }
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
  if (process.env.OCEAN_REPORT === '1') {
    for (const r of reports) {
      console.log(
        `L${r.level} seed ${r.seed}: ended=${r.ended} t=${r.timeS.toFixed(0)}s stall=${r.worstStall} seatErr=${r.worstSeatError.toFixed(3)} ` +
          `maxAlt=${r.worstAltitude.toFixed(2)} solidPen=${r.freeIntrusion.toFixed(3)} cliffPen=${r.worstCliffPen.toFixed(3)} levels=${[...r.levelsSeen].sort().join('/')} traps=${r.traps.length} wedged=${r.worstWedged} | ${r.seatDebug} | ${r.solidDebug}`,
      );
    }
    const timeouts = reports.filter((r) => !r.ended).length;
    console.log(`OCEAN SMOKE: ${reports.length} matches, ${timeouts} timeouts (>${MAX_SIM_S}s), worst stall ${Math.max(...reports.map((r) => r.worstStall))} frames`);
  }
}, 900_000);

describe('ocean headless smoke (10 bots, every difficulty, several seeds)', () => {
  it('ran every seed at every level', () => {
    expect(reports).toHaveLength(LEVELS.length * SEEDS.length);
  });

  it('no crash and no NaN in any fighter state', () => {
    for (const r of reports) expect(r.nan, `seed ${r.seed} L${r.level}`).toBeNull();
  });

  it('every grounded free fighter stands exactly on the ground of its level; nobody floats; no solid / cliff intrusion', () => {
    for (const r of reports) {
      const tag = `seed ${r.seed} L${r.level}`;
      expect(r.worstSeatError, tag + ' seat').toBeLessThan(0.21);
      expect(r.worstAltitude, tag + ' altitude').toBeLessThan(3.5);
      expect(r.freeIntrusion, tag + ' solid').toBeLessThan(0.25);
      expect(r.worstCliffPen, tag + ' cliff').toBeLessThan(0.3);
    }
  });

  it('fighters are seen on more than one level over the runs (the three levels are all in play across the matches)', () => {
    const seen = new Set<number>();
    for (const r of reports) for (const l of r.levelsSeen) seen.add(l);
    expect(seen.has(0)).toBe(true);
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });

  it('nobody gets WEDGED at a cliff or a ramp seam: a bot steering away from a cliff always comes off it (< 0.5 s)', () => {
    for (const r of reports) expect(r.worstWedged, `seed ${r.seed} L${r.level}`).toBeLessThan(30);
  });

  it('bot stalls (the bots plan paths over the ramps since WP-O2) stay under 300 frames (5 s)', () => {
    for (const r of reports) expect(r.worstStall, `seed ${r.seed} L${r.level}`).toBeLessThan(300);
  });

  it('every match ends inside the cap (no timeouts)', () => {
    for (const r of reports) expect(r.ended, `seed ${r.seed} L${r.level}`).toBe(true);
  });

  it('traps placed at every difficulty: full count, each on a real level', () => {
    for (const r of reports) {
      expect(r.traps.length, `seed ${r.seed} L${r.level}`).toBe(TRAP_COUNT_BY_DIFFICULTY[r.level]);
      for (const t of r.traps) expect([0, 1.5, 3]).toContain(t.y);
    }
  });
});
