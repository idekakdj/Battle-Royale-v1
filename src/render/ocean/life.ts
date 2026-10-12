/**
 * The ocean beyond the glass (WP-O3): aquatic life, kelp forest, coral reef ring, a distant shipwreck.
 *
 * Sea life is DECORATIVE and fully GPU-driven: each species is one instanced draw whose per-instance attributes describe a looping
 * path (circular orbit / straight pass / drift) and whose vertex shader (see `materials.creatureMaterial`) computes position, heading,
 * tail wag, wing flap and jelly pulse from the elapsed-time uniform alone. Nothing is allocated or uploaded per frame and the motion
 * is a pure function of time (deterministic, loops forever, rollback-proof).
 *
 *   fish schools x3 species (many small instances) - 3 sharks circling at different radii and heights - 2 humpback-ish whales that
 *   pass slowly now and then (110-150 s period) - manta rays gliding - sea turtles - drifting, pulsing, glowing jellyfish
 *   kelp: swaying ribbon stalks   reef: merged coral clusters + rock spires + a half-buried shipwreck silhouette at the rim
 *
 * Tier scaling: `setTier` lowers the instance counts (drawn counts only), drops the jellyfish on low and thins the reef.
 */

import * as THREE from 'three';
import { mulberry32, TAU, type Rng } from '../../core/math';
import { VGeo, composeMat, hash2, mix, rgb, smoothstep, type VertexColorFn } from '../jungle/vgeo';
import type { QualityTier } from '../quality';
import { creatureMaterial, makeInstanced, patchLit, type CreatureInstances, type OceanShared } from './materials';
import { seabedHeight } from './terrain';

type RGB = [number, number, number];

// ── Loft helper (bodies of revolution-ish along +z) ──────────────────────────

export interface Station {
  z: number;
  rx: number;
  ry: number;
  cy?: number;
}

export type LoftColor = (t: number, a: number) => RGB;

/** Loft a closed body along z (nose at the first station) through elliptical stations, `sides` around. */
export function addLoft(vg: VGeo, stations: readonly Station[], sides: number, color: LoftColor): void {
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const rows: number[][] = [];
  const n = stations.length;
  for (let i = 0; i < n; i++) {
    const s = stations[i];
    const row: number[] = [];
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * TAU;
      pos.push(Math.cos(a) * s.rx, (s.cy ?? 0) + Math.sin(a) * s.ry, s.z);
      const c = color(i / (n - 1), a);
      col.push(c[0], c[1], c[2]);
      row.push(pos.length / 3 - 1);
    }
    rows.push(row);
  }
  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < sides; k++) {
      const a = rows[i][k];
      const b = rows[i][(k + 1) % sides];
      const c = rows[i + 1][(k + 1) % sides];
      const d = rows[i + 1][k];
      idx.push(a, b, c, a, c, d);
    }
  }
  // Cap the two ends with fans.
  for (const e of [0, n - 1]) {
    const s = stations[e];
    pos.push(0, s.cy ?? 0, s.z);
    const cc = color(e / (n - 1), 0);
    col.push(cc[0], cc[1], cc[2]);
    const centre = pos.length / 3 - 1;
    for (let k = 0; k < sides; k++) idx.push(centre, rows[e][k], rows[e][(k + 1) % sides]);
  }
  // Orient: the first body triangle's normal must point away from the axis (outward).
  const t0 = [idx[0] * 3, idx[1] * 3, idx[2] * 3];
  const ux = pos[t0[1]] - pos[t0[0]];
  const uy = pos[t0[1] + 1] - pos[t0[0] + 1];
  const uz = pos[t0[1] + 2] - pos[t0[0] + 2];
  const vx = pos[t0[2]] - pos[t0[0]];
  const vy = pos[t0[2] + 1] - pos[t0[0] + 1];
  const vz = pos[t0[2] + 2] - pos[t0[0] + 2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const cx = pos[t0[0]];
  const cy = pos[t0[0] + 1] - (stations[0].cy ?? 0);
  if (nx * cx + ny * cy < 0 && Math.abs(nz) < 1e9) {
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const tmp = idx[t + 1];
      idx[t + 1] = idx[t + 2];
      idx[t + 2] = tmp;
    }
  }
  vg.addRaw(pos, idx, col);
}

/** A single flat triangle (double-sided material). */
export function tri(vg: VGeo, a: [number, number, number], b: [number, number, number], c: [number, number, number], col: RGB, col2: RGB = col): void {
  vg.addRaw([...a, ...b, ...c], [0, 1, 2], [...col, ...col2, ...col2]);
}

/** A flat quad (a, b, c, d in order). */
export function quadTri(vg: VGeo, a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number], col: RGB): void {
  vg.addRaw([...a, ...b, ...c, ...d], [0, 1, 2, 0, 2, 3], [...col, ...col, ...col, ...col]);
}

// ── Species geometry ─────────────────────────────────────────────────────────

const FISH_COLORS: Record<'a' | 'b' | 'c', { back: RGB; belly: RGB; fin: RGB }> = {
  a: { back: rgb(0xe8e8e8), belly: rgb(0xffffff), fin: rgb(0xffffff) },
  b: { back: rgb(0xb9c9d1), belly: rgb(0xf1f6f8), fin: rgb(0xd7e4ea) },
  c: { back: rgb(0xffffff), belly: rgb(0xfff3e0), fin: rgb(0xffffff) },
};

