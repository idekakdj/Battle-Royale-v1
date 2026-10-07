/**
 * Jungle props (WP-J3): the static, merged-geometry scenery that is not a tree — fallen logs, pickup pads with flower beds, mossy
 * rocks, the wet-stone shoreline, lily pads, mushrooms, the wicker crate and its debris, the foliage-and-cliff ring that replaces
 * the colosseum stands, plus the reed / fern / glow-flower templates that are drawn instanced. Every placement reads the ARENA
 * DATA (`arena.segments`, `arena.pickupPads`, `arena.terrain`, `arena.wallRadius`, …); randomness is seeded so the clearing is the
 * same every time.
 *
 * All geometry is flat-shaded, vertex-coloured (the colosseum's flat-vector look) and built once at init.
 */

import * as THREE from 'three';
import type { ArenaDef, TerrainZoneDef } from '../../config/arenas';
import { mulberry32, TAU, type Rng } from '../../core/math';
import { VGeo, composeMat, hash2, mix, smoothstep, type VertexColorFn } from './vgeo';
import { buildLeafClumpGeometry } from './trees';
import { POOL_SURFACE_Y } from '../arenaContext';

// ── Palette ──────────────────────────────────────────────────────────────────
const ROCK = [0.4, 0.43, 0.38] as const;
const ROCK_DARK = [0.24, 0.27, 0.24] as const;
const MOSS_G = [0.27, 0.5, 0.16] as const;
const MOSS_LIME = [0.45, 0.68, 0.22] as const;
const LOG_BARK = [0.3, 0.22, 0.15] as const;
const LOG_CUT = [0.62, 0.5, 0.32] as const;
const STRAW = [0.72, 0.58, 0.32] as const;
const STRAW_DARK = [0.52, 0.4, 0.22] as const;
const STRAW_LIGHT = [0.84, 0.7, 0.4] as const;
const VINE = [0.2, 0.42, 0.14] as const;
const WOOD_DARK = [0.28, 0.2, 0.12] as const;

type RGB = readonly [number, number, number];

/** A rock-ish colour function: grey stone, moss-green on up-facing facets, darker streaks. */
function rockColor(mossy: number, base: RGB = ROCK): VertexColorFn {
  return (x, y, z, nx, ny, nz, out) => {
    const facet = hash2(Math.floor(nx * 5 + 9) + Math.floor(x * 0.7), Math.floor(nz * 5 + ny * 4 + 13) + Math.floor(z * 0.7));
    const top = smoothstep(0.1, 0.65, ny) * mossy;
    const lime = smoothstep(0.6, 0.95, facet) * top;
    const sh = 0.8 + facet * 0.36;
    const dark = smoothstep(0.55, 0.0, y) * 0.35;
    out[0] = mix(mix(base[0], ROCK_DARK[0], dark), mix(MOSS_G[0], MOSS_LIME[0], lime), top) * sh;
    out[1] = mix(mix(base[1], ROCK_DARK[1], dark), mix(MOSS_G[1], MOSS_LIME[1], lime), top) * sh;
    out[2] = mix(mix(base[2], ROCK_DARK[2], dark), mix(MOSS_G[2], MOSS_LIME[2], lime), top) * sh;
    void z;
  };
}

/** Displaced dodecahedron "rock" geometry (unit size), deterministic by `seed`. */
export function rockGeometry(seed: number, detail = 0): THREE.BufferGeometry {
  const g = new THREE.DodecahedronGeometry(1, detail);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const h = hash2(Math.round(x * 30) + seed, Math.round(y * 30) * 1.7 + Math.round(z * 30) * 0.9);
    const k = 0.82 + h * 0.36;
    p.setXYZ(i, x * k, y * k, z * k);
  }
  g.computeVertexNormals();
  return g;
}

function solidColor(c: RGB, jitter: number, rng: Rng): VertexColorFn {
  const f = 1 + (rng() - 0.5) * jitter;
  return (_x, _y, _z, nx, ny, nz, out) => {
    const sh = 0.85 + hash2(Math.floor(nx * 4 + 7), Math.floor(nz * 4 + ny * 3 + 3)) * 0.3;
    out[0] = c[0] * f * sh;
    out[1] = c[1] * f * sh;
    out[2] = c[2] * f * sh;
  };
}

// ── Logs ─────────────────────────────────────────────────────────────────────

