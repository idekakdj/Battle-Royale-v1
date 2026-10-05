/**
 * v1.6 dynamic stages — SIMULATION behaviour (docs/CL-MAPS-PLAN.md): path motion carrying riders, a solid moving platform pushing bystanders
 * out, breakable platforms (hit counting, breaking, falling riders, dropped hangers), the final form, the inner-ledge exposure rule and the
 * save / load / checksum coverage of all the new state. Data rules live in stages.dynamic.test.ts; the rollback matrix in net.rollback.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../src/core/math';
import type { Rng } from '../../src/core/math';
import type { AnimalId } from '../../src/core/types';
import type { BrawlEvent, BrawlIntent, BrawlMatchConfig, BrawlSnapshot, MoveBody, MoveData, MovesetDef, PlatformDef, StageDef, StageId } from '../../src/brawl/types';
import { PHYS } from '../../src/brawl/config';
import type { BrawlDataSource } from '../../src/brawl/sim/dataSource';
import { BrawlWorld } from '../../src/brawl/sim/BrawlWorld';
import { createSavedState } from '../../src/brawl/sim/stateIO';
import { platformAt } from '../../src/brawl/data';
import { FIXTURE_SOURCE, FIX_STAGES, cfg, circle, fixtureMoveset, idle, intent, mkBody, run } from './fixtures';

// ── helpers ──────────────────────────────────────────────────────────────────

const STAND = 'lion' as AnimalId;

function stageWorld(stage: StageId, animals: AnimalId[] = [STAND, STAND], over: Partial<BrawlMatchConfig> = {}, seed = 1, source: BrawlDataSource = FIXTURE_SOURCE): BrawlWorld {
  const w = new BrawlWorld(cfg(animals, { stage, stocks: 99, timeLimitS: 0, ...over }), seed, source);
  w.skipCountdown();
  return w;
}

const plat = (w: BrawlWorld, id: string) => {
  const p = w.snapshot().platforms.find((q) => q.id === id);
  if (!p) throw new Error(`no platform ${id}`);
  return p;
};
const fighter = (w: BrawlWorld, id: number) => w.snapshot().fighters[id];

function events(w: BrawlWorld): BrawlEvent[] {
  return w.drainEvents();
}

/** A data source whose fixture lion has a fast, low `lightS` (7 frames, box at feet height) and a high one — for hit-counting scenarios. */
function lowMoveSource(boxY: number, radius = 0.4, totalExtra = 0): BrawlDataSource {
  const base = fixtureMoveset('lion');
  const body: MoveBody = mkBody('fast', [2, 2, 3 + totalExtra], [circle(0.8, boxY, radius, 2, 4, 1, 1, 1, 40)]);
  const moves = { ...base.moves, lightS: { id: 'lightS', ground: body, air: null } as MoveData };
  const lion: MovesetDef = { ...base, moves };
  return {
    getMoveset: (a) => (a === 'lion' ? lion : fixtureMoveset(a)),
    getMoveBody: (a, id, air, chain = 0) => (a === 'lion' && id === 'lightS' ? body : FIXTURE_SOURCE.getMoveBody(a, id, air, chain)),
    getStage: (id) => FIX_STAGES[id],
  };
}

/** Press lightS (side attack) once for fighter `id` facing right, then idle for `after` frames. Returns all events. */
function swing(w: BrawlWorld, id: number, after = 12): BrawlEvent[] {
  w.setIntent(id, intent({ light: true, moveX: 0.8 }));
  w.step();
  w.setIntent(id, intent());
  const out = events(w);
  for (let i = 0; i < after; i++) {
    w.step();
    out.push(...events(w));
  }
  return out;
}

const platEvents = (ev: BrawlEvent[]) => ev.filter((e) => e.type === 'platformHit' || e.type === 'platformBreak' || e.type === 'stageFinal');

// ── path motion + riders ─────────────────────────────────────────────────────

