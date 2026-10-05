/**
 * Crumbling Amphitheatre piece geometry (v1.6): every platform of the stage as merged vertex-coloured geometry with its origin at the
 * top-surface centre. Breakable pieces are baked once per crack stage (0 intact, 1 hairlines, 2 spalled + slumped, 3 about to fall);
 * the scene swaps `mesh.geometry` when the stage derived from `hp / maxHp` changes, so cracks cost no extra draw calls. Cracks of stage
 * k are a superset of stage k-1 (each crack has its own seeded rng stream). The collision top stays at y = 0: slumps are <= 0.08 m and
 * the only raised bits are small rubble heaps. Node-safe.
 */

import * as THREE from 'three';
import { mulberry32 } from '../../../core/math';
import type { PlatformDef } from '../../types';
import { GeoBuilder, archGeo } from './common';

export const AC = {
  stone: 0x8c7b6c,
  stoneLight: 0xb7a48d,
  stoneDark: 0x5c4d45,
  stoneDeep: 0x382f33,
  crack: 0x17110f,
  dust: 0xc9b89c,
  rubble: 0x6f6158,
  iron: 0x3a3436,
  gold: 0xf2c25e,
  goldLight: 0xffe49a,
  goldDark: 0xa97a22,
  marble: 0xece4d4,
  marbleShade: 0xc9bfae,
  rose: 0xe9a88c,
};

/** Palette used for the falling chunks of a destroyed piece. */
export const CHUNK_COLORS: readonly number[] = [AC.stone, AC.stoneLight, AC.stoneDark, AC.rubble, 0x9a8978];

export const FRONT_Z = 2.7;
export const BACK_Z = -3.0;
const DEPTH = FRONT_Z - BACK_Z;
const MID_Z = (FRONT_Z + BACK_Z) / 2;

export interface PieceGeo {
  body: THREE.BufferGeometry | null;
  /** Emissive details (final-form gold inlays); null for plain stone. */
  glow: THREE.BufferGeometry | null;
}

function arch(b: GeoBuilder, w: number, h: number, color: number, x: number, y: number, z: number): void {
  const g = archGeo(w, h);
  b.add(g, color, x, y, z, { jitter: 0.02 });
  g.dispose();
}

/** A zig-zag crack polyline in the front plane; each box is one segment. */
function crackLine(b: GeoBuilder, seed: number, x: number, y: number, z: number, len: number, ang: number, thick: number): void {
  const r = mulberry32(seed);
  let cx = x;
  let cy = y;
  let a = ang;
  let left = len;
  while (left > 0.05) {
    const seg = Math.min(left, 0.28 + r() * 0.3);
    a += (r() - 0.5) * 1.1;
    const nx = cx + Math.cos(a) * seg;
    const ny = cy + Math.sin(a) * seg;
    b.box(seg + 0.03, thick, 0.05, AC.crack, (cx + nx) / 2, (cy + ny) / 2, z, { rz: Math.atan2(ny - cy, nx - cx), jitter: 0 });
    cx = nx;
    cy = ny;
    left -= seg;
  }
}

/** Small rubble heap on a top surface (kept <= 0.16 m tall). */
function rubble(b: GeoBuilder, seed: number, x: number, z: number, n: number, spread: number): void {
  const r = mulberry32(seed);
  for (let i = 0; i < n; i++) {
    const s = 0.07 + r() * 0.1;
    b.lump(s, i % 2 === 0 ? AC.rubble : AC.stoneLight, x + (r() - 0.5) * spread, s * 0.55, z + (r() - 0.5) * spread * 0.8, { sy: 0.6 });
  }
}

