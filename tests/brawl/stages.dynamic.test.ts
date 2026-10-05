/**
 * v1.6 dynamic stages — DATA rules (docs/CL-MAPS-PLAN.md): path evaluation, platform speeds, the Clockwork Heights design rules over its whole
 * joint loop, the Crumbling Amphitheatre intact / final layouts, and the data fingerprint. The simulation behaviour lives in
 * sim.dynamic.test.ts.
 */

import { describe, expect, it } from 'vitest';
import type { PathSpec, PlatformDef, StageDef } from '../../src/brawl/types';
import { STAGE_IDS } from '../../src/brawl/types';
import { PHYS } from '../../src/brawl/config';
import { STAGES, movingOffset, pathOffset, platformAt } from '../../src/brawl/data';
import { STAGE_DEFS } from '../../src/brawl/data/stages';
import { makePlatRT, pathCycle, pathOffsetAt, platformAtFrame } from '../../src/brawl/sim/geometry';
import { computeFingerprint, fingerprintData, stableStringify } from '../../src/online/room/fingerprint';

const CLOCK = STAGES.clockworkHeights;
const AMPH = STAGES.crumblingAmphitheatre;
const PERIOD_FRAMES = (p: PathSpec): number => Math.round(p.periodS * 60);

function def(stage: StageDef, id: string): PlatformDef {
  const p = stage.platforms.find((q) => q.id === id);
  if (!p) throw new Error(`no platform ${id}`);
  return p;
}

interface Rect {
  x0: number;
  x1: number;
  /** top */
  y: number;
  /** thickness */
  t: number;
}

function rectAt(p: PlatformDef, frame: number): Rect {
  const r = platformAt(p, frame);
  return { x0: r.x0, x1: r.x1, y: r.y, t: p.thickness };
}

/** Euclidean gap between two rects (0 when they touch / overlap). */
function gap(a: Rect, b: Rect): number {
  const gx = Math.max(0, a.x0 - b.x1, b.x0 - a.x1);
  const gy = Math.max(0, a.y - a.t - b.y, b.y - b.t - a.y);
  return Math.sqrt(gx * gx + gy * gy);
}

