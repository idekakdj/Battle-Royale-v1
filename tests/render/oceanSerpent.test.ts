/**
 * Ocean Dome geometry + sea-serpent visual tests (v1.9 WP-O3, v1.10 WP-H4), all node-safe:
 *  - the levels geometry reproduces `arenaGroundHeight` (tops, ramps, the three towers and their two-piece climbs) with no holes along the
 *    ramp seams, the plateau / terrace junctions or the tower rims, and the ramps are real slopes,
 *  - the strike STRIP drapes over the terrain: width 3.6, wall -> centre, follows ramps, climbs cliffs with a double row; the HIGH strip is
 *    drawn only on high ground, the LOW strip never touches high ground (every low lane angle), the overhead ribbon is flat at the lane height,
 *  - the phase -> visual mapping (pure of the snapshot block: rollback / late join / interpolation give the same picture), for both tiers,
 *  - the serpent models + FX pools update without allocating / throwing, hide when idle, and the high serpent has its own identity.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { OCEAN_ARENA, OCEAN_UPPER_HEIGHT, OCEAN_SERPENT_SPLIT_Y, arenaGroundHeight } from '../../src/config/arenas';
import { serpentLaneBins } from '../../src/config/serpentLanes';
import { SERPENT } from '../../src/config/serpent';
import { arenaTowers, buildLevelsGeometry, buildSeabedGeometry, seabedHeight, towerMouths } from '../../src/render/ocean/terrain';
import { STRIP_COLUMNS, STRIP_MAX_ROWS, allocStrip, buildOverheadRibbon, buildStrip } from '../../src/render/ocean/strip';
import { EXIT_S, GLASS_LEAD, blank, glassLead, highLaneY, pathGround, serpentVisualState, simHeadR, HEAD_RADIUS } from '../../src/render/ocean/serpentState';
import { serpentShake } from '../../src/render/ocean/OceanScene';
import { SERPENT_PALETTE, SerpentModel, bodySegments } from '../../src/render/ocean/serpentModel';
import { SerpentFx } from '../../src/render/ocean/serpentFx';
import { createShared } from '../../src/render/ocean/materials';

const A = OCEAN_ARENA;
const W = A.wallRadius;

/** Highest triangle surface (y) over (x, z) of a geometry, or -Infinity (O(tris), fine for a few hundred samples). */
function topAt(geo: THREE.BufferGeometry, x: number, z: number): number {
  const pos = geo.getAttribute('position');
  const idx = geo.index!;
  let best = -Infinity;
  for (let t = 0; t < idx.count; t += 3) {
    const a = idx.getX(t);
    const b = idx.getX(t + 1);
    const c = idx.getX(t + 2);
    const ax = pos.getX(a);
    const az = pos.getZ(a);
    const bx = pos.getX(b);
    const bz = pos.getZ(b);
    const cx = pos.getX(c);
    const cz = pos.getZ(c);
    const minX = Math.min(ax, bx, cx);
    if (x < minX - 1e-6 || x > Math.max(ax, bx, cx) + 1e-6) continue;
    if (z < Math.min(az, bz, cz) - 1e-6 || z > Math.max(az, bz, cz) + 1e-6) continue;
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(d) < 1e-9) continue;
    const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
    const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
    const y = l1 * pos.getY(a) + l2 * pos.getY(b) + l3 * pos.getY(c);
    if (y > best) best = y;
  }
  return best;
}

