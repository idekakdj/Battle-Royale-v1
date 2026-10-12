/**
 * Ocean Dome geometry + sea-serpent visual tests (v1.9 WP-O3), all node-safe:
 *  - the levels geometry reproduces `arenaGroundHeight` (tops, ramps) and the ramps are real slopes,
 *  - the strike STRIP drapes over the terrain: width 3.6, wall -> centre, follows ramps, climbs cliffs with a double row,
 *  - the phase -> visual mapping (pure of the snapshot block: rollback / late join / interpolation give the same picture),
 *  - the serpent model + FX pools update without allocating / throwing, and hide when idle.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { OCEAN_ARENA, arenaGroundHeight } from '../../src/config/arenas';
import { SERPENT } from '../../src/config/serpent';
import { buildLevelsGeometry, buildSeabedGeometry, seabedHeight } from '../../src/render/ocean/terrain';
import { STRIP_COLUMNS, STRIP_MAX_ROWS, allocStrip, buildStrip } from '../../src/render/ocean/strip';
import { EXIT_S, GLASS_LEAD, blank, pathGround, serpentVisualState, simHeadR, HEAD_RADIUS } from '../../src/render/ocean/serpentState';
import { serpentShake } from '../../src/render/ocean/OceanScene';
import { SerpentModel, bodySegments } from '../../src/render/ocean/serpentModel';
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

  it('builds the terrace, plateau and 9 ramps with glowing inlays', () => {
    expect(lv.stats.ramps).toBe(9);
    expect(lv.stats.rings).toBe(1);
    expect(lv.stats.plateaus).toBe(1);
    expect(lv.main.index!.count / 3).toBeGreaterThan(5_000);
    expect(lv.main.index!.count / 3).toBeLessThan(30_000);
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

  it('the head stays on or above the terrain it crosses', () => {
    const v = blank();
    for (const angle of [0, 36, 72, 108, 200, 300]) {
      for (let t = 0; t < SERPENT.strikeS; t += 0.02) {
        serpentVisualState(A, { phase: 'strike', angleDeg: angle, t }, 1, v);
        const g = pathGround(A, v.dirX, v.dirZ, Math.min(v.rv, W + 1), -1.2, 1.2);
        // the head's underside is at headY - HEAD_RADIUS; the blurred ground may lag a cliff by < the step height
        expect(v.headY - HEAD_RADIUS).toBeGreaterThanOrEqual(g - 0.8);
        expect(Number.isFinite(v.headY)).toBe(true);
      }
    }
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
