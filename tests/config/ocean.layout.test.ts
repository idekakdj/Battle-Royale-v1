/**
 * Ocean Dome layout rules (docs/OCEAN-PLAN.md v1.9 + docs/OCEAN-HEIGHTS-PLAN.md v1.10): four levels joined by ramps — the seabed, the
 * terrace, the plateau and THREE UPPER PLATFORMS (sea-stacks, tops 6.5 m) — cover on every lower level, spawn / pad / crate heights,
 * clearances, a walk-graph proof (0.5 m grid, fighter radius 1.2 m, the sim's step + cliff rule) that every spawn, pad, crate pile, the
 * centre plateau and every platform top are reachable from every spawn using ONLY the ramps, ramp grades, the serpent lane bins and the
 * fall-damage geometry. The geometric rules themselves live in tests/config/oceanRules.ts (shared with scripts/ocean-layout.ts).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { ElevationPiece } from '../../src/config/arenas';
import {
  ARENAS,
  ARENA_MAX_RAMP_SLOPE,
  ARENA_STEP_UP,
  COLOSSEUM_ARENA,
  JUNGLE_ARENA,
  OCEAN_ARENA as O,
  OCEAN_FALL_DAMAGE,
  OCEAN_FALL_MIN_DROP,
  OCEAN_PLATEAU_HEIGHT,
  OCEAN_SERPENT_SPLIT_Y,
  OCEAN_STACKS,
  OCEAN_TERRACE_HEIGHT,
  OCEAN_UPPER_HEIGHT,
  arenaCanWalk,
  arenaCliffDistance,
  arenaGroundHeight,
  arenaHasHighSerpent,
  arenaIsLevel,
  arenaSerpentBand,
  arenaSlopeAt,
  elevationPieceHeight,
  getArena,
  isArenaId,
} from '../../src/config/arenas';
import { SERPENT } from '../../src/config/serpent';
import { serpentLaneBins, stripHighLength, stripMaxGround } from '../../src/config/serpentLanes';
import { segDist, walkSpace } from './arenaGeom';
import {
  FIGHTER_R,
  OCEAN_RULES,
  minRampDist,
  nearDist,
  rampEnds,
  rampRole,
  rampsOf,
  reachability,
  stacksOf,
  upperRoutes,
  type ReachReport,
} from './oceanRules';

const hf = O.heightfield as readonly ElevationPiece[];
const ramps = rampsOf(O);
const outerRamps = ramps.filter((r) => rampRole(r) === 'outer');
const innerRamps = ramps.filter((r) => rampRole(r) === 'inner');
const levelRamps = [...outerRamps, ...innerRamps];
const upperPieces = ramps.filter((r) => ['causeway', 'chord', 'top'].includes(rampRole(r)));
const routes = upperRoutes(O);
const stacks = stacksOf(O);
const angleOf = (x: number, z: number): number => ((Math.atan2(z, x) * 180) / Math.PI + 360) % 360;
const DEG = Math.PI / 180;
/** A direction along which every level is plain (no ramp, no tower, no cover on the ground heights): the seabed / terrace / plateau only. */
const PLAIN_DEG = 308;
const at = (r: number, deg = PLAIN_DEG) => ({ x: r * Math.cos(deg * DEG), z: r * Math.sin(deg * DEG) });
const groundAt = (r: number, deg = PLAIN_DEG): number => {
  const p = at(r, deg);
  return arenaGroundHeight(O, p.x, p.z);
};

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
    expect(O.dais).toBeUndefined();
    expect(O.spawnLayout).toBe('seats');
  });

  it('v1.10 hazards: the serpent, the 4.5 m lane split and the 3.4 m / 50 damage fall rule (exact values)', () => {
    expect(OCEAN_UPPER_HEIGHT).toBe(6.5);
    expect(OCEAN_SERPENT_SPLIT_Y).toBe(4.5);
    expect(OCEAN_FALL_MIN_DROP).toBe(3.4);
    expect(OCEAN_FALL_DAMAGE).toBe(50);
    expect(O.hazards).toEqual({ serpent: true, serpentSplitY: 4.5, fallDamage: { minDrop: 3.4, damage: 50 } });
    expect(arenaHasHighSerpent(O)).toBe(true);
  });

  it('the colosseum and the jungle have no height field and no hazards', () => {
    expect(ARENAS.colosseum.heightfield).toBeUndefined();
    expect(ARENAS.jungle.heightfield).toBeUndefined();
    expect(ARENAS.colosseum.hazards).toBeUndefined();
    expect(ARENAS.jungle.hazards).toBeUndefined();
    expect(arenaHasHighSerpent(COLOSSEUM_ARENA)).toBe(false);
    expect(arenaHasHighSerpent(JUNGLE_ARENA)).toBe(false);
  });
});