/** Adds the cumulative cracks for `stage` (1..3) to a slab with front-face rectangle [x0,x1] x [yTop-h, yTop] and a top surface. */
function addCracks(b: GeoBuilder, seed: number, stage: number, x0: number, x1: number, h: number, soft: boolean): void {
  const w = x1 - x0;
  const hf = Math.max(0.3, h);
  const fz = FRONT_Z + 0.04;
  const count = stage === 1 ? 2 : stage === 2 ? 4 : 6;
  for (let i = 0; i < count; i++) {
    const r = mulberry32(seed * 977 + i * 31);
    const x = x0 + w * (0.12 + r() * 0.76);
    if (!soft || i < 2) crackLine(b, seed * 131 + i, x, -0.3, fz, Math.min(hf - 0.3, 0.8 + r() * 1.4 + stage * 0.35), -Math.PI / 2 + (r() - 0.5) * 0.8, 0.045 + stage * 0.016);
  }
  // top cracks as thin dark strips across the walkable surface (stage 1+: a hairline, 2: two, 3: a wide fault)
  const tops = stage === 1 ? 1 : stage === 2 ? 2 : 3;
  for (let i = 0; i < tops; i++) {
    const r = mulberry32(seed * 523 + i * 17);
    const x = x0 + w * (0.2 + r() * 0.6);
    const wid = stage === 3 ? 0.12 : 0.05;
    b.box(wid, 0.03, DEPTH * (0.55 + r() * 0.35), AC.crack, x, 0.012, MID_Z + (r() - 0.5) * 1.0, { ry: (r() - 0.5) * 0.5, jitter: 0 });
  }
  if (stage >= 2) {
    // a spalled patch on the front face (darker, rough) and loose rubble on the top
    const r = mulberry32(seed * 71);
    b.box(Math.min(1.0, w * 0.22), Math.min(0.9, hf * 0.4), 0.05, AC.stoneDeep, x0 + w * (0.25 + r() * 0.5), -0.55 - Math.min(0.5, hf * 0.2), fz + 0.01, { jitter: 0.05 });
    rubble(b, seed * 7, x0 + w * 0.3, MID_Z + 0.8, 3, 0.9);
  }
  if (stage >= 3) {
    const r = mulberry32(seed * 91);
    b.box(Math.min(1.4, w * 0.3), Math.min(1.2, hf * 0.5), 0.06, AC.crack, x0 + w * (0.55 + r() * 0.2), -0.7 - Math.min(0.6, hf * 0.25), fz + 0.02, { jitter: 0 });
    rubble(b, seed * 13, x0 + w * 0.7, MID_Z - 0.6, 4, 1.2);
    // chips hanging off the lower edge
    for (let i = 0; i < 3; i++) b.lump(0.16 + r() * 0.1, AC.rubble, x0 + w * (0.2 + i * 0.3), -hf - 0.05, FRONT_Z - 0.4, { sy: 0.8 });
  }
}

// ── solid floors / tiles ─────────────────────────────────────────────────────

function solidBlock(b: GeoBuilder, rng: () => number, w: number, th: number, o: { stone: number; light: number; dark: number; strong: boolean }): void {
  const hw = w / 2;
  b.box(w, 0.5, DEPTH, o.light, 0, -0.25, MID_Z, { ao: 0.12, jitter: 0.03 });
  for (let i = 1; i < 3; i++) b.box(0.04, 0.02, DEPTH - 0.3, o.dark, -hw + (i * w) / 3, 0.006, MID_Z, { jitter: 0 });
  b.box(w, th - 0.5, 1.3, o.stone, 0, -0.5 - (th - 0.5) / 2, FRONT_Z - 0.65, { ao: 0.3, jitter: 0.02 });
  b.box(w + 0.14, 0.22, 0.55, o.light, 0, -0.38, FRONT_Z - 0.22, { jitter: 0.02 });
  for (const s of [-1, 1]) b.box(0.4, th - 0.45, 0.45, o.dark, s * (hw - 0.2), -0.5 - (th - 0.5) / 2, FRONT_Z + 0.02, { ao: 0.2, jitter: 0.03 });
  arch(b, w * 0.34, th - 1.2, AC.stoneDeep, 0, -th + 0.12, FRONT_Z + 0.06);
  arch(b, w * 0.24, th - 1.55, 0x1d1719, 0, -th + 0.12, FRONT_Z + 0.09);
  if (o.strong) {
    // iron bands on the unbreakable floors
    for (const s of [-1, 1]) b.box(w - 0.6, 0.1, 0.06, AC.iron, 0, s > 0 ? -1.15 : -2.3, FRONT_Z + 0.04, { jitter: 0 });
  }
  b.box(w - 0.4, th - 0.5, 3, o.dark, 0, -0.5 - (th - 0.5) / 2, BACK_Z + 1.5, { ao: 0.3 });
  b.box(w - 1, 0.9, DEPTH - 1, AC.stoneDeep, 0, -th - 0.45, MID_Z, { ao: 0.5 });
  b.cone(w * 0.28, 2.6, AC.stoneDark, rng() * 0.6 - 0.3, -th - 2.0, MID_Z, 7, { rx: Math.PI, ao: 0.55, ry: 0.4 });
  for (let i = 0; i < 3; i++) b.lump(0.25 + rng() * 0.25, i % 2 === 0 ? AC.rubble : AC.stoneDark, (rng() - 0.5) * (w - 1), -th - 0.6 - rng() * 1.2, FRONT_Z - 0.5 - rng() * 1.2, { sy: 1.1 });
}