/** Small schooling fish, length ~0.55 (tinted per instance). `deep` = tall-bodied, `slim` = baitfish. */
export function fishGeometry(kind: 'a' | 'b' | 'c'): THREE.BufferGeometry {
  const vg = new VGeo();
  const pal = FISH_COLORS[kind];
  const h = kind === 'a' ? 1.5 : kind === 'b' ? 0.75 : 1.1;
  const w = kind === 'a' ? 0.8 : 1.0;
  const L = kind === 'b' ? 0.5 : 0.42;
  const stations: Station[] = [
    { z: L * 0.5, rx: 0.002, ry: 0.002 },
    { z: L * 0.4, rx: 0.035 * w, ry: 0.06 * h },
    { z: L * 0.12, rx: 0.05 * w, ry: 0.1 * h },
    { z: -L * 0.15, rx: 0.045 * w, ry: 0.085 * h },
    { z: -L * 0.38, rx: 0.02 * w, ry: 0.035 * h },
    { z: -L * 0.5, rx: 0.006, ry: 0.012 },
  ];
  addLoft(vg, stations, 7, (t, a) => {
    const down = Math.max(0, -Math.sin(a));
    const k = 1 - 0.42 * (0.5 + 0.5 * Math.sin(a));
    const stripe = kind === 'c' ? (Math.sin(t * 22) > 0.55 ? 0.35 : 1) : 1;
    return [mix(pal.back[0], pal.belly[0], down) * k * stripe, mix(pal.back[1], pal.belly[1], down) * k * stripe, mix(pal.back[2], pal.belly[2], down) * k * stripe];
  });
  const tailZ = -L * 0.46;
  const tc = pal.fin;
  tri(vg, [0, 0, tailZ], [0, 0.12 * h, tailZ - 0.2], [0, -0.12 * h, tailZ - 0.2], [tc[0] * 0.9, tc[1] * 0.9, tc[2] * 0.9], tc);
  tri(vg, [0, 0.085 * h, L * 0.1], [0, 0.17 * h, -L * 0.1], [0, 0.07 * h, -L * 0.25], [pal.back[0] * 0.8, pal.back[1] * 0.8, pal.back[2] * 0.8], tc);
  tri(vg, [0.04, -0.03, L * 0.2], [0.14 * w, -0.08, L * 0.05], [0.04, -0.045, L * 0.0], tc);
  tri(vg, [-0.04, -0.03, L * 0.2], [-0.14 * w, -0.08, L * 0.05], [-0.04, -0.045, L * 0.0], tc);
  // dark eyes
  for (const sx of [-1, 1]) {
    const eye = new THREE.IcosahedronGeometry(0.014, 0);
    vg.add(eye, composeMat(sx * 0.04 * w, 0.018 * h, L * 0.3), [0.02, 0.02, 0.03]);
    eye.dispose();
  }
  return vg.build();
}

/** A shark, ~5 m long, nose at +z. */
export function sharkGeometry(): THREE.BufferGeometry {
  const vg = new VGeo();
  const back = rgb(0x52687a);
  const belly = rgb(0xe9f1f3);
  const stations: Station[] = [
    { z: 2.7, rx: 0.02, ry: 0.02 },
    { z: 2.45, rx: 0.2, ry: 0.2 },
    { z: 1.8, rx: 0.4, ry: 0.4 },
    { z: 0.8, rx: 0.56, ry: 0.6 },
    { z: -0.4, rx: 0.5, ry: 0.54 },
    { z: -1.5, rx: 0.3, ry: 0.34 },
    { z: -2.3, rx: 0.12, ry: 0.2 },
    { z: -2.75, rx: 0.05, ry: 0.1 },
  ];
  addLoft(vg, stations, 10, (_t, a) => {
    const down = smoothstep(0.1, -0.4, Math.sin(a));
    const k = 0.85 + 0.15 * Math.cos(a * 2);
    return [mix(back[0], belly[0], down) * k, mix(back[1], belly[1], down) * k, mix(back[2], belly[2], down) * k];
  });
  const fin = rgb(0x465b6b);
  tri(vg, [0, 0.55, 1.0], [0, 1.45, -0.15], [0, 0.55, -0.45], fin, [fin[0] * 0.8, fin[1] * 0.8, fin[2] * 0.8]);
  tri(vg, [0, 0.3, -1.6], [0, 0.65, -1.9], [0, 0.28, -2.0], fin);
  // pectoral fins (long, swept back)
  for (const sx of [-1, 1]) {
    tri(vg, [sx * 0.4, -0.3, 1.1], [sx * 1.7, -0.75, 0.2], [sx * 0.45, -0.35, 0.2], fin, [fin[0] * 0.8, fin[1] * 0.8, fin[2] * 0.8]);
    tri(vg, [sx * 0.2, -0.45, -1.0], [sx * 0.65, -0.55, -1.4], [sx * 0.2, -0.45, -1.4], fin);
  }
  // crescent tail: big upper lobe, smaller lower lobe
  tri(vg, [0, 0.0, -2.62], [0, 1.35, -3.6], [0, 0.08, -3.0], fin, [fin[0] * 0.85, fin[1] * 0.85, fin[2] * 0.85]);
  tri(vg, [0, 0.0, -2.62], [0, -0.8, -3.35], [0, -0.06, -2.95], fin, [fin[0] * 0.85, fin[1] * 0.85, fin[2] * 0.85]);
  // eyes + mouth line + gill slits
  for (const sx of [-1, 1]) {
    const eye = new THREE.IcosahedronGeometry(0.06, 0);
    vg.add(eye, composeMat(sx * 0.27, 0.12, 2.1), [0.01, 0.01, 0.015]);
    eye.dispose();
    for (let g = 0; g < 4; g++) tri(vg, [sx * 0.43, 0.2 - g * 0.08, 1.55 - g * 0.1], [sx * 0.46, 0.05 - g * 0.08, 1.55 - g * 0.1], [sx * 0.44, 0.12 - g * 0.08, 1.49 - g * 0.1], [0.12, 0.17, 0.2]);
  }
  quadTri(vg, [-0.2, -0.12, 2.38], [0.2, -0.12, 2.38], [0.19, -0.14, 2.1], [-0.19, -0.14, 2.1], [0.1, 0.12, 0.14]);
  return vg.build();
}