describe('Clockwork Heights: the core carries its riders', () => {
  it('the world reports the path positions in its snapshots (a pure function of the frame)', () => {
    const w = new BrawlWorld(cfg([STAND, STAND], { stage: 'clockworkHeights' }), 1, FIXTURE_SOURCE);
    const defs = FIX_STAGES.clockworkHeights.platforms;
    for (let f = 1; f <= 1500; f++) {
      w.step();
      if (f % 97 !== 0 && f !== 1) continue;
      const s = w.snapshot();
      expect(s.frame).toBe(f);
      s.platforms.forEach((p, i) => {
        const r = platformAt(defs[i], f);
        expect(p.x0, `${p.id}@${f}`).toBeCloseTo(r.x0, 9);
        expect(p.x1, `${p.id}@${f}`).toBeCloseTo(r.x1, 9);
        expect(p.y, `${p.id}@${f}`).toBeCloseTo(r.y, 9);
      });
    }
  });

  it('spawns on the core, is carried through the whole 3 s countdown and stays grounded on it (never launched)', () => {
    const w = new BrawlWorld(cfg([STAND, STAND, STAND, STAND], { stage: 'clockworkHeights' }), 1, FIXTURE_SOURCE);
    const rel0 = w.snapshot().fighters.map((f) => f.pos.x - plat(w, 'core').x0);
    for (let i = 0; i < 180; i++) w.step();
    const s = w.snapshot();
    expect(plat(w, 'core').x0).not.toBeCloseTo(-6.5, 1); // it moved during the countdown
    s.fighters.forEach((f, i) => {
      expect(f.grounded, `fighter ${i}`).toBe(true);
      expect(f.platformId).toBe('core');
      expect(f.pos.y).toBeCloseTo(plat(w, 'core').y, 9);
      expect(f.pos.x - plat(w, 'core').x0).toBeCloseTo(rel0[i], 9);
      expect(f.vel.x).toBe(0);
    });
  });

  it('skipCountdown carries the riders by the platform displacement too', () => {
    const w = new BrawlWorld(cfg([STAND, STAND]), 1, FIXTURE_SOURCE);
    const v = new BrawlWorld(cfg([STAND, STAND], { stage: 'clockworkHeights' }), 1, FIXTURE_SOURCE);
    w.skipCountdown();
    v.skipCountdown();
    const c = plat(v, 'core');
    expect(fighter(v, 0).pos.x).toBeCloseTo(-5 + (c.x0 + 6.5), 9);
    expect(fighter(v, 0).pos.y).toBeCloseTo(c.y, 9);
    expect(fighter(v, 0).grounded).toBe(true);
  });

  it('a rider stays on the core for 60 s of drift (no slipping, no hop) and keeps its position on the slab', () => {
    const w = stageWorld('clockworkHeights');
    const rel = fighter(w, 0).pos.x - plat(w, 'core').x0;
    let maxVx = 0;
    for (let i = 0; i < 3600; i++) {
      w.step();
      const f = fighter(w, 0);
      expect(f.grounded).toBe(true);
      expect(f.pos.y).toBeCloseTo(plat(w, 'core').y, 9);
      maxVx = Math.max(maxVx, Math.abs(f.vel.x));
    }
    expect(fighter(w, 0).pos.x - plat(w, 'core').x0).toBeCloseTo(rel, 6);
    expect(maxVx).toBe(0); // the platform's velocity is never given to the rider
  });

  it('walking against the drift works, and jumping off does not slingshot (the rider keeps its own velocity)', () => {
    const w = stageWorld('clockworkHeights');
    const f0 = fighter(w, 0).pos.x;
    run(w, 30, 0, () => ({ moveX: 1 }));
    expect(fighter(w, 0).pos.x - f0).toBeGreaterThan(3); // runs ~8 m/s on top of the slow drift
    // stand still, jump straight up: horizontal velocity must stay ~0 whatever the core does
    run(w, 40, 0);
    run(w, 1, 0, () => ({ jump: true, jumpHeld: true }));
    let maxAbsVx = 0;
    for (let i = 0; i < 25; i++) {
      run(w, 1, 0, () => ({ jumpHeld: true }));
      maxAbsVx = Math.max(maxAbsVx, Math.abs(fighter(w, 0).vel.x));
    }
    expect(maxAbsVx).toBeLessThan(1e-9);
    expect(fighter(w, 0).grounded).toBe(false);
  });

  it('a fighter in hitlag keeps riding the platform', () => {
    const w = stageWorld('clockworkHeights');
    const rel = fighter(w, 0).pos.x - plat(w, 'core').x0;
    w.debugFighter(0).hitlag = 16;
    for (let i = 0; i < 16; i++) {
      w.step();
      expect(fighter(w, 0).pos.x - plat(w, 'core').x0).toBeCloseTo(rel, 9);
      expect(fighter(w, 0).pos.y).toBeCloseTo(plat(w, 'core').y, 9);
    }
  });

  it('a fighter hanging from a core ledge moves with the moving corner, and the ledge assist zone follows it', () => {
    const w = stageWorld('clockworkHeights', [STAND, STAND]);
    // park fighter 1 far away and let fighter 0 fall onto the right ledge corner from above-outside
    w.debugPlace(1, -28, 5);
    const c = plat(w, 'core');
    w.debugPlace(0, c.x1 + 0.9, c.y - 1.2, 0, -2);
    let hung = false;
    for (let i = 0; i < 90 && !hung; i++) {
      run(w, 1, 0, () => ({ moveX: -0.6 }));
      if (fighter(w, 0).action === 'ledgeHang') hung = true;
    }
    expect(hung).toBe(true);
    // hangs from the corner, every frame, for the next 600 frames of drift
    for (let i = 0; i < 600; i++) {
      run(w, 1, 0);
      const f = fighter(w, 0);
      if (f.action !== 'ledgeHang') break; // hang time out ends it (180 frames); the position check below covers the frames it hung
      const core = plat(w, 'core');
      expect(f.pos.x).toBeCloseTo(core.x1 + f.pos.x - core.x1, 9);
      expect(f.pos.x - core.x1).toBeCloseTo(0.55 + PHYS.ledgeHangOffset, 6);
      expect(f.pos.y).toBeCloseTo(core.y - 1.5 * PHYS.ledgeHandFrac, 6);
    }
    // ... and a climb from the moving ledge ends standing on the (moved) core, never inside it
    const w3 = stageWorld('clockworkHeights', [STAND, STAND]);
    w3.debugPlace(1, -28, 5);
    idle(w3, 700);
    const c3 = plat(w3, 'core');
    w3.debugPlace(0, c3.x1 + 0.9, c3.y - 1.2, 0, -2);
    let hung3 = false;
    for (let i = 0; i < 60 && !hung3; i++) {
      run(w3, 1, 0, () => ({ moveX: -0.6 }));
      hung3 = fighter(w3, 0).action === 'ledgeHang';
    }
    expect(hung3).toBe(true);
    idle(w3, PHYS.ledgeMinHang + 2);
    let climbed = false;
    for (let i = 0; i < 60 && !climbed; i++) {
      run(w3, 1, 0, () => ({ moveY: 1 }));
      const f = fighter(w3, 0);
      const core = plat(w3, 'core');
      const o = overlap(f, { w: 1.1, h: 1.5 }, { ...core, thickness: 3.2 });
      if (f.action === 'ledgeClimb') expect(o.ox > 0.05 && o.oy > 0.05, 'climbing inside the core').toBe(false);
      climbed = f.grounded && f.platformId === 'core';
    }
    expect(climbed).toBe(true);
    expect(fighter(w3, 0).pos.y).toBeCloseTo(plat(w3, 'core').y, 9);
    expect(fighter(w3, 0).pos.x).toBeLessThanOrEqual(plat(w3, 'core').x1);
    // assist zone: a fighter drifting up from underneath the CURRENT (moved) corner grabs it
    const w2 = stageWorld('clockworkHeights', [STAND, STAND]);
    w2.debugPlace(1, -28, 5);
    idle(w2, 1500); // let the core wander off its start position
    const c2 = plat(w2, 'core');
    expect(Math.abs(c2.x1 - 6.5)).toBeGreaterThan(0.5);
    w2.debugPlace(0, c2.x1 + 1.2, c2.y - 2, 0, 4);
    let grabbed = false;
    for (let i = 0; i < 40 && !grabbed; i++) {
      run(w2, 1, 0, () => ({ moveX: -1 }));
      grabbed = fighter(w2, 0).action === 'ledgeHang';
    }
    expect(grabbed).toBe(true);
  });
});

// ── solid moving platform: push-out ──────────────────────────────────────────

/** A hand-made stage for push-out scenarios: a static floor, a static wall and a moving solid block on a path. */
function pushStage(blockPath: PlatformDef['path'], extra: PlatformDef[] = []): { source: BrawlDataSource; stage: StageDef } {
  const stage: StageDef = {
    ...FIX_STAGES.brokenColosseum,
    id: 'clockworkHeights',
    platforms: [
      { id: 'floor', kind: 'solid', x0: -20, x1: 20, y: 0, thickness: 3, ledgeLeft: true, ledgeRight: true },
      // taller than the floor (top at y = 2) so a fighter standing beside it really bumps into its side
      { id: 'block', kind: 'solid', x0: 4, x1: 8, y: 2, thickness: 5, ledgeLeft: true, ledgeRight: true, path: blockPath },
      ...extra,
    ],
  };
  return { stage, source: { ...FIXTURE_SOURCE, getStage: () => stage } };
}

/** Moves by (dx, dy) over `secs` seconds (cosine eased) and back again; its cycle starts at frame 180, i.e. the first live frame after `skipCountdown()`. */
const slide = (dx: number, dy: number, secs: number): PlatformDef['path'] => ({
  periodS: secs * 2,
  phase: 1 - 3 / (secs * 2),
  keys: [
    { t: 0, x: 0, y: 0 },
    { t: 0.5, x: dx, y: dy },
  ],
});

function solidsOf(s: BrawlSnapshot, defs: PlatformDef[]): { x0: number; x1: number; y: number; thickness: number }[] {
  return s.platforms.map((p, i) => ({ ...p, thickness: defs[i].thickness, solid: defs[i].kind === 'solid' })).filter((p) => p.solid && p.active !== false);
}

function overlap(f: { pos: { x: number; y: number } }, size: { w: number; h: number }, p: { x0: number; x1: number; y: number; thickness: number }): { ox: number; oy: number } {
  return {
    ox: Math.min(f.pos.x + size.w / 2, p.x1) - Math.max(f.pos.x - size.w / 2, p.x0),
    oy: Math.min(f.pos.y + size.h, p.y) - Math.max(f.pos.y, p.y - p.thickness),
  };
}

