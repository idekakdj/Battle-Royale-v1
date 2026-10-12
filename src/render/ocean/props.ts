/**
 * Ocean Dome props (WP-O3): coral pillars, rock outcrops, low coral arches, the sea-crate, the pickup pads. Every placement reads
 * the ARENA DATA (`arena.circles` kinds `coral` / `rock`, `arena.segments` kind `arch`, `arena.crates`, `arena.pickupPads`) and the
 * collider's `baseY`, so the scenery sits exactly where (and as high as) the sim's colliders are. Flat-shaded vertex colours; glowing
 * parts go to the unlit glow geometry (colours > 1 bloom). All deterministic (seeded by position), init-time only, node-safe.
 */

import * as THREE from 'three';
import type { ArenaCircle, ArenaDef, ArenaSegment } from '../../config/arenas';
import { arenaGroundHeight } from '../../config/arenas';
import { TAU } from '../../core/math';
import { VGeo, composeMat, hash2, mix, rgb, smoothstep, type VertexColorFn } from '../jungle/vgeo';
import { GLOW } from './terrain';

type RGB = [number, number, number];

const P = {
  rock: rgb(0x6b7e88),
  rockDark: rgb(0x465a64),
  rockLight: rgb(0x93a4a8),
  algae: rgb(0x3f7d62),
  coral: [rgb(0xe04f7b), rgb(0xf08a45), rgb(0x9a6bd6), rgb(0xe9c14a), rgb(0x4fc1b4)] as RGB[],
  coralTip: [rgb(0xff9ab2), rgb(0xffc07a), rgb(0xcfb0ff), rgb(0xfff0a0), rgb(0xa2f4e4)] as RGB[],
  wood: rgb(0x6c7d74),
  woodDark: rgb(0x445650),
  woodLight: rgb(0x8da096),
  rope: rgb(0xb89d6a),
  barnacle: rgb(0xcfd6c8),
  padStone: rgb(0xb8c3be),
  padInner: rgb(0xd7e2dc),
  padGroove: rgb(0x4d6b6b),
};

const _id = new THREE.Matrix4();

function solid(c: RGB, jit = 0.1, seed = 0): VertexColorFn {
  return (x, y, z, nx, ny, nz, out) => {
    const h = hash2(Math.floor(nx * 4 + 7) + seed, Math.floor(nz * 4 + ny * 3 + 3) + Math.floor(y * 2));
    const f = 1 - jit / 2 + h * jit;
    out[0] = c[0] * f;
    out[1] = c[1] * f;
    out[2] = c[2] * f;
    void x;
    void z;
  };
}

/** A displaced icosahedron rock lump (unit size), deterministic by `seed`. */
function lumpGeometry(seed: number, detail = 1, amp = 0.2): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const h = hash2(Math.round(x * 20) + seed, Math.round(y * 20) * 1.7 + Math.round(z * 20) * 0.9);
    const k = 1 - amp / 2 + h * amp;
    p.setXYZ(i, x * k, y * k, z * k);
  }
  g.computeVertexNormals();
  return g;
}

/** Rocky colour: blue-grey facets, darker toward the base, algae tint on up-facing facets, optional coral blush. */
function rockColor(blush: RGB | null, seed: number): VertexColorFn {
  return (x, y, z, nx, ny, nz, out) => {
    const facet = hash2(Math.floor(nx * 5 + 9) + seed, Math.floor(nz * 5 + ny * 4 + 13) + Math.floor(x * 0.6 + z * 0.6));
    const base = smoothstep(0.7, 0.0, y);
    const top = smoothstep(0.2, 0.8, ny);
    let r = mix(P.rock[0], P.rockLight[0], facet * 0.6);
    let g = mix(P.rock[1], P.rockLight[1], facet * 0.6);
    let b = mix(P.rock[2], P.rockLight[2], facet * 0.6);
    r = mix(r, P.rockDark[0], base * 0.5);
    g = mix(g, P.rockDark[1], base * 0.5);
    b = mix(b, P.rockDark[2], base * 0.5);
    const alg = base * 0.5 + top * 0.18 * smoothstep(0.4, 0.8, facet);
    r = mix(r, P.algae[0], alg);
    g = mix(g, P.algae[1], alg);
    b = mix(b, P.algae[2], alg);
    if (blush !== null) {
      const k = smoothstep(0.62, 0.9, facet) * smoothstep(0.1, 0.6, ny) * 0.8;
      r = mix(r, blush[0], k);
      g = mix(g, blush[1], k);
      b = mix(b, blush[2], k);
    }
    const sh = 0.82 + facet * 0.3;
    out[0] = r * sh;
    out[1] = g * sh;
    out[2] = b * sh;
  };
}