describe('path motion: PathSpec evaluation', () => {
  const spec: PathSpec = {
    periodS: 10,
    phase: 0,
    keys: [
      { t: 0, x: 0, y: 0 },
      { t: 0.25, x: 4, y: 2 },
      { t: 0.5, x: 4, y: 2 },
      { t: 0.75, x: -2, y: 6 },
    ],
  };
  const at = (frame: number): { x: number; y: number } => {
    const o = { x: -99, y: -99 };
    pathOffsetAt(spec, frame, o);
    return o;
  };

  it('hits every key exactly at its cycle position and holds equal consecutive keys', () => {
    expect(at(0)).toEqual({ x: 0, y: 0 });
    expect(at(150).x).toBeCloseTo(4, 12); // t = 0.25 -> 2.5 s
    expect(at(150).y).toBeCloseTo(2, 12);
    for (const f of [150, 200, 250, 299]) expect(at(f).x).toBeCloseTo(4, 12 - 1); // hold between t 0.25 and 0.5 (frame 300 = 0.5)
    expect(at(450).x).toBeCloseTo(-2, 12);
    expect(at(450).y).toBeCloseTo(6, 12);
  });

  it('eases with a cosine: the half way point of a leg is its mean, and the leg starts / ends at rest', () => {
    // leg 0 -> 1 spans frames 0..150; the midpoint is frame 75
    expect(at(75).x).toBeCloseTo(2, 9);
    expect(at(75).y).toBeCloseTo(1, 9);
    // zero speed at the keys, maximum speed in the middle
    const v = (f: number): number => Math.hypot(at(f + 1).x - at(f).x, at(f + 1).y - at(f).y) * 60;
    expect(v(0)).toBeLessThan(0.06);
    expect(v(149)).toBeLessThan(0.06);
    expect(v(75)).toBeGreaterThan(v(10));
    // peak speed of a leg = (pi / 2) * length / duration
    const len = Math.hypot(4, 2);
    expect(v(75)).toBeCloseTo((Math.PI / 2) * (len / 2.5), 1);
  });

  it('is a closed loop: the last key eases back to the first, and frame f + period == frame f', () => {
    // leg 3 -> 0 spans cycle 0.75..1.0; at its midpoint (frame 525) the offset is the mean of key 3 and key 0
    expect(at(525).x).toBeCloseTo(-1, 9);
    expect(at(525).y).toBeCloseTo(3, 9);
    for (const f of [0, 1, 77, 301, 599]) {
      const a = at(f);
      const b = at(f + PERIOD_FRAMES(spec));
      const c = at(f + 7 * PERIOD_FRAMES(spec));
      expect(b.x).toBeCloseTo(a.x, 9);
      expect(b.y).toBeCloseTo(a.y, 9);
      expect(c.x).toBeCloseTo(a.x, 8);
    }
    expect(at(599).x).toBeCloseTo(0, 1);
  });

  it('phase shifts the cycle (a quarter phase starts at key 1) and negative phases work', () => {
    const shifted: PathSpec = { ...spec, phase: 0.25 };
    const o = { x: 0, y: 0 };
    pathOffsetAt(shifted, 0, o);
    expect(o.x).toBeCloseTo(4, 12);
    pathOffsetAt({ ...spec, phase: -0.75 }, 0, o);
    expect(o.x).toBeCloseTo(4, 12);
    expect(pathCycle(shifted, 0)).toBeCloseTo(0.25, 12);
    expect(pathCycle(spec, 600)).toBeCloseTo(0, 12);
  });

  it('is a pure function of the frame; degenerate specs do not produce NaN', () => {
    for (let f = 0; f < 3000; f += 13) expect(at(f)).toEqual(at(f));
    const o = { x: 1, y: 1 };
    pathOffsetAt({ periodS: 5, phase: 0, keys: [] }, 10, o);
    expect(o).toEqual({ x: 0, y: 0 });
    pathOffsetAt({ periodS: 5, phase: 0, keys: [{ t: 0, x: 3, y: -1 }] }, 10, o);
    expect(o).toEqual({ x: 3, y: -1 });
    pathOffsetAt({ periodS: 0, phase: 0.5, keys: spec.keys }, 10, o);
    expect(Number.isFinite(o.x) && Number.isFinite(o.y)).toBe(true);
    for (const f of [0, 1e6, 1e7]) {
      pathOffsetAt(spec, f, o);
      expect(Number.isFinite(o.x) && Number.isFinite(o.y)).toBe(true);
    }
  });

  it('platformAt (data / view / bots) and platformAtFrame (sim) agree for every shipped platform, `moving` and `path` adding up', () => {
    for (const id of STAGE_IDS) {
      for (const p of STAGES[id].platforms) {
        const rt = makePlatRT(p);
        for (let f = 0; f < 5000; f += 37) {
          platformAtFrame(p, f, rt);
          const r = platformAt(p, f);
          expect(r.x0, `${id}.${p.id}@${f}`).toBeCloseTo(rt.x0, 9);
          expect(r.x1, `${id}.${p.id}@${f}`).toBeCloseTo(rt.x1, 9);
          expect(r.y, `${id}.${p.id}@${f}`).toBeCloseTo(rt.y, 9);
        }
      }
    }
    const both: PlatformDef = {
      id: 'x',
      kind: 'soft',
      x0: 0,
      x1: 2,
      y: 1,
      thickness: 0.5,
      moving: { axis: 'y', amplitude: 1, periodS: 4, phase: 0 },
      path: spec,
    };
    const rt = makePlatRT(both);
    platformAtFrame(both, 60, rt);
    const o = pathOffset(spec, 60);
    expect(rt.x0).toBeCloseTo(0 + o.x, 9);
    expect(rt.y).toBeCloseTo(1 + movingOffset(both.moving!, 60) + o.y, 9);
    expect(platformAt(both, 60).y).toBeCloseTo(rt.y, 9);
  });
});