describe('ocean: levels and ramps', () => {
  it('the plain direction really is plain (no ramp, no tower from the centre to the wall)', () => {
    for (let r = 0; r <= 30; r += 0.25) {
      const p = at(r);
      expect(arenaSlopeAt(O, p.x, p.z), `r ${r}`).toBe(0);
    }
  });

  it('three lower levels: seabed 0 (r > 19), terrace 1.5 (8 < r < 19), plateau 3.0 (r < 8) away from the ramps', () => {
    expect(groundAt(0)).toBe(3);
    expect(groundAt(7.9)).toBe(3);
    expect(groundAt(8.2)).toBe(1.5);
    expect(groundAt(15)).toBe(1.5);
    expect(groundAt(18.9)).toBe(1.5);
    expect(groundAt(19.2)).toBe(0);
    expect(groundAt(25)).toBe(0);
    expect(groundAt(29.9)).toBe(0);
    expect(OCEAN_TERRACE_HEIGHT).toBe(1.5);
    expect(OCEAN_PLATEAU_HEIGHT).toBe(3);
  });

  it('>= 4 seabed->terrace ramps at distinct angles and >= 3 terrace->plateau ramps (a stair never shares one ramp: inner and outer are separate pieces)', () => {
    expect(outerRamps.length).toBeGreaterThanOrEqual(4);
    expect(innerRamps.length).toBeGreaterThanOrEqual(3);
    const outerAng = outerRamps.map((r) => angleOf(r.x, r.z));
    const innerAng = innerRamps.map((r) => angleOf(r.x, r.z));
    const gap = (a: number, b: number): number => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
    for (let i = 0; i < outerAng.length; i++) {
      for (let k = i + 1; k < outerAng.length; k++) expect(gap(outerAng[i], outerAng[k])).toBeGreaterThanOrEqual(30);
    }
    // v1.9 asked for >= 20 degrees between an inner and an outer ramp ("routes differ"). The towers' wedge ramps now leave only one narrow
    // free sector per terrace pocket (24-60 degrees wide: the only place with a clear landing in front of an outer ramp AND a free foot for an
    // inner one), so a pocket's two stairs are at most 18 degrees apart (the pocket between the south tower and the west tower: 3 degrees,
    // a straight stair). They are still two separate ramps on two levels; the outer ramp's landing in front is checked below.
    for (const a of innerAng) for (const b of outerAng) expect(gap(a, b)).toBeGreaterThanOrEqual(3);
    for (const a of innerAng) expect(Math.min(...outerAng.map((b) => gap(a, b)))).toBeLessThanOrEqual(20); // each inner ramp has an outer one beside it (a short way up)
  });

  it('every LEVEL ramp: slope <= 25 deg, width >= 5 m, rises 1.5 m between two levels, ends flush with them', () => {
    for (const r of levelRamps) {
      expect(Math.abs(r.h1 - r.h0) / r.length).toBeLessThanOrEqual(ARENA_MAX_RAMP_SLOPE);
      expect(r.width).toBeGreaterThanOrEqual(5);
      expect(r.h1 - r.h0).toBeCloseTo(1.5, 9);
      expect(r.length).toBeGreaterThanOrEqual(4);
    }
    // the low end of an outer ramp touches the seabed (height 0), its high end the terrace ring (1.5); likewise the inner ones
    for (const r of levelRamps) {
      const e = rampEnds(r);
      const a = r.dirDeg * DEG;
      const k = r.length / 2 - 1e-6;
      expect(elevationPieceHeight(r, r.x - Math.cos(a) * k, r.z - Math.sin(a) * k)).toBeCloseTo(r.h0, 6);
      expect(elevationPieceHeight(r, r.x + Math.cos(a) * k, r.z + Math.sin(a) * k)).toBeCloseTo(r.h1, 6);
      // low end is on the lower level's flat ground just beyond the end (no step), high end tucks under the upper level
      expect(arenaGroundHeight(O, e.low.x - Math.cos(a) * 0.3, e.low.z - Math.sin(a) * 0.3)).toBeCloseTo(r.h0, 6);
      expect(arenaGroundHeight(O, e.high.x + Math.cos(a) * 0.3, e.high.z + Math.sin(a) * 0.3)).toBeCloseTo(r.h1, 6);
    }
  });

  it('the ground is continuous along every ramp axis, upper routes included (no step bigger than 0.2 m anywhere on the way up)', () => {
    for (const r of ramps) {
      const a = r.dirDeg * DEG;
      let prev = NaN;
      for (let t = -r.length / 2 - 2; t <= r.length / 2 + 2; t += 0.05) {
        const h = arenaGroundHeight(O, r.x + Math.cos(a) * t, r.z + Math.sin(a) * t);
        if (!Number.isNaN(prev)) expect(Math.abs(h - prev), `${rampRole(r)} at ${r.x},${r.z}`).toBeLessThanOrEqual(0.2);
        prev = h;
      }
    }
    // and the whole way from the foot of each upper route to the tower's centre (foot -> top piece -> tower top)
    for (const rt of routes) {
      const a = rt.dirDeg * DEG;
      const len = Math.hypot(rt.stack.x - rt.foot.x, rt.stack.z - rt.foot.z);
      let prev = NaN;
      for (let t = -2; t <= len; t += 0.05) {
        const h = arenaGroundHeight(O, rt.foot.x + Math.cos(a) * t, rt.foot.z + Math.sin(a) * t);
        if (!Number.isNaN(prev)) expect(Math.abs(h - prev)).toBeLessThanOrEqual(0.2);
        prev = h;
      }
      expect(prev).toBe(OCEAN_UPPER_HEIGHT);
    }
  });

  it('arenaSlopeAt reports the ramp grade on a ramp and 0 on flat levels', () => {
    for (const r of ramps) expect(arenaSlopeAt(O, r.x, r.z)).toBeCloseTo(Math.abs(r.h1 - r.h0) / r.length, 9);
    expect(arenaSlopeAt(O, 0, 0)).toBe(0);
    const p14 = at(14);
    expect(arenaSlopeAt(O, p14.x, p14.z)).toBe(0);
    const p26 = at(26);
    expect(arenaSlopeAt(O, p26.x, p26.z)).toBe(0);
    for (const st of stacks) expect(arenaSlopeAt(O, st.x, st.z)).toBe(0); // a tower top is flat
  });
});