function floorGeo(def: PlatformDef, outerSign: number): PieceGeo {
  const rng = mulberry32(def.id.length * 131 + 7);
  const b = new GeoBuilder(rng);
  const w = def.x1 - def.x0;
  solidBlock(b, rng, w, def.thickness, { stone: AC.stoneDark, light: AC.stone, dark: AC.stoneDeep, strong: true });
  // a broken column stump standing at the OUTER end, behind the fighters
  const cx = outerSign * (w / 2 - 0.9);
  b.box(1.5, 0.35, 1.5, AC.stoneDark, cx, 0.17, -1.9, { ao: 0.3 });
  b.cyl(0.52, 0.6, 2.6, AC.stone, cx, 1.65, -1.9, 9, { ao: 0.2, jitter: 0.04 });
  b.lump(0.62, AC.stoneDark, cx + 0.12, 3.1, -1.9, { sy: 0.7 });
  b.lump(0.3, AC.rubble, cx - outerSign * 1.3, 0.2, -1.2, { sy: 0.7 });
  return { body: b.build(), glow: null };
}

function tileGeo(def: PlatformDef, stage: number): PieceGeo {
  const rng = mulberry32(def.id.length * 53 + def.x0 * 7 + 19);
  const b = new GeoBuilder(rng);
  const w = def.x1 - def.x0;
  solidBlock(b, rng, w, def.thickness, { stone: AC.stone, light: AC.stoneLight, dark: AC.stoneDark, strong: false });
  if (stage > 0) addCracks(b, Math.round(Math.abs(def.x0) * 10) + def.id.length * 7, stage, -w / 2, w / 2, def.thickness - 0.5, false);
  return { body: b.build(), glow: null };
}

// ── soft breakables ──────────────────────────────────────────────────────────

function archBase(b: GeoBuilder, w: number, stage: number): void {
  b.box(w, 0.34, 2.2, AC.stone, 0, -0.17, 0, { ao: 0.3, jitter: 0.03 });
  b.box(w - 0.1, 0.03, 2.1, AC.stoneLight, 0, -0.012, 0, { jitter: 0.03 });
  b.box(w + 0.08, 0.16, 0.2, AC.stoneLight, 0, -0.1, 1.05, { jitter: 0.02 });
  // an arch bridge under the slab: two piers + a backing wall with the arch opening
  const piers = stage >= 3 ? [-1] : [-1, 1];
  for (const s of piers) {
    b.box(0.7, 1.5, 0.9, AC.stoneDark, s * (w / 2 - 0.5), -1.09, 0.1, { ao: 0.4, jitter: 0.04 });
    b.cone(0.3, 0.7, AC.stoneDeep, s * (w / 2 - 0.5), -2.15, 0.1, 6, { rx: Math.PI, ao: 0.4 });
  }
  b.box(w - 1.0, 1.4, 0.3, AC.stoneDeep, 0, -1.04, -0.5, { ao: 0.4 });
  arch(b, w - 1.5, 1.3, 0x1d1719, 0, -1.74, -0.33);
  // balusters along the back edge (behind the fighters)
  const n = 7;
  for (let i = 0; i < n; i++) {
    const missing = (stage >= 2 && i % 3 === 1) || (stage >= 3 && i % 2 === 0);
    if (missing) continue;
    b.cyl(0.07, 0.09, 0.55, AC.stoneLight, -w / 2 + 0.4 + ((w - 0.8) * i) / (n - 1), 0.28, -0.9, 6, { jitter: 0.03 });
  }
  b.box(w - 0.4, 0.1, 0.18, AC.stone, 0, 0.58, -0.9, { jitter: 0.03 });
}