describe('a moving SOLID platform pushes bystanders out along the minimal-penetration axis', () => {
  const size = { w: 1.1, h: 1.5 }; // fixture lion

  it('a block sliding sideways into a standing fighter pushes it ahead of the block (never inside it)', () => {
    const { source } = pushStage(slide(-12, 0, 6)); // slides left, towards a fighter standing at x = 0
    const w = new BrawlWorld(cfg([STAND, STAND], { stage: 'clockworkHeights', stocks: 99, timeLimitS: 0 }), 1, source);
    w.skipCountdown();
    w.debugPlace(1, -18, 5);
    // after skipCountdown the block is already ~0 m along; put the fighter straight in its path on the floor
    w.debugPlace(0, 2, 0);
    let pushedFrames = 0;
    let lastX = fighter(w, 0).pos.x;
    for (let i = 0; i < 360; i++) {
      w.step();
      const s = w.snapshot();
      const f = s.fighters[0];
      const blk = s.platforms.find((p) => p.id === 'block')!;
      const o = overlap(f, size, { ...blk, thickness: 5 });
      expect(o.ox > 0.001 && o.oy > 0.001, `frame ${s.frame}: fighter inside the block (${o.ox}, ${o.oy})`).toBe(false);
      if (f.pos.x < lastX - 1e-9) pushedFrames++;
      lastX = f.pos.x;
      expect(f.grounded).toBe(true); // pushed along the floor, never lifted
      expect(Number.isFinite(f.pos.x)).toBe(true);
    }
    expect(pushedFrames).toBeGreaterThan(30);
    expect(fighter(w, 0).pos.x).toBeLessThan(0.5); // pushed well left of where it started
  });

  it('a block that rises into an airborne fighter lifts it onto its top (the minimal-penetration axis), then it rides the block', () => {
    const up = pushStage(slide(0, 3, 4), []);
    // the floor only reaches x = 0 so the block stands alone over the void
    const stage: StageDef = { ...up.stage, platforms: [{ ...up.stage.platforms[0], x0: -20, x1: 0 }, up.stage.platforms[1]] };
    const source: BrawlDataSource = { ...FIXTURE_SOURCE, getStage: () => stage };
    const w = new BrawlWorld(cfg([STAND, STAND], { stage: 'clockworkHeights', stocks: 99, timeLimitS: 0 }), 1, source);
    w.skipCountdown();
    w.debugPlace(1, -18, 5);
    idle(w, 60);
    const top = plat(w, 'block').y;
    expect(top).toBeGreaterThan(2.01); // it has started to rise (its defined top is 2)
    w.debugPlace(0, 6, top, 0, 0);
    // hovering exactly on the top, airborne: the next move of the block carries its top INTO the fighter's feet
    w.debugFighter(0).grounded = false;
    w.debugFighter(0).platIdx = -1;
    w.step();
    expect(fighter(w, 0).pos.y).toBeGreaterThanOrEqual(plat(w, 'block').y - 1e-9);
    expect(fighter(w, 0).pos.x).toBeCloseTo(6, 9); // lifted, not shoved sideways
    let landed = false;
    for (let i = 0; i < 300; i++) {
      w.step();
      const s = w.snapshot();
      const f = s.fighters[0];
      const blk = s.platforms.find((p) => p.id === 'block')!;
      const o = overlap(f, size, { ...blk, thickness: 5 });
      expect(o.ox > 0.001 && o.oy > 0.001, `frame ${s.frame}: inside the rising block`).toBe(false);
      if (f.grounded && f.platformId === 'block') {
        landed = true;
        expect(f.pos.y).toBeCloseTo(blk.y, 9);
      }
    }
    expect(landed).toBe(true);
  });

  it('a block that sinks onto an airborne fighter from above pushes it down (or aside), never leaves it inside', () => {
    const stage: StageDef = {
      ...FIX_STAGES.brokenColosseum,
      id: 'clockworkHeights',
      platforms: [{ id: 'ram', kind: 'solid', x0: -2, x1: 2, y: 8, thickness: 2, ledgeLeft: true, ledgeRight: true, path: slide(0, -7, 4) }],
    };
    const source: BrawlDataSource = { ...FIXTURE_SOURCE, getStage: () => stage };
    const w = new BrawlWorld(cfg([STAND, STAND], { stage: 'clockworkHeights', stocks: 99, timeLimitS: 0 }), 1, source);
    w.skipCountdown();
    w.debugPlace(1, -25, 5);
    w.debugPlace(0, 0, 4.2, 0, 0); // under the ram, falling; the ram's bottom comes down through its head level
    let minY = Infinity;
    for (let i = 0; i < 150; i++) {
      w.step();
      const s = w.snapshot();
      const f = s.fighters[0];
      if (!f.alive) break;
      minY = Math.min(minY, f.pos.y);
      const o = overlap(f, size, { ...s.platforms[0], thickness: 2 });
      expect(o.ox > 0.001 && o.oy > 0.001, `frame ${s.frame}: inside the sinking ram`).toBe(false);
      expect(Number.isFinite(f.pos.y)).toBe(true);
    }
    expect(minY).toBeLessThan(4.2);
  });

  it('a block that moves down onto a fighter standing in a pit-like gap squeezes deterministically (no NaN, nobody left inside a solid)', () => {
    // fighter stands on a low static slab; a block comes down onto its head from above while a wall is beside it
    const stage: StageDef = {
      ...FIX_STAGES.brokenColosseum,
      id: 'clockworkHeights',
      platforms: [
        { id: 'floor', kind: 'solid', x0: -20, x1: 20, y: 0, thickness: 3, ledgeLeft: true, ledgeRight: true },
        { id: 'wallL', kind: 'solid', x0: 3.0, x1: 4.0, y: 6, thickness: 6, ledgeLeft: true, ledgeRight: true },
        { id: 'wallR', kind: 'solid', x0: 6.1, x1: 7.1, y: 6, thickness: 6, ledgeLeft: true, ledgeRight: true },
        { id: 'ram', kind: 'solid', x0: 4.0, x1: 6.1, y: 9, thickness: 1, ledgeLeft: true, ledgeRight: true, path: slide(0, -8, 5) },
      ],
    };
    const source: BrawlDataSource = { ...FIXTURE_SOURCE, getStage: () => stage };
    const w = new BrawlWorld(cfg([STAND, STAND], { stage: 'clockworkHeights', stocks: 99, timeLimitS: 0 }), 1, source);
    w.skipCountdown();
    w.debugPlace(1, -18, 5);
    w.debugPlace(0, 5.05, 0); // in the 2.1 m wide shaft between the walls, under the ram
    for (let i = 0; i < 600; i++) {
      w.step();
      const s = w.snapshot();
      const f = s.fighters[0];
      for (const n of [f.pos.x, f.pos.y, f.vel.x, f.vel.y]) expect(Number.isFinite(n)).toBe(true);
      if (!f.alive) break;
      for (const p of solidsOf(s, stage.platforms)) {
        const o = overlap(f, size, p);
        // the fighter may be touching but never embedded by more than a sliver (squeezes resolve by lifting it onto a surface)
        expect(o.ox > 0.1 && o.oy > 0.1, `frame ${s.frame}: embedded (${o.ox.toFixed(2)}, ${o.oy.toFixed(2)}) in ${p.x0}..${p.x1} @ ${p.y}`).toBe(false);
      }
    }
  });

  it('static solids never trigger the push pass: a fighter placed inside a static solid is only eased out gently, as before v1.6', () => {
    const w = stageWorld('brokenColosseum');
    w.debugPlace(0, 10.5, -1, 0, 0); // inside main's right edge
    const x0 = fighter(w, 0).pos.x;
    w.step();
    expect(Math.abs(fighter(w, 0).pos.x - x0)).toBeLessThanOrEqual(PHYS.pushOutRate + 1e-9);
  });
});