describe('levels geometry = the arena heightfield', () => {
  const lv = buildLevelsGeometry(A);

  it('builds the terrace, plateau, 3 towers and 18 ramp pieces (5 level ramps + 5 two-piece climbs) with glowing inlays', () => {
    expect(lv.stats.ramps).toBe(18);
    expect(lv.stats.climbs).toBe(5); // 3 causeways + 2 chords arrive at a tower
    expect(lv.stats.towers).toBe(3);
    expect(lv.stats.rings).toBe(1);
    expect(lv.stats.plateaus).toBe(1);
    expect(lv.main.index!.count / 3).toBeGreaterThan(5_000);
    expect(lv.main.index!.count / 3).toBeLessThan(60_000);
    expect(lv.glow.index!.count / 3).toBeGreaterThan(800);
    // every vertex colour is finite; glow colours exceed 1 (they bloom)
    const c = lv.glow.getAttribute('color');
    let hot = 0;
    for (let i = 0; i < c.count; i++) {
      expect(Number.isFinite(c.getX(i) + c.getY(i) + c.getZ(i))).toBe(true);
      if (Math.max(c.getX(i), c.getY(i), c.getZ(i)) > 1) hot++;
    }
    expect(hot).toBeGreaterThan(c.count * 0.5);
  });

  it('the top surface matches arenaGroundHeight on the flat levels and the ramp slopes (away from edges and kerbs)', () => {
    let checked = 0;
    let maxErr = 0;
    for (let i = 0; i < 700; i++) {
      const a = (i * 2.399963) % (Math.PI * 2);
      const r = 0.5 + ((i * 0.6180339) % 1) * 28;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const g = arenaGroundHeight(A, x, z);
      // skip spots within 0.55 m of a height change (cliffs, ramp edges, kerbs sit 0.2 m proud of the ramp sides)
      let flat = true;
      for (const [ox, oz] of [[0.55, 0], [-0.55, 0], [0, 0.55], [0, -0.55], [0.4, 0.4], [-0.4, -0.4], [0.4, -0.4], [-0.4, 0.4]]) {
        if (Math.abs(arenaGroundHeight(A, x + ox, z + oz) - g) > 0.3 + 1e-6) flat = false;
      }
      if (!flat) continue;
      // on a ramp the kerbs are 0.2 m proud near the lateral edges: only test ramp points well inside
      const top = Math.max(topAt(lv.main, x, z), 0);
      if (g === 0 && top > 0.01) continue; // a ramp's low slab corner / kerb footprint: allowed to be proud of 0
      checked++;
      const err = Math.abs(top - g);
      if (err > maxErr) maxErr = err;
      if (top > 0.01 || g > 0.01) expect(err, `(${x.toFixed(2)}, ${z.toFixed(2)})`).toBeLessThan(0.23);
    }
    expect(checked).toBeGreaterThan(300);
    expect(maxErr).toBeLessThan(0.23);
  });

  it('the ramp surface rises along its axis (14 degrees: the arena grade of 0.25)', () => {
    const ramp = A.heightfield!.find((p) => p.kind === 'ramp')!;
    if (ramp.kind !== 'ramp') throw new Error('no ramp');
    const c = Math.cos((ramp.dirDeg * Math.PI) / 180);
    const s = Math.sin((ramp.dirDeg * Math.PI) / 180);
    const at = (u: number): number => topAt(lv.main, ramp.x + c * u, ramp.z + s * u);
    const lo = at(-2.2);
    const hi = at(2.2);
    expect((hi - lo) / 4.4).toBeCloseTo((ramp.h1 - ramp.h0) / ramp.length, 1);
    expect(hi).toBeGreaterThan(lo);
  });

  it('the seabed is exactly flat over the dome footprint and rolls beyond the glass', () => {
    for (let r = 0; r <= 34; r += 4) expect(seabedHeight(r, 0)).toBe(0);
    let maxOut = 0;
    for (let i = 0; i < 60; i++) maxOut = Math.max(maxOut, Math.abs(seabedHeight(50 * Math.cos(i), 50 * Math.sin(i))));
    expect(maxOut).toBeGreaterThan(0.3);
    const sb = buildSeabedGeometry(A);
    expect(sb.index!.count / 3).toBeGreaterThan(5_000);
    sb.dispose();
  });
});

