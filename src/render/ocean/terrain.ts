/**
 * Ocean Dome terrain geometry (WP-O3, v1.10 WP-H4): the seabed with its dunes outside the glass, and the levels built exactly from the
 * arena's `heightfield` (terrace ring, plateau, the level ramps, and since v1.10 the UPPER TIER: sea-stack towers with their two-piece
 * causeway / chord climbs), every piece as a closed solid so the depth buffer reproduces `arenaGroundHeight` (= the max over the
 * pieces) wherever they overlap. Pure three geometry + the arena data, no DOM: node-safe.
 *
 *  - SEABED: flat (y = 0) over the whole dome footprint - the sim's ground there is flat - and rolling dunes beyond the glass that
 *    rise into a bowl at the horizon. Sand colours are vertex colours; the ripples are a shader effect (`materials.patchLit`).
 *  - CLIFFS: stratified rock walls with an inward (never outward: the collider is exact) noise bulge, coral patches near the base
 *    and a pale cap along the rim.
 *  - RAMPS: sloped stone slabs (grade from the arena data) with side walls down to the ground beneath (sampled along the wedge, so a
 *    causeway standing on the terrace is a solid dike, not a bridge), raised kerbs along both edges and a glowing coral inlay + bulbs
 *    marking the edges (the glow goes to a second, unlit geometry). A climb made of two pieces (a long lower slab and a short gentle top
 *    piece) is drawn as ONE ramp: the lower slab / kerbs / walls stop exactly where the top piece starts (no overlap, no hairline).
 *  - TOWERS (sea-stacks, tops in the high serpent band): sheer eroded cliffs with ledges and strata, a flat plaza top with a low
 *    glowing parapet that opens at the ramp mouths. Their coral crowns are in props.ts.
 */

import * as THREE from 'three';
import type { ArenaDef, ElevationPiece } from '../../config/arenas';
import { arenaGroundHeight, elevationPieceHeight } from '../../config/arenas';
import { TAU } from '../../core/math';
import { VGeo, fbm2, hash2, mix, rgb, smoothstep } from '../jungle/vgeo';
import { DOME_HEIGHT, DOME_MARGIN, domeRadiusFor } from './domeShape';

// ── Dome constants ───────────────────────────────────────────────────────────

export { DOME_MARGIN, DOME_HEIGHT };

export function domeRadius(arena: ArenaDef): number {
  return domeRadiusFor(arena.wallRadius);
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
  rockViolet: rgb(0x53517a),
  rockVioletLight: rgb(0x7a78a6),
  towerTop: rgb(0xcfc8d8),
  towerTopB: rgb(0xb7b0c6),
  parapet: rgb(0xb9b3cf),
  parapetTop: rgb(0xd9d4ea),
  rampUp: rgb(0xa08a78),
  rampUpB: rgb(0x8b7568),
};

