/**
 * Effects (BLUEPRINT §11.4, polished in v1.1 WP-K) — pooled,
 * allocation-free-after-init combat FX.
 *
 * Systems: swing arc ribbon trails, hit sparks (hot core flash + spark spray +
 * impact ring) vs blocked sparks (blue-white), guard-break shatter, dust
 * puffs, telegraph ground decals (ring / arc sector / rect; red enemy / gold
 * player; animated fill + marching bands), ground-crack decals for slams,
 * footstep/landing dust (fed by the animal rigs through render/fxBus), ult
 * auras (accent ground ring + blooming light column), floating damage numbers
 * (64 pooled canvas billboards — size scales with damage, capped on-screen,
 * randomized + stacked so they never blob, drawn in the untonemapped overlay
 * layer), death burst + crowd streamers, and a screenshake offset the
 * CameraRig applies (≤0.15 m) plus a FOV kick on ultimates/heavy hits.
 *
 * Public API is event-shaped so WP-I can pipe GameEvents straight in
 * (positions are plain `Vec3` from core/types) — unchanged from v1.0.
 *
 * Budgets: ≤500 live particles (two pools totalling 500); typical draw calls
 * ≤ 2 (points) + visible ribbons/decals/numbers/flashes.
 */

import * as THREE from 'three';
import type { AnimalId, Vec3 } from '../core/types';
import { ANIMALS } from '../config/animals';
import { DEG2RAD, TAU, clamp01 } from '../core/math';
import { STANDS_INNER } from '../config/arena';
import { OVERLAY_LAYER } from './SceneManager';
import { kickFov, setFxSink, getFxSink, type FxSink, type SlamKind } from './fxBus';
import { tierProfile } from './quality';

export type TelegraphKind = 'ring' | 'arc' | 'rect';

export interface HitOptions {
  /** Blocked hit: blue-white sparks + pale number. */
  blocked?: boolean;
  /** Finisher/ult crit styling on sparks + number. */
  crit?: boolean;
}

// ── Tunables ────────────────────────────────────────────────────────────────
const MAX_ADDITIVE = 320;
const MAX_SOFT = 180; // 320 + 180 = 500 (§11.4 particle budget)
const RIBBONS = 8;
const RIBBON_SEGS = 14;
const DECALS = 8;
const NUMBERS = 64;
const FLASHES = 8;
const IMPACT_RINGS = 8;
const RINGS = 6;
const CRACKS = 6;
const COLUMNS = 3;
const SHAKE_MAX = 0.15;
const SHAKE_TAU = 0.16;

// Damage numbers.
const NUM_TTL = 1.05;
const NUM_MIN_SCALE = 0.34; // world height (m) at the reference distance
const NUM_MAX_SCALE = 0.8;
const NUM_REF_DIST = 8; // m — numbers keep a near-constant screen size around here
const NUM_STACK_RADIUS = 1.4;
const NUM_STACK_WINDOW = 0.55; // s
const NUM_STACK_STEP = 0.46; // m

const COL_TELE_ENEMY = 0xff3b2f;
const COL_TELE_FRIEND = 0xffc93c;

const _c = new THREE.Color();
const _v = new THREE.Vector3();