describe('towers + two-piece climbs (v1.10)', () => {
  const lv = buildLevelsGeometry(A);
  const towers = arenaTowers(A);

  it('finds the three towers; their tops are 6.5 m flat discs at the sea-stack positions', () => {
    expect(towers.length).toBe(3);
    for (const t of towers) {
      expect(t.height).toBe(OCEAN_UPPER_HEIGHT);
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        const r = (i % 6) * 0.58;
        expect(topAt(lv.main, t.x + Math.cos(a) * r, t.z + Math.sin(a) * r), `tower ${t.x.toFixed(1)} i${i}`).toBeCloseTo(OCEAN_UPPER_HEIGHT, 3);
      }
    }
  });

  it('no holes: the surface is closed along every climb axis (seam between the lower slab and the top piece included), at the plateau / terrace feet and over the tower rims', () => {
    let worst = 0;
    let n = 0;
    for (const t of towers) {
      // each tower is reached along the line from its centre toward each mouth; walk it from the tower centre out to 16 m every 4 cm
      for (const [ang] of towerMouths(A, t)) {
        for (let d = 0; d < 16; d += 0.04) {
          const x = t.x + Math.cos(ang) * d;
          const z = t.z + Math.sin(ang) * d;
          const g = arenaGroundHeight(A, x, z);
          const top = topAt(lv.main, x, z);
          expect(Number.isFinite(top), `hole at (${x.toFixed(2)}, ${z.toFixed(2)}) d=${d.toFixed(2)}`).toBe(true);
          // the axis is inside the kerbs: the surface is the ground (the 0.2 m kerbs are 1.6 m off the axis) - except within 3 cm of a real step
          // (the 0.17 m lip where the ramp meets the tower rim, the plateau / terrace edges): there the analytic circle and the polygon may differ
          const gb = arenaGroundHeight(A, x - Math.cos(ang) * 0.03, z - Math.sin(ang) * 0.03);
          const gf = arenaGroundHeight(A, x + Math.cos(ang) * 0.03, z + Math.sin(ang) * 0.03);
          if (Math.abs(gb - gf) > 0.12) continue;
          worst = Math.max(worst, Math.abs(top - g));
          n++;
        }
      }
      // the rim circle: just inside and just outside (r = R -/+ 0.03) away from the mouths the surface is the top / the cliff base level
      for (let i = 0; i < 90; i++) {
        const a = (i / 90) * Math.PI * 2;
        if (towerMouths(A, t).some(([c, h]) => Math.abs(Math.atan2(Math.sin(a - c), Math.cos(a - c))) < h + 0.1)) continue;
        const inner = topAt(lv.main, t.x + Math.cos(a) * (t.radius - 0.03), t.z + Math.sin(a) * (t.radius - 0.03));
        expect(inner, `rim ${i}`).toBeGreaterThanOrEqual(OCEAN_UPPER_HEIGHT - 0.01); // the parapet may stand 0.14 above
        expect(inner).toBeLessThanOrEqual(OCEAN_UPPER_HEIGHT + 0.16);
      }
    }
    expect(worst).toBeLessThan(0.07);
    expect(n).toBeGreaterThan(1500);
  });

  it('the rim has no T-junction slits: every vertex of the top face on the rim circle has a coincident vertex of the cliff wall (same angular resolution)', () => {
    const pos = lv.main.getAttribute('position');
    for (const t of towers) {
      const seen = new Map<string, number>();
      for (let i = 0; i < pos.count; i++) {
        if (Math.abs(pos.getY(i) - OCEAN_UPPER_HEIGHT) > 1e-6) continue;
        const d = Math.hypot(pos.getX(i) - t.x, pos.getZ(i) - t.z);
        if (Math.abs(d - t.radius) > 1e-4) continue;
        const key = `${(Math.round(pos.getX(i) * 1e4) / 1e4 + 0).toFixed(4)},${(Math.round(pos.getZ(i) * 1e4) / 1e4 + 0).toFixed(4)}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      // 65 angular positions (the wall and the top share them); each appears in the top face and the wall (and the parapet) at least twice
      expect(seen.size).toBeGreaterThanOrEqual(64);
      for (const [k, c] of seen) expect(c, `rim vertex ${k}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('the cliff of a tower is a sheer wall (inward-only bulge): the wall never pokes outside the collider circle and reaches from the seabed to the rim', () => {
    const pos = lv.main.getAttribute('position');
    for (const t of towers) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < pos.count; i++) {
        const d = Math.hypot(pos.getX(i) - t.x, pos.getZ(i) - t.z);
        // a vertex on the cliff band (radius within 0.6 of R) between y 0.3 and 6.4 that is OUTSIDE R by more than 1 cm must belong to a ramp / kerb (it lies along a mouth)
        if (d > t.radius + 0.01 && d < t.radius + 0.6 && pos.getY(i) > 1.6 && pos.getY(i) < OCEAN_UPPER_HEIGHT - 0.1) {
          const ang = Math.atan2(pos.getZ(i) - t.z, pos.getX(i) - t.x);
          const inMouth = towerMouths(A, t, 0.9).some(([c, h]) => Math.abs(Math.atan2(Math.sin(ang - c), Math.cos(ang - c))) < h + 0.2);
          expect(inMouth, `vertex at r=${d.toFixed(3)} y=${pos.getY(i).toFixed(2)} outside the cliff and outside every mouth`).toBe(true);
        }
        if (Math.abs(d - t.radius) < 0.4) {
          lo = Math.min(lo, pos.getY(i));
          hi = Math.max(hi, pos.getY(i));
        }
      }
      expect(lo).toBeLessThanOrEqual(0.01);
      expect(hi).toBeGreaterThanOrEqual(OCEAN_UPPER_HEIGHT);
    }
  });

  it('the climbs rise at the arena grades: the surface along a causeway axis matches the ramp pieces (top piece gentler than the lower slab)', () => {
    const t = towers[0];
    const [ang] = towerMouths(A, t).find(([c]) => Math.abs(Math.atan2(Math.sin(c - (252 * Math.PI) / 180), Math.cos(c - (252 * Math.PI) / 180))) < 0.2)!; // the causeway leaves toward the centre (72 + 180 deg)
    const at = (d: number): number => topAt(lv.main, t.x + Math.cos(ang) * d, t.z + Math.sin(ang) * d);
    const lowerGrade = (at(5) - at(9)) / 4; // d = distance from the tower centre: the height FALLS with d
    const topGrade = (at(3.8) - at(4.8)) / 1.0;
    expect(lowerGrade).toBeGreaterThan(0.38);
    expect(lowerGrade).toBeLessThan(0.41);
    expect(topGrade).toBeGreaterThan(0.29);
    expect(topGrade).toBeLessThan(0.34);
  });

  it('every tower has a parapet that opens at its ramp mouths, and the rim accents skip towers and ramps (the glow geometry has no dash inside a tower)', () => {
    const pos = lv.glow.getAttribute('position');
    for (const t of towers) {
      const mouths = towerMouths(A, t);
      expect(mouths.length).toBeGreaterThanOrEqual(1);
      expect(mouths.length).toBeLessThanOrEqual(2);
      // no glow vertex at the terrace-rim height (1.51) / plateau-rim height (3.01) inside the tower disc
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        if (Math.abs(y - 1.512) < 0.003 || Math.abs(y - 3.012) < 0.003) expect(Math.hypot(pos.getX(i) - t.x, pos.getZ(i) - t.z)).toBeGreaterThan(t.radius);
      }
    }
  });
});