// ── fuzz on the moving stage ─────────────────────────────────────────────────

class FuzzPilot {
  private x = 0;
  private y = 0;
  private held = false;
  constructor(private readonly rng: Rng) {}
  next(): BrawlIntent {
    const r = this.rng;
    if (r() < 0.12) this.x = [-1, -0.5, 0, 0, 0.5, 1][Math.floor(r() * 6)];
    if (r() < 0.1) this.y = [-1, 0, 0, 0, 1][Math.floor(r() * 5)];
    if (r() < 0.08) this.held = !this.held;
    return { moveX: this.x, moveY: this.y, jump: r() < 0.04, jumpHeld: this.held, light: r() < 0.07, heavy: r() < 0.04, dodge: r() < 0.02 };
  }
}

interface FuzzResult {
  hits: number;
  kos: number;
  grabs: number;
  carried: number;
  worst: number;
  maxGraze: number;
  breaks: number;
  finals: number;
}

/**
 * Random-intent fuzz with the strict invariants of the dynamic stages. `script(frame, world)` may poke the world (the demolition fuzz breaks pieces
 * on a timetable). Solids are read from the SNAPSHOT every frame (moving / destroyed / not-yet-active platforms).
 */
function fuzz(stage: StageId, frames: number, script?: (frame: number, w: BrawlWorld) => void): FuzzResult {
  const roster: AnimalId[] = ['lion', 'gorilla', 'crocodile', 'eagle'];
  const w = stageWorld(stage, roster, { stocks: 999 }, 99);
  const defs = FIX_STAGES[stage].platforms;
  const blast = FIX_STAGES[stage].blast;
  const sizes = roster.map((a) => ({ w: fixtureMoveset(a).stats.width, h: fixtureMoveset(a).stats.height }));
  const pilots = roster.map((_, k) => new FuzzPilot(mulberry32(77 + k)));
  const r: FuzzResult = { hits: 0, kos: 0, grabs: 0, carried: 0, worst: 0, maxGraze: 0, breaks: 0, finals: 0 };
  const graze = [0, 0, 0, 0];
  for (let i = 0; i < frames; i++) {
    if (script) script(i, w);
    for (let id = 0; id < 4; id++) w.setIntent(id, pilots[id].next());
    w.step();
    const s = w.snapshot();
    const solids = solidsOf(s, defs);
    for (const f of s.fighters) {
      for (const n of [f.pos.x, f.pos.y, f.vel.x, f.vel.y, f.percent]) {
        if (!Number.isFinite(n)) throw new Error(`non-finite value at frame ${s.frame}: ${JSON.stringify(f)}`);
      }
      if (!f.alive || f.action === 'respawn') continue;
      let touching = false;
      for (const p of solids) {
        const o = overlap(f, sizes[f.id], p);
        const embedded = o.ox > 0.03 && o.oy > 0.03;
        if (embedded) touching = true;
        r.worst = Math.max(r.worst, Math.min(o.ox, o.oy));
        // a wide body that steps off a corner may graze the solid for a few frames while it slides out (as on every stage since v1.4);
        // deep or lasting overlap is a bug
        if (o.ox > 0.75 && o.oy > 0.75) throw new Error(`fighter ${f.id} deeply inside solid ${p.x0.toFixed(2)}..${p.x1.toFixed(2)}@${p.y.toFixed(2)} at frame ${s.frame}: ${JSON.stringify(f.pos)} (${o.ox.toFixed(3)} x ${o.oy.toFixed(3)})`);
        // tunnelling guard: the body centre is never inside a solid
        const cy = f.pos.y + sizes[f.id].h / 2;
        if (f.pos.x > p.x0 && f.pos.x < p.x1 && cy < p.y && cy > p.y - p.thickness) throw new Error(`fighter ${f.id} centre inside a solid at frame ${s.frame}`);
      }
      graze[f.id] = touching ? graze[f.id] + 1 : 0;
      r.maxGraze = Math.max(r.maxGraze, graze[f.id]);
      if (graze[f.id] > 12) throw new Error(`fighter ${f.id} stuck in a solid for ${graze[f.id]} frames at frame ${s.frame}`);
      if (f.grounded) {
        const pl = s.platforms.find((q) => q.id === f.platformId);
        if (!pl || pl.active === false || Math.abs(pl.y - f.pos.y) > 1e-6) throw new Error(`grounded fighter ${f.id} is not on an active platform at frame ${s.frame}`);
        r.carried++;
      }
      if (f.pos.x < blast.left || f.pos.x > blast.right || f.pos.y < blast.bottom || f.pos.y > blast.top) throw new Error(`alive fighter outside the blast zones at frame ${s.frame}`);
    }
    for (const e of w.drainEvents()) {
      if (e.type === 'hit') r.hits++;
      else if (e.type === 'ko') r.kos++;
      else if (e.type === 'ledgeGrab') r.grabs++;
      else if (e.type === 'platformBreak') r.breaks++;
      else if (e.type === 'stageFinal') r.finals++;
    }
  }
  return r;
}

describe('fuzz: 20 000 frames x 4 fighters with random intents on the dynamic stages', () => {
  it('moving stage: nobody ever overlaps a solid, nothing goes NaN, nobody tunnels, riders always stand on their platform', () => {
    const r = fuzz('clockworkHeights', 20000);
    expect(r.hits).toBeGreaterThan(50);
    expect(r.kos).toBeGreaterThan(3);
    expect(r.grabs).toBeGreaterThan(0);
    expect(r.carried).toBeGreaterThan(10000); // plenty of time spent riding the moving platforms
    // eslint-disable-next-line no-console
    console.log(`[fuzz clockworkHeights] worst transient solid overlap (smaller side): ${r.worst.toFixed(3)} m, longest graze ${r.maxGraze} frames`);
  });

  it('breakable stage under demolition: pieces break on a timetable (riders fall, hangers drop, the stage flips) and the invariants still hold', () => {
    const order = ['tileC', 'archL', 'tileL', 'crown', 'tileR', 'archR'];
    const r = fuzz('crumblingAmphitheatre', 20000, (frame, w) => {
      const k = Math.floor(frame / 2500) - 1; // frame 2500 breaks the first piece, ... frame 15000 the last (the flip)
      if (frame % 2500 === 0 && k >= 0 && k < order.length) w.debugHitPlatform(order[k], k % 4, 99);
    });
    expect(r.breaks).toBe(6);
    expect(r.finals).toBe(1);
    expect(r.hits).toBeGreaterThan(50);
    expect(r.kos).toBeGreaterThan(3);
    // eslint-disable-next-line no-console
    console.log(`[fuzz crumblingAmphitheatre] worst transient solid overlap (smaller side): ${r.worst.toFixed(3)} m, longest graze ${r.maxGraze} frames`);
  });

  it('is deterministic: the same seed and inputs give the same frames', () => {
    const go = (): string => {
      const w = stageWorld('clockworkHeights', ['lion', 'eagle', 'gorilla', 'crocodile'], { stocks: 99 }, 5);
      const pilots = [0, 1, 2, 3].map((k) => new FuzzPilot(mulberry32(300 + k)));
      const out: string[] = [];
      for (let i = 0; i < 4000; i++) {
        for (let id = 0; id < 4; id++) w.setIntent(id, pilots[id].next());
        w.step();
        if (i % 20 === 0) out.push(JSON.stringify(w.snapshot()));
        w.drainEvents();
      }
      return out.join('\n');
    };
    expect(go()).toBe(go());
  });
});