describe('stage registry', () => {
  it('has all four stages in the documented order with the documented names and blurbs', () => {
    expect([...STAGE_IDS]).toEqual(['brokenColosseum', 'skyAqueduct', 'clockworkHeights', 'crumblingAmphitheatre']);
    expect(Object.keys(STAGES).sort()).toEqual([...STAGE_IDS].sort());
    expect(CLOCK.name).toBe('Clockwork Heights');
    expect(CLOCK.blurb).toBe('A drifting brass-and-stone clockwork. The platforms never stop re-forming.');
    expect(AMPH.name).toBe('Crumbling Amphitheatre');
    expect(AMPH.blurb).toBe('Smash the ruins: break every piece and the arena transforms.');
    expect(CLOCK.blast).toEqual({ left: -32, right: 32, top: 24, bottom: -18 });
    expect(AMPH.blast).toEqual({ left: -30, right: 30, top: 22, bottom: -17 });
    expect(CLOCK.camera).toEqual({ minHalfW: 12, maxHalfW: 22 });
    expect(AMPH.camera).toEqual({ minHalfW: 11, maxHalfW: 19 });
    expect(CLOCK.respawn).toEqual({ x: 0, y: 12 });
    expect(AMPH.respawn).toEqual({ x: 0, y: 12 });
    expect(CLOCK.spawns.map((s) => s.x)).toEqual([-5, -1.7, 1.7, 5]);
    expect(AMPH.spawns.map((s) => s.x)).toEqual([-7, -2.5, 2.5, 7]);
  });

  it('platform ids are unique, ledges only sit on solid platforms, breakables / finalOnly are well formed', () => {
    for (const id of STAGE_IDS) {
      const ids = STAGES[id].platforms.map((p) => p.id);
      expect(new Set(ids).size, id).toBe(ids.length);
      for (const p of STAGES[id].platforms) {
        if (p.ledgeLeft || p.ledgeRight) expect(p.kind, `${id}.${p.id}`).toBe('solid');
        if (p.breakable) {
          expect(Number.isInteger(p.breakable.hits) && p.breakable.hits >= 1, `${id}.${p.id}`).toBe(true);
          expect(p.finalOnly, `${id}.${p.id} cannot be both breakable and final-only`).toBeFalsy();
          expect(p.moving || p.path, `${id}.${p.id} breakables are static`).toBeFalsy();
        }
        if (p.path) {
          expect(p.path.periodS).toBeGreaterThan(0);
          expect(p.path.keys[0].t).toBe(0);
          for (let i = 1; i < p.path.keys.length; i++) expect(p.path.keys[i].t, `${id}.${p.id} key ${i}`).toBeGreaterThan(p.path.keys[i - 1].t);
          expect(p.path.keys[p.path.keys.length - 1].t).toBeLessThan(1);
          expect(p.path.phase).toBeGreaterThanOrEqual(0);
          expect(p.path.phase).toBeLessThan(1);
        }
      }
    }
    // the two original stages have no dynamic features at all
    for (const id of ['brokenColosseum', 'skyAqueduct'] as const) {
      for (const p of STAGES[id].platforms) expect(p.path || p.breakable || p.finalOnly).toBeFalsy();
    }
  });
});

