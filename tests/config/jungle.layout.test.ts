/**
 * v1.8 Jungle Clearing layout rules (docs/JUNGLE-PLAN.md): counts, clearances, bounds, overlaps, and a free-space BFS
 * proving no spawn / pickup pad / crate pile is walled in and no pocket of the arena is sealed off.
 */

import { describe, it, expect } from 'vitest';
import { JUNGLE_ARENA as J } from '../../src/config/arenas';
import type { ArenaSegment } from '../../src/config/arenas';
import { PICKUPS } from '../../src/config/balance';
import { ANIMALS } from '../../src/config/animals';
import { componentAt, freeSpace, minSurfaceDist, segDist, segSegDist, surfaceDist, terrainDist } from './arenaGeom';

const trees = J.circles;
const logs = J.segments;
const pool = J.terrain.filter((t) => t.kind === 'water');
const moss = J.terrain.filter((t) => t.kind === 'moss');
const FIGHTER_R = 1.2; // the largest animal radius (hippo)

describe('jungle: data shape', () => {
  it('identity and bounds', () => {
    expect(J.id).toBe('jungle');
    expect(J.name).toBe('Jungle Clearing');
    expect(J.blurb).toBe('Giant trees, mossy ground and a shallow pool in the middle.');
    expect(J.wallRadius).toBe(30);
    expect(J.wallHeight).toBe(5);
    expect(J.dais).toBeUndefined();
    expect(J.gateAnglesDeg).toBeUndefined();
  });

  it('about 14 non-walkable, non-jumpable tree trunks (r 0.8-1.5, height 12), kind "tree"', () => {
    expect(trees).toHaveLength(14);
    for (const t of trees) {
      expect(t.kind).toBe('tree');
      expect(t.radius).toBeGreaterThanOrEqual(0.8);
      expect(t.radius).toBeLessThanOrEqual(1.5);
      expect(t.height).toBe(12);
      expect(t.walkable).toBe(false);
      expect(t.jumpable).toBe(false);
    }
    // a few big ones make the cover lanes
    expect(trees.filter((t) => t.radius >= 1.3).length).toBeGreaterThanOrEqual(4);
  });

  it('3-4 fallen logs: jumpable segments, thickness 1.0, height 0.9, kind "log"', () => {
    expect(logs.length).toBeGreaterThanOrEqual(3);
    expect(logs.length).toBeLessThanOrEqual(4);
    for (const l of logs) {
      expect(l.kind).toBe('log');
      expect(l.thickness).toBe(1.0);
      expect(l.height).toBe(0.9);
      expect(l.jumpable).toBe(true);
      const len = Math.hypot(l.bx - l.ax, l.bz - l.az);
      expect(len).toBeGreaterThanOrEqual(3);
      expect(len).toBeLessThanOrEqual(8);
    }
  });

  it('4 crate clusters of 3 (12 crates, 150 hp, 1 m) and 6 pickup pads, 10 spawn seats on the r=20 ring', () => {
    expect(J.crates).toHaveLength(12);
    for (const c of J.crates) {
      expect(c.kind).toBe('crate');
      expect(c.hp).toBe(150);
      expect(c.halfX).toBe(0.5);
      expect(c.height).toBe(1);
    }
    expect(J.pickupPads).toHaveLength(6);
    expect(J.spawns).toHaveLength(10);
    for (const s of J.spawns) expect(Math.hypot(s.x, s.z)).toBeCloseTo(20, 2);
    expect(J.spawnRing).toBe(20);
  });

  it('terrain: one central water pool r=6.5 depth 0.55 and 7 moss patches r 2-3.5', () => {
    expect(pool).toHaveLength(1);
    expect(pool[0]).toMatchObject({ kind: 'water', shape: 'circle', x: 0, z: 0, radius: 6.5, depth: 0.55 });
    expect(moss).toHaveLength(7);
    for (const m of moss) {
      expect(m.shape).toBe('circle');
      expect(m.radius).toBeGreaterThanOrEqual(2);
      expect(m.radius).toBeLessThanOrEqual(3.5);
      expect(m.depth).toBeUndefined();
    }
    expect(J.terrain).toHaveLength(8);
  });

  it('pool depth is shallow: below the smallest animal height scale, so nobody can go fully under', () => {
    // every animal is at least ~0.5 m tall (radius 0.5 is the mole, the smallest body)
    const smallest = Math.min(...Object.values(ANIMALS).map((a) => a.radius));
    expect(pool[0].depth as number).toBeLessThan(smallest * 2);
  });
});