// ── Point-sprite shaders (per-particle size/alpha/color) ────────────────────
const POINTS_VERTEX = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uPointScale;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uPointScale / max(0.1, -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

const POINTS_FRAGMENT = /* glsl */ `
uniform float uBoost;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  float a = vAlpha * smoothstep(1.0, 0.35, d);
  if (a < 0.012) discard;
  float core = 1.0 + uBoost * (1.0 - smoothstep(0.0, 0.45, d));
  gl_FragColor = vec4(vColor * core, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Swap-compacted particle pool rendered as one THREE.Points (1 draw call). */
class ParticlePool {
  readonly points: THREE.Points;
  count = 0;

  private readonly max: number;
  private readonly aPos: THREE.BufferAttribute;
  private readonly aCol: THREE.BufferAttribute;
  private readonly aAlpha: THREE.BufferAttribute;
  private readonly aSize: THREE.BufferAttribute;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly ttl: Float32Array;
  private readonly grav: Float32Array;
  private readonly damp: Float32Array;
  private readonly size0: Float32Array;
  private readonly size1: Float32Array;
  private readonly alpha0: Float32Array;
  private readonly material: THREE.ShaderMaterial;
  private cursor = 0;

  constructor(max: number, additive: boolean, pointScale: { value: number }) {
    this.max = max;
    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(new Float32Array(max * 3), 3);
    this.aCol = new THREE.BufferAttribute(new Float32Array(max * 3), 3);
    this.aAlpha = new THREE.BufferAttribute(new Float32Array(max), 1);
    this.aSize = new THREE.BufferAttribute(new Float32Array(max), 1);
    this.aPos.setUsage(THREE.DynamicDrawUsage);
    this.aCol.setUsage(THREE.DynamicDrawUsage);
    this.aAlpha.setUsage(THREE.DynamicDrawUsage);
    this.aSize.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aColor', this.aCol);
    geo.setAttribute('aAlpha', this.aAlpha);
    geo.setAttribute('aSize', this.aSize);
    geo.setDrawRange(0, 0);

    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.ttl = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.damp = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.size1 = new Float32Array(max);
    this.alpha0 = new Float32Array(max);

    this.material = new THREE.ShaderMaterial({
      uniforms: { uPointScale: pointScale, uBoost: { value: additive ? 1.6 : 0 } },
      vertexShader: POINTS_VERTEX,
      fragmentShader: POINTS_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  spawn(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    ttl: number, s0: number, s1: number,
    r: number, g: number, b: number,
    alpha: number, grav: number, damp: number,
  ): void {
    let i: number;
    if (this.count < this.max) i = this.count++;
    else {
      i = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
    }
    this.aPos.setXYZ(i, x, y, z);
    this.aCol.setXYZ(i, r, g, b);
    this.aAlpha.setX(i, alpha);
    this.aSize.setX(i, s0);
    const o = i * 3;
    this.vel[o] = vx;
    this.vel[o + 1] = vy;
    this.vel[o + 2] = vz;
    this.life[i] = ttl;
    this.ttl[i] = ttl;
    this.grav[i] = grav;
    this.damp[i] = damp;
    this.size0[i] = s0;
    this.size1[i] = s1;
    this.alpha0[i] = alpha;
  }

  update(dt: number): void {
    for (let i = this.count - 1; i >= 0; i--) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.kill(i);
        continue;
      }
      const o = i * 3;
      const d = 1 - this.damp[i] * dt;
      const dd = d < 0 ? 0 : d;
      this.vel[o] *= dd;
      this.vel[o + 2] *= dd;
      this.vel[o + 1] = this.vel[o + 1] * dd + this.grav[i] * dt;
      let ny = this.aPos.getY(i) + this.vel[o + 1] * dt;
      if (ny < 0.03) {
        ny = 0.03;
        this.vel[o + 1] *= -0.3;
      }
      this.aPos.setXYZ(i, this.aPos.getX(i) + this.vel[o] * dt, ny, this.aPos.getZ(i) + this.vel[o + 2] * dt);
      const frac = this.life[i] / this.ttl[i]; // 1 → 0
      const age = 1 - frac;
      this.aSize.setX(i, this.size0[i] + (this.size1[i] - this.size0[i]) * age);
      const fade = frac < 0.35 ? frac / 0.35 : 1;
      this.aAlpha.setX(i, this.alpha0[i] * fade);
    }
    this.aPos.needsUpdate = true;
    this.aCol.needsUpdate = true;
    this.aAlpha.needsUpdate = true;
    this.aSize.needsUpdate = true;
    this.points.geometry.setDrawRange(0, this.count);
  }

  private kill(i: number): void {
    const last = --this.count;
    if (i === last) return;
    this.aPos.setXYZ(i, this.aPos.getX(last), this.aPos.getY(last), this.aPos.getZ(last));
    this.aCol.setXYZ(i, this.aCol.getX(last), this.aCol.getY(last), this.aCol.getZ(last));
    this.aAlpha.setX(i, this.aAlpha.getX(last));
    this.aSize.setX(i, this.aSize.getX(last));
    const oi = i * 3;
    const ol = last * 3;
    this.vel[oi] = this.vel[ol];
    this.vel[oi + 1] = this.vel[ol + 1];
    this.vel[oi + 2] = this.vel[ol + 2];
    this.life[i] = this.life[last];
    this.ttl[i] = this.ttl[last];
    this.grav[i] = this.grav[last];
    this.damp[i] = this.damp[last];
    this.size0[i] = this.size0[last];
    this.size1[i] = this.size1[last];
    this.alpha0[i] = this.alpha0[last];
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

// ── Swing arc ribbons ────────────────────────────────────────────────────────
class RibbonPool {
  readonly group = new THREE.Group();
  private readonly meshes: THREE.Mesh[] = [];
  private readonly mats: THREE.MeshBasicMaterial[] = [];
  private readonly life = new Float32Array(RIBBONS);
  private readonly ttl = new Float32Array(RIBBONS);

  constructor() {
    for (let i = 0; i < RIBBONS; i++) {
      const geo = new THREE.BufferGeometry();
      const verts = (RIBBON_SEGS + 1) * 2;
      const pos = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
      pos.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('position', pos);
      // Alpha gradient across the ribbon (inner edge faint, outer bright).
      const col = new Float32Array(verts * 3);
      for (let s = 0; s <= RIBBON_SEGS; s++) {
        const t = s / RIBBON_SEGS;
        const k = 0.25 + 0.75 * t; // trailing end dimmer
        col.set([0.35 * k, 0.35 * k, 0.35 * k, k, k, k], s * 6);
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const idx = new Uint16Array(RIBBON_SEGS * 6);
      for (let s = 0; s < RIBBON_SEGS; s++) {
        const a = s * 2;
        idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], s * 6);
      }
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      const mat = new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        vertexColors: true,
        fog: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 6;
      this.group.add(mesh);
      this.meshes.push(mesh);
      this.mats.push(mat);
    }
  }

  spawn(pos: Vec3, yaw: number, range: number, arcDeg: number, color: number): void {
    let slot = 0;
    let best = Infinity;
    for (let i = 0; i < RIBBONS; i++) {
      if (!this.meshes[i].visible) {
        slot = i;
        best = -1;
        break;
      }
      if (this.life[i] < best) {
        best = this.life[i];
        slot = i;
      }
    }
    const mesh = this.meshes[slot];
    const attr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arcHalf = (arcDeg * DEG2RAD) / 2;
    const ri = range * 0.42;
    const ro = range;
    for (let s = 0; s <= RIBBON_SEGS; s++) {
      const t = s / RIBBON_SEGS;
      const a = -arcHalf + arcHalf * 2 * t;
      const sa = Math.sin(a);
      const ca = Math.cos(a);
      const arch = Math.sin(t * Math.PI) * 0.14;
      attr.setXYZ(s * 2, sa * ri, 1.0 + arch, ca * ri);
      attr.setXYZ(s * 2 + 1, sa * ro, 1.32 + arch, ca * ro);
    }
    attr.needsUpdate = true;
    mesh.position.set(pos.x, pos.y, pos.z);
    mesh.rotation.y = yaw;
    mesh.visible = true;
    this.mats[slot].color.setHex(color).multiplyScalar(1.4);
    this.ttl[slot] = 0.22;
    this.life[slot] = 0.22;
  }

  update(dt: number): void {
    for (let i = 0; i < RIBBONS; i++) {
      if (!this.meshes[i].visible) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.meshes[i].visible = false;
        continue;
      }
      const frac = 1 - this.life[i] / this.ttl[i]; // 0 → 1 sweep
      const segs = Math.max(2, Math.ceil(frac * RIBBON_SEGS));
      this.meshes[i].geometry.setDrawRange(0, segs * 6);
      this.mats[i].opacity = 0.85 * Math.pow(this.life[i] / this.ttl[i], 1.2);
    }
  }

  dispose(): void {
    for (const m of this.meshes) m.geometry.dispose();
    for (const m of this.mats) m.dispose();
  }
}

// ── Telegraph decals ─────────────────────────────────────────────────────────
const DECAL_VERTEX = /* glsl */ `
varying vec2 vP;
void main() {
  vP = (uv - 0.5) * 2.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const DECAL_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uFill;
uniform float uAlpha;
uniform float uArcHalf;
uniform float uKind; // 0 ring, 1 arc, 2 rect
uniform float uTime;
varying vec2 vP;
void main() {
  float a = 0.0;
  float glow = 0.0;
  if (uKind < 1.5) {
    float r = length(vP);
    if (r > 1.0) discard;
    float edge = smoothstep(0.9, 0.965, r) * (1.0 - smoothstep(0.985, 1.0, r));
    float front = (1.0 - smoothstep(uFill - 0.035, uFill, r)) * smoothstep(uFill - 0.09, uFill - 0.02, r);
    float bands = 0.5 + 0.5 * sin((r - uTime * 0.9) * 28.0);
    float fill = (1.0 - smoothstep(uFill - 0.02, uFill, r)) * (0.18 + 0.14 * bands) * (0.4 + 0.6 * r);
    a = max(max(edge, fill), front * 0.9);
    glow = edge + front;
    if (uKind > 0.5) {
      float ang = abs(atan(vP.x, vP.y));
      float side = 1.0 - smoothstep(uArcHalf - 0.03, uArcHalf + 0.03, ang);
      float rim = (1.0 - smoothstep(0.0, 0.05, abs(ang - uArcHalf))) * step(0.12, r);
      a = max(a * side, rim * 0.85);
      glow = max(glow * side, rim);
    }
  } else {
    vec2 q = abs(vP);
    if (q.x > 1.0 || q.y > 1.0) discard;
    float edge = smoothstep(0.88, 0.95, max(q.x, q.y));
    float fwd = vP.y * 0.5 + 0.5;
    float chev = 0.5 + 0.5 * sin((fwd - q.x * 0.35 - uTime * 1.2) * 22.0);
    float fill = (1.0 - smoothstep(uFill - 0.03, uFill, fwd)) * (0.16 + 0.18 * chev);
    float front = (1.0 - smoothstep(uFill - 0.03, uFill, fwd)) * smoothstep(uFill - 0.08, uFill - 0.02, fwd);
    a = max(max(edge, fill), front * 0.9);
    glow = edge + front;
  }
  a *= uAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor * (1.0 + glow * 0.6), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

interface DecalState {
  windup: number;
  t: number;
  phase: 0 | 1 | 2; // fill / flash / fade
}

class DecalPool {
  readonly group = new THREE.Group();
  private readonly meshes: THREE.Mesh[] = [];
  private readonly mats: THREE.ShaderMaterial[] = [];
  private readonly states: DecalState[] = [];
  private readonly geometry: THREE.PlaneGeometry;
  private readonly time = { value: 0 };

  constructor() {
    this.geometry = new THREE.PlaneGeometry(2, 2);
    this.geometry.rotateX(Math.PI / 2); // lie flat; local +Z (uv.y=1) = forward
    for (let i = 0; i < DECALS; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(0xffffff) },
          uFill: { value: 0 },
          uAlpha: { value: 0 },
          uArcHalf: { value: Math.PI },
          uKind: { value: 0 },
          uTime: this.time,
        },
        vertexShader: DECAL_VERTEX,
        fragmentShader: DECAL_FRAGMENT,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      });
      const mesh = new THREE.Mesh(this.geometry, mat);
      mesh.visible = false;
      mesh.renderOrder = 2;
      this.group.add(mesh);
      this.meshes.push(mesh);
      this.mats.push(mat);
      this.states.push({ windup: 1, t: 0, phase: 0 });
    }
  }

  spawn(
    kind: TelegraphKind,
    pos: Vec3,
    radius: number,
    yaw: number,
    arcDeg: number,
    windup: number,
    friendly: boolean,
    width: number,
  ): void {
    let slot = 0;
    let best = Infinity;
    for (let i = 0; i < DECALS; i++) {
      if (!this.meshes[i].visible) {
        slot = i;
        best = -1;
        break;
      }
      const remain = this.states[i].windup - this.states[i].t;
      if (remain < best) {
        best = remain;
        slot = i;
      }
    }
    const mesh = this.meshes[slot];
    const mat = this.mats[slot];
    const st = this.states[slot];
    const kindIdx = kind === 'ring' ? 0 : kind === 'arc' ? 1 : 2;

    mesh.rotation.y = yaw;
    if (kind === 'rect') {
      // `radius` = forward length; extends from pos along yaw.
      const hl = radius / 2;
      mesh.scale.set(width / 2, 1, hl);
      mesh.position.set(pos.x + Math.sin(yaw) * hl, pos.y + 0.035, pos.z + Math.cos(yaw) * hl);
    } else {
      mesh.scale.set(radius, 1, radius);
      mesh.position.set(pos.x, pos.y + 0.035, pos.z);
    }
    mesh.visible = true;
    (mat.uniforms.uColor.value as THREE.Color).setHex(friendly ? COL_TELE_FRIEND : COL_TELE_ENEMY);
    mat.uniforms.uKind.value = kindIdx;
    mat.uniforms.uArcHalf.value = (Math.max(1, arcDeg) * DEG2RAD) / 2;
    mat.uniforms.uFill.value = 0;
    mat.uniforms.uAlpha.value = 0;
    st.windup = windup > 0.01 ? windup : 0.3;
    st.t = 0;
    st.phase = 0;
  }

  update(dt: number): void {
    this.time.value += dt;
    for (let i = 0; i < DECALS; i++) {
      const mesh = this.meshes[i];
      if (!mesh.visible) continue;
      const st = this.states[i];
      const mat = this.mats[i];
      st.t += dt;
      if (st.phase === 0) {
        mat.uniforms.uFill.value = clamp01(st.t / st.windup);
        mat.uniforms.uAlpha.value = Math.min(1, st.t / 0.1) * 0.85;
        if (st.t >= st.windup) {
          st.phase = 1;
          st.t = 0;
        }
      } else if (st.phase === 1) {
        mat.uniforms.uFill.value = 1;
        mat.uniforms.uAlpha.value = 1;
        if (st.t >= 0.1) {
          st.phase = 2;
          st.t = 0;
        }
      } else {
        mat.uniforms.uAlpha.value = 1 - clamp01(st.t / 0.18);
        if (st.t >= 0.18) mesh.visible = false;
      }
    }
  }

  dispose(): void {
    this.geometry.dispose();
    for (const m of this.mats) m.dispose();
  }
}

