/**
 * v1.8 terrain fuzz: a 10-fighter jungle match driven by random (seeded) intents for 20 000 frames. Invariants checked every
 * frame: nothing is NaN, nobody gets stuck inside a tree, the terrain flags agree with the positions the system saw, every
 * flag flip has its splash, the snapshot carries exactly the live flags, and the mole never STARTS a burrow in the water.
 * Plus: two replays with the same seed are identical (flags, multipliers, events).
 */

import { describe, it, expect } from 'vitest';
import { World } from '../../src/sim/World';
import { EventBus } from '../../src/core/EventBus';
import { ANIMAL_IDS } from '../../src/config/animals';
import { JUNGLE_ARENA as J, JUNGLE_POOL_RADIUS } from '../../src/config/arenas';
import { TERRAIN, waterSpeedMultiplier } from '../../src/config/terrain';
import { mulberry32 } from '../../src/core/math';
import type { AnimalId, FighterIntent, GameEvent, MatchConfig } from '../../src/core/types';
import { DT, neutral } from './helpers';

const POOL = J.terrain.find((z) => z.kind === 'water')!;
const MOSS = J.terrain.filter((z) => z.kind === 'moss');
const TREES = J.circles.filter((c) => c.kind === 'tree');
const H = TERRAIN.water.shorelineHysteresis;

