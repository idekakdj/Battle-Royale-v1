/**
 * Shared building blocks for the Champions League stages: a vertex-coloured geometry baker (one merged
 * mesh per material → few draw calls), soft textures, the gradient sky dome, GPU-animated ambient motes,
 * parallax cloud layers, the water-fall material, the blast-zone telegraph and the `StageVisual` contract.
 * Everything here is node-safe (no DOM) so the stage builders can run in unit tests.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../../../core/math';
import type { BrawlEvent, PlatformState, StageDef } from '../../types';
import type { QualityTier } from '../../../render/quality';
import type { Vfx } from '../vfx/Vfx';

// ── Contract ─────────────────────────────────────────────────────────────────

export interface StageSetup {
  fog: { color: number; near: number; far: number };
  hemi: { sky: number; ground: number; intensity: number };
  key: { color: number; intensity: number; pos: [number, number, number] };
  rim: { color: number; intensity: number; pos: [number, number, number] };
  exposure: number;
  /** Post grade: linear tint, vignette strength, saturation. */
  grade: { tint: [number, number, number]; vignette: number; sat: number };
  /** Tint used for the soft contact shadows. */
  shadow: number;
}

/**
 * v1.6: the scene lights a stage may re-tint every frame (the Amphitheatre's night -> dawn flip). The view owns the light objects and
 * the post grade; a stage that never changes them simply omits `updateLights`.
 */
export interface StageLights {
  hemi: THREE.HemisphereLight;
  key: THREE.DirectionalLight;
  rim: THREE.DirectionalLight;
  fog: THREE.Fog | null;
  /** Tone-mapping exposure and post grade (the view pushes them to the pipeline when they change). */
  exposure: number;
  gradeTint: [number, number, number];
  gradeVignette: number;
  gradeSat: number;
}

/** What a stage may use to add one-off effects for sim events (v1.6): the pooled VFX hub and a camera rumble. */
export interface StageFxCtx {
  vfx: Vfx;
  rumble(amount: number): void;
}

export interface StageVisual {
  readonly group: THREE.Group;
  readonly setup: StageSetup;
  /**
   * Per frame. `platforms` = the interpolated platform states from the snapshot (moving platforms follow them),
   * `dt` = FX-clock seconds, `time` = FX-clock total seconds, `cam` = the render camera (parallax / billboards).
   */
  update(platforms: readonly PlatformState[], dt: number, time: number, cam: THREE.Camera): void;
  setTier(tier: QualityTier): void;
  dispose(): void;
  /** Debug/test: draw-call estimate of the static scenery (meshes + points). */
  countDrawables(): number;
  /**
   * v1.6 (optional): cosmetic one-off effects for the frame's sim events (`platformHit` / `platformBreak` / `stageFinal`). Never the source
   * of persistent state: what exists / how cracked / which form is always re-derived from `update(platforms)`.
   */
  onEvents?(events: readonly BrawlEvent[], ctx: StageFxCtx): void;
  /** v1.6 (optional): re-tint the scene lights / grade after `update` (called every frame when present). Return true when anything changed. */
  updateLights?(l: StageLights): boolean;
  /**
   * v1.6 (optional): the stage's persistent dynamic state for the F3 overlay / tests (derived from the platform snapshot, never from
   * events): e.g. `finalK` = how far the Amphitheatre is into its final-form look (0..1).
   */
  dynamicState?(): Readonly<Record<string, number>>;
}

// ── Resource bookkeeping ─────────────────────────────────────────────────────

export class ResourceBag {
  private readonly geos = new Set<THREE.BufferGeometry>();
  private readonly mats = new Set<THREE.Material>();
  private readonly texs = new Set<THREE.Texture>();

  geo<T extends THREE.BufferGeometry>(g: T): T {
    this.geos.add(g);
    return g;
  }
  mat<T extends THREE.Material>(m: T): T {
    this.mats.add(m);
    return m;
  }
  tex<T extends THREE.Texture>(t: T): T {
    this.texs.add(t);
    return t;
  }
  dispose(): void {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const t of this.texs) t.dispose();
    this.geos.clear();
    this.mats.clear();
    this.texs.clear();
  }
}

// ── Vertex-colour geometry baker ─────────────────────────────────────────────

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _c = new THREE.Color();
const _v = new THREE.Vector3();