describe('Clockwork Heights: design rules over the WHOLE joint loop', () => {
  const core = def(CLOCK, 'core');
  const sats = CLOCK.platforms.filter((p) => p.id !== 'core');
  // the core loops every 40 s, the satellites every 36 s -> every combination of phases recurs after lcm = 360 s
  const JOINT = Math.round((360 * 60) / 1) ;

  it('the core is the only solid platform, has ledges on both ends and spawns stand on it at frame 0', () => {
    expect(CLOCK.platforms.filter((p) => p.kind === 'solid').map((p) => p.id)).toEqual(['core']);
    expect(core).toMatchObject({ kind: 'solid', x0: -6.5, x1: 6.5, y: 0, thickness: 3.2, ledgeLeft: true, ledgeRight: true });
    expect(core.path!.periodS).toBe(40);
    expect(sats).toHaveLength(4);
    for (const s of sats) {
      expect(s.kind).toBe('soft');
      expect(s.path!.periodS).toBe(36);
      expect(s.x1 - s.x0).toBeCloseTo(4.5, 9);
      expect(s.thickness).toBeCloseTo(0.5, 9);
    }
    const c0 = platformAt(core, 0);
    for (const sp of CLOCK.spawns) {
      expect(sp.x).toBeGreaterThanOrEqual(c0.x0);
      expect(sp.x).toBeLessThanOrEqual(c0.x1);
      expect(Math.abs(sp.y - c0.y)).toBeLessThan(0.05);
    }
  });

  it('measured platform speeds stay within the plan limits (core <= 2.5 m/s, everything <= 3.5 m/s)', () => {
    let coreMax = 0;
    let satMax = 0;
    let prev = new Map<string, Rect>();
    for (const p of CLOCK.platforms) prev.set(p.id, rectAt(p, 0));
    for (let f = 1; f <= JOINT / 4; f++) {
      for (const p of CLOCK.platforms) {
        const r = rectAt(p, f);
        const o = prev.get(p.id)!;
        const v = Math.hypot(r.x0 - o.x0, r.y - o.y) * 60;
        if (p.id === 'core') coreMax = Math.max(coreMax, v);
        else satMax = Math.max(satMax, v);
        prev.set(p.id, r);
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[clockworkHeights] max platform speed: core ${coreMax.toFixed(3)} m/s, satellites ${satMax.toFixed(3)} m/s`);
    expect(coreMax).toBeLessThanOrEqual(PHYS.dynCoreMaxSpeed);
    expect(satMax).toBeLessThanOrEqual(PHYS.dynMaxSpeed);
    expect(coreMax).toBeGreaterThan(0.3);
    expect(satMax).toBeGreaterThan(0.3);
  });

  it('the core wanders about +-3.5 m sideways and -0.6..+1.5 m vertically', () => {
    let minX = 0;
    let maxX = 0;
    let minY = 0;
    let maxY = 0;
    for (let f = 0; f < PERIOD_FRAMES(core.path!); f++) {
      const r = platformAt(core, f);
      minX = Math.min(minX, r.x0 + 6.5);
      maxX = Math.max(maxX, r.x0 + 6.5);
      minY = Math.min(minY, r.y);
      maxY = Math.max(maxY, r.y);
    }
    expect(minX).toBeLessThanOrEqual(-3.4);
    expect(maxX).toBeGreaterThanOrEqual(3.4);
    expect(Math.max(-minX, maxX)).toBeLessThanOrEqual(3.6);
    expect(minY).toBeGreaterThanOrEqual(-1);
    expect(maxY).toBeLessThanOrEqual(2.2);
    expect(maxY - minY).toBeGreaterThan(1.5);
  });

  it('every platform stays inside the blast zones (with a margin) at every frame', () => {
    const { left, right, top, bottom } = CLOCK.blast;
    for (const p of CLOCK.platforms) {
      for (let f = 0; f < JOINT; f += 3) {
        const r = rectAt(p, f);
        expect(r.x0, `${p.id}@${f}`).toBeGreaterThan(left + 10);
        expect(r.x1, `${p.id}@${f}`).toBeLessThan(right - 10);
        expect(r.y, `${p.id}@${f}`).toBeLessThan(top - 8);
        expect(r.y - r.t, `${p.id}@${f}`).toBeGreaterThan(bottom + 8);
      }
    }
    // and inside the widest camera framing
    let widest = 0;
    for (const p of sats) for (let f = 0; f < 2160; f += 5) widest = Math.max(widest, Math.abs(rectAt(p, f).x0), Math.abs(rectAt(p, f).x1));
    expect(widest).toBeLessThanOrEqual(CLOCK.camera.maxHalfW + 0.5);
  });

  it('satellites never overlap each other (>= 0.6 m clear), at every frame', () => {
    let minGap = Infinity;
    for (let f = 0; f < 2160; f++) {
      const rs = sats.map((p) => rectAt(p, f));
      for (let i = 0; i < rs.length; i++) {
        for (let j = i + 1; j < rs.length; j++) minGap = Math.min(minGap, gap(rs[i], rs[j]));
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[clockworkHeights] minimum satellite-satellite clearance: ${minGap.toFixed(3)} m`);
    expect(minGap).toBeGreaterThanOrEqual(PHYS.dynSatGap);
  });

  it('satellites never touch the core body, nor the space a fighter stands in on a satellite (all 360 s of combinations)', () => {
    let minClear = Infinity;
    for (let f = 0; f < JOINT; f++) {
      const c = rectAt(core, f);
      for (const s of sats) {
        const r = rectAt(s, f);
        // padded: a fighter on the satellite overhangs its ends by up to a body half width (~1 m)
        const padded: Rect = { x0: r.x0 - 1, x1: r.x1 + 1, y: r.y, t: r.t + PHYS.dynCoreClear };
        const g = gap(padded, c);
        minClear = Math.min(minClear, g);
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[clockworkHeights] minimum satellite-core clearance (padded): ${minClear.toFixed(3)} m`);
    expect(minClear).toBeGreaterThan(0);
  });

  it('at ANY frame at least two satellites are within jump reach of the core top (<= 4.6 m above, <= 5 m sideways)', () => {
    let worst = Infinity;
    for (let f = 0; f < JOINT; f++) {
      const c = rectAt(core, f);
      let n = 0;
      for (const s of sats) {
        const r = rectAt(s, f);
        const up = r.y - c.y;
        // sideways distance from the satellite's span to the nearest of the core's left ledge, centre and right ledge
        const side = Math.min(...[c.x0, (c.x0 + c.x1) / 2, c.x1].map((x) => Math.max(0, r.x0 - x, x - r.x1)));
        if (up <= PHYS.dynReachUp && side <= PHYS.dynReachSide) n++;
      }
      worst = Math.min(worst, n);
      if (n < 2) throw new Error(`only ${n} satellite(s) within reach at frame ${f}`);
    }
    expect(worst).toBeGreaterThanOrEqual(2);
  });

  it('the layout really keeps changing: three clearly different satellite arrangements and no standstill', () => {
    const sig = (f: number): number[] => sats.flatMap((s) => [rectAt(s, f).x0, rectAt(s, f).y]);
    const dist = (a: number[], b: number[]): number => Math.sqrt(a.reduce((acc, v, i) => acc + (v - b[i]) ** 2, 0));
    const A = sig(0); // layout A is held 0..6 s
    const B = sig(12 * 60 + 60); // layout B is held 12..18 s
    const C = sig(24 * 60 + 60); // layout C is held 24..30 s
    expect(dist(A, B)).toBeGreaterThan(6);
    expect(dist(B, C)).toBeGreaterThan(6);
    expect(dist(C, A)).toBeGreaterThan(5);
    // hold: nothing moves in the middle of a hold; glide: something moves
    expect(dist(sig(1 * 60), sig(5 * 60))).toBeLessThan(1e-9);
    expect(dist(sig(8 * 60), sig(10 * 60))).toBeGreaterThan(0.5);
    // the core keeps moving too: it is never at rest for more than a moment
    let rest = 0;
    for (let f = 1; f < 2400; f++) {
      const a = rectAt(core, f - 1);
      const b = rectAt(core, f);
      if (Math.abs(a.x0 - b.x0) + Math.abs(a.y - b.y) < 1e-6) rest++;
    }
    expect(rest).toBeLessThan(10);
  });
});

/** `up` can be jumped onto from `from`: at most dynReachUp above it and at most dynReachSide sideways of its span. */
function reach(up: PlatformDef, from: PlatformDef): boolean {
  return up.y - from.y > 0 && up.y - from.y <= PHYS.dynReachUp && Math.max(0, up.x0 - from.x1, from.x0 - up.x1) <= PHYS.dynReachSide;
}

/** Ids reachable from platform `start` (jump up to 4.6 m, any drop, <= 5 m sideways), sorted. */
function reachable(plats: PlatformDef[], start: string): string[] {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const a = plats.find((p) => p.id === id)!;
    for (const b of plats) {
      if (seen.has(b.id)) continue;
      const side = Math.max(0, b.x0 - a.x1, a.x0 - b.x1);
      if (side <= PHYS.dynReachSide && b.y - a.y <= PHYS.dynReachUp) {
        seen.add(b.id);
        queue.push(b.id);
      }
    }
  }
  return [...seen].sort();
}

describe('Crumbling Amphitheatre: intact and final layouts', () => {
  const breakables = AMPH.platforms.filter((p) => p.breakable);
  const finals = AMPH.platforms.filter((p) => p.finalOnly);
  const intact = AMPH.platforms.filter((p) => !p.finalOnly);
  const last = AMPH.platforms.filter((p) => !p.breakable);

  it('has exactly the plan layout: 2 unbreakable floors, 6 breakables with the plan geometry, 5 final-only platforms', () => {
    expect(def(AMPH, 'floorL')).toMatchObject({ kind: 'solid', x0: -13, x1: -8.5, y: 0, thickness: 3.5, ledgeLeft: true, ledgeRight: true });
    expect(def(AMPH, 'floorR')).toMatchObject({ kind: 'solid', x0: 8.5, x1: 13, y: 0, thickness: 3.5, ledgeLeft: true, ledgeRight: true });
    expect(def(AMPH, 'tileL')).toMatchObject({ kind: 'solid', x0: -8.5, x1: -3, y: 0, thickness: 3.5 });
    expect(def(AMPH, 'tileC')).toMatchObject({ kind: 'solid', x0: -3, x1: 3, y: 0, thickness: 3.5 });
    expect(def(AMPH, 'tileR')).toMatchObject({ kind: 'solid', x0: 3, x1: 8.5, y: 0, thickness: 3.5 });
    expect(def(AMPH, 'archL')).toMatchObject({ kind: 'soft', x0: -10, x1: -5.5, y: 4.4 });
    expect(def(AMPH, 'archR')).toMatchObject({ kind: 'soft', x0: 5.5, x1: 10, y: 4.4 });
    expect(def(AMPH, 'crown')).toMatchObject({ kind: 'soft', x0: -2.5, x1: 2.5, y: 7.8 });
    expect(def(AMPH, 'sunL')).toMatchObject({ kind: 'soft', x0: -11, x1: -6, y: 3, finalOnly: true });
    expect(def(AMPH, 'sunR')).toMatchObject({ kind: 'soft', x0: 6, x1: 11, y: 3, finalOnly: true });
    expect(def(AMPH, 'core')).toMatchObject({ kind: 'solid', x0: -3, x1: 3, y: 1.4, thickness: 2, ledgeLeft: true, ledgeRight: true, finalOnly: true });
    expect(def(AMPH, 'halo')).toMatchObject({ kind: 'soft', x0: -2.5, x1: 2.5, y: 6.4, finalOnly: true });
    // v1.7: the walkway in the air between the two sun slabs (same height, abutting both)
    expect(def(AMPH, 'span')).toMatchObject({ kind: 'soft', x0: -6, x1: 6, y: 3, thickness: 0.5, finalOnly: true });
    expect(breakables.map((p) => p.id).sort()).toEqual(['archL', 'archR', 'crown', 'tileC', 'tileL', 'tileR']);
    expect(finals.map((p) => p.id).sort()).toEqual(['core', 'halo', 'span', 'sunL', 'sunR']);
    expect(last.filter((p) => !p.finalOnly).map((p) => p.id).sort()).toEqual(['floorL', 'floorR']);
    // hit counts: tiles take the most, the soft pieces fewer
    for (const t of ['tileL', 'tileC', 'tileR']) expect(def(AMPH, t).breakable!.hits).toBeGreaterThanOrEqual(def(AMPH, 'crown').breakable!.hits);
  });

  it('spawns stand on solid ground of the INTACT layout at frame 0', () => {
    for (const sp of AMPH.spawns) {
      const under = intact.filter((p) => p.kind === 'solid' && p.x0 <= sp.x && sp.x <= p.x1 && Math.abs(p.y - sp.y) < 0.05);
      expect(under.length, `spawn ${sp.x}`).toBeGreaterThan(0);
    }
  });

  it('the intact layout is a fair, connected arena: every upper piece is within jump reach of one below it', () => {
    for (const u of intact.filter((p) => p.kind === 'soft')) {
      const below = intact.filter((p) => p !== u && p.y < u.y);
      expect(below.some((b) => reach(u, b)), `${u.id} reachable`).toBe(true);
    }
    expect(reachable(intact, 'floorL')).toEqual(intact.map((p) => p.id).sort());
  });

  it('the FINAL form is playable on its own: two ledged islands, a ledged centre and four soft platforms, all reachable', () => {
    const fin = AMPH.platforms.filter((p) => p.finalOnly || !p.breakable);
    const solids = fin.filter((p) => p.kind === 'solid');
    const softs = fin.filter((p) => p.kind === 'soft');
    expect(solids.map((p) => p.id).sort()).toEqual(['core', 'floorL', 'floorR']);
    for (const s of solids) expect(s.ledgeLeft && s.ledgeRight, s.id).toBe(true);
    // ledges only ever sit on solid platforms, so the span (soft) has none
    expect(softs.map((p) => p.id).sort()).toEqual(['halo', 'span', 'sunL', 'sunR']);
    for (const s of softs) expect(s.ledgeLeft || s.ledgeRight, `${s.id} is soft: no ledges`).toBeFalsy();
    // every final-form platform can be reached on foot / by jumping from each outer floor (directed: up <= 4.6 m, drops are free)
    for (const from of ['floorL', 'floorR']) expect(reachable(fin, from), `from ${from}`).toEqual(fin.map((p) => p.id).sort());
    for (const u of softs) {
      const below = fin.filter((p) => p !== u && p.y < u.y);
      expect(below.some((b) => reach(u, b)), `${u.id} reachable in the final form`).toBe(true);
    }
    // the final form's platforms do not overlap each other; the only contact allowed is the walkway (see the next test): soft platforms at
    // the very same height that abut end to end
    for (let i = 0; i < fin.length; i++) {
      for (let j = i + 1; j < fin.length; j++) {
        const a = fin[i];
        const b = fin[j];
        const g = gap({ x0: a.x0, x1: a.x1, y: a.y, t: a.thickness }, { x0: b.x0, x1: b.x1, y: b.y, t: b.thickness });
        const walkway = a.kind === 'soft' && b.kind === 'soft' && a.y === b.y && (a.x1 === b.x0 || b.x1 === a.x0);
        if (walkway) expect(g, `${a.id} abuts ${b.id}`).toBe(0);
        else expect(g, `${a.id} vs ${b.id}`).toBeGreaterThan(0);
      }
    }
    // everything inside the blast zones
    const { left, right, top, bottom } = AMPH.blast;
    for (const p of AMPH.platforms) {
      expect(p.x0).toBeGreaterThan(left);
      expect(p.x1).toBeLessThan(right);
      expect(p.y).toBeLessThan(top);
      expect(p.y - p.thickness).toBeGreaterThan(bottom);
    }
  });

  it('v1.7 span: sunL + span + sunR are ONE continuous walkway at y 3.0 (no gap, no overlap, same thickness) across the whole arena', () => {
    const run = ['sunL', 'span', 'sunR'].map((id) => def(AMPH, id));
    expect(new Set(run.map((p) => p.y)).size).toBe(1);
    expect(new Set(run.map((p) => p.thickness)).size).toBe(1);
    for (let i = 1; i < run.length; i++) expect(run[i].x0, `${run[i].id} starts where ${run[i - 1].id} ends`).toBeCloseTo(run[i - 1].x1, 9);
    expect(run[0].x0).toBeLessThanOrEqual(-8.5); // starts over the left floor ...
    expect(run[run.length - 1].x1).toBeGreaterThanOrEqual(8.5); // ... and ends over the right one: a fighter can step off at either end onto solid ground
    // the walkway is the middle of the arena: symmetric
    const span = def(AMPH, 'span');
    expect(span.x0 + span.x1).toBeCloseTo(0, 9);
  });

  it('v1.7 span clearances: well below the halo, clear above the core pedestal, never inside a solid, jumpable from the pedestal', () => {
    const span = def(AMPH, 'span');
    const halo = def(AMPH, 'halo');
    const core = def(AMPH, 'core');
    const spanBottom = span.y - span.thickness;
    // >= 1.2 m of clear air between the span's top and the halo's underside (fighters on the span must be able to jump)
    expect(halo.y - halo.thickness - span.y).toBeGreaterThanOrEqual(1.2);
    expect(halo.y - halo.thickness - span.y).toBeCloseTo(2.9, 9);
    // the soft span hangs above the pedestal: its underside is above the core's top (it never collides with it), a fighter on the core
    // can jump up through it (rise within the bots' jump reach; the real per-animal check is in sim.finalCrossing.test.ts), and no solid
    // platform touches the span's rectangle
    expect(spanBottom).toBeGreaterThan(core.y);
    expect(span.y - core.y).toBeGreaterThan(0);
    expect(span.y - core.y).toBeLessThanOrEqual(PHYS.dynReachUp);
    for (const p of AMPH.platforms.filter((q) => q.kind === 'solid')) {
      expect(gap({ x0: span.x0, x1: span.x1, y: span.y, t: span.thickness }, { x0: p.x0, x1: p.x1, y: p.y, t: p.thickness }), `span vs ${p.id}`).toBeGreaterThan(0);
    }
    // the span does not cover a ledge corner of the core / floors (the cover rule is |dy| <= PHYS.ledgeCoverDy)
    for (const p of AMPH.platforms.filter((q) => q.kind === 'solid')) {
      expect(Math.abs(p.y - span.y), `${p.id} ledge cover`).toBeGreaterThan(PHYS.ledgeCoverDy);
    }
    // the span stays inside the camera framing and blast zones with the same margins as the other final-form pieces
    expect(Math.max(Math.abs(span.x0), Math.abs(span.x1))).toBeLessThanOrEqual(AMPH.camera.maxHalfW);
  });
});

describe('online data fingerprint covers the stage data', () => {
  it('the championsLeague fingerprint data contains the whole STAGES table (paths, breakables, finalOnly)', () => {
    const text = stableStringify(fingerprintData('championsLeague'));
    for (const needle of ['"clockworkHeights"', '"crumblingAmphitheatre"', '"path"', '"keys"', '"breakable"', '"finalOnly"', '"hits"', '"periodS":36']) {
      expect(text.includes(needle), needle).toBe(true);
    }
    expect(computeFingerprint('championsLeague')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('changing any dynamic stage number changes the fingerprint (mismatched clients would be rejected)', () => {
    const fp = (stages: unknown): string => {
      const data = { ...(fingerprintData('championsLeague') as Record<string, unknown>), stages };
      return stableStringify(data);
    };
    const base = fp(STAGE_DEFS);
    expect(fp(STAGE_DEFS)).toBe(base);
    const mutate = (edit: (s: typeof STAGE_DEFS) => void): string => {
      const c = structuredClone(STAGE_DEFS);
      edit(c);
      return fp(c);
    };
    expect(mutate((s) => (s.crumblingAmphitheatre.platforms.find((p) => p.id === 'tileC')!.breakable!.hits += 1))).not.toBe(base);
    expect(mutate((s) => (s.clockworkHeights.platforms[1].path!.keys[2].x += 0.01))).not.toBe(base);
    expect(mutate((s) => (s.clockworkHeights.platforms[0].path!.periodS += 1))).not.toBe(base);
    expect(mutate((s) => delete s.crumblingAmphitheatre.platforms.find((p) => p.id === 'sunL')!.finalOnly)).not.toBe(base);
    expect(mutate((s) => (s.crumblingAmphitheatre.platforms[0].x1 += 0.5))).not.toBe(base);
    // v1.7: the final-form span is part of the data a mismatched client would disagree on
    expect(mutate((s) => (s.crumblingAmphitheatre.platforms.find((p) => p.id === 'span')!.x1 += 0.5))).not.toBe(base);
    expect(mutate((s) => (s.crumblingAmphitheatre.platforms = s.crumblingAmphitheatre.platforms.filter((p) => p.id !== 'span')))).not.toBe(base);
  });
});