/** A humpback-ish whale, ~18 m long, nose at +z. */
export function whaleGeometry(): THREE.BufferGeometry {
  const vg = new VGeo();
  const back = rgb(0x39505f);
  const belly = rgb(0xd8e3e6);
  const stations: Station[] = [
    { z: 9.2, rx: 0.15, ry: 0.15, cy: -0.1 },
    { z: 8.6, rx: 0.9, ry: 0.85, cy: -0.1 },
    { z: 7.2, rx: 1.55, ry: 1.45 },
    { z: 4.8, rx: 2.1, ry: 2.15, cy: 0.1 },
    { z: 1.8, rx: 2.4, ry: 2.5, cy: 0.2 },
    { z: -1.5, rx: 2.15, ry: 2.2, cy: 0.1 },
    { z: -4.5, rx: 1.45, ry: 1.5 },
    { z: -7.0, rx: 0.75, ry: 0.8 },
    { z: -8.8, rx: 0.4, ry: 0.5 },
    { z: -9.5, rx: 0.12, ry: 0.2 },
  ];
  addLoft(vg, stations, 12, (t, a) => {
    const down = smoothstep(0.15, -0.55, Math.sin(a));
    const groove = Math.abs(Math.sin(a * 9)) < 0.2 && Math.sin(a) < -0.2 && t < 0.62 ? 0.82 : 1;
    const patch = hash2(Math.floor(t * 14), Math.floor(a * 3)) > 0.86 ? 1.18 : 1;
    return [mix(back[0], belly[0], down) * groove * patch, mix(back[1], belly[1], down) * groove * patch, mix(back[2], belly[2], down) * groove * patch];
  });
  const fin = rgb(0x2f4553);
  // dorsal hump fin
  tri(vg, [0, 2.45, -2.2], [0, 3.3, -3.6], [0, 2.1, -4.1], fin);
  // long pectoral fins
  for (const sx of [-1, 1]) {
    tri(vg, [sx * 1.7, -1.2, 5.2], [sx * 6.2, -2.8, 3.3], [sx * 1.8, -1.6, 3.2], rgb(0xe4eef0), fin);
  }
  // flukes (horizontal tail): wide, scalloped
  const fl = rgb(0x2b4452);
  const fl2 = rgb(0x9fb4bb);
  for (const sx of [-1, 1]) {
    quadTri(vg, [sx * 0.1, 0.0, -9.0], [sx * 4.8, 0.25, -11.0], [sx * 3.4, 0.2, -11.7], [sx * 0.1, 0.0, -10.2], fl);
    tri(vg, [sx * 0.1, -0.02, -9.0], [sx * 4.8, 0.2, -11.0], [sx * 2.5, -0.02, -10.2], fl2);
  }
  for (const sx of [-1, 1]) {
    const eye = new THREE.IcosahedronGeometry(0.16, 0);
    vg.add(eye, composeMat(sx * 1.52, 0.1, 6.9), [0.01, 0.01, 0.015]);
    eye.dispose();
  }
  return vg.build();
}

/** A manta ray, wingspan ~5 m, nose at +z. */
export function mantaGeometry(): THREE.BufferGeometry {
  const vg = new VGeo();
  const back = rgb(0x24394a);
  const belly = rgb(0xf2f6f6);
  const pos: number[] = [];
  const idx: number[] = [];
  const col: number[] = [];
  const nx = 12;
  const nz = 7;
  const S = 2.6;
  const rowsIdx: number[][] = [];
  for (let j = 0; j <= nz; j++) {
    const tz = j / nz;
    const row: number[] = [];
    for (let i = 0; i <= nx; i++) {
      const tx = (i / nx) * 2 - 1;
      const ax = Math.abs(tx);
      // diamond outline: chord shrinks toward the wing tips, leading edge sweeps back
      const chord = 1.5 * (1 - ax * 0.88);
      const z = 0.9 - ax * 0.55 - tz * chord;
      const y = 0.18 * (1 - ax) * Math.sin(Math.PI * Math.min(1, tz * 1.1)) - ax * ax * 0.05;
      pos.push(tx * S, y, z);
      const spot = hash2(Math.floor(i * 1.3), j * 2) > 0.9 && ax < 0.8 && tz > 0.2 && tz < 0.85;
      const c = spot ? [0.8, 0.84, 0.84] : back;
      col.push(c[0] * (0.88 + 0.2 * (1 - ax)), c[1] * (0.88 + 0.2 * (1 - ax)), c[2] * (0.88 + 0.2 * (1 - ax)));
      row.push(pos.length / 3 - 1);
    }
    rowsIdx.push(row);
  }
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) idx.push(rowsIdx[j][i], rowsIdx[j + 1][i], rowsIdx[j + 1][i + 1], rowsIdx[j][i], rowsIdx[j + 1][i + 1], rowsIdx[j][i + 1]);
  vg.addRaw(pos, idx, col);
  // pale belly: a slightly lower copy, light colour
  const pos2 = pos.map((v, k) => (k % 3 === 1 ? v - 0.05 : v));
  const col2: number[] = [];
  for (let k = 0; k < pos.length / 3; k++) col2.push(belly[0] * 0.95, belly[1] * 0.95, belly[2] * 0.95);
  const idx2: number[] = [];
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) idx2.push(rowsIdx[j][i], rowsIdx[j + 1][i + 1], rowsIdx[j + 1][i], rowsIdx[j][i], rowsIdx[j][i + 1], rowsIdx[j + 1][i + 1]);
  vg.addRaw(pos2, idx2, col2);
  // cephalic horns
  for (const sx of [-1, 1]) tri(vg, [sx * 0.35, 0.02, 0.88], [sx * 0.5, 0.0, 1.5], [sx * 0.2, 0.0, 0.88], back);
  // tail
  tri(vg, [-0.08, 0.0, -0.55], [0.08, 0.0, -0.55], [0, 0.0, -3.2], back);
  const eyes = new THREE.IcosahedronGeometry(0.05, 0);
  for (const sx of [-1, 1]) vg.add(eyes, composeMat(sx * 0.5, 0.1, 0.55), [0.01, 0.01, 0.02]);
  eyes.dispose();
  return vg.build();
}