const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _d = new THREE.Vector3();

/** Add a tapered branch from `from` along `dir` (unit), `len` long, base radius `r0` -> tip `r1`. */
function addBranch(vg: VGeo, from: THREE.Vector3, dir: THREE.Vector3, len: number, r0: number, r1: number, col: VertexColorFn | RGB): void {
  const cyl = new THREE.CylinderGeometry(r1, r0, len, 6, 1);
  _q.setFromUnitVectors(_up, dir);
  _v.copy(from).addScaledVector(dir, len / 2);
  vg.add(cyl, new THREE.Matrix4().compose(_v, _q, new THREE.Vector3(1, 1, 1)), col as RGB);
  cyl.dispose();
}

// ── Coral pillar ─────────────────────────────────────────────────────────────

/** A tall branching coral column at the collider (x, z), standing on `baseY`; fingers + glowing tips. */
export function addCoralPillar(vg: VGeo, glow: VGeo, c: ArenaCircle): void {
  const seed = Math.floor(Math.abs(c.x * 7.3 + c.z * 3.1)) % 97;
  const hue = Math.floor(hash2(c.x, c.z) * P.coral.length);
  const col = P.coral[hue];
  const tip = P.coralTip[hue];
  const y0 = c.baseY ?? 0;
  const H = c.height;
  const R = c.radius;

  // Rocky foot (fills the collider footprint) + the ridged trunk.
  const foot = lumpGeometry(seed, 1, 0.25);
  vg.add(foot, composeMat(c.x, y0 + 0.28, c.z, 0, seed, 0, R * 0.98, 0.62, R * 0.98), rockColor(col, seed));
  foot.dispose();
  const trunk = new THREE.CylinderGeometry(R * 0.5, R * 0.68, H * 0.62, 10, 4);
  const tp = trunk.getAttribute('position');
  for (let i = 0; i < tp.count; i++) {
    const a = Math.atan2(tp.getZ(i), tp.getX(i));
    const k = 1 + Math.sin(a * 6 + tp.getY(i) * 1.4) * 0.09 + hash2(i + seed, 3) * 0.04;
    tp.setX(i, tp.getX(i) * k);
    tp.setZ(i, tp.getZ(i) * k);
  }
  trunk.computeVertexNormals();
  vg.add(trunk, composeMat(c.x, y0 + 0.5 + H * 0.31, c.z), (x, y, z, nx, ny, nz, out) => {
    const f = 0.85 + 0.25 * hash2(Math.floor(Math.atan2(nz, nx) * 4), Math.floor(y * 3) + seed);
    const lower = smoothstep(y0 + 1.6, y0 + 0.6, y) * 0.45;
    out[0] = mix(col[0], P.rock[0], lower) * f;
    out[1] = mix(col[1], P.rock[1], lower) * f;
    out[2] = mix(col[2], P.rock[2], lower) * f;
    void x;
    void z;
    void nx;
    void ny;
  });
  trunk.dispose();

  // Branching fingers near the top (glowing tips).
  const top = new THREE.Vector3(c.x, y0 + H * 0.82, c.z);
  const nBr = 6;
  for (let i = 0; i < nBr; i++) {
    const a = (i / nBr) * TAU + hash2(seed, i) * 0.7;
    const tilt = 0.45 + hash2(i, seed) * 0.5;
    _d.set(Math.cos(a) * Math.sin(tilt), Math.cos(tilt), Math.sin(a) * Math.sin(tilt)).normalize();
    const from = new THREE.Vector3(c.x + Math.cos(a) * R * 0.28, y0 + H * (0.55 + 0.1 * hash2(i, seed + 4)), c.z + Math.sin(a) * R * 0.28);
    const len = H * (0.26 + 0.1 * hash2(seed, i + 9));
    addBranch(vg, from, _d.clone(), len, R * 0.2, R * 0.1, solid(col, 0.2, i));
    const end = from.clone().addScaledVector(_d, len);
    // a forked tip
    for (let k = 0; k < 2; k++) {
      const a2 = a + (k === 0 ? 0.6 : -0.6) + hash2(i, k + seed) * 0.3;
      const d2 = new THREE.Vector3(Math.cos(a2) * 0.55, 0.85, Math.sin(a2) * 0.55).normalize();
      addBranch(vg, end, d2, len * 0.45, R * 0.1, R * 0.06, solid(tip, 0.15, k));
      const e2 = end.clone().addScaledVector(d2, len * 0.45);
      const nodule = new THREE.IcosahedronGeometry(R * 0.1, 0);
      glow.add(nodule, new THREE.Matrix4().makeTranslation(e2.x, e2.y, e2.z), [tip[0] * 1.7, tip[1] * 1.7, tip[2] * 1.7]);
      nodule.dispose();
    }
  }
  // A crown knob.
  const knob = lumpGeometry(seed + 5, 1, 0.2);
  vg.add(knob, composeMat(top.x, y0 + H * 0.78, top.z, 0, 0, 0, R * 0.42, R * 0.34, R * 0.42), solid(tip, 0.2, seed));
  knob.dispose();
  // Small brain-coral domes around the foot.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + hash2(seed, i) * 1.2;
    const d = R * (0.9 + 0.1 * hash2(i, seed));
    const dome = lumpGeometry(seed + i, 1, 0.18);
    const k2 = (hash2(i + 5, seed) + hash2(seed, i + 2)) * 0.5;
    vg.add(dome, composeMat(c.x + Math.cos(a) * d * 0.75, y0 + 0.14, c.z + Math.sin(a) * d * 0.75, 0, a, 0, 0.3, 0.22, 0.3), solid(P.coral[(hue + 1 + (k2 > 0.5 ? 1 : 0)) % P.coral.length], 0.25, i));
    dome.dispose();
  }
}