// ── Floating damage numbers (64 pooled canvas billboards) ────────────────────
type NumberStyle = 0 | 1 | 2; // normal | blocked | crit

class NumberPool {
  readonly group = new THREE.Group();
  private readonly sprites: THREE.Sprite[] = [];
  private readonly mats: THREE.SpriteMaterial[] = [];
  private readonly ctxs: CanvasRenderingContext2D[] = [];
  private readonly texs: THREE.CanvasTexture[] = [];
  private readonly life = new Float32Array(NUMBERS);
  private readonly ttl = new Float32Array(NUMBERS);
  private readonly baseScale = new Float32Array(NUMBERS);
  private readonly curScale = new Float32Array(NUMBERS);
  private readonly baseY = new Float32Array(NUMBERS);
  private readonly driftX = new Float32Array(NUMBERS);
  private readonly driftZ = new Float32Array(NUMBERS);
  private readonly originX = new Float32Array(NUMBERS);
  private readonly originZ = new Float32Array(NUMBERS);
  // Recent spawn ring buffer for stacking (x, z, time).
  private readonly recent = new Float32Array(16 * 3);
  private recentCursor = 0;
  private clock = 0;
  private cursor = 0;

  constructor() {
    for (let i = 0; i < NUMBERS; i++) {
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 80;
      const ctx = canvas.getContext('2d');
      if (ctx === null) throw new Error('2d canvas unavailable for damage numbers');
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.generateMipmaps = false;
      tex.minFilter = THREE.LinearFilter;
      const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        fog: false,
        toneMapped: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.renderOrder = 20;
      sprite.layers.set(OVERLAY_LAYER);
      // Screen-size cap: re-scale by camera distance right before drawing so
      // numbers keep a near-constant, capped on-screen size.
      const idx = i;
      sprite.onBeforeRender = (_r, _s, camera) => {
        const d = camera.position.distanceTo(sprite.position);
        const k = d / NUM_REF_DIST;
        const kk = k < 0.55 ? 0.55 : k > 1.7 ? 1.7 : k;
        const s = this.curScale[idx] * kk;
        sprite.scale.set(s * 2, s, 1);
        sprite.updateMatrixWorld();
      };
      this.group.add(sprite);
      this.sprites.push(sprite);
      this.mats.push(mat);
      this.ctxs.push(ctx);
      this.texs.push(tex);
    }
    this.recent.fill(-1e6);
  }

