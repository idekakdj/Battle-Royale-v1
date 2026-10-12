/**
 * v1.9 Ocean Dome layout rules (docs/OCEAN-PLAN.md): three levels joined by ramps, cover on every level, spawn / pad / crate heights,
 * clearances, and a walk-graph proof (0.5 m grid, fighter radius 1.2 m, the sim's step + cliff rule) that every spawn, pad, crate pile
 * and the centre plateau are reachable from every spawn using ONLY the ramps.
 */

import { describe, it, expect } from 'vitest';
import type { ElevationPiece } from '../../src/config/arenas';
import {
  ARENAS,
  ARENA_MAX_RAMP_SLOPE,
  ARENA_STEP_UP,
  OCEAN_ARENA as O,
  arenaCliffDistance,
  arenaGroundHeight,
  arenaIsLevel,
  arenaSlopeAt,
  elevationPieceHeight,
  getArena,
  isArenaId,
} from '../../src/config/arenas';
import { PICKUPS } from '../../src/config/balance';
import { segDist, surfaceDist, walkSpace } from './arenaGeom';

type Ramp = Extract<ElevationPiece, { kind: 'ramp' }>;
const hf = O.heightfield as readonly ElevationPiece[];
const ramps = hf.filter((p): p is Ramp => p.kind === 'ramp');
const outerRamps = ramps.filter((r) => r.h0 === 0 && r.h1 === 1.5);
const innerRamps = ramps.filter((r) => r.h0 === 1.5 && r.h1 === 3);
const FIGHTER_R = 1.2; // the largest animal radius (hippo)