// ── Rock outcrop ─────────────────────────────────────────────────────────────

export function addRockOutcrop(vg: VGeo, glow: VGeo, c: ArenaCircle): void {
  const seed = Math.floor(Math.abs(c.x * 5.7 + c.z * 2.3)) % 89;
  const y0 = c.baseY ?? 0;
  const R = c.radius;
  const H = c.height;
  const blush = P.coral[seed % P.coral.length];
  const big = lumpGeometry(seed, 1, 0.35);
  vg.add(big, composeMat(c.x, y0 + H * 0.42, c.z, 0, seed, 0, R * 0.98, H * 0.46, R * 0.98), rockColor(blush, seed));
  big.dispose();
  const mid = lumpGeometry(seed + 3, 1, 0.35);
  vg.add(mid, composeMat(c.x + R * 0.22, y0 + H * 0.74, c.z - R * 0.15, 0, seed * 2, 0, R * 0.62, H * 0.3, R * 0.6), rockColor(blush, seed + 1));
  mid.dispose();
  const small = lumpGeometry(seed + 8, 1, 0.3);
  vg.add(small, composeMat(c.x - R * 0.5, y0 + H * 0.2, c.z + R * 0.45, 0, seed * 3, 0, R * 0.42, H * 0.22, R * 0.4), rockColor(null, seed + 2));
  small.dispose();
  // Anemone / sea-fan tufts on the shoulders.
  for (let i = 0; i < 3; i++) {
    const a = hash2(seed, i) * TAU;
    const px = c.x + Math.cos(a) * R * 0.5;
    const pz = c.z + Math.sin(a) * R * 0.5;
    const py = y0 + H * (0.7 + 0.12 * hash2(i, seed));
    addSeaFan(vg, px, py, pz, a, 0.5 + hash2(seed, i + 3) * 0.3, P.coral[(seed + i) % P.coral.length]);
    const nod = new THREE.IcosahedronGeometry(0.07, 0);
    glow.add(nod, new THREE.Matrix4().makeTranslation(px, py + 0.42, pz), [GLOW.amber[0], GLOW.amber[1], GLOW.amber[2]]);
    nod.dispose();
  }
}

