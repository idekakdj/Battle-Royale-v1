/**
 * Sea-serpent FX (WP-O3): the telegraphed STRIKE STRIP on the floor, the glass SHARDS, the splash / bubble particles, the HOLD
 * shockwave ring + flash, and the hit flashes.
 *
 * Persistent visuals (strip, ring, flash radius) are driven by `serpentVisualState`; the one-shot bursts (shards + splash on the
 * strike, hit flash on a `serpentHit`) are triggered by the match events. All buffers are pre-allocated: nothing is allocated per frame.
 */

import * as THREE from 'three';
import { mulberry32, TAU } from '../../core/math';
import type { ArenaDef } from '../../config/arenas';
import { allocStrip, buildStrip, type StripGeometry } from './strip';
import { glassRadius, type SerpentVisual } from './serpentState';
import type { OceanShared } from './materials';
import type { QualityTier } from '../quality';

// ── Strip ────────────────────────────────────────────────────────────────────

const STRIP_VERT = /* glsl */ `
attribute vec2 aRL;
varying vec2 vRL;
void main() {
  vRL = aRL;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}
`;

const STRIP_FRAG = /* glsl */ `
uniform float uTime;
uniform float uUrgency;
uniform float uAlpha;
uniform float uSweep;
uniform float uPass;
uniform float uAge;
uniform float uWall;
varying vec2 vRL;
void main() {
  float r = vRL.x;
  float lat = abs(vRL.y);
  float edge = smoothstep(0.74, 0.98, lat);
  float speed = 2.6 + 11.0 * uUrgency;
  float p = r * 0.6 - lat * 0.7 + uTime * speed;
  float f = fract(p);
  float chev = smoothstep(0.0, 0.08, f) * (1.0 - smoothstep(0.34, 0.46, f));
  float pulse = 0.7 + 0.3 * sin(uTime * (9.0 + 26.0 * uUrgency));
  float fill = (0.46 + 0.22 * uUrgency) * pulse + chev * 0.6 + edge * 0.6;
  vec3 col = mix(vec3(1.35, 0.22, 0.045), vec3(2.0, 0.95, 0.22), chev);
  col = mix(col, vec3(2.3, 1.7, 1.0), edge * 0.65);
  // the opening punch: a white-hot flash that settles over ~0.35 s (readable from the very first frames)
  float punch = exp(-uAge * 7.0);
  col += vec3(1.3, 1.0, 0.75) * punch;
  fill += punch * 0.5;
  // the head has already crossed the part of the strip beyond the sweep front
  float behind = uPass * smoothstep(uSweep - 0.4, uSweep + 1.2, r);
  col = mix(col, vec3(2.2, 2.0, 1.8), behind * 0.85);
  float ends = smoothstep(0.0, 1.5, r) * (1.0 - 0.8 * smoothstep(uWall - 0.6, uWall + 0.6, r));
  float reveal = smoothstep(0.0, 0.07, uAge);
  float a = clamp(fill, 0.0, 1.0) * uAlpha * ends * reveal;
  if (a < 0.003) discard;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class StripMesh {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private readonly data: StripGeometry = allocStrip();
  private angle = -999;
  private readonly u = {
    uTime: { value: 0 },
    uUrgency: { value: 0 },
    uAlpha: { value: 0 },
    uSweep: { value: 99 },
    uPass: { value: 0 },
    uAge: { value: 0 },
    uWall: { value: 30 },
  };

  constructor(shared: OceanShared, wall: number) {
    this.u.uTime = shared.uTime;
    this.u.uWall.value = wall;
    this.geo = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(this.data.positions, 3);
    const rl = new THREE.BufferAttribute(this.data.rl, 2);
    pos.setUsage(THREE.DynamicDrawUsage);
    rl.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', pos);
    this.geo.setAttribute('aRL', rl);
    this.geo.setIndex(new THREE.BufferAttribute(this.data.indices, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: STRIP_VERT,
      fragmentShader: STRIP_FRAG,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      fog: false,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
  }

  /** (Re)build the strip for `angleDeg` (a no-op when unchanged). */
  setAngle(arena: ArenaDef, angleDeg: number): void {
    if (Math.abs(angleDeg - this.angle) < 1e-6) return;
    this.angle = angleDeg;
    buildStrip(arena, angleDeg, this.data);
    (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aRL') as THREE.BufferAttribute).needsUpdate = true;
    this.geo.index!.needsUpdate = true;
    this.geo.setDrawRange(0, this.data.indexCount);
  }

  get rows(): number {
    return this.data.rows;
  }

  /** The current strip geometry (tests). */
  get geometry(): StripGeometry {
    return this.data;
  }

  update(v: SerpentVisual, arena: ArenaDef, age: number): void {
    this.mesh.visible = v.active && v.stripAlpha > 0.002 && v.phase !== 'exit';
    if (!this.mesh.visible) {
      this.angle = this.angle; // keep the cached angle
      return;
    }
    this.setAngle(arena, v.angleDeg);
    this.u.uUrgency.value = v.urgency;
    this.u.uAlpha.value = v.stripAlpha;
    this.u.uSweep.value = v.sweepR;
    this.u.uPass.value = v.phase === 'strike' || v.phase === 'hold' ? 1 : 0;
    this.u.uAge.value = v.phase === 'warn' ? age : 9;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ── Particles (bubbles, spray, flashes) ──────────────────────────────────────

const PART_VERT = /* glsl */ `
attribute vec4 aState; // kind, life fraction (1 -> 0), size, seed
uniform float uPx;
varying vec4 vS;
void main() {
  vS = aState;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float s = aState.z * (aState.x > 1.5 ? (1.6 - aState.y * 0.9) : 1.0);
  gl_PointSize = aState.y > 0.0 ? max(1.0, s * uPx / max(0.5, -mv.z)) : 0.0;
  gl_Position = projectionMatrix * mv;
}
`;

const PART_FRAG = /* glsl */ `
varying vec4 vS;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  if (d > 1.0) discard;
  float life = clamp(vS.y, 0.0, 1.0);
  vec3 col;
  float a;
  if (vS.x < 0.5) {
    // bubble: a bright rim and a faint interior with a highlight
    float rim = smoothstep(0.62, 0.9, d) * (1.0 - smoothstep(0.9, 1.0, d));
    float hi = smoothstep(0.35, 0.0, length(c - vec2(-0.18, 0.2)));
    a = (rim * 0.9 + 0.12 + hi * 0.6) * life;
    col = vec3(0.75, 0.95, 1.0);
  } else if (vS.x < 1.5) {
    // spray droplet
    a = (1.0 - smoothstep(0.4, 1.0, d)) * life;
    col = vec3(0.8, 0.96, 1.0);
  } else {
    // hit / impact flash: hot core, red-orange halo
    float core = 1.0 - smoothstep(0.0, 0.5, d);
    a = (core + (1.0 - smoothstep(0.3, 1.0, d)) * 0.5) * life * life;
    col = mix(vec3(2.6, 0.55, 0.14), vec3(3.2, 2.8, 2.3), core);
  }
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