export function addLogs(vg: VGeo, arena: ArenaDef, rng: Rng): void {
  const up = new THREE.Vector3(0, 1, 0);
  for (const seg of arena.segments) {
    if (seg.kind !== 'log') continue;
    const dx = seg.bx - seg.ax;
    const dz = seg.bz - seg.az;
    const len = Math.hypot(dx, dz);
    const dir = new THREE.Vector3(dx / len, 0, dz / len);
    const q = new THREE.Quaternion().setFromUnitVectors(up, dir);
    const rad = seg.thickness / 2 - 0.02;
    const cy = seg.height - rad;
    const mx = (seg.ax + seg.bx) / 2;
    const mz = (seg.az + seg.bz) / 2;

    // Bark trunk: ridged cylinder; mossy on top, pale cut wood on the end caps.
    const cyl = new THREE.CylinderGeometry(rad, rad * 1.04, len + 0.5, 12, 4);
    const pp = cyl.getAttribute('position');
    for (let i = 0; i < pp.count; i++) {
      const a = Math.atan2(pp.getZ(i), pp.getX(i));
      const ridge = 1 + Math.sin(a * 7 + pp.getY(i) * 1.3) * 0.045;
      pp.setX(i, pp.getX(i) * ridge);
      pp.setZ(i, pp.getZ(i) * ridge);
    }
    cyl.computeVertexNormals();
    const mat = new THREE.Matrix4().compose(new THREE.Vector3(mx, cy, mz), q, new THREE.Vector3(1, 1, 1));
    const axis = dir.clone();
    vg.add(cyl, mat, (x, y, z, nx, ny, nz, out) => {
      const along = nx * axis.x + nz * axis.z;
      if (Math.abs(along) > 0.85) {
        const rr = Math.hypot(x - mx - axis.x * ((x - mx) * axis.x + (z - mz) * axis.z), z - mz - axis.z * ((x - mx) * axis.x + (z - mz) * axis.z));
        const ring = 0.5 + 0.5 * Math.sin(rr * 26);
        out[0] = LOG_CUT[0] * (0.88 + ring * 0.14);
        out[1] = LOG_CUT[1] * (0.88 + ring * 0.14);
        out[2] = LOG_CUT[2] * (0.88 + ring * 0.14);
        return;
      }
      const moss = smoothstep(0.15, 0.7, ny) * (0.55 + 0.45 * hash2(Math.floor((x + z) * 1.7), Math.floor(y * 3)));
      const sh = 0.82 + hash2(Math.floor(nx * 6), Math.floor(nz * 6 + y * 5)) * 0.34;
      out[0] = mix(LOG_BARK[0], MOSS_G[0], moss) * sh;
      out[1] = mix(LOG_BARK[1], MOSS_G[1], moss) * sh;
      out[2] = mix(LOG_BARK[2], MOSS_G[2], moss) * sh;
    });
    cyl.dispose();

    // Moss cushion draped along the top + a pair of broken branch stubs + a few mushrooms.
    const cushion = rockGeometry(0x40 + Math.floor(len * 10), 0);
    for (let i = 0; i < 3; i++) {
      const t = (i + 0.5) / 3 - 0.5 + (rng() - 0.5) * 0.12;
      const px = mx + dir.x * len * t;
      const pz = mz + dir.z * len * t;
      vg.add(
        cushion,
        composeMat(px, seg.height - 0.04, pz, 0, Math.atan2(dir.x, dir.z), 0, rad * 0.9, rad * 0.3, len * 0.12 + 0.2),
        rockColor(1, [0.3, 0.5, 0.17]),
      );
    }
    cushion.dispose();
    for (const t of [-0.22, 0.31]) {
      const side = t < 0 ? 1 : -1;
      const px = mx + dir.x * len * t - dir.z * side * rad * 0.9;
      const pz = mz + dir.z * len * t + dir.x * side * rad * 0.9;
      const stub = new THREE.CylinderGeometry(0.07, 0.11, 0.55, 7);
      vg.add(stub, composeMat(px, cy + 0.15, pz, 0.8 * side, 0, -dir.z * 0.4), LOG_BARK);
      stub.dispose();
    }
    for (let i = 0; i < 4; i++) {
      const t = -0.45 + rng() * 0.9;
      const px = mx + dir.x * len * t - dir.z * rad * 0.92;
      const pz = mz + dir.z * len * t + dir.x * rad * 0.92;
      addMushroom(vg, px, seg.height - 0.28, pz, 0.7 + rng() * 0.6, rng);
    }
  }
}