export const GLOW = {
  teal: [0.35, 1.7, 1.5] as RGB,
  pink: [1.8, 0.55, 1.05] as RGB,
  amber: [1.9, 1.1, 0.35] as RGB,
  white: [1.6, 1.8, 1.8] as RGB,
  /** The upper tier's accent: the high serpent's violet. */
  violet: [1.25, 0.5, 2.2] as RGB,
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

/** Flip the triangles of a patch if its first non-degenerate one faces away from `want` (nx, ny, nz). */
function orient(pos: number[], idx: number[], first: number, want: [number, number, number]): void {
  for (let f = first; f + 2 < idx.length; f += 3) {
    const a = idx[f] * 3;
    const b = idx[f + 1] * 3;
    const c = idx[f + 2] * 3;
    const ux = pos[b] - pos[a];
    const uy = pos[b + 1] - pos[a + 1];
    const uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a];
    const vy = pos[c + 1] - pos[a + 1];
    const vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    if (nx * nx + ny * ny + nz * nz < 1e-14) continue; // a degenerate (zero-area) triangle says nothing about the winding
    if (nx * want[0] + ny * want[1] + nz * want[2] < 0) {
      for (let t = first; t + 2 < idx.length; t += 3) {
        const tmp = idx[t + 1];
        idx[t + 1] = idx[t + 2];
        idx[t + 2] = tmp;
      }
    }
    return;
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

/** A rocky stratified wall colour at height fraction `t` (0 base .. 1 rim), world position (x, y, z). `hi`: the upper tier's cooler, thinner strata. */
function cliffColor(x: number, y: number, z: number, t: number, out: RGB, hi = false): RGB {
  const n = fbm2(x * 0.35 + 11, z * 0.35 - 4);
  const band = Math.floor(y * (hi ? 3.6 : 2.6) + n * 2.2);
  const k = ((band % 3) + 3) % 3;
  if (k === 0) out = mixc(C.rockA, C.rockB, 0.3 + 0.5 * n, out);
  else if (k === 1) out = mixc(C.rockC, C.rockA, 0.4 + 0.4 * n, out);
  else out = mixc(C.rockB, C.rockD, 0.2 + 0.5 * n, out);
  if (hi) {
    // violet-tinted layers every other band + a dark seam line between strata: reads as a different, higher tier of rock
    mixc(out, k === 2 ? C.rockVioletLight : C.rockViolet, k === 1 ? 0.18 : 0.34, out);
    const seam = Math.abs(((y * 3.6 + n * 2.2) % 1) - 0.5);
    if (seam > 0.46) {
      out[0] *= 0.72;
      out[1] *= 0.72;
      out[2] *= 0.76;
    }
  }
  // coral patches (pink / orange / purple) low-mid on the wall
  const patch = smoothstep(hi ? 0.74 : 0.7, 0.85, fbm2(x * 0.5 + 2, z * 0.5 + y * 0.9));
  if (patch > 0) {
    const pick = hash2(Math.floor(x * 0.5), Math.floor(z * 0.5));
    const cc = pick < 0.4 ? C.coralPink : pick < 0.75 ? C.coralOrange : C.coralPurple;
    mixc(out, cc, patch * (0.55 + 0.3 * (1 - t)), out);
  }
  // algae near the base, a pale cap at the rim
  const base = smoothstep(0.32, 0.0, t);
  mixc(out, C.algae, base * 0.55, out);
  const cap = smoothstep(0.88, 1.0, t);
  mixc(out, hi ? C.towerTop : C.stoneTop, cap * 0.7, out);
  const sh = 0.86 + 0.2 * hash2(Math.floor(x * 3.1), Math.floor(z * 3.1 + y * 5));
  out[0] *= sh;
  out[1] *= sh;
  out[2] *= sh;
  return out;
}

interface WallOpts {
  /** Eroded ledges (soft strata notches cut INWARD) + the upper tier's colours: for the towers. */
  tower?: boolean;
  /** The circle's centre (default: the dome centre). */
  cx?: number;
  cz?: number;
}

/** Angular resolution shared by a round piece's wall and its top, so their rims have identical vertices (no T-junction slits). */
function ringSegments(R: number, tower: boolean): number {
  return Math.max(64, Math.round(R * (tower ? 18 : 8)));
}

/** Vertical wall of radius R (outward-facing when `outward`) from y0 to y1, bulging INWARD by a noise amount (never outward). */
function addCircularWall(vg: VGeo, R: number, y0: number, y1: number, outward: boolean, seed: number, o: WallOpts = {}): void {
  const tower = o.tower === true;
  const na = ringSegments(R, tower);
  const ox = o.cx ?? 0;
  const oz = o.cz ?? 0;
  const nb = Math.max(3, Math.ceil((y1 - y0) / (tower ? 0.26 : 0.25)));
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
      let d = (0.03 + 0.15 * fbm2(Math.cos(a) * R * 0.6 + seed, Math.sin(a) * R * 0.6 + y * 1.7)) * bulge;
      if (tower) {
        // soft layers erode further than hard ones: periodic inward ledges (always inward, so the exact collider is never poked through),
        // plus a vertical fluting that varies with the angle
        const layer = 0.5 + 0.5 * Math.sin(y * 4.6 + fbm2(Math.cos(a) * 1.7 + seed, Math.sin(a) * 1.7) * 6.0);
        d += 0.17 * Math.pow(layer, 5) * bulge + 0.05 * (0.5 + 0.5 * Math.sin(a * 9 + y * 0.8)) * bulge;
      }
      const r = outward ? R - d : R + d;
      const x = ox + ca * r;
      const z = oz + sa * r;
      cliffColor(ox + ca * R, y, oz + sa * R, t, _c, tower);
      row.push(soup.v(x, y, z, [_c[0], _c[1], _c[2]]));
    }
    rows.push(row);
  }
  for (let j = 0; j < nb; j++) {
    for (let i = 0; i < na; i++) {
      soup.quad(rows[j][i], rows[j][i + 1], rows[j + 1][i + 1], rows[j + 1][i]);
    }
  }
  soup.flush(vg, 0, outward ? [1, 0, 0] : [-1, 0, 0]);
}

