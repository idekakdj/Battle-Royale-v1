/**
 * Jungle trees (WP-J3): the shared trunk template (buttress roots, ridged bark, moss on the lower trunk), the leaf-clump geometry
 * used for the canopy and the foliage ring, and the hanging vines. Trunks are drawn EXACTLY at their collider position / radius:
 * the template has unit base radius and is scaled per tree by the collider radius (a tree of radius r is r × the template in X/Z).
 *
 * Everything is flat-shaded vertex-coloured geometry (the colosseum's flat-vector look); one InstancedMesh draws all trunks (so
 * each tree has its own fade value), one InstancedMesh all canopy clumps, one merged mesh all vines.
 */

import * as THREE from 'three';
import { mulberry32, TAU } from '../../core/math';
import { VGeo, composeMat, fbm2, hash2, mix, smoothstep } from './vgeo';

/** Total modelled height of the trunk template (m): it runs past the 12 m collider height into the canopy. */
export const TRUNK_HEIGHT = 16;
/** Height of the collider the template is authored for (the arena's `JUNGLE_TREE_HEIGHT`). */
export const TRUNK_COLLIDER_HEIGHT = 12;

const BARK = [0.36, 0.27, 0.19] as const;
const BARK_DARK = [0.2, 0.15, 0.11] as const;
const MOSS = [0.26, 0.46, 0.15] as const;


// ── Trunk ────────────────────────────────────────────────────────────────────

const TRUNK_YS = [0, 0.35, 1.0, 2.2, 4, 6.2, 8.6, 11, 13.4, 16] as const;
const TRUNK_RS = [1.28, 1.12, 1.0, 0.94, 0.9, 0.88, 0.84, 0.8, 0.74, 0.62] as const;
const TRUNK_SEGS = 14;
const FINS = 6;