export interface AddOpts {
  rx?: number;
  ry?: number;
  rz?: number;
  sx?: number;
  sy?: number;
  sz?: number;
  /** Random brightness jitter (fraction). */
  jitter?: number;
  /** Ambient-occlusion style darkening toward the bottom of the piece (0..1). */
  ao?: number;
  /** Extra vertical colour gradient: top colour blended in over the piece height. */
  topColor?: number;
}

/** Collects primitives (baked transform + vertex colour) and merges them into ONE BufferGeometry. */
export class GeoBuilder {
  private readonly parts: THREE.BufferGeometry[] = [];
  private readonly base = new THREE.Matrix4();
  private hasBase = false;
  constructor(readonly rng: () => number = mulberry32(1)) {}

  /** Run `fn` with every added part additionally transformed by `m` (group placement). */
  withTransform(m: THREE.Matrix4, fn: () => void): this {
    const prevBase = this.base.clone();
    const prevHas = this.hasBase;
    this.base.copy(prevHas ? prevBase.multiply(m) : m);
    this.hasBase = true;
    fn();
    this.base.copy(prevBase);
    this.hasBase = prevHas;
    return this;
  }

  add(src: THREE.BufferGeometry, color: number, x: number, y: number, z: number, o: AddOpts = {}): this {
    const g = src.index !== null ? src.toNonIndexed() : src.clone();
    g.deleteAttribute('uv');
    _e.set(o.rx ?? 0, o.ry ?? 0, o.rz ?? 0);
    _q.setFromEuler(_e);
    _v.set(o.sx ?? 1, o.sy ?? 1, o.sz ?? 1);
    _m4.compose(new THREE.Vector3(x, y, z), _q, _v);
    if (this.hasBase) _m4.premultiply(this.base);
    g.applyMatrix4(_m4);
    const pos = g.getAttribute('position');
    const n = pos.count;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const py = pos.getY(i);
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    const span = Math.max(1e-4, maxY - minY);
    const j = 1 + (this.rng() - 0.5) * 2 * (o.jitter ?? 0.05);
    const ao = o.ao ?? 0;
    const cols = new Float32Array(n * 3);
    _c.set(color);
    const baseR = _c.r;
    const baseG = _c.g;
    const baseB = _c.b;
    const tc = o.topColor !== undefined ? new THREE.Color(o.topColor) : null;
    for (let i = 0; i < n; i++) {
      const t = (pos.getY(i) - minY) / span;
      const k = j * (1 - ao * (1 - t));
      let r = baseR;
      let gg = baseG;
      let b = baseB;
      if (tc !== null) {
        const m = t * t;
        r += (tc.r - r) * m;
        gg += (tc.g - gg) * m;
        b += (tc.b - b) * m;
      }
      cols[i * 3] = r * k;
      cols[i * 3 + 1] = gg * k;
      cols[i * 3 + 2] = b * k;
    }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    // Keep only position / normal / color so every part merges.
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'color') g.deleteAttribute(name);
    }
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    this.parts.push(g);
    return this;
  }

  box(w: number, h: number, d: number, color: number, x: number, y: number, z: number, o: AddOpts = {}): this {
    return this.add(BOX_CACHE.get(1, 1, 1), color, x, y, z, { ...o, sx: w * (o.sx ?? 1), sy: h * (o.sy ?? 1), sz: d * (o.sz ?? 1) });
  }

  /** Cylinder along Y (radius top/bottom, height, radial segments). */
  cyl(rTop: number, rBot: number, h: number, color: number, x: number, y: number, z: number, seg = 8, o: AddOpts = {}): this {
    return this.add(new THREE.CylinderGeometry(rTop, rBot, h, seg, 1), color, x, y, z, o);
  }

  cone(r: number, h: number, color: number, x: number, y: number, z: number, seg = 7, o: AddOpts = {}): this {
    return this.add(new THREE.ConeGeometry(r, h, seg, 1), color, x, y, z, o);
  }

  /** Low-poly rock lump. */
  lump(r: number, color: number, x: number, y: number, z: number, o: AddOpts = {}, detail = 0): this {
    const g = new THREE.IcosahedronGeometry(r, detail);
    const pos = g.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const k = 0.82 + this.rng() * 0.36;
      pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k, pos.getZ(i) * k);
    }
    g.computeVertexNormals();
    return this.add(g, color, x, y, z, o);
  }

  get count(): number {
    return this.parts.length;
  }

  build(): THREE.BufferGeometry | null {
    if (this.parts.length === 0) return null;
    const merged = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts.length = 0;
    if (merged === null) return null;
    merged.computeBoundingSphere();
    return merged;
  }
}

