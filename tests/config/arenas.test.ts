/**
 * v1.8 arena registry: `getArena`, the colosseum def being a faithful view of the unchanged `config/arena.ts`
 * constants, spawn positions, ground height, and the derived views of ArenaDef.
 */

import { describe, it, expect } from 'vitest';
import { ARENA_IDS } from '../../src/core/types';
import {
  ARENAS,
  COLOSSEUM_ARENA,
  JUNGLE_ARENA,
  arenaGroundHeight,
  getArena,
  isArenaId,
  spawnPositions,
  staticObstaclesOf,
} from '../../src/config/arenas';
import * as A from '../../src/config/arena';
import { MATCH, ARENA as ARENA_CFG } from '../../src/config/balance';
import { dirToYaw } from '../../src/core/math';
import { seatPositions, seatRoster } from '../../src/match/seating';

describe('arena registry', () => {
  it('has exactly one def per ArenaId, keyed by its own id', () => {
    expect(Object.keys(ARENAS).sort()).toEqual([...ARENA_IDS].sort());
    for (const id of ARENA_IDS) expect(ARENAS[id].id).toBe(id);
  });

  it('getArena(undefined) is the colosseum; known ids resolve; unknown ids fall back to the colosseum', () => {
    expect(getArena(undefined)).toBe(COLOSSEUM_ARENA);
    expect(getArena('colosseum')).toBe(COLOSSEUM_ARENA);
    expect(getArena('jungle')).toBe(JUNGLE_ARENA);
    expect(getArena('atlantis' as never)).toBe(COLOSSEUM_ARENA);
  });

  it('isArenaId accepts the registered ids only', () => {
    expect(isArenaId('jungle')).toBe(true);
    expect(isArenaId('colosseum')).toBe(true);
    expect(isArenaId('moon')).toBe(false);
    expect(isArenaId(undefined)).toBe(false);
    expect(isArenaId(3)).toBe(false);
  });

  it('every def has a name, a blurb, a wall, and a consistent derived view', () => {
    for (const id of ARENA_IDS) {
      const a = ARENAS[id];
      expect(a.name.length).toBeGreaterThan(2);
      expect(a.blurb.length).toBeGreaterThan(10);
      expect(a.wallRadius).toBe(30);
      expect(a.wallHeight).toBe(5);
      expect(a.standsOuter).toBeGreaterThan(a.standsInner);
      expect(a.standsInner).toBeGreaterThan(a.wallRadius);
      // solids = circles, then segments, then crates (the order the sim has always used)
      expect(a.solids).toEqual([...a.circles, ...a.segments, ...a.crates]);
      expect(a.circles.every((o) => o.shape === 'circle' && !o.walkable)).toBe(true);
      expect(a.segments.every((o) => o.shape === 'segment')).toBe(true);
      expect(a.crates.every((o) => o.shape === 'aabb' && o.destructible && o.hp > 0)).toBe(true);
      expect(a.spawns).toHaveLength(10);
      expect(a.pickupPads).toHaveLength(6);
      expect(a.pickupPads.map((p) => p.id)).toEqual([0, 1, 2, 3, 4, 5]);
      for (const o of a.solids) expect(typeof o.kind).toBe('string');
    }
  });

  it('ARENAS is plain data (JSON round-trips) so it can be fingerprinted', () => {
    const copy = JSON.parse(JSON.stringify(ARENAS)) as typeof ARENAS;
    expect(copy.jungle.circles).toHaveLength(JUNGLE_ARENA.circles.length);
    expect(copy.colosseum.pickupPads).toEqual(JSON.parse(JSON.stringify(COLOSSEUM_ARENA.pickupPads)));
  });
});