function archPieceGeo(def: PlatformDef, stage: number): PieceGeo {
  const b = new GeoBuilder(mulberry32(def.id.length * 29 + 3));
  const w = def.x1 - def.x0;
  archBase(b, w, stage);
  if (stage > 0) addCracks(b, def.id.length * 17 + 5, stage, -w / 2, w / 2, 0.34, true);
  return { body: b.build(), glow: null };
}

function crownGeo(def: PlatformDef, stage: number): PieceGeo {
  const b = new GeoBuilder(mulberry32(41));
  const w = def.x1 - def.x0;
  b.box(w, 0.34, 2.0, AC.stone, 0, -0.17, 0, { ao: 0.3, jitter: 0.03 });
  b.box(w - 0.1, 0.03, 1.9, AC.stoneLight, 0, -0.012, 0, { jitter: 0.03 });
  b.box(w + 0.08, 0.16, 0.2, AC.goldDark, 0, -0.1, 0.95, { jitter: 0 });
  b.box(w + 0.02, 0.05, 0.14, AC.gold, 0, -0.01, 0.95, { jitter: 0 });
  for (const s of [-1, 1]) b.box(0.26, 0.4, 2.05, AC.goldDark, s * (w / 2 - 0.08), -0.15, 0, { jitter: 0 });
  b.cone(0.7, 1.6, AC.stoneDark, 0, -1.2, 0, 7, { rx: Math.PI, ao: 0.5, ry: 0.4 });
  // crown spikes in the back plane
  const hs = [0.9, 1.5, 2.1, 1.5, 0.9];
  for (let i = 0; i < hs.length; i++) {
    const broken = (stage >= 2 && (i === 1 || i === 3)) || (stage >= 3 && i !== 2);
    const h = broken ? hs[i] * 0.45 : hs[i];
    b.cone(0.28, h, broken ? AC.stoneDark : AC.stoneLight, -w / 2 + 0.7 + ((w - 1.4) * i) / (hs.length - 1), h / 2, -0.95, 5, { ao: 0.2, jitter: 0.04 });
    if (!broken) b.cone(0.1, 0.35, AC.gold, -w / 2 + 0.7 + ((w - 1.4) * i) / (hs.length - 1), h + 0.1, -0.95, 5, { jitter: 0 });
  }
  b.box(w - 0.9, 0.12, 0.3, AC.goldDark, 0, 0.1, -0.95, { jitter: 0 });
  if (stage > 0) addCracks(b, 913, stage, -w / 2, w / 2, 0.34, true);
  return { body: b.build(), glow: null };
}

// ── final form ───────────────────────────────────────────────────────────────