class BoxCache {
  private g: THREE.BoxGeometry | null = null;
  get(w: number, h: number, d: number): THREE.BoxGeometry {
    if (this.g === null) this.g = new THREE.BoxGeometry(w, h, d);
    return this.g;
  }
}
const BOX_CACHE = new BoxCache();

/** Arch-shaped flat decal (rectangle with a semicircular top) facing +Z, origin at the base centre. */
export function archGeo(w: number, h: number): THREE.ShapeGeometry {
  const r = w / 2;
  const s = new THREE.Shape();
  s.moveTo(-r, 0);
  s.lineTo(-r, Math.max(0, h - r));
  s.absarc(0, Math.max(0, h - r), r, Math.PI, 0, true);
  s.lineTo(r, 0);
  s.lineTo(-r, 0);
  return new THREE.ShapeGeometry(s, 8);
}

export function stoneMaterial(rough = 0.93): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: rough, metalness: 0 });
}

/** Mesh helper that registers geometry + material in the bag and adds to `parent`. */
export function bakeMesh(
  bag: ResourceBag,
  parent: THREE.Object3D,
  geo: THREE.BufferGeometry | null,
  mat: THREE.Material,
  name = '',
): THREE.Mesh | null {
  if (geo === null) return null;
  bag.geo(geo);
  const m = new THREE.Mesh(geo, mat);
  m.name = name;
  m.matrixAutoUpdate = true;
  parent.add(m);
  return m;
}

// ── Textures ────────────────────────────────────────────────────────────────

/** Radial soft-disc alpha texture (white), node-safe (DataTexture). */
export function softDiscTexture(size = 64, power = 1.8): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const r = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 2);
      const a = Math.pow(1 - r, power);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

// ── Sky dome ────────────────────────────────────────────────────────────────