class Particles {
  readonly points: THREE.Points;
  private readonly n: number;
  private readonly pos: Float32Array;
  private readonly state: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly kindBuoy: Float32Array;
  private readonly attr: THREE.BufferAttribute;
  private readonly stateAttr: THREE.BufferAttribute;
  private cursor = 0;
  private live = 0;
  private readonly px = { value: 600 };
  private readonly mat: THREE.ShaderMaterial;
  private readonly rng = mulberry32(0xb0b1e);

  constructor(n: number) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.state = new Float32Array(n * 4);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n).fill(1);
    this.kindBuoy = new Float32Array(n);
    const g = new THREE.BufferGeometry();
    this.attr = new THREE.BufferAttribute(this.pos, 3);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    this.stateAttr = new THREE.BufferAttribute(this.state, 4);
    this.stateAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.attr);
    g.setAttribute('aState', this.stateAttr);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uPx: this.px },
      vertexShader: PART_VERT,
      fragmentShader: PART_FRAG,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    this.points.visible = false;
  }

  /** kind: 0 bubble, 1 spray, 2 flash. */
  spawn(kind: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.n;
    if (this.life[i] <= 0) this.live++;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.state[i * 4] = kind;
    this.state[i * 4 + 1] = 1;
    this.state[i * 4 + 2] = size;
    this.state[i * 4 + 3] = this.rng();
    this.kindBuoy[i] = kind;
    this.points.visible = true;
  }

  update(dt: number): void {
    if (this.live === 0) return;
    if (typeof window !== 'undefined') this.px.value = (window.innerHeight * Math.min(2, window.devicePixelRatio || 1)) / 1.04;
    let alive = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.state[i * 4 + 1] = 0;
        continue;
      }
      alive++;
      const k = this.kindBuoy[i];
      const o = i * 3;
      if (k < 0.5) {
        // bubbles rise and wobble
        this.vel[o + 1] += 1.6 * dt;
        this.vel[o] += Math.sin(this.life[i] * 7 + i) * 0.4 * dt;
        this.vel[o + 2] += Math.cos(this.life[i] * 6 + i * 1.7) * 0.4 * dt;
        const damp = Math.exp(-dt * 1.4);
        this.vel[o] *= damp;
        this.vel[o + 2] *= damp;
      } else if (k < 1.5) {
        this.vel[o + 1] -= 11 * dt;
      } else {
        const damp = Math.exp(-dt * 6);
        this.vel[o] *= damp;
        this.vel[o + 1] *= damp;
        this.vel[o + 2] *= damp;
      }
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
      if (k < 1.5 && this.pos[o + 1] < 0.05 && k > 0.5) {
        this.pos[o + 1] = 0.05;
        this.vel[o + 1] *= -0.2;
        this.vel[o] *= 0.4;
        this.vel[o + 2] *= 0.4;
      }
      this.state[i * 4 + 1] = this.life[i] / this.maxLife[i];
    }
    this.live = alive;
    this.attr.needsUpdate = true;
    this.stateAttr.needsUpdate = true;
    if (alive === 0) this.points.visible = false;
  }

  get liveCount(): number {
    return this.live;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.mat.dispose();
  }
}

