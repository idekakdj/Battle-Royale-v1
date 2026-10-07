/**
 * Jungle ground (WP-J3): the procedural mossy-earth texture of the clearing. Painted once at init from the ARENA DATA — tree
 * roots radiate from every trunk, the pool basin (pebbly floor + wet-mud shoreline) sits at the pool disc, dry clearings lie under
 * the pickup pads — over a 3-scale noise mottle of mud, olive earth, leaf litter and grass. The brighter moss patches are NOT in
 * this texture (they are glowing decals, see moss.ts) so they stay readable against the muted ground.
 *
 * Node-safe: without a DOM (vitest) it returns a 1×1 flat texture.
 */

import * as THREE from 'three';
import type { ArenaDef } from '../../config/arenas';
import { mulberry32 } from '../../core/math';
import { smoothstep } from './vgeo';
import { POOL_BANK_WIDTH, poolFloorHeight } from '../arenaContext';

/** Metres of ground disc beyond the wall (hidden under the foliage ring). */
export const GROUND_MARGIN = 4;

class NoiseGrid {
  private readonly g: Float32Array;
  constructor(private readonly n: number, seed: number) {
    const rng = mulberry32(seed);
    this.g = new Float32Array(n * n);
    for (let i = 0; i < this.g.length; i++) this.g[i] = rng();
  }
  /** Tileable bilinear sample at lattice coords (x, z). */
  sample(x: number, z: number): number {
    const n = this.n;
    const fx = Math.floor(x);
    const fz = Math.floor(z);
    const tx = x - fx;
    const tz = z - fz;
    const x0 = ((fx % n) + n) % n;
    const z0 = ((fz % n) + n) % n;
    const x1 = (x0 + 1) % n;
    const z1 = (z0 + 1) % n;
    const sx = tx * tx * (3 - 2 * tx);
    const sz = tz * tz * (3 - 2 * tz);
    const a = this.g[z0 * n + x0];
    const b = this.g[z0 * n + x1];
    const c = this.g[z1 * n + x0];
    const d = this.g[z1 * n + x1];
    return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
  }
}

export interface GroundTexture {
  map: THREE.Texture;
  /** Ground disc radius (m) the texture spans edge to edge. */
  radius: number;
}