/** A sea turtle, ~1.4 m long, head at +z. */
export function turtleGeometry(): THREE.BufferGeometry {
  const vg = new VGeo();
  const shell = rgb(0x6b6a37);
  const shell2 = rgb(0x8f8a48);
  const skin = rgb(0x9fb086);
  const sh = new THREE.SphereGeometry(1, 12, 8);
  vg.add(sh, composeMat(0, 0.02, -0.05, 0, 0, 0, 0.5, 0.2, 0.68), ((x, y, z, nx, ny, nz, out) => {
    const cell = hash2(Math.floor(x * 5), Math.floor(z * 5));
    const t = cell > 0.55 ? 1 : 0;
    out[0] = mix(shell[0], shell2[0], t) * (0.8 + 0.3 * ny);
    out[1] = mix(shell[1], shell2[1], t) * (0.8 + 0.3 * ny);
    out[2] = mix(shell[2], shell2[2], t) * (0.8 + 0.3 * ny);
    void y;
    void nx;
    void nz;
  }) as VertexColorFn);
  sh.dispose();
  const belly = new THREE.SphereGeometry(1, 10, 6);
  vg.add(belly, composeMat(0, -0.05, -0.05, 0, 0, 0, 0.44, 0.13, 0.6), skin);
  belly.dispose();
  const head = new THREE.SphereGeometry(0.13, 8, 6);
  vg.add(head, composeMat(0, 0.03, 0.78, 0, 0, 0, 1, 0.85, 1.25), skin);
  head.dispose();
  const neck = new THREE.CylinderGeometry(0.09, 0.12, 0.3, 6);
  neck.rotateX(Math.PI / 2);
  vg.add(neck, composeMat(0, 0.02, 0.62), skin);
  neck.dispose();
  // flippers: front pair large and swept, rear pair small
  for (const sx of [-1, 1]) {
    tri(vg, [sx * 0.34, -0.02, 0.42], [sx * 1.15, -0.1, 0.12], [sx * 0.4, -0.04, 0.02], skin, [skin[0] * 0.8, skin[1] * 0.8, skin[2] * 0.8]);
    tri(vg, [sx * 0.3, -0.03, -0.42], [sx * 0.62, -0.06, -0.72], [sx * 0.25, -0.03, -0.62], skin);
  }
  for (const sx of [-1, 1]) {
    const eye = new THREE.IcosahedronGeometry(0.025, 0);
    vg.add(eye, composeMat(sx * 0.1, 0.07, 0.86), [0.02, 0.02, 0.02]);
    eye.dispose();
  }
  return vg.build();
}

/** A jellyfish (bell + tentacles), bell radius 0.5, tentacles hang to about y = -1.5. Colours > 1 glow. */
export function jellyGeometry(): THREE.BufferGeometry {
  const vg = new VGeo();
  const bell = new THREE.SphereGeometry(0.5, 10, 5, 0, TAU, 0, Math.PI / 2);
  vg.add(bell, composeMat(0, 0, 0, 0, 0, 0, 1, 0.82, 1), ((x, y, z, nx, ny, nz, out) => {
    const rim = smoothstep(0.25, 0.0, y);
    const ribs = 0.8 + 0.3 * Math.abs(Math.sin(Math.atan2(z, x) * 8));
    out[0] = mix(0.7, 1.5, rim) * ribs;
    out[1] = mix(0.9, 0.55, rim) * ribs;
    out[2] = mix(1.5, 1.6, rim) * ribs;
    void nx;
    void ny;
    void nz;
  }) as VertexColorFn);
  bell.dispose();
  // inner glow core
  const core = new THREE.SphereGeometry(0.22, 8, 5, 0, TAU, 0, Math.PI / 2);
  vg.add(core, composeMat(0, 0.0, 0, 0, 0, 0, 1, 0.9, 1), [1.9, 1.5, 2.1]);
  core.dispose();
  // tentacles: eight ribbons
  const n = 8;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * TAU;
    const len = 1.0 + 0.6 * hash2(k, 3);
    const segs = 6;
    const pos: number[] = [];
    const idx: number[] = [];
    const colr: number[] = [];
    const bx = Math.cos(a) * 0.42;
    const bz = Math.sin(a) * 0.42;
    const tx = -Math.sin(a) * 0.022;
    const tz = Math.cos(a) * 0.022;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const y = -t * len;
      pos.push(bx - tx * (1 - t * 0.6), y, bz - tz * (1 - t * 0.6), bx + tx * (1 - t * 0.6), y, bz + tz * (1 - t * 0.6));
      const f = 1.2 - 0.8 * t;
      colr.push(1.5 * f, 0.7 * f, 1.7 * f, 1.5 * f, 0.7 * f, 1.7 * f);
      if (i < segs) {
        const b = i * 2;
        idx.push(b, b + 1, b + 3, b, b + 3, b + 2);
      }
    }
    vg.addRaw(pos, idx, colr);
  }
  // two long oral arms
  for (let k = 0; k < 2; k++) {
    const a = k * Math.PI + 0.4;
    const pos: number[] = [];
    const idx: number[] = [];
    const colr: number[] = [];
    for (let i = 0; i <= 5; i++) {
      const t = i / 5;
      pos.push(Math.cos(a) * 0.08 - 0.04, -t * 1.5, Math.sin(a) * 0.08, Math.cos(a) * 0.08 + 0.04, -t * 1.5, Math.sin(a) * 0.08);
      colr.push(1.9 * (1.1 - t), 1.2 * (1.1 - t), 2.0 * (1.1 - t), 1.9 * (1.1 - t), 1.2 * (1.1 - t), 2.0 * (1.1 - t));
      if (i < 5) idx.push(i * 2, i * 2 + 1, i * 2 + 3, i * 2, i * 2 + 3, i * 2 + 2);
    }
    vg.addRaw(pos, idx, colr);
  }
  return vg.build();
}

// ── Kelp ─────────────────────────────────────────────────────────────────────