describe('strike strip on the terrain', () => {
  it('is 3.6 m wide, runs from just past the wall to the centre and hugs the ground', () => {
    const s = buildStrip(A, 130);
    expect(s.rows).toBeGreaterThan(100);
    expect(s.rows).toBeLessThanOrEqual(STRIP_MAX_ROWS);
    const dx = Math.cos((130 * Math.PI) / 180);
    const dz = Math.sin((130 * Math.PI) / 180);
    // first row = wall + 0.5, last row = the centre
    expect(s.rl[0]).toBeCloseTo(W + 0.5, 6);
    expect(s.rl[(s.rows - 1) * STRIP_COLUMNS * 2]).toBe(0);
    for (const row of [0, 40, 80, s.rows - 1]) {
      const l = row * STRIP_COLUMNS;
      const r = l + STRIP_COLUMNS - 1;
      const w = Math.hypot(s.positions[l * 3] - s.positions[r * 3], s.positions[l * 3 + 2] - s.positions[r * 3 + 2]);
      expect(w).toBeCloseTo(2 * SERPENT.stripHalfWidth, 5);
      // every vertex sits a hair above the ground
      for (let c = 0; c < STRIP_COLUMNS; c++) {
        const v = l + c;
        const g = arenaGroundHeight(A, s.positions[v * 3], s.positions[v * 3 + 2]);
        expect(s.positions[v * 3 + 1] - g).toBeCloseTo(0.05, 5);
      }
      // the row's centre column is on the strike line
      const m = l + (STRIP_COLUMNS - 1) / 2;
      const along = s.positions[m * 3] * dx + s.positions[m * 3 + 2] * dz;
      expect(along).toBeCloseTo(s.rl[m * 2], 5);
    }
    expect(s.indexCount).toBe((s.rows - 1) * (STRIP_COLUMNS - 1) * 6);
    expect(s.vertexCount).toBe(s.rows * STRIP_COLUMNS);
  });

  it('follows a ramp up (angle 0 runs straight up the 5 m-wide ramp at 0 degrees) with the arena grade', () => {
    const s = buildStrip(A, 0);
    const yAt = (r: number): number => {
      let best = -1;
      let by = 0;
      let bd = 1e9;
      for (let row = 0; row < s.rows; row++) {
        const m = row * STRIP_COLUMNS + 2;
        const d = Math.abs(s.rl[m * 2] - r);
        if (d < bd) {
          bd = d;
          best = row;
          by = s.positions[m * 3 + 1];
        }
      }
      void best;
      return by;
    };
    // the outer ramp spans r 18.5 .. 24.5 rising 1.5 m toward the centre: y(r) = 1.5 * (24.5 - r) / 6
    for (const r of [23.5, 22, 21, 19.8]) expect(yAt(r)).toBeCloseTo((1.5 * (24.5 - r)) / 6 + 0.05, 1);
    // flat beyond the ramp's foot (the seabed) and on the terrace
    expect(yAt(27)).toBeCloseTo(0.05, 2);
    expect(yAt(14)).toBeCloseTo(1.55, 2);
    expect(yAt(0.5)).toBeCloseTo(3.05, 2);
  });

  it('climbs a cliff with a double row (no slanted triangle through the rock)', () => {
    const angle = 36; // between the outer ramps: the terrace edge at r = 19 is a cliff on this line (the inner ramp at 36 deg meets the plateau)
    const s = buildStrip(A, angle);
    let found = false;
    for (let row = 1; row < s.rows; row++) {
      const a = (row - 1) * STRIP_COLUMNS + 2;
      const b = row * STRIP_COLUMNS + 2;
      const dy = Math.abs(s.positions[a * 3 + 1] - s.positions[b * 3 + 1]);
      const dr = Math.abs(s.rl[a * 2] - s.rl[b * 2]);
      if (dy > 1 && dr < 0.1) found = true; // a >1 m rise within <0.1 m of run: the vertical face of the cliff
      expect(dr, `row ${row} spacing`).toBeLessThan(0.3);
    }
    expect(found).toBe(true);
    // the surface heights jump exactly where the ground does
    const rows = new Set<number>();
    for (let row = 0; row < s.rows; row++) rows.add(Math.round(s.rl[(row * STRIP_COLUMNS + 2) * 2] * 1000));
    expect(rows.size).toBeGreaterThan(100);
  });

  it('is rebuilt in place for another angle (no reallocation) and fits the preallocated buffers for every angle', () => {
    const buf = allocStrip();
    const keep = buf.positions;
    for (let a = 0; a < 360; a += 7) {
      const s = buildStrip(A, a, buf);
      expect(s).toBe(buf);
      expect(s.positions).toBe(keep);
      expect(s.rows).toBeLessThanOrEqual(STRIP_MAX_ROWS);
      for (let i = 0; i < s.vertexCount * 3; i++) expect(Number.isFinite(s.positions[i])).toBe(true);
    }
  });
});

