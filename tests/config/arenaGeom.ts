/**
 * Shared geometry helpers for the arena tests (v1.8): distances to colliders / terrain and a free-space BFS.
 * Pure functions over {@link ArenaDef}; nothing here touches the sim.
 */

import type { ArenaDef, ArenaObstacle, TerrainZoneDef } from '../../src/config/arenas';
import { arenaCliffDistance, arenaWalkableStep } from '../../src/config/arenas';

export function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax;
  const abz = bz - az;
  const l2 = abx * abx + abz * abz;
  let t = l2 > 1e-9 ? ((px - ax) * abx + (pz - az) * abz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + abx * t), pz - (az + abz * t));
}

/** Signed distance from (x,z) to the surface of one solid (negative inside). */
export function surfaceDist(ob: ArenaObstacle, x: number, z: number): number {
  if (ob.shape === 'circle') return Math.hypot(x - ob.x, z - ob.z) - ob.radius;
  if (ob.shape === 'segment') return segDist(x, z, ob.ax, ob.az, ob.bx, ob.bz) - ob.thickness * 0.5;
  const dx = Math.max(0, Math.abs(x - ob.x) - ob.halfX);
  const dz = Math.max(0, Math.abs(z - ob.z) - ob.halfZ);
  return Math.hypot(dx, dz);
}

/** Distance from (x,z) to the nearest solid surface of a subset. */
export function minSurfaceDist(solids: readonly ArenaObstacle[], x: number, z: number): number {
  let best = Infinity;
  for (const ob of solids) best = Math.min(best, surfaceDist(ob, x, z));
  return best;
}

/** Signed distance from (x,z) to a terrain disc's edge (negative inside). */
export function terrainDist(t: TerrainZoneDef, x: number, z: number): number {
  return Math.hypot(x - t.x, z - t.z) - t.radius;
}

/** Min distance between two segments (sampled; good to ~1 cm for the lengths used here). */
export function segSegDist(a: number[], b: number[]): number {
  let best = Infinity;
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    best = Math.min(best, segDist(a[0] + (a[2] - a[0]) * t, a[1] + (a[3] - a[1]) * t, b[0], b[1], b[2], b[3]));
  }
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    best = Math.min(best, segDist(b[0] + (b[2] - b[0]) * t, b[1] + (b[3] - b[1]) * t, a[0], a[1], a[2], a[3]));
  }
  return best;
}

export interface FreeSpace {
  /** Grid step (m). */
  step: number;
  /** Cells per side; cell (i,j) is at x = -half + i*step. */
  n: number;
  half: number;
  free: Uint8Array;
  /** Component id per free cell (-1 for blocked). */
  comp: Int32Array;
  /** Cell count per component id. */
  sizes: number[];
  cell(x: number, z: number): number;
}

/**
 * Free-space map of the arena for a body of `radius`: a grid cell is free when its centre is inside the wall
 * (minus the radius) and clear of every solid by `radius` (logs/crates included, conservatively: nobody is
 * assumed to hop them). Water / moss do NOT block. Connected components are labelled (4-neighbourhood).
 */
export function freeSpace(arena: ArenaDef, radius: number, step = 0.5): FreeSpace {
  const half = arena.wallRadius;
  const n = Math.ceil((half * 2) / step) + 1;
  const free = new Uint8Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = -half + i * step;
      const z = -half + j * step;
      if (Math.hypot(x, z) > arena.wallRadius - radius) continue;
      let ok = true;
      for (const ob of arena.solids) {
        if (surfaceDist(ob, x, z) < radius) {
          ok = false;
          break;
        }
      }
      if (ok) free[i * n + j] = 1;
    }
  }
  const comp = new Int32Array(n * n).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let s = 0; s < n * n; s++) {
    if (!free[s] || comp[s] >= 0) continue;
    const id = sizes.length;
    let count = 0;
    stack.push(s);
    comp[s] = id;
    while (stack.length > 0) {
      const c = stack.pop() as number;
      count++;
      const ci = Math.floor(c / n);
      const cj = c % n;
      const nb = [
        ci > 0 ? c - n : -1,
        ci < n - 1 ? c + n : -1,
        cj > 0 ? c - 1 : -1,
        cj < n - 1 ? c + 1 : -1,
      ];
      for (const q of nb) {
        if (q >= 0 && free[q] && comp[q] < 0) {
          comp[q] = id;
          stack.push(q);
        }
      }
    }
    sizes.push(count);
  }
  return {
    step,
    n,
    half,
    free,
    comp,
    sizes,
    cell(x: number, z: number): number {
      const i = Math.round((x + half) / step);
      const j = Math.round((z + half) / step);
      return i * n + j;
    },
  };
}