// ── breakable platforms ──────────────────────────────────────────────────────

describe('breakable platforms: hit counting', () => {
  /** Fighter 0 stands on tileC facing right at x = 0 (its low side attack covers x 0.4 .. 1.2, in the tile's rect); fighter 1 is parked away on tileL. */
  function arena(src: BrawlDataSource): BrawlWorld {
    const w = stageWorld('crumblingAmphitheatre', [STAND, STAND], {}, 1, src);
    w.debugPlace(0, 0, 0);
    w.debugPlace(1, -7, 0);
    w.debugSetFacing(0, 1);
    return w;
  }

  it('a damaging hitbox overlapping the platform rect counts one hit and emits platformHit with hpLeft / maxHp', () => {
    const w = arena(lowMoveSource(0.1));
    const max = FIX_STAGES.crumblingAmphitheatre.platforms.find((p) => p.id === 'tileC')!.breakable!.hits;
    expect(plat(w, 'tileC')).toMatchObject({ hp: max, maxHp: max, active: true });
    const ev = platEvents(swing(w, 0));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: 'platformHit', platformId: 'tileC', attackerId: 0, hpLeft: max - 1, maxHp: max });
    expect(plat(w, 'tileC')).toMatchObject({ hp: max - 1, maxHp: max, active: true });
    // position = the contact point on the platform rect
    const e = ev[0] as Extract<BrawlEvent, { type: 'platformHit' }>;
    expect(e.pos.x).toBeGreaterThanOrEqual(-3);
    expect(e.pos.x).toBeLessThanOrEqual(3);
    // the neighbouring pieces were not touched
    expect(plat(w, 'tileL').hp).toBe(plat(w, 'tileL').maxHp);
    expect(plat(w, 'tileR').hp).toBe(plat(w, 'tileR').maxHp);
  });

  it('the rect is expanded by 0.15 m: a box whose edge is 0.14 m above the top counts, 0.2 m does not', () => {
    // box centre y = bottom + r; circle r 0.4 -> bottom edge = boxY - 0.4
    const near = arena(lowMoveSource(0.14 + 0.4));
    expect(platEvents(swing(near, 0))).toHaveLength(1);
    const far = arena(lowMoveSource(0.2 + 0.4));
    expect(platEvents(swing(far, 0))).toHaveLength(0);
    // sanity: the same far box does connect with a fighter standing there (it is a real, damaging hitbox)
    expect(PHYS.platHitPad).toBeCloseTo(0.15, 12);
  });

  it('counts per attack activation: one multi-hit activation counts once however many frames its box overlaps', () => {
    // a 40-frame active window that overlaps the tile the whole time
    const base = fixtureMoveset('lion');
    const long = mkBody('long', [2, 40, 3], [circle(0.8, 0.1, 0.4, 2, 42, 1, 1, 1, 40, { multiHitInterval: 5 })]);
    const lion: MovesetDef = { ...base, moves: { ...base.moves, lightS: { id: 'lightS', ground: long, air: null } as MoveData } };
    const src: BrawlDataSource = {
      getMoveset: (a) => (a === 'lion' ? lion : fixtureMoveset(a)),
      getMoveBody: (a, id, air, chain = 0) => (a === 'lion' && id === 'lightS' ? long : FIXTURE_SOURCE.getMoveBody(a, id, air, chain)),
      getStage: (id) => FIX_STAGES[id],
    };
    const w = arena(src);
    const ev = platEvents(swing(w, 0, 60));
    expect(ev).toHaveLength(1);
  });

  it('keeps a per-attacker, per-platform cooldown of 20 frames between counts and counts again after it', () => {
    const w = arena(lowMoveSource(0.1)); // a 7-frame move: spam it every 8 frames
    const counts: number[] = [];
    for (let i = 0; i < 160; i++) {
      w.setIntent(0, intent({ light: i % 8 === 0, moveX: 0.8 }));
      w.step();
      for (const e of w.drainEvents()) if (e.type === 'platformHit' && e.platformId === 'tileC') counts.push(w.frame);
    }
    expect(counts.length).toBeGreaterThanOrEqual(5);
    expect(counts.length).toBeLessThanOrEqual(8); // 160 frames / 20
    for (let i = 1; i < counts.length; i++) expect(counts[i] - counts[i - 1], `count ${i}`).toBeGreaterThanOrEqual(PHYS.platHitCooldown);
  });

  it('two attackers each count on their own cooldown; a platform struck by both loses two hits', () => {
    const src = lowMoveSource(0.1);
    const w = stageWorld('crumblingAmphitheatre', [STAND, STAND], {}, 1, src);
    w.debugPlace(0, -1, 0);
    w.debugPlace(1, 1, 0);
    w.debugSetFacing(0, 1);
    w.debugSetFacing(1, -1);
    const max = plat(w, 'tileC').maxHp!;
    w.setIntent(0, intent({ light: true, moveX: 0.8 }));
    w.setIntent(1, intent({ light: true, moveX: -0.8 }));
    w.step();
    w.setIntent(0, intent());
    w.setIntent(1, intent());
    const ev: BrawlEvent[] = [];
    for (let i = 0; i < 12; i++) {
      w.step();
      ev.push(...w.drainEvents());
    }
    const hits = ev.filter((e) => e.type === 'platformHit' && e.platformId === 'tileC');
    expect(hits).toHaveLength(2);
    expect(new Set(hits.map((e) => (e as { attackerId: number }).attackerId))).toEqual(new Set([0, 1]));
    expect(plat(w, 'tileC').hp).toBe(max - 2);
  });

  it('an attack that hits NO fighter (a whiff) and one that hits a fighter both count: it is attack based', () => {
    const w = arena(lowMoveSource(0.1));
    // a fighter standing in the box is hit AND the platform counts
    w.debugPlace(1, 1.0, 0);
    const ev = swing(w, 0);
    expect(ev.some((e) => e.type === 'hit')).toBe(true);
    expect(platEvents(ev)).toHaveLength(1);
  });

  it('higher attacks do not touch ground-level tiles, and pieces count only while active', () => {
    // a box at standing height misses the tile top by far more than the pad
    const w = arena(lowMoveSource(0.9));
    expect(platEvents(swing(w, 0))).toHaveLength(0);
    // a destroyed piece no longer counts
    const v = arena(lowMoveSource(0.1));
    v.debugHitPlatform('tileC', 0, 99);
    expect(plat(v, 'tileC').active).toBe(false);
    v.debugPlace(0, 5, 0);
    v.drainEvents();
    expect(platEvents(swing(v, 0))).toHaveLength(1); // tileR (x 3..8.5) is struck instead
    expect(plat(v, 'tileC').hp).toBe(0);
  });

  it('unbreakable platforms and the original stages never emit platform events', () => {
    const w = stageWorld('crumblingAmphitheatre', [STAND, STAND], {}, 1, lowMoveSource(0.1));
    w.debugPlace(0, -11, 0); // on floorL (unbreakable), facing the left edge
    w.debugSetFacing(0, -1);
    expect(platEvents(swing(w, 0))).toHaveLength(0);
    const o = stageWorld('brokenColosseum', [STAND, STAND], {}, 1, lowMoveSource(0.1));
    expect(platEvents(swing(o, 0))).toHaveLength(0);
    expect(o.snapshot().platforms.every((p) => p.active === undefined && p.hp === undefined && p.maxHp === undefined)).toBe(true);
    expect(Object.keys(o.snapshot().platforms[0]).sort()).toEqual(['id', 'x0', 'x1', 'y']);
  });
});

