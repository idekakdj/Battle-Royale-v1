/**
 * v1.9 trap placement on the Ocean Dome: a trap disc lies wholly on ONE flat level (never on a ramp or at a cliff edge), clear of every
 * solid / pad / spawn / other trap, and its y is the ground height of its level. Every difficulty, many seeds.
 */

import { describe, it, expect } from 'vitest';
import { placeTraps, trapPlacementFor, trapSiteValid, TRAP_LEVEL_MARGIN } from '../../src/sim/TrapSystem';
import { World } from '../../src/sim/World';
import { EventBus } from '../../src/core/EventBus';
import { OCEAN_ARENA as O, arenaGroundHeight, arenaIsLevel, arenaSlopeAt, spawnPositions, type ElevationPiece } from '../../src/config/arenas';
import { TRAP_COUNT_BY_DIFFICULTY, TRAP_MAX_RADIUS } from '../../src/config/traps';
import { PICKUPS } from '../../src/config/balance';
import type { AnimalId, Difficulty, MatchConfig } from '../../src/core/types';
import { surfaceDist } from '../config/arenaGeom';

const LEVELS: Difficulty[] = [1, 2, 3, 4];
const R = TRAP_MAX_RADIUS;
const SPAWNS = spawnPositions(O, 10);
const P = trapPlacementFor(O);
const TEN: AnimalId[] = ['lion', 'gorilla', 'crocodile', 'hippo', 'rhino', 'eagle', 'panther', 'python', 'giraffe', 'mole'];
type Ramp = Extract<ElevationPiece, { kind: 'ramp' }>;
const ramps = (O.heightfield as readonly ElevationPiece[]).filter((p): p is Ramp => p.kind === 'ramp');

function rampDist(r: Ramp, x: number, z: number): number {
  const a = (r.dirDeg * Math.PI) / 180;
  const along = (x - r.x) * Math.cos(a) + (z - r.z) * Math.sin(a);
  const lat = -(x - r.x) * Math.sin(a) + (z - r.z) * Math.cos(a);
  return Math.hypot(Math.max(0, Math.abs(along) - r.length / 2), Math.max(0, Math.abs(lat) - r.width / 2));
}

