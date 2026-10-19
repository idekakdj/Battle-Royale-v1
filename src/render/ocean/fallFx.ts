/**
 * Fall-damage impact FX (v1.10, WP-H4): when a fighter lands after a big drop (`fall` event) the floor answers with
 *  - a ring of silty DUST puffs rolling outward plus a small upward plume,
 *  - a short BUBBLE column rising from the spot,
 *  - a ground CRACK DECAL (dark radial fractures + a scuffed dent) laid on the surface it hit (aligned to the slope on a ramp), fading over ~1.7 s.
 *
 * Everything is pooled and pre-allocated: one Points draw (shared `Particles` pool, kinds 0 bubble / 4 dust) and one instanced decal draw,
 * both hidden while nothing is alive. Pure scene objects - the camera shake / FOV kick for the victim is the scene's job (arenaShake).
 */

import * as THREE from 'three';
import { mulberry32, TAU } from '../../core/math';
import { arenaGroundHeight, type ArenaDef } from '../../config/arenas';
import type { QualityTier } from '../quality';
import { Particles } from './serpentFx';

const DECAL_MAX = 4;
const DECAL_LIFE = 1.7;

const DECAL_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vI;
void main() {
  vUv = uv;
  vI = instanceColor;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const DECAL_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec3 vI;
float h1(float n) { return fract(sin(n * 91.345 + 17.13) * 43758.5453); }
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float r = length(p);
  if (r > 1.0) discard;
  float ang = atan(p.y, p.x);
  float age = vI.x;
  float seed = vI.y;
  // radial cracks: 9 spokes with jittered angles and lengths, wobbling a little with the radius
  float cracks = 0.0;
  for (int i = 0; i < 9; i++) {
    float fi = float(i);
    float a0 = (fi / 9.0 + (h1(fi + seed * 7.0) - 0.5) * 0.09) * 6.2831853;
    float d = ang - a0 + sin(r * 11.0 + fi * 2.0 + seed * 5.0) * 0.12;
    d = abs(atan(sin(d), cos(d))) * r;
    float len = 0.45 + 0.5 * h1(fi * 3.1 + seed * 11.0);
    float w = 0.012 + 0.03 * (1.0 - r);
    cracks = max(cracks, (1.0 - smoothstep(0.0, w, d)) * (1.0 - smoothstep(len * 0.55, len, r)));
  }
  // a scuffed dent and a pale dust rim
  float dent = (1.0 - smoothstep(0.0, 0.5, r)) * 0.55;
  float rim = smoothstep(0.52, 0.6, r) * (1.0 - smoothstep(0.62, 0.78, r)) * 0.22;
  float fade = pow(max(0.0, 1.0 - age), 1.4) * smoothstep(0.0, 0.04, age + 0.03);
  float a = max(cracks * 0.92, dent) * fade * (1.0 - smoothstep(0.82, 1.0, r));
  a = max(a, rim * fade);
  if (a < 0.004) discard;
  vec3 col = mix(vec3(0.045, 0.04, 0.035), vec3(0.62, 0.56, 0.44), rim * 2.0 * (1.0 - cracks));
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _n = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _c = new THREE.Color();

export class FallFx {
  readonly root = new THREE.Group();
  private readonly arena: ArenaDef;
  private readonly parts = new Particles(120);
  private readonly decals: THREE.InstancedMesh;
  private readonly mat: THREE.ShaderMaterial;
  private readonly geo: THREE.PlaneGeometry;
  private readonly age = new Float32Array(DECAL_MAX).fill(-1);
  private readonly dx = new Float32Array(DECAL_MAX);
  private readonly dy = new Float32Array(DECAL_MAX);
  private readonly dz = new Float32Array(DECAL_MAX);
  private readonly dScale = new Float32Array(DECAL_MAX);
  private readonly dSeed = new Float32Array(DECAL_MAX);
  private readonly dQ = new Float32Array(DECAL_MAX * 4);
  private cursor = 0;
  private tier: QualityTier = 'high';
  private readonly rng = mulberry32(0xfa11);
  private bursts = 0;

  constructor(arena: ArenaDef) {
    this.arena = arena;
    this.geo = new THREE.PlaneGeometry(1, 1);
    this.geo.rotateX(-Math.PI / 2);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: DECAL_VERT,
      fragmentShader: DECAL_FRAG,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
      fog: false,
    });
    this.decals = new THREE.InstancedMesh(this.geo, this.mat, DECAL_MAX);
    this.decals.frustumCulled = false;
    this.decals.renderOrder = 3;
    this.decals.visible = false;
    this.decals.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < DECAL_MAX; i++) {
      this.decals.setMatrixAt(i, _m.makeScale(0, 0, 0));
      this.decals.setColorAt(i, _c.setRGB(1, 0, 0));
    }
    this.root.add(this.decals, this.parts.points);
  }

  setTier(tier: QualityTier): void {
    this.tier = tier;
  }

  /** How many bursts were fired (tests). */
  get burstCount(): number {
    return this.bursts;
  }

  /** Live decals / particles / visible draws (tests, draw-call accounting). */
  get liveDecals(): number {
    let n = 0;
    for (let i = 0; i < DECAL_MAX; i++) if (this.age[i] >= 0) n++;
    return n;
  }
  get liveParticles(): number {
    return this.parts.liveCount;
  }
  get visibleDraws(): number {
    return (this.decals.visible ? 1 : 0) + (this.parts.points.visible ? 1 : 0);
  }
  get decalMesh(): THREE.InstancedMesh {
    return this.decals;
  }

  /** The surface normal at (x, z) from the ground height field (central differences, 0.5 m). */
  private normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const e = 0.5;
    const hx = arenaGroundHeight(this.arena, x + e, z) - arenaGroundHeight(this.arena, x - e, z);
    const hz = arenaGroundHeight(this.arena, x, z + e) - arenaGroundHeight(this.arena, x, z - e);
    // a cliff edge next to the landing point would tilt the decal absurdly: only gentle (ramp) slopes count
    const k = Math.abs(hx) > 1.6 || Math.abs(hz) > 1.6 ? 0 : 1;
    return out.set((-hx / (2 * e)) * k, 1, (-hz / (2 * e)) * k).normalize();
  }

  /** The impact at (x, y, z) after dropping `drop` metres. */
  burst(x: number, y: number, z: number, drop: number): void {
    this.bursts++;
    const k = this.tier === 'low' ? 0.5 : 1;
    const strength = Math.min(1.5, Math.max(0.7, (drop - 2.2) / 3.2));
    const rng = this.rng;
    // dust ring
    const nRing = Math.round(22 * k * strength);
    for (let i = 0; i < nRing; i++) {
      const a = (i / nRing) * TAU + rng() * 0.3;
      const sp = 1.2 + rng() * 2.4 * strength;
      this.parts.spawn(4, x + Math.cos(a) * 0.35, y + 0.12, z + Math.sin(a) * 0.35, Math.cos(a) * sp, 0.2 + rng() * 0.7, Math.sin(a) * sp, 0.9 + rng() * 0.8, 1.0 + rng() * 1.0);
    }
    // the plume
    const nPlume = Math.round(8 * k);
    for (let i = 0; i < nPlume; i++) {
      const a = rng() * TAU;
      const sp = 0.3 + rng() * 0.7;
      this.parts.spawn(4, x, y + 0.2, z, Math.cos(a) * sp, 1.0 + rng() * 1.6, Math.sin(a) * sp, 1.0 + rng() * 0.9, 1.1 + rng() * 1.0);
    }
    // bubble column
    const nBub = Math.round(16 * k * strength);
    for (let i = 0; i < nBub; i++) {
      const a = rng() * TAU;
      const rr = rng() * 0.5;
      this.parts.spawn(0, x + Math.cos(a) * rr, y + 0.2 + rng() * 0.5, z + Math.sin(a) * rr, Math.cos(a) * 0.3, 1.2 + rng() * 2.2, Math.sin(a) * 0.3, 1.1 + rng() * 1.1, 0.14 + rng() * 0.2);
    }
    // the crack decal
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % DECAL_MAX;
    this.age[i] = 0;
    this.dSeed[i] = rng() * 6;
    this.dScale[i] = 2.7 * strength;
    this.normalAt(x, z, _n);
    _q.setFromUnitVectors(_up, _n);
    // a random spin about the normal
    const spin = rng() * TAU;
    _q.multiply(new THREE.Quaternion().setFromAxisAngle(_up, spin));
    this.dQ[i * 4] = _q.x;
    this.dQ[i * 4 + 1] = _q.y;
    this.dQ[i * 4 + 2] = _q.z;
    this.dQ[i * 4 + 3] = _q.w;
    this.dx[i] = x;
    this.dy[i] = y + 0.035;
    this.dz[i] = z;
    this.writeDecal(i);
    this.decals.visible = true;
  }

  private writeDecal(i: number): void {
    const a = this.age[i];
    if (a < 0) {
      this.decals.setMatrixAt(i, _m.makeScale(0, 0, 0));
      return;
    }
    _p.set(this.dx[i], this.dy[i], this.dz[i]);
    _q.set(this.dQ[i * 4], this.dQ[i * 4 + 1], this.dQ[i * 4 + 2], this.dQ[i * 4 + 3]);
    const grow = 0.75 + 0.25 * Math.min(1, a / DECAL_LIFE / 0.12);
    const sc = this.dScale[i] * grow;
    _s.set(sc, 1, sc);
    this.decals.setMatrixAt(i, _m.compose(_p, _q, _s));
    this.decals.setColorAt(i, _c.setRGB(Math.min(1, a / DECAL_LIFE), this.dSeed[i], 0));
  }

  update(dt: number): void {
    this.parts.update(dt);
    let any = false;
    for (let i = 0; i < DECAL_MAX; i++) {
      if (this.age[i] < 0) continue;
      this.age[i] += dt;
      if (this.age[i] >= DECAL_LIFE) this.age[i] = -1;
      else any = true;
      this.writeDecal(i);
    }
    if (any || this.decals.visible) {
      this.decals.instanceMatrix.needsUpdate = true;
      if (this.decals.instanceColor !== null) this.decals.instanceColor.needsUpdate = true;
    }
    this.decals.visible = any;
  }

  dispose(): void {
    this.parts.dispose();
    this.decals.dispose();
    this.geo.dispose();
    this.mat.dispose();
    this.root.removeFromParent();
  }
}