export function addMushroom(vg: VGeo, x: number, y: number, z: number, scale: number, rng: Rng): void {
  const stalk = new THREE.CylinderGeometry(0.03 * scale, 0.045 * scale, 0.12 * scale, 6);
  vg.add(stalk, composeMat(x, y + 0.06 * scale, z), [0.88, 0.84, 0.7]);
  stalk.dispose();
  const cap = new THREE.SphereGeometry(0.1 * scale, 7, 4, 0, TAU, 0, Math.PI / 2);
  const caps: RGB[] = [[0.82, 0.3, 0.2], [0.88, 0.62, 0.2], [0.74, 0.5, 0.82], [0.9, 0.86, 0.72]];
  vg.add(cap, composeMat(x, y + 0.12 * scale, z), caps[Math.floor(rng() * caps.length)]);
  cap.dispose();
}

// ── Pads (stone discs with a flower bed) ─────────────────────────────────────

export function addPads(vg: VGeo, arena: ArenaDef, rng: Rng): void {
  const leaf = buildLeafClumpGeometry(0x9ad);
  for (const pad of arena.pickupPads) {
    const disc = new THREE.CylinderGeometry(1.35, 1.52, 0.14, 22);
    vg.add(disc, composeMat(pad.x, 0.07, pad.z), rockColor(0.55, [0.5, 0.52, 0.46]));
    disc.dispose();
    const rim = new THREE.RingGeometry(0.95, 1.2, 24);
    rim.rotateX(-Math.PI / 2);
    vg.add(rim, composeMat(pad.x, 0.148, pad.z), [0.78, 0.72, 0.46]);
    rim.dispose();
    const core = new THREE.RingGeometry(0.2, 0.36, 18);
    core.rotateX(-Math.PI / 2);
    vg.add(core, composeMat(pad.x, 0.148, pad.z), [0.7, 0.62, 0.36]);
    core.dispose();
    // Flower bed: leafy tufts with little blooms around the stone.
    const tufts = 11;
    for (let i = 0; i < tufts; i++) {
      const a = (i / tufts) * TAU + rng() * 0.3;
      const rr = 1.75 + rng() * 0.45;
      const px = pad.x + Math.cos(a) * rr;
      const pz = pad.z + Math.sin(a) * rr;
      const s = 0.16 + rng() * 0.1;
      vg.add(leaf, composeMat(px, 0.16, pz, 0, rng() * TAU, 0, s * 1.15, s * 1.25, s * 1.15), (x, y, z, nx, ny, nz, out) => {
        const t = hash2(Math.floor(nx * 5), Math.floor(nz * 5 + ny * 2));
        out[0] = 0.16 + t * 0.16;
        out[1] = 0.42 + t * 0.22;
        out[2] = 0.12 + t * 0.08;
        void x;
        void y;
        void z;
      });
      const blooms = 2 + Math.floor(rng() * 3);
      for (let b = 0; b < blooms; b++) {
        const bx = px + (rng() - 0.5) * 0.3;
        const bz = pz + (rng() - 0.5) * 0.3;
        const cone = new THREE.ConeGeometry(0.07, 0.12, 5);
        const bloom = rng();
        const c: RGB = bloom < 0.34 ? [0.95, 0.5, 0.7] : bloom < 0.67 ? [0.98, 0.92, 0.62] : [0.92, 0.95, 0.96];
        vg.add(cone, composeMat(bx, 0.36 + rng() * 0.15, bz, Math.PI, 0, 0), c);
        cone.dispose();
      }
    }
  }
  leaf.dispose();
}

// ── Rocks, shoreline stones, lily pads ───────────────────────────────────────

function waterZone(arena: ArenaDef): TerrainZoneDef | null {
  return arena.terrain.find((z) => z.kind === 'water') ?? null;
}