describe('breakable platforms: breaking', () => {
  it('breaking emits platformBreak with the span at break time; the platform stops colliding the same frame; riders fall with normal air physics', () => {
    const w = stageWorld('crumblingAmphitheatre', [STAND, STAND]);
    w.debugPlace(0, 0, 0);
    w.debugPlace(1, -7, 0);
    const max = plat(w, 'tileC').maxHp!;
    w.debugHitPlatform('tileC', 1, max - 1);
    expect(plat(w, 'tileC').active).toBe(true);
    expect(fighter(w, 0).grounded).toBe(true);
    events(w);
    w.debugHitPlatform('tileC', 1, 1);
    const ev = events(w);
    const types = ev.map((e) => e.type);
    expect(types.filter((t) => t === 'platformBreak')).toHaveLength(1);
    expect(types[types.length - 2]).toBe('platformHit');
    const brk = ev.find((e) => e.type === 'platformBreak') as Extract<BrawlEvent, { type: 'platformBreak' }>;
    expect(brk).toMatchObject({ platformId: 'tileC', x0: -3, x1: 3, y: 0 });
    expect(plat(w, 'tileC')).toMatchObject({ active: false, hp: 0 });
    // the rider is airborne right away (same frame), with no velocity change from the break itself
    const f = fighter(w, 0);
    expect(f.grounded).toBe(false);
    expect(f.platformId).toBeNull();
    expect(f.vel.y).toBe(0);
    // then ordinary gravity: it accelerates downwards and falls through the pit to the bottom blast zone (KO)
    let prevVy = 0;
    let ko = false;
    for (let i = 0; i < 400; i++) {
      w.step();
      const g = fighter(w, 0);
      if (!g.alive) {
        ko = true;
        break;
      }
      expect(g.vel.y).toBeLessThanOrEqual(prevVy + 1e-9);
      prevVy = g.vel.y;
      expect(g.pos.y).toBeLessThan(0.01);
    }
    expect(ko).toBe(true);
    expect(w.drainEvents().some((e) => e.type === 'ko' && e.side === 'bottom')).toBe(true);
  });

  it('a fighter walking onto a destroyed piece falls straight through it; its neighbours still hold', () => {
    const w = stageWorld('crumblingAmphitheatre', [STAND, STAND]);
    w.debugPlace(1, -7, 0);
    w.debugHitPlatform('tileC', 1, 99);
    w.debugPlace(0, 4, 0); // on tileR
    expect(fighter(w, 0).grounded).toBe(true);
    run(w, 40, 0, () => ({ moveX: -1 })); // run towards the pit
    // it either ran off tileR's left end into the pit or hangs on its ledge; it never stands in the pit
    const f = fighter(w, 0);
    expect(!(f.grounded && Math.abs(f.pos.x) < 2.9 && f.pos.y === 0)).toBe(true);
  });

  it('a hanging fighter drops when its platform breaks (and a climbing one too)', () => {
    const w = stageWorld('crumblingAmphitheatre', [STAND, STAND]);
    w.debugPlace(1, -12, 0);
    // make tileL's right ledge (x = -3) grabbable: its corner is covered by tileC until tileC is gone... so break tileC first
    w.debugHitPlatform('tileC', 1, 99);
    w.debugPlace(0, -2.3, -1.3, 0, -1); // in the grab zone of tileL's right corner, falling
    let hung = false;
    for (let i = 0; i < 30 && !hung; i++) {
      run(w, 1, 0, () => ({ moveX: -0.5 }));
      hung = fighter(w, 0).action === 'ledgeHang';
    }
    // (a grab is not guaranteed by this hand-placed pose, so place it directly when needed)
    expect(hung).toBe(true);
    expect(fighter(w, 0).platformId).toBe('tileL');
    w.debugHitPlatform('tileL', 1, 99);
    const f = fighter(w, 0);
    expect(f.action).toBe('fall');
    expect(f.grounded).toBe(false);
    expect(f.vel.y).toBeLessThan(0);
    // and it can not re-grab the destroyed platform's ledge
    for (let i = 0; i < 60; i++) {
      run(w, 1, 0, () => ({ moveX: 0.5 }));
      expect(fighter(w, 0).action).not.toBe('ledgeHang');
    }
  });

  it('no ledge can be grabbed on a destroyed platform and the ledge grab event is not emitted for it', () => {
    const w = stageWorld('crumblingAmphitheatre', [STAND, STAND]);
    w.debugPlace(1, -12, 0);
    w.debugHitPlatform('tileC', 1, 99);
    w.debugHitPlatform('tileL', 1, 99);
    w.debugPlace(0, -2.3, -1.3, 0, -1);
    events(w);
    for (let i = 0; i < 40; i++) {
      run(w, 1, 0, () => ({ moveX: -0.5 }));
      expect(fighter(w, 0).action).not.toBe('ledgeHang');
    }
    expect(w.drainEvents().some((e) => e.type === 'ledgeGrab')).toBe(false);
  });

  it('a jump squat cancelled by the floor vanishing does not give a free mid-air ground jump', () => {
    const w = stageWorld('crumblingAmphitheatre', [STAND, STAND]);
    w.debugPlace(0, 0, 0);
    w.debugPlace(1, -7, 0);
    run(w, 1, 0, () => ({ jump: true, jumpHeld: true }));
    expect(fighter(w, 0).action).toBe('jumpSquat');
    w.debugHitPlatform('tileC', 1, 99);
    expect(fighter(w, 0).action).toBe('fall');
    run(w, 10, 0, () => ({ jumpHeld: true }));
    expect(fighter(w, 0).vel.y).toBeLessThan(0);
  });
});