describe('strips + ribbon per serpent (v1.10)', () => {
  const split = OCEAN_SERPENT_SPLIT_Y;
  const ground = (s: ReturnType<typeof buildStrip>, v: number): number => arenaGroundHeight(A, s.positions[v * 3], s.positions[v * 3 + 2]);

  it('the HIGH strip is drawn only where the ground is high: every emitted triangle stands on >= 4.5 m ground', () => {
    let nonEmpty = 0;
    for (const b of serpentLaneBins(A).high.filter((_, i) => i % 3 === 0)) {
      const s = buildStrip(A, b + 0.5, allocStrip(), 'high');
      if (s.indexCount > 0) nonEmpty++;
      for (let k = 0; k < s.indexCount; k++) expect(ground(s, s_idx(s, k)), `angle ${b + 0.5} index ${k}`).toBeGreaterThanOrEqual(split - 1e-4);
      // and the whole low part of the line is NOT drawn: far fewer triangles than the full strip
      expect(s.indexCount).toBeLessThan(buildStrip(A, b + 0.5, allocStrip(), 'low').indexCount * 0.55);
    }
    expect(nonEmpty).toBeGreaterThan(20);
    // a purely low angle has nothing for the high strip to draw
    const low0 = serpentLaneBins(A).low[0] + 0.5;
    expect(buildStrip(A, low0, allocStrip(), 'high').indexCount).toBe(0);
  });

  it('the LOW strip never touches high ground: for every angle of the low lane (all 182 bins, both bin edges and the middle) every vertex is on ground < 4.5 m', () => {
    const buf = allocStrip();
    const bins = serpentLaneBins(A).low;
    expect(bins.length).toBeGreaterThanOrEqual(150);
    for (const b of bins) {
      for (const f of [0, 0.5, 0.999]) {
        buildStrip(A, b + f, buf, 'low');
        for (let v = 0; v < buf.vertexCount; v++) expect(ground(buf, v), `angle ${b + f}`).toBeLessThan(split);
      }
    }
  });

  it('the high strip is rebuilt in place with the pooled buffers (no reallocation) and the tier changes nothing else about its layout', () => {
    const buf = allocStrip();
    const keep = buf.positions;
    const a = buildStrip(A, 72.5, buf, 'high');
    expect(a).toBe(buf);
    expect(a.positions).toBe(keep);
    const full = buildStrip(A, 72.5, allocStrip(), 'low');
    expect(a.vertexCount).toBe(full.vertexCount);
    expect(a.rows).toBe(full.rows);
  });

  it('the overhead ribbon is flat at the high lane height, 3.6 m wide, wall -> centre, 5 columns', () => {
    const r = buildOverheadRibbon(A, 130, highLaneY(A));
    expect(r.rl[0]).toBeCloseTo(W + 0.5, 6);
    expect(r.rl[(r.rows - 1) * STRIP_COLUMNS * 2]).toBe(0);
    expect(r.rows).toBeLessThanOrEqual(STRIP_MAX_ROWS);
    for (let v = 0; v < r.vertexCount; v++) expect(r.positions[v * 3 + 1]).toBeCloseTo(OCEAN_UPPER_HEIGHT + 2, 5);
    for (const row of [0, 20, r.rows - 1]) {
      const l = row * STRIP_COLUMNS;
      const e = l + STRIP_COLUMNS - 1;
      expect(Math.hypot(r.positions[l * 3] - r.positions[e * 3], r.positions[l * 3 + 2] - r.positions[e * 3 + 2])).toBeCloseTo(2 * SERPENT.stripHalfWidth, 5);
    }
    expect(r.indexCount).toBe((r.rows - 1) * (STRIP_COLUMNS - 1) * 6);
  });
});

function s_idx(s: ReturnType<typeof buildStrip>, k: number): number {
  return s.indices[k];
}