export interface SkyParams {
  top: number;
  mid: number;
  horizon: number;
  bottom: number;
  sunColor: number;
  /** Direction toward the sun (need not be normalised). */
  sunDir: [number, number, number];
  sunSize: number;
  /** Strength of the soft sun glow (0..1). */
  glow: number;
  /** Cloud band colours / amount (0 = none). */
  cloudLit: number;
  cloudShade: number;
  clouds: number;
  /** Horizon height (dir.y at which `horizon` is reached). */
  horizonY: number;
}

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * p;
}
`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uMid;
uniform vec3 uHorizon;
uniform vec3 uBottom;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
uniform float uSunSize;
uniform float uGlow;
uniform float uClouds;
uniform float uHorizonY;
uniform float uTime;
varying vec3 vDir;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0; float a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return s;
}
void main() {
  vec3 d = normalize(vDir);
  float h = d.y - uHorizonY;
  vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.16, h));
  col = mix(col, uTop, smoothstep(0.1, 0.5, h));
  col = mix(col, uBottom, smoothstep(0.0, -0.22, h));
  float s = max(dot(d, normalize(uSunDir)), 0.0);
  col += uSunColor * (pow(s, uSunSize) * 4.5 + pow(s, 64.0) * 0.4 * uGlow + pow(s, 6.0) * 0.16 * uGlow);
  if (uClouds > 0.01) {
    float band = smoothstep(-0.35, -0.02, h) * (1.0 - smoothstep(0.1, 0.5, h));
    vec2 p = vec2(d.x / (abs(d.y - uHorizonY) + 0.18), (d.y - uHorizonY) * 5.0) * 1.15 + vec2(uTime * 0.006, 0.0);
    float n = fbm(p);
    float m = smoothstep(0.52, 0.8, n) * band * uClouds;
    float lit = clamp(0.5 + 0.5 * pow(s, 2.0) + (n - 0.6) * 1.2, 0.0, 1.0);
    col = mix(col, mix(uCloudShade, uCloudLit, lit), m * 0.85);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class SkyDome {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.ShaderMaterial;
  constructor(bag: ResourceBag, p: SkyParams) {
    this.mat = bag.mat(
      new THREE.ShaderMaterial({
        uniforms: {
          uTop: { value: new THREE.Color(p.top) },
          uMid: { value: new THREE.Color(p.mid) },
          uHorizon: { value: new THREE.Color(p.horizon) },
          uBottom: { value: new THREE.Color(p.bottom) },
          uSunColor: { value: new THREE.Color(p.sunColor) },
          uSunDir: { value: new THREE.Vector3(...p.sunDir).normalize() },
          uCloudLit: { value: new THREE.Color(p.cloudLit) },
          uCloudShade: { value: new THREE.Color(p.cloudShade) },
          uSunSize: { value: p.sunSize },
          uGlow: { value: p.glow },
          uClouds: { value: p.clouds },
          uHorizonY: { value: p.horizonY },
          uTime: { value: 0 },
        },
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        fog: false,
      }),
    );
    const g = bag.geo(new THREE.SphereGeometry(300, 24, 14));
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.renderOrder = -100;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'sky';
  }
  /** Follow the camera so the sky never parallaxes. */
  update(cam: THREE.Camera, time: number): void {
    this.mesh.position.copy(cam.position);
    (this.mat.uniforms.uTime as THREE.IUniform<number>).value = time;
  }
  setClouds(on: boolean): void {
    (this.mat.uniforms.uClouds as THREE.IUniform<number>).value = on ? 1 : 0;
  }
  /** v1.6: blend between two parameter sets (`k` 0 = a, 1 = b): the Amphitheatre's night -> dawn sky. Allocation-free. */
  mix(a: SkyParams, b: SkyParams, k: number): void {
    const u = this.mat.uniforms;
    const lerpC = (name: string, ca: number, cb: number): void => {
      const c = (u[name] as THREE.IUniform<THREE.Color>).value;
      c.set(ca).lerp(_mixC.set(cb), k);
    };
    lerpC('uTop', a.top, b.top);
    lerpC('uMid', a.mid, b.mid);
    lerpC('uHorizon', a.horizon, b.horizon);
    lerpC('uBottom', a.bottom, b.bottom);
    lerpC('uSunColor', a.sunColor, b.sunColor);
    lerpC('uCloudLit', a.cloudLit, b.cloudLit);
    lerpC('uCloudShade', a.cloudShade, b.cloudShade);
    const sd = (u.uSunDir as THREE.IUniform<THREE.Vector3>).value;
    sd.set(a.sunDir[0] + (b.sunDir[0] - a.sunDir[0]) * k, a.sunDir[1] + (b.sunDir[1] - a.sunDir[1]) * k, a.sunDir[2] + (b.sunDir[2] - a.sunDir[2]) * k).normalize();
    (u.uSunSize as THREE.IUniform<number>).value = a.sunSize + (b.sunSize - a.sunSize) * k;
    (u.uGlow as THREE.IUniform<number>).value = a.glow + (b.glow - a.glow) * k;
    (u.uClouds as THREE.IUniform<number>).value = a.clouds + (b.clouds - a.clouds) * k;
    (u.uHorizonY as THREE.IUniform<number>).value = a.horizonY + (b.horizonY - a.horizonY) * k;
  }
}

const _mixC = new THREE.Color();

// ── GPU-animated ambient motes (embers / pollen / dust) ──────────────────────

export interface MoteParams {
  count: number;
  /** Spawn box centre / half extents. */
  cx: number;
  cy: number;
  cz: number;
  hx: number;
  hy: number;
  hz: number;
  /** Rise speed (m/s, can be negative), horizontal sway amplitude (m), size (px at 1 m), colours. */
  speed: number;
  sway: number;
  size: number;
  colorA: number;
  colorB: number;
  /** HDR boost (embers glow > 1). */
  boost: number;
  seed?: number;
}

const MOTE_VERT = /* glsl */ `
uniform float uTime;
uniform float uSize;
uniform vec3 uBox;     // half extents
uniform vec3 uCenter;
uniform float uSpeed;
uniform float uSway;
uniform float uScale;
attribute vec4 aRand; // x,y,z in 0..1, w phase
varying float vAlpha;
varying float vMix;
void main() {
  vec3 p;
  float yy = fract(aRand.y + uTime * uSpeed / (2.0 * uBox.y));
  p.y = (yy - 0.5) * 2.0 * uBox.y;
  p.x = (aRand.x - 0.5) * 2.0 * uBox.x + sin(uTime * (0.6 + aRand.w) + aRand.w * 40.0) * uSway;
  p.z = (aRand.z - 0.5) * 2.0 * uBox.z + cos(uTime * (0.5 + aRand.w * 0.8) + aRand.w * 20.0) * uSway * 0.5;
  p += uCenter;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float fade = smoothstep(0.0, 0.12, yy) * (1.0 - smoothstep(0.7, 1.0, yy));
  float tw = 0.65 + 0.35 * sin(uTime * (3.0 + aRand.w * 6.0) + aRand.w * 60.0);
  vAlpha = fade * tw;
  vMix = aRand.w;
  gl_PointSize = uSize * uScale * (0.55 + aRand.w * 0.9) * (30.0 / max(1.0, -mv.z));
}
`;

const MOTE_FRAG = /* glsl */ `
uniform vec3 uColA;
uniform vec3 uColB;
uniform float uBoost;
uniform float uFade;
varying float vAlpha;
varying float vMix;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c) * 2.0;
  float a = (1.0 - smoothstep(0.0, 1.0, r));
  a *= a;
  vec3 col = mix(uColA, uColB, vMix) * uBoost;
  gl_FragColor = vec4(col, a * vAlpha * uFade);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class Motes {
  readonly points: THREE.Points;
  private readonly mat: THREE.ShaderMaterial;
  private readonly total: number;
  constructor(bag: ResourceBag, p: MoteParams, additive = true) {
    const rng = mulberry32(p.seed ?? 7);
    this.total = p.count;
    const g = bag.geo(new THREE.BufferGeometry());
    const pos = new Float32Array(p.count * 3); // dummy (positions computed in the shader)
    const rnd = new Float32Array(p.count * 4);
    for (let i = 0; i < p.count; i++) {
      rnd[i * 4] = rng();
      rnd[i * 4 + 1] = rng();
      rnd[i * 4 + 2] = rng();
      rnd[i * 4 + 3] = rng();
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aRand', new THREE.BufferAttribute(rnd, 4));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(p.cx, p.cy, p.cz), Math.max(p.hx, p.hy, p.hz) * 2);
    this.mat = bag.mat(
      new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uSize: { value: p.size },
          uBox: { value: new THREE.Vector3(p.hx, p.hy, p.hz) },
          uCenter: { value: new THREE.Vector3(p.cx, p.cy, p.cz) },
          uSpeed: { value: p.speed },
          uSway: { value: p.sway },
          uScale: { value: 1 },
          uColA: { value: new THREE.Color(p.colorA) },
          uColB: { value: new THREE.Color(p.colorB) },
          uBoost: { value: p.boost },
          uFade: { value: 1 },
        },
        vertexShader: MOTE_VERT,
        fragmentShader: MOTE_FRAG,
        transparent: true,
        depthWrite: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        fog: false,
      }),
    );
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
  }
  update(time: number): void {
    (this.mat.uniforms.uTime as THREE.IUniform<number>).value = time;
  }
  /** v1.6: global alpha (0..1) and a colour re-tint (`k` 0 = the construction colours, 1 = `a` / `b`). */
  setFade(f: number): void {
    (this.mat.uniforms.uFade as THREE.IUniform<number>).value = f;
    this.points.visible = f > 0.01;
  }
  setColors(a: number, b: number): void {
    (this.mat.uniforms.uColA as THREE.IUniform<THREE.Color>).value.set(a);
    (this.mat.uniforms.uColB as THREE.IUniform<THREE.Color>).value.set(b);
  }
  /** Fraction of the motes drawn (tier scaling). */
  setDensity(f: number): void {
    const n = Math.max(0, Math.min(this.total, Math.round(this.total * f)));
    this.points.geometry.setDrawRange(0, n);
  }
  /** Rendering scale for the point size (pixel-ratio / resolution independence). */
  setScale(s: number): void {
    (this.mat.uniforms.uScale as THREE.IUniform<number>).value = s;
  }
}

