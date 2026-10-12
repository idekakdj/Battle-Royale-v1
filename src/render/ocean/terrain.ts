/**
 * Ocean Dome terrain geometry (WP-O3): the seabed with its dunes outside the glass, and the THREE LEVELS built exactly from the
 * arena's `heightfield` (terrace ring, plateau, the nine ramps), every piece as a closed solid so the depth buffer reproduces
 * `arenaGroundHeight` (= the max over the pieces) wherever they overlap. Pure three geometry + the arena data, no DOM: node-safe.
 *
 *  - SEABED: flat (y = 0) over the whole dome footprint - the sim's ground there is flat - and rolling dunes beyond the glass that
 *    rise into a bowl at the horizon. Sand colours are vertex colours; the ripples are a shader effect (`materials.patchLit`).
 *  - CLIFFS: stratified rock walls with an inward (never outward: the collider is exact) noise bulge, coral patches near the base
 *    and a pale cap along the rim.
 *  - RAMPS: sloped stone slabs (grade from the arena data) with side walls down to the neighbouring level, raised kerbs along both
 *    edges and a glowing coral inlay + bulbs marking the edges (the glow goes to a second, unlit geometry).
 */

import * as THREE from 'three';
import type { ArenaDef, ElevationPiece } from '../../config/arenas';
import { arenaGroundHeight, elevationPieceHeight } from '../../config/arenas';
import { TAU } from '../../core/math';
import { VGeo, fbm2, hash2, mix, rgb, smoothstep } from '../jungle/vgeo';

// ── Dome constants ───────────────────────────────────────────────────────────

/** The glass dome's horizontal radius is the arena wall + this many metres. */
export const DOME_MARGIN = 2;
/** Dome height (m) above the seabed (an ellipsoidal half-dome, radius = wall + 2). */
export const DOME_HEIGHT = 22;

export function domeRadius(arena: ArenaDef): number {
  return arena.wallRadius + DOME_MARGIN;
}

// ── Palette (sRGB hex -> working colour) ─────────────────────────────────────

type RGB = [number, number, number];
const C = {
  sandA: rgb(0xb09c68),
  sandB: rgb(0x9d8a5a),
  sandWet: rgb(0x8f8a68),
  sandOut: rgb(0x7f9680),
  stoneTop: rgb(0xc4baa0),
  stoneTopB: rgb(0xb3a98c),
  plateau: rgb(0xd0c8b4),
  ramp: rgb(0xa88f62),
  rampB: rgb(0x937c52),
  rockA: rgb(0x42565f),
  rockB: rgb(0x5a7078),
  rockC: rgb(0x2f434b),
  rockD: rgb(0x6a7f84),
  algae: rgb(0x3f7a63),
  coralPink: rgb(0xd9577d),
  coralOrange: rgb(0xe98a48),
  coralPurple: rgb(0x8d62c9),
  kerb: rgb(0x9db1b6),
  kerbTop: rgb(0xc4d4d6),
};

export const GLOW = {
  teal: [0.35, 1.7, 1.5] as RGB,
  pink: [1.8, 0.55, 1.05] as RGB,
  amber: [1.9, 1.1, 0.35] as RGB,
  white: [1.6, 1.8, 1.8] as RGB,
};

function mixc(a: RGB, b: RGB, t: number, out: RGB): RGB {
  out[0] = mix(a[0], b[0], t);
  out[1] = mix(a[1], b[1], t);
  out[2] = mix(a[2], b[2], t);
  return out;
}

// ── Seabed ───────────────────────────────────────────────────────────────────

/** Seabed height (m): exactly 0 over the dome footprint, rolling dunes beyond the glass, rising into a bowl at the horizon. */
export function seabedHeight(x: number, z: number, flatRadius = 36): number {
  const r = Math.hypot(x, z);
  if (r <= flatRadius) return 0;
  const k = smoothstep(flatRadius, flatRadius + 14, r);
  const dunes = (fbm2(x * 0.042 + 3.1, z * 0.042 - 1.7) - 0.45) * 3.2 + Math.sin(x * 0.09 + fbm2(z * 0.05, x * 0.03) * 4) * 0.45;
  const bowl = smoothstep(80, 175, r) * 16;
  return k * dunes + bowl * k;
}

const SEABED_RADII: readonly number[] = [0, 5, 10, 15, 20, 25, 29, 32, 34, 36, 39, 43, 48, 54, 61, 70, 81, 94, 109, 126, 146, 168];