describe('jungle: clearances', () => {
  const P = pool[0];

  it('trees are inside the wall with room to walk behind them (>= 2 m from the wall)', () => {
    for (const t of trees) expect(Math.hypot(t.x, t.z) + t.radius).toBeLessThanOrEqual(J.wallRadius - 2);
  });

  it('no tree within 3.5 m of a spawn seat or pickup pad (trunk surface to point)', () => {
    for (const t of trees) {
      for (const s of J.spawns) expect(surfaceDist(t, s.x, s.z)).toBeGreaterThanOrEqual(3.5);
      for (const p of J.pickupPads) expect(surfaceDist(t, p.x, p.z)).toBeGreaterThanOrEqual(3.5);
    }
  });

  it('no tree inside the pool or on a moss patch (discs do not overlap)', () => {
    for (const t of trees) {
      expect(Math.hypot(t.x - P.x, t.z - P.z)).toBeGreaterThanOrEqual(P.radius + t.radius + 1);
      for (const m of moss) expect(Math.hypot(t.x - m.x, t.z - m.z)).toBeGreaterThanOrEqual(m.radius + t.radius);
    }
  });

  it('trees do not overlap each other; gaps are wide enough for the biggest animal (>= 3 m)', () => {
    for (let i = 0; i < trees.length; i++) {
      for (let k = i + 1; k < trees.length; k++) {
        const gap = Math.hypot(trees[i].x - trees[k].x, trees[i].z - trees[k].z) - trees[i].radius - trees[k].radius;
        expect(gap).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('logs: inside the wall, off the pool, clear of trees/spawns/pads/crates, apart from each other', () => {
    for (const l of logs) {
      expect(Math.hypot(l.ax, l.az)).toBeLessThanOrEqual(J.wallRadius - 4);
      expect(Math.hypot(l.bx, l.bz)).toBeLessThanOrEqual(J.wallRadius - 4);
      expect(segDist(0, 0, l.ax, l.az, l.bx, l.bz) - l.thickness / 2).toBeGreaterThanOrEqual(P.radius + 2);
      for (const t of trees) expect(surfaceDist(l, t.x, t.z) - t.radius).toBeGreaterThanOrEqual(2);
      for (const s of J.spawns) expect(surfaceDist(l, s.x, s.z)).toBeGreaterThanOrEqual(3);
      for (const p of J.pickupPads) expect(surfaceDist(l, p.x, p.z)).toBeGreaterThanOrEqual(3);
      for (const c of J.crates) expect(surfaceDist(l, c.x, c.z) - 0.5).toBeGreaterThanOrEqual(2);
    }
    for (let i = 0; i < logs.length; i++) {
      for (let k = i + 1; k < logs.length; k++) {
        const a = logs[i] as ArenaSegment;
        const b = logs[k] as ArenaSegment;
        expect(segSegDist([a.ax, a.az, a.bx, a.bz], [b.ax, b.az, b.bx, b.bz])).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it('crates: inside the wall, outside the pool and moss, clear of trees, logs, pads and spawns', () => {
    for (const c of J.crates) {
      expect(Math.hypot(c.x, c.z)).toBeLessThanOrEqual(J.wallRadius - 6);
      expect(Math.hypot(c.x - P.x, c.z - P.z) - P.radius).toBeGreaterThanOrEqual(2);
      for (const m of moss) expect(terrainDist(m, c.x, c.z)).toBeGreaterThanOrEqual(1.5);
      for (const t of trees) expect(surfaceDist(t, c.x, c.z)).toBeGreaterThanOrEqual(2.6);
      for (const p of J.pickupPads) expect(Math.hypot(c.x - p.x, c.z - p.z)).toBeGreaterThanOrEqual(3);
      for (const s of J.spawns) expect(Math.hypot(c.x - s.x, c.z - s.z)).toBeGreaterThanOrEqual(4);
    }
    // crate piles do not overlap each other
    for (let i = 0; i < J.crates.length; i++) {
      for (let k = i + 1; k < J.crates.length; k++) {
        const a = J.crates[i];
        const b = J.crates[k];
        const sepX = Math.abs(a.x - b.x) - a.halfX - b.halfX;
        const sepZ = Math.abs(a.z - b.z) - a.halfZ - b.halfZ;
        expect(Math.max(sepX, sepZ)).toBeGreaterThan(0);
      }
    }
  });

  it('pickup pads: outside the pool (>= 3 m), off the moss (>= 1 m), clear of every solid', () => {
    for (const p of J.pickupPads) {
      expect(Math.hypot(p.x - P.x, p.z - P.z) - P.radius).toBeGreaterThanOrEqual(3);
      for (const m of moss) expect(terrainDist(m, p.x, p.z) - PICKUPS.radius).toBeGreaterThanOrEqual(1);
      expect(minSurfaceDist(J.solids, p.x, p.z)).toBeGreaterThanOrEqual(2.5);
      expect(Math.hypot(p.x, p.z) + PICKUPS.radius).toBeLessThan(J.wallRadius);
    }
  });

  it('spawn seats: clear of every solid (>= 3 m), outside the pool and every moss patch', () => {
    for (const s of J.spawns) {
      expect(minSurfaceDist(J.solids, s.x, s.z)).toBeGreaterThanOrEqual(3);
      expect(Math.hypot(s.x, s.z)).toBeGreaterThanOrEqual(P.radius + 3);
      for (const m of moss) expect(terrainDist(m, s.x, s.z)).toBeGreaterThanOrEqual(2.5);
    }
  });

  it('moss patches: inside the wall, not touching the pool, spawns, pads or solids; at most slight overlap with each other', () => {
    for (const m of moss) {
      expect(Math.hypot(m.x, m.z) + m.radius).toBeLessThanOrEqual(J.wallRadius - 2);
      expect(Math.hypot(m.x - P.x, m.z - P.z) - P.radius - m.radius).toBeGreaterThanOrEqual(0.5);
      for (const s of J.spawns) expect(terrainDist(m, s.x, s.z)).toBeGreaterThanOrEqual(2.5);
      for (const p of J.pickupPads) expect(terrainDist(m, p.x, p.z)).toBeGreaterThanOrEqual(1 + PICKUPS.radius);
      for (const t of trees) expect(Math.hypot(m.x - t.x, m.z - t.z) - m.radius - t.radius).toBeGreaterThanOrEqual(0.3);
      for (const c of J.crates) expect(terrainDist(m, c.x, c.z)).toBeGreaterThanOrEqual(1.5);
    }
    for (let i = 0; i < moss.length; i++) {
      for (let k = i + 1; k < moss.length; k++) {
        const overlap = moss[i].radius + moss[k].radius - Math.hypot(moss[i].x - moss[k].x, moss[i].z - moss[k].z);
        expect(overlap).toBeLessThanOrEqual(0.5);
      }
    }
  });
});

describe('jungle: accessibility (free-space BFS, 0.5 m grid, fighter radius 1.2 m)', () => {
  const fs = freeSpace(J, FIGHTER_R, 0.5);

  it('every spawn seat and every pickup pad lies in the same connected free region', () => {
    const base = componentAt(fs, J.spawns[0].x, J.spawns[0].z);
    expect(base).toBeGreaterThanOrEqual(0);
    for (const s of J.spawns) expect(componentAt(fs, s.x, s.z)).toBe(base);
    for (const p of J.pickupPads) expect(componentAt(fs, p.x, p.z)).toBe(base);
  });

  it('every crate pile and the pool centre are reachable too (approach cells next to each crate)', () => {
    const base = componentAt(fs, J.spawns[0].x, J.spawns[0].z);
    expect(componentAt(fs, 0, 0)).toBe(base);
    for (const c of J.crates) {
      // a body can stand 1.3 m off the crate on at least one side
      const sides = [
        [c.x + 1.7, c.z],
        [c.x - 1.7, c.z],
        [c.x, c.z + 1.7],
        [c.x, c.z - 1.7],
      ];
      expect(sides.some(([x, z]) => componentAt(fs, x, z) === base)).toBe(true);
    }
  });

  it('nothing is sealed off: >= 99% of all free cells are in the main region (no walled-in pockets)', () => {
    const total = fs.sizes.reduce((a, b) => a + b, 0);
    const base = componentAt(fs, J.spawns[0].x, J.spawns[0].z);
    expect(fs.sizes[base] / total).toBeGreaterThanOrEqual(0.99);
  });

  it('trees leave most of the arena open (a thinned forest, not a maze): >= 80% of the floor is free', () => {
    const floorCells = Math.PI * (J.wallRadius - FIGHTER_R) ** 2 / (0.5 * 0.5);
    const total = fs.sizes.reduce((a, b) => a + b, 0);
    expect(total / floorCells).toBeGreaterThanOrEqual(0.8);
  });

  it('a Cub-sized body (r 0.5) and the largest body (r 1.2) share the same connectivity of spawns/pads', () => {
    const small = freeSpace(J, 0.5, 0.5);
    const base = componentAt(small, J.spawns[0].x, J.spawns[0].z);
    for (const s of J.spawns) expect(componentAt(small, s.x, s.z)).toBe(base);
    for (const p of J.pickupPads) expect(componentAt(small, p.x, p.z)).toBe(base);
  });

  it('the cover lanes exist: at least 3 tree trunks stand between the spawn ring and the pool', () => {
    const mid = trees.filter((t) => Math.hypot(t.x, t.z) < 19);
    expect(mid.length).toBeGreaterThanOrEqual(3);
  });
});