const KELP_VERT = /* glsl */ `
attribute vec4 aKelp;
uniform float uTime;
varying vec3 gkW;
varying float vH;
void main() {
  float s = aKelp.w;
  float h = (6.0 + fract(s * 7.31) * 9.0);
  float t = position.y;
  vH = t;
  float sway = pow(t, 1.5);
  float ph = uTime * (0.55 + fract(s * 3.7) * 0.3) + s * 31.0;
  vec3 p = vec3(position.x * (0.55 + fract(s * 5.1) * 0.35), t * h, position.z * 0.6);
  p.x += (sin(ph) * 0.9 + sin(ph * 2.3 + 1.0) * 0.25) * sway * h * 0.12;
  p.z += (cos(ph * 0.83) * 0.8) * sway * h * 0.1;
  // blades fan out in yaw by seed
  float yaw = s * 6.2831 * 7.0;
  float cy = cos(yaw);
  float sy = sin(yaw);
  p = vec3(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy);
  vec3 w = vec3(aKelp.x, aKelp.y, aKelp.z) + p;
  gkW = w;
  vec4 mv = viewMatrix * vec4(w, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

const KELP_FRAG = /* glsl */ `
uniform vec3 uWaterCol;
uniform float uWaterDens;
uniform vec2 uDome;
varying vec3 gkW;
varying float vH;
void main() {
  vec3 base = vec3(0.07, 0.30, 0.17);
  vec3 tip = vec3(0.52, 0.66, 0.2);
  vec3 col = mix(base, tip, smoothstep(0.0, 1.0, vH));
  col *= 0.8 + 0.4 * smoothstep(0.0, 0.45, vH) * (1.0 - vH * 0.3);
  vec3 gkD = gkW - cameraPosition;
  float gkK = uDome.x / uDome.y;
  vec3 gkOs = vec3(cameraPosition.x, cameraPosition.y * gkK, cameraPosition.z);
  vec3 gkDs = vec3(gkD.x, gkD.y * gkK, gkD.z);
  float gkA2 = max(dot(gkDs, gkDs), 1e-4);
  float gkB2 = dot(gkOs, gkDs);
  float gkC2 = dot(gkOs, gkOs) - uDome.x * uDome.x;
  float gkDisc = gkB2 * gkB2 - gkA2 * gkC2;
  float gkIn = 0.0;
  if (gkC2 < 0.0 && gkDisc > 0.0) gkIn = clamp((-gkB2 + sqrt(gkDisc)) / gkA2, 0.0, 1.0);
  float gkLen = (1.0 - gkIn) * length(gkD);
  float gkWf = 1.0 - exp(-uWaterDens * gkLen);
  col = mix(col, uWaterCol, gkWf);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function kelpBladeGeometry(): THREE.BufferGeometry {
  // 3 crossed ribbons, each 9 segments tall, tapering; position.y is the 0..1 height fraction, x/z the ribbon width offsets.
  const pos: number[] = [];
  const idx: number[] = [];
  const segs = 9;
  for (let r = 0; r < 2; r++) {
    const a = (r / 2) * Math.PI;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const base = pos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const w = 0.42 * (1 - t * 0.78) * (1 + 0.15 * Math.sin(t * 9));
      pos.push(dx * w, t, dz * w, -dx * w, t, -dz * w);
      if (i < segs) {
        const b = base + i * 2;
        idx.push(b, b + 1, b + 3, b, b + 3, b + 2);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(new THREE.BufferAttribute(new Uint16Array(idx), 1));
  return g;
}

export class KelpForest {
  readonly mesh: THREE.Mesh;
  readonly max: number;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly mat: THREE.ShaderMaterial;

  constructor(shared: OceanShared, domeR: number, count: number) {
    this.max = count;
    const base = kelpBladeGeometry();
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = base.index;
    this.geo.setAttribute('position', base.getAttribute('position'));
    const rng = mulberry32(0x6e1f);
    const arr = new Float32Array(count * 4);
    // Clumps: groves around the dome at 38..78 m, denser near the glass.
    const groves = 22;
    const gc: Array<[number, number, number]> = [];
    for (let i = 0; i < groves; i++) {
      const a = (i / groves) * TAU + rng() * 0.25;
      const r = domeR + 6 + rng() * 38;
      gc.push([Math.cos(a) * r, Math.sin(a) * r, 2 + rng() * 5]);
    }
    for (let i = 0; i < count; i++) {
      const g = gc[i % groves];
      const a = rng() * TAU;
      const d = Math.sqrt(rng()) * g[2];
      const x = g[0] + Math.cos(a) * d;
      const z = g[1] + Math.sin(a) * d;
      arr.set([x, seabedHeight(x, z, domeR + 4) - 0.1, z, rng()], i * 4);
    }
    this.geo.setAttribute('aKelp', new THREE.InstancedBufferAttribute(arr, 4));
    this.geo.instanceCount = count;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: shared.uTime, uWaterCol: shared.uWaterCol, uWaterDens: shared.uWaterDens, uDome: shared.uDome },
      vertexShader: KELP_VERT,
      fragmentShader: KELP_FRAG,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    base.dispose();
  }

  setCount(n: number): void {
    this.geo.instanceCount = Math.min(this.max, Math.max(0, n));
    this.mesh.visible = n > 0;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ── Reef + far props ─────────────────────────────────────────────────────────

const CORALS: RGB[] = [rgb(0xe04f7b), rgb(0xf08a45), rgb(0x9a6bd6), rgb(0xe9c14a), rgb(0x4fc1b4), rgb(0xd96aa8)];
const REEF_ROCK = rgb(0x4e6470);

function lump(seed: number, amp: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 0);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const h = hash2(Math.round(p.getX(i) * 20) + seed, Math.round(p.getY(i) * 20) + Math.round(p.getZ(i) * 20) * 1.3);
    const k = 1 - amp / 2 + h * amp;
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k);
  }
  g.computeVertexNormals();
  return g;
}

export interface ReefGeometry {
  geometry: THREE.BufferGeometry;
  /** Index counts at which to cut the draw range per tier (cluster boundaries). */
  tierIndexCount: Record<QualityTier, number>;
  stats: { clusters: number };
}

function addReefCluster(vg: VGeo, cx: number, cz: number, rng: Rng, scale: number): void {
  const y = seabedHeight(cx, cz);
  const n = 4 + Math.floor(rng() * 4);
  const hue = Math.floor(rng() * CORALS.length);
  for (let i = 0; i < n; i++) {
    const a = rng() * TAU;
    const d = rng() * 3.2 * scale;
    const x = cx + Math.cos(a) * d;
    const z = cz + Math.sin(a) * d;
    const gy = seabedHeight(x, z) - 0.15;
    const col = CORALS[(hue + Math.floor(rng() * 3)) % CORALS.length];
    const kind = rng();
    const s = (0.7 + rng() * 1.1) * scale;
    if (kind < 0.3) {
      // brain coral dome
      const g = lump(i + Math.floor(cx), 0.25);
      vg.add(g, composeMat(x, gy + 0.2 * s, z, 0, rng() * TAU, 0, 0.9 * s, 0.62 * s, 0.9 * s), col);
      g.dispose();
    } else if (kind < 0.55) {
      // tube corals: a bundle of cylinders
      const m = 3 + Math.floor(rng() * 3);
      for (let k = 0; k < m; k++) {
        const hh = (0.9 + rng() * 1.6) * s;
        const c = new THREE.CylinderGeometry(0.12 * s, 0.17 * s, hh, 6, 1);
        vg.add(c, composeMat(x + (rng() - 0.5) * 0.8 * s, gy + hh / 2, z + (rng() - 0.5) * 0.8 * s, (rng() - 0.5) * 0.3, 0, (rng() - 0.5) * 0.3), col);
        c.dispose();
        const cap = new THREE.CylinderGeometry(0.1 * s, 0.1 * s, 0.04, 6, 1);
        vg.add(cap, composeMat(x, gy + hh, z), [col[0] * 1.3, col[1] * 1.3, col[2] * 1.3]);
        cap.dispose();
      }
    } else if (kind < 0.8) {
      // branching coral: a trunk and 4 forks
      const h0 = (1.2 + rng() * 1.5) * s;
      const trunk = new THREE.CylinderGeometry(0.1 * s, 0.2 * s, h0, 6, 1);
      vg.add(trunk, composeMat(x, gy + h0 / 2, z), col);
      trunk.dispose();
      for (let k = 0; k < 4; k++) {
        const b = new THREE.CylinderGeometry(0.04 * s, 0.1 * s, h0 * 0.7, 5, 1);
        const aa = (k / 4) * TAU + rng();
        vg.add(b, composeMat(x + Math.cos(aa) * 0.3 * s, gy + h0 * 0.85, z + Math.sin(aa) * 0.3 * s, Math.sin(aa) * 0.7, 0, -Math.cos(aa) * 0.7), [col[0] * 1.15, col[1] * 1.15, col[2] * 1.15]);
        b.dispose();
      }
    } else {
      // table coral
      const h0 = (0.8 + rng() * 1.2) * s;
      const stem = new THREE.CylinderGeometry(0.12 * s, 0.2 * s, h0, 6, 1);
      vg.add(stem, composeMat(x, gy + h0 / 2, z), REEF_ROCK);
      stem.dispose();
      const table = new THREE.CylinderGeometry(1.3 * s, 0.9 * s, 0.14 * s, 9, 1);
      vg.add(table, composeMat(x, gy + h0, z, 0, rng() * TAU, 0), col);
      table.dispose();
    }
  }
  // a base rock or two
  for (let i = 0; i < 2; i++) {
    const g = lump(i + Math.floor(cz), 0.35);
    const s = (0.8 + rng() * 1.2) * scale;
    vg.add(g, composeMat(cx + (rng() - 0.5) * 2.5, y + 0.2 * s, cz + (rng() - 0.5) * 2.5, 0, rng() * TAU, 0, 1.5 * s, 0.6 * s, 1.3 * s), REEF_ROCK);
    g.dispose();
  }
}

function addShipwreck(vg: VGeo, x: number, z: number, yaw: number): void {
  const wood = rgb(0x2d3a40);
  const wood2 = rgb(0x3b4a50);
  const y = seabedHeight(x, z);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.12, yaw, 0.38, 'YXZ'));
  const place = (g: THREE.BufferGeometry, lx: number, ly: number, lz: number, sx: number, sy: number, sz: number, col: RGB): void => {
    const v = new THREE.Vector3(lx, ly, lz).applyQuaternion(q);
    vg.add(g, new THREE.Matrix4().compose(new THREE.Vector3(x + v.x, y + 3 + v.y, z + v.z), q, new THREE.Vector3(sx, sy, sz)), col);
  };
  // hull: a long tapered half-shell (open topped), ribs, a stub mast, broken stern castle
  const hull = new THREE.CylinderGeometry(5, 3.2, 34, 10, 1, true, 0, Math.PI);
  hull.rotateX(Math.PI / 2);
  hull.rotateZ(Math.PI);
  const hullOut = new THREE.Matrix4();
  void hullOut;
  place(hull, 0, 0, 0, 1, 1, 1, wood);
  hull.dispose();
  for (let i = -6; i <= 6; i++) {
    const rib = new THREE.BoxGeometry(0.5, 7.5, 0.6);
    place(rib, 0, 1.5, i * 2.4, 1, 1 - Math.abs(i) * 0.06, 1, wood2);
    rib.dispose();
  }
  const deck = new THREE.BoxGeometry(8, 0.5, 26);
  place(deck, 0, -0.6, -1, 1, 1, 1, wood2);
  deck.dispose();
  const mast = new THREE.CylinderGeometry(0.4, 0.55, 22, 6, 1);
  place(mast, 0.5, 9, 4, 1, 1, 1, wood);
  mast.dispose();
  const yard = new THREE.CylinderGeometry(0.22, 0.22, 11, 5, 1);
  yard.rotateZ(Math.PI / 2);
  place(yard, 0.5, 14, 4, 1, 1, 1, wood2);
  yard.dispose();
  const castle = new THREE.BoxGeometry(7.5, 5, 7);
  place(castle, 0, 3.5, -14, 1, 1, 1, wood);
  castle.dispose();
}