/** A flat sea-fan (double-sided in the material): a fan of three triangles on a short stem. */
function addSeaFan(vg: VGeo, x: number, y: number, z: number, yaw: number, size: number, col: RGB): void {
  const stem = new THREE.CylinderGeometry(0.03, 0.045, size * 0.5, 5, 1);
  vg.add(stem, composeMat(x, y + size * 0.25, z), solid(P.rockDark, 0.1, 1));
  stem.dispose();
  const pos: number[] = [];
  const idx: number[] = [];
  const colr: number[] = [];
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const n = 7;
  const apex = [x, y + size * 0.45, z];
  pos.push(apex[0], apex[1], apex[2]);
  colr.push(col[0] * 0.7, col[1] * 0.7, col[2] * 0.7);
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1) - 0.5) * 1.9;
    const lx = Math.sin(t) * size * 0.8;
    const ly = size * 0.45 + Math.cos(t) * size * 0.6 + (i % 2) * size * 0.07;
    pos.push(x + lx * cy, y + ly, z + lx * sy);
    colr.push(col[0] * (0.85 + (i % 2) * 0.25), col[1] * (0.85 + (i % 2) * 0.25), col[2] * (0.85 + (i % 2) * 0.25));
  }
  for (let i = 1; i < n; i++) idx.push(0, i, i + 1);
  vg.addRaw(pos, idx, colr);
}

// ── Arch ─────────────────────────────────────────────────────────────────────

export function addCoralArch(vg: VGeo, glow: VGeo, s: ArenaSegment): void {
  const seed = Math.floor(Math.abs(s.ax * 3.3 + s.az * 5.1)) % 83;
  const y0 = s.baseY ?? 0;
  const dx = s.bx - s.ax;
  const dz = s.bz - s.az;
  const len = Math.hypot(dx, dz);
  const yaw = Math.atan2(dx, dz);
  const ux = dx / len;
  const uz = dz / len;
  const mx = (s.ax + s.bx) / 2;
  const mz = (s.az + s.bz) / 2;
  const H = s.height;
  const T = s.thickness / 2;
  // Two piers and a thick lintel with a low gap beneath, then fans on top.
  const pier = lumpGeometry(seed, 1, 0.25);
  for (const side of [-1, 1]) {
    const px = mx + ux * side * len * 0.36;
    const pz = mz + uz * side * len * 0.36;
    vg.add(pier, composeMat(px, y0 + H * 0.42, pz, 0, yaw + side, 0, T * 0.95, H * 0.5, T * 0.95), rockColor(P.coral[seed % P.coral.length], seed + side));
  }
  pier.dispose();
  const lintel = lumpGeometry(seed + 4, 1, 0.22);
  vg.add(lintel, composeMat(mx, y0 + H * 0.62, mz, 0, yaw, 0, T * 0.9, H * 0.34, len * 0.46), rockColor(P.coral[(seed + 1) % P.coral.length], seed + 9));
  lintel.dispose();
  for (let i = 0; i < 3; i++) {
    const t = (i - 1) * len * 0.3;
    addSeaFan(vg, mx + ux * t, y0 + H * 0.86, mz + uz * t, yaw + Math.PI / 2, 0.45 + 0.15 * hash2(seed, i), P.coral[(seed + i * 2) % P.coral.length]);
    const nod = new THREE.IcosahedronGeometry(0.075, 0);
    glow.add(nod, new THREE.Matrix4().makeTranslation(mx + ux * t, y0 + H * 0.9 + 0.5, mz + uz * t), [GLOW.pink[0], GLOW.pink[1], GLOW.pink[2]]);
    nod.dispose();
  }
}

// ── Pads ─────────────────────────────────────────────────────────────────────

/** A round coral-stone pad (radius 1.9) at (x, z) on `y`, with eight glowing rim lights. */
export function addPad(vg: VGeo, glow: VGeo, x: number, y: number, z: number, seed: number): void {
  const base = new THREE.CylinderGeometry(1.95, 2.05, 0.12, 40, 1);
  vg.add(base, composeMat(x, y + 0.06, z), P.padStone);
  base.dispose();
  const inner = new THREE.CylinderGeometry(1.55, 1.55, 0.04, 40, 1);
  vg.add(inner, composeMat(x, y + 0.13, z), P.padInner);
  inner.dispose();
  const groove = new THREE.TorusGeometry(1.72, 0.035, 5, 48);
  groove.rotateX(Math.PI / 2);
  vg.add(groove, composeMat(x, y + 0.135, z), P.padGroove);
  groove.dispose();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + hash2(seed, 1) * 0.2;
    const b = new THREE.IcosahedronGeometry(0.09, 0);
    glow.add(b, new THREE.Matrix4().makeTranslation(x + Math.cos(a) * 1.84, y + 0.17, z + Math.sin(a) * 1.84), i % 2 === 0 ? GLOW.teal : GLOW.pink);
    b.dispose();
  }
  // A few shells / pebbles around the pad.
  for (let i = 0; i < 5; i++) {
    const a = hash2(seed, i + 7) * TAU;
    const d = 2.25 + hash2(i, seed) * 0.5;
    const peb = lumpGeometry(seed + i, 0, 0.3);
    vg.add(peb, composeMat(x + Math.cos(a) * d, y + 0.07, z + Math.sin(a) * d, 0, a, 0, 0.16, 0.09, 0.14), solid(P.barnacle, 0.3, i));
    peb.dispose();
  }
}