function marbleSlab(b: GeoBuilder, g: GeoBuilder, w: number): void {
  b.box(w, 0.34, 2.2, AC.marble, 0, -0.17, 0, { ao: 0.25, jitter: 0.02 });
  b.box(w - 0.1, 0.03, 2.1, 0xfff6e2, 0, -0.012, 0, { jitter: 0.02 });
  b.box(w + 0.1, 0.16, 0.2, AC.gold, 0, -0.1, 1.05, { jitter: 0 });
  for (const s of [-1, 1]) b.box(0.26, 0.4, 2.25, AC.goldLight, s * (w / 2 - 0.08), -0.15, 0, { jitter: 0 });
  // sun-ray inlay on the deck
  for (let i = -3; i <= 3; i++) g.box(0.06, 0.02, 1.6, AC.goldLight, i * (w / 8), 0.012, 0, { ry: i * 0.1, jitter: 0 });
  g.box(w - 0.5, 0.05, 0.08, AC.goldLight, 0, -0.02, 1.12, { jitter: 0 });
  b.cone(0.5, 1.2, AC.marbleShade, 0, -1.0, 0, 7, { rx: Math.PI, ao: 0.4, ry: 0.4 });
  g.cone(0.14, 0.5, AC.goldLight, 0, -1.75, 0, 5, { rx: Math.PI, jitter: 0 });
}

function sunGeo(def: PlatformDef): PieceGeo {
  const b = new GeoBuilder(mulberry32(def.id.length * 11));
  const g = new GeoBuilder(mulberry32(5));
  marbleSlab(b, g, def.x1 - def.x0);
  return { body: b.build(), glow: g.build() };
}

function haloGeo(def: PlatformDef): PieceGeo {
  const b = new GeoBuilder(mulberry32(77));
  const g = new GeoBuilder(mulberry32(78));
  const w = def.x1 - def.x0;
  marbleSlab(b, g, w);
  const ring = new THREE.RingGeometry(1.7, 2.05, 40);
  g.add(ring, AC.goldLight, 0, 2.1, -1.0, { jitter: 0 });
  ring.dispose();
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    g.box(0.07, 0.34, 0.04, AC.gold, Math.cos(a) * 2.4, 2.1 + Math.sin(a) * 2.4, -1.0, { rz: a - Math.PI / 2, jitter: 0 });
  }
  return { body: b.build(), glow: g.build() };
}

/**
 * v1.7 the golden span: a slender marble walkway that joins the two sun slabs at one height. It abuts both (no raised end rails — the
 * slabs' own gold end caps become the thresholds). Fighters stand and fight under it (the core sits below), so the deck is thin and all the
 * heavy decoration — the belly wall with arched openings, rune medallions, gold pendants and a low balustrade — sits in the BACK plane,
 * behind the bodies. A line of sun-rune inlays and a glowing underline carry the final form's gold.
 */
function spanGeo(def: PlatformDef): PieceGeo {
  const b = new GeoBuilder(mulberry32(131));
  const g = new GeoBuilder(mulberry32(132));
  const w = def.x1 - def.x0;
  const hw = w / 2;
  // thin deck + gold front lip (same lip as the slabs so the surfaces read as one run)
  b.box(w, 0.22, 2.2, AC.marble, 0, -0.11, 0, { ao: 0.25, jitter: 0.02 });
  b.box(w - 0.1, 0.03, 2.1, 0xfff6e2, 0, -0.012, 0, { jitter: 0.02 });
  b.box(w, 0.16, 0.2, AC.gold, 0, -0.1, 1.05, { jitter: 0 });
  // belly wall in the back plane with arched openings, rune medallions and short gold-tipped pendants
  const wallZ = -0.95;
  b.box(w - 1.0, 0.7, 0.3, AC.marbleShade, 0, -0.57, wallZ, { ao: 0.4, jitter: 0.02 });
  const arches = 5;
  const aw = (w - 1.0) / arches;
  for (let i = 0; i < arches; i++) {
    const x = -hw + 0.5 + aw * (i + 0.5);
    arch(b, aw - 0.55, 0.58, 0x2c2530, x, -0.92, wallZ + 0.17);
    if (i < arches - 1) {
      const px = x + aw / 2;
      b.cone(0.22, 0.55, AC.marbleShade, px, -1.2, wallZ, 7, { rx: Math.PI, ao: 0.4, ry: 0.4 });
      g.cone(0.09, 0.22, AC.goldLight, px, -1.38, wallZ, 5, { rx: Math.PI, jitter: 0 });
      const disc = new THREE.CircleGeometry(0.17, 16);
      g.add(disc, AC.goldLight, px, -0.5, wallZ + 0.17, { jitter: 0 });
      disc.dispose();
    }
  }
  // balustrade along the back edge (behind the fighters) with a gold cap rail
  const posts = 11;
  for (let i = 0; i < posts; i++) b.cyl(0.07, 0.09, 0.5, AC.marble, -hw + 0.6 + ((w - 1.2) * i) / (posts - 1), 0.25, wallZ, 6, { jitter: 0.02 });
  b.box(w - 0.8, 0.1, 0.18, AC.goldDark, 0, 0.52, wallZ, { jitter: 0 });
  // sun-rune inlays across the deck and a glowing underline on the front lip
  for (let i = 0; i < 15; i++) g.box(0.06, 0.02, 1.6, AC.goldLight, -hw + 0.8 + ((w - 1.6) * i) / 14, 0.012, 0, { ry: (i % 2 === 0 ? 1 : -1) * 0.12, jitter: 0 });
  g.box(w - 0.5, 0.05, 0.08, AC.goldLight, 0, -0.02, 1.12, { jitter: 0 });
  return { body: b.build(), glow: g.build() };
}