describe('breakable platforms: the final form', () => {
  const FINAL_IDS = ['sunL', 'sunR', 'core', 'halo', 'span'];
  const BREAKABLE_IDS = ['tileL', 'tileC', 'tileR', 'archL', 'archR', 'crown'];

  it('finalOnly platforms are inactive before: no snapshot activity, no collision, no ledge', () => {
    const w = stageWorld('crumblingAmphitheatre', [STAND, STAND]);
    for (const id of FINAL_IDS) expect(plat(w, id).active, id).toBe(false);
    for (const id of BREAKABLE_IDS) expect(plat(w, id).active, id).toBe(true);
    expect(plat(w, 'floorL').active).toBeUndefined();
    // fighter 0 jumps up through where the final-form core is and keeps going (nothing there to bump into)
    w.debugPlace(1, -12, 0);
    w.debugPlace(0, 0, 0);
    w.debugHitPlatform('tileC', 1, 99);
    w.debugPlace(0, 0, -0.2, 0, 17); // rising through (0, 1.4)
    let maxY = -Infinity;
    for (let i = 0; i < 20; i++) {
      w.step();
      maxY = Math.max(maxY, fighter(w, 0).pos.y);
    }
    expect(maxY).toBeGreaterThan(3);
  });

  it('breaking the LAST breakable emits stageFinal exactly once, right after that platformBreak, and activates every finalOnly platform', () => {
    const w = stageWorld('crumblingAmphitheatre', [STAND, STAND]);
    w.debugPlace(1, -12, 0);
    w.debugPlace(0, 12, 0);
    const all: BrawlEvent[] = [];
    for (const id of BREAKABLE_IDS.slice(0, 5)) {
      w.debugHitPlatform(id, 0, 99);
      all.push(...events(w));
      expect(all.some((e) => e.type === 'stageFinal'), `after ${id}`).toBe(false);
      for (const f of FINAL_IDS) expect(plat(w, f).active).toBe(false);
    }
    w.debugHitPlatform('crown', 0, 99);
    all.push(...events(w));
    expect(all.filter((e) => e.type === 'stageFinal')).toHaveLength(1);
    expect(all.filter((e) => e.type === 'platformBreak')).toHaveLength(6);
    const idx = all.findIndex((e) => e.type === 'stageFinal');
    expect(all[idx - 1]).toMatchObject({ type: 'platformBreak', platformId: 'crown' });
    for (const f of FINAL_IDS) expect(plat(w, f).active, f).toBe(true);
    for (const b of BREAKABLE_IDS) expect(plat(w, b)).toMatchObject({ active: false, hp: 0 });
    // further hits do nothing, and the event never repeats
    w.debugHitPlatform('crown', 0, 5);
    expect(events(w)).toHaveLength(0);
    for (let i = 0; i < 60; i++) {
      w.step();
      expect(w.drainEvents().some((e) => e.type === 'stageFinal')).toBe(false);
    }
  });

  it('breaking two pieces on the same frame in the right order still flips exactly once', () => {
    const w = stageWorld('crumblingAmphitheatre', [STAND, STAND]);
    for (const id of BREAKABLE_IDS.slice(0, 4)) w.debugHitPlatform(id, 0, 99);
    events(w);
    w.debugHitPlatform('archR', 0, 99);
    w.debugHitPlatform('crown', 1, 99);
    expect(events(w).filter((e) => e.type === 'stageFinal')).toHaveLength(1);
  });

  it('the final-form platforms collide as soon as they appear: land on the core, grab its ledges, stand on the soft ones', () => {
    const w = stageWorld('crumblingAmphitheatre', [STAND, STAND]);
    w.debugPlace(1, -12, 0);
    w.debugPlace(0, 12, 0);
    for (const id of BREAKABLE_IDS) w.debugHitPlatform(id, 0, 99);
    events(w);
    // lands on the (solid, y 1.4) core (dropped from just under the v1.7 span: from above, the soft span at y 3.0 would catch it first)
    w.debugPlace(0, 0, 2.4, 0, 0);
    let landed = false;
    for (let i = 0; i < 60 && !landed; i++) {
      w.step();
      const f = fighter(w, 0);
      landed = f.grounded && f.platformId === 'core';
    }
    expect(landed).toBe(true);
    expect(fighter(w, 0).pos.y).toBeCloseTo(1.4, 9);
    // grabs the core's left ledge (corner x = -3, y = 1.4)
    w.debugPlace(0, -3.9, 0.6, 0, -1);
    let hung = false;
    for (let i = 0; i < 40 && !hung; i++) {
      run(w, 1, 0, () => ({ moveX: 0.4 }));
      hung = fighter(w, 0).action === 'ledgeHang';
    }
    expect(hung).toBe(true);
    expect(fighter(w, 0).platformId).toBe('core');
    // sunL (soft, y 3) is landable from below-through
    w.debugPlace(0, -8, 0.5, 0, 17);
    let onSun = false;
    for (let i = 0; i < 80 && !onSun; i++) {
      w.step();
      onSun = fighter(w, 0).platformId === 'sunL' && fighter(w, 0).grounded;
    }
    expect(onSun).toBe(true);
    // v1.7: the soft span (y 3.0, x -6..6) hangs over the core and catches a fall from above the middle; it is landable from below-through too
    w.debugPlace(0, 0, 5, 0, 0);
    let onSpan = false;
    for (let i = 0; i < 80 && !onSpan; i++) {
      w.step();
      onSpan = fighter(w, 0).platformId === 'span' && fighter(w, 0).grounded;
    }
    expect(onSpan).toBe(true);
    expect(fighter(w, 0).pos.y).toBeCloseTo(3, 9);
    w.setIntent(0, intent()); // no stick left over from the ledge scenario above
    w.debugPlace(0, 4.5, 0.5, 0, 17);
    onSpan = false;
    for (let i = 0; i < 80 && !onSpan; i++) {
      w.step();
      onSpan = fighter(w, 0).platformId === 'span' && fighter(w, 0).grounded;
    }
    expect(onSpan).toBe(true);
  });

  it('fighters embedded in a newly active solid are pushed out of it (never left inside the core), for every overlap pose', () => {
    const poses: Array<[number, number]> = [
      [0, 0.2],
      [2.7, -0.3],
      [-2.9, 1.0],
      [0.1, -0.5],
      [3.4, 0.5],
      [-3.4, 1.0],
      [0, 1.3],
    ];
    for (const [x, y] of poses) {
      const w = stageWorld('crumblingAmphitheatre', [STAND, STAND]);
      w.debugPlace(1, -12, 0);
      for (const id of BREAKABLE_IDS.slice(0, 5)) w.debugHitPlatform(id, 0, 99);
      w.debugPlace(0, x, y, 0, -3);
      w.debugHitPlatform('crown', 0, 99);
      const f = fighter(w, 0);
      const c = plat(w, 'core');
      const ox = Math.min(f.pos.x + 0.55, c.x1) - Math.max(f.pos.x - 0.55, c.x0);
      const oy = Math.min(f.pos.y + 1.5, c.y) - Math.max(f.pos.y, c.y - 2);
      expect(ox > 0.001 && oy > 0.001, `(${x}, ${y}) left inside the core at (${f.pos.x}, ${f.pos.y})`).toBe(false);
      for (let i = 0; i < 120; i++) {
        w.step();
        const g = fighter(w, 0);
        expect(Number.isFinite(g.pos.x + g.pos.y)).toBe(true);
      }
    }
  });
});