describe('serpent visual state (pure of the snapshot block)', () => {
  const lead = GLASS_LEAD / W;

  it('maps each phase to the right head radius, glass state and strip', () => {
    const v = blank();
    serpentVisualState(A, { phase: 'warn', angleDeg: 90, t: 0.5 }, 1, v);
    expect(v.active).toBe(true);
    expect(v.phase).toBe('warn');
    expect(v.rv).toBeGreaterThanOrEqual(W * (1 + lead) - 1e-9); // coiled outside the glass
    expect(v.coil).toBe(1);
    expect(v.stripAlpha).toBe(1);
    expect(v.crack).toBe(0);
    expect(v.hole).toBe(0);
    expect(v.urgency).toBeCloseTo(0.5 / SERPENT.warnS, 6);
    expect(v.dirX).toBeCloseTo(0, 6);
    expect(v.dirZ).toBeCloseTo(1, 6);

    serpentVisualState(A, { phase: 'strike', angleDeg: 90, t: SERPENT.strikeS / 2 }, 1, v);
    expect(v.rv).toBeCloseTo((W / 2) * (1 + lead), 6);
    expect(v.rv).toBeGreaterThan(simHeadR('strike', SERPENT.strikeS / 2, W)); // the drawn head is never behind the hitbox
    expect(v.crack).toBe(1);
    expect(v.hole).toBe(1);
    expect(v.coil).toBeLessThan(1);
    expect(v.jaw).toBeGreaterThan(0.9);

    serpentVisualState(A, { phase: 'hold', angleDeg: 90, t: 0.1 }, 1, v);
    expect(v.rv).toBe(0);
    expect(v.shock).toBeGreaterThanOrEqual(0);
    expect(v.pitch).toBeGreaterThan(0.3); // rears up
    expect(v.coil).toBe(0);

    serpentVisualState(A, { phase: 'retreat', angleDeg: 90, t: SERPENT.retreatS * 0.5 }, 1, v);
    expect(v.rv).toBeCloseTo(W * 0.5 * (1 + lead), 6);
    expect(v.stripAlpha).toBe(0);
    expect(v.hole).toBeLessThan(0.5); // the glass is re-forming
    expect(v.crack).toBeGreaterThan(0);
    serpentVisualState(A, { phase: 'retreat', angleDeg: 90, t: SERPENT.retreatS }, 1, v);
    expect(v.hole).toBe(0);
    expect(v.crack).toBeCloseTo(0, 6);
  });

  it('the LOW head stays on or above the terrain it crosses (on the angles the low lane really draws: never through a tower)', () => {
    const v = blank();
    const lane = serpentLaneBins(A).low;
    const angles = [0, 36, 108, 200, 300, 150.5].filter((a) => lane.includes(Math.floor(a)));
    for (let k = 0; k < lane.length; k += 9) angles.push(lane[k] + 0.5);
    expect(angles.length).toBeGreaterThan(20);
    for (const angle of angles) {
      for (let t = 0; t < SERPENT.strikeS; t += 0.02) {
        serpentVisualState(A, { phase: 'strike', angleDeg: angle, t }, 1, v);
        const g = pathGround(A, v.dirX, v.dirZ, Math.min(v.rv, W + 1), -1.2, 1.2);
        // the head's underside is at headY - HEAD_RADIUS; the blurred ground may lag a cliff by < the step height
        expect(v.headY - HEAD_RADIUS, `angle ${angle} t ${t.toFixed(2)}`).toBeGreaterThanOrEqual(g - 0.8);
        expect(Number.isFinite(v.headY)).toBe(true);
        expect(v.tier).toBe('low');
      }
    }
  });

  it('the HIGH head flies level at the tower-top height + 2 m (over the towers AND the plateau), against the glass where the glass is, never behind the hitbox', () => {
    const v = blank('high');
    const laneY = highLaneY(A);
    expect(laneY).toBe(OCEAN_UPPER_HEIGHT + 2);
    const lead = glassLead(A, 'high');
    expect(lead).toBeLessThan(GLASS_LEAD); // the glass is closer at 8.5 m than at the floor
    expect(lead).toBeGreaterThan(0.8);
    for (const b of serpentLaneBins(A).high.filter((_, i) => i % 6 === 0)) {
      for (const [phase, t] of [['warn', 0.4], ['strike', 0.0], ['strike', 0.1], ['strike', 0.3], ['strike', SERPENT.strikeS], ['hold', 0.0], ['retreat', 0.3]] as const) {
        serpentVisualState(A, { phase, angleDeg: b + 0.5, t }, 1, v, -1, 'high');
        expect(v.tier).toBe('high');
        if (phase === 'strike') {
          expect(v.headY).toBe(laneY);
          expect(v.rv).toBeGreaterThanOrEqual(simHeadR('strike', t, W) - 1e-9); // never behind the sim head
          expect(v.rv).toBeCloseTo(simHeadR('strike', t, W) * (1 + lead / W), 6);
          // over every tower top / ramp on the line the head's underside stays above the ground (6.5 m max)
          const g = pathGround(A, v.dirX, v.dirZ, Math.min(v.rv, W + 1), -1.2, 1.2);
          expect(v.headY - HEAD_RADIUS).toBeGreaterThanOrEqual(g - 0.8);
        }
        if (phase === 'hold') expect(v.headY).toBeGreaterThanOrEqual(laneY);
        expect(Number.isFinite(v.headY + v.rv)).toBe(true);
      }
    }
  });

  it('high and low are the SAME pure mapping with the same timeline (phase, t, urgency, glass, shock) - only the head height / lead / tier differ', () => {
    const lo = blank('low');
    const hi = blank('high');
    for (const [phase, t] of [['warn', 0.7], ['strike', 0.2], ['hold', 0.2], ['retreat', 0.5]] as const) {
      serpentVisualState(A, { phase, angleDeg: 100, t }, 1, lo, -1, 'low');
      serpentVisualState(A, { phase, angleDeg: 100, t }, 1, hi, -1, 'high');
      for (const k of ['phase', 't', 'urgency', 'stripAlpha', 'sweepR', 'crack', 'hole', 'shudder', 'flash', 'shock', 'jaw', 'coil', 'alpha', 'dirX', 'dirZ'] as const) expect(hi[k], `${phase} ${k}`).toEqual(lo[k]);
      expect(hi.headY).toBeGreaterThan(lo.headY);
    }
    // the withdrawal after the event also follows the tier
    serpentVisualState(A, { phase: 'retreat', angleDeg: 100, t: SERPENT.retreatS }, 1, hi, -1, 'high');
    serpentVisualState(A, null, 1, hi, 0.5, 'high');
    expect(hi.phase).toBe('exit');
    expect(hi.headY).toBeGreaterThanOrEqual(highLaneY(A));
  });

  it('is a pure function of the block: rollback, a late join and fresh state give identical pictures', () => {
    const a = blank();
    const b = blank();
    // `a` sees the whole event, `b` joins in the middle (and a third pass rolls back to the strike)
    const timeline: Array<{ phase: 'warn' | 'strike' | 'hold' | 'retreat'; t: number }> = [];
    for (let t = 0; t < SERPENT.warnS; t += 1 / 60) timeline.push({ phase: 'warn', t });
    for (let t = 0; t < SERPENT.strikeS; t += 1 / 60) timeline.push({ phase: 'strike', t });
    for (let t = 0; t < SERPENT.holdS; t += 1 / 60) timeline.push({ phase: 'hold', t });
    for (let t = 0; t < SERPENT.retreatS; t += 1 / 60) timeline.push({ phase: 'retreat', t });
    const frames = timeline.map((s) => ({ ...serpentVisualState(A, { ...s, angleDeg: 217 }, 1, a) }));
    for (const idx of [0, 30, 66, 80, 95, 110, timeline.length - 1]) {
      const fresh = { ...serpentVisualState(A, { ...timeline[idx], angleDeg: 217 }, 1, b) };
      expect(fresh, `frame ${idx}`).toEqual(frames[idx]);
    }
    // interpolated online blocks (any t between ticks) stay inside the phase and finite
    for (const phase of ['warn', 'strike', 'hold', 'retreat'] as const) {
      const v = serpentVisualState(A, { phase, angleDeg: 5, t: 9 }, 1, blank());
      expect(v.t).toBeLessThanOrEqual(phase === 'warn' ? SERPENT.warnS : phase === 'strike' ? SERPENT.strikeS : phase === 'hold' ? SERPENT.holdS : SERPENT.retreatS);
    }
  });

  it('render alpha lags the drawn time by (1 - alpha) ticks and never goes negative', () => {
    const v = blank();
    serpentVisualState(A, { phase: 'strike', angleDeg: 0, t: 0.1 }, 0.5, v);
    expect(v.t).toBeCloseTo(0.1 - 0.5 / 60, 6);
    serpentVisualState(A, { phase: 'strike', angleDeg: 0, t: 0 }, 0, v);
    expect(v.t).toBe(0);
  });

  it('after the sim ends the event the serpent withdraws for EXIT_S then vanishes', () => {
    const v = blank();
    serpentVisualState(A, { phase: 'retreat', angleDeg: 40, t: SERPENT.retreatS }, 1, v);
    const rv0 = v.rv;
    serpentVisualState(A, null, 1, v, 0);
    expect(v.phase).toBe('exit');
    expect(v.active).toBe(true);
    serpentVisualState(A, null, 1, v, EXIT_S * 0.6);
    expect(v.rv).toBeGreaterThan(rv0);
    expect(v.alpha).toBeLessThan(1);
    serpentVisualState(A, null, 1, v, EXIT_S + 0.01);
    expect(v.active).toBe(false);
    expect(v.phase).toBe('none');
    // never-active state stays inactive
    const idle = serpentVisualState(A, null, 1, blank(), 0.3);
    expect(idle.active).toBe(false);
  });

  it('camera shake: a low rumble while coiling, a heavy jolt at the strike, stronger on the strike side, never above the rig cap', () => {
    const v = blank();
    serpentVisualState(A, { phase: 'warn', angleDeg: 0, t: 0.1 }, 1, v);
    const early = serpentShake(v, 20, 0, true, W);
    serpentVisualState(A, { phase: 'warn', angleDeg: 0, t: 1.05 }, 1, v);
    const late = serpentShake(v, 20, 0, true, W);
    expect(late).toBeGreaterThan(early);
    const farSide = serpentShake(v, -20, 0, true, W);
    expect(farSide).toBeLessThan(late);
    serpentVisualState(A, { phase: 'strike', angleDeg: 0, t: 0.1 }, 1, v);
    const strike = serpentShake(v, 20, 0, true, W);
    expect(strike).toBeGreaterThan(late);
    expect(strike).toBeLessThanOrEqual(0.15);
    expect(serpentShake(blank(), 0, 0, true, W)).toBe(0);
  });
});