/** The big seabed disc: flat inside the dome, dunes outside. One vertex-coloured geometry. */
export function buildSeabedGeometry(arena: ArenaDef): THREE.BufferGeometry {
  const flat = domeRadius(arena) + 4;
  const na = 160;
  const radii = SEABED_RADII;
  const nr = radii.length;
  const pos = new Float32Array(nr * (na + 1) * 3);
  const col = new Float32Array(nr * (na + 1) * 3);
  const tmp: RGB = [0, 0, 0];
  for (let i = 0; i < nr; i++) {
    for (let j = 0; j <= na; j++) {
      const a = (j / na) * TAU;
      const r = radii[i];
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = seabedHeight(x, z, flat);
      const o = (i * (na + 1) + j) * 3;
      pos[o] = x;
      pos[o + 1] = y;
      pos[o + 2] = z;
      // Sand colour: warm inside the dome, cooler and greener outside, mottled by noise, darker in the troughs.
      const n = fbm2(x * 0.11 + 7, z * 0.11 - 3);
      const m = fbm2(x * 0.5, z * 0.5);
      mixc(C.sandA, C.sandB, n, tmp);
      const outside = smoothstep(flat - 1, flat + 14, r);
      mixc(tmp, C.sandOut, outside * 0.7, tmp);
      const patch = smoothstep(0.62, 0.8, fbm2(x * 0.23 - 5, z * 0.23 + 2));
      mixc(tmp, C.sandWet, patch * 0.5, tmp);
      const shade = 0.9 + m * 0.18 - (y < -0.2 ? 0.12 : 0);
      col[o] = tmp[0] * shade;
      col[o + 1] = tmp[1] * shade;
      col[o + 2] = tmp[2] * shade;
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < nr - 1; i++) {
    for (let j = 0; j < na; j++) {
      const a = i * (na + 1) + j;
      const b = a + 1;
      const c = a + (na + 1);
      const d = c + 1;
      // normal up: (a -> b) runs along +angle, (a -> c) along +radius, and +angle x +radius = +y
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
  g.computeVertexNormals();
  return g;
}

// ── Levels ───────────────────────────────────────────────────────────────────

/** Flip the triangles of a patch if the first one faces away from `want` (nx, ny, nz). */
function orient(pos: number[], idx: number[], first: number, want: [number, number, number]): void {
  const a = idx[first] * 3;
  const b = idx[first + 1] * 3;
  const c = idx[first + 2] * 3;
  const ux = pos[b] - pos[a];
  const uy = pos[b + 1] - pos[a + 1];
  const uz = pos[b + 2] - pos[a + 2];
  const vx = pos[c] - pos[a];
  const vy = pos[c + 1] - pos[a + 1];
  const vz = pos[c + 2] - pos[a + 2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  if (nx * want[0] + ny * want[1] + nz * want[2] < 0) {
    for (let t = first; t + 2 < idx.length; t += 3) {
      const tmp = idx[t + 1];
      idx[t + 1] = idx[t + 2];
      idx[t + 2] = tmp;
    }
  }
}

/** A growing triangle soup: add vertices (position + colour), then triangles by index. */
class Soup {
  pos: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  v(x: number, y: number, z: number, c: RGB): number {
    this.pos.push(x, y, z);
    this.col.push(c[0], c[1], c[2]);
    return this.pos.length / 3 - 1;
  }
  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }
  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }
  /** Orient the triangles added since `first` (index into idx) so they face `want`, then flush into `vg`. */
  flush(vg: VGeo, first: number, want: [number, number, number]): void {
    orient(this.pos, this.idx, first, want);
    vg.addRaw(this.pos, this.idx, this.col);
    this.pos = [];
    this.col = [];
    this.idx = [];
  }
}

const _c: RGB = [0, 0, 0];

/** A rocky stratified wall colour at height fraction `t` (0 base .. 1 rim), world position (x, y, z). */
function cliffColor(x: number, y: number, z: number, t: number, out: RGB): RGB {
  const n = fbm2(x * 0.35 + 11, z * 0.35 - 4);
  const band = Math.floor(y * 2.6 + n * 2.2);
  const k = ((band % 3) + 3) % 3;
  if (k === 0) out = mixc(C.rockA, C.rockB, 0.3 + 0.5 * n, out);
  else if (k === 1) out = mixc(C.rockC, C.rockA, 0.4 + 0.4 * n, out);
  else out = mixc(C.rockB, C.rockD, 0.2 + 0.5 * n, out);
  // coral patches (pink / orange / purple) low-mid on the wall
  const patch = smoothstep(0.7, 0.85, fbm2(x * 0.5 + 2, z * 0.5 + y * 0.9));
  if (patch > 0) {
    const pick = hash2(Math.floor(x * 0.5), Math.floor(z * 0.5));
    const cc = pick < 0.4 ? C.coralPink : pick < 0.75 ? C.coralOrange : C.coralPurple;
    mixc(out, cc, patch * (0.55 + 0.3 * (1 - t)), out);
  }
  // algae near the base, a pale cap at the rim
  const base = smoothstep(0.32, 0.0, t);
  mixc(out, C.algae, base * 0.55, out);
  const cap = smoothstep(0.88, 1.0, t);
  mixc(out, C.stoneTop, cap * 0.7, out);
  const sh = 0.86 + 0.2 * hash2(Math.floor(x * 3.1), Math.floor(z * 3.1 + y * 5));
  out[0] *= sh;
  out[1] *= sh;
  out[2] *= sh;
  return out;
}

/** Vertical wall of radius R (outward-facing when `outward`) from y0 to y1, bulging INWARD by a noise amount (never outward). */
function addCircularWall(vg: VGeo, R: number, y0: number, y1: number, outward: boolean, seed: number): void {
  const na = Math.max(64, Math.round(R * 8));
  const nb = Math.max(3, Math.ceil((y1 - y0) / 0.25));
  const soup = new Soup();
  const rows: number[][] = [];
  for (let j = 0; j <= nb; j++) {
    const t = j / nb;
    const y = y0 + (y1 - y0) * t;
    const row: number[] = [];
    for (let i = 0; i <= na; i++) {
      const a = (i / na) * TAU;
      const wrapA = i === na ? 0 : a;
      const ca = Math.cos(wrapA);
      const sa = Math.sin(wrapA);
      const bulge = Math.pow(Math.sin(Math.PI * t), 0.7);
      const d = (0.03 + 0.15 * fbm2(Math.cos(a) * R * 0.6 + seed, Math.sin(a) * R * 0.6 + y * 1.7)) * bulge;
      const r = outward ? R - d : R + d;
      const x = ca * r;
      const z = sa * r;
      cliffColor(ca * R, y, sa * R, t, _c);
      row.push(soup.v(x, y, z, [_c[0], _c[1], _c[2]]));
    }
    rows.push(row);
  }
  for (let j = 0; j < nb; j++) {
    for (let i = 0; i < na; i++) {
      soup.quad(rows[j][i], rows[j][i + 1], rows[j + 1][i + 1], rows[j + 1][i]);
    }
  }
  const mid = (y0 + y1) / 2;
  void mid;
  soup.flush(vg, 0, outward ? [1, 0, 0] : [-1, 0, 0]);
}

/** Horizontal disc / annulus top at height y between radii r0 and r1; colour by `shade(r, angle)`. */
function addAnnulusTop(vg: VGeo, r0: number, r1: number, y: number, colorAt: (x: number, z: number, r: number, edge: number, out: RGB) => RGB, step = 1.0): void {
  const na = Math.max(64, Math.round(r1 * 7));
  const span = r1 - r0;
  const nr = Math.max(2, Math.ceil(span / step));
  const radii: number[] = [];
  // dense rows near both edges (cliff AO / lip colours), looser in the middle
  for (let i = 0; i <= nr; i++) radii.push(r0 + (span * i) / nr);
  if (r0 > 0.5) radii.splice(1, 0, r0 + 0.2);
  radii.splice(radii.length - 1, 0, r1 - 0.2);
  const soup = new Soup();
  const rows: number[][] = [];
  for (let i = 0; i < radii.length; i++) {
    const r = radii[i];
    const row: number[] = [];
    for (let j = 0; j <= na; j++) {
      const a = (j / na) * TAU;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const edge = Math.min(r - r0 + (r0 > 0.5 ? 0 : 99), r1 - r);
      colorAt(x, z, r, edge, _c);
      row.push(soup.v(x, y, z, [_c[0], _c[1], _c[2]]));
    }
    rows.push(row);
  }
  for (let i = 0; i < rows.length - 1; i++) {
    for (let j = 0; j < na; j++) soup.quad(rows[i][j], rows[i + 1][j], rows[i + 1][j + 1], rows[i][j + 1]);
  }
  soup.flush(vg, 0, [0, 1, 0]);
}

function terraceColor(x: number, z: number, r: number, edge: number, out: RGB): RGB {
  const n = fbm2(x * 0.22 + 4, z * 0.22 + 9);
  mixc(C.stoneTop, C.stoneTopB, n, out);
  // concentric paving rings + radial seams
  const ring = Math.abs(Math.sin(r * 1.35));
  const seam = Math.abs(Math.sin(Math.atan2(z, x) * 10));
  const pave = 0.94 + 0.06 * smoothstep(0.25, 0.6, ring) * 0 + 0.05 * (ring > 0.95 ? -1 : 0) + 0.04 * (seam > 0.97 ? -1 : 0);
  const sand = smoothstep(0.55, 0.78, fbm2(x * 0.3 - 2, z * 0.3 + 5));
  mixc(out, C.sandA, sand * 0.55, out);
  const ao = 0.78 + 0.22 * smoothstep(0, 0.7, edge);
  const f = pave * ao * (0.92 + 0.14 * hash2(Math.floor(x * 2), Math.floor(z * 2)));
  out[0] *= f;
  out[1] *= f;
  out[2] *= f;
  return out;
}

function plateauColor(x: number, z: number, r: number, edge: number, out: RGB): RGB {
  mixc(C.plateau, C.stoneTopB, fbm2(x * 0.3, z * 0.3), out);
  // an inlaid mosaic: three rings and a centre medallion
  const ringHit = Math.abs(r - 2.2) < 0.12 || Math.abs(r - 5.1) < 0.14 || Math.abs(r - 7.4) < 0.1;
  if (ringHit) mixc(out, C.coralPurple, 0.55, out);
  if (r < 1.5) mixc(out, C.coralOrange, 0.35 * smoothstep(1.5, 0.9, r), out);
  const ao = 0.8 + 0.2 * smoothstep(0, 0.6, edge);
  out[0] *= ao;
  out[1] *= ao;
  out[2] *= ao;
  return out;
}

// ── Ramps ────────────────────────────────────────────────────────────────────

type Ramp = Extract<ElevationPiece, { kind: 'ramp' }>;

interface RampFrame {
  cx: number;
  cz: number;
  c: number;
  s: number;
  L: number;
  W: number;
  h0: number;
  h1: number;
}

function frameOf(p: Ramp): RampFrame {
  const a = (p.dirDeg * Math.PI) / 180;
  return { cx: p.x, cz: p.z, c: Math.cos(a), s: Math.sin(a), L: p.length, W: p.width, h0: p.h0, h1: p.h1 };
}

/** World position + surface height of the ramp at (u along from the LOW end 0..L, v lateral -W/2..W/2). */
function rampPoint(f: RampFrame, u: number, v: number, lift = 0): [number, number, number] {
  const a = u - f.L / 2;
  const x = f.cx + a * f.c - v * f.s;
  const z = f.cz + a * f.s + v * f.c;
  const y = f.h0 + (f.h1 - f.h0) * (u / f.L) + lift;
  return [x, y, z];
}

const KERB_W = 0.3;
const KERB_H = 0.2;
const INLAY_W = 0.09;

interface BuildOut {
  stats: { ramps: number; bulbs: number };
}

function addRamp(vg: VGeo, glow: VGeo, arena: ArenaDef, p: Ramp, out: BuildOut): void {
  const f = frameOf(p);
  const L = f.L;
  const W = f.W;
  // Ground beneath the ramp's low end (the neighbour level it climbs from): the side walls only go down to it.
  const low = rampPoint(f, 0, 0);
  let under = 0;
  for (const q of arena.heightfield ?? []) {
    if (q === p) continue;
    const e = elevationPieceHeight(q, low[0] - f.c * 0.15, low[2] - f.s * 0.15);
    if (e > under) under = e;
  }
  const bottom = Math.min(under, f.h0);

  const nu = 12;
  const nv = 6;
  const stripe = (i: number): number => (i % 2 === 0 ? 1 : 0.955);

  // Top surface.
  {
    const soup = new Soup();
    const rows: number[][] = [];
    for (let i = 0; i <= nu; i++) {
      const row: number[] = [];
      for (let j = 0; j <= nv; j++) {
        const u = (i / nu) * L;
        const v = (j / nv - 0.5) * W;
        const [x, y, z] = rampPoint(f, u, v);
        mixc(C.ramp, C.rampB, fbm2(x * 0.5, z * 0.5), _c);
        const centre = 1 - Math.abs(v) / (W / 2);
        const k = stripe(i) * (0.93 + 0.1 * centre);
        row.push(soup.v(x, y, z, [_c[0] * k, _c[1] * k, _c[2] * k]));
      }
      rows.push(row);
    }
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) soup.quad(rows[i][j], rows[i + 1][j], rows[i + 1][j + 1], rows[i][j + 1]);
    soup.flush(vg, 0, [0, 1, 0]);
  }

  // Uphill chevrons (dim emissive V marks pointing to the high end) so a ramp reads from across the dome.
  {
    const gcol = p.h1 > 2 ? GLOW.pink : GLOW.teal;
    const cc: RGB = [gcol[0] * 0.5, gcol[1] * 0.5, gcol[2] * 0.5];
    const soup = new Soup();
    for (let k = 0; k < 4; k++) {
      const u = L * (0.14 + k * 0.17);
      for (const side of [-1, 1]) {
        const a0 = rampPoint(f, u, side * 1.3, 0.018);
        const a1 = rampPoint(f, u + 0.18, side * 1.3, 0.018);
        const b1 = rampPoint(f, u + 0.78, 0, 0.018);
        const b0 = rampPoint(f, u + 0.6, 0, 0.018);
        const i0 = soup.v(a0[0], a0[1], a0[2], cc);
        const i1 = soup.v(a1[0], a1[1], a1[2], cc);
        const i2 = soup.v(b1[0], b1[1], b1[2], cc);
        const i3 = soup.v(b0[0], b0[1], b0[2], cc);
        soup.quad(i0, i1, i2, i3);
      }
    }
    soup.flush(glow, 0, [0, 1, 0]);
  }

  // Side walls (both sides) down to `bottom`.
  for (const side of [-1, 1]) {
    const soup = new Soup();
    const rows: number[][] = [];
    const nz = 3;
    for (let i = 0; i <= nu; i++) {
      const u = (i / nu) * L;
      const [x, yTop, z] = rampPoint(f, u, side * (W / 2));
      const row: number[] = [];
      for (let k = 0; k <= nz; k++) {
        const y = mix(yTop, bottom, k / nz);
        cliffColor(x, y, z, 1 - k / nz, _c);
        row.push(soup.v(x, y, z, [_c[0], _c[1], _c[2]]));
      }
      rows.push(row);
    }
    for (let i = 0; i < nu; i++) for (let k = 0; k < nz; k++) soup.quad(rows[i][k], rows[i + 1][k], rows[i + 1][k + 1], rows[i][k + 1]);
    // outward normal of the side = side * lateral axis (-s, c)
    soup.flush(vg, 0, [side * -f.s, 0, side * f.c]);
  }

  // Kerbs along both edges: top, inner and outer faces + end caps; the inlay + bulbs ride on the kerb top.
  const uEnd = L - 0.9; // the high end tucks under the next level
  const uStart = 0.5;
  const nk = 14;
  for (const side of [-1, 1]) {
    const vo = side * (W / 2);
    const vi = side * (W / 2 - KERB_W);

    // top face
    {
      const soup = new Soup();
      const row: Array<[number, number]> = [];
      for (let i = 0; i <= nk; i++) {
        const u = mix(uStart, uEnd, i / nk);
        const po = rampPoint(f, u, vo, KERB_H);
        const pi = rampPoint(f, u, vi, KERB_H);
        const kt = 0.96 + 0.06 * (i % 2);
        const col: RGB = [C.kerbTop[0] * kt, C.kerbTop[1] * kt, C.kerbTop[2] * kt];
        row.push([soup.v(po[0], po[1], po[2], col), soup.v(pi[0], pi[1], pi[2], col)]);
      }
      for (let i = 0; i < nk; i++) soup.quad(row[i][0], row[i + 1][0], row[i + 1][1], row[i][1]);
      soup.flush(vg, 0, [0, 1, 0]);
    }
    // inner and outer faces
    const faces: Array<{ v: number; shade: number; want: [number, number, number] }> = [
      { v: vi, shade: 1, want: [side * f.s, 0, -side * f.c] },
      { v: vo, shade: 0.9, want: [-side * f.s, 0, side * f.c] },
    ];
    for (const fc of faces) {
      const soup = new Soup();
      const row: Array<[number, number]> = [];
      for (let i = 0; i <= nk; i++) {
        const u = mix(uStart, uEnd, i / nk);
        const t = rampPoint(f, u, fc.v, KERB_H);
        const b = rampPoint(f, u, fc.v, 0);
        row.push([
          soup.v(t[0], t[1], t[2], [C.kerb[0] * fc.shade, C.kerb[1] * fc.shade, C.kerb[2] * fc.shade]),
          soup.v(b[0], b[1], b[2], [C.kerb[0] * 0.65 * fc.shade, C.kerb[1] * 0.65 * fc.shade, C.kerb[2] * 0.65 * fc.shade]),
        ]);
      }
      for (let i = 0; i < nk; i++) soup.quad(row[i][0], row[i + 1][0], row[i + 1][1], row[i][1]);
      soup.flush(vg, 0, fc.want);
    }
    // end caps (low end faces down the ramp, high end faces up it)
    for (const uc of [uStart, uEnd]) {
      const soup = new Soup();
      const a = rampPoint(f, uc, vo, KERB_H);
      const b = rampPoint(f, uc, vi, KERB_H);
      const a0 = rampPoint(f, uc, vo, 0);
      const b0 = rampPoint(f, uc, vi, 0);
      const q0 = soup.v(a[0], a[1], a[2], [C.kerbTop[0], C.kerbTop[1], C.kerbTop[2]]);
      const q1 = soup.v(b[0], b[1], b[2], [C.kerbTop[0], C.kerbTop[1], C.kerbTop[2]]);
      const q2 = soup.v(b0[0], b0[1], b0[2], [C.kerb[0], C.kerb[1], C.kerb[2]]);
      const q3 = soup.v(a0[0], a0[1], a0[2], [C.kerb[0], C.kerb[1], C.kerb[2]]);
      soup.quad(q0, q1, q2, q3);
      const dirSign = uc === uStart ? -1 : 1;
      soup.flush(vg, 0, [dirSign * f.c, 0, dirSign * f.s]);
    }

    // Glowing inlay (a thin emissive line along the kerb top) + bulbs.
    const glowCol = p.h1 > 2 ? GLOW.pink : GLOW.teal;
    const soupG = new Soup();
    const vm = side * (W / 2 - KERB_W / 2);
    const rowG: Array<[number, number]> = [];
    for (let i = 0; i <= nk; i++) {
      const u = mix(uStart + 0.1, uEnd - 0.1, i / nk);
      const a = rampPoint(f, u, vm - INLAY_W / 2, KERB_H + 0.012);
      const b = rampPoint(f, u, vm + INLAY_W / 2, KERB_H + 0.012);
      const pulse = 0.85 + 0.3 * (i % 2);
      const gc: RGB = [glowCol[0] * pulse, glowCol[1] * pulse, glowCol[2] * pulse];
      rowG.push([soupG.v(a[0], a[1], a[2], gc), soupG.v(b[0], b[1], b[2], gc)]);
    }
    for (let i = 0; i < nk; i++) soupG.quad(rowG[i][0], rowG[i + 1][0], rowG[i + 1][1], rowG[i][1]);
    soupG.flush(glow, 0, [0, 1, 0]);
    const bulb = new THREE.IcosahedronGeometry(0.1, 0);
    const bn = 6;
    for (let i = 0; i < bn; i++) {
      const u = mix(uStart + 0.4, uEnd - 0.3, i / (bn - 1));
      const q = rampPoint(f, u, vm, KERB_H + 0.1);
      glow.add(bulb, new THREE.Matrix4().makeTranslation(q[0], q[1], q[2]), glowCol);
      out.stats.bulbs++;
    }
    bulb.dispose();
  }
  out.stats.ramps++;
}

// ── Public builder ───────────────────────────────────────────────────────────

export interface LevelsGeometry {
  /** Lit, vertex-coloured: cliffs, tops, ramps, kerbs. */
  main: THREE.BufferGeometry;
  /** Unlit emissive: ramp inlays + bulbs + rim accents (colours > 1 so the bloom picks them up). */
  glow: THREE.BufferGeometry;
  stats: { ramps: number; bulbs: number; rings: number; plateaus: number };
}

/** Angular spans [centre, halfWidth] (radians) of the ramp mouths at radius R (to leave gaps in rim accents). */
function mouthSpans(arena: ArenaDef, R: number, rampH0: number, rampH1: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const q of arena.heightfield ?? []) {
    if (q.kind !== 'ramp') continue;
    if (Math.abs(q.h0 - rampH0) > 0.01 || Math.abs(q.h1 - rampH1) > 0.01) continue;
    const a = Math.atan2(q.z, q.x);
    out.push([a, Math.asin(Math.min(1, (q.width / 2 + 0.3) / R))]);
  }
  return out;
}