export function buildReef(domeR: number): ReefGeometry {
  const vg = new VGeo();
  const rng = mulberry32(0x7ee3);
  const tierIndexCount: Record<QualityTier, number> = { low: 0, medium: 0, high: 0 };
  // Far props first (always drawn): the shipwreck, giant spires and arches around the horizon.
  addShipwreck(vg, Math.cos(3.6) * 108, Math.sin(3.6) * 108, 0.7);
  for (let i = 0; i < 9; i++) {
    const a = rng() * TAU;
    const r = 96 + rng() * 70;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const h = 14 + rng() * 26;
    const spire = new THREE.ConeGeometry(4 + rng() * 5, h, 7, 3);
    const sp = spire.getAttribute('position');
    for (let v = 0; v < sp.count; v++) {
      const k = 1 + (hash2(v, i) - 0.5) * 0.35;
      sp.setX(v, sp.getX(v) * k);
      sp.setZ(v, sp.getZ(v) * k);
    }
    spire.computeVertexNormals();
    vg.add(spire, composeMat(x, seabedHeight(x, z) + h / 2 - 1, z), ((px, py, pz, nx, ny, nz, out) => {
      const t = smoothstep(0, 1, (py - seabedHeight(x, z)) / h);
      out[0] = mix(0.18, 0.3, t);
      out[1] = mix(0.28, 0.4, t);
      out[2] = mix(0.34, 0.44, t);
      void px;
      void pz;
      void nx;
      void ny;
      void nz;
    }) as VertexColorFn);
    spire.dispose();
  }
  // Reef clusters in the ring just outside the glass; low/medium use the first N clusters (evenly spread by construction).
  const clusters = 34;
  const ends: number[] = [];
  const order: number[] = [];
  for (let i = 0; i < clusters; i++) order.push(i);
  // interleave so any prefix is spread around the ring
  const spread = order.map((i) => ((i * 17) % clusters));
  for (let k = 0; k < clusters; k++) {
    const i = spread[k];
    const a = (i / clusters) * TAU + (rng() - 0.5) * 0.08;
    const r = domeR + 4.5 + rng() * 20 + (k % 3) * 4;
    addReefCluster(vg, Math.cos(a) * r, Math.sin(a) * r, rng, 0.85 + rng() * 0.5);
    ends.push(vg.triangleCount * 3);
  }
  const geometry = vg.build();
  tierIndexCount.high = geometry.index?.count ?? 0;
  tierIndexCount.medium = ends[Math.floor(clusters * 0.62) - 1] ?? tierIndexCount.high;
  tierIndexCount.low = ends[Math.floor(clusters * 0.32) - 1] ?? tierIndexCount.high;
  // The far props are at the start of the index buffer, so a draw-range prefix always includes them.
  return { geometry, tierIndexCount, stats: { clusters } };
}

