/**
 * Pooled 3D rubble for the Crumbling Amphitheatre (v1.6): when a breakable piece is destroyed a handful of lit stone chunks tumble out
 * of its volume and fall away. One `InstancedMesh` draw call, struct-of-arrays state, swap-remove compaction, a fixed capacity (the
 * oldest chunk is recycled when full) and zero allocation per frame. Cosmetic only (its own xorshift rng, never the sim's).
 */

import * as THREE from 'three';

const _d = new THREE.Object3D();
const _c = new THREE.Color();

export class ChunkPool {
  readonly mesh: THREE.InstancedMesh;
  readonly cap: number;
  /** Live chunks (tests / debug). */
  n = 0;
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.MeshStandardMaterial;
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  private readonly rx: Float32Array;
  private readonly ry: Float32Array;
  private readonly rz: Float32Array;
  private readonly wx: Float32Array;
  private readonly wy: Float32Array;
  private readonly wz: Float32Array;
  private readonly sx: Float32Array;
  private readonly sy: Float32Array;
  private readonly sz: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly colors: Float32Array;
  private ring = 0;
  private seed = 0x2545f491;

  constructor(cap = 72) {
    this.cap = cap;
    const mk = (): Float32Array => new Float32Array(cap);
    this.px = mk();
    this.py = mk();
    this.pz = mk();
    this.vx = mk();
    this.vy = mk();
    this.vz = mk();
    this.rx = mk();
    this.ry = mk();
    this.rz = mk();
    this.wx = mk();
    this.wy = mk();
    this.wz = mk();
    this.sx = mk();
    this.sy = mk();
    this.sz = mk();
    this.age = mk();
    this.life = mk();
    this.colors = new Float32Array(cap * 3);
    this.geo = new THREE.IcosahedronGeometry(0.5, 0);
    this.mat = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.95, metalness: 0 });
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, cap);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'stage-chunks';
    this.mesh.visible = false;
  }

  private rnd(): number {
    let x = this.seed;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.seed = x;
    return x / 4294967296;
  }

  /** Throw `count` chunks out of the box `[x0, x1] x [yLo, yHi]` (z spread `zr`), outward from `cx`, in the given stone colours. */
  burst(x0: number, x1: number, yLo: number, yHi: number, zr: number, count: number, size: number, colors: readonly number[], outward = 0.9): void {
    const cx = (x0 + x1) * 0.5;
    for (let i = 0; i < count; i++) {
      const x = x0 + this.rnd() * (x1 - x0);
      const y = yLo + this.rnd() * (yHi - yLo);
      const s = size * (0.45 + this.rnd() * 0.85);
      this.spawn(
        x,
        y,
        (this.rnd() - 0.5) * 2 * zr,
        (x - cx) * outward + (this.rnd() - 0.5) * 3,
        this.rnd() * 4.5 - 1,
        (this.rnd() - 0.2) * 3,
        s * (0.8 + this.rnd() * 0.5),
        s * (0.6 + this.rnd() * 0.6),
        s * (0.7 + this.rnd() * 0.6),
        colors[Math.floor(this.rnd() * colors.length) % colors.length],
        1.7 + this.rnd() * 0.9,
      );
    }
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, sx: number, sy: number, sz: number, hex: number, life: number): void {
    let i: number;
    if (this.n < this.cap) i = this.n++;
    else {
      i = this.ring;
      this.ring = (this.ring + 1) % this.cap;
    }
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.rx[i] = this.rnd() * 6.28;
    this.ry[i] = this.rnd() * 6.28;
    this.rz[i] = this.rnd() * 6.28;
    this.wx[i] = (this.rnd() - 0.5) * 9;
    this.wy[i] = (this.rnd() - 0.5) * 9;
    this.wz[i] = (this.rnd() - 0.5) * 9;
    this.sx[i] = sx;
    this.sy[i] = sy;
    this.sz[i] = sz;
    this.age[i] = 0;
    this.life[i] = life;
    _c.set(hex);
    const k = i * 3;
    const j = 0.82 + this.rnd() * 0.36;
    this.colors[k] = _c.r * j;
    this.colors[k + 1] = _c.g * j;
    this.colors[k + 2] = _c.b * j;
  }

  private remove(i: number): void {
    const l = --this.n;
    if (i === l) return;
    const f = [this.px, this.py, this.pz, this.vx, this.vy, this.vz, this.rx, this.ry, this.rz, this.wx, this.wy, this.wz, this.sx, this.sy, this.sz, this.age, this.life];
    for (let a = 0; a < f.length; a++) f[a][i] = f[a][l];
    this.colors[i * 3] = this.colors[l * 3];
    this.colors[i * 3 + 1] = this.colors[l * 3 + 1];
    this.colors[i * 3 + 2] = this.colors[l * 3 + 2];
  }

  clear(): void {
    this.n = 0;
    this.ring = 0;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  update(dt: number, killBelowY: number): void {
    const ic = this.mesh.instanceColor as THREE.InstancedBufferAttribute;
    const ca = ic.array as Float32Array;
    let i = 0;
    while (i < this.n) {
      const a = (this.age[i] += dt);
      if (a >= this.life[i] || this.py[i] < killBelowY) {
        this.remove(i);
        continue;
      }
      this.vy[i] -= 26 * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      this.rx[i] += this.wx[i] * dt;
      this.ry[i] += this.wy[i] * dt;
      this.rz[i] += this.wz[i] * dt;
      const left = this.life[i] - a;
      const sc = left < 0.3 ? left / 0.3 : 1;
      _d.position.set(this.px[i], this.py[i], this.pz[i]);
      _d.rotation.set(this.rx[i], this.ry[i], this.rz[i]);
      _d.scale.set(this.sx[i] * sc, this.sy[i] * sc, this.sz[i] * sc);
      _d.updateMatrix();
      this.mesh.setMatrixAt(i, _d.matrix);
      const k = i * 3;
      ca[k] = this.colors[k];
      ca[k + 1] = this.colors[k + 1];
      ca[k + 2] = this.colors[k + 2];
      i++;
    }
    this.mesh.count = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      ic.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geo.dispose();
    this.mat.dispose();
  }
}