/** Horizontal disc / annulus top at height y between radii r0 and r1; colour by `shade(r, angle)`. */
function addAnnulusTop(vg: VGeo, r0: number, r1: number, y: number, colorAt: (x: number, z: number, r: number, edge: number, out: RGB) => RGB, step = 1.0, cx = 0, cz = 0, tower = false): void {
  const na = ringSegments(r1, tower);
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
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
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
type Plateau = Extract<ElevationPiece, { kind: 'plateau' }>;

interface RampFrame {
  cx: number;
  cz: number;
  c: number;
  s: number;
  /** The arena piece's length: the centring reference of `rampPoint`'s `u`. */
  L: number;
  W: number;
  h0: number;
  /** Rendered length / end height: a piece that a following piece continues is cut exactly where that one starts. */
  Lr: number;
  hr: number;
}

function frameOf(p: Ramp, cut: { u: number; h: number } | null): RampFrame {
  const a = (p.dirDeg * Math.PI) / 180;
  return { cx: p.x, cz: p.z, c: Math.cos(a), s: Math.sin(a), L: p.length, W: p.width, h0: p.h0, Lr: cut === null ? p.length : cut.u, hr: cut === null ? p.h1 : cut.h };
}

/** World position + surface height of the ramp at (u along from the LOW end 0..Lr, v lateral -W/2..W/2). */
function rampPoint(f: RampFrame, u: number, v: number, lift = 0): [number, number, number] {
  const a = u - f.L / 2;
  const x = f.cx + a * f.c - v * f.s;
  const z = f.cz + a * f.s + v * f.c;
  const y = f.h0 + (f.hr - f.h0) * (u / f.Lr) + lift;
  return [x, y, z];
}

/** How a ramp piece relates to its neighbours (two-piece climbs: a long lower slab + a short, gentler top piece). */
interface RampLink {
  /** The piece that continues this one (its low end sits on this piece's axis near our high end), and where (u). */
  succ: Ramp | null;
  uCut: number;
  hCut: number;
  hasPred: boolean;
  /** The upper-tier tower this piece's high end tucks into (null for the level ramps and for a lower slab). */
  tower: Plateau | null;
}

function linkRamps(hf: readonly ElevationPiece[], towers: readonly Plateau[]): Map<Ramp, RampLink> {
  const ramps = hf.filter((p): p is Ramp => p.kind === 'ramp');
  const out = new Map<Ramp, RampLink>();
  for (const p of ramps) out.set(p, { succ: null, uCut: p.length, hCut: p.h1, hasPred: false, tower: null });
  for (const p of ramps) {
    const f = frameOf(p, null);
    const low = rampPoint(f, 0, 0);
    for (const q of ramps) {
      if (q === p) continue;
      const g = frameOf(q, null);
      const ql = rampPoint(g, 0, 0);
      const rx = ql[0] - low[0];
      const rz = ql[2] - low[2];
      const u = rx * f.c + rz * f.s;
      const lat = -rx * f.s + rz * f.c;
      if (Math.abs(lat) > 0.05 || Math.abs(Math.sin(((q.dirDeg - p.dirDeg) * Math.PI) / 180)) > 0.001) continue;
      if (Math.cos(((q.dirDeg - p.dirDeg) * Math.PI) / 180) < 0) continue;
      if (u < p.length - 0.6 || u > p.length + 0.02) continue;
      const hp = p.h0 + (p.h1 - p.h0) * (u / p.length);
      if (Math.abs(hp - q.h0) > 0.05) continue;
      const lp = out.get(p)!;
      lp.succ = q;
      lp.uCut = u;
      lp.hCut = q.h0;
      out.get(q)!.hasPred = true;
    }
  }
  for (const p of ramps) {
    const f = frameOf(p, null);
    const hi = rampPoint(f, p.length, 0);
    for (const t of towers) {
      if (Math.abs(p.h1 - t.height) > 0.01) continue;
      if (Math.hypot(hi[0] - t.x, hi[2] - t.z) <= t.radius + 0.1) out.get(p)!.tower = t;
    }
  }
  return out;
}

/** Ground height under (x, z) from every piece except `self` (0 = the seabed). */
function groundBelow(hf: readonly ElevationPiece[], self: ElevationPiece, x: number, z: number): number {
  let g = 0;
  for (const q of hf) {
    if (q === self) continue;
    const e = elevationPieceHeight(q, x, z);
    if (e > g) g = e;
  }
  return g;
}

const KERB_W = 0.3;
const KERB_H = 0.2;
const INLAY_W = 0.09;
/** Ramps (or ramp pieces) reaching above this are the upper tier: violet accents, cooler rock. */
const HIGH_RAMP_Y = 4;

interface BuildOut {
  stats: { ramps: number; bulbs: number };
}

function rampGlow(p: Ramp): RGB {
  return p.h1 > HIGH_RAMP_Y ? GLOW.violet : p.h1 > 2 ? GLOW.pink : GLOW.teal;
}

function addRamp(vg: VGeo, glow: VGeo, hf: readonly ElevationPiece[], p: Ramp, link: RampLink, out: BuildOut): void {
  const f = frameOf(p, link.succ === null ? null : { u: link.uCut, h: link.hCut });
  const Lr = f.Lr;
  const W = f.W;
  const hi = p.h1 > HIGH_RAMP_Y;

  const nu = Math.max(4, Math.round(Lr / 0.5));
  const nv = 6;
  const stripe = (i: number): number => (i % 2 === 0 ? 1 : 0.955);
  const cA = hi ? C.rampUp : C.ramp;
  const cB = hi ? C.rampUpB : C.rampB;

  // Top surface.
  {
    const soup = new Soup();
    const rows: number[][] = [];
    for (let i = 0; i <= nu; i++) {
      const row: number[] = [];
      for (let j = 0; j <= nv; j++) {
        const u = (i / nu) * Lr;
        const v = (j / nv - 0.5) * W;
        const [x, y, z] = rampPoint(f, u, v);
        mixc(cA, cB, fbm2(x * 0.5, z * 0.5), _c);
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
    const gcol = rampGlow(p);
    const cc: RGB = [gcol[0] * 0.5, gcol[1] * 0.5, gcol[2] * 0.5];
    const soup = new Soup();
    for (let u = 0.84; u + 0.78 < Lr - 0.15; u += 1.02) {
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
    if (soup.idx.length > 0) soup.flush(glow, 0, [0, 1, 0]);
  }

  // Side walls (both sides) down to the ground beneath, sampled along the wedge (a causeway standing on the terrace is a solid dike:
  // over the plateau the bottom is 3 m, over the terrace 1.5 m ...). The bottom of a column is the LOWEST ground within +-0.3 m of it,
  // so a step in the ground under the wall never leaves a gap (the extra length is buried in the lower-level solid).
  for (const side of [-1, 1]) {
    const soup = new Soup();
    const nuw = Math.max(2, Math.ceil(Lr / 0.6));
    const tops: Array<[number, number, number]> = [];
    const bottoms: number[] = [];
    let maxH = 0;
    for (let i = 0; i <= nuw; i++) {
      const u = (i / nuw) * Lr;
      const top = rampPoint(f, u, side * (W / 2));
      let b = top[1];
      for (const du of [-0.3, 0, 0.3]) {
        const uu = Math.min(Lr, Math.max(0, u + du));
        const sp = rampPoint(f, uu, side * (W / 2));
        b = Math.min(b, groundBelow(hf, p, sp[0], sp[2]));
      }
      tops.push(top);
      bottoms.push(b);
      maxH = Math.max(maxH, top[1] - b);
    }
    const nz = Math.min(10, Math.max(1, Math.ceil(maxH / 0.8)));
    const rows: number[][] = [];
    for (let i = 0; i <= nuw; i++) {
      const [x, yTop, z] = tops[i];
      const row: number[] = [];
      for (let k = 0; k <= nz; k++) {
        const y = mix(yTop, bottoms[i], k / nz);
        cliffColor(x, y, z, 1 - k / nz, _c, hi);
        row.push(soup.v(x, y, z, [_c[0], _c[1], _c[2]]));
      }
      rows.push(row);
    }
    for (let i = 0; i < nuw; i++) for (let k = 0; k < nz; k++) soup.quad(rows[i][k], rows[i + 1][k], rows[i + 1][k + 1], rows[i][k + 1]);
    // outward normal of the side = side * lateral axis (-s, c)
    soup.flush(vg, 0, [side * -f.s, 0, side * f.c]);
  }

  // Kerbs along both edges: top, inner and outer faces (+ end caps where the kerb ends); the inlay + bulbs ride on the kerb top.
  // A kerb runs on through a joint with the next / previous piece of the same climb and stops short of a tower rim (inside the disc it
  // would hang over the void at the rim's curve).
  const uStart = link.hasPred ? 0 : 0.5;
  let uEnd: number;
  if (link.succ !== null) uEnd = Lr;
  else if (link.tower !== null) {
    const t = link.tower;
    const low = rampPoint(f, 0, 0);
    const uT = (t.x - low[0]) * f.c + (t.z - low[2]) * f.s;
    let cap = Infinity;
    for (const v of [W / 2 - KERB_W, W / 2]) cap = Math.min(cap, uT - Math.sqrt(Math.max(0, t.radius * t.radius - v * v)));
    uEnd = Math.max(uStart + 0.4, cap - 0.05);
  } else uEnd = Lr - 0.9; // the high end tucks under the next level
  const nk = Math.max(3, Math.ceil((uEnd - uStart) / 0.4));
  const glowCol = rampGlow(p);
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
    // end caps (low end faces down the ramp, high end faces up it); none at a joint with a neighbouring piece
    const caps: number[] = [];
    if (!link.hasPred) caps.push(uStart);
    if (link.succ === null) caps.push(uEnd);
    for (const uc of caps) {
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
    const soupG = new Soup();
    const vm = side * (W / 2 - KERB_W / 2);
    const rowG: Array<[number, number]> = [];
    const i0 = link.hasPred ? 0 : 0.1;
    const i1 = link.succ !== null ? 0 : 0.1;
    for (let i = 0; i <= nk; i++) {
      const u = mix(uStart + i0, uEnd - i1, i / nk);
      const a = rampPoint(f, u, vm - INLAY_W / 2, KERB_H + 0.012);
      const b = rampPoint(f, u, vm + INLAY_W / 2, KERB_H + 0.012);
      const pulse = 0.85 + 0.3 * (i % 2);
      const gc: RGB = [glowCol[0] * pulse, glowCol[1] * pulse, glowCol[2] * pulse];
      rowG.push([soupG.v(a[0], a[1], a[2], gc), soupG.v(b[0], b[1], b[2], gc)]);
    }
    for (let i = 0; i < nk; i++) soupG.quad(rowG[i][0], rowG[i + 1][0], rowG[i + 1][1], rowG[i][1]);
    soupG.flush(glow, 0, [0, 1, 0]);
    const bulb = new THREE.IcosahedronGeometry(0.1, 0);
    const bn = Math.max(2, Math.round((uEnd - uStart) / 0.85));
    for (let i = 0; i < bn; i++) {
      const u = mix(uStart + 0.4, Math.max(uStart + 0.5, uEnd - 0.3), i / (bn - 1));
      const q = rampPoint(f, u, vm, KERB_H + 0.1);
      glow.add(bulb, new THREE.Matrix4().makeTranslation(q[0], q[1], q[2]), glowCol);
      out.stats.bulbs++;
    }
    bulb.dispose();
  }
  out.stats.ramps++;
}

// ── Towers (the upper tier) ──────────────────────────────────────────────────

/** The arena's upper-tier towers: plateau pieces whose top is in the HIGH serpent band (`hazards.serpentSplitY`). None without a split. */
export function arenaTowers(arena: ArenaDef): Plateau[] {
  const split = arena.hazards?.serpentSplitY;
  if (split === undefined) return [];
  return (arena.heightfield ?? []).filter((p): p is Plateau => p.kind === 'plateau' && p.height >= split);
}

/** Angular spans [centre, halfWidth] (radians, around the tower's centre) where a ramp reaches the tower's rim. */
export function towerMouths(arena: ArenaDef, t: Plateau, extra = 0.35): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const q of arena.heightfield ?? []) {
    if (q.kind !== 'ramp' || Math.abs(q.h1 - t.height) > 0.01) continue;
    const f = frameOf(q, null);
    const hi = rampPoint(f, q.length, 0);
    if (Math.hypot(hi[0] - t.x, hi[2] - t.z) > t.radius + 0.1) continue;
    // the ramp climbs toward the tower: from the tower's centre the mouth lies the opposite way (dir + 180)
    const a = ((q.dirDeg + 180) * Math.PI) / 180;
    out.push([a, Math.asin(Math.min(1, (q.width / 2 + extra) / t.radius))]);
  }
  return out;
}

/** Is the world angle `a` (rad) inside one of the angular spans [centre, half-width] (grown by `pad`)? */
export function inSpan(a: number, spans: ReadonlyArray<[number, number]>, pad = 0): boolean {
  for (const [c, h] of spans) {
    let d = a - c;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    if (Math.abs(d) < h + pad) return true;
  }
  return false;
}

function towerTopColorFn(t: Plateau): (x: number, z: number, r: number, edge: number, out: RGB) => RGB {
  return (x, z, r, edge, out) => {
    const lx = x - t.x;
    const lz = z - t.z;
    mixc(C.towerTop, C.towerTopB, fbm2(x * 0.3 + 5, z * 0.3 - 2), out);
    // flagstones: concentric joints + radial seams, a violet inlay ring just inside the parapet and a ring around the pad
    const ring = Math.abs(Math.sin(r * 2.1));
    const seam = Math.abs(Math.sin(Math.atan2(lz, lx) * 12));
    let f = 0.95 + (ring > 0.96 ? -0.07 : 0) + (seam > 0.975 ? -0.06 : 0);
    if (Math.abs(r - (t.radius - 0.62)) < 0.07) mixc(out, C.coralPurple, 0.6, out);
    if (Math.abs(r - 2.55) < 0.06) mixc(out, C.coralPurple, 0.45, out);
    const ao = 0.8 + 0.2 * smoothstep(0, 0.6, edge);
    f *= ao * (0.93 + 0.12 * hash2(Math.floor(x * 2), Math.floor(z * 2)));
    out[0] *= f;
    out[1] *= f;
    out[2] *= f;
    return out;
  };
}

const PARAPET_H = 0.14;
const PARAPET_W = 0.3;

/**
 * The low parapet around a tower's rim (14 cm high, 30 cm wide, pale stone with a glowing violet inlay): it opens where the ramps arrive.
 * Its outer face continues the cliff's vertical face exactly (same vertices as the wall's top row), so there is no seam to see.
 */
function addTowerParapet(vg: VGeo, glow: VGeo, t: Plateau, spans: ReadonlyArray<[number, number]>): void {
  const R = t.radius;
  const na = ringSegments(R, true); // the wall's own angular resolution (its top row = this row)
  const y = t.height;
  const soup = new Soup();
  const open: boolean[] = [];
  for (let i = 0; i < na; i++) open.push(!inSpan(((i + 0.5) / na) * TAU, spans));
  const P = C.parapet;
  const T = C.parapetTop;
  const at = (i: number, r: number, yy: number): [number, number, number] => {
    const a = ((i % na) / na) * TAU;
    return [t.x + Math.cos(a) * r, yy, t.z + Math.sin(a) * r];
  };
  for (let i = 0; i < na; i++) {
    if (!open[i]) continue;
    const k = 0.94 + 0.08 * (i % 2);
    const col = (c: RGB, s = 1): RGB => [c[0] * k * s, c[1] * k * s, c[2] * k * s];
    const oT0 = at(i, R, y + PARAPET_H);
    const oT1 = at(i + 1, R, y + PARAPET_H);
    const iT0 = at(i, R - PARAPET_W, y + PARAPET_H);
    const iT1 = at(i + 1, R - PARAPET_W, y + PARAPET_H);
    const oB0 = at(i, R, y);
    const oB1 = at(i + 1, R, y);
    const iB0 = at(i, R - PARAPET_W, y);
    const iB1 = at(i + 1, R - PARAPET_W, y);
    const v = (p: [number, number, number], c: RGB): number => soup.v(p[0], p[1], p[2], c);
    // top (faces up)
    const f0 = soup.idx.length;
    soup.quad(v(oT0, col(T)), v(oT1, col(T)), v(iT1, col(T)), v(iT0, col(T)));
    orient(soup.pos, soup.idx, f0, [0, 1, 0]);
    // outer face (faces away from the tower's centre)
    const f1 = soup.idx.length;
    soup.quad(v(oB0, col(P, 0.8)), v(oB1, col(P, 0.8)), v(oT1, col(P)), v(oT0, col(P)));
    const am = (((i + 0.5) / na) * TAU);
    orient(soup.pos, soup.idx, f1, [Math.cos(am), 0, Math.sin(am)]);
    // inner face (faces the centre)
    const f2 = soup.idx.length;
    soup.quad(v(iB0, col(P, 0.75)), v(iB1, col(P, 0.75)), v(iT1, col(P, 0.95)), v(iT0, col(P, 0.95)));
    orient(soup.pos, soup.idx, f2, [-Math.cos(am), 0, -Math.sin(am)]);
    // end caps where the neighbour is open to a ramp mouth
    if (!open[(i + na - 1) % na]) {
      const f3 = soup.idx.length;
      soup.quad(v(oB0, col(P, 0.85)), v(oT0, col(P, 0.9)), v(iT0, col(P, 0.9)), v(iB0, col(P, 0.85)));
      const a0 = (i / na) * TAU;
      orient(soup.pos, soup.idx, f3, [Math.sin(a0), 0, -Math.cos(a0)]);
    }
    if (!open[(i + 1) % na]) {
      const f4 = soup.idx.length;
      soup.quad(v(oB1, col(P, 0.85)), v(oT1, col(P, 0.9)), v(iT1, col(P, 0.9)), v(iB1, col(P, 0.85)));
      const a1 = ((i + 1) / na) * TAU;
      orient(soup.pos, soup.idx, f4, [-Math.sin(a1), 0, Math.cos(a1)]);
    }
  }
  if (soup.idx.length > 0) {
    vg.addRaw(soup.pos, soup.idx, soup.col);
  }
  // glowing inlay dashes on the parapet top (every other segment)
  const g = new Soup();
  for (let i = 0; i < na; i += 2) {
    if (!open[i] || !open[(i + 1) % na]) continue;
    const gc: RGB = [GLOW.violet[0] * (i % 4 === 0 ? 1 : 0.8), GLOW.violet[1] * (i % 4 === 0 ? 1 : 0.8), GLOW.violet[2] * (i % 4 === 0 ? 1 : 0.8)];
    const a = at(i, R - PARAPET_W / 2 - 0.04, y + PARAPET_H + 0.012);
    const b = at(i + 1, R - PARAPET_W / 2 - 0.04, y + PARAPET_H + 0.012);
    const c = at(i + 1, R - PARAPET_W / 2 + 0.04, y + PARAPET_H + 0.012);
    const d = at(i, R - PARAPET_W / 2 + 0.04, y + PARAPET_H + 0.012);
    g.quad(g.v(a[0], a[1], a[2], gc), g.v(b[0], b[1], b[2], gc), g.v(c[0], c[1], c[2], gc), g.v(d[0], d[1], d[2], gc));
  }
  if (g.idx.length > 0) g.flush(glow, 0, [0, 1, 0]);
}

// ── Public builder ───────────────────────────────────────────────────────────

export interface LevelsGeometry {
  /** Lit, vertex-coloured: cliffs, tops, ramps, kerbs. */
  main: THREE.BufferGeometry;
  /** Unlit emissive: ramp inlays + bulbs + rim accents (colours > 1 so the bloom picks them up). */
  glow: THREE.BufferGeometry;
  /** `ramps` = ramp PIECES (a two-piece climb counts twice), `climbs` = ramps that arrive at a tower, `towers` = upper-tier towers. */
  stats: { ramps: number; bulbs: number; rings: number; plateaus: number; towers: number; climbs: number };
}

/** Is (x, z) on a ramp's footprint (grown by `grow`) or inside a tower (grown by `grow`)? Used to keep the rim accents off them. */
function makeBlocked(hf: readonly ElevationPiece[], towers: readonly Plateau[], grow = 0.35): (x: number, z: number) => boolean {
  const ramps = hf.filter((p): p is Ramp => p.kind === 'ramp').map((p) => ({ p, f: frameOf(p, null) }));
  return (x, z) => {
    for (const t of towers) if (Math.hypot(x - t.x, z - t.z) < t.radius + grow) return true;
    for (const { p, f } of ramps) {
      const dx = x - f.cx;
      const dz = z - f.cz;
      const along = dx * f.c + dz * f.s;
      const lat = -dx * f.s + dz * f.c;
      if (Math.abs(along) <= p.length / 2 + 0.3 && Math.abs(lat) <= p.width / 2 + grow) return true;
    }
    return false;
  };
}

/** Dashed glowing accent along a circular rim (skips the ramp mouths and the towers). */
function addRimAccent(glow: VGeo, R: number, y: number, blocked: (x: number, z: number) => boolean, color: RGB, phase: number): void {
  const dash = 0.8;
  const gap = 0.75;
  const n = Math.floor((TAU * R) / (dash + gap));
  const soup = new Soup();
  for (let i = 0; i < n; i++) {
    const a0 = (i * (dash + gap) / R) + phase;
    const a1 = a0 + dash / R;
    const rm = R - 0.12;
    if (blocked(Math.cos(a0) * rm, Math.sin(a0) * rm) || blocked(Math.cos(a1) * rm, Math.sin(a1) * rm)) continue;
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

/** Build the levels of an arena with a `heightfield`. Returns empty geometries for an arena without one. */
export function buildLevelsGeometry(arena: ArenaDef): LevelsGeometry {
  const vg = new VGeo();
  const glow = new VGeo();
  const out: BuildOut & { stats: LevelsGeometry['stats'] } = { stats: { ramps: 0, bulbs: 0, rings: 0, plateaus: 0, towers: 0, climbs: 0 } };
  const hf = arena.heightfield ?? [];
  const towers = arenaTowers(arena);
  const plateaus = hf.filter((p): p is Plateau => p.kind === 'plateau' && !towers.includes(p));
  const links = linkRamps(hf, towers);
  const blocked = makeBlocked(hf, towers);
  let seed = 1.7;
  for (const p of hf) {
    if (p.kind === 'plateau') {
      if (towers.includes(p)) {
        addAnnulusTop(vg, 0, p.radius, p.height, towerTopColorFn(p), 0.9, p.x, p.z, true);
        addCircularWall(vg, p.radius, 0, p.height, true, (seed += 3.3), { tower: true, cx: p.x, cz: p.z });
        addTowerParapet(vg, glow, p, towerMouths(arena, p));
        out.stats.towers++;
      } else {
        addAnnulusTop(vg, 0, p.radius, p.height, plateauColor, 1.3);
        addCircularWall(vg, p.radius, 0, p.height, true, (seed += 3.3));
        out.stats.plateaus++;
        addRimAccent(glow, p.radius, p.height, blocked, GLOW.pink, 0.2);
      }
    } else if (p.kind === 'ring') {
      // The inner part under the plateau is hidden: start the top where the plateau ends.
      const covered = plateaus.find((q) => q.height >= p.height && q.radius > p.rInner);
      const r0 = covered !== undefined ? covered.radius - 0.05 : p.rInner;
      addAnnulusTop(vg, r0, p.rOuter, p.height, terraceColor, 1.2);
      addCircularWall(vg, p.rOuter, 0, p.height, true, (seed += 3.3));
      if (covered === undefined && p.rInner > 0.5) addCircularWall(vg, p.rInner, 0, p.height, false, (seed += 3.3));
      out.stats.rings++;
      addRimAccent(glow, p.rOuter, p.height, blocked, GLOW.teal, 0.5);
    } else {
      const link = links.get(p)!;
      addRamp(vg, glow, hf, p, link, out);
      if (link.tower !== null) out.stats.climbs++;
    }
  }
  return { main: vg.build(), glow: glow.build(), stats: out.stats };
}

/** Surface height of the visual levels at (x, z): by construction the arena's ground height (tests compare the two). */
export function levelsHeight(arena: ArenaDef, x: number, z: number): number {
  return arenaGroundHeight(arena, x, z);
}