// ── Shards ───────────────────────────────────────────────────────────────────

const SHARD_MAX = 44;
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

class Shards {
  readonly mesh: THREE.InstancedMesh;
  private readonly pos = new Float32Array(SHARD_MAX * 3);
  private readonly vel = new Float32Array(SHARD_MAX * 3);
  private readonly rot = new Float32Array(SHARD_MAX * 3);
  private readonly rotVel = new Float32Array(SHARD_MAX * 3);
  private readonly life = new Float32Array(SHARD_MAX);
  private readonly size = new Float32Array(SHARD_MAX);
  private cursor = 0;
  private live = 0;
  private readonly rng = mulberry32(0x5ba2d);
  private readonly mat: THREE.MeshBasicMaterial;
  private readonly geo: THREE.BufferGeometry;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();

  constructor() {
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.3, 0, 0.6, -0.1, 0, 0.1, 0.7, 0]), 3));
    this.mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.7, 1.2, 1.5), transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false, fog: false });
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, SHARD_MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < SHARD_MAX; i++) this.mesh.setMatrixAt(i, ZERO);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
  }

  burst(cx: number, cy: number, cz: number, dirX: number, dirZ: number, count: number): void {
    const px = -dirZ;
    const pz = dirX;
    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % SHARD_MAX;
      if (this.life[i] <= 0) this.live++;
      const u = (this.rng() - 0.5) * 6.4;
      const v = (this.rng() - 0.3) * 5.2;
      const o = i * 3;
      this.pos[o] = cx + px * u;
      this.pos[o + 1] = Math.max(0.2, cy + v);
      this.pos[o + 2] = cz + pz * u;
      const sp = 3 + this.rng() * 9;
      this.vel[o] = -dirX * sp + px * (this.rng() - 0.5) * 5;
      this.vel[o + 1] = 1 + this.rng() * 5;
      this.vel[o + 2] = -dirZ * sp + pz * (this.rng() - 0.5) * 5;
      this.rot[o] = this.rng() * TAU;
      this.rot[o + 1] = this.rng() * TAU;
      this.rot[o + 2] = this.rng() * TAU;
      this.rotVel[o] = (this.rng() - 0.5) * 14;
      this.rotVel[o + 1] = (this.rng() - 0.5) * 14;
      this.rotVel[o + 2] = (this.rng() - 0.5) * 14;
      this.life[i] = 1.1 + this.rng() * 0.7;
      this.size[i] = 0.35 + this.rng() * 0.75;
    }
    this.mesh.visible = true;
  }

  update(dt: number): void {
    if (this.live === 0) return;
    let alive = 0;
    for (let i = 0; i < SHARD_MAX; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.mesh.setMatrixAt(i, ZERO);
        continue;
      }
      alive++;
      const o = i * 3;
      this.vel[o + 1] -= 9 * dt;
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
      if (this.pos[o + 1] < 0.1) {
        this.pos[o + 1] = 0.1;
        this.vel[o + 1] *= -0.25;
        this.vel[o] *= 0.5;
        this.vel[o + 2] *= 0.5;
        this.rotVel[o] *= 0.4;
        this.rotVel[o + 1] *= 0.4;
        this.rotVel[o + 2] *= 0.4;
      }
      this.rot[o] += this.rotVel[o] * dt;
      this.rot[o + 1] += this.rotVel[o + 1] * dt;
      this.rot[o + 2] += this.rotVel[o + 2] * dt;
      const k = this.life[i] < 0.3 ? this.life[i] / 0.3 : 1;
      this.e.set(this.rot[o], this.rot[o + 1], this.rot[o + 2]);
      this.q.setFromEuler(this.e);
      this.p.set(this.pos[o], this.pos[o + 1], this.pos[o + 2]);
      const sz = this.size[i] * k;
      this.s.set(sz, sz, sz);
      this.mesh.setMatrixAt(i, this.m.compose(this.p, this.q, this.s));
    }
    this.live = alive;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (alive === 0) this.mesh.visible = false;
  }

  get liveCount(): number {
    return this.live;
  }

  dispose(): void {
    this.mesh.dispose();
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ── Shockwave ring + impact flash ────────────────────────────────────────────

const RING_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const RING_FRAG = /* glsl */ `
uniform float uA;
varying vec2 vUv;
void main() {
  float band = smoothstep(0.0, 0.45, vUv.x) * (1.0 - smoothstep(0.55, 1.0, vUv.x));
  float a = band * uA;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vec3(2.6, 1.9, 1.3), clamp(a, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ── Aggregate ────────────────────────────────────────────────────────────────

export class SerpentFx {
  readonly root = new THREE.Group();
  readonly strip: StripMesh;
  private readonly shards = new Shards();
  private readonly parts = new Particles(180);
  private readonly ring: THREE.Mesh;
  private readonly ringMat: THREE.ShaderMaterial;
  private readonly flash: THREE.Mesh;
  private readonly flashMat: THREE.MeshBasicMaterial;
  private readonly arena: ArenaDef;
  private bubbleAcc = 0;
  private tier: QualityTier = 'high';
  private readonly rng = mulberry32(0xf1a5);
  /** The plateau height (the shockwave and impact flash are centred on it). */
  private readonly centreY: number;

  constructor(shared: OceanShared, arena: ArenaDef, centreY: number) {
    this.arena = arena;
    this.centreY = centreY;
    this.strip = new StripMesh(shared, arena.wallRadius);
    this.root.add(this.strip.mesh, this.shards.mesh, this.parts.points);
    const rg = new THREE.RingGeometry(0.88, 1.0, 72, 1);
    rg.rotateX(-Math.PI / 2);
    this.ringMat = new THREE.ShaderMaterial({
      uniforms: { uA: { value: 0 } },
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.ring = new THREE.Mesh(rg, this.ringMat);
    this.ring.visible = false;
    this.ring.renderOrder = 5;
    this.ring.frustumCulled = false;
    this.root.add(this.ring);
    this.flashMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.8, 1.0, 0.55), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    this.flash = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), this.flashMat);
    this.flash.visible = false;
    this.flash.renderOrder = 5;
    this.flash.frustumCulled = false;
    this.root.add(this.flash);
  }

  setTier(tier: QualityTier): void {
    this.tier = tier;
  }

  /** One-shot: the head bursts through the glass at `dir` (unit x/z). */
  onStrike(dirX: number, dirZ: number): void {
    const R = glassRadius(this.arena) - 0.2;
    const k = this.tier === 'low' ? 0.5 : 1;
    this.shards.burst(dirX * R, 2.4, dirZ * R, dirX, dirZ, Math.round(34 * k));
    const n = Math.round(46 * k);
    for (let i = 0; i < n; i++) {
      const a = this.rng() * TAU;
      const rr = this.rng() * 2.4;
      const px = -dirZ * Math.cos(a) * rr;
      const pz = dirX * Math.cos(a) * rr;
      // water spray punched inward + bubbles outside
      this.parts.spawn(1, dirX * R + px, 2.3 + Math.sin(a) * rr, dirZ * R + pz, -dirX * (4 + this.rng() * 9) + px * 2, 1 + this.rng() * 5, -dirZ * (4 + this.rng() * 9) + pz * 2, 0.7 + this.rng() * 0.7, 0.2 + this.rng() * 0.2);
    }
    for (let i = 0; i < Math.round(40 * k); i++) {
      const a = this.rng() * TAU;
      const rr = this.rng() * 3;
      this.parts.spawn(0, dirX * (R + 0.8 + this.rng() * 1.6) - dirZ * Math.cos(a) * rr, 1.5 + this.rng() * 4, dirZ * (R + 0.8 + this.rng() * 1.6) + dirX * Math.cos(a) * rr, dirX * (1 + this.rng() * 3), 0.4 + this.rng() * 1.2, dirZ * (1 + this.rng() * 3), 1.4 + this.rng() * 1.4, 0.25 + this.rng() * 0.35);
    }
    this.parts.spawn(2, dirX * R, 2.3, dirZ * R, 0, 0, 0, 0.35, 5);
  }

  /** One-shot: the head hit a fighter at (x, y, z). */
  onHit(x: number, y: number, z: number): void {
    this.parts.spawn(2, x, y + 1, z, 0, 0, 0, 0.45, 4.2);
    for (let i = 0; i < 12; i++) {
      const a = this.rng() * TAU;
      const s = 2 + this.rng() * 5;
      this.parts.spawn(1, x, y + 0.9, z, Math.cos(a) * s, 2 + this.rng() * 4, Math.sin(a) * s, 0.5 + this.rng() * 0.4, 0.18);
    }
  }

  update(v: SerpentVisual, dt: number, warnAge: number): void {
    this.strip.update(v, this.arena, warnAge);
    // Heal bubbles: the seam re-forming during the retreat.
    if (v.active && v.phase === 'retreat' && v.hole > 0.02) {
      this.bubbleAcc += dt * (this.tier === 'low' ? 16 : 36);
      const R = glassRadius(this.arena) - 0.5;
      while (this.bubbleAcc >= 1) {
        this.bubbleAcc -= 1;
        const a = this.rng() * TAU;
        const rr = this.rng() * 2.6;
        this.parts.spawn(0, v.dirX * R - v.dirZ * Math.cos(a) * rr, 1.2 + Math.abs(Math.sin(a)) * rr + 0.4, v.dirZ * R + v.dirX * Math.cos(a) * rr, -v.dirX * 0.6, 1 + this.rng() * 1.4, -v.dirZ * 0.6, 1.2 + this.rng(), 0.22 + this.rng() * 0.3);
      }
    } else this.bubbleAcc = 0;
    // Shockwave: a ring racing outward from the centre with a flash.
    if (v.active && v.shock >= 0) {
      const k = v.shock;
      this.ring.visible = true;
      const r = 1.5 + k * 24;
      this.ring.scale.set(r, 1, r);
      this.ring.position.set(0, this.centreY + 0.35, 0);
      this.ringMat.uniforms.uA.value = (1 - k) * (1 - k) * 0.55;
      this.flash.visible = k < 0.5;
      this.flash.position.set(0, this.centreY + 1.6, 0);
      const fs = 1 + k * 7;
      this.flash.scale.set(fs, fs * 0.8, fs);
      this.flashMat.opacity = Math.max(0, 0.22 * (1 - k * 2));
    } else {
      this.ring.visible = false;
      this.flash.visible = false;
    }
    this.shards.update(dt);
    this.parts.update(dt);
  }

  /** Live pooled elements (tests). */
  get liveShards(): number {
    return this.shards.liveCount;
  }
  get liveParticles(): number {
    return this.parts.liveCount;
  }
  get ringVisible(): boolean {
    return this.ring.visible;
  }

  dispose(): void {
    this.strip.dispose();
    this.shards.dispose();
    this.parts.dispose();
    this.ring.geometry.dispose();
    this.ringMat.dispose();
    this.flash.geometry.dispose();
    this.flashMat.dispose();
    this.root.removeFromParent();
  }
}