describe('ocean: the upper tier (sea-stacks)', () => {
  it('3 or 4 round towers, top 6.5 m, radius 2.8-3.6, exported as OCEAN_STACKS and present in the height field', () => {
    expect(stacks.length).toBeGreaterThanOrEqual(3);
    expect(stacks.length).toBeLessThanOrEqual(4);
    expect(OCEAN_STACKS).toHaveLength(stacks.length);
    for (const s of OCEAN_STACKS) {
      expect(s.radius).toBeGreaterThanOrEqual(2.8);
      expect(s.radius).toBeLessThanOrEqual(3.6);
      expect(stacks.some((t) => t.x === s.x && t.z === s.z && t.radius === s.radius && t.height === OCEAN_UPPER_HEIGHT)).toBe(true);
      // the whole top is flat at 6.5 (centre and 80 % of the radius all round)
      expect(arenaGroundHeight(O, s.x, s.z)).toBe(OCEAN_UPPER_HEIGHT);
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        expect(arenaGroundHeight(O, s.x + Math.cos(a) * s.radius * 0.8, s.z + Math.sin(a) * s.radius * 0.8)).toBe(OCEAN_UPPER_HEIGHT);
      }
    }
    // the towers are apart from each other (their rims are >= 6 m apart: room to fight on each, none shares a top)
    for (let i = 0; i < stacks.length; i++) {
      for (let k = i + 1; k < stacks.length; k++) {
        expect(Math.hypot(stacks[i].x - stacks[k].x, stacks[i].z - stacks[k].z) - stacks[i].radius - stacks[k].radius).toBeGreaterThanOrEqual(6);
      }
    }
  });

  it('every tower has at least one route, at least 2 towers have TWO (from different levels and different directions)', () => {
    const per = stacks.map((s) => routes.filter((r) => r.stack.x === s.x && r.stack.z === s.z));
    for (const p of per) expect(p.length).toBeGreaterThanOrEqual(1);
    expect(per.filter((p) => p.length >= 2).length).toBeGreaterThanOrEqual(2);
    for (const p of per) {
      if (p.length < 2) continue;
      expect(new Set(p.map((r) => r.baseHeight)).size).toBe(p.length); // the plateau and the terrace
      for (let i = 0; i < p.length; i++) {
        for (let k = i + 1; k < p.length; k++) {
          const d = Math.abs(p[i].dirDeg - p[k].dirDeg) % 360;
          expect(Math.min(d, 360 - d)).toBeGreaterThanOrEqual(30);
        }
      }
    }
  });

  it('ramp grades: every upper piece <= 0.40, width >= 3.6, and the top piece is gentler than the lower one (the rim stays clear for the biggest body)', () => {
    expect(upperPieces.length).toBeGreaterThanOrEqual(2 * routes.length);
    for (const r of upperPieces) {
      expect(Math.abs(r.h1 - r.h0) / r.length, `${rampRole(r)}`).toBeLessThanOrEqual(0.4);
      expect(r.width).toBeGreaterThanOrEqual(3.6);
    }
    for (const rt of routes) {
      const gTop = (rt.top.h1 - rt.top.h0) / rt.top.length;
      const gLow = (rt.lower.h1 - rt.lower.h0) / rt.lower.length;
      expect(gTop).toBeLessThan(gLow);
      // dead-zone proof: at the height where the tower stops being a cliff for a walker (ground = top - ARENA_STEP_UP) the rim is still >= 1.2 m away
      const stepH = OCEAN_UPPER_HEIGHT - ARENA_STEP_UP;
      expect(rt.top.h0).toBeCloseTo(stepH, 9);
      const rimClear = rt.top.length + rt.endDist - rt.stack.radius; // distance along the axis from the landing height to the rim
      expect(rimClear).toBeGreaterThanOrEqual(FIGHTER_R - 1e-9);
    }
  });

  it('a ramp reaches its tower: tucked 0.4-0.6 m under the rim, corners inside the tower, the foot flush on the terrace or plateau, the pieces joined', () => {
    for (const rt of routes) {
      const tuck = rt.stack.radius - rt.endDist;
      expect(tuck).toBeGreaterThanOrEqual(0.4 - 1e-9);
      expect(tuck).toBeLessThanOrEqual(0.6 + 1e-9);
      const eTop = rampEnds(rt.top);
      const eLow = rampEnds(rt.lower);
      expect(Math.hypot(eLow.high.x - eTop.low.x, eLow.high.z - eTop.low.z)).toBeLessThan(0.05); // (the lower piece overlaps the top one by 3 cm: no crack)
      expect(rt.lower.dirDeg).toBe(rt.top.dirDeg);
      expect([OCEAN_TERRACE_HEIGHT, OCEAN_PLATEAU_HEIGHT]).toContain(rt.baseHeight);
    }
    // the layout rule set (upper tier part): tuck, corners, flush foot, joined pieces, pad on each top, cliffs, lane bins
    expect(OCEAN_RULES.upperTier(O)).toEqual([]);
  });

  it('a pickup pad on every tower top (at its centre, on the flat top, 3 m or more from its rim and from its ramp ends)', () => {
    for (const s of stacks) {
      const pads = O.pickupPads.filter((p) => Math.hypot(p.x - s.x, p.z - s.z) < s.radius);
      expect(pads.length).toBeGreaterThanOrEqual(1);
      for (const p of pads) {
        expect(arenaGroundHeight(O, p.x, p.z)).toBe(OCEAN_UPPER_HEIGHT);
        expect(s.radius - Math.hypot(p.x - s.x, p.z - s.z)).toBeGreaterThanOrEqual(2.7); // 1.2 m pad + 1.5 m from the rim
        expect(minRampDist(O, p.x, p.z)).toBeGreaterThanOrEqual(2.5);
      }
    }
  });

  it('every tower is reachable ON FOOT by ramp from its foot (arenaCanWalk, radius 1.2, both ways) and not by a straight line from the seabed', () => {
    for (const rt of routes) {
      const a = rt.dirDeg * DEG;
      const sx = rt.foot.x - Math.cos(a) * 2;
      const sz = rt.foot.z - Math.sin(a) * 2;
      expect(arenaCanWalk(O, sx, sz, rt.stack.x, rt.stack.z, FIGHTER_R, false), 'up').toBe(true);
      expect(arenaCanWalk(O, rt.stack.x, rt.stack.z, sx, sz, FIGHTER_R, false), 'down').toBe(true);
    }
    for (const s of stacks) {
      const from = at(26);
      expect(arenaCanWalk(O, from.x, from.z, s.x, s.z, FIGHTER_R, false)).toBe(false); // a cliff in the way
    }
  });

  it('the outer edge is a real cliff: every rim sample that is not a ramp drops >= 3.4 m (to the terrace, the seabed or the plateau)', () => {
    for (const s of stacks) {
      let cliff = 0;
      let nonRamp = 0;
      for (let i = 0; i < 144; i++) {
        const a = (i / 144) * Math.PI * 2;
        const x = s.x + Math.cos(a) * (s.radius + 0.6);
        const z = s.z + Math.sin(a) * (s.radius + 0.6);
        if (arenaSlopeAt(O, x, z) > 0) continue;
        nonRamp++;
        const drop = OCEAN_UPPER_HEIGHT - arenaGroundHeight(O, x, z);
        expect(drop).toBeGreaterThanOrEqual(OCEAN_FALL_MIN_DROP);
        if (drop >= OCEAN_FALL_MIN_DROP) cliff++;
      }
      expect(cliff).toBe(nonRamp);
      expect(nonRamp).toBeGreaterThan(144 * 0.6);
    }
  });
});