export function makeGroundTexture(arena: ArenaDef, size = 1024): GroundTexture {
  const R = arena.wallRadius + GROUND_MARGIN;
  if (typeof document === 'undefined') {
    const flat = new THREE.DataTexture(new Uint8Array([70, 86, 50, 255]), 1, 1);
    flat.colorSpace = THREE.SRGBColorSpace;
    flat.needsUpdate = true;
    return { map: flat, radius: R };
  }
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  if (ctx === null) return { map: tex, radius: R };

  const pm = size / (2 * R); // pixels per metre
  const px = (m: number): number => (m / (2 * R) + 0.5) * size;
  const water = arena.terrain.find((z) => z.kind === 'water') ?? null;
  const grid = new NoiseGrid(64, 0x1a9c);
  const fine = new NoiseGrid(64, 0x77b3);

  const img = ctx.createImageData(size, size);
  const data = img.data;
  const pads = arena.pickupPads;
  let seed = 0x9e3779b1;
  for (let y = 0; y < size; y++) {
    const wz = (y / size - 0.5) * 2 * R;
    for (let x = 0; x < size; x++) {
      const wx = (x / size - 0.5) * 2 * R;
      const r = Math.hypot(wx, wz);
      const n1 = grid.sample(wx * 0.09 + 11, wz * 0.09 + 5);
      const n2 = grid.sample(wx * 0.33 + 3, wz * 0.33 + 19);
      const n3 = fine.sample(wx * 1.35, wz * 1.35);
      const n4 = fine.sample(wx * 3.7 + 9, wz * 3.7 + 2);

      // Mud ↔ olive earth base, leaf litter and grass patches.
      const e = smoothstep(0.32, 0.7, n1);
      let cr = 56 + (82 - 56) * e;
      let cg = 50 + (96 - 50) * e;
      let cb = 34 + (50 - 34) * e;
      const litter = smoothstep(0.6, 0.82, n2) * 0.5;
      cr += (126 - cr) * litter;
      cg += (98 - cg) * litter;
      cb += (52 - cb) * litter;
      const grass = smoothstep(0.55, 0.8, n1 * 0.55 + n3 * 0.45) * (1 - litter) * 0.55;
      cr += (62 - cr) * grass;
      cg += (116 - cg) * grass;
      cb += (42 - cb) * grass;
      let f = 0.84 + n3 * 0.22 + n4 * 0.1;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      f += ((seed >>> 8) / 16777216 - 0.5) * 0.07;

      // Dry clearing under each pad.
      for (let i = 0; i < pads.length; i++) {
        const d = Math.hypot(wx - pads[i].x, wz - pads[i].z);
        if (d < 3) {
          const k = (1 - smoothstep(1.4, 3.0, d)) * 0.5;
          cr += (146 - cr) * k;
          cg += (122 - cg) * k;
          cb += (78 - cb) * k;
        }
      }

      // The pool: pebbly sandy floor inside, wet dark shoreline outside.
      if (water !== null) {
        const d = Math.hypot(wx - water.x, wz - water.z);
        const Rp = water.radius;
        if (d < Rp + 2.2) {
          const inside = 1 - smoothstep(Rp - 0.25, Rp + 0.15, d);
          const wet = (1 - smoothstep(Rp + 0.1, Rp + 2.2, d)) * (1 - inside);
          // floor
          const pebble = smoothstep(0.62, 0.7, n4) * 0.5;
          const fr = 132 - pebble * 60 + (n3 - 0.5) * 16;
          const fg = 124 - pebble * 56 + (n3 - 0.5) * 14;
          const fb = 84 - pebble * 36 + (n3 - 0.5) * 12;
          cr += (fr - cr) * inside;
          cg += (fg - cg) * inside;
          cb += (fb - cb) * inside;
          // wet mud
          cr += (44 - cr) * wet * 0.85;
          cg += (50 - cg) * wet * 0.85;
          cb += (36 - cb) * wet * 0.85;
          f *= 1 - wet * 0.18;
        }
      }

      // Darker, heavier ground toward the wall.
      const wallK = smoothstep(arena.wallRadius - 4, arena.wallRadius + 1, r);
      f *= 1 - wallK * 0.42;

      cr *= f;
      cg *= f;
      cb *= f;
      const o = (y * size + x) * 4;
      data[o] = cr > 255 ? 255 : cr;
      data[o + 1] = cg > 255 ? 255 : cg;
      data[o + 2] = cb > 255 ? 255 : cb;
      data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const rng = mulberry32(0x6a09);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Tree roots crawling out over the ground.
  for (const t of arena.circles) {
    if (t.kind !== 'tree') continue;
    const roots = 6;
    for (let k = 0; k < roots; k++) {
      const a = (k / roots) * Math.PI * 2 + rng() * 0.7;
      const x = t.x + Math.cos(a) * t.radius * 0.9;
      const z = t.z + Math.sin(a) * t.radius * 0.9;
      const len = 2.2 + rng() * 3.2;
      const steps = 8;
      const w = (0.34 + rng() * 0.16) * Math.min(1.4, t.radius);
      const wob = rng() * 1000;
      for (const pass of [0, 1]) {
        let xx = x;
        let zz = z;
        let aa = a;
        let ww = w;
        ctx.strokeStyle = pass === 0 ? 'rgba(34,24,16,0.55)' : 'rgba(112,86,52,0.42)';
        const off = pass === 0 ? 0 : -0.05;
        const wr = mulberry32(Math.floor(wob) + k * 7919);
        for (let s = 0; s < steps; s++) {
          aa += (wr() - 0.5) * 0.45;
          const nx = xx + Math.cos(aa) * (len / steps);
          const nz = zz + Math.sin(aa) * (len / steps);
          ctx.lineWidth = Math.max(1, ww * pm * (pass === 0 ? 1 : 0.45));
          ctx.beginPath();
          ctx.moveTo(px(xx) + off * pm, px(zz) + off * pm);
          ctx.lineTo(px(nx) + off * pm, px(nz) + off * pm);
          ctx.stroke();
          xx = nx;
          zz = nz;
          ww *= 0.82;
        }
      }
    }
  }

  // Leaf litter + flower specks.
  const litterCols = ['rgba(150,120,52,0.5)', 'rgba(106,84,40,0.5)', 'rgba(96,126,50,0.5)', 'rgba(170,96,44,0.42)'];
  for (let i = 0; i < 1100; i++) {
    const a = rng() * Math.PI * 2;
    const rr = Math.sqrt(rng()) * (arena.wallRadius - 0.5);
    ctx.fillStyle = litterCols[Math.floor(rng() * litterCols.length)];
    ctx.beginPath();
    ctx.ellipse(px(Math.cos(a) * rr), px(Math.sin(a) * rr), (0.05 + rng() * 0.09) * pm, (0.025 + rng() * 0.04) * pm, rng() * 6.28, 0, Math.PI * 2);
    ctx.fill();
  }
  const flowerCols = ['rgba(246,236,170,0.85)', 'rgba(244,150,190,0.8)', 'rgba(255,255,255,0.8)', 'rgba(150,200,255,0.75)'];
  for (let i = 0; i < 160; i++) {
    const a = rng() * Math.PI * 2;
    const rr = Math.sqrt(rng()) * (arena.wallRadius - 1.5);
    ctx.fillStyle = flowerCols[Math.floor(rng() * flowerCols.length)];
    ctx.beginPath();
    ctx.arc(px(Math.cos(a) * rr), px(Math.sin(a) * rr), (0.035 + rng() * 0.03) * pm, 0, Math.PI * 2);
    ctx.fill();
  }

  // Wet shoreline stones.
  if (water !== null) {
    for (let i = 0; i < 260; i++) {
      const a = rng() * Math.PI * 2;
      const rr = water.radius + (rng() - 0.35) * 1.8;
      const gx = px(water.x + Math.cos(a) * rr);
      const gz = px(water.z + Math.sin(a) * rr);
      const sz = (0.04 + rng() * 0.1) * pm;
      const v = 80 + Math.floor(rng() * 70);
      ctx.fillStyle = `rgba(${v},${v + 6},${v - 6},0.8)`;
      ctx.beginPath();
      ctx.ellipse(gx, gz, sz * 1.3, sz, rng() * 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(210,225,220,0.18)';
      ctx.beginPath();
      ctx.ellipse(gx - sz * 0.25, gz - sz * 0.25, sz * 0.6, sz * 0.35, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  tex.needsUpdate = true;
  return { map: tex, radius: R };
}

/**
 * The ground as ONE polar-grid mesh: flat at y = 0 everywhere except inside the pool disc, where it falls into the sunk basin
 * (`poolFloorHeight`: 0 at the shoreline, −depth over the bank, flat floor inside). Rings are dense around the pool, coarse
 * toward the wall. UVs match the texture mapping of {@link makeGroundTexture} (u = x/R, v = −z/R).
 */
export function buildGroundGeometry(arena: ArenaDef, radius: number, segments = 96): THREE.BufferGeometry {
  const water = arena.terrain.find((z) => z.kind === 'water') ?? null;
  const rp = water?.radius ?? 0;
  const radii: number[] = [0];
  if (water !== null) {
    for (const f of [0.18, 0.36, 0.54, 0.68, 0.78, 0.86, 0.92, 0.96, 0.985, 1.0, 1.03, 1.08, 1.16]) radii.push(rp * f);
  }
  const start = radii[radii.length - 1];
  for (const r of [9, 11, 13.5, 16.5, 20, 24, 28, 31, radius]) if (r > start + 0.4) radii.push(r);
  radii[radii.length - 1] = radius;

  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const push = (x: number, z: number): void => {
    let y = 0;
    if (water !== null) y = poolFloorHeight(Math.hypot(x - water.x, z - water.z), water.radius, water.depth ?? 0.55, POOL_BANK_WIDTH);
    pos.push(x, y, z);
    uv.push((x / radius + 1) / 2, (-z / radius + 1) / 2);
  };
  push(0, 0);
  for (let i = 1; i < radii.length; i++) {
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      push(Math.cos(a) * radii[i], Math.sin(a) * radii[i]);
    }
  }
  for (let s = 0; s < segments; s++) idx.push(0, 1 + ((s + 1) % segments), 1 + s);
  for (let i = 1; i < radii.length - 1; i++) {
    const a0 = 1 + (i - 1) * segments;
    const a1 = 1 + i * segments;
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      idx.push(a0 + s, a0 + s1, a1 + s, a0 + s1, a1 + s1, a1 + s);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