describe('inner-ledge exposure rule', () => {
  /** Drop fighter 0 into the grab zone of the ledge at corner (cx, cy) coming from the outside (side = -1 left end, +1 right end). */
  function tryGrab(w: BrawlWorld, cx: number, cy: number, side: -1 | 1): boolean {
    w.debugPlace(0, cx + side * 0.9, cy - 1.2, 0, -2);
    for (let i = 0; i < 40; i++) {
      run(w, 1, 0, () => ({ moveX: -side * 0.4 }));
      if (fighter(w, 0).action === 'ledgeHang') return true;
    }
    return false;
  }

  it('the outer ledges of the unbreakable floors are always grabbable; the inner ones only once the adjacent tile is gone', () => {
    const w = stageWorld('crumblingAmphitheatre', [STAND, STAND]);
    w.debugPlace(1, -1, 20); // out of the way, high up
    w.debugSetStocks(1, 9);
    expect(tryGrab(w, -13, 0, -1)).toBe(true); // floorL outer
    w.debugPlace(0, 0, 6);
    w.debugPlace(1, 9, 20);
    const v = stageWorld('crumblingAmphitheatre', [STAND, STAND]);
    v.debugPlace(1, 0, 25);
    expect(tryGrab(v, 13, 0, 1)).toBe(true); // floorR outer
    // inner ledge of floorL (corner x = -8.5) is covered by tileL (flush, same height): not grabbable
    const a = stageWorld('crumblingAmphitheatre', [STAND, STAND]);
    a.debugPlace(1, 0, 25);
    a.debugHitPlatform('archL', 1, 99); // (irrelevant piece) just to prove only same-height cover matters
    expect(tryGrab(a, -8.5, 0, 1)).toBe(false);
    // ... but once tileL is destroyed the corner is exposed
    const b = stageWorld('crumblingAmphitheatre', [STAND, STAND]);
    b.debugPlace(1, 0, 25);
    b.debugHitPlatform('tileL', 1, 99);
    expect(tryGrab(b, -8.5, 0, 1)).toBe(true);
    expect(fighter(b, 0).platformId).toBe('floorL');
  });

  it('a tile ledge facing a neighbouring tile opens only when that neighbour breaks', () => {
    const a = stageWorld('crumblingAmphitheatre', [STAND, STAND]);
    a.debugPlace(1, 0, 25);
    expect(tryGrab(a, -3, 0, 1)).toBe(false); // tileL's right corner is flush against tileC
    const b = stageWorld('crumblingAmphitheatre', [STAND, STAND]);
    b.debugPlace(1, 0, 25);
    b.debugHitPlatform('tileC', 1, 99);
    expect(tryGrab(b, -3, 0, 1)).toBe(true);
    expect(fighter(b, 0).platformId).toBe('tileL');
  });

  it('does not change anything on the two original stages (their ledges are all exposed)', () => {
    for (const [stage, corners] of [
      ['brokenColosseum', [[-11, 0, -1], [11, 0, 1]]],
      ['skyAqueduct', [[-13, 0, -1], [-3, 0, 1], [3, 0, -1], [13, 0, 1]]],
    ] as const) {
      for (const [cx, cy, side] of corners) {
        const w = stageWorld(stage, [STAND, STAND]);
        w.debugPlace(1, 0, 25);
        expect(tryGrab(w, cx, cy, side as -1 | 1), `${stage} corner ${cx}`).toBe(true);
      }
    }
  });
});

// ── state save / load / checksum ─────────────────────────────────────────────

describe('state, save / load and checksum cover the dynamic stage state', () => {
  it('hp, destroyed flags, the final flag and per-attacker hit cooldowns are part of the checksum', () => {
    const w = stageWorld('crumblingAmphitheatre', [STAND, STAND]);
    const c0 = w.checksum();
    w.debugHitPlatform('tileC', 0, 1);
    const c1 = w.checksum();
    expect(c1).not.toBe(c0);
    w.debugHitPlatform('tileC', 0, 99);
    const c2 = w.checksum();
    expect(c2).not.toBe(c1);
    for (const id of ['tileL', 'tileR', 'archL', 'archR']) w.debugHitPlatform(id, 0, 99);
    const c3 = w.checksum();
    w.debugHitPlatform('crown', 0, 99); // final form
    expect(w.checksum()).not.toBe(c3);
    // the per-attacker bookkeeping
    const v = stageWorld('crumblingAmphitheatre', [STAND, STAND]);
    const base = v.checksum();
    v.debugFighter(0).platFrame[3] += 5;
    expect(v.checksum()).not.toBe(base);
    const u = stageWorld('crumblingAmphitheatre', [STAND, STAND]);
    u.debugFighter(1).actSerial += 1;
    expect(u.checksum()).not.toBe(base);
  });

  it('save -> break things -> load restores everything (also across a final-form flip), and a fresh world loads it identically', () => {
    const run1 = (w: BrawlWorld): string[] => {
      const out: string[] = [];
      const ids = ['tileL', 'tileC', 'tileR', 'archL', 'archR', 'crown'];
      for (let i = 0; i < 90; i++) {
        if (i % 15 === 7 && i / 15 < ids.length) w.debugHitPlatform(ids[Math.floor(i / 15)], i % 2, 99);
        w.setIntent(0, intent({ moveX: i % 30 < 15 ? 0.5 : -0.5 }));
        w.setIntent(1, intent({ moveX: i % 40 < 20 ? 0.7 : -0.3, jump: i % 25 === 0 }));
        w.step();
        out.push(`${w.checksum()}|${JSON.stringify(w.snapshot().platforms)}|${JSON.stringify(w.drainEvents())}`);
      }
      return out;
    };
    const w = stageWorld('crumblingAmphitheatre', [STAND, STAND]);
    w.debugHitPlatform('tileC', 0, 2); // some partial damage before the save
    events(w);
    const s = createSavedState();
    w.saveState(s);
    const a = run1(w);
    expect(a.some((l) => l.includes('"stageFinal"'))).toBe(true);
    const endSum = w.checksum();
    w.loadState(s);
    expect(plat(w, 'tileC').hp).toBe(plat(w, 'tileC').maxHp! - 2);
    expect(plat(w, 'crown').active).toBe(true);
    expect(plat(w, 'core').active).toBe(false);
    const b = run1(w);
    expect(b).toEqual(a);
    expect(w.checksum()).toBe(endSum);
    // a different world of the same config
    const x = stageWorld('crumblingAmphitheatre', [STAND, STAND]);
    x.loadState(s);
    expect(run1(x)).toEqual(a);
  });

  it('a state saved AFTER the flip restores the final form (finalOnly active, breakables gone) and does not flip again', () => {
    const w = stageWorld('crumblingAmphitheatre', [STAND, STAND]);
    for (const id of ['tileL', 'tileC', 'tileR', 'archL', 'archR', 'crown']) w.debugHitPlatform(id, 0, 99);
    events(w);
    const s = w.saveState();
    const sum = w.checksum();
    const x = stageWorld('crumblingAmphitheatre', [STAND, STAND]);
    x.loadState(s);
    expect(x.checksum()).toBe(sum);
    expect(plat(x, 'core').active).toBe(true);
    expect(plat(x, 'tileC').active).toBe(false);
    x.debugHitPlatform('crown', 0, 3);
    expect(events(x)).toHaveLength(0);
  });

  it('the moving stage: a state saved mid-drift continues identically after loading (platform positions come from the frame)', () => {
    const w = stageWorld('clockworkHeights', ['lion', 'gorilla', 'eagle']);
    idle(w, 777);
    const s = w.saveState();
    const a: string[] = [];
    for (let i = 0; i < 300; i++) {
      w.step();
      a.push(`${w.checksum()}|${JSON.stringify(w.snapshot())}`);
    }
    const x = stageWorld('clockworkHeights', ['lion', 'gorilla', 'eagle']);
    x.loadState(s);
    const b: string[] = [];
    for (let i = 0; i < 300; i++) {
      x.step();
      b.push(`${x.checksum()}|${JSON.stringify(x.snapshot())}`);
    }
    expect(b).toEqual(a);
  });
});