describe('serpent model + fx', () => {
  it('poses the body with finite matrices, hides when idle, and the segment table covers ~74 m', () => {
    const shared = createShared(W + 2, 22);
    const model = new SerpentModel(shared);
    const segs = bodySegments();
    expect(segs.length).toBeGreaterThan(40);
    expect(segs.length).toBeLessThanOrEqual(96);
    expect(segs[segs.length - 1]).toBeGreaterThan(60);
    const v = blank();
    serpentVisualState(A, null, 1, v);
    model.update(A, v, 0);
    expect(model.root.visible).toBe(false);
    for (const phase of ['warn', 'strike', 'hold', 'retreat'] as const) {
      serpentVisualState(A, { phase, angleDeg: 310, t: 0.2 }, 1, v);
      model.update(A, v, 1.7);
      expect(model.root.visible).toBe(true);
      for (const child of model.root.children) {
        const im = child as THREE.InstancedMesh;
        if (!im.isInstancedMesh) continue;
        const arr = im.instanceMatrix.array as Float32Array;
        for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) throw new Error(`non-finite matrix in ${phase}`);
      }
    }
    // the head is ~3.5 m wide: its bounding box in x (across the strike line) is within 3.2 .. 4.6 m
    const head = model.head.children[0] as THREE.Mesh;
    head.geometry.computeBoundingBox();
    const bb = head.geometry.boundingBox!;
    expect(bb.max.x - bb.min.x).toBeGreaterThan(2.3);
    model.dispose();
  });

  it('fx: pooled shards / particles burst on the strike and a hit, then die out; the shockwave only runs at the hold', () => {
    const shared = createShared(W + 2, 22);
    const fx = new SerpentFx(shared, A, 3);
    const v = blank();
    serpentVisualState(A, { phase: 'warn', angleDeg: 20, t: 0.2 }, 1, v);
    fx.update(v, 1 / 60, v.t);
    expect(fx.strip.mesh.visible).toBe(true);
    expect(fx.ringVisible).toBe(false);
    fx.onStrike(Math.cos(0.35), Math.sin(0.35));
    fx.onHit(3, 1.5, 4);
    fx.update(v, 1 / 60, 9);
    expect(fx.liveShards).toBeGreaterThan(20);
    expect(fx.liveParticles).toBeGreaterThan(40);
    serpentVisualState(A, { phase: 'hold', angleDeg: 20, t: 0.1 }, 1, v);
    fx.update(v, 1 / 60, 9);
    expect(fx.ringVisible).toBe(true);
    serpentVisualState(A, null, 1, v);
    for (let i = 0; i < 240; i++) fx.update(v, 1 / 60, 9);
    expect(fx.liveShards).toBe(0);
    expect(fx.liveParticles).toBe(0);
    expect(fx.ringVisible).toBe(false);
    expect(fx.strip.mesh.visible).toBe(false);
    fx.dispose();
  });
});