/** Geometry of the final-form SOFT platforms that are not the plain sun slab. */
const FINAL_SOFT_GEO: Readonly<Record<string, (def: PlatformDef) => PieceGeo>> = { halo: haloGeo, span: spanGeo };

function finalCoreGeo(def: PlatformDef): PieceGeo {
  const rng = mulberry32(99);
  const b = new GeoBuilder(rng);
  const g = new GeoBuilder(rng);
  const w = def.x1 - def.x0;
  const th = def.thickness;
  b.box(w, 0.5, DEPTH - 0.4, AC.marble, 0, -0.25, MID_Z, { ao: 0.12, jitter: 0.02 });
  b.box(w, th - 0.5, 1.3, AC.marbleShade, 0, -0.5 - (th - 0.5) / 2, FRONT_Z - 0.65, { ao: 0.3, jitter: 0.02 });
  b.box(w + 0.14, 0.22, 0.55, AC.marble, 0, -0.38, FRONT_Z - 0.22, { jitter: 0 });
  for (const s of [-1, 1]) b.box(0.4, th - 0.45, 0.45, AC.gold, s * (w / 2 - 0.2), -0.5 - (th - 0.5) / 2, FRONT_Z + 0.02, { jitter: 0 });
  // sun disc relief on the front (glowing)
  const disc = new THREE.CircleGeometry(0.62, 24);
  g.add(disc, AC.goldLight, 0, -1.2, FRONT_Z + 0.07, { jitter: 0 });
  disc.dispose();
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    g.box(0.07, 0.3, 0.04, AC.gold, Math.cos(a) * 0.95, -1.2 + Math.sin(a) * 0.95, FRONT_Z + 0.07, { rz: a - Math.PI / 2, jitter: 0 });
  }
  b.box(w - 1, 0.8, DEPTH - 1.4, AC.marbleShade, 0, -th - 0.4, MID_Z, { ao: 0.5 });
  b.cone(w * 0.24, 2.0, AC.marbleShade, 0, -th - 1.7, MID_Z, 7, { rx: Math.PI, ao: 0.5, ry: 0.4 });
  g.box(w - 1.0, 0.05, 0.1, AC.goldLight, 0, 0.02, FRONT_Z - 0.2, { jitter: 0 });
  return { body: b.build(), glow: g.build() };
}

/** Build the geometry of platform `def` for crack `stage` (0..3; ignored for non-breakables). */
export function buildPiece(def: PlatformDef, stage: number): PieceGeo {
  if (def.finalOnly === true) {
    if (def.kind === 'solid') return finalCoreGeo(def);
    return (FINAL_SOFT_GEO[def.id] ?? sunGeo)(def);
  }
  if (def.breakable === undefined) return floorGeo(def, def.x0 < 0 ? -1 : 1);
  if (def.kind === 'solid') return tileGeo(def, stage);
  return def.id === 'crown' ? crownGeo(def, stage) : archPieceGeo(def, stage);
}