/** Component id of the free cell nearest to (x,z) (searching the 3x3 around the snapped cell); -1 if none free. */
export function componentAt(fs: FreeSpace, x: number, z: number): number {
  const i0 = Math.round((x + fs.half) / fs.step);
  const j0 = Math.round((z + fs.half) / fs.step);
  for (let r = 0; r <= 2; r++) {
    for (let di = -r; di <= r; di++) {
      for (let dj = -r; dj <= r; dj++) {
        const i = i0 + di;
        const j = j0 + dj;
        if (i < 0 || j < 0 || i >= fs.n || j >= fs.n) continue;
        const c = i * fs.n + j;
        if (fs.free[c]) return fs.comp[c];
      }
    }
  }
  return -1;
}

// ── v1.9: walking over a height field (ramps only; the cliff rule is the sim's) ─────────────────────────────────

export interface WalkSpace {
  step: number;
  n: number;
  half: number;
  free: Uint8Array;
  /** Cell index of the grid point nearest (x,z). */
  cell(x: number, z: number): number;
  /** Cell centre of cell `c`. */
  pos(c: number): { x: number; z: number };
  /** Walking distance (m) from the nearest free cell to (x0,z0) over the walk graph; Infinity = unreachable. */
  distFrom(x0: number, z0: number): Float64Array;
}

/**
 * Walk graph of a heightfield arena for a body of `radius`: a cell is walkable when it is inside the wall (minus the radius), clear
 * of every solid (conservative: logs / arches / crates all block) and `arenaCliffDistance ≥ radius` (the sim's cliff rule, so the
 * body can stand there). Two cells are joined (8-neighbourhood, a diagonal needs both orthogonal cells free) when
 * `arenaWalkableStep` allows the move. Dijkstra gives walking distances.
 */
export function walkSpace(arena: ArenaDef, radius: number, step = 0.5): WalkSpace {
  const half = arena.wallRadius;
  const n = Math.ceil((half * 2) / step) + 1;
  const free = new Uint8Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = -half + i * step;
      const z = -half + j * step;
      if (Math.hypot(x, z) > arena.wallRadius - radius) continue;
      let ok = true;
      for (const ob of arena.solids) {
        if (surfaceDist(ob, x, z) < radius) {
          ok = false;
          break;
        }
      }
      if (ok && arenaCliffDistance(arena, x, z) < radius - 1e-9) ok = false;
      if (ok) free[i * n + j] = 1;
    }
  }
  const cell = (x: number, z: number): number => Math.round((x + half) / step) * n + Math.round((z + half) / step);
  const pos = (c: number): { x: number; z: number } => ({ x: -half + Math.floor(c / n) * step, z: -half + (c % n) * step });
  const distFrom = (x0: number, z0: number): Float64Array => {
    const dist = new Float64Array(n * n).fill(Infinity);
    // start: nearest free cell within 1.5 m
    let start = -1;
    let bestD = Infinity;
    const c0 = cell(x0, z0);
    const i0 = Math.floor(c0 / n);
    const j0 = c0 % n;
    for (let di = -3; di <= 3; di++) {
      for (let dj = -3; dj <= 3; dj++) {
        const i = i0 + di;
        const j = j0 + dj;
        if (i < 0 || j < 0 || i >= n || j >= n || !free[i * n + j]) continue;
        const d = Math.hypot(-half + i * step - x0, -half + j * step - z0);
        if (d < bestD) {
          bestD = d;
          start = i * n + j;
        }
      }
    }
    if (start < 0) return dist;
    dist[start] = 0;
    // binary heap of [d, cell]
    const heap: number[][] = [[0, start]];
    const push = (e: number[]): void => {
      heap.push(e);
      let k = heap.length - 1;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (heap[p][0] <= heap[k][0]) break;
        [heap[p], heap[k]] = [heap[k], heap[p]];
        k = p;
      }
    };
    const pop = (): number[] => {
      const top = heap[0];
      const last = heap.pop() as number[];
      if (heap.length > 0) {
        heap[0] = last;
        let k = 0;
        for (;;) {
          const l = 2 * k + 1;
          const r = l + 1;
          let m = k;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === k) break;
          [heap[m], heap[k]] = [heap[k], heap[m]];
          k = m;
        }
      }
      return top;
    };
    while (heap.length > 0) {
      const [d, c] = pop();
      if (d > dist[c]) continue;
      const ci = Math.floor(c / n);
      const cj = c % n;
      const cp = pos(c);
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          if (di === 0 && dj === 0) continue;
          const i = ci + di;
          const j = cj + dj;
          if (i < 0 || j < 0 || i >= n || j >= n) continue;
          const q = i * n + j;
          if (!free[q]) continue;
          if (di !== 0 && dj !== 0 && (!free[(ci + di) * n + cj] || !free[ci * n + cj + dj])) continue;
          const qp = pos(q);
          if (!arenaWalkableStep(arena, cp.x, cp.z, qp.x, qp.z)) continue;
          const nd = d + (di !== 0 && dj !== 0 ? Math.SQRT2 : 1) * step;
          if (nd < dist[q]) {
            dist[q] = nd;
            push([nd, q]);
          }
        }
      }
    }
    return dist;
  };
  return { step, n, half, free, cell, pos, distFrom };
}