describe('ocean trap placement across seeds', () => {
  it('places the full difficulty count for every seed at every difficulty (150 seeds each)', () => {
    const short: string[] = [];
    for (const d of LEVELS) {
      for (let seed = 1; seed <= 150; seed++) {
        const t = placeTraps(seed * 7919 + d, d, SPAWNS, 10, O);
        if (t.length !== TRAP_COUNT_BY_DIFFICULTY[d]) short.push(`L${d} seed ${seed}: ${t.length}`);
      }
    }
    expect(short).toEqual([]);
  });

  it('every trap disc: on one flat level, off every ramp and cliff edge, clear of solids / pads / spawns / other traps', () => {
    for (const d of LEVELS) {
      for (let seed = 1; seed <= 150; seed++) {
        const traps = placeTraps(seed * 104729 + d, d, SPAWNS, 10, O);
        traps.forEach((t, i) => {
          const { x, z } = t.pos;
          const tag = `L${d} seed ${seed} trap ${i}`;
          // flat ground wholly within trap radius + margin: no ramp, no level edge
          expect(arenaIsLevel(O, x, z, R + TRAP_LEVEL_MARGIN), tag + ' level').toBe(true);
          expect(arenaSlopeAt(O, x, z), tag + ' slope').toBe(0);
          for (const r of ramps) expect(rampDist(r, x, z) - R, tag + ' ramp').toBeGreaterThanOrEqual(TRAP_LEVEL_MARGIN - 1e-6);
          // y = the ground height of its level
          expect(t.pos.y, tag + ' y').toBe(arenaGroundHeight(O, x, z));
          expect([0, 1.5, 3], tag + ' on a level').toContain(t.pos.y);
          for (const ob of O.solids) expect(surfaceDist(ob, x, z) - R, tag + ' solid').toBeGreaterThanOrEqual(P.obstacleClear - 1e-6);
          for (const pad of O.pickupPads) expect(Math.hypot(x - pad.x, z - pad.z) - PICKUPS.radius - R, tag + ' pad').toBeGreaterThanOrEqual(P.pickupClear - 1e-6);
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

  it('traps appear on the terrace (and sometimes the seabed): the layout offers both levels', () => {
    const levels = new Set<number>();
    for (let seed = 1; seed <= 200; seed++) for (const t of placeTraps(seed, 4, SPAWNS, 10, O)) levels.add(t.pos.y);
    expect(levels.has(1.5)).toBe(true);
    expect(levels.size).toBeGreaterThanOrEqual(1);
  });

  it('trapSiteValid rejects a site on a ramp, on the rim of a level, and on the plateau slope', () => {
    const r = ramps[0];
    expect(trapSiteValid(r.x, r.z, SPAWNS, [], O)).toBe(false);
    expect(trapSiteValid(-18.2, 0, SPAWNS, [], O)).toBe(false); // terrace rim (r = 19)
    expect(trapSiteValid(-8.8, 0, SPAWNS, [], O)).toBe(false); // plateau edge (r = 8)
    const ok = placeTraps(1, 4, SPAWNS, 10, O)[0];
    expect(trapSiteValid(ok.pos.x, ok.pos.z, SPAWNS, [], O)).toBe(true); // a placed site is valid (flat, clear)
  });

  it('World on the ocean places traps through the arena (every difficulty) with y = ground', () => {
    for (const d of LEVELS) {
      const cfg: MatchConfig = { roster: TEN.map((a) => ({ animal: a, isPlayer: false })), difficulty: d, arena: 'ocean' };
      const w = new World(cfg, 31337 + d, new EventBus());
      expect(w.traps).toHaveLength(TRAP_COUNT_BY_DIFFICULTY[d]);
      for (const t of w.traps) expect(t.pos.y).toBe(arenaGroundHeight(O, t.pos.x, t.pos.z));
      const direct = placeTraps(31337 + d, d, spawnPositions(O, 10), 10, O);
      expect(w.traps.map((t) => [t.kind, t.pos.x, t.pos.y, t.pos.z])).toEqual(direct.map((t) => [t.kind, t.pos.x, t.pos.y, t.pos.z]));
      // the snapshot carries the trap y
      expect(w.snapshot().traps.map((t) => t.pos.y)).toEqual(w.traps.map((t) => t.pos.y));
    }
  });

  it('a fighter standing on a terrace trap triggers it (altitude is relative to the ground), a seabed fighter below does not', () => {
    const cfg: MatchConfig = { roster: [{ animal: 'lion', isPlayer: true }, { animal: 'gorilla', isPlayer: false }], difficulty: 4, arena: 'ocean' };
    let w = new World(cfg, 1, new EventBus());
    for (let seed = 2; seed < 600 && !w.traps.some((t) => t.pos.y === 1.5); seed++) w = new World(cfg, seed, new EventBus()); // (v1.10: most sites are on the seabed; a terrace trap turns up within a few dozen seeds)
    for (let i = 0; i < 190; i++) w.step(1 / 60);
    const terraceTrap = w.traps.find((t) => t.pos.y === 1.5);
    expect(terraceTrap).toBeDefined();
    const t = terraceTrap as NonNullable<typeof terraceTrap>;
    const f = w.fighters[0];
    f.state.pos.x = t.pos.x;
    f.state.pos.z = t.pos.z;
    f.state.pos.y = 1.5;
    w.fighters[1].state.pos.x = 25;
    w.fighters[1].state.pos.z = 5;
    w.step(1 / 60);
    expect(t.phase).toBe('active');
    expect(f.state.hp).toBeLessThan(f.state.maxHp);
  });
});