// ── Parallax cloud layer (instanced soft puffs) ──────────────────────────────

export interface CloudLayerParams {
  count: number;
  /** x span (centred on `cx`), y range, depth, puff size range. */
  cx: number;
  span: number;
  y0: number;
  y1: number;
  z: number;
  sizeMin: number;
  sizeMax: number;
  /** m/s drift. */
  speed: number;
  colorTop: number;
  colorBottom: number;
  opacity: number;
  seed: number;
}

export class CloudLayer {
  readonly mesh: THREE.InstancedMesh;
  private readonly base: Float32Array; // x, y, w, h per instance
  private readonly p: CloudLayerParams;
  private readonly dummy = new THREE.Object3D();
  constructor(bag: ResourceBag, tex: THREE.Texture, p: CloudLayerParams) {
    this.p = p;
    const rng = mulberry32(p.seed);
    const geo = bag.geo(new THREE.PlaneGeometry(1, 1));
    const mat = bag.mat(
      new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        opacity: p.opacity,
        fog: false,
        color: 0xffffff,
      }),
    );
    this.mesh = new THREE.InstancedMesh(geo, mat, p.count);
    this.mesh.frustumCulled = false;
    this.base = new Float32Array(p.count * 4);
    const top = new THREE.Color(p.colorTop);
    const bot = new THREE.Color(p.colorBottom);
    const col = new THREE.Color();
    // Clusters of 3–6 puffs so each cloud reads as a lumpy bank, lit on top and shaded underneath.
    let i = 0;
    while (i < p.count) {
      const cxp = (rng() - 0.5) * p.span;
      const cyp = p.y0 + rng() * (p.y1 - p.y0);
      const n = 3 + Math.floor(rng() * 4);
      const sz = p.sizeMin + rng() * (p.sizeMax - p.sizeMin);
      for (let k = 0; k < n && i < p.count; k++, i++) {
        const ox = (k - (n - 1) / 2) * sz * 0.55 + (rng() - 0.5) * sz * 0.3;
        const oy = (rng() - 0.35) * sz * 0.22 + Math.sin((k / Math.max(1, n - 1)) * Math.PI) * sz * 0.14;
        const s = sz * (0.7 + rng() * 0.5) * (1 - Math.abs(k - (n - 1) / 2) * 0.1);
        this.base[i * 4] = cxp + ox;
        this.base[i * 4 + 1] = cyp + oy;
        this.base[i * 4 + 2] = s * 1.6;
        this.base[i * 4 + 3] = s * 0.85;
        const t = clamp01((oy / sz + 0.12) * 2.2 + 0.5);
        col.copy(bot).lerp(top, t);
        this.mesh.setColorAt(i, col);
      }
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.update(0, 0);
  }
  update(time: number, camX: number): void {
    const p = this.p;
    const span = p.span;
    const off = time * p.speed;
    const d = this.dummy;
    for (let i = 0; i < p.count; i++) {
      let x = this.base[i * 4] + off;
      // Wrap into the span (centred on cx, shifted a little with the camera for extra parallax).
      x = ((((x - p.cx) % span) + span * 1.5) % span) - span / 2 + p.cx;
      d.position.set(x, this.base[i * 4 + 1], p.z);
      d.scale.set(this.base[i * 4 + 2], this.base[i * 4 + 3], 1);
      d.updateMatrix();
      this.mesh.setMatrixAt(i, d.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    void camX;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ── Water-fall / mist material ───────────────────────────────────────────────

const FALL_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const FALL_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uCol;
uniform vec3 uFoam;
uniform float uLen;
varying vec2 vUv;
float hash(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  // vUv.y: 1 at the lip, 0 at the bottom.
  float x = vUv.x;
  float cols = 9.0;
  float cid = floor(x * cols);
  float speed = 0.5 + hash(cid) * 0.6;
  float streak = fract(vUv.y * (2.0 + hash(cid + 3.0) * 3.0) * (uLen / 14.0) + uTime * speed + hash(cid + 7.0));
  float s = smoothstep(0.0, 0.55, streak) * (1.0 - smoothstep(0.55, 1.0, streak));
  float edge = smoothstep(0.0, 0.14, x) * smoothstep(1.0, 0.86, x);
  float fade = smoothstep(0.0, 0.5, vUv.y) * (0.55 + 0.45 * smoothstep(1.0, 0.9, vUv.y));
  float body = 0.5 + 0.5 * s;
  float foam = smoothstep(0.9, 1.0, vUv.y);
  vec3 c = mix(uCol, uFoam, clamp(s * 0.55 + foam, 0.0, 1.0));
  float a = body * edge * fade * 0.8;
  gl_FragColor = vec4(c, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function makeWaterfall(
  bag: ResourceBag,
  width: number,
  length: number,
  color: number,
  foam: number,
): { mesh: THREE.Mesh; update: (t: number) => void } {
  const g = bag.geo(new THREE.PlaneGeometry(width, length, 1, 1));
  g.translate(0, -length / 2, 0);
  const m = bag.mat(
    new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCol: { value: new THREE.Color(color) },
        uFoam: { value: new THREE.Color(foam) },
        uLen: { value: length },
      },
      vertexShader: FALL_VERT,
      fragmentShader: FALL_FRAG,
      transparent: true,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
    }),
  );
  const mesh = new THREE.Mesh(g, m);
  return { mesh, update: (t: number): void => void ((m.uniforms.uTime as THREE.IUniform<number>).value = t) };
}

// ── Blast-zone telegraph (faint glow bands + a thin line at each edge) ───────

const BLAST_VERT = /* glsl */ `
attribute float aEdge;
varying float vEdge;
void main() {
  vEdge = aEdge;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const BLAST_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uCol;
varying float vEdge;
void main() {
  float e = clamp(vEdge, 0.0, 1.0);
  float band = pow(max(1.0 - e, 0.0), 2.4);
  float line = (1.0 - smoothstep(0.0, 0.012, e));
  float pulse = 0.78 + 0.22 * sin(uTime * 2.4);
  float a = (band * 0.34 + line * 0.6) * pulse;
  gl_FragColor = vec4(uCol * (0.9 + line * 1.3), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function buildBlastTelegraph(
  bag: ResourceBag,
  stage: StageDef,
  color = 0xff4a38,
): { mesh: THREE.Mesh; update: (t: number) => void } {
  const b = stage.blast;
  const depth = 0; // plane z
  const w = 9; // band thickness (m)
  // Four quads: each has aEdge = 0 on the blast line, 1 at the inner side.
  const pos: number[] = [];
  const edge: number[] = [];
  const idx: number[] = [];
  const quad = (a: [number, number], bb: [number, number], c: [number, number], d: [number, number], e0: number, e1: number): void => {
    const base = pos.length / 3;
    pos.push(a[0], a[1], depth, bb[0], bb[1], depth, c[0], c[1], depth, d[0], d[1], depth);
    edge.push(e0, e0, e1, e1);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const ext = 40; // extend past the corners
  // left (blast line at b.left, band extends inward = +x)
  quad([b.left, b.bottom - ext], [b.left, b.top + ext], [b.left + w, b.top + ext], [b.left + w, b.bottom - ext], 0, 1);
  // right
  quad([b.right, b.top + ext], [b.right, b.bottom - ext], [b.right - w, b.bottom - ext], [b.right - w, b.top + ext], 0, 1);
  // top
  quad([b.left - ext, b.top], [b.right + ext, b.top], [b.right + ext, b.top - w], [b.left - ext, b.top - w], 0, 1);
  // bottom
  quad([b.right + ext, b.bottom], [b.left - ext, b.bottom], [b.left - ext, b.bottom + w], [b.right + ext, b.bottom + w], 0, 1);
  const g = bag.geo(new THREE.BufferGeometry());
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  const m = bag.mat(
    new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uCol: { value: new THREE.Color(color) } },
      vertexShader: BLAST_VERT,
      fragmentShader: BLAST_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    }),
  );
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  mesh.renderOrder = 50;
  mesh.name = 'blast-telegraph';
  return { mesh, update: (t: number): void => void ((m.uniforms.uTime as THREE.IUniform<number>).value = t) };
}

// ── Platform visual bookkeeping ──────────────────────────────────────────────

/** A platform's visual group: its origin is the top-surface centre (the snapshot supplies the live x0/x1/y of moving ones). */
export interface PlatformVisual {
  id: string;
  group: THREE.Group;
  x0: number;
  y: number;
  moving: boolean;
}

/** Apply the snapshot platform states to the visual groups (moving platforms only). Never recomputes motion. */
export function syncPlatforms(visuals: readonly PlatformVisual[], platforms: readonly PlatformState[]): void {
  for (let i = 0; i < visuals.length; i++) {
    const v = visuals[i];
    if (!v.moving) continue;
    for (let k = 0; k < platforms.length; k++) {
      const s = platforms[k];
      if (s.id !== v.id) continue;
      v.group.position.set((s.x0 + s.x1) / 2, s.y, 0);
      break;
    }
  }
}

export { mulberry32 };