/** Whether (x, z) is clear of every solid, pad, spawn, moss disc and the pool (+margin) — for decorative scatter. */
export function isScatterClear(arena: ArenaDef, x: number, z: number, margin: number, allowWaterRim = false): boolean {
  if (Math.hypot(x, z) > arena.wallRadius - 1.5) return false;
  for (const c of arena.circles) {
    if (Math.hypot(x - c.x, z - c.z) < c.radius + margin) return false;
  }
  for (const s of arena.segments) {
    const ex = s.bx - s.ax;
    const ez = s.bz - s.az;
    const l2 = ex * ex + ez * ez;
    const t = Math.max(0, Math.min(1, ((x - s.ax) * ex + (z - s.az) * ez) / l2));
    if (Math.hypot(x - (s.ax + ex * t), z - (s.az + ez * t)) < s.thickness / 2 + margin) return false;
  }
  for (const c of arena.crates) {
    if (Math.abs(x - c.x) < c.halfX + margin && Math.abs(z - c.z) < c.halfZ + margin) return false;
  }
  for (const p of arena.pickupPads) {
    if (Math.hypot(x - p.x, z - p.z) < 2.2 + margin * 0.5) return false;
  }
  for (const s of arena.spawns) {
    if (Math.hypot(x - s.x, z - s.z) < 1.7 + margin * 0.5) return false;
  }
  for (const t of arena.terrain) {
    const pad = t.kind === 'water' && allowWaterRim ? 0 : margin * 0.5;
    if (Math.hypot(x - t.x, z - t.z) < t.radius + pad) return false;
  }
  return true;
}

export function addRocks(vg: VGeo, arena: ArenaDef, rng: Rng): void {
  const water = waterZone(arena);
  // Wet shoreline stones: flat, low, ringing the pool (gaps left so animals wade in anywhere).
  if (water !== null) {
    for (let i = 0; i < 46; i++) {
      const a = (i / 46) * TAU + (rng() - 0.5) * 0.12;
      if (hash2(Math.floor(a * 3.1), 7) > 0.78) continue; // natural gaps
      const rr = water.radius + 0.25 + rng() * 0.95;
      const x = water.x + Math.cos(a) * rr;
      const z = water.z + Math.sin(a) * rr;
      const s = 0.2 + rng() * 0.3;
      const g = rockGeometry(i * 3 + 1, 0);
      vg.add(g, composeMat(x, 0.02, z, 0, rng() * TAU, 0, s, s * (0.3 + rng() * 0.25), s * (0.7 + rng() * 0.5)), rockColor(0.25, [0.36, 0.4, 0.36]));
      g.dispose();
    }
    // A few taller boulders on the bank.
    for (let i = 0; i < 9; i++) {
      const a = rng() * TAU;
      const rr = water.radius + 1.5 + rng() * 1.6;
      const x = water.x + Math.cos(a) * rr;
      const z = water.z + Math.sin(a) * rr;
      if (!isScatterClear(arena, x, z, 0.9, true)) continue;
      const s = 0.42 + rng() * 0.45;
      const g = rockGeometry(100 + i, 0);
      vg.add(g, composeMat(x, s * 0.28, z, 0, rng() * TAU, 0, s * 1.2, s * 0.7, s), rockColor(0.85));
      g.dispose();
    }
  }
  // Mossy rocks scattered over the clearing.
  let placed = 0;
  for (let tries = 0; tries < 400 && placed < 34; tries++) {
    const a = rng() * TAU;
    const rr = 3 + Math.sqrt(rng()) * (arena.wallRadius - 5);
    const x = Math.cos(a) * rr;
    const z = Math.sin(a) * rr;
    if (!isScatterClear(arena, x, z, 0.9)) continue;
    placed++;
    const s = 0.22 + rng() * rng() * 0.8;
    const g = rockGeometry(200 + placed, 0);
    vg.add(g, composeMat(x, s * 0.3, z, 0, rng() * TAU, 0, s * (0.9 + rng() * 0.5), s * (0.5 + rng() * 0.3), s), rockColor(0.6 + rng() * 0.4));
    g.dispose();
    if (rng() < 0.3) addMushroom(vg, x + s * 0.8, 0, z, 0.8 + rng() * 0.6, rng);
  }
}