/** Unit-radius trunk (+ buttress fins) as one vertex-coloured geometry; scale X/Z by the collider radius. */
export function buildTrunkGeometry(seed = 0x7ee): THREE.BufferGeometry {
  const rng = mulberry32(seed);
  const vg = new VGeo();

  // Ridged trunk shaft.
  const rings = TRUNK_YS.length;
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < rings; i++) {
    const y = TRUNK_YS[i];
    for (let s = 0; s < TRUNK_SEGS; s++) {
      const a = (s / TRUNK_SEGS) * TAU + y * 0.035; // a slight twist up the trunk
      const ridge = s % 2 === 0 ? 1 : 0.935;
      const bump = 1 + (hash2(s * 3.1, i * 5.7) - 0.5) * 0.1;
      const r = TRUNK_RS[i] * ridge * bump;
      pos.push(Math.cos(a) * r, y, Math.sin(a) * r);
      const n = fbm2(s * 0.9 + 3.3, y * 0.5);
      const mossAmt = smoothstep(4.6, 0.5, y) * (0.35 + 0.65 * n) + smoothstep(0.7, 0.2, Math.abs(n - 0.5)) * 0.05;
      const shade = 0.78 + hash2(s * 1.7, i * 2.3) * 0.35;
      const lichen = smoothstep(0.78, 0.95, hash2(s * 9.1, Math.floor(y * 0.7)));
      let cr = mix(BARK[0], BARK_DARK[0], s % 2 === 0 ? 0 : 0.5) * shade;
      let cg = mix(BARK[1], BARK_DARK[1], s % 2 === 0 ? 0 : 0.5) * shade;
      let cb = mix(BARK[2], BARK_DARK[2], s % 2 === 0 ? 0 : 0.5) * shade;
      cr = mix(cr, MOSS[0] * shade, Math.min(1, mossAmt * 0.95));
      cg = mix(cg, MOSS[1] * shade, Math.min(1, mossAmt * 0.95));
      cb = mix(cb, MOSS[2] * shade, Math.min(1, mossAmt * 0.95));
      cr = mix(cr, 0.55, lichen * 0.3);
      cg = mix(cg, 0.6, lichen * 0.3);
      cb = mix(cb, 0.42, lichen * 0.3);
      col.push(cr, cg, cb);
    }
  }
  for (let i = 0; i < rings - 1; i++) {
    for (let s = 0; s < TRUNK_SEGS; s++) {
      const s1 = (s + 1) % TRUNK_SEGS;
      const a = i * TRUNK_SEGS + s;
      const b = i * TRUNK_SEGS + s1;
      const c = (i + 1) * TRUNK_SEGS + s;
      const d = (i + 1) * TRUNK_SEGS + s1;
      idx.push(a, c, b, b, c, d);
    }
  }
  vg.addRaw(pos, idx, col);

  // Buttress fins: thin wedges flaring out of the base, mossy on top.
  for (let k = 0; k < FINS; k++) {
    const a = (k / FINS) * TAU + (rng() - 0.5) * 0.5;
    const reach = 1.9 + rng() * 0.9;
    const h = 2.0 + rng() * 1.5;
    const w0 = 0.26 + rng() * 0.12;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    // radial (ca,sa) and tangent (-sa,ca)
    const P = (r: number, y: number, t: number): [number, number, number] => [ca * r - sa * t, y, sa * r + ca * t];
    const verts: [number, number, number][] = [
      P(0.8, -0.05, -w0), P(reach, -0.05, -w0 * 0.8), P(0.95, h, -0.05),
      P(0.8, -0.05, w0), P(reach, -0.05, w0 * 0.8), P(0.95, h, 0.05),
      P(reach * 0.92, 0.18, 0), // the root's ridge tip
    ];
    const fpos: number[] = [];
    for (const v of verts) fpos.push(v[0], v[1], v[2]);
    const fidx = [
      0, 2, 1, 3, 4, 5, // inner-ish caps (unseen mostly)
      0, 1, 6, 0, 6, 2, 3, 6, 4, 3, 5, 6, // sloped faces
      1, 2, 5, 1, 5, 4, 0, 3, 5, 0, 5, 2, 1, 4, 6, // sides / underside
    ];
    const fcol: number[] = [];
    for (let v = 0; v < verts.length; v++) {
      const top = smoothstep(0.2, h, verts[v][1]);
      const m = 0.4 + 0.5 * (1 - top);
      fcol.push(mix(BARK[0], MOSS[0], m) * (0.8 + rng() * 0.2), mix(BARK[1], MOSS[1], m) * (0.8 + rng() * 0.2), mix(BARK[2], MOSS[2], m) * (0.8 + rng() * 0.2));
    }
    vg.addRaw(fpos, fidx, fcol);
  }
  return vg.build();
}

// ── Leaf clumps (canopy + foliage ring) ──────────────────────────────────────

const LEAF_DEEP = [0.1, 0.27, 0.1] as const;
const LEAF_LIGHT = [0.36, 0.6, 0.17] as const;
const LEAF_WARM = [0.62, 0.7, 0.2] as const;

/**
 * A faceted leaf clump: a displaced, slightly flattened icosphere (detail 1 = 80 facets), dark underneath and sun-lit on top, with
 * the odd warm patch. Unit radius; instances scale / rotate / tint it.
 */