function inMouth(a: number, spans: Array<[number, number]>): boolean {
  for (const [c, h] of spans) {
    let d = a - c;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    if (Math.abs(d) < h) return true;
  }
  return false;
}

/** Dashed glowing accent along a circular rim (skips the ramp mouths). */
function addRimAccent(glow: VGeo, R: number, y: number, spans: Array<[number, number]>, color: RGB, phase: number): void {
  const dash = 0.8;
  const gap = 0.75;
  const n = Math.floor((TAU * R) / (dash + gap));
  const soup = new Soup();
  for (let i = 0; i < n; i++) {
    const a0 = (i * (dash + gap) / R) + phase;
    const a1 = a0 + dash / R;
    if (inMouth(a0, spans) || inMouth(a1, spans)) continue;
    const r0 = R - 0.17;
    const r1 = R - 0.07;
    const v0 = soup.v(Math.cos(a0) * r0, y + 0.012, Math.sin(a0) * r0, color);
    const v1 = soup.v(Math.cos(a0) * r1, y + 0.012, Math.sin(a0) * r1, color);
    const v2 = soup.v(Math.cos(a1) * r1, y + 0.012, Math.sin(a1) * r1, color);
    const v3 = soup.v(Math.cos(a1) * r0, y + 0.012, Math.sin(a1) * r0, color);
    soup.quad(v0, v1, v2, v3);
  }
  if (soup.idx.length > 0) soup.flush(glow, 0, [0, 1, 0]);
}