export function addLilyPads(vg: VGeo, arena: ArenaDef, rng: Rng): void {
  const water = waterZone(arena);
  if (water === null) return;
  const full = water.radius - 1.4;
  const placed: { x: number; z: number; r: number }[] = [];
  for (let tries = 0; tries < 200 && placed.length < 11; tries++) {
    const a = rng() * TAU;
    const rr = Math.sqrt(rng()) * full;
    const x = water.x + Math.cos(a) * rr;
    const z = water.z + Math.sin(a) * rr;
    const r = 0.28 + rng() * 0.2;
    if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < p.r + r + 0.25)) continue;
    placed.push({ x, z, r });
    const pad = new THREE.CircleGeometry(r, 10, 0.3, TAU - 0.5);
    pad.rotateX(-Math.PI / 2);
    const tone = 0.8 + rng() * 0.35;
    vg.add(pad, composeMat(x, POOL_SURFACE_Y + 0.035, z, 0, rng() * TAU, 0), (px, py, pz, nx, ny, nz, out) => {
      const d = Math.hypot(px - x, pz - z) / r;
      out[0] = (0.14 + 0.1 * d) * tone;
      out[1] = (0.4 + 0.12 * (1 - d)) * tone;
      out[2] = 0.13 * tone;
      void py;
      void nx;
      void ny;
      void nz;
    });
    pad.dispose();
    if (rng() < 0.4) {
      const lotus = new THREE.ConeGeometry(0.11, 0.2, 6);
      vg.add(lotus, composeMat(x + r * 0.2, POOL_SURFACE_Y + 0.14, z, Math.PI, 0, 0), [0.96, 0.62, 0.78]);
      lotus.dispose();
      const heart = new THREE.SphereGeometry(0.04, 5, 4);
      vg.add(heart, composeMat(x + r * 0.2, POOL_SURFACE_Y + 0.1, z), [0.98, 0.86, 0.3]);
      heart.dispose();
    }
  }
}

// ── Crates (wicker + vine) ───────────────────────────────────────────────────

/** Local-origin wicker crate of edge `size` (matches the collider; the instance matrix lifts it by size / 2). */
export function buildWickerCrateGeometry(size: number): THREE.BufferGeometry {
  const vg = new VGeo();
  const s = size * 0.98;
  const id = new THREE.Matrix4();
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, c: RGB | VertexColorFn): void => {
    const g = new THREE.BoxGeometry(w, h, d);
    vg.add(g, composeMat(x, y, z), c);
    g.dispose();
  };
  void id;
  // Woven body.
  box(s, s, s, 0, 0, 0, (x, y, _z, nx, ny, nz, out) => {
    const band = Math.floor((y / s + 0.5) * 8);
    const weave = band % 2 === 0 ? 0 : 1;
    const t = hash2(Math.floor(x * 9) + band * 3, Math.floor(_z * 9) + band);
    const c = weave === 0 ? STRAW : STRAW_DARK;
    out[0] = c[0] * (0.88 + t * 0.2);
    out[1] = c[1] * (0.88 + t * 0.2);
    out[2] = c[2] * (0.88 + t * 0.2);
    void nx;
    void ny;
    void nz;
  });
  // Wicker bands proud of the surface.
  for (let i = 0; i < 4; i++) {
    const y = -s * 0.36 + i * s * 0.24;
    box(s + 0.035, s * 0.07, s + 0.035, 0, y, 0, i % 2 === 0 ? STRAW_LIGHT : STRAW_DARK);
  }
  // Corner posts.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(0.09, s + 0.04, 0.09, sx * s * 0.5, 0, sz * s * 0.5, WOOD_DARK);
  // Vine rope around the middle, tied off with a leafy knot on top.
  box(s + 0.07, 0.06, s + 0.07, 0, 0.02, 0, VINE);
  const leaf = buildLeafClumpGeometry(0x77);
  vg.add(leaf, composeMat(s * 0.15, s * 0.5 + 0.02, -s * 0.1, 0, 0.6, 0, 0.18, 0.1, 0.18), solidColor([0.24, 0.52, 0.17], 0.4, mulberry32(3)));
  leaf.dispose();
  const g = vg.build();
  return g;
}

// ── Wall: mossy cliff + dense foliage (replaces the stands) ──────────────────

export interface WallGeometry {
  /** The cliff + foliage right behind the arena edge (every tier). */
  main: THREE.BufferGeometry;
  /** Taller foliage / trunks beyond it (hidden on the `low` tier). */
  backdrop: THREE.BufferGeometry;
}