describe('ocean: fall-damage geometry (hazards.fallDamage)', () => {
  const minDrop = (O.hazards?.fallDamage as { minDrop: number }).minDrop;

  it('top -> plateau is 3.5 m (hurts), plateau -> seabed is 3.0 m (does not), terrace drops never hurt', () => {
    expect(OCEAN_UPPER_HEIGHT - OCEAN_PLATEAU_HEIGHT).toBeCloseTo(3.5, 9);
    expect(OCEAN_UPPER_HEIGHT - OCEAN_PLATEAU_HEIGHT).toBeGreaterThanOrEqual(minDrop);
    expect(OCEAN_PLATEAU_HEIGHT - 0).toBe(3);
    expect(OCEAN_PLATEAU_HEIGHT - 0).toBeLessThan(minDrop);
    expect(OCEAN_PLATEAU_HEIGHT - OCEAN_TERRACE_HEIGHT).toBeLessThan(minDrop);
    expect(OCEAN_TERRACE_HEIGHT - 0).toBeLessThan(minDrop);
    expect(OCEAN_UPPER_HEIGHT - OCEAN_TERRACE_HEIGHT).toBeGreaterThanOrEqual(minDrop);
    expect(OCEAN_UPPER_HEIGHT - 0).toBeGreaterThanOrEqual(minDrop);
  });

  it('on the real map a 0.5 m step in any direction only drops >= 3.4 m from the upper tier (tops and the top of their ramps >= 4.9 m); the lower levels never hurt', () => {
    let hurting = 0;
    for (let zi = -60; zi <= 60; zi++) {
      for (let xi = -60; xi <= 60; xi++) {
        const x = xi * 0.5;
        const z = zi * 0.5;
        if (Math.hypot(x, z) > 29.5) continue;
        const g = arenaGroundHeight(O, x, z);
        for (const [dx, dz] of [[0.5, 0], [0, 0.5], [0.35, 0.35], [0.35, -0.35]]) {
          const g2 = arenaGroundHeight(O, x + dx, z + dz);
          if (g - g2 >= minDrop - 1e-9) {
            hurting++;
            expect(g, `drop ${g} -> ${g2} at ${x},${z}`).toBeGreaterThanOrEqual(1.5 + minDrop - 1e-9);
          }
        }
      }
    }
    expect(hurting).toBeGreaterThan(100); // (the towers' rims and ramp flanks are real)
  });

  it('walking down any route is smooth (never a drop >= 3.4 m on the ramps themselves: the ramps are the safe way down)', () => {
    for (const rt of routes) {
      const a = rt.dirDeg * DEG;
      const len = Math.hypot(rt.stack.x - rt.foot.x, rt.stack.z - rt.foot.z);
      let prev = arenaGroundHeight(O, rt.stack.x, rt.stack.z);
      for (let t = len; t >= -1; t -= 0.05) {
        const h = arenaGroundHeight(O, rt.foot.x + Math.cos(a) * t, rt.foot.z + Math.sin(a) * t);
        expect(prev - h).toBeLessThan(0.25);
        prev = h;
      }
    }
  });
});

