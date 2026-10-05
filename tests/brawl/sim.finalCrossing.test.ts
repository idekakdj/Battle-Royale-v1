/**
 * v1.7 Crumbling Amphitheatre FINAL FORM: the golden `span` joins the two sun slabs into one walkway in the air so the arena can be crossed
 * once every floor piece is gone. These tests run the SHIPPED data in the REAL simulation (no fixtures):
 *   1. crossing: for EVERY animal a chain of real hops (ground jump + air jumps + air drift, walk-offs, drop-throughs, ledge climbs; each one
 *      verified by actually stepping the sim from a saved state) leads from the top of floorL to the top of floorR and back, over active
 *      platforms only; a control run with the span removed shows what the span buys;
 *   2. walking: a fighter really walks from sunL to sunR over the span at y 3.0 without ever leaving the ground;
 *   3. the span is soft: every animal jumps up onto it from the core pedestal and drops down through it onto the core.
 */

import { describe, expect, it } from 'vitest';
import type { AnimalId } from '../../src/core/types';
import type { BrawlIntent, PlatformDef, StageDef } from '../../src/brawl/types';
import { idleIntent } from '../../src/brawl/types';
import { PHYS } from '../../src/brawl/config';
import { steerTo } from '../../src/brawl/ai/kinematics';
import { MOVESETS, STAGES } from '../../src/brawl/data';
import { BrawlWorld } from '../../src/brawl/sim/BrawlWorld';
import type { BrawlDataSource } from '../../src/brawl/sim/dataSource';
import { DEFAULT_DATA_SOURCE } from '../../src/brawl/sim/dataSource';

const ANIMALS = Object.keys(MOVESETS) as AnimalId[];
const AMPH = STAGES.crumblingAmphitheatre;

const press = (over: Partial<BrawlIntent>): BrawlIntent => ({ ...idleIntent(), ...over });

/** The shipped data, optionally with the Amphitheatre's span removed (the pre-v1.7 final form) for the control run. */
function source(withSpan: boolean): BrawlDataSource {
  if (withSpan) return DEFAULT_DATA_SOURCE;
  const def: StageDef = { ...AMPH, platforms: AMPH.platforms.filter((p) => p.id !== 'span') };
  return { ...DEFAULT_DATA_SOURCE, getStage: (id) => (id === 'crumblingAmphitheatre' ? def : DEFAULT_DATA_SOURCE.getStage(id)) };
}

/** A live Amphitheatre in its FINAL form (every breakable destroyed); fighter 1 (a lion) is parked out of the way. */
function finalWorld(animal: AnimalId, withSpan = true): BrawlWorld {
  const w = new BrawlWorld({ stage: 'crumblingAmphitheatre', roster: [{ animal, isPlayer: false }, { animal: 'lion', isPlayer: false }], difficulty: 1, stocks: 99, timeLimitS: 0 }, 3, source(withSpan));
  w.skipCountdown();
  for (const p of AMPH.platforms) if (p.breakable !== undefined) w.debugHitPlatform(p.id, 0, p.breakable.hits);
  w.drainEvents();
  w.debugPlace(1, 0, 40); // never interferes: far above, falls out through the top blast zone long after every trial has ended
  w.debugSetStocks(1, 99);
  return w;
}

// ── 1. the platform graph, verified hop by hop in the real sim ───────────────

/** A walkable run: active platforms at one height that touch end to end (a soft walkway counts like a floor). */
interface Run {
  lo: number;
  hi: number;
  y: number;
  ids: string[];
  solid: boolean;
}

function runsOf(plats: readonly PlatformDef[]): Run[] {
  const runs: Run[] = [];
  const used = new Set<string>();
  for (const p of plats) {
    if (used.has(p.id)) continue;
    const r: Run = { lo: p.x0, hi: p.x1, y: p.y, ids: [p.id], solid: p.kind === 'solid' };
    used.add(p.id);
    let grew = true;
    while (grew) {
      grew = false;
      for (const q of plats) {
        if (used.has(q.id) || Math.abs(q.y - r.y) > 0.12 || q.x1 < r.lo - 0.1 || q.x0 > r.hi + 0.1) continue;
        used.add(q.id);
        r.ids.push(q.id);
        r.lo = Math.min(r.lo, q.x0);
        r.hi = Math.max(r.hi, q.x1);
        r.solid = r.solid || q.kind === 'solid';
        grew = true;
      }
    }
    runs.push(r);
  }
  return runs;
}