export function buildLeafClumpGeometry(seed = 0x1eaf): THREE.BufferGeometry {
  const base = new THREE.IcosahedronGeometry(1, 1);
  const p = base.getAttribute('position');
  // Displace by a function of the (deduplicated) vertex position so shared corners stay joined.
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const h = hash2(Math.round(x * 40) + seed, Math.round(y * 40) * 1.3 + Math.round(z * 40) * 0.7);
    const k = 0.84 + h * 0.34;
    p.setXYZ(i, x * k, y * k * 0.78, z * k);
  }
  base.computeVertexNormals();
  const vg = new VGeo();
  vg.add(base, new THREE.Matrix4(), (x, y, z, nx, ny, nz, out) => {
    const top = Math.max(0, Math.min(1, y * 0.55 + 0.5 + ny * 0.25));
    const facet = hash2(Math.floor(nx * 6 + 11), Math.floor(nz * 6 + ny * 3 + 17));
    const warm = smoothstep(0.8, 0.95, facet) * top;
    let r = mix(LEAF_DEEP[0], LEAF_LIGHT[0], top);
    let g = mix(LEAF_DEEP[1], LEAF_LIGHT[1], top);
    let b = mix(LEAF_DEEP[2], LEAF_LIGHT[2], top);
    r = mix(r, LEAF_WARM[0], warm * 0.7);
    g = mix(g, LEAF_WARM[1], warm * 0.7);
    b = mix(b, LEAF_WARM[2], warm * 0.7);
    const sh = 0.86 + facet * 0.28;
    out[0] = r * sh;
    out[1] = g * sh;
    out[2] = b * sh;
    void x;
    void z;
  });
  base.dispose();
  return vg.build();
}

// ── Vines ────────────────────────────────────────────────────────────────────

export interface VineAnchor {
  x: number;
  y: number;
  z: number;
  length: number;
}

/**
 * Hanging vines: thin tapered 3-sided strands with a slow sideways sag and the odd leaf pair, from canopy height down toward the
 * ground (they stop 1.5–5 m up so they never poke through the fighters). One merged geometry.
 */
export function buildVinesGeometry(anchors: readonly VineAnchor[], seed = 0xb1de): THREE.BufferGeometry {
  const rng = mulberry32(seed);
  const vg = new VGeo();
  const SEG = 9;
  for (const v of anchors) {
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const phase = rng() * TAU;
    const sway = 0.25 + rng() * 0.4;
    const w0 = 0.05 + rng() * 0.035;
    const dark = 0.75 + rng() * 0.3;
    for (let i = 0; i <= SEG; i++) {
      const s = i / SEG;
      const cx = v.x + Math.sin(phase + s * 2.4) * sway * s;
      const cz = v.z + Math.cos(phase * 1.3 + s * 2.1) * sway * s;
      const cy = v.y - v.length * s;
      const w = w0 * (1 - 0.65 * s);
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * TAU + phase;
        pos.push(cx + Math.cos(a) * w, cy, cz + Math.sin(a) * w);
        const g = (0.4 + 0.18 * hash2(i * 1.1, k * 2.3 + phase)) * dark;
        col.push(0.16 * dark, g, 0.1 * dark);
      }
    }
    for (let i = 0; i < SEG; i++) {
      for (let k = 0; k < 3; k++) {
        const a = i * 3 + k;
        const b = i * 3 + ((k + 1) % 3);
        const c = (i + 1) * 3 + k;
        const d = (i + 1) * 3 + ((k + 1) % 3);
        idx.push(a, c, b, b, c, d);
      }
    }
    vg.addRaw(pos, idx, col);
    // Leaf pairs along the strand.
    const leaf = new THREE.PlaneGeometry(0.34, 0.2);
    leaf.translate(0.17, 0, 0);
    for (let i = 2; i < SEG; i += 2) {
      const s = i / SEG;
      const cx = v.x + Math.sin(phase + s * 2.4) * sway * s;
      const cz = v.z + Math.cos(phase * 1.3 + s * 2.1) * sway * s;
      const cy = v.y - v.length * s;
      for (const side of [0, 1]) {
        const yaw = rng() * TAU;
        const m = composeMat(cx, cy, cz, -0.5 + rng() * 0.4, yaw, 0, 1 + rng() * 0.5, 1 + rng() * 0.4, 1);
        const tone = 0.7 + rng() * 0.5;
        vg.add(leaf, m, [0.18 * tone, 0.5 * tone, 0.13 * tone] as const, side === 1);
      }
    }
    leaf.dispose();
  }
  return vg.build();
}