export function buildWallGeometry(arena: ArenaDef, seed = 0x3a11): WallGeometry {
  const rng = mulberry32(seed);
  const R = arena.wallRadius;
  const main = new VGeo();
  const back = new VGeo();
  const leaf = buildLeafClumpGeometry(0x4d);
  const leafColor: VertexColorFn = (x, y, z, nx, ny, nz, out) => {
    const top = Math.max(0, Math.min(1, ny * 0.5 + 0.5));
    const facet = hash2(Math.floor(nx * 6 + 11), Math.floor(nz * 6 + ny * 3 + 17));
    out[0] = mix(0.09, 0.3, top) * (0.85 + facet * 0.3);
    out[1] = mix(0.26, 0.56, top) * (0.85 + facet * 0.3);
    out[2] = mix(0.09, 0.15, top) * (0.85 + facet * 0.3);
    void x;
    void y;
    void z;
  };

  // Light gaps in the cliff.
  const gaps: number[] = [];
  for (let i = 0; i < 6; i++) gaps.push(((i + 0.3 + rng() * 0.4) / 6) * TAU);
  const inGap = (a: number): number => {
    let m = 0;
    for (const g of gaps) {
      let d = Math.abs(a - g);
      d = Math.min(d, TAU - d);
      m = Math.max(m, 1 - smoothstep(0.05, 0.16, d));
    }
    return m; // 1 in a gap centre
  };

  // Cliff blocks.
  const N = 46;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * TAU + (rng() - 0.5) * 0.04;
    const gap = inGap(a);
    const r = R + 0.7 + rng() * 0.9;
    const arc = ((TAU * r) / N) * (1.2 + rng() * 0.3);
    const h = mix(3.4 + rng() * 3.0, 0.9 + rng() * 0.6, gap);
    const d = 1.5 + rng() * 1.1;
    const g = rockGeometry(300 + i, 0);
    const yaw = -a + (rng() - 0.5) * 0.3;
    main.add(g, composeMat(Math.cos(a) * r, h * 0.42, Math.sin(a) * r, 0, yaw, 0, arc * 0.55, h * 0.55, d), rockColor(0.75 + rng() * 0.25, [0.36, 0.4, 0.33]));
    g.dispose();
    // A second, smaller stone higher up / in front for a stacked-cliff silhouette.
    const g2 = rockGeometry(500 + i, 0);
    main.add(
      g2,
      composeMat(Math.cos(a + 0.02) * (r - 0.8), h * 0.2, Math.sin(a + 0.02) * (r - 0.8), 0, yaw + 0.5, 0, arc * 0.32, h * 0.26, d * 0.7),
      rockColor(0.6 + rng() * 0.4, [0.38, 0.41, 0.35]),
    );
    g2.dispose();
  }

  // Dense foliage on and in front of the cliff.
  for (let i = 0; i < 96; i++) {
    const a = rng() * TAU;
    const gap = inGap(a);
    if (gap > 0.6 && rng() < 0.7) continue;
    const r = R + 0.25 + rng() * 2.4;
    const s = 1.0 + rng() * 1.5;
    const y = 1.0 + rng() * (5.2 - gap * 3);
    main.add(leaf, composeMat(Math.cos(a) * r, y, Math.sin(a) * r, 0, rng() * TAU, 0, s * 1.25, s * 0.95, s * 1.1), leafColor);
  }

  // Backdrop: tall foliage domes + dark trunk silhouettes beyond the wall.
  for (let i = 0; i < 54; i++) {
    const a = (i / 54) * TAU + rng() * 0.1;
    const r = R + 4 + rng() * 9;
    const s = 3.6 + rng() * 3.8;
    back.add(leaf, composeMat(Math.cos(a) * r, 5 + rng() * 8, Math.sin(a) * r, 0, rng() * TAU, 0, s * 1.2, s * 0.9, s * 1.2), leafColor);
  }
  for (let i = 0; i < 22; i++) {
    const a = rng() * TAU;
    const r = R + 2.5 + rng() * 7;
    const rad = 0.7 + rng() * 0.9;
    const trunk = new THREE.CylinderGeometry(rad * 0.8, rad * 1.1, 16, 8);
    back.add(trunk, composeMat(Math.cos(a) * r, 7.5, Math.sin(a) * r), solidColor([0.26, 0.2, 0.14], 0.4, rng));
    trunk.dispose();
  }
  leaf.dispose();
  return { main: main.build(), backdrop: back.build() };
}

// ── Instanced templates ──────────────────────────────────────────────────────

