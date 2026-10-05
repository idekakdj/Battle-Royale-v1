/**
 * Pooled, instanced quad particles (one draw call per pool). A particle is a camera-facing quad on the z plane
 * with a procedural look chosen by `kind` (soft disc, ring, streak, star flash, beam, laurel ring, ghost capsule,
 * dust puff). Struct-of-arrays state, swap-remove compaction, zero allocation per frame in steady state.
 */

import * as THREE from 'three';

export const K = {
  disc: 0,
  ring: 1,
  streak: 2,
  star: 3,
  beam: 4,
  laurel: 5,
  ghost: 6,
  puff: 7,
  clod: 8,
} as const;

const VERT = /* glsl */ `
attribute vec4 iA; // x, y, z, rotation
attribute vec4 iB; // sx, sy, kind, param
attribute vec4 iC; // rgba
varying vec2 vP;
varying vec4 vC;
varying vec2 vK;
void main() {
  vP = position.xy;
  vC = iC;
  vK = iB.zw;
  float c = cos(iA.w);
  float s = sin(iA.w);
  vec2 q = position.xy * iB.xy;
  q = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
  vec3 wp = vec3(iA.xy + q, iA.z);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const FRAG = /* glsl */ `
varying vec2 vP;
varying vec4 vC;
varying vec2 vK;
void main() {
  vec2 p = vP;
  float r = length(p) * 2.0;
  float k = vK.x;
  float prm = vK.y;
  float a = 0.0;
  float hot = 0.0;
  float sh = 1.0;
  float am = vC.a;
  if (k < 0.5) {            // soft disc
    float f = clamp(1.0 - r, 0.0, 1.0);
    a = f * f;
    hot = f * f * f * f;
  } else if (k < 1.5) {     // ring (param = thickness)
    float w = max(prm, 0.03);
    float d = abs(r - (1.0 - w * 0.5));
    a = (1.0 - smoothstep(0.0, w * 0.5, d)) * (1.0 - smoothstep(0.92, 1.0, r));
    hot = a * a;
  } else if (k < 2.5) {     // streak, bright head at +x
    float u = p.x + 0.5;
    float v = abs(p.y) * 2.0;
    float hw = mix(0.12, 1.0, smoothstep(0.0, 0.85, u));
    a = (1.0 - smoothstep(hw * 0.35, hw, v)) * pow(clamp(u, 0.0, 1.0), 1.3) * (1.0 - smoothstep(0.96, 1.0, u));
    hot = a * smoothstep(0.55, 1.0, u);
  } else if (k < 3.5) {     // 4-point star flash
    vec2 q = abs(p) * 2.0;
    float f = pow(q.x, 0.55) + pow(q.y, 0.55);
    float st = clamp(1.0 - f, 0.0, 1.0);
    float core = clamp(1.0 - r * 1.15, 0.0, 1.0);
    a = clamp(st * st * 1.4 + core * core * 0.9, 0.0, 1.0);
    hot = core * core;
  } else if (k < 4.5) {     // beam: soft bar along x (param = core sharpness)
    float v = abs(p.y) * 2.0;
    float e = 1.0 - smoothstep(0.82, 1.0, abs(p.x) * 2.0);
    float f = clamp(1.0 - v, 0.0, 1.0);
    a = pow(f, 1.6) * e;
    hot = pow(f, 5.0 + prm * 6.0) * e;
  } else if (k < 5.5) {     // laurel ring: notched leaves around a ring
    float ang = atan(p.y, p.x);
    float leaf = 0.55 + 0.45 * sin(ang * 12.0);
    float w = 0.16;
    float d = abs(r - 0.82);
    a = (1.0 - smoothstep(0.0, w, d)) * leaf * (1.0 - smoothstep(0.92, 1.0, r));
    hot = a * a;
  } else if (k < 6.5) {     // ghost capsule (soft rounded silhouette)
    vec2 q = abs(p) * 2.0;
    float e = pow(pow(q.x, 2.4) + pow(q.y, 2.4), 1.0 / 2.4);
    a = 1.0 - smoothstep(0.5, 1.0, e);
    hot = 0.0;
  } else if (k < 7.5) {     // puff: soft flat disc with a slightly lumpy edge
    float ang = atan(p.y, p.x);
    float lump = 1.0 + 0.12 * sin(ang * 5.0 + prm * 6.28) + 0.07 * sin(ang * 9.0 - prm * 12.0);
    a = 1.0 - smoothstep(0.35, 1.0, r * lump);
  } else {                  // clod: hard-edged lumpy soil chunk, lit from the upper left (param = seed)
    float ang = atan(p.y, p.x);
    float lump = 1.0 + 0.16 * sin(ang * 3.0 + prm * 6.28) + 0.1 * sin(ang * 7.0 - prm * 9.0);
    a = 1.0 - smoothstep(0.8, 1.0, r * lump);
    sh = 0.62 + 0.55 * clamp(0.5 - p.x * 0.9 + p.y * 1.1, 0.0, 1.0);
    am = min(vC.a, 1.0); // (an alpha above 1 is used to hold full opacity; normal blending must never see it)
  }
  vec3 col = vC.rgb * sh * (1.0 + hot * 1.2);
  gl_FragColor = vec4(col, a * am);
  if (gl_FragColor.a < 0.003) discard;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Spawn description (reused scratch object; set the fields you need and call `pool.spawn(spec)`). */
export class Spec {
  kind = 0;
  x = 0;
  y = 0;
  z = 0.6;
  vx = 0;
  vy = 0;
  rot = 0;
  vrot = 0;
  sx0 = 1;
  sy0 = 1;
  sx1 = 1;
  sy1 = 1;
  life = 0.5;
  r = 1;
  g = 1;
  b = 1;
  a0 = 1;
  a1 = 0;
  r1 = -1; // < 0: same colour
  g1 = 0;
  b1 = 0;
  drag = 0;
  grav = 0;
  param = 0;
  /** Fade-in fraction of the life (0 = none). */
  fadeIn = 0.06;
  /** Size easing exponent: 1 linear, < 1 fast start (burst), > 1 slow start. */
  ease = 0.6;
  reset(): this {
    this.kind = 0;
    this.x = this.y = this.vx = this.vy = this.rot = this.vrot = 0;
    this.z = 0.6;
    this.sx0 = this.sy0 = this.sx1 = this.sy1 = 1;
    this.life = 0.5;
    this.r = this.g = this.b = 1;
    this.a0 = 1;
    this.a1 = 0;
    this.r1 = -1;
    this.g1 = this.b1 = 0;
    this.drag = this.grav = this.param = 0;
    this.fadeIn = 0.06;
    this.ease = 0.6;
    return this;
  }
  rgb(hex: number, boost = 1): this {
    this.r = (((hex >> 16) & 0xff) / 255) ** 2.2 * boost;
    this.g = (((hex >> 8) & 0xff) / 255) ** 2.2 * boost;
    this.b = ((hex & 0xff) / 255) ** 2.2 * boost;
    return this;
  }
  rgb1(hex: number, boost = 1): this {
    this.r1 = (((hex >> 16) & 0xff) / 255) ** 2.2 * boost;
    this.g1 = (((hex >> 8) & 0xff) / 255) ** 2.2 * boost;
    this.b1 = ((hex & 0xff) / 255) ** 2.2 * boost;
    return this;
  }
}

export class QuadPool {
  readonly mesh: THREE.Mesh;
  readonly cap: number;
  n = 0;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private readonly iA: THREE.InstancedBufferAttribute;
  private readonly iB: THREE.InstancedBufferAttribute;
  private readonly iC: THREE.InstancedBufferAttribute;
  // SoA state
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly rot: Float32Array;
  private readonly vrot: Float32Array;
  private readonly s0: Float32Array; // sx0, sy0, sx1, sy1
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly col0: Float32Array; // r,g,b,a0
  private readonly col1: Float32Array; // r,g,b,a1
  private readonly misc: Float32Array; // drag, grav, kind, param
  private readonly shape: Float32Array; // fadeIn, ease
  private ring = 0;

  constructor(cap: number, additive: boolean) {
    this.cap = cap;
    this.px = new Float32Array(cap);
    this.py = new Float32Array(cap);
    this.pz = new Float32Array(cap);
    this.vx = new Float32Array(cap);
    this.vy = new Float32Array(cap);
    this.rot = new Float32Array(cap);
    this.vrot = new Float32Array(cap);
    this.s0 = new Float32Array(cap * 4);
    this.age = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.col0 = new Float32Array(cap * 4);
    this.col1 = new Float32Array(cap * 4);
    this.misc = new Float32Array(cap * 4);
    this.shape = new Float32Array(cap * 2);

    this.geo = new THREE.InstancedBufferGeometry();
    const quad = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
    this.geo.setAttribute('position', new THREE.BufferAttribute(quad, 3));
    this.geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.iA = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.iB = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.iC = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.iA.setUsage(THREE.DynamicDrawUsage);
    this.iB.setUsage(THREE.DynamicDrawUsage);
    this.iC.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('iA', this.iA);
    this.geo.setAttribute('iB', this.iB);
    this.geo.setAttribute('iC', this.iC);
    this.geo.instanceCount = 0;
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e5);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: false,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 30 : 20;
    this.mesh.visible = false;
  }

  spawn(s: Spec): void {
    let i: number;
    if (this.n < this.cap) {
      i = this.n++;
    } else {
      // Pool full: recycle round-robin (oldest-ish).
      i = this.ring;
      this.ring = (this.ring + 1) % this.cap;
    }
    this.px[i] = s.x;
    this.py[i] = s.y;
    this.pz[i] = s.z;
    this.vx[i] = s.vx;
    this.vy[i] = s.vy;
    this.rot[i] = s.rot;
    this.vrot[i] = s.vrot;
    const k = i * 4;
    this.s0[k] = s.sx0;
    this.s0[k + 1] = s.sy0;
    this.s0[k + 2] = s.sx1;
    this.s0[k + 3] = s.sy1;
    this.age[i] = 0;
    this.life[i] = Math.max(0.016, s.life);
    this.col0[k] = s.r;
    this.col0[k + 1] = s.g;
    this.col0[k + 2] = s.b;
    this.col0[k + 3] = s.a0;
    const same = s.r1 < 0;
    this.col1[k] = same ? s.r : s.r1;
    this.col1[k + 1] = same ? s.g : s.g1;
    this.col1[k + 2] = same ? s.b : s.b1;
    this.col1[k + 3] = s.a1;
    this.misc[k] = s.drag;
    this.misc[k + 1] = s.grav;
    this.misc[k + 2] = s.kind;
    this.misc[k + 3] = s.param;
    this.shape[i * 2] = s.fadeIn;
    this.shape[i * 2 + 1] = s.ease;
  }

  private remove(i: number): void {
    const l = --this.n;
    if (i === l) return;
    this.px[i] = this.px[l];
    this.py[i] = this.py[l];
    this.pz[i] = this.pz[l];
    this.vx[i] = this.vx[l];
    this.vy[i] = this.vy[l];
    this.rot[i] = this.rot[l];
    this.vrot[i] = this.vrot[l];
    this.age[i] = this.age[l];
    this.life[i] = this.life[l];
    const k = i * 4;
    const m = l * 4;
    for (let j = 0; j < 4; j++) {
      this.s0[k + j] = this.s0[m + j];
      this.col0[k + j] = this.col0[m + j];
      this.col1[k + j] = this.col1[m + j];
      this.misc[k + j] = this.misc[m + j];
    }
    this.shape[i * 2] = this.shape[l * 2];
    this.shape[i * 2 + 1] = this.shape[l * 2 + 1];
  }

  clear(): void {
    this.n = 0;
    this.ring = 0;
    this.geo.instanceCount = 0;
    this.mesh.visible = false;
  }

  update(dt: number): void {
    const A = this.iA.array as Float32Array;
    const B = this.iB.array as Float32Array;
    const Cc = this.iC.array as Float32Array;
    let i = 0;
    while (i < this.n) {
      const a = (this.age[i] += dt);
      const life = this.life[i];
      if (a >= life) {
        this.remove(i);
        continue;
      }
      const k = i * 4;
      const drag = this.misc[k];
      const df = drag > 0 ? 1 / (1 + drag * dt) : 1;
      this.vx[i] *= df;
      this.vy[i] = this.vy[i] * df - this.misc[k + 1] * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.rot[i] += this.vrot[i] * dt;
      const t = a / life;
      const e = Math.pow(t, this.shape[i * 2 + 1]);
      const sx = this.s0[k] + (this.s0[k + 2] - this.s0[k]) * e;
      const sy = this.s0[k + 1] + (this.s0[k + 3] - this.s0[k + 1]) * e;
      const fi = this.shape[i * 2];
      const fade = fi > 0 && t < fi ? t / fi : 1;
      A[k] = this.px[i];
      A[k + 1] = this.py[i];
      A[k + 2] = this.pz[i];
      A[k + 3] = this.rot[i];
      B[k] = sx;
      B[k + 1] = sy;
      B[k + 2] = this.misc[k + 2];
      B[k + 3] = this.misc[k + 3];
      Cc[k] = this.col0[k] + (this.col1[k] - this.col0[k]) * t;
      Cc[k + 1] = this.col0[k + 1] + (this.col1[k + 1] - this.col0[k + 1]) * t;
      Cc[k + 2] = this.col0[k + 2] + (this.col1[k + 2] - this.col0[k + 2]) * t;
      Cc[k + 3] = (this.col0[k + 3] + (this.col1[k + 3] - this.col0[k + 3]) * t) * fade;
      i++;
    }
    this.geo.instanceCount = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n > 0) {
      this.iA.needsUpdate = true;
      this.iB.needsUpdate = true;
      this.iC.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
  }
}
