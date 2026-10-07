/**
 * v1.8 trap placement is arena-aware: clearances come from the arena's solids, pads, spawns AND terrain zones, so a trap is
 * never placed in the jungle pool / on moss / near a trunk; the colosseum's placement is unchanged.
 */

import { describe, it, expect } from 'vitest';
import { placeTraps, obstacleSurfaceDist, trapSiteValid, trapPlacementFor } from '../../src/sim/TrapSystem';
import { World } from '../../src/sim/World';
import { EventBus } from '../../src/core/EventBus';
import { COLOSSEUM_ARENA, JUNGLE_ARENA as J, spawnPositions, type ArenaDef } from '../../src/config/arenas';
import { TRAP_COUNT_BY_DIFFICULTY, TRAP_MAX_RADIUS, TRAP_PLACEMENT } from '../../src/config/traps';
import { PICKUPS } from '../../src/config/balance';
import type { Difficulty, MatchConfig } from '../../src/core/types';
import { surfaceDist, terrainDist } from '../config/arenaGeom';

const LEVELS: Difficulty[] = [1, 2, 3, 4];
const R = TRAP_MAX_RADIUS;
const SPAWNS = spawnPositions(J, 10);
const P = trapPlacementFor(J);

describe('jungle trap placement across seeds', () => {
  it('places the full difficulty count for every seed at every difficulty', () => {
    for (const d of LEVELS) {
      for (let seed = 1; seed <= 150; seed++) {
        const t = placeTraps(seed * 7919 + d, d, SPAWNS, 10, J);
        expect(t.length, `L${d} seed ${seed}`).toBe(TRAP_COUNT_BY_DIFFICULTY[d]);
      }
    }
  });

  it('every trap disc is wholly outside the pool and every moss patch, and clear of every solid, pad, spawn and other trap', () => {
    for (const d of LEVELS) {
      for (let seed = 1; seed <= 150; seed++) {
        const traps = placeTraps(seed * 104729 + d, d, SPAWNS, 10, J);
        traps.forEach((t, i) => {
          const { x, z } = t.pos;
          const tag = `L${d} seed ${seed} trap ${i}`;
          for (const zone of J.terrain) {
            expect(terrainDist(zone, x, z) - R, tag + ' terrain').toBeGreaterThanOrEqual(J.trapRules.terrainClear - 1e-6);
          }
          for (const ob of J.solids) expect(surfaceDist(ob, x, z) - R, tag + ' solid').toBeGreaterThanOrEqual(P.obstacleClear - 1e-6);
          for (const pad of J.pickupPads) {
            expect(Math.hypot(x - pad.x, z - pad.z) - PICKUPS.radius - R, tag + ' pad').toBeGreaterThanOrEqual(P.pickupClear - 1e-6);
          }
          for (const s of SPAWNS) expect(Math.hypot(x - s.x, z - s.z) - R, tag + ' spawn').toBeGreaterThanOrEqual(P.spawnClear - 1e-6);
          for (let k = 0; k < i; k++) {
            const o = traps[k].pos;
            expect(Math.hypot(x - o.x, z - o.z) - 2 * R, tag + ' trap').toBeGreaterThanOrEqual(P.trapClear - 1e-6);
          }
          expect(Math.hypot(x, z)).toBeGreaterThanOrEqual(P.minRadius - 1e-6);
          expect(Math.hypot(x, z)).toBeLessThanOrEqual(P.maxRadius + 1e-6);
        });
      }
    }
  });

  it('no trap centre is ever inside the water pool or a moss patch (the plain-language rule)', () => {
    for (let seed = 1; seed <= 100; seed++) {
      for (const t of placeTraps(seed, 4, SPAWNS, 10, J)) {
        for (const zone of J.terrain) expect(terrainDist(zone, t.pos.x, t.pos.z)).toBeGreaterThan(R);
      }
    }
  });

  it('placement is deterministic per seed, varies between seeds, and has both kinds when >= 2 traps', () => {
    const a = placeTraps(777, 4, SPAWNS, 10, J);
    const b = placeTraps(777, 4, SPAWNS, 10, J);
    expect(a.map((t) => [t.kind, t.pos.x, t.pos.z])).toEqual(b.map((t) => [t.kind, t.pos.x, t.pos.z]));
    const layouts = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) layouts.add(placeTraps(seed, 3, SPAWNS, 10, J).map((t) => `${t.pos.x},${t.pos.z}`).join(';'));
    expect(layouts.size).toBeGreaterThan(30); // not the same few spots every match
    for (let seed = 1; seed <= 60; seed++) {
      const kinds = new Set(placeTraps(seed, 2, SPAWNS, 10, J).map((t) => t.kind));
      expect(kinds.size).toBe(2);
    }
  });

  it('World on the jungle places traps through the arena (default placement on, every difficulty)', () => {
    for (const d of LEVELS) {
      const cfg: MatchConfig = { roster: ['lion', 'gorilla', 'crocodile', 'hippo', 'rhino', 'eagle', 'panther', 'python', 'giraffe', 'mole'].map((a) => ({ animal: a as never, isPlayer: false })), difficulty: d, arena: 'jungle' };
      const w = new World(cfg, 31337 + d, new EventBus());
      expect(w.traps).toHaveLength(TRAP_COUNT_BY_DIFFICULTY[d]);
      for (const t of w.traps) {
        for (const zone of J.terrain) expect(terrainDist(zone, t.pos.x, t.pos.z) - R).toBeGreaterThanOrEqual(J.trapRules.terrainClear - 1e-6);
      }
      const direct = placeTraps(31337 + d, d, spawnPositions(J, 10), 10, J);
      expect(w.traps.map((t) => [t.kind, t.pos.x, t.pos.z])).toEqual(direct.map((t) => [t.kind, t.pos.x, t.pos.z]));
    }
  });
});

