/**
 * Jungle geometry helpers (WP-J3): a vertex-coloured geometry accumulator with PER-VERTEX colour functions (so a tree trunk can
 * blend bark → moss, a rock can be green on top and grey below) and a few shared maths helpers.
 *
 * Everything here runs at init time only and is node-safe (pure three geometry, no DOM).
 */

import * as THREE from 'three';

/** Colour callback: world-space vertex position + normal → linear-ish sRGB triple written into `out` (0..1). */
export type VertexColorFn = (x: number, y: number, z: number, nx: number, ny: number, nz: number, out: [number, number, number]) => void;

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _nm = new THREE.Matrix3();
const _c = new THREE.Color();
const _out: [number, number, number] = [0, 0, 0];

/** Accumulates transformed, vertex-coloured geometry into ONE indexed BufferGeometry (position / normal / color). */
export class VGeo {
  private pos: number[] = [];
  private nor: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  get triangleCount(): number {
    return this.idx.length / 3;
  }

  /**
   * Add `geometry` (NOT consumed; the caller disposes it) transformed by `matrix`, coloured by a constant colour or a per-vertex
   * function. Non-indexed geometries get sequential indices. `flip` reverses the winding (inside-out surfaces).
   */
  add(
    geometry: THREE.BufferGeometry,
    matrix: THREE.Matrix4,
    color: THREE.ColorRepresentation | readonly [number, number, number] | VertexColorFn,
    flip = false,
  ): void {
    const p = geometry.getAttribute('position');
    const nAttr = geometry.getAttribute('normal');
    const base = this.pos.length / 3;
    _nm.getNormalMatrix(matrix);
    const fn = typeof color === 'function' ? color : null;
    if (fn === null) {
      if (Array.isArray(color)) _c.setRGB(color[0] as number, color[1] as number, color[2] as number);
      else _c.set(color as THREE.ColorRepresentation);
    }
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i).applyMatrix4(matrix);
      if (nAttr !== undefined) _n.fromBufferAttribute(nAttr, i).applyMatrix3(_nm).normalize();
      else _n.set(0, 1, 0);
      this.pos.push(_v.x, _v.y, _v.z);
      this.nor.push(_n.x, _n.y, _n.z);
      if (fn !== null) {
        fn(_v.x, _v.y, _v.z, _n.x, _n.y, _n.z, _out);
        this.col.push(_out[0], _out[1], _out[2]);
      } else {
        this.col.push(_c.r, _c.g, _c.b);
      }
    }
    const index = geometry.getIndex();
    const count = index === null ? p.count : index.count;
    for (let t = 0; t + 2 < count; t += 3) {
      const a = index === null ? t : index.getX(t);
      const b = index === null ? t + 1 : index.getX(t + 1);
      const c = index === null ? t + 2 : index.getX(t + 2);
      if (flip) this.idx.push(base + a, base + c, base + b);
      else this.idx.push(base + a, base + b, base + c);
    }
  }

  /** Add a raw triangle soup / strip built by the caller (positions already in world space). */
  addRaw(positions: ArrayLike<number>, indices: ArrayLike<number>, colors: ArrayLike<number>): void {
    const base = this.pos.length / 3;
    const n = positions.length / 3;
    const nor = new Float32Array(positions.length);
    // Face normals accumulated per vertex.
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const a = indices[t] * 3;
      const b = indices[t + 1] * 3;
      const c = indices[t + 2] * 3;
      const ux = positions[b] - positions[a];
      const uy = positions[b + 1] - positions[a + 1];
      const uz = positions[b + 2] - positions[a + 2];
      const vx = positions[c] - positions[a];
      const vy = positions[c + 1] - positions[a + 1];
      const vz = positions[c + 2] - positions[a + 2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      for (const o of [a, b, c]) {
        nor[o] += nx;
        nor[o + 1] += ny;
        nor[o + 2] += nz;
      }
    }
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const l = Math.hypot(nor[o], nor[o + 1], nor[o + 2]) || 1;
      this.pos.push(positions[o], positions[o + 1], positions[o + 2]);
      this.nor.push(nor[o] / l, nor[o + 1] / l, nor[o + 2] / l);
      this.col.push(colors[o], colors[o + 1], colors[o + 2]);
    }
    for (let t = 0; t < indices.length; t++) this.idx.push(base + indices[t]);
  }

  /** Finish: one indexed geometry carrying position / normal / color. */
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    g.setIndex(new THREE.BufferAttribute(this.vertexCount > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx), 1));
    this.pos = [];
    this.nor = [];
    this.col = [];
    this.idx = [];
    return g;
  }
}

// ── Maths helpers ────────────────────────────────────────────────────────────

export function smoothstep(a: number, b: number, x: number): number {
  const t = (x - a) / (b - a);
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Cheap deterministic 2D hash → 0..1. */
export function hash2(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Smooth value noise in 0..1 (bilinear over a hash lattice). */
export function vnoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

/** Two-octave fractal noise in ~0..1. */
export function fbm2(x: number, z: number): number {
  return vnoise(x, z) * 0.62 + vnoise(x * 2.07 + 17.3, z * 2.07 + 9.1) * 0.38;
}

const _mm = new THREE.Matrix4();
const _qq = new THREE.Quaternion();
const _ee = new THREE.Euler();
const _p3 = new THREE.Vector3();
const _s3 = new THREE.Vector3();

/** Compose translate · Euler(rx, ry, rz) · scale into a (shared, short-lived) matrix. */
export function composeMat(
  x: number, y: number, z: number,
  rx = 0, ry = 0, rz = 0,
  sx = 1, sy = sx, sz = sx,
): THREE.Matrix4 {
  _ee.set(rx, ry, rz, 'YXZ');
  _qq.setFromEuler(_ee);
  _p3.set(x, y, z);
  _s3.set(sx, sy, sz);
  return _mm.compose(_p3, _qq, _s3);
}

/** Linear-ish colour helper: hex → [r,g,b] 0..1 (three's `Color.set` in the working space). */
export function rgb(hex: number): [number, number, number] {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}