/** A clump of tall reed blades with cattail heads (double-sided strips). Unit height ≈ 1.5 m. */
export function buildReedGeometry(seed = 0x4eed): THREE.BufferGeometry {
  const rng = mulberry32(seed);
  const vg = new VGeo();
  const blades = 9;
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * TAU + rng() * 0.5;
    const rr = 0.04 + rng() * 0.12;
    const h = 1.0 + rng() * 0.7;
    const lean = 0.12 + rng() * 0.25;
    const w = 0.035 + rng() * 0.02;
    const bx = Math.cos(a) * rr;
    const bz = Math.sin(a) * rr;
    const lx = Math.cos(a);
    const lz = Math.sin(a);
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const SEG = 3;
    for (let i = 0; i <= SEG; i++) {
      const s = i / SEG;
      const ox = bx + lx * lean * s * s * h;
      const oz = bz + lz * lean * s * s * h;
      const ww = w * (1 - 0.8 * s);
      // blade faces perpendicular to lean direction: width along (-lz, lx)
      pos.push(ox - lz * ww, h * s, oz + lx * ww, ox + lz * ww, h * s, oz - lx * ww);
      const g = mix(0.28, 0.62, s) * (0.85 + rng() * 0.2);
      const c: RGB = [mix(0.14, 0.44, s * s) * (0.9 + rng() * 0.2), g, mix(0.1, 0.18, s)];
      col.push(c[0], c[1], c[2], c[0], c[1], c[2]);
    }
    for (let i = 0; i < SEG; i++) {
      const a0 = i * 2;
      idx.push(a0, a0 + 2, a0 + 1, a0 + 1, a0 + 2, a0 + 3); // single winding: the material is DoubleSide
    }
    vg.addRaw(pos, idx, col);
    if (b % 3 === 0) {
      const head = new THREE.CylinderGeometry(0.032, 0.032, 0.2, 5);
      vg.add(head, composeMat(bx + lx * lean * h, h * 0.86, bz + lz * lean * h), [0.36, 0.22, 0.12]);
      head.dispose();
    }
  }
  return vg.build();
}

/** A fern crown: 8 curved lanceolate fronds. Unit radius ≈ 0.6 m, height ≈ 0.5 m. */
export function buildFernGeometry(seed = 0xfe12): THREE.BufferGeometry {
  const rng = mulberry32(seed);
  const vg = new VGeo();
  const fronds = 7;
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * TAU + (rng() - 0.5) * 0.35;
    const len = 0.5 + rng() * 0.22;
    const lift = 0.5 + rng() * 0.5;
    const lx = Math.cos(a);
    const lz = Math.sin(a);
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const SEG = 4;
    for (let i = 0; i <= SEG; i++) {
      const s = i / SEG;
      const ox = lx * len * s;
      const oz = lz * len * s;
      const oy = Math.sin(s * Math.PI * 0.8) * lift * 0.34 - s * s * 0.1 + 0.03;
      const w = 0.11 * Math.sin(Math.min(1, s * 1.05 + 0.08) * Math.PI) * (1 - 0.25 * s) + 0.005;
      // zig-zag leaflet edge
      const zig = i % 2 === 0 ? 1 : 0.68;
      pos.push(ox - lz * w * zig, oy, oz + lx * w * zig, ox + lz * w * zig, oy, oz - lx * w * zig);
      const g = mix(0.32, 0.62, s);
      const c: RGB = [mix(0.1, 0.3, s), g, mix(0.08, 0.14, s)];
      col.push(c[0], c[1], c[2], c[0], c[1], c[2]);
    }
    for (let i = 0; i < SEG; i++) {
      const a0 = i * 2;
      idx.push(a0, a0 + 2, a0 + 1, a0 + 1, a0 + 2, a0 + 3); // single winding: the material is DoubleSide
    }
    vg.addRaw(pos, idx, col);
  }
  return vg.build();
}

/**
 * A glowing jungle flower: a ring of six pointed petals around a bright core. Unlit material (MeshBasic) with colours pushed
 * above 1 through the instance colour so the high tier's bloom makes them glow. Unit radius ≈ 0.14 m.
 */
export function buildGlowFlowerGeometry(): THREE.BufferGeometry {
  const vg = new VGeo();
  const petals = 6;
  for (let i = 0; i < petals; i++) {
    const a = (i / petals) * TAU;
    const petal = new THREE.ConeGeometry(0.045, 0.16, 4);
    petal.translate(0, 0.08, 0);
    vg.add(petal, composeMat(Math.cos(a) * 0.045, 0.05, Math.sin(a) * 0.045, Math.sin(a) * 1.15, 0, -Math.cos(a) * 1.15), [0.9, 0.9, 0.9]);
    petal.dispose();
  }
  const core = new THREE.IcosahedronGeometry(0.05, 0);
  vg.add(core, composeMat(0, 0.06, 0), [1, 1, 0.8]);
  core.dispose();
  return vg.build();
}