describe('colosseum def = the unchanged config/arena constants', () => {
  it('bounds, pillars, columns, crates, dais, pads, gates', () => {
    const c = COLOSSEUM_ARENA;
    expect(c.wallRadius).toBe(A.WALL_RADIUS);
    expect(c.wallHeight).toBe(A.WALL_HEIGHT);
    expect(c.standsInner).toBe(A.STANDS_INNER);
    expect(c.standsOuter).toBe(A.STANDS_OUTER);
    expect(c.circles.map(({ kind: _k, ...o }) => o)).toEqual([...A.PILLARS]);
    expect(c.segments.map(({ kind: _k, ...o }) => o)).toEqual([...A.FALLEN_COLUMNS]);
    expect(c.crates.map(({ kind: _k, ...o }) => o)).toEqual([...A.CRATES]);
    expect(c.pickupPads).toEqual([...A.PICKUP_PADS]);
    expect(c.dais).toEqual(A.DAIS);
    expect(c.gateAnglesDeg).toEqual([...A.GATE_ANGLES_DEG]);
    expect(c.terrain).toEqual([]);
    // SOLID_OBSTACLES ordering is preserved
    expect(c.solids.map(({ kind: _k, ...o }) => o)).toEqual([...A.SOLID_OBSTACLES]);
  });

  it('kind tags let the renderer tell pillar / column / crate apart', () => {
    expect(COLOSSEUM_ARENA.circles.every((o) => o.kind === 'pillar')).toBe(true);
    expect(COLOSSEUM_ARENA.segments.every((o) => o.kind === 'column')).toBe(true);
    expect(COLOSSEUM_ARENA.crates.every((o) => o.kind === 'crate')).toBe(true);
  });

  it('static obstacles (sim colliders) are the pillars then the fallen columns, crates excluded', () => {
    const st = staticObstaclesOf(COLOSSEUM_ARENA);
    expect(st).toHaveLength(A.PILLARS.length + A.FALLEN_COLUMNS.length);
    expect(st.every((o) => o.shape !== 'aabb')).toBe(true);
  });

  it('spawn positions are the v1.0 ring rule for every roster size (bit-identical to the old World formula)', () => {
    for (let n = 1; n <= 10; n++) {
      const got = spawnPositions(COLOSSEUM_ARENA, n);
      expect(got).toHaveLength(n);
      const stepDeg = 360 / n;
      for (let i = 0; i < n; i++) {
        const angle = ((270 + stepDeg * i) * Math.PI) / 180;
        expect(got[i].x).toBe(MATCH.spawnRing * Math.cos(angle));
        expect(got[i].z).toBe(MATCH.spawnRing * Math.sin(angle));
      }
    }
    expect(COLOSSEUM_ARENA.spawns).toEqual(spawnPositions(COLOSSEUM_ARENA, 10));
    // seat 0 is due south (z negative, x ~ 0)
    expect(Math.abs(COLOSSEUM_ARENA.spawns[0].x)).toBeLessThan(1e-9);
    expect(COLOSSEUM_ARENA.spawns[0].z).toBeCloseTo(-MATCH.spawnRing, 9);
  });

  it('ground height: dais top inside r=4, else 0; arenas without a dais are flat', () => {
    expect(arenaGroundHeight(COLOSSEUM_ARENA, 0, 0)).toBe(ARENA_CFG.daisY);
    expect(arenaGroundHeight(COLOSSEUM_ARENA, 3.9, 0)).toBe(ARENA_CFG.daisY);
    expect(arenaGroundHeight(COLOSSEUM_ARENA, 4.1, 0)).toBe(ARENA_CFG.groundY);
    expect(arenaGroundHeight(JUNGLE_ARENA, 0, 0)).toBe(0);
    expect(arenaGroundHeight(JUNGLE_ARENA, 2, 1)).toBe(0);
  });
});

describe('spawn positions on the jungle', () => {
  it('10 fighters take all ten cleared seats; seat 0 is due south', () => {
    const s = spawnPositions(JUNGLE_ARENA, 10);
    expect(s).toEqual([...JUNGLE_ARENA.spawns]);
    expect(Math.abs(s[0].x)).toBeLessThan(1e-3);
    expect(s[0].z).toBeCloseTo(-20, 3);
  });

  it('smaller rosters take evenly spaced seats (2 fighters sit opposite each other)', () => {
    const two = spawnPositions(JUNGLE_ARENA, 2);
    expect(two[0]).toEqual(JUNGLE_ARENA.spawns[0]);
    expect(two[1]).toEqual(JUNGLE_ARENA.spawns[5]);
    expect(two[0].x + two[1].x).toBeCloseTo(0, 3);
    for (let n = 1; n <= 10; n++) {
      const got = spawnPositions(JUNGLE_ARENA, n);
      expect(got).toHaveLength(n);
      expect(new Set(got.map((p) => `${p.x},${p.z}`)).size).toBe(n); // distinct seats
      for (const p of got) expect(JUNGLE_ARENA.spawns.some((q) => q.x === p.x && q.z === p.z)).toBe(true);
    }
  });

  it('fighters spawned in the jungle face the centre', () => {
    for (const p of spawnPositions(JUNGLE_ARENA, 10)) {
      const yaw = dirToYaw(-p.x, -p.z);
      expect(Math.abs(Math.sin(yaw) * p.z - Math.cos(yaw) * p.x)).toBeLessThan(1e-6); // yaw direction passes through the origin
    }
  });
});

describe('match seating accepts the arena', () => {
  it('seatPositions = spawnPositions of the arena (default colosseum)', () => {
    expect(seatPositions(10)).toEqual(spawnPositions(COLOSSEUM_ARENA, 10));
    expect(seatPositions(10, JUNGLE_ARENA)).toEqual([...JUNGLE_ARENA.spawns]);
    expect(seatPositions(4, JUNGLE_ARENA)).toEqual(spawnPositions(JUNGLE_ARENA, 4));
  });

  it('seatRoster is unchanged for both arenas (ten animals, player first, same shuffle)', () => {
    const base = seatRoster('lion', 123);
    expect(base).toHaveLength(10);
    expect(base[0]).toEqual({ animal: 'lion', isPlayer: true });
    expect(seatRoster('lion', 123, COLOSSEUM_ARENA)).toEqual(base);
    expect(seatRoster('lion', 123, JUNGLE_ARENA)).toEqual(base);
  });
});