function shuffled(seed: number): AnimalId[] {
  const order = [...(ANIMAL_IDS as readonly AnimalId[])];
  const rng = mulberry32(seed ^ 0x9e3779b9);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/** Seeded random-intent driver: wanders (biased towards the pool half the time), swings, blocks, jumps, casts. */
class Driver {
  private readonly rng: () => number;
  private readonly dir: { x: number; z: number; until: number; toPool: boolean }[];
  constructor(seed: number, n: number) {
    this.rng = mulberry32(seed);
    this.dir = Array.from({ length: n }, () => ({ x: 0, z: 0, until: 0, toPool: false }));
  }
  intent(world: World, id: number, frame: number): FighterIntent {
    const r = this.rng;
    const d = this.dir[id];
    const f = world.fighters[id];
    if (frame >= d.until) {
      d.until = frame + 20 + Math.floor(r() * 80);
      d.toPool = r() < 0.5;
      const a = r() * Math.PI * 2;
      d.x = Math.cos(a);
      d.z = Math.sin(a);
    }
    let mx = d.x;
    let mz = d.z;
    if (d.toPool) {
      const dx = POOL.x - f.state.pos.x;
      const dz = POOL.z - f.state.pos.z;
      const l = Math.hypot(dx, dz) || 1;
      mx = dx / l;
      mz = dz / l;
    }
    const i = neutral();
    i.moveX = mx;
    i.moveZ = mz;
    i.aimYaw = Math.atan2(mx, mz);
    i.attack = r() < 0.08;
    i.block = r() < 0.04;
    i.jump = r() < 0.03;
    i.special = r() < 0.03;
    i.ultimate = r() < 0.004;
    if (i.ultimate) f.state.ultCharge = 100;
    return i;
  }
}

interface Pre {
  alive: boolean;
  x: number;
  z: number;
  alt: number;
  phased: boolean;
  inWater: boolean;
  ability: boolean;
}

/** Cheap assertion for the per-frame checks (hundreds of thousands of them): throws with the message. */
function fail(msg: string): never {
  throw new Error(msg);
}

function inAnyMoss(x: number, z: number, r: number): boolean {
  return MOSS.some((m) => Math.hypot(x - m.x, z - m.z) < m.radius + r);
}

function run(seed: number, frames: number, check: boolean) {
  const animals = shuffled(seed);
  const cfg: MatchConfig = { roster: animals.map((a) => ({ animal: a, isPlayer: false })), difficulty: 4, arena: 'jungle' };
  const bus = new EventBus();
  const events: GameEvent[] = [];
  const stepEvents: GameEvent[] = [];
  bus.onAny((e) => {
    events.push(e);
    stepEvents.push(e);
  });
  const world = new World(cfg, seed, bus, { traps: true });
  for (let i = 0; i < 190; i++) world.step(DT); // countdown
  events.length = 0;
  const drv = new Driver(seed * 7 + 1, animals.length);
  const pre: Pre[] = animals.map(() => ({ alive: true, x: 0, z: 0, alt: 0, phased: false, inWater: false, ability: false }));
  const stuck = new Array<number>(animals.length).fill(0);
  const stats = { framesInWater: 0, framesOnMoss: 0, splashes: 0, worstStuck: 0, worstFreePen: 0, moleBlocked: 0, flips: 0 };
  const hash: string[] = [];

  for (let frame = 0; frame < frames; frame++) {
    for (const f of world.fighters) {
      f.state.hp = f.state.maxHp; // nobody dies: the match runs the whole 20 000 frames
      f.state.guard = f.state.maxGuard;
    }
    for (let i = 0; i < animals.length; i++) {
      const f = world.fighters[i];
      const p = pre[i];
      p.alive = f.state.alive;
      p.x = f.state.pos.x;
      p.z = f.state.pos.z;
      p.alt = f.state.pos.y; // arena has no dais: ground height 0
      p.phased = f.untargetable || f.state.burrowT > 0;
      p.inWater = f.inWater;
      p.ability = f.ability !== null;
      world.setIntent(i, drv.intent(world, i, frame));
    }
    stepEvents.length = 0;
    world.step(DT);

    for (let i = 0; i < animals.length; i++) {
      const f = world.fighters[i];
      const s = f.state;
      const p = pre[i];
      if (!Number.isFinite(s.pos.x + s.pos.y + s.pos.z + s.vel.x + s.vel.y + s.vel.z + s.hp + s.yaw + f.terrainSpeedMult)) {
        throw new Error(`NaN/Infinity at frame ${frame} fighter ${i} (${animals[i]})`);
      }
      if (f.inWater) stats.framesInWater++;
      if (f.onMoss) stats.framesOnMoss++;
      if (!check) continue;

      // ── flags vs the positions the terrain system saw (the tick's starting positions) ──
      const where = `f${i} (${animals[i]}) frame ${frame}`;
      const grounded = p.alive && !p.phased && p.alt <= TERRAIN.groundedAlt;
      const d = Math.hypot(p.x - POOL.x, p.z - POOL.z);
      if (!grounded) {
        if (f.inWater || f.onMoss) fail(`${where}: flags set while ungrounded`);
        if (f.terrainSpeedMult !== 1) fail(`${where}: ungrounded multiplier ${f.terrainSpeedMult}`);
      } else {
        if (d <= POOL.radius && !f.inWater) fail(`${where}: centre inside the pool but not inWater`);
        if (d > POOL.radius + H && f.inWater) fail(`${where}: outside the shoreline band but inWater`);
        if (f.onMoss !== inAnyMoss(p.x, p.z, f.def.radius)) fail(`${where}: onMoss disagrees with the position`);
      }
      const w = f.inWater ? waterSpeedMultiplier(f.def) : 1;
      const m = f.mossLingerT > 0 ? 0.65 : 1;
      if (Math.abs(f.terrainSpeedMult - w * m) > 1e-12) fail(`${where}: multiplier ${f.terrainSpeedMult} != ${w * m}`);
      if (f.onMoss && f.mossLingerT !== TERRAIN.moss.lingerS) fail(`${where}: on moss without a full linger`);

      // ── every flip of inWater has exactly its splash (silent only for burrow / untargetable / death) ──
      let nMine = 0;
      let mine: Extract<GameEvent, { type: 'splash' }> | null = null;
      for (const e of stepEvents) {
        if (e.type === 'splash' && e.fighterId === i) {
          nMine++;
          mine = e;
        }
      }
      if (nMine > 1) fail(`${where}: ${nMine} splashes in one tick`);
      if (f.inWater !== p.inWater) {
        stats.flips++;
        if (p.alive && s.alive && !p.phased) {
          if (mine === null) fail(`${where}: inWater flipped without a splash`);
          else {
            if (mine.entering !== f.inWater) fail(`${where}: splash direction wrong`);
            if (!(mine.strength > 0 && mine.strength <= 1)) fail(`${where}: splash strength ${mine.strength}`);
            if (mine.pos.y !== POOL.depth) fail(`${where}: splash not at the water surface`);
          }
        }
      } else if (nMine > 0) {
        fail(`${where}: splash without a flip`);
      }
      stats.splashes += nMine;

      // ── the mole never starts a burrow from the water ──
      if (animals[i] === 'mole' && f.inWater && !p.ability) {
        // (f.inWater is this tick's flag: TerrainSystem runs first in the tick, before the decisions)
        if (stepEvents.some((e) => e.type === 'special' && e.fighterId === i)) fail(`${where}: the mole burrowed from the water`);
        if (f.intent.special) stats.moleBlocked++;
      }

      // ── nobody stuck in a tree ──
      // (underground fighters — the mole's Burrow / ultimate — legitimately pass beneath trunks)
      let pen = 0;
      if (s.burrowT <= 0 && !f.untargetable) {
        for (const t of TREES) pen = Math.max(pen, t.radius + f.def.radius - Math.hypot(s.pos.x - t.x, s.pos.z - t.z));
      }
      if (pen > 0.3) stuck[i]++;
      else stuck[i] = 0;
      stats.worstStuck = Math.max(stats.worstStuck, stuck[i]);
      const free = f.ability === null && s.grabbedById === -1 && f.knockTimer <= 0 && s.grabTargetId === -1 && !f.movementOwned;
      if (free) stats.worstFreePen = Math.max(stats.worstFreePen, pen);
    }

    if (check && frame % 50 === 0) {
      const snap = world.snapshot();
      for (let i = 0; i < animals.length; i++) {
        const f = world.fighters[i];
        const sf = snap.fighters[i];
        if (f.inWater ? sf.inWater !== true : 'inWater' in sf) fail(`snapshot inWater f${i} frame ${frame}`);
        if (f.onMoss ? sf.onMoss !== true : 'onMoss' in sf) fail(`snapshot onMoss f${i} frame ${frame}`);
      }
    }
    if (frame % 25 === 0) {
      hash.push(world.fighters.map((f) => `${f.state.pos.x.toFixed(4)},${f.state.pos.z.toFixed(4)},${f.inWater ? 1 : 0}${f.onMoss ? 1 : 0},${f.terrainSpeedMult.toFixed(6)}`).join('|'));
    }
  }
  return { world, events, stats, hash: hash.join('\n') };
}

describe('terrain fuzz — a 10-fighter jungle match with random intents', () => {
  it('20 000 frames: no NaN, nobody stuck in a tree, flags consistent with positions, splashes match flips', () => {
    const r = run(2025, 20000, true);
    // the fuzz really exercised the terrain
    if (process.env.JUNGLE_REPORT === '1') console.log('terrain fuzz stats', JSON.stringify(r.stats));
    expect(r.stats.framesInWater).toBeGreaterThan(2000);
    expect(r.stats.framesOnMoss).toBeGreaterThan(500);
    expect(r.stats.splashes).toBeGreaterThan(50);
    expect(r.stats.flips).toBeGreaterThan(50);
    expect(r.stats.moleBlocked).toBeGreaterThan(0);
    expect(r.stats.worstStuck, 'longest run inside a trunk (frames)').toBeLessThan(60); // same bound as the J1a smoke: a transient shove never pins a fighter
    expect(r.stats.worstFreePen).toBeLessThan(0.35);
    for (const f of r.world.fighters) expect(f.state.alive).toBe(true);
    const sp = r.events.filter((e) => e.type === 'splash');
    expect(sp.length).toBe(r.stats.splashes);
  }, 120_000);

  it('a second seed (traps, ultimates and flyers included) holds the same invariants', () => {
    const r = run(77, 6000, true);
    expect(r.stats.framesInWater).toBeGreaterThan(300);
    expect(r.stats.worstFreePen).toBeLessThan(0.35);
  }, 60_000);

  it('replays with the same seed are identical: positions, flags, multipliers and the whole event log', () => {
    const a = run(31337, 4000, false);
    const b = run(31337, 4000, false);
    expect(a.hash).toBe(b.hash);
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(JSON.stringify(a.world.snapshot())).toBe(JSON.stringify(b.world.snapshot()));
    expect(a.events.some((e) => e.type === 'splash')).toBe(true);
    // a different seed diverges (the check above is not vacuous)
    const c = run(31338, 4000, false);
    expect(c.hash).not.toBe(a.hash);
  }, 60_000);

  it('the pool radius used by the checks is the arena data (guards against a silent geometry change)', () => {
    expect(POOL.radius).toBe(JUNGLE_POOL_RADIUS);
  });
});