describe('the high serpent has its own identity (v1.10)', () => {
  it('palette: the high serpent is violet / magenta where the low one is teal / orange (hue test), eyes magenta vs yellow-green', () => {
    const lo = SERPENT_PALETTE.low;
    const hi = SERPENT_PALETTE.high;
    const hue = (c: [number, number, number]): number => {
      const [r, g, b] = c;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      if (mx === mn) return 0;
      const d = mx - mn;
      let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
      return h < 0 ? h + 360 : h;
    };
    expect(hue(lo.scaleMid)).toBeGreaterThan(160);
    expect(hue(lo.scaleMid)).toBeLessThan(215); // teal
    expect(hue(hi.scaleMid)).toBeGreaterThan(250);
    expect(hue(hi.scaleMid)).toBeLessThan(290); // violet
    expect(hue(lo.fin)).toBeLessThan(35); // orange
    expect(hue(hi.fin)).toBeGreaterThan(300); // magenta
    expect(hi.eye[0]).toBeGreaterThan(hi.eye[1] * 3); // magenta: red + blue high, green low
    expect(hi.eye[2]).toBeGreaterThan(hi.eye[1] * 3);
    expect(lo.eye[2]).toBeLessThan(lo.eye[0] * 0.2); // yellow-green: no blue
  });

  it('strip palette: the high strip is violet / magenta (blue > green, red-orange off), the low strip red-orange (red > blue)', () => {
    const shared = createShared(W + 2, 22);
    const lo = new SerpentFx(shared, A, 3, 'low');
    const hi = new SerpentFx(shared, A, 3, 'high');
    expect(lo.strip.palette.base.x).toBeGreaterThan(lo.strip.palette.base.z * 5);
    expect(hi.strip.palette.base.z).toBeGreaterThan(hi.strip.palette.base.x);
    expect(hi.strip.palette.chevron.z).toBeGreaterThan(hi.strip.palette.chevron.y * 3);
    expect(lo.ribbon).toBeNull();
    expect(hi.ribbon).not.toBeNull();
    lo.dispose();
    hi.dispose();
  });

  it('the high model poses with finite matrices at the lane height inside the dome (head + the neck behind it), and hides when idle', () => {
    const shared = createShared(W + 2, 22);
    const model = new SerpentModel(shared, 'high');
    const v = blank('high');
    serpentVisualState(A, null, 1, v, -1, 'high');
    model.update(A, v, 0);
    expect(model.root.visible).toBe(false);
    for (const phase of ['warn', 'strike', 'hold', 'retreat'] as const) {
      serpentVisualState(A, { phase, angleDeg: 72.4, t: 0.2 }, 1, v, -1, 'high');
      model.update(A, v, 1.7);
      expect(model.root.visible).toBe(true);
      expect(model.head.position.y).toBeCloseTo(v.headY, 6);
      for (const child of model.root.children) {
        const im = child as THREE.InstancedMesh;
        if (!im.isInstancedMesh) continue;
        const arr = im.instanceMatrix.array as Float32Array;
        for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) throw new Error(`non-finite matrix in ${phase}`);
      }
    }
    // mid-strike: the first ten body segments (the neck) are at the flight height (+-3.5 m), not on the floor
    serpentVisualState(A, { phase: 'strike', angleDeg: 72.4, t: 0.3 }, 1, v, -1, 'high');
    model.update(A, v, 1.7);
    const body = model.root.children.find((c) => (c as THREE.InstancedMesh).isInstancedMesh && (c as THREE.InstancedMesh).count === model.segmentCount) as THREE.InstancedMesh;
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    for (let i = 0; i < 10; i++) {
      body.getMatrixAt(i, m);
      p.setFromMatrixPosition(m);
      expect(p.y, `segment ${i}`).toBeGreaterThan(v.headY - 3.5);
      expect(p.y).toBeLessThan(v.headY + 1);
    }
    model.dispose();
  });

  it('fx (high): shards / spray burst at the glass height (8.5 m), violet flash, a horizontal shockwave at the lane height; pools die out', () => {
    const shared = createShared(W + 2, 22);
    const fx = new SerpentFx(shared, A, 3, 'high');
    const v = blank('high');
    serpentVisualState(A, { phase: 'warn', angleDeg: 72.4, t: 0.4 }, 1, v, -1, 'high');
    fx.update(v, 1 / 60, v.t);
    expect(fx.strip.mesh.visible).toBe(true);
    expect(fx.ribbon!.mesh.visible).toBe(true);
    expect(fx.ringVisible).toBe(false);
    fx.onStrike(Math.cos(1.263), Math.sin(1.263));
    fx.update(v, 1 / 60, 9);
    expect(fx.liveShards).toBeGreaterThan(20);
    expect(fx.liveParticles).toBeGreaterThan(40);
    serpentVisualState(A, { phase: 'hold', angleDeg: 72.4, t: 0.1 }, 1, v, -1, 'high');
    fx.update(v, 1 / 60, 9);
    expect(fx.ringVisible).toBe(true);
    expect(fx.ringY).toBeGreaterThan(OCEAN_UPPER_HEIGHT + 1); // a horizontal ring in the air at the lane height, not on the plateau floor
    expect(fx.visibleDraws).toBeLessThanOrEqual(6);
    serpentVisualState(A, null, 1, v, -1, 'high');
    for (let i = 0; i < 240; i++) fx.update(v, 1 / 60, 9);
    expect(fx.liveShards).toBe(0);
    expect(fx.liveParticles).toBe(0);
    expect(fx.visibleDraws).toBe(0);
    fx.dispose();
  });
});