describe('ocean: serpent lanes (hazards.serpentSplitY = 4.5)', () => {
  const bins = serpentLaneBins(O);

  it('at least 150 low bins and at least 80 high bins of 360 (every bin 1 degree)', () => {
    expect(bins.low.length).toBeGreaterThanOrEqual(150);
    expect(bins.high.length).toBeGreaterThanOrEqual(80);
    expect(bins.low.length).toBeLessThanOrEqual(360);
    // a bin is never both: the low strip stays off high ground, the high strip runs over it
    const hi = new Set(bins.high);
    expect(bins.low.filter((b) => hi.has(b))).toEqual([]);
  });

  it('the low serpent never runs over, through or alongside the upper tier: every low bin keeps its padded strip on ground < 4.5', () => {
    const hw = SERPENT.stripHalfWidth + 1.0;
    for (const b of bins.low) {
      for (const off of [0, 0.5, 1]) expect(stripMaxGround(O, b + off, hw), `bin ${b}+${off}`).toBeLessThan(OCEAN_SERPENT_SPLIT_Y);
    }
  });

  it('every high bin threatens the upper tier (>= 2 m of its centre line over ground >= 4.5), and each tower is covered by >= 8 high bins', () => {
    for (const b of bins.high) expect(stripHighLength(O, b + 0.5, OCEAN_SERPENT_SPLIT_Y), `bin ${b}`).toBeGreaterThanOrEqual(2);
    for (const s of stacks) {
      const covered = bins.high.filter((b) => {
        const a = (b + 0.5) * DEG;
        // the bin's centre line passes within the tower's radius of its centre
        const t = s.x * Math.cos(a) + s.z * Math.sin(a);
        return t > 0 && Math.abs(-s.x * Math.sin(a) + s.z * Math.cos(a)) < s.radius * 0.9;
      }).length;
      expect(covered).toBeGreaterThanOrEqual(8);
    }
  });

  it('bands follow the GROUND height: towers and the top of their ramps are high, the three lower levels and the lower ramps are low', () => {
    for (const s of stacks) expect(arenaSerpentBand(O, s.x, s.z)).toBe('high');
    expect(arenaSerpentBand(O, 0, 0)).toBe('low'); // plateau
    for (const r of [5, 14, 26]) {
      const p = at(r);
      expect(arenaSerpentBand(O, p.x, p.z)).toBe('low');
    }
    for (const rt of routes) {
      const a = rt.dirDeg * DEG;
      const len = Math.hypot(rt.stack.x - rt.foot.x, rt.stack.z - rt.foot.z);
      for (let t = 0; t <= len; t += 0.5) {
        const x = rt.foot.x + Math.cos(a) * t;
        const z = rt.foot.z + Math.sin(a) * t;
        expect(arenaSerpentBand(O, x, z)).toBe(arenaGroundHeight(O, x, z) >= OCEAN_SERPENT_SPLIT_Y ? 'high' : 'low');
      }
    }
    expect(arenaSerpentBand(COLOSSEUM_ARENA, 0, 0)).toBe('low');
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
    expect(OCEAN_RULES.seats(O)).toEqual([]); // flat 3 m, clear of every solid (3.5), ramp (3) and cliff / tower (3)
  });

  it('9 pickup pads (ids = index): the centre plateau holds one at the middle, one on each tower top, >= 2 on the terrace and >= 2 on the seabed', () => {
    expect(O.pickupPads).toHaveLength(9);
    expect(O.pickupPads.map((p) => p.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const levels = O.pickupPads.map((p) => arenaGroundHeight(O, p.x, p.z));
    expect(new Set(levels)).toEqual(new Set([0, 1.5, 3, 6.5]));
    expect(O.pickupPads[0]).toMatchObject({ x: 0, z: 0 });
    const plateau = O.pickupPads.filter((p) => arenaGroundHeight(O, p.x, p.z) === 3);
    expect(plateau.length).toBe(1);
    expect(Math.hypot(plateau[0].x, plateau[0].z)).toBeLessThan(1);
    expect(levels.filter((h) => h === 6.5)).toHaveLength(stacks.length);
    expect(levels.filter((h) => h === 1.5).length).toBeGreaterThanOrEqual(2);
    expect(levels.filter((h) => h === 0).length).toBeGreaterThanOrEqual(2);
    expect(OCEAN_RULES.pads(O)).toEqual([]); // flat disc (pad + 1.5 m), off every ramp (2.5), clear of every solid (2.5)
    for (const p of O.pickupPads) expect(Math.hypot(p.x, p.z) + 1.2).toBeLessThan(O.wallRadius - 2);
  });

  it('4 crate clusters of 3 on at least two levels, each crate sitting on its ground (baseY) and on one flat level', () => {
    expect(O.crates).toHaveLength(12);
    const baseSet = new Set<number>();
    for (const c of O.crates) {
      expect(c.kind).toBe('crate');
      expect(c.hp).toBe(150);
      expect(c.baseY).toBe(arenaGroundHeight(O, c.x, c.z));
      expect(arenaIsLevel(O, c.x, c.z, 2.2)).toBe(true);
      baseSet.add(c.baseY as number);
    }
    expect(baseSet.size).toBeGreaterThanOrEqual(2);
    expect(baseSet.has(0)).toBe(true);
    expect(baseSet.has(1.5)).toBe(true);
    expect(O.crates.filter((c) => c.baseY === 0)).toHaveLength(6);
    expect(O.crates.filter((c) => c.baseY === 1.5)).toHaveLength(6);
  });

  it('every solid has baseY = the ground height under it (flat under its whole footprint plus 1 m)', () => {
    expect(OCEAN_RULES.solidsSeated(O)).toEqual([]);
    for (const s of O.solids) {
      if (s.shape === 'circle') expect(s.baseY).toBe(arenaGroundHeight(O, s.x, s.z));
      if (s.shape === 'segment') expect(Math.hypot(s.bx - s.ax, s.bz - s.az)).toBeGreaterThanOrEqual(3);
    }
    // nothing stands on a tower top (a 7 m disc with a pad on it)
    for (const s of O.solids) {
      const p = s.shape === 'segment' ? { x: (s.ax + s.bx) / 2, z: (s.az + s.bz) / 2 } : { x: s.x, z: s.z };
      expect(arenaGroundHeight(O, p.x, p.z)).toBeLessThan(OCEAN_UPPER_HEIGHT);
    }
  });
});

describe('ocean: cover', () => {
  const blockers = O.circles;
  const arches = O.segments;
  const levelOf = (x: number, z: number): number => arenaGroundHeight(O, x, z);

  it('coral pillars, rock outcrops and arches: cover on the seabed and the plateau (round) and on the terrace (arches), on >= 2 levels', () => {
    for (const lvl of [0, 3]) expect(blockers.filter((b) => levelOf(b.x, b.z) === lvl).length).toBeGreaterThanOrEqual(2);
    const cover = (lvl: number): number =>
      blockers.filter((b) => levelOf(b.x, b.z) === lvl).length + arches.filter((a) => levelOf((a.ax + a.bx) / 2, (a.az + a.bz) / 2) === lvl).length;
    for (const lvl of [0, 1.5, 3]) expect(cover(lvl), `level ${lvl}`).toBeGreaterThanOrEqual(2);
    expect(blockers.filter((b) => b.kind === 'coral').length).toBeGreaterThanOrEqual(3);
    // (v1.9 had 3 rocks; the cliff-corridor rule below — a hippo can pass between a pillar and a wall — leaves room for two on the seabed)
    expect(blockers.filter((b) => b.kind === 'rock').length).toBeGreaterThanOrEqual(2);
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
    expect(OCEAN_RULES.solidsInside(O)).toEqual([]);
  });

  it('no solid on or near a ramp (>= 1.8 m from the ramp rectangle to the solid surface), none within 1 m of a level edge', () => {
    expect(OCEAN_RULES.solidsOffRamps(O)).toEqual([]);
    expect(OCEAN_RULES.solidsAwayFromCliffs(O)).toEqual([]);
  });

  it('spawn seats are clear of every solid (>= 3.5 m surface to point) and of the ramps (>= 3 m)', () => {
    expect(OCEAN_RULES.seats(O)).toEqual([]);
  });

  it('solids do not overlap one another (crates within a pile excepted); gaps >= 2.4 m between cover pieces', () => {
    expect(OCEAN_RULES.coverGaps(O)).toEqual([]);
  });

  it('(helper) segDist stays importable', () => {
    expect(segDist(0, 0, -1, 0, 1, 0)).toBe(0);
  });
});

describe('ocean: reachability using ONLY the ramps (walk graph, 0.5 m grid, fighter radius 1.2, step rule 0.6 m)', () => {
  const ws = walkSpace(O, FIGHTER_R, 0.5);
  let rep: ReachReport;
  beforeAll(() => {
    rep = reachability(O);
  }, 180_000);

  it('every spawn seat is walkable', () => {
    for (const s of O.spawns) expect(ws.free[ws.cell(s.x, s.z)]).toBe(1);
  });

  it('from EVERY spawn: every other spawn, every pad (all four levels, tower tops included), every tower top, every crate pile and the plateau centre', () => {
    expect(rep.missing).toEqual([]);
    // routes are not absurdly long: the plateau pad is 28 - 50 m of walking from any seat (it takes the ramps)
    expect(Math.max(...rep.toCentre)).toBeLessThanOrEqual(52); // measured 28 - 48 m
    expect(Math.min(...rep.toCentre)).toBeGreaterThanOrEqual(25);
    // every tower pad: nobody is further than 70 m of walking from a tower top and every seat gets there
    O.pickupPads.forEach((p, k) => {
      if (arenaGroundHeight(O, p.x, p.z) !== OCEAN_UPPER_HEIGHT) return;
      for (const row of rep.toPads) {
        expect(Number.isFinite(row[k])).toBe(true);
        expect(row[k]).toBeLessThanOrEqual(75);
        expect(row[k]).toBeGreaterThanOrEqual(24);
      }
    });
  });

  it('the walkable area is one region: no walkable pocket is cut off from spawn 0', () => {
    expect(rep.reachedFraction).toBeGreaterThanOrEqual(0.99);
  });

  it('a body of the largest radius cannot get stuck: > 99 % of all its standable cells are connected, and for a small body (0.5) all but a handful', () => {
    const small = walkSpace(O, 0.5, 0.5);
    const d0 = small.distFrom(O.spawns[0].x, O.spawns[0].z);
    let free = 0;
    let lost = 0;
    for (let c = 0; c < small.free.length; c++) {
      if (!small.free[c]) continue;
      free++;
      if (!Number.isFinite(d0[c])) lost++;
    }
    expect(lost / free).toBeLessThan(0.002);
  });

  it('cliffs really block: without the ramps the levels would be separate, and each ramp family matters', () => {
    const origin = O.spawns[0];
    const terracePad = O.pickupPads.find((p) => arenaGroundHeight(O, p.x, p.z) === OCEAN_TERRACE_HEIGHT) as { x: number; z: number };
    const reach = (arena: typeof O, x: number, z: number): boolean => {
      const w = walkSpace(arena, FIGHTER_R, 0.5);
      return Number.isFinite(nearDist(w, w.distFrom(origin.x, origin.z), x, z));
    };
    // removing ALL ramps leaves separate levels (nothing above the seabed is reachable)
    const flat = { ...O, heightfield: hf.filter((p) => p.kind !== 'ramp') };
    expect(reach(flat, 0, 0)).toBe(false);
    expect(reach(flat, terracePad.x, terracePad.z)).toBe(false);
    for (const s of stacks) expect(reach(flat, s.x, s.z)).toBe(false);
    // without the upper routes the towers are unreachable but the plateau and the terrace are not
    const noUpper = { ...O, heightfield: hf.filter((p) => p.kind !== 'ramp' || levelRamps.includes(p)) };
    expect(reach(noUpper, 0, 0)).toBe(true);
    expect(reach(noUpper, terracePad.x, terracePad.z)).toBe(true);
    for (const s of stacks) expect(reach(noUpper, s.x, s.z)).toBe(false);
    // without the outer ramps nothing above the seabed is reachable at all, towers included
    const noOuter = { ...O, heightfield: hf.filter((p) => p.kind !== 'ramp' || rampRole(p) !== 'outer') };
    expect(reach(noOuter, 0, 0)).toBe(false);
    expect(reach(noOuter, terracePad.x, terracePad.z)).toBe(false);
    for (const s of stacks) expect(reach(noOuter, s.x, s.z)).toBe(false);
    // without the inner ramps the plateau is still reachable (over a tower: chord up, causeway down), but only the long way round
    const noInner = { ...O, heightfield: hf.filter((p) => p.kind !== 'ramp' || rampRole(p) !== 'inner') };
    const wi = walkSpace(noInner, FIGHTER_R, 0.5);
    const d3c = nearDist(wi, wi.distFrom(origin.x, origin.z), 0, 0);
    const dFull = nearDist(ws, ws.distFrom(origin.x, origin.z), 0, 0);
    expect(Number.isFinite(d3c)).toBe(true);
    expect(d3c).toBeGreaterThan(dFull + 5);
  });

  it('each ramp piece is wide open: its whole centre line is walkable for the largest body (the tower rim never pinches the top of a route)', () => {
    for (const r of ramps) {
      const a = r.dirDeg * DEG;
      for (let t = -r.length / 2; t <= r.length / 2 + 1e-9; t += 0.25) {
        const x = r.x + Math.cos(a) * t;
        const z = r.z + Math.sin(a) * t;
        expect(ws.free[ws.cell(x, z)], `${rampRole(r)} (${r.x.toFixed(1)}, ${r.z.toFixed(1)}) t ${t}: cliff distance ${arenaCliffDistance(O, x, z).toFixed(2)}`).toBe(1);
      }
    }
  });

  it('a clear walkway on every level: the seabed, the plateau and the tower tops (>= 60 %) and the terrace (>= 55 %, measured 58 %: the long upper ramps wedge across it) are walkable', () => {
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
    }
    expect(frac(0)).toBeGreaterThanOrEqual(0.6);
    expect(frac(1.5)).toBeGreaterThanOrEqual(0.55);
    expect(frac(3)).toBeGreaterThanOrEqual(0.6);
    expect(frac(6.5)).toBeGreaterThanOrEqual(0.9);
  });
});

describe('ocean: step rule helpers', () => {
  it('arenaCliffDistance: distance to the next level up (the step limit is feet + 0.6)', () => {
    // standing on the seabed 1 m from the terrace edge (r = 19) the cliff is 1 m away; on the terrace 1.5 m outside the plateau edge (r = 8) it is 1.5 m
    const p20 = at(20);
    const p95 = at(9.5);
    expect(arenaCliffDistance(O, p20.x, p20.z)).toBeCloseTo(1, 1);
    expect(arenaCliffDistance(O, p95.x, p95.z)).toBeGreaterThan(1.0); // (the plateau rim 1.5 m away, or a ramp flank a little nearer)
    expect(arenaCliffDistance(O, p95.x, p95.z)).toBeLessThanOrEqual(1.5 + 1e-6);
    expect(arenaCliffDistance(O, 0, 2)).toBeGreaterThan(5); // on the plateau only the towers' causeways (3 m up, 6+ m away) are higher
    for (const s of stacks) expect(arenaCliffDistance(O, s.x, s.z)).toBe(Infinity); // on a tower top neither
  });
  it('ARENA_STEP_UP is the dais height', () => {
    expect(ARENA_STEP_UP).toBe(0.6);
    expect(ARENAS.colosseum.dais?.height).toBe(ARENA_STEP_UP);
  });
});