/** Build the three levels of an arena with a `heightfield`. Returns empty geometries for an arena without one. */
export function buildLevelsGeometry(arena: ArenaDef): LevelsGeometry {
  const vg = new VGeo();
  const glow = new VGeo();
  const out: BuildOut & { stats: LevelsGeometry['stats'] } = { stats: { ramps: 0, bulbs: 0, rings: 0, plateaus: 0 } };
  const hf = arena.heightfield ?? [];
  const plateaus = hf.filter((p) => p.kind === 'plateau') as Extract<ElevationPiece, { kind: 'plateau' }>[];
  let seed = 1.7;
  for (const p of hf) {
    if (p.kind === 'plateau') {
      addAnnulusTop(vg, 0, p.radius, p.height, plateauColor, 1.3);
      addCircularWall(vg, p.radius, 0, p.height, true, (seed += 3.3));
      out.stats.plateaus++;
      addRimAccent(glow, p.radius, p.height, mouthSpans(arena, p.radius, 1.5, p.height), GLOW.pink, 0.2);
    } else if (p.kind === 'ring') {
      // The inner part under the plateau is hidden: start the top where the plateau ends.
      const covered = plateaus.find((q) => q.height >= p.height && q.radius > p.rInner);
      const r0 = covered !== undefined ? covered.radius - 0.05 : p.rInner;
      addAnnulusTop(vg, r0, p.rOuter, p.height, terraceColor, 1.2);
      addCircularWall(vg, p.rOuter, 0, p.height, true, (seed += 3.3));
      if (covered === undefined && p.rInner > 0.5) addCircularWall(vg, p.rInner, 0, p.height, false, (seed += 3.3));
      out.stats.rings++;
      addRimAccent(glow, p.rOuter, p.height, mouthSpans(arena, p.rOuter, 0, p.height), GLOW.teal, 0.5);
    } else {
      addRamp(vg, glow, arena, p, out);
    }
  }
  return { main: vg.build(), glow: glow.build(), stats: out.stats };
}

/** Surface height of the visual levels at (x, z): by construction the arena's ground height (tests compare the two). */
export function levelsHeight(arena: ArenaDef, x: number, z: number): number {
  return arenaGroundHeight(arena, x, z);
}
