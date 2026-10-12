/**
 * The serpent's STRIKE STRIP draped over the terrain (WP-O3). Pure geometry (no three, node-safe): rows of vertices run from just past
 * the wall (r = wall + 0.5) to the centre along the strike line, 5 columns wide across the strip (full width = 2 x the half-width),
 * every vertex lifted a hair above `arenaGroundHeight`. Where the ground jumps (the cliffs of the terrace / plateau, the sides of a
 * ramp) the row spacing is refined by bisection and two rows are inserted either side of the jump, so the ribbon climbs the cliff face
 * instead of cutting a slanted triangle through the rock; on a ramp the vertices follow the slope.
 *
 * `buildStrip` returns plain arrays so the scene can copy them into a preallocated BufferGeometry (no allocation per frame - the strip
 * is rebuilt only when the strike angle changes, once per event).
 */

import { arenaGroundHeight, type ArenaDef } from '../../config/arenas';
import { SERPENT } from '../../config/serpent';

/** Columns across the strip (lateral fractions -1 .. 1). */
export const STRIP_COLUMNS = 5;
/** Nominal row spacing along the line (m). */
export const STRIP_STEP = 0.25;
/** Lift above the ground (m) so the strip never z-fights with the floor. */
export const STRIP_LIFT = 0.05;
/** Upper bound on rows (allocation size for the scene's buffers): the line plus up to ~24 refined jumps. */
export const STRIP_MAX_ROWS = 220;

export interface StripGeometry {
  /** xyz per vertex. */
  positions: Float32Array;
  /** (r, lateral -1..1) per vertex. */
  rl: Float32Array;
  /** Triangle indices. */
  indices: Uint16Array;
  rows: number;
  vertexCount: number;
  indexCount: number;
}

/** Allocate the arrays once (max size). */
export function allocStrip(): StripGeometry {
  return {
    positions: new Float32Array(STRIP_MAX_ROWS * STRIP_COLUMNS * 3),
    rl: new Float32Array(STRIP_MAX_ROWS * STRIP_COLUMNS * 2),
    indices: new Uint16Array((STRIP_MAX_ROWS - 1) * (STRIP_COLUMNS - 1) * 6),
    rows: 0,
    vertexCount: 0,
    indexCount: 0,
  };
}

function colHeight(arena: ArenaDef, dx: number, dz: number, r: number, lat: number, halfW: number): number {
  const x = dx * r - dz * lat * halfW;
  const z = dz * r + dx * lat * halfW;
  return arenaGroundHeight(arena, x, z);
}

/** Largest height difference across the strip's columns between two radii (jump detector for the row refinement). */
function rowSignature(arena: ArenaDef, dx: number, dz: number, r: number, halfW: number): number[] {
  const out: number[] = [];
  for (let c = 0; c < STRIP_COLUMNS; c++) out.push(colHeight(arena, dx, dz, r, (c / (STRIP_COLUMNS - 1)) * 2 - 1, halfW));
  return out;
}

/**
 * Build the strip for a strike at `angleDeg` into `out` (reused). Rows are listed from the OUTER end (r = wall + 0.5) toward the centre.
 */
export function buildStrip(arena: ArenaDef, angleDeg: number, out: StripGeometry = allocStrip()): StripGeometry {
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(a);
  const dz = Math.sin(a);
  const halfW = SERPENT.stripHalfWidth;
  const r0 = arena.wallRadius + 0.5;

  // Row radii: uniform steps, plus a pair of rows around every jump found by bisection.
  const radii: number[] = [];
  const n = Math.ceil(r0 / STRIP_STEP);
  let prevR = r0;
  let prevSig = rowSignature(arena, dx, dz, prevR, halfW);
  radii.push(prevR);
  for (let i = 1; i <= n; i++) {
    const r = Math.max(0, r0 - i * STRIP_STEP);
    const sig = rowSignature(arena, dx, dz, r, halfW);
    // Any column's height changed by more than 0.12 m since the previous row: a cliff / ramp edge lies between them.
    let jump = false;
    for (let c = 0; c < STRIP_COLUMNS; c++) if (Math.abs(sig[c] - prevSig[c]) > 0.12 && Math.abs(sig[c] - prevSig[c]) > STRIP_STEP * 0.6) jump = true;
    if (jump && radii.length < STRIP_MAX_ROWS - 6) {
      // Refine: the radius at which the centre column's (or any column's) height flips - bisect the largest-jump column.
      let col = 0;
      let best = 0;
      for (let c = 0; c < STRIP_COLUMNS; c++) {
        const d = Math.abs(sig[c] - prevSig[c]);
        if (d > best) {
          best = d;
          col = c;
        }
      }
      const lat = (col / (STRIP_COLUMNS - 1)) * 2 - 1;
      let hi = prevR;
      let lo = r;
      const hHi = colHeight(arena, dx, dz, hi, lat, halfW);
      for (let k = 0; k < 14; k++) {
        const mid = (hi + lo) / 2;
        const hm = colHeight(arena, dx, dz, mid, lat, halfW);
        if (Math.abs(hm - hHi) < 0.05) hi = mid;
        else lo = mid;
      }
      // Only a true cliff (a vertical step) gets the double row; a gentle ramp slope just continues.
      const eps = 0.012;
      if (Math.abs(colHeight(arena, dx, dz, hi - eps, lat, halfW) - colHeight(arena, dx, dz, hi + eps, lat, halfW)) > 0.2) {
        radii.push(hi + eps);
        radii.push(hi - eps);
      }
    }
    radii.push(r);
    prevR = r;
    prevSig = sig;
  }
  const rows = Math.min(radii.length, STRIP_MAX_ROWS);
  let v = 0;
  for (let i = 0; i < rows; i++) {
    const r = radii[i];
    for (let c = 0; c < STRIP_COLUMNS; c++) {
      const lat = (c / (STRIP_COLUMNS - 1)) * 2 - 1;
      const x = dx * r - dz * lat * halfW;
      const z = dz * r + dx * lat * halfW;
      const y = arenaGroundHeight(arena, x, z) + STRIP_LIFT;
      out.positions[v * 3] = x;
      out.positions[v * 3 + 1] = y;
      out.positions[v * 3 + 2] = z;
      out.rl[v * 2] = r;
      out.rl[v * 2 + 1] = lat;
      v++;
    }
  }
  let k = 0;
  for (let i = 0; i < rows - 1; i++) {
    for (let c = 0; c < STRIP_COLUMNS - 1; c++) {
      const a0 = i * STRIP_COLUMNS + c;
      const b0 = a0 + 1;
      const c0 = a0 + STRIP_COLUMNS;
      const d0 = c0 + 1;
      out.indices[k++] = a0;
      out.indices[k++] = c0;
      out.indices[k++] = b0;
      out.indices[k++] = b0;
      out.indices[k++] = c0;
      out.indices[k++] = d0;
    }
  }
  out.rows = rows;
  out.vertexCount = v;
  out.indexCount = k;
  return out;
}