  spawn(pos: Vec3, value: number, style: NumberStyle): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % NUMBERS;
    const ctx = this.ctxs[i];
    ctx.clearRect(0, 0, 160, 80);
    const text = String(Math.max(0, Math.round(value)));
    const px = style === 2 ? 60 : style === 1 ? 46 : 54;
    ctx.font = `900 ${px}px Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 10;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = style === 2 ? '#6a1f0a' : style === 1 ? '#1e3a5f' : '#3c2410';
    ctx.strokeText(text, 80, 42);
    ctx.fillStyle = style === 2 ? '#ffd24a' : style === 1 ? '#bfe0ff' : '#fff4e0';
    ctx.fillText(text, 80, 42);
    this.texs[i].needsUpdate = true;

    // Stack above recent numbers near the same spot.
    let stack = 0;
    for (let k = 0; k < 16; k++) {
      const o = k * 3;
      if (this.clock - this.recent[o + 2] > NUM_STACK_WINDOW) continue;
      const dx = this.recent[o] - pos.x;
      const dz = this.recent[o + 1] - pos.z;
      if (dx * dx + dz * dz < NUM_STACK_RADIUS * NUM_STACK_RADIUS) stack++;
    }
    if (stack > 4) stack = 4;
    const ro = this.recentCursor * 3;
    this.recent[ro] = pos.x;
    this.recent[ro + 1] = pos.z;
    this.recent[ro + 2] = this.clock;
    this.recentCursor = (this.recentCursor + 1) % 16;

    // Size grows with damage (small hits small, finishers/ults bigger), capped.
    let s = NUM_MIN_SCALE + (NUM_MAX_SCALE - NUM_MIN_SCALE) * Math.min(1, value / 240);
    if (style === 2) s *= 1.22;
    else if (style === 1) s *= 0.85;
    if (s > NUM_MAX_SCALE) s = NUM_MAX_SCALE;

    // Random scatter; stacked numbers also alternate sides so they never blob.
    const side = stack === 0 ? 0 : stack % 2 === 1 ? 0.5 : -0.5;
    const ox = side + (Math.random() - 0.5) * 0.6;
    const oz = side * 0.5 + (Math.random() - 0.5) * 0.6;
    const sprite = this.sprites[i];
    this.originX[i] = pos.x + ox;
    this.originZ[i] = pos.z + oz;
    this.driftX[i] = ox * 0.6;
    this.driftZ[i] = oz * 0.6;
    this.baseY[i] = pos.y + 1.45 + stack * NUM_STACK_STEP;
    sprite.position.set(this.originX[i], this.baseY[i], this.originZ[i]);
    sprite.visible = true;
    this.mats[i].opacity = 1;
    this.baseScale[i] = s;
    this.curScale[i] = s * 0.5;
    this.ttl[i] = NUM_TTL;
    this.life[i] = NUM_TTL;
  }

  update(dt: number): void {
    this.clock += dt;
    for (let i = 0; i < NUMBERS; i++) {
      const sprite = this.sprites[i];
      if (!sprite.visible) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        sprite.visible = false;
        continue;
      }
      const age = 1 - this.life[i] / this.ttl[i];
      // Pop (overshoot) then settle.
      const pop = age < 0.12 ? age / 0.12 : 1;
      const over = age < 0.12 ? 1 + 0.25 * pop : 1 + 0.25 * Math.max(0, 1 - (age - 0.12) / 0.12);
      this.curScale[i] = this.baseScale[i] * (0.5 + 0.5 * pop) * over;
      // Upward drift that decelerates + slight sideways spread.
      const rise = 1 - (1 - age) * (1 - age);
      sprite.position.set(
        this.originX[i] + this.driftX[i] * rise,
        this.baseY[i] + rise * 1.05,
        this.originZ[i] + this.driftZ[i] * rise,
      );
      const frac = this.life[i] / this.ttl[i];
      this.mats[i].opacity = frac < 0.35 ? frac / 0.35 : 1;
    }
  }

  dispose(): void {
    for (const t of this.texs) t.dispose();
    for (const m of this.mats) m.dispose();
  }
}

// ── Radial flash sprites + expanding ground rings ────────────────────────────
function makeRadialTexture(ring: boolean): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    const g = ctx.createRadialGradient(64, 64, 2, 64, 64, 64);
    if (ring) {
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.62, 'rgba(255,255,255,0)');
      g.addColorStop(0.8, 'rgba(255,255,255,1)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
    } else {
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

class FlashPool {
  readonly group = new THREE.Group();
  private readonly sprites: THREE.Sprite[] = [];
  private readonly mats: THREE.SpriteMaterial[] = [];
  private readonly life: Float32Array;
  private readonly ttl: Float32Array;
  private readonly s0: Float32Array;
  private readonly s1: Float32Array;
  private readonly sy: Float32Array;
  private readonly a0: Float32Array;
  private readonly texture: THREE.CanvasTexture;
  private readonly n: number;
  private cursor = 0;

  constructor(n: number, ring: boolean) {
    this.n = n;
    this.life = new Float32Array(n);
    this.ttl = new Float32Array(n);
    this.s0 = new Float32Array(n);
    this.s1 = new Float32Array(n);
    this.sy = new Float32Array(n);
    this.a0 = new Float32Array(n);
    this.texture = makeRadialTexture(ring);
    for (let i = 0; i < n; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this.texture,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.renderOrder = 7;
      this.group.add(sprite);
      this.sprites.push(sprite);
      this.mats.push(mat);
    }
  }

  /** `boost` > 1 pushes the colour into HDR so the bloom pass catches it. */
  spawn(
    pos: Vec3, y: number, color: number,
    size0: number, size1: number, ttl: number,
    alpha: number, yStretch = 1, boost = 1,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.n;
    const sprite = this.sprites[i];
    sprite.position.set(pos.x, pos.y + y, pos.z);
    sprite.visible = true;
    this.mats[i].color.setHex(color).multiplyScalar(boost);
    this.mats[i].opacity = alpha;
    this.life[i] = ttl;
    this.ttl[i] = ttl;
    this.s0[i] = size0;
    this.s1[i] = size1;
    this.sy[i] = yStretch;
    this.a0[i] = alpha;
    sprite.scale.set(size0, size0 * yStretch, 1);
  }

  update(dt: number): void {
    for (let i = 0; i < this.n; i++) {
      const sprite = this.sprites[i];
      if (!sprite.visible) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        sprite.visible = false;
        continue;
      }
      const age = 1 - this.life[i] / this.ttl[i];
      const e = 1 - (1 - age) * (1 - age);
      const s = this.s0[i] + (this.s1[i] - this.s0[i]) * e;
      sprite.scale.set(s, s * this.sy[i], 1);
      this.mats[i].opacity = this.a0[i] * (1 - age);
    }
  }

  dispose(): void {
    this.texture.dispose();
    for (const m of this.mats) m.dispose();
  }
}

class RingPool {
  readonly group = new THREE.Group();
  private readonly meshes: THREE.Mesh[] = [];
  private readonly mats: THREE.MeshBasicMaterial[] = [];
  private readonly life = new Float32Array(RINGS);
  private readonly ttl = new Float32Array(RINGS);
  private readonly s0 = new Float32Array(RINGS);
  private readonly s1 = new Float32Array(RINGS);
  private readonly a0 = new Float32Array(RINGS);
  private readonly geometry: THREE.RingGeometry;
  private cursor = 0;

  constructor() {
    this.geometry = new THREE.RingGeometry(0.8, 1, 48);
    this.geometry.rotateX(-Math.PI / 2);
    for (let i = 0; i < RINGS; i++) {
      const mat = new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        fog: false,
      });
      const mesh = new THREE.Mesh(this.geometry, mat);
      mesh.visible = false;
      mesh.renderOrder = 3;
      this.group.add(mesh);
      this.meshes.push(mesh);
      this.mats.push(mat);
    }
  }

  spawn(pos: Vec3, color: number, size0: number, size1: number, ttl: number, boost = 1, alpha = 0.9): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % RINGS;
    const mesh = this.meshes[i];
    mesh.position.set(pos.x, pos.y + 0.06, pos.z);
    mesh.scale.set(size0, 1, size0);
    mesh.visible = true;
    this.mats[i].color.setHex(color).multiplyScalar(boost);
    this.mats[i].opacity = alpha;
    this.life[i] = ttl;
    this.ttl[i] = ttl;
    this.s0[i] = size0;
    this.s1[i] = size1;
    this.a0[i] = alpha;
  }

  update(dt: number): void {
    for (let i = 0; i < RINGS; i++) {
      const mesh = this.meshes[i];
      if (!mesh.visible) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        mesh.visible = false;
        continue;
      }
      const age = 1 - this.life[i] / this.ttl[i];
      const e = 1 - (1 - age) * (1 - age);
      const s = this.s0[i] + (this.s1[i] - this.s0[i]) * e;
      mesh.scale.set(s, 1, s);
      this.mats[i].opacity = this.a0[i] * (1 - age);
    }
  }

  dispose(): void {
    this.geometry.dispose();
    for (const m of this.mats) m.dispose();
  }
}

// ── Ground cracks (slams) ────────────────────────────────────────────────────
function makeCrackTexture(): THREE.CanvasTexture {
  const S = 256;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    const c = S / 2;
    const g = ctx.createRadialGradient(c, c, 4, c, c, c);
    g.addColorStop(0, 'rgba(40,24,12,0.75)');
    g.addColorStop(0.35, 'rgba(70,46,24,0.35)');
    g.addColorStop(1, 'rgba(70,46,24,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    ctx.strokeStyle = 'rgba(28,16,8,0.95)';
    ctx.lineCap = 'round';
    let seed = 7;
    const rnd = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 11; i++) {
      let a = (i / 11) * Math.PI * 2 + rnd() * 0.4;
      let x = c + Math.cos(a) * 10;
      let y = c + Math.sin(a) * 10;
      let w = 5;
      ctx.beginPath();
      ctx.moveTo(x, y);
      const steps = 6 + Math.floor(rnd() * 4);
      for (let s = 0; s < steps; s++) {
        a += (rnd() - 0.5) * 0.7;
        const len = 9 + rnd() * 10;
        x += Math.cos(a) * len;
        y += Math.sin(a) * len;
        ctx.lineWidth = w;
        ctx.lineTo(x, y);
        w = Math.max(1, w * 0.8);
        if (Math.hypot(x - c, y - c) > c * 0.92) break;
      }
      ctx.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

class CrackPool {
  readonly group = new THREE.Group();
  private readonly meshes: THREE.Mesh[] = [];
  private readonly mats: THREE.MeshBasicMaterial[] = [];
  private readonly life = new Float32Array(CRACKS);
  private readonly geometry: THREE.PlaneGeometry;
  private readonly texture: THREE.CanvasTexture;
  private cursor = 0;

  constructor() {
    this.geometry = new THREE.PlaneGeometry(2, 2);
    this.geometry.rotateX(-Math.PI / 2);
    this.texture = makeCrackTexture();
    for (let i = 0; i < CRACKS; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
      });
      const mesh = new THREE.Mesh(this.geometry, mat);
      mesh.visible = false;
      mesh.renderOrder = 1;
      this.group.add(mesh);
      this.meshes.push(mesh);
      this.mats.push(mat);
    }
  }

  spawn(x: number, y: number, z: number, radius: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % CRACKS;
    const m = this.meshes[i];
    m.position.set(x, y + 0.025, z);
    m.rotation.y = Math.random() * TAU;
    m.scale.set(radius, 1, radius);
    m.visible = true;
    this.mats[i].opacity = 1;
    this.life[i] = 3;
  }

  update(dt: number): void {
    for (let i = 0; i < CRACKS; i++) {
      const m = this.meshes[i];
      if (!m.visible) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        m.visible = false;
        continue;
      }
      this.mats[i].opacity = this.life[i] < 1 ? this.life[i] : 1;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.texture.dispose();
    for (const m of this.mats) m.dispose();
  }
}

// ── Ult aura light columns ───────────────────────────────────────────────────
const COLUMN_VERTEX = /* glsl */ `
varying float vAlong;
varying float vFacing;
void main() {
  vAlong = uv.y;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  vFacing = abs(dot(n, normalize(-mv.xyz)));
  gl_Position = projectionMatrix * mv;
}
`;

const COLUMN_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uTime;
varying float vAlong;
varying float vFacing;
void main() {
  float a = pow(vFacing, 1.4) * pow(1.0 - vAlong, 1.6) * uAlpha;
  a *= 0.8 + 0.2 * sin(vAlong * 18.0 - uTime * 10.0);
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

class ColumnPool {
  readonly group = new THREE.Group();
  private readonly meshes: THREE.Mesh[] = [];
  private readonly mats: THREE.ShaderMaterial[] = [];
  private readonly life = new Float32Array(COLUMNS);
  private readonly geometry: THREE.CylinderGeometry;
  private readonly time = { value: 0 };
  private cursor = 0;

  constructor() {
    this.geometry = new THREE.CylinderGeometry(1, 1.15, 1, 20, 1, true);
    this.geometry.translate(0, 0.5, 0);
    for (let i = 0; i < COLUMNS; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color() }, uAlpha: { value: 0 }, uTime: this.time },
        vertexShader: COLUMN_VERTEX,
        fragmentShader: COLUMN_FRAGMENT,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        fog: false,
      });
      const mesh = new THREE.Mesh(this.geometry, mat);
      mesh.visible = false;
      mesh.renderOrder = 7;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.meshes.push(mesh);
      this.mats.push(mat);
    }
  }

  spawn(pos: Vec3, color: THREE.Color): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % COLUMNS;
    const m = this.meshes[i];
    m.position.set(pos.x, pos.y, pos.z);
    m.scale.set(0.5, 9, 0.5);
    m.visible = true;
    (this.mats[i].uniforms.uColor.value as THREE.Color).copy(color).multiplyScalar(2.6);
    this.life[i] = 0;
  }

  update(dt: number): void {
    this.time.value += dt;
    for (let i = 0; i < COLUMNS; i++) {
      const m = this.meshes[i];
      if (!m.visible) continue;
      this.life[i] += dt;
      const t = this.life[i];
      if (t >= 1.3) {
        m.visible = false;
        continue;
      }
      const grow = t < 0.15 ? t / 0.15 : 1;
      const r = 0.5 + 0.9 * grow;
      m.scale.set(r, 9 * (0.6 + 0.4 * grow), r);
      this.mats[i].uniforms.uAlpha.value = (t < 0.12 ? t / 0.12 : 1 - (t - 0.12) / 1.18) * 0.9;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    for (const m of this.mats) m.dispose();
  }
}

// ── Effects facade ───────────────────────────────────────────────────────────
export class Effects implements FxSink {
  private readonly scene: THREE.Scene;
  private readonly additive: ParticlePool;
  private readonly soft: ParticlePool;
  private readonly ribbons = new RibbonPool();
  private readonly decals = new DecalPool();
  private readonly numbers = new NumberPool();
  private readonly flashes = new FlashPool(FLASHES, false);
  private readonly impactRings = new FlashPool(IMPACT_RINGS, true);
  private readonly rings = new RingPool();
  private readonly cracks = new CrackPool();
  private readonly columns = new ColumnPool();

  private readonly pointScale: { value: number };
  private readonly fovDeg: number;
  private shake = 0;

  private readonly handleResize = (): void => {
    this.pointScale.value =
      (window.innerHeight * Math.min(2, window.devicePixelRatio || 1)) / (2 * Math.tan((this.fovDeg * DEG2RAD) / 2));
  };

  constructor(scene: THREE.Scene, options: { fovDeg?: number } = {}) {
    this.scene = scene;
    this.fovDeg = options.fovDeg ?? 55;
    this.pointScale = { value: 1 };
    this.handleResize();
    window.addEventListener('resize', this.handleResize);

    this.additive = new ParticlePool(MAX_ADDITIVE, true, this.pointScale);
    this.soft = new ParticlePool(MAX_SOFT, false, this.pointScale);
    scene.add(this.additive.points);
    scene.add(this.soft.points);
    scene.add(this.ribbons.group);
    scene.add(this.decals.group);
    scene.add(this.numbers.group);
    scene.add(this.flashes.group);
    scene.add(this.impactRings.group);
    scene.add(this.rings.group);
    scene.add(this.cracks.group);
    scene.add(this.columns.group);
    // Animal rigs report footfalls / slams here (render/fxBus).
    setFxSink(this);
  }

  /** Advance every pool; call once per rendered frame. */
  update(dt: number): void {
    this.additive.update(dt);
    this.soft.update(dt);
    this.ribbons.update(dt);
    this.decals.update(dt);
    this.numbers.update(dt);
    this.flashes.update(dt);
    this.impactRings.update(dt);
    this.rings.update(dt);
    this.cracks.update(dt);
    this.columns.update(dt);
    this.shake *= Math.exp(-dt / SHAKE_TAU);
    if (this.shake < 0.0004) this.shake = 0;
  }

  // ── Event-shaped API (WP-I pipes GameEvents straight in) ──────────────────

  /** Swing arc ribbon trail at the attacker (`friendly` = player gold). */
  onSwing(pos: Vec3, yaw: number, range: number, arcDeg: number, friendly = false): void {
    this.ribbons.spawn(pos, yaw, range, arcDeg, friendly ? 0xffd786 : 0xffe8d8);
  }

  /**
   * Landed hit: sparks + impact ring + floating damage number.
   * `blocked` → blue-white sparks; `crit` → finisher/ult styling + more kick.
   */
  onHit(pos: Vec3, damage: number, options: HitOptions = {}): void {
    const blocked = options.blocked === true;
    const crit = options.crit === true;
    const fx = tierProfile().fxScale;
    const n = Math.round((blocked ? 10 : crit ? 26 : 14) * fx);
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * TAU;
      const up = Math.random();
      const sp = 3.5 + Math.random() * 5.5;
      const cr = Math.random();
      let r: number;
      let g: number;
      let b: number;
      if (blocked) {
        r = 0.75 + cr * 0.25;
        g = 0.85 + cr * 0.15;
        b = 1;
      } else {
        r = 1;
        g = 0.34 + cr * 0.5;
        b = 0.08 + cr * 0.14;
      }
      this.additive.spawn(
        pos.x, pos.y + 1.0, pos.z,
        Math.cos(ang) * sp, 1.5 + up * 4.5, Math.sin(ang) * sp,
        0.28 + Math.random() * 0.24, 0.12 + Math.random() * 0.06, 0.03,
        r, g, b, 0.95, -20, 2.6,
      );
    }
    this.numbers.spawn(pos, damage, blocked ? 1 : crit ? 2 : 0);
    if (!blocked) {
      this.flashes.spawn(pos, 1.0, crit ? 0xffb347 : 0xff7a3c, 0.25, crit ? 1.5 : 0.95, 0.14, crit ? 0.75 : 0.55, 1, crit ? 1.3 : 1);
      this.impactRings.spawn(pos, 1.0, crit ? 0xffd070 : 0xffa060, 0.3, crit ? 2.2 : 1.4, 0.2, crit ? 0.7 : 0.5, 1, 1);
    } else {
      this.impactRings.spawn(pos, 1.0, 0x9cc8ff, 0.3, 1.2, 0.18, 0.55, 1, 1);
    }
    this.addShake(blocked ? 0.015 : crit ? 0.07 : 0.03);
    if (crit) kickFov(1.6);
  }

  /** Guard-break shatter: blue-white shard burst + shockwave ring. */
  onGuardBreak(pos: Vec3): void {
    for (let i = 0; i < 34; i++) {
      const ang = Math.random() * TAU;
      const sp = 3 + Math.random() * 6;
      const c = 0.8 + Math.random() * 0.2;
      this.additive.spawn(
        pos.x, pos.y + 1.1, pos.z,
        Math.cos(ang) * sp, 2 + Math.random() * 4.5, Math.sin(ang) * sp,
        0.5 + Math.random() * 0.3, 0.2 + Math.random() * 0.1, 0.05,
        c * 0.85, c * 0.95, 1, 0.95, -14, 1.8,
      );
    }
    this.rings.spawn(pos, 0x9cc8ff, 0.5, 4.2, 0.4, 1.4);
    this.impactRings.spawn(pos, 1.1, 0xbfe0ff, 0.6, 3.0, 0.3, 0.75, 1, 1.2);
    this.flashes.spawn(pos, 1.1, 0xbfe0ff, 0.8, 2.2, 0.2, 0.8, 1, 1.2);
    this.addShake(0.06);
  }

  /** Dust puff (footsteps, landings, burrow, crate breaks). */
  onDust(pos: Vec3, scale = 1): void {
    const n = Math.min(12, Math.round(9 * scale * tierProfile().fxScale));
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * TAU;
      const sp = (0.8 + Math.random() * 1.4) * scale;
      this.soft.spawn(
        pos.x, pos.y + 0.15, pos.z,
        Math.cos(ang) * sp, 0.7 + Math.random() * 1.2, Math.sin(ang) * sp,
        0.7 + Math.random() * 0.45, 0.35 * scale, 0.95 * scale,
        0.79, 0.66, 0.44, 0.34, -1.2, 2.2,
      );
    }
  }

  /** Death burst + celebratory crowd streamers from the stands rim. */
  onDeath(pos: Vec3, accent: THREE.ColorRepresentation = 0x8f2118): void {
    _c.set(accent);
    for (let i = 0; i < 26; i++) {
      const ang = Math.random() * TAU;
      const sp = 2.5 + Math.random() * 4.5;
      const shadeV = 0.55 + Math.random() * 0.45;
      this.additive.spawn(
        pos.x, pos.y + 0.9, pos.z,
        Math.cos(ang) * sp, 1 + Math.random() * 4, Math.sin(ang) * sp,
        0.5 + Math.random() * 0.3, 0.16, 0.05,
        Math.min(1, _c.r * shadeV + 0.25), _c.g * shadeV, _c.b * shadeV, 0.9, -16, 2.0,
      );
    }
    this.rings.spawn(pos, 0xc8402f, 0.5, 3.4, 0.45, 1.3);
    this.onDust(pos, 1.3);
    // Streamers: thrown from the stands toward the arena, fluttering down.
    for (let i = 0; i < 46; i++) {
      const ang = Math.random() * TAU;
      const r = STANDS_INNER + 0.5 + Math.random() * 8;
      const x = Math.cos(ang) * r;
      const z = Math.sin(ang) * r;
      const inX = -Math.cos(ang);
      const inZ = -Math.sin(ang);
      const sp = 2 + Math.random() * 2.5;
      const ci = Math.floor(Math.random() * 4);
      const cr = ci === 0 ? 0.95 : ci === 1 ? 0.85 : ci === 2 ? 0.45 : 0.95;
      const cg = ci === 0 ? 0.75 : ci === 1 ? 0.25 : ci === 2 ? 0.7 : 0.93;
      const cb = ci === 0 ? 0.25 : ci === 1 ? 0.2 : ci === 2 ? 0.75 : 0.88;
      this.soft.spawn(
        x, 6 + Math.random() * 5, z,
        inX * sp, 1.5 + Math.random() * 2, inZ * sp,
        2.2 + Math.random() * 0.8, 0.2, 0.1,
        cr, cg, cb, 0.85, -3.2, 0.6,
      );
    }
    this.addShake(0.05);
  }

  /** Ultimate activation: accent flash, blooming light column, ground aura. */
  onUltimate(pos: Vec3, animal: AnimalId): void {
    _c.set(ANIMALS[animal].accent);
    const hex = _c.getHex();
    this.flashes.spawn(pos, 1.2, hex, 1.5, 7, 0.45, 0.8, 1, 1.5);
    this.columns.spawn(pos, _c);
    this.rings.spawn(pos, hex, 0.8, 9, 0.6, 2.0);
    this.rings.spawn(pos, 0xfff0d0, 0.4, 3.5, 0.9, 1.4, 0.6);
    this.impactRings.spawn(pos, 1.0, hex, 1, 6, 0.5, 0.7, 1, 1.5);
    const n = Math.round(30 * tierProfile().fxScale);
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * TAU;
      const sp = 1 + Math.random() * 2.5;
      this.additive.spawn(
        pos.x + Math.cos(ang) * 0.6, pos.y + 0.3, pos.z + Math.sin(ang) * 0.6,
        Math.cos(ang) * sp, 3 + Math.random() * 5, Math.sin(ang) * sp,
        0.6 + Math.random() * 0.4, 0.2, 0.06,
        Math.min(1, _c.r + 0.3), Math.min(1, _c.g + 0.3), Math.min(1, _c.b + 0.3),
        0.95, -3, 1.2,
      );
    }
    this.addShake(0.1);
    kickFov(4.5);
  }

  /**
   * Telegraph ground decal (§11.4): ring / arc sector / rect, red for enemies,
   * gold for the player; the fill animates over `windup` seconds then flashes.
   * For `rect`, `radius` is the forward length and `width` the lateral size.
   */
  telegraph(
    kind: TelegraphKind,
    pos: Vec3,
    radius: number,
    yaw: number,
    arcDeg: number,
    windup: number,
    friendly: boolean,
    width = 2.6,
  ): void {
    this.decals.spawn(kind, pos, radius, yaw, arcDeg, windup, friendly, width);
  }

  /** Add screenshake amplitude (m); total clamped to ≤0.15 (§11.4). */
  addShake(amount: number): void {
    this.shake = Math.min(SHAKE_MAX, this.shake + amount);
  }

  /** Current shake offset for the CameraRig (wire to `CameraRig.shakeSource`). */
  getShakeOffset(): number {
    return this.shake;
  }

  /** Live particle count across both pools (budget: ≤500). */
  get liveParticles(): number {
    return this.additive.count + this.soft.count;
  }

  // ── FxSink (animal rigs → render/fxBus) ───────────────────────────────────

  footstep(source: THREE.Object3D, x: number, z: number, scale: number): void {
    if (source.parent !== this.scene) return;
    const n = scale > 0.8 ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * TAU;
      const sp = 0.3 + Math.random() * 0.5;
      this.soft.spawn(
        x + Math.cos(ang) * 0.2, 0.08, z + Math.sin(ang) * 0.2,
        Math.cos(ang) * sp, 0.25 + Math.random() * 0.4, Math.sin(ang) * sp,
        0.55 + Math.random() * 0.3, 0.2 * scale, 0.6 * scale,
        0.8, 0.67, 0.46, 0.22, -0.6, 2.5,
      );
    }
  }

  land(source: THREE.Object3D, x: number, z: number, scale: number): void {
    if (source.parent !== this.scene) return;
    this.dustRing(x, z, scale * 1.2, 10);
  }

  slam(source: THREE.Object3D, x: number, z: number, radius: number, color: number, kind: SlamKind): void {
    if (source.parent !== this.scene) return;
    if (kind === 'crack') this.cracks.spawn(x, 0, z, radius * 0.85);
    this.dustRing(x, z, radius, kind === 'crack' ? 16 : 12);
    _v.set(x, 0, z);
    this.rings.spawn(_v, color, radius * 0.3, radius * 1.15, 0.45, 1.3, 0.75);
    // Grit chunks.
    if (kind === 'crack') {
      for (let i = 0; i < 8; i++) {
        const ang = Math.random() * TAU;
        const sp = 1.5 + Math.random() * 2.5;
        this.soft.spawn(
          x, 0.1, z,
          Math.cos(ang) * sp, 3 + Math.random() * 3, Math.sin(ang) * sp,
          0.7, 0.12, 0.1,
          0.36, 0.26, 0.16, 0.9, -16, 0.5,
        );
      }
      this.addShake(0.05);
      kickFov(1.2);
    }
  }

  private dustRing(x: number, z: number, radius: number, count: number): void {
    const n = Math.max(4, Math.round(count * tierProfile().fxScale));
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * TAU + Math.random() * 0.3;
      const sp = (1.2 + Math.random() * 0.8) * Math.max(0.6, radius);
      this.soft.spawn(
        x + Math.cos(ang) * 0.3, 0.12, z + Math.sin(ang) * 0.3,
        Math.cos(ang) * sp, 0.4 + Math.random() * 0.6, Math.sin(ang) * sp,
        0.8 + Math.random() * 0.4, 0.4, 1.2 + radius * 0.2,
        0.79, 0.66, 0.44, 0.38, -0.8, 3.2,
      );
    }
  }

  dispose(): void {
    if (getFxSink() === this) setFxSink(null);
    window.removeEventListener('resize', this.handleResize);
    this.scene.remove(this.additive.points, this.soft.points);
    this.scene.remove(
      this.ribbons.group,
      this.decals.group,
      this.numbers.group,
      this.flashes.group,
      this.impactRings.group,
      this.rings.group,
      this.cracks.group,
      this.columns.group,
    );
    this.additive.dispose();
    this.soft.dispose();
    this.ribbons.dispose();
    this.decals.dispose();
    this.numbers.dispose();
    this.flashes.dispose();
    this.impactRings.dispose();
    this.rings.dispose();
    this.cracks.dispose();
    this.columns.dispose();
  }
}