// ── Crates ───────────────────────────────────────────────────────────────────

/** One sea-crate (1 m cube, origin at its CENTRE) as a single vertex-coloured geometry. */
export function buildSeaCrateGeometry(size: number): THREE.BufferGeometry {
  const vg = new VGeo();
  const h = size / 2;
  const body = new THREE.BoxGeometry(size * 0.96, size * 0.96, size * 0.96);
  vg.add(body, _id, (x, y, z, nx, ny, nz, out) => {
    const plank = Math.floor((y + h) / (size / 4));
    const f = 0.88 + 0.16 * hash2(plank * 3 + Math.floor(nx * 2), Math.floor(nz * 2) + plank);
    const seam = Math.abs(((y + h) / (size / 4)) % 1 - 0.0) < 0.05 ? 0.78 : 1;
    out[0] = P.wood[0] * f * seam;
    out[1] = P.wood[1] * f * seam;
    out[2] = P.wood[2] * f * seam;
    void x;
    void z;
    void ny;
  });
  body.dispose();
  // Corner posts + two bands
  const post = new THREE.BoxGeometry(size * 0.1, size, size * 0.1);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) vg.add(post, composeMat(sx * (h - size * 0.04), 0, sz * (h - size * 0.04)), P.woodDark);
  }
  post.dispose();
  for (const yy of [-0.28, 0.28]) {
    const band = new THREE.BoxGeometry(size * 1.02, size * 0.07, size * 1.02);
    vg.add(band, composeMat(0, yy * size, 0), P.woodLight);
    band.dispose();
  }
  // rope knot + barnacles
  const rope = new THREE.TorusGeometry(size * 0.16, size * 0.03, 5, 12);
  vg.add(rope, composeMat(0, 0.0, h + 0.005), P.rope);
  rope.dispose();
  for (let i = 0; i < 6; i++) {
    const b = new THREE.IcosahedronGeometry(size * 0.045, 0);
    const a = hash2(i, 4) * TAU;
    vg.add(b, composeMat(Math.cos(a) * h * 0.7, h * (0.2 + 0.7 * hash2(i, 9)) * (i % 2 === 0 ? 1 : -0.6), Math.sin(a) * h * 0.7 > 0 ? h * 0.97 : -h * 0.97), P.barnacle);
    b.dispose();
  }
  return vg.build();
}

/** Small plank for crate debris (origin at its centre). */
export function buildPlankGeometry(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(0.28, 0.1, 0.18);
}

// ── Public: all static props in two geometries ───────────────────────────────

export interface PropsGeometry {
  main: THREE.BufferGeometry;
  glow: THREE.BufferGeometry;
  stats: { coral: number; rocks: number; arches: number; pads: number };
}

export function buildOceanProps(arena: ArenaDef): PropsGeometry {
  const vg = new VGeo();
  const glow = new VGeo();
  const stats = { coral: 0, rocks: 0, arches: 0, pads: 0 };
  for (const c of arena.circles) {
    if (c.kind === 'coral') {
      addCoralPillar(vg, glow, c);
      stats.coral++;
    } else if (c.kind === 'rock') {
      addRockOutcrop(vg, glow, c);
      stats.rocks++;
    }
  }
  for (const s of arena.segments) {
    if (s.kind === 'arch') {
      addCoralArch(vg, glow, s);
      stats.arches++;
    }
  }
  arena.pickupPads.forEach((pad, i) => {
    addPad(vg, glow, pad.x, arenaGroundHeight(arena, pad.x, pad.z), pad.z, i + 1);
    stats.pads++;
  });
  return { main: vg.build(), glow: glow.build(), stats };
}