// ── The assembled sea life ───────────────────────────────────────────────────

interface SpeciesRow {
  path: [number, number, number, number];
  off?: [number, number, number, number];
  tint?: [number, number, number, number];
}

const FISH_TINTS_A: RGB[] = [rgb(0xffd23c), rgb(0xff9a2e), rgb(0xffe86a)];
const FISH_TINTS_B: RGB[] = [rgb(0xc7d7e4), rgb(0x9bb5cf), rgb(0xd9e6ef)];
const FISH_TINTS_C: RGB[] = [rgb(0x3aa0ff), rgb(0x6c7bff), rgb(0xff6a4c)];

function schoolRows(rng: Rng, schools: Array<{ r: number; h: number; w: number; ph: number; n: number; tint: RGB; spread: number; scale: number }>): SpeciesRow[] {
  // Build per-school lists, then interleave so cutting the tail thins every school evenly.
  const lists: SpeciesRow[][] = schools.map((s) => {
    const rows: SpeciesRow[] = [];
    for (let i = 0; i < s.n; i++) {
      const j = (v: number): number => (rng() - 0.5) * v;
      const t = 0.85 + rng() * 0.3;
      rows.push({
        path: [s.r, s.h, s.w, s.ph],
        off: [j(s.spread * 1.6), j(s.spread * 0.8), j(s.spread * 2.4), rng()],
        tint: [s.tint[0] * t, s.tint[1] * t, s.tint[2] * t, s.scale * (0.85 + rng() * 0.35)],
      });
    }
    return rows;
  });
  const out: SpeciesRow[] = [];
  const most = Math.max(...lists.map((l) => l.length));
  for (let i = 0; i < most; i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

export interface SeaLifeStats {
  fish: number;
  sharks: number;
  whales: number;
  mantas: number;
  turtles: number;
  jellies: number;
  kelp: number;
}

interface Species {
  name: string;
  mesh: THREE.Mesh;
  inst: CreatureInstances;
  geometry: THREE.InstancedBufferGeometry;
  material: THREE.Material;
  base: THREE.BufferGeometry;
  /** Instance counts per tier. */
  counts: Record<QualityTier, number>;
}

export class SeaLife {
  readonly root = new THREE.Group();
  readonly kelp: KelpForest;
  readonly reefMesh: THREE.Mesh;
  private readonly reef: ReefGeometry;
  private readonly species: Species[] = [];
  private readonly reefMat: THREE.MeshStandardMaterial;
  private tier: QualityTier = 'high';

  constructor(shared: OceanShared, domeR: number) {
    const rng = mulberry32(0xf15c);
    const add = (name: string, base: THREE.BufferGeometry, rows: SpeciesRow[], mat: THREE.Material, counts: Record<QualityTier, number>, order = 0): void => {
      const { geometry, inst } = makeInstanced(base, rows);
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.name = `ocean-${name}`;
      mesh.frustumCulled = false;
      mesh.renderOrder = order;
      this.root.add(mesh);
      this.species.push({ name, mesh, inst, geometry, material: mat, base, counts });
    };

    // Fish schools (orbits at 40-56 m, bobbing).
    const R0 = domeR + 8;
    add(
      'fishA',
      fishGeometry('a'),
      schoolRows(rng, [
        { r: R0 + 0, h: 6, w: 0.055, ph: 0.4, n: 22, tint: FISH_TINTS_A[0], spread: 2.6, scale: 1 },
        { r: R0 + 9, h: 13, w: -0.048, ph: 2.6, n: 22, tint: FISH_TINTS_A[1], spread: 3, scale: 1 },
        { r: R0 + 17, h: 4, w: 0.04, ph: 4.4, n: 22, tint: FISH_TINTS_A[2], spread: 3.2, scale: 1.1 },
      ]),
      creatureMaterial(shared, { key: 'fishA', mode: 'orbit', len: 0.42, span: 0.2, wag: [0.2, 16], bob: 1.5, school: true }),
      { low: 14, medium: 44, high: 66 },
    );
    add(
      'fishB',
      fishGeometry('b'),
      schoolRows(rng, [
        { r: R0 + 4, h: 9, w: -0.062, ph: 1.4, n: 26, tint: FISH_TINTS_B[0], spread: 3.4, scale: 1.1 },
        { r: R0 + 13, h: 18, w: 0.05, ph: 3.5, n: 26, tint: FISH_TINTS_B[1], spread: 3.8, scale: 1.2 },
      ]),
      creatureMaterial(shared, { key: 'fishB', mode: 'orbit', len: 0.5, span: 0.2, wag: [0.22, 19], bob: 2, school: true }),
      { low: 10, medium: 34, high: 52 },
    );
    add(
      'fishC',
      fishGeometry('c'),
      schoolRows(rng, [
        { r: R0 + 2, h: 3, w: 0.07, ph: 5.2, n: 14, tint: FISH_TINTS_C[0], spread: 2.2, scale: 1.2 },
        { r: R0 + 22, h: 8, w: -0.042, ph: 0.9, n: 14, tint: FISH_TINTS_C[2], spread: 2.4, scale: 1.2 },
      ]),
      creatureMaterial(shared, { key: 'fishC', mode: 'orbit', len: 0.42, span: 0.2, wag: [0.2, 17], bob: 1, school: true }),
      { low: 8, medium: 20, high: 28 },
    );

    // Sharks: three orbits, different radius / height / direction.
    add(
      'sharks',
      sharkGeometry(),
      [
        { path: [R0 + 14, 10, 0.075, 0.2], off: [0, 0, 0, 0.11], tint: [1, 1, 1, 1.5] },
        { path: [R0 + 28, 17, -0.062, 2.4], off: [0, 0, 0, 0.47], tint: [1, 1, 1, 1.7] },
        { path: [R0 + 41, 6.5, 0.052, 4.3], off: [0, 0, 0, 0.83], tint: [0.92, 0.95, 1, 1.9] },
      ],
      creatureMaterial(shared, { key: 'shark', mode: 'orbit', len: 5.4, span: 1.7, wag: [0.07, 2.4], bob: 1.8 }),
      { low: 2, medium: 3, high: 3 },
    );

    // Whales: a slow straight pass every 110 / 150 s.
    add(
      'whales',
      whaleGeometry(),
      [
        { path: [-92, 26, 110, 0.32], off: [0, 0, 0, 0.3], tint: [1, 1, 1, 1] },
        { path: [112, 38, -150, 0.7], off: [0, 0, 0, 0.6], tint: [0.9, 0.95, 1, 1.15] },
      ],
      creatureMaterial(shared, { key: 'whale', mode: 'line', len: 19, span: 6, wag: [0.035, 0.9], bob: 3, lineHalf: 230 }),
      { low: 1, medium: 2, high: 2 },
    );

    // Manta rays.
    add(
      'mantas',
      mantaGeometry(),
      [
        { path: [R0 + 10, 14, 0.06, 1.1], off: [0, 0, 0, 0.21], tint: [1, 1, 1, 1.4] },
        { path: [R0 + 10, 15.5, 0.06, 1.55], off: [0, 0, 0, 0.35], tint: [1, 1, 1, 1.1] },
        { path: [R0 + 30, 22, -0.05, 3.9], off: [0, 0, 0, 0.62], tint: [1, 1, 1, 1.7] },
        { path: [R0 + 24, 9, 0.045, 5.5], off: [0, 0, 0, 0.9], tint: [0.95, 1, 1, 1.3] },
      ],
      creatureMaterial(shared, { key: 'manta', mode: 'orbit', len: 3, span: 2.6, flap: [0.16, 2.3], bob: 2.5 }),
      { low: 2, medium: 3, high: 4 },
    );

    // Turtles.
    add(
      'turtles',
      turtleGeometry(),
      [
        { path: [R0 + 3, 4.5, 0.032, 0.3], off: [0, 0, 0, 0.13], tint: [1, 1, 1, 1.5] },
        { path: [R0 + 18, 7, -0.03, 2.1], off: [0, 0, 0, 0.36], tint: [1, 1, 1, 1.8] },
        { path: [R0 + 9, 10, 0.028, 3.7], off: [0, 0, 0, 0.55], tint: [1, 1, 1, 1.4] },
        { path: [R0 + 26, 5.5, -0.026, 5.0], off: [0, 0, 0, 0.74], tint: [1, 1, 1, 2] },
        { path: [R0 + 14, 3.5, 0.034, 0.9], off: [0, 0, 0, 0.92], tint: [1, 1, 1, 1.6] },
      ],
      creatureMaterial(shared, { key: 'turtle', mode: 'orbit', len: 1.4, span: 1.1, flap: [0.2, 3.4], bob: 1.2 }),
      { low: 3, medium: 4, high: 5 },
    );

    // Jellyfish (glowing, pulsing, drifting) - transparent, drawn before the glass.
    const jellyRows: SpeciesRow[] = [];
    for (let i = 0; i < 18; i++) {
      const hue = rgb([0xff7ad8, 0x8ad2ff, 0xb18aff, 0x7affd0][i % 4]);
      jellyRows.push({
        path: [domeR + 7 + rng() * 34, 4 + rng() * 22, 0.2 + rng() * 0.25, rng() * TAU],
        off: [0, 0, 0, rng()],
        tint: [hue[0] * 1.2, hue[1] * 1.2, hue[2] * 1.2, 1.2 + rng() * 1.6],
      });
    }
    add(
      'jellies',
      jellyGeometry(),
      jellyRows,
      creatureMaterial(shared, { key: 'jelly', mode: 'drift', len: 1, span: 1, basic: true, pulse: 2.4, transparent: true, opacity: 0.82 }),
      { low: 0, medium: 10, high: 18 },
      -1,
    );

    // Kelp + reef.
    this.kelp = new KelpForest(shared, domeR, 170);
    this.kelp.mesh.renderOrder = 0;
    this.kelp.mesh.name = 'ocean-kelp';
    this.root.add(this.kelp.mesh);
    this.reef = buildReef(domeR);
    this.reefMat = patchLit(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85, metalness: 0 }), shared, { key: 'reef', waterFog: true });
    this.reefMesh = new THREE.Mesh(this.reef.geometry, this.reefMat);
    this.reefMesh.name = 'ocean-reef';
    this.reefMesh.frustumCulled = false;
    this.root.add(this.reefMesh);
    this.setTier('high');
  }

  setTier(tier: QualityTier): void {
    this.tier = tier;
    for (const s of this.species) {
      const n = Math.min(s.inst.count, s.counts[tier]);
      s.geometry.instanceCount = n;
      s.mesh.visible = n > 0;
    }
    this.kelp.setCount(tier === 'high' ? 170 : tier === 'medium' ? 110 : 50);
    this.reef.geometry.setDrawRange(0, this.reef.tierIndexCount[tier]);
  }

  getTier(): QualityTier {
    return this.tier;
  }

  /** Visible instance counts per species (tests / HUD). */
  getStats(): SeaLifeStats {
    const c = (name: string): number => this.species.find((s) => s.name === name)?.geometry.instanceCount ?? 0;
    return {
      fish: c('fishA') + c('fishB') + c('fishC'),
      sharks: c('sharks'),
      whales: c('whales'),
      mantas: c('mantas'),
      turtles: c('turtles'),
      jellies: c('jellies'),
      kelp: this.kelp.mesh.visible ? (this.kelp.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount : 0,
    };
  }

  /** Species meshes (tests count draw calls from `root`). */
  get speciesMeshes(): readonly THREE.Mesh[] {
    return this.species.map((s) => s.mesh);
  }

  dispose(): void {
    for (const s of this.species) {
      s.geometry.dispose();
      s.base.dispose();
      s.material.dispose();
    }
    this.kelp.dispose();
    this.reef.geometry.dispose();
    this.reefMat.dispose();
    this.root.removeFromParent();
  }
}