/** Distance from (x,z) to a ramp's rectangle (0 inside). */
function rampDist(r: Ramp, x: number, z: number): number {
  const a = (r.dirDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const along = (x - r.x) * c + (z - r.z) * s;
  const lat = -(x - r.x) * s + (z - r.z) * c;
  const dx = Math.max(0, Math.abs(along) - r.length / 2);
  const dz = Math.max(0, Math.abs(lat) - r.width / 2);
  return Math.hypot(dx, dz);
}
const minRampDist = (x: number, z: number): number => Math.min(...ramps.map((r) => rampDist(r, x, z)));
const angleOf = (x: number, z: number): number => ((Math.atan2(z, x) * 180) / Math.PI + 360) % 360;

describe('ocean: identity and registry', () => {
  it('is registered as "ocean" and has the plan numbers', () => {
    expect(O.id).toBe('ocean');
    expect(O.name).toBe('Ocean Dome');
    expect(ARENAS.ocean).toBe(O);
    expect(getArena('ocean')).toBe(O);
    expect(isArenaId('ocean')).toBe(true);
    expect(O.wallRadius).toBe(30);
    expect(O.wallHeight).toBe(5);
    expect(O.standsInner).toBe(31);
    expect(O.standsOuter).toBe(44);
    expect(O.terrain).toEqual([]);
    expect(O.hazards).toEqual({ serpent: true });
    expect(O.dais).toBeUndefined();
    expect(O.spawnLayout).toBe('seats');
  });

  it('the colosseum and the jungle have no height field and no hazards', () => {
    expect(ARENAS.colosseum.heightfield).toBeUndefined();
    expect(ARENAS.jungle.heightfield).toBeUndefined();
    expect(ARENAS.colosseum.hazards).toBeUndefined();
    expect(ARENAS.jungle.hazards).toBeUndefined();
  });
});

describe('ocean: levels and ramps', () => {
  it('three levels: seabed 0 (r > 19), terrace 1.5 (8 < r < 19), plateau 3.0 (r < 8) away from the ramps', () => {
    // sample the west direction (180°): no ramp (outer ramps at 144° / 216°, inner ones at 108° / 252°)
    const at = (r: number, deg = 180) => arenaGroundHeight(O, r * Math.cos((deg * Math.PI) / 180), r * Math.sin((deg * Math.PI) / 180));
    expect(at(0)).toBe(3);
    expect(at(7.9)).toBe(3);
    expect(at(8.2)).toBe(1.5);
    expect(at(15)).toBe(1.5);
    expect(at(18.9)).toBe(1.5);
    expect(at(19.2)).toBe(0);
    expect(at(25)).toBe(0);
    expect(at(29.9)).toBe(0);
  });

  it('>= 4 seabed->terrace ramps at distinct angles and >= 3 terrace->plateau ramps, offset from the outer ones', () => {
    expect(outerRamps.length).toBeGreaterThanOrEqual(4);
    expect(innerRamps.length).toBeGreaterThanOrEqual(3);
    expect(outerRamps.length + innerRamps.length).toBe(ramps.length);
    const outerAng = outerRamps.map((r) => angleOf(r.x, r.z));
    const innerAng = innerRamps.map((r) => angleOf(r.x, r.z));
    const gap = (a: number, b: number): number => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
    for (let i = 0; i < outerAng.length; i++) {
      for (let k = i + 1; k < outerAng.length; k++) expect(gap(outerAng[i], outerAng[k])).toBeGreaterThanOrEqual(30);
    }
    for (const a of innerAng) for (const b of outerAng) expect(gap(a, b)).toBeGreaterThanOrEqual(20); // routes differ
  });

  it('every ramp: slope <= 25 deg, width >= 5 m, rises 1.5 m between two levels, ends flush with them', () => {
    for (const r of ramps) {
      expect(Math.abs(r.h1 - r.h0) / r.length).toBeLessThanOrEqual(ARENA_MAX_RAMP_SLOPE);
      expect(r.width).toBeGreaterThanOrEqual(5);
      expect(r.h1 - r.h0).toBeCloseTo(1.5, 9);
      expect(r.length).toBeGreaterThanOrEqual(4);
    }
    // the low end of an outer ramp touches the seabed (height 0), its high end the terrace ring (1.5); likewise the inner ones
    for (const r of ramps) {
      const a = (r.dirDeg * Math.PI) / 180;
      const lowX = r.x - (Math.cos(a) * (r.length / 2 - 1e-6));
      const lowZ = r.z - (Math.sin(a) * (r.length / 2 - 1e-6));
      const topX = r.x + (Math.cos(a) * (r.length / 2 - 1e-6));
      const topZ = r.z + (Math.sin(a) * (r.length / 2 - 1e-6));
      expect(elevationPieceHeight(r, lowX, lowZ)).toBeCloseTo(r.h0, 6);
      expect(elevationPieceHeight(r, topX, topZ)).toBeCloseTo(r.h1, 6);
      // low end is on the lower level's flat ground just beyond the end (no step), high end tucks under the upper level
      const beyondLow = arenaGroundHeight(O, lowX - Math.cos(a) * 0.3, lowZ - Math.sin(a) * 0.3);
      expect(beyondLow).toBeCloseTo(r.h0, 6);
      const beyondTop = arenaGroundHeight(O, topX + Math.cos(a) * 0.3, topZ + Math.sin(a) * 0.3);
      expect(beyondTop).toBeCloseTo(r.h1, 6);
    }
  });

  it('the ground is continuous along every ramp axis (no step bigger than 0.2 m anywhere on the way up)', () => {
    for (const r of ramps) {
      const a = (r.dirDeg * Math.PI) / 180;
      let prev = NaN;
      for (let t = -r.length / 2 - 2; t <= r.length / 2 + 2; t += 0.05) {
        const h = arenaGroundHeight(O, r.x + Math.cos(a) * t, r.z + Math.sin(a) * t);
        if (!Number.isNaN(prev)) expect(Math.abs(h - prev)).toBeLessThanOrEqual(0.2);
        prev = h;
      }
    }
  });

  it('arenaSlopeAt reports the ramp grade on a ramp and 0 on flat levels', () => {
    for (const r of ramps) expect(arenaSlopeAt(O, r.x, r.z)).toBeCloseTo(Math.abs(r.h1 - r.h0) / r.length, 9);
    expect(arenaSlopeAt(O, 0, 0)).toBe(0);
    expect(arenaSlopeAt(O, 0, 14)).toBe(0);
    expect(arenaSlopeAt(O, 0, -26)).toBe(0);
  });
});

describe('ocean: spawns, pads, crates', () => {
  it('10 spawn seats on the seabed ring r=24, seat 0 due south, all at height 0 on flat ground', () => {
    expect(O.spawns).toHaveLength(10);
    expect(O.spawns[0].x).toBeCloseTo(0, 3);
    expect(O.spawns[0].z).toBeCloseTo(-24, 3);
    for (const s of O.spawns) {
      expect(Math.hypot(s.x, s.z)).toBeCloseTo(24, 2);
      expect(arenaGroundHeight(O, s.x, s.z)).toBe(0);
      expect(arenaIsLevel(O, s.x, s.z, 2)).toBe(true);
    }
  });

  it('6 pickup pads spread over all three levels; the centre plateau holds one at the middle', () => {
    expect(O.pickupPads).toHaveLength(6);
    expect(O.pickupPads.map((p) => p.id)).toEqual([0, 1, 2, 3, 4, 5]);
    const levels = O.pickupPads.map((p) => arenaGroundHeight(O, p.x, p.z));
    expect(new Set(levels)).toEqual(new Set([0, 1.5, 3]));
    const plateau = O.pickupPads.filter((p) => arenaGroundHeight(O, p.x, p.z) === 3);
    expect(plateau.length).toBeGreaterThanOrEqual(1);
    expect(Math.hypot(plateau[0].x, plateau[0].z)).toBeLessThan(1);
    expect(levels.filter((h) => h === 1.5).length).toBeGreaterThanOrEqual(2);
    expect(levels.filter((h) => h === 0).length).toBeGreaterThanOrEqual(2);
    for (const p of O.pickupPads) {
      // flat level, off every ramp and at least 3 m from any level edge
      expect(arenaIsLevel(O, p.x, p.z, PICKUPS.radius + 1.5), `pad ${p.id} level`).toBe(true);
      expect(minRampDist(p.x, p.z)).toBeGreaterThanOrEqual(2.5);
      expect(Math.hypot(p.x, p.z) + PICKUPS.radius).toBeLessThan(O.wallRadius - 2);
    }
  });

  it('4 crate clusters of 3 on two levels, each crate sitting on its ground (baseY) and on one flat level', () => {
    expect(O.crates).toHaveLength(12);
    const baseSet = new Set<number>();
    for (const c of O.crates) {
      expect(c.kind).toBe('crate');
      expect(c.hp).toBe(150);
      expect(c.baseY).toBe(arenaGroundHeight(O, c.x, c.z));
      expect(arenaIsLevel(O, c.x, c.z, 2.2)).toBe(true);
      baseSet.add(c.baseY as number);
    }
    expect([...baseSet].sort()).toEqual([0, 1.5]);
    // 2 clusters on each of the two levels
    expect(O.crates.filter((c) => c.baseY === 0)).toHaveLength(6);
    expect(O.crates.filter((c) => c.baseY === 1.5)).toHaveLength(6);
  });

  it('every solid has baseY = the ground height under it (flat under its whole footprint plus 1 m)', () => {
    for (const s of O.solids) {
      if (s.shape === 'circle') {
        expect(s.baseY).toBe(arenaGroundHeight(O, s.x, s.z));
        expect(arenaIsLevel(O, s.x, s.z, s.radius + 1)).toBe(true);
      } else if (s.shape === 'segment') {
        const len = Math.hypot(s.bx - s.ax, s.bz - s.az);
        for (let i = 0; i <= 8; i++) {
          const x = s.ax + ((s.bx - s.ax) * i) / 8;
          const z = s.az + ((s.bz - s.az) * i) / 8;
          expect(arenaGroundHeight(O, x, z)).toBe(s.baseY);
          expect(arenaIsLevel(O, x, z, s.thickness / 2 + 1)).toBe(true);
        }
        expect(len).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe('ocean: cover', () => {
  const blockers = O.circles;
  const arches = O.segments;
  const levelOf = (x: number, z: number): number => arenaGroundHeight(O, x, z);

  it('coral pillars, rock outcrops and arches exist on every level', () => {
    for (const lvl of [0, 1.5, 3]) {
      const here = blockers.filter((b) => levelOf(b.x, b.z) === lvl);
      expect(here.length).toBeGreaterThanOrEqual(2);
    }
    expect(blockers.filter((b) => b.kind === 'coral').length).toBeGreaterThanOrEqual(3);
    expect(blockers.filter((b) => b.kind === 'rock').length).toBeGreaterThanOrEqual(3);
    expect(blockers.every((b) => b.kind === 'coral' || b.kind === 'rock')).toBe(true);
    expect(arches.length).toBeGreaterThanOrEqual(2);
    for (const a of arches) {
      expect(a.kind).toBe('arch');
      expect(a.jumpable).toBe(true);
      expect(a.thickness).toBeGreaterThanOrEqual(1);
    }
    // arches on at least two levels
    expect(new Set(arches.map((a) => levelOf((a.ax + a.bx) / 2, (a.az + a.bz) / 2))).size).toBeGreaterThanOrEqual(2);
    for (const b of blockers) {
      expect(b.walkable).toBe(false);
      expect(b.jumpable).toBe(false);
    }
  });

  it('inside the wall with no body-sized pocket behind it (every solid reaches at most r = 27.5, i.e. leaves >= 2.5 m to the wall)', () => {
    const bad: string[] = [];
    O.solids.forEach((s, i) => {
      const reach =
        s.shape === 'circle'
          ? Math.hypot(s.x, s.z) + s.radius
          : s.shape === 'segment'
            ? Math.max(Math.hypot(s.ax, s.az), Math.hypot(s.bx, s.bz)) + s.thickness / 2
            : Math.hypot(s.x, s.z) + s.halfX * Math.SQRT2;
      if (reach > O.wallRadius - 2.5) bad.push(`solid ${i} (${s.kind}) reaches r ${reach.toFixed(2)}`);
    });
    expect(bad).toEqual([]);
  });

  it('no solid on or near a ramp (>= 1.8 m from the ramp rectangle to the solid surface)', () => {
    const bad: string[] = [];
    O.solids.forEach((s, i) => {
      const pts: [number, number][] =
        s.shape === 'circle' ? [[s.x, s.z]] : s.shape === 'segment' ? [[s.ax, s.az], [s.bx, s.bz], [(s.ax + s.bx) / 2, (s.az + s.bz) / 2]] : [[s.x, s.z]];
      const extent = s.shape === 'circle' ? s.radius : s.shape === 'segment' ? s.thickness / 2 : s.halfX * Math.SQRT2;
      for (const [x, z] of pts) if (minRampDist(x, z) - extent < 1.8) bad.push(`solid ${i} (${s.kind}) ${(minRampDist(x, z) - extent).toFixed(2)}`);
    });
    expect(bad).toEqual([]);
  });

  it('spawn seats are clear of every solid (>= 3.5 m surface to point) and of the ramps (>= 3 m)', () => {
    const bad: string[] = [];
    O.spawns.forEach((sp, si) => {
      O.solids.forEach((s, i) => {
        if (surfaceDist(s, sp.x, sp.z) < 3.5) bad.push(`seat ${si} - solid ${i} (${s.kind}) ${surfaceDist(s, sp.x, sp.z).toFixed(2)}`);
      });
      if (minRampDist(sp.x, sp.z) < 3) bad.push(`seat ${si} - ramp ${minRampDist(sp.x, sp.z).toFixed(2)}`);
    });
    expect(bad).toEqual([]);
  });

  it('pads are clear of every solid (>= 2.5 m surface to centre)', () => {
    const bad: string[] = [];
    for (const p of O.pickupPads) O.solids.forEach((s, i) => { if (surfaceDist(s, p.x, p.z) < 2.5) bad.push(`pad ${p.id} - solid ${i} (${s.kind}) ${surfaceDist(s, p.x, p.z).toFixed(2)}`); });
    expect(bad).toEqual([]);
  });

  it('solids do not overlap one another (crates within a pile excepted); gaps >= 2.4 m between cover pieces', () => {
    const bad: string[] = [];
    const cover = [...blockers, ...arches];
    for (let i = 0; i < cover.length; i++) {
      for (let k = i + 1; k < cover.length; k++) {
        const a = cover[i];
        const b = cover[k];
        // distance between the two bodies' surfaces, sampled on b's axis points
        const sample = (o: typeof a): [number, number][] =>
          o.shape === 'circle' ? [[o.x, o.z]] : [[o.ax, o.az], [(o.ax + o.bx) / 2, (o.az + o.bz) / 2], [o.bx, o.bz]];
        let gap = Infinity;
        for (const [x, z] of sample(b)) gap = Math.min(gap, surfaceDist(a, x, z) - (b.shape === 'circle' ? b.radius : b.thickness / 2));
        for (const [x, z] of sample(a)) gap = Math.min(gap, surfaceDist(b, x, z) - (a.shape === 'circle' ? a.radius : a.thickness / 2));
        if (gap < 2.4) bad.push(`${a.kind}@${a.shape === 'circle' ? a.x + ',' + a.z : a.ax + ',' + a.az} - ${b.kind}@${b.shape === 'circle' ? b.x + ',' + b.z : b.ax + ',' + b.az} gap ${gap.toFixed(2)}`);
      }
    }
    O.crates.forEach((c, ci) => {
      for (const s of cover) if (surfaceDist(s, c.x, c.z) - 0.5 < 1.8) bad.push(`crate ${ci} - ${s.kind} ${(surfaceDist(s, c.x, c.z) - 0.5).toFixed(2)}`);
    });
    // piles do not overlap each other
    for (let i = 0; i < O.crates.length; i++) {
      for (let k = i + 1; k < O.crates.length; k++) {
        const a = O.crates[i];
        const b = O.crates[k];
        if (Math.floor(i / 3) === Math.floor(k / 3)) continue;
        const sep = Math.max(Math.abs(a.x - b.x) - 1, Math.abs(a.z - b.z) - 1);
        if (sep < 2.4) bad.push(`crate ${i} - crate ${k} ${sep.toFixed(2)}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('ocean: reachability using ONLY the ramps (walk graph, 0.5 m grid, fighter radius 1.2, step rule 0.6 m)', () => {
  const ws = walkSpace(O, FIGHTER_R, 0.5);

  it('every spawn seat is walkable', () => {
    for (const s of O.spawns) expect(ws.free[ws.cell(s.x, s.z)]).toBe(1);
  });

  it('from EVERY spawn: every other spawn, every pad, every crate pile and the plateau centre are reachable', () => {
    const missing: string[] = [];
    const lens: number[] = [];
    O.spawns.forEach((sp, si) => {
      const dist = ws.distFrom(sp.x, sp.z);
      const reach = (x: number, z: number): number => {
        const c = ws.cell(x, z);
        const i0 = Math.floor(c / ws.n);
        const j0 = c % ws.n;
        let best = Infinity;
        for (let di = -2; di <= 2; di++) for (let dj = -2; dj <= 2; dj++) best = Math.min(best, dist[(i0 + di) * ws.n + (j0 + dj)] ?? Infinity);
        return best;
      };
      for (const o of O.spawns) if (!Number.isFinite(reach(o.x, o.z))) missing.push(`spawn ${si} -> spawn at ${o.x},${o.z}`);
      for (const p of O.pickupPads) {
        const d = reach(p.x, p.z);
        if (!Number.isFinite(d)) missing.push(`spawn ${si} -> pad ${p.id}`);
        if (p.id === 0) lens.push(d);
      }
      // a body can stand 1.7 m off at least one side of every crate
      for (let c = 0; c < O.crates.length; c += 3) {
        const cr = O.crates[c];
        const sides: [number, number][] = [
          [cr.x + 2.3, cr.z + 0.5],
          [cr.x - 1.7, cr.z + 0.5],
          [cr.x + 0.5, cr.z + 2.3],
          [cr.x + 0.5, cr.z - 1.7],
        ];
        if (!sides.some(([x, z]) => Number.isFinite(reach(x, z)))) missing.push(`spawn ${si} -> crate pile ${c / 3}`);
      }
    });
    expect(missing).toEqual([]);
    // routes are not absurdly long: the plateau pad is 28 - 45 m of walking from any seat (it takes the ramps)
    expect(Math.max(...lens)).toBeLessThanOrEqual(45); // measured 30.8 - 34.2 m
    expect(Math.min(...lens)).toBeGreaterThanOrEqual(28);
  });

  it('the walkable area is one region: no walkable pocket is cut off from spawn 0', () => {
    const dist = ws.distFrom(O.spawns[0].x, O.spawns[0].z);
    let free = 0;
    let reached = 0;
    for (let c = 0; c < ws.free.length; c++) {
      if (!ws.free[c]) continue;
      free++;
      if (Number.isFinite(dist[c])) reached++;
    }
    expect(reached / free).toBeGreaterThanOrEqual(0.99);
  });

  it('cliffs really block: without the ramps the levels would be separate (the walk graph needs every ramp family)', () => {
    // removing all ramps leaves three disconnected levels (the plateau and terrace cannot be reached from the seabed)
    const flat = { ...O, heightfield: hf.filter((p) => p.kind !== 'ramp') };
    const noRamps = walkSpace(flat, FIGHTER_R, 0.5);
    const dist = noRamps.distFrom(O.spawns[0].x, O.spawns[0].z);
    const plateauCell = noRamps.cell(0, 0);
    expect(Number.isFinite(dist[plateauCell])).toBe(false);
    const terraceCell = noRamps.cell(0, 12);
    expect(Number.isFinite(dist[terraceCell])).toBe(false);
    // ... and without the inner ramps the plateau is cut off while the terrace stays reachable
    const noInner = { ...O, heightfield: hf.filter((p) => p.kind !== 'ramp' || (p.h0 === 0 && p.h1 === 1.5)) };
    const wi = walkSpace(noInner, FIGHTER_R, 0.5);
    const d2 = wi.distFrom(O.spawns[0].x, O.spawns[0].z);
    expect(Number.isFinite(d2[wi.cell(0, 0)])).toBe(false);
    expect(Number.isFinite(d2[wi.cell(0, 12)])).toBe(true);
  });

  it('each ramp is wide open: its whole centre line is walkable for the largest body', () => {
    for (const r of ramps) {
      const a = (r.dirDeg * Math.PI) / 180;
      for (let t = -r.length / 2; t <= r.length / 2 + 1e-9; t += 0.5) {
        const x = r.x + Math.cos(a) * t;
        const z = r.z + Math.sin(a) * t;
        expect(ws.free[ws.cell(x, z)]).toBe(1);
      }
    }
  });

  it('a clear walkway on every level: >= 60% of each level\'s floor is walkable', () => {
    const frac = (lvl: number): number => {
      let tot = 0;
      let ok = 0;
      for (let c = 0; c < ws.free.length; c++) {
        const p = ws.pos(c);
        if (Math.hypot(p.x, p.z) > O.wallRadius - FIGHTER_R) continue;
        if (arenaGroundHeight(O, p.x, p.z) !== lvl) continue;
        tot++;
        if (ws.free[c]) ok++;
      }
      return ok / tot;
    };
    expect(frac(0)).toBeGreaterThanOrEqual(0.6);
    expect(frac(1.5)).toBeGreaterThanOrEqual(0.6);
    expect(frac(3)).toBeGreaterThanOrEqual(0.6);
  });
});

describe('ocean: step rule helpers', () => {
  it('arenaCliffDistance: distance to the next level up (the step limit is feet + 0.6)', () => {
    // standing on the seabed 1 m from the terrace edge (r = 19) the cliff is 1 m away; on the terrace the plateau edge (r = 8) is 7 m away
    expect(arenaCliffDistance(O, 0, -20)).toBeCloseTo(1, 1);
    expect(arenaCliffDistance(O, -15, 0)).toBeCloseTo(7, 1);
    expect(arenaCliffDistance(O, 0, 2)).toBe(Infinity); // on the plateau nothing is higher
  });
  it('ARENA_STEP_UP is the dais height', () => {
    expect(ARENA_STEP_UP).toBe(0.6);
    expect(ARENAS.colosseum.dais?.height).toBe(ARENA_STEP_UP);
  });
  it('helper segDist stays importable (sanity)', () => {
    expect(segDist(0, 0, -1, 0, 1, 0)).toBe(0);
  });
});