interface Plan {
  mode: 'jump' | 'walk' | 'drop';
  x: number;
  dir: 1 | -1;
  tx: number;
  /** An air jump is spent when the fighter is no longer rising and its feet are at or below this height. */
  jy: number;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * Step the real sim from `base`: put the animal on `from`, execute `plan` and report which run it ends up standing on (-1: none within
 * 200 frames / it fell away). A ledge hang is climbed (Up) like a player would.
 */
function trial(w: BrawlWorld, base: ReturnType<BrawlWorld['saveState']>, animal: AnimalId, from: Run, plan: Plan, runs: Run[]): number {
  const st = MOVESETS[animal].stats;
  w.loadState(base);
  w.debugPlace(0, plan.x, from.y);
  for (let i = 0; i < 4; i++) {
    w.setIntent(0, idleIntent());
    w.step();
  }
  let s = w.snapshot().fighters[0];
  if (!s.grounded || s.platformId === null || !from.ids.includes(s.platformId)) return -1;
  let left = false;
  let lastAirJump = -99;
  for (let f = 0; f < 200; f++) {
    s = w.snapshot().fighters[0];
    if (!s.alive || s.pos.y < from.y - 14) return -1;
    if (!s.grounded && s.action !== 'ledgeHang') left = true;
    let i: BrawlIntent;
    if (s.action === 'ledgeHang') {
      left = true;
      i = press({ moveY: 1 });
    } else if (s.grounded) {
      if (left && s.platformId !== null) {
        const r = runs.findIndex((q) => q.ids.includes(s.platformId as string));
        if (r >= 0) return r;
      }
      if (plan.mode === 'jump') i = press(f === 0 ? { jump: true, jumpHeld: true, moveX: plan.dir * 0.5 } : { jumpHeld: true, moveX: plan.dir * 0.5 });
      else if (plan.mode === 'walk') i = press({ moveX: plan.dir });
      else i = press({ moveY: -1 });
    } else {
      const air = steerTo(s.pos.x, s.vel.x, plan.tx, st.airSpeed);
      const wantJump = s.jumpsLeft > 0 && s.vel.y <= 0.3 && s.pos.y <= plan.jy && f - lastAirJump > 8;
      if (wantJump) lastAirJump = f;
      i = press({ moveX: air, jump: wantJump, jumpHeld: true });
    }
    w.setIntent(0, i);
    w.step();
    w.drainEvents();
  }
  return -1;
}

interface Edge {
  from: number;
  to: number;
  plan: Plan;
}

/** All verified hops out of run `a` that land on a run in `want` (stops at the first plan that works for each target). */
function hopsFrom(w: BrawlWorld, base: ReturnType<BrawlWorld['saveState']>, animal: AnimalId, runs: Run[], a: number, want: number[]): Edge[] {
  const st = MOVESETS[animal].stats;
  const jumpH = (st.jumpVel * st.jumpVel) / (2 * PHYS.gravity * st.gravityMult);
  const airH = ((st.airJumpVel * st.airJumpVel) / (2 * PHYS.gravity * st.gravityMult)) * (st.maxJumps - 1);
  const A = runs[a];
  const out: Edge[] = [];
  for (const b of want) {
    const B = runs[b];
    const rise = B.y - A.y;
    const gap = B.lo > A.hi ? B.lo - A.hi : A.lo > B.hi ? A.lo - B.hi : 0;
    // the cheap pre-filter every planner uses: far beyond the animal's total jump height / a huge gap is hopeless
    if (rise > jumpH + airH + 0.3 || gap > 9) continue;
    const dir: 1 | -1 = B.lo + B.hi > A.lo + A.hi ? 1 : -1;
    const up = rise > 0.4;
    const edgeX = dir > 0 ? A.hi - 0.3 : A.lo + 0.3;
    const xs = [edgeX];
    if (gap === 0) xs.push(clamp((Math.max(A.lo, B.lo) + Math.min(A.hi, B.hi)) / 2, A.lo + 0.4, A.hi - 0.4));
    const modes: Plan['mode'][] = up ? ['jump'] : A.solid ? ['walk'] : ['walk', 'drop'];
    let found = false;
    for (const mode of modes) {
      for (const x of xs) {
        if (mode === 'drop' && x === edgeX && gap > 0) continue;
        for (const tx of [clamp(x + (gap > 0 ? dir * 2.5 : 0), B.lo + 0.9, B.hi - 0.9), (B.lo + B.hi) / 2]) {
          for (const jy of up ? [Infinity, B.y + 1.2, B.y - 0.8] : [-Infinity, B.y + 1.2]) {
            const plan: Plan = { mode, x, dir, tx, jy };
            const landed = trial(w, base, animal, A, plan, runs);
            if (landed === b) {
              out.push({ from: a, to: b, plan });
              found = true;
              break;
            }
          }
          if (found) break;
        }
        if (found) break;
      }
      if (found) break;
    }
  }
  return out;
}

interface Graph {
  runs: Run[];
  /** Verified hops, keyed `from>to` (run indices). */
  edges: Map<string, Plan>;
}

const graphs = new Map<string, Graph>();

/** Every verified hop between the final form's runs for `animal` (each one actually stepped in the sim; memoised). */
function graphOf(animal: AnimalId, withSpan: boolean): Graph {
  const key = `${animal}:${withSpan}`;
  const hit = graphs.get(key);
  if (hit !== undefined) return hit;
  const w = finalWorld(animal, withSpan);
  const base = w.saveState();
  const plats = (withSpan ? AMPH.platforms : AMPH.platforms.filter((p) => p.id !== 'span')).filter((p) => p.finalOnly === true || p.breakable === undefined);
  const runs = runsOf(plats);
  const edges = new Map<string, Plan>();
  runs.forEach((_, a) => {
    for (const e of hopsFrom(w, base, animal, runs, a, runs.map((__, i) => i).filter((i) => i !== a))) edges.set(`${e.from}>${e.to}`, e.plan);
  });
  const g = { runs, edges };
  graphs.set(key, g);
  return g;
}

const runName = (r: Run): string => r.ids.join('+');

/** Shortest chain of verified hops from the run containing `startId` to the one containing `goalId` (null: unreachable). */
function route(animal: AnimalId, withSpan: boolean, startId: string, goalId: string): { path: string[]; hops: number } | null {
  const { runs, edges } = graphOf(animal, withSpan);
  const s = runs.findIndex((r) => r.ids.includes(startId));
  const g = runs.findIndex((r) => r.ids.includes(goalId));
  const prev = new Map<number, number>([[s, -1]]);
  const queue = [s];
  for (let h = 0; h < queue.length && !prev.has(g); h++) {
    for (let k = 0; k < runs.length; k++) {
      if (prev.has(k) || !edges.has(`${queue[h]}>${k}`)) continue;
      prev.set(k, queue[h]);
      queue.push(k);
    }
  }
  if (!prev.has(g)) return null;
  const chain: number[] = [];
  for (let n = g; n >= 0; n = prev.get(n) as number) chain.unshift(n);
  return { path: chain.map((i) => runName(runs[i])), hops: chain.length - 1 };
}

describe('Crumbling Amphitheatre final form: every animal can cross the arena (real sim, real data)', () => {
  const rows: string[] = [];
  for (const animal of ANIMALS) {
    it(`${animal}: floorL -> floorR and back over active platforms only, and the sun walkway is part of a crossing`, () => {
      const g = graphOf(animal, true);
      // the final form is made of exactly five runs: two floors, the pedestal, the sun walkway (sunL + span + sunR) and the halo
      expect(g.runs.map((r) => [...r.ids].sort().join('+')).sort()).toEqual(['core', 'floorL', 'floorR', 'halo', 'span+sunL+sunR']);
      const there = route(animal, true, 'floorL', 'floorR');
      const back = route(animal, true, 'floorR', 'floorL');
      expect(there, `${animal} cannot get from floorL to floorR`).not.toBeNull();
      expect(back, `${animal} cannot get from floorR to floorL`).not.toBeNull();
      // ... and the crossing can use the walkway: floorL -> (pedestal) -> walkway -> floorR, in at most three real hops either way
      const up = route(animal, true, 'floorL', 'span');
      const down = route(animal, true, 'span', 'floorR');
      const upBack = route(animal, true, 'floorR', 'span');
      const downBack = route(animal, true, 'span', 'floorL');
      for (const [name, r] of [['floorL -> walkway', up], ['walkway -> floorR', down], ['floorR -> walkway', upBack], ['walkway -> floorL', downBack]] as const) {
        expect(r, `${animal}: ${name}`).not.toBeNull();
      }
      expect(up!.hops + down!.hops, `${animal} crossing over the walkway`).toBeLessThanOrEqual(3);
      expect(upBack!.hops + downBack!.hops, `${animal} crossing back over the walkway`).toBeLessThanOrEqual(3);
      // every animal can step down from the walkway to BOTH floors in one hop, and reach it from the pedestal in one hop
      expect(down!.hops).toBe(1);
      expect(downBack!.hops).toBe(1);
      expect(route(animal, true, 'core', 'span')!.hops).toBe(1);
      // the control: the pre-v1.7 final form (no span)
      const old = route(animal, false, 'floorL', 'floorR');
      const sh = (r: { path: string[]; hops: number } | null): string => (r === null ? 'NO PATH' : `${r.hops} hops [${r.path.join(' > ')}]`);
      rows.push(`${animal.padEnd(9)} floorL->floorR ${sh(there)} | via walkway ${up!.hops}+${down!.hops} [${[...up!.path, ...down!.path.slice(1)].join(' > ')}] | no-span control ${sh(old)}`);
      if (old !== null) expect(there!.hops).toBeLessThanOrEqual(old.hops);
      // without the span the walkway does not exist: sunL and sunR are two separate islands in the air
      const oldRuns = graphOf(animal, false).runs.map((r) => [...r.ids].sort().join('+'));
      expect(oldRuns).toContain('sunL');
      expect(oldRuns).toContain('sunR');
    }, 120000);
  }
  it('prints the route table', () => {
    // eslint-disable-next-line no-console
    console.log(['[crumblingAmphitheatre final form] verified crossing routes (real sim):', ...rows].join('\n'));
    // eslint-disable-next-line no-console
    console.log(
      ANIMALS.map((a) => {
        const g = graphOf(a, true);
        return `${a.padEnd(9)} hops: ${[...g.edges.keys()].map((k) => k.split('>').map((i) => runName(g.runs[Number(i)]).slice(0, 8)).join('>')).join('  ')}`;
      }).join('\n'),
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});

// ── 2. walking across the span ───────────────────────────────────────────────

describe('Crumbling Amphitheatre final form: walking over the span', () => {
  for (const animal of ANIMALS) {
    it(`${animal}: walks from sunL over the span to sunR (and back) at y 3.0 without ever leaving the ground`, () => {
      for (const dir of [1, -1] as const) {
        const w = finalWorld(animal);
        const startId = dir > 0 ? 'sunL' : 'sunR';
        const lastId = dir > 0 ? 'sunR' : 'sunL';
        w.debugPlace(0, dir * -9.5, 3);
        for (let i = 0; i < 4; i++) w.step();
        expect(w.snapshot().fighters[0]).toMatchObject({ grounded: true, platformId: startId });
        const visited: string[] = [];
        let arrived = -1;
        for (let f = 0; f < 600 && arrived < 0; f++) {
          w.setIntent(0, press({ moveX: dir }));
          w.step();
          w.drainEvents();
          const s = w.snapshot().fighters[0];
          expect(Number.isFinite(s.pos.x + s.pos.y)).toBe(true);
          // over the walkway: never airborne, never lower than 3.0, never a hop up
          expect(s.grounded, `frame ${f} at x ${s.pos.x.toFixed(2)}`).toBe(true);
          expect(s.pos.y).toBeCloseTo(3, 9);
          if (s.platformId !== null && visited[visited.length - 1] !== s.platformId) visited.push(s.platformId);
          if (s.pos.x * dir >= 9.5) arrived = f;
        }
        expect(visited, `${animal} dir ${dir}`).toEqual([startId, 'span', lastId]);
        // 19 m of walkway at run speed takes well under 8 s even for the hippo (run speed 6.5 m/s)
        expect(arrived).toBeGreaterThan(0);
        expect(arrived).toBeLessThan(8 * 60);
        // let go: it stops on the far slab (still on the high walkway, still at 3.0)
        for (let f = 0; f < 30; f++) {
          w.setIntent(0, press({}));
          w.step();
          w.drainEvents();
        }
        const e = w.snapshot().fighters[0];
        expect(e).toMatchObject({ grounded: true, platformId: lastId });
        expect(e.pos.y).toBeCloseTo(3, 9);
      }
    });
  }

  it('the whole walk is deterministic (same inputs, same checksums)', () => {
    const go = (): number => {
      const w = finalWorld('hippo');
      w.debugPlace(0, -9.5, 3);
      for (let f = 0; f < 400; f++) {
        w.setIntent(0, press({ moveX: 1 }));
        w.step();
        w.drainEvents();
      }
      return w.checksum();
    };
    expect(go()).toBe(go());
  });
});

// ── 3. the span is soft: up through it from the pedestal, down through it onto the pedestal ──

describe('Crumbling Amphitheatre final form: the span is a soft platform above the core pedestal', () => {
  const core = AMPH.platforms.find((p) => p.id === 'core')!;
  const span = AMPH.platforms.find((p) => p.id === 'span')!;

  for (const animal of ANIMALS) {
    it(`${animal}: jumps up through the span from the core (ground jump, air jump at the apex if needed) and drops back through it onto the core`, () => {
      const w = finalWorld(animal);
      w.debugPlace(0, 0, core.y);
      for (let i = 0; i < 4; i++) w.step();
      expect(w.snapshot().fighters[0]).toMatchObject({ grounded: true, platformId: 'core' });
      let landed = false;
      let usedAir = false;
      let maxY = core.y;
      for (let f = 0; f < 150 && !landed; f++) {
        const s0 = w.snapshot().fighters[0];
        const air = !s0.grounded && !usedAir && s0.vel.y <= 0.3 && s0.jumpsLeft > 0 && s0.pos.y < span.y + 0.2;
        if (air) usedAir = true;
        w.setIntent(0, press({ jump: f === 0 || air, jumpHeld: true }));
        w.step();
        w.drainEvents();
        const s = w.snapshot().fighters[0];
        maxY = Math.max(maxY, s.pos.y);
        landed = s.grounded && s.platformId === 'span';
      }
      expect(landed, `lands on top of the span (apex ${maxY.toFixed(2)})`).toBe(true);
      expect(maxY).toBeGreaterThan(span.y); // it went up THROUGH the soft span (no bonk) and came down onto it
      expect(w.snapshot().fighters[0].pos.y).toBeCloseTo(span.y, 9);
      // stand a moment, then press Down in the middle of the span: it falls through and lands on the pedestal again
      for (let i = 0; i < 6; i++) {
        w.setIntent(0, press({}));
        w.step();
      }
      let down = false;
      for (let f = 0; f < 120 && !down; f++) {
        w.setIntent(0, press({ moveY: -1 }));
        w.step();
        w.drainEvents();
        const s = w.snapshot().fighters[0];
        down = s.grounded && s.platformId === 'core';
      }
      expect(down, 'drops through the span onto the core').toBe(true);
      expect(w.snapshot().fighters[0].pos.y).toBeCloseTo(core.y, 9);
    });
  }
});