describe('arena-aware placement helpers', () => {
  it('obstacleSurfaceDist sees the jungle trunk, log and crate surfaces (and no dais)', () => {
    const tree = J.circles[1];
    expect(obstacleSurfaceDist(tree.x + tree.radius + 2, tree.z, J)).toBeLessThanOrEqual(2 + 1e-9);
    const log = J.segments[0];
    const mx = (log.ax + log.bx) / 2;
    const mz = (log.az + log.bz) / 2;
    expect(obstacleSurfaceDist(mx, mz, J)).toBeLessThanOrEqual(-log.thickness / 2 + 1e-9);
    expect(obstacleSurfaceDist(0, 0, J)).toBeGreaterThan(5); // the pool centre is far from every solid; no dais
    expect(obstacleSurfaceDist(0, 0, COLOSSEUM_ARENA)).toBeLessThanOrEqual(-4 + 1e-9); // colosseum: inside the dais disc
  });

  it('colosseum placement through the arena equals the legacy call (default arena), seed for seed', () => {
    const sp = spawnPositions(COLOSSEUM_ARENA, 10);
    for (const d of LEVELS) {
      for (let seed = 1; seed <= 40; seed++) {
        const legacy = placeTraps(seed * 31 + d, d, sp, 10);
        const viaArena = placeTraps(seed * 31 + d, d, sp, 10, COLOSSEUM_ARENA);
        expect(viaArena.map((t) => [t.kind, t.pos.x, t.pos.z])).toEqual(legacy.map((t) => [t.kind, t.pos.x, t.pos.z]));
        expect(legacy).toHaveLength(TRAP_COUNT_BY_DIFFICULTY[d]);
      }
    }
    expect(trapPlacementFor(COLOSSEUM_ARENA)).toEqual({
      minRadius: TRAP_PLACEMENT.minRadius,
      maxRadius: TRAP_PLACEMENT.maxRadius,
      obstacleClear: TRAP_PLACEMENT.obstacleClear,
      pickupClear: TRAP_PLACEMENT.pickupClear,
      spawnClear: TRAP_PLACEMENT.spawnClear,
      trapClear: TRAP_PLACEMENT.trapClear,
    });
  });

  it('terrain zones and exclusion discs reject sites; overrides change the ring and clearances', () => {
    // a synthetic open arena: the colosseum with a water pool / moss patch / exclusion disc added
    const open: ArenaDef = { ...COLOSSEUM_ARENA, solids: [], circles: [], segments: [], crates: [], dais: undefined, pickupPads: [] };
    expect(trapSiteValid(15, 0, [], [], open)).toBe(true);
    const wet: ArenaDef = { ...open, terrain: [{ kind: 'water', shape: 'circle', x: 15, z: 0, radius: 3, depth: 0.5 }] };
    expect(trapSiteValid(15, 0, [], [], wet)).toBe(false); // in the water
    expect(trapSiteValid(15 + 3 + R + 0.2, 0, [], [], wet)).toBe(false); // inside the terrain gap
    expect(trapSiteValid(15 + 3 + R + 0.6, 0, [], [], wet)).toBe(true); // just outside the 0.5 m gap
    const mossy: ArenaDef = { ...open, terrain: [{ kind: 'moss', shape: 'circle', x: -12, z: 4, radius: 2.5 }] };
    expect(trapSiteValid(-12, 4, [], [], mossy)).toBe(false);
    const excl: ArenaDef = { ...open, trapRules: { overrides: {}, exclusions: [{ x: 10, z: 10, radius: 2 }], terrainClear: 0.5 } };
    expect(trapSiteValid(10, 10, [], [], excl)).toBe(false);
    expect(trapSiteValid(10 + 2 + R + TRAP_PLACEMENT.obstacleClear + 0.1, 10, [], [], excl)).toBe(true);
    const tight: ArenaDef = { ...open, trapRules: { overrides: { minRadius: 10, maxRadius: 12 }, exclusions: [], terrainClear: 0.5 } };
    expect(trapSiteValid(8, 0, [], [], tight)).toBe(false);
    expect(trapSiteValid(11, 0, [], [], tight)).toBe(true);
    expect(trapSiteValid(13, 0, [], [], tight)).toBe(false);
    for (const t of placeTraps(5, 4, [], 10, tight)) expect(Math.hypot(t.pos.x, t.pos.z)).toBeGreaterThanOrEqual(10 - 1e-6);
  });
});
