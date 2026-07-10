/**
 * Effects (BLUEPRINT §11.4) — pooled, allocation-free-after-init combat FX.
 *
 * Systems: swing arc ribbon trails, hit sparks (red-orange) vs blocked sparks
 * (blue-white), guard-break shatter, dust puffs, telegraph ground decals
 * (ring / arc sector / rect; red enemy / gold player; radial fill animates
 * over the windup), floating damage numbers (64 pooled canvas-texture
 * billboards, crit style), death burst + crowd streamers, ult flash tinted per
 * animal accent, and a screenshake offset the CameraRig applies (≤0.15 m).
 *
 * Public API is event-shaped so WP-I can pipe GameEvents straight in
 * (positions are plain `Vec3` from core/types).
 *
 * Budgets: ≤500 live particles (two pools totalling 500); typical draw calls
 * ≤ 2 (points) + visible ribbons/decals/numbers/flashes.
 */

import * as THREE from 'three';
import type { AnimalId, Vec3 } from '../core/types';
import { ANIMALS } from '../config/animals';
import { DEG2RAD, TAU, clamp01 } from '../core/math';
import { STANDS_INNER } from '../config/arena';

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
const FLASHES = 6;
const RINGS = 6;
const SHAKE_MAX = 0.15;
const SHAKE_TAU = 0.16;

const COL_TELE_ENEMY = 0xff3b2f;
const COL_TELE_FRIEND = 0xffc93c;

const _c = new THREE.Color();

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
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  float a = vAlpha * smoothstep(1.0, 0.35, d);
  if (a < 0.012) discard;
  gl_FragColor = vec4(vColor, a);
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
      uniforms: { uPointScale: pointScale },
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
      this.aPos.setXYZ(
        i,
        this.aPos.getX(i) + this.vel[o] * dt,
        this.aPos.getY(i) + this.vel[o + 1] * dt,
        this.aPos.getZ(i) + this.vel[o + 2] * dt,
      );
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
    this.mats[slot].color.setHex(color);
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
varying vec2 vP;
void main() {
  float a = 0.0;
  if (uKind < 1.5) {
    float r = length(vP);
    if (r > 1.0) discard;
    float edge = smoothstep(0.90, 0.965, r) * (1.0 - smoothstep(0.985, 1.0, r));
    float fill = (1.0 - smoothstep(uFill - 0.04, uFill, r)) * 0.38;
    a = max(edge, fill);
    if (uKind > 0.5) {
      float ang = abs(atan(vP.x, vP.y));
      a *= 1.0 - smoothstep(uArcHalf - 0.03, uArcHalf + 0.03, ang);
    }
  } else {
    vec2 q = abs(vP);
    if (q.x > 1.0 || q.y > 1.0) discard;
    float edge = smoothstep(0.88, 0.95, max(q.x, q.y));
    float fwd = vP.y * 0.5 + 0.5;
    float fill = (1.0 - smoothstep(uFill - 0.03, uFill, fwd)) * 0.38;
    a = max(edge, fill);
  }
  a *= uAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a);
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
        },
        vertexShader: DECAL_VERTEX,
        fragmentShader: DECAL_FRAGMENT,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
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
      mesh.position.set(pos.x + Math.sin(yaw) * hl, 0.03, pos.z + Math.cos(yaw) * hl);
    } else {
      mesh.scale.set(radius, 1, radius);
      mesh.position.set(pos.x, 0.03, pos.z);
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
  private readonly baseY = new Float32Array(NUMBERS);
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
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.renderOrder = 20;
      this.group.add(sprite);
      this.sprites.push(sprite);
      this.mats.push(mat);
      this.ctxs.push(ctx);
      this.texs.push(tex);
    }
  }

  spawn(pos: Vec3, value: number, style: NumberStyle): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % NUMBERS;
    const ctx = this.ctxs[i];
    ctx.clearRect(0, 0, 160, 80);
    const text = String(Math.max(0, Math.round(value)));
    const px = style === 2 ? 56 : style === 1 ? 40 : 46;
    ctx.font = `900 ${px}px Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 9;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = style === 2 ? '#7a2a12' : style === 1 ? '#1e3a5f' : '#3c2410';
    ctx.strokeText(text, 80, 42);
    ctx.fillStyle = style === 2 ? '#ffd75e' : style === 1 ? '#bfe0ff' : '#fff4e0';
    ctx.fillText(text, 80, 42);
    this.texs[i].needsUpdate = true;

    const sprite = this.sprites[i];
    sprite.position.set(pos.x, pos.y + 0.4, pos.z);
    sprite.visible = true;
    this.mats[i].opacity = 1;
    this.baseScale[i] = style === 2 ? 1.5 : 1.05;
    this.baseY[i] = pos.y + 0.4;
    this.ttl[i] = 0.95;
    this.life[i] = 0.95;
    sprite.scale.set(0.01, 0.005, 1);
  }

  update(dt: number): void {
    for (let i = 0; i < NUMBERS; i++) {
      const sprite = this.sprites[i];
      if (!sprite.visible) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        sprite.visible = false;
        continue;
      }
      const age = 1 - this.life[i] / this.ttl[i];
      const pop = Math.min(1, age * 7);
      const s = this.baseScale[i] * (0.55 + 0.45 * pop);
      sprite.scale.set(s * 2, s, 1);
      sprite.position.y = this.baseY[i] + age * 1.15;
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
function makeRadialTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    const g = ctx.createRadialGradient(64, 64, 2, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
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
  private readonly life = new Float32Array(FLASHES);
  private readonly ttl = new Float32Array(FLASHES);
  private readonly s0 = new Float32Array(FLASHES);
  private readonly s1 = new Float32Array(FLASHES);
  private readonly sy = new Float32Array(FLASHES);
  private readonly a0 = new Float32Array(FLASHES);
  private readonly texture: THREE.CanvasTexture;
  private cursor = 0;

  constructor() {
    this.texture = makeRadialTexture();
    for (let i = 0; i < FLASHES; i++) {
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

  spawn(
    pos: Vec3, y: number, color: number,
    size0: number, size1: number, ttl: number,
    alpha: number, yStretch = 1,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % FLASHES;
    const sprite = this.sprites[i];
    sprite.position.set(pos.x, pos.y + y, pos.z);
    sprite.visible = true;
    this.mats[i].color.setHex(color);
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
    for (let i = 0; i < FLASHES; i++) {
      const sprite = this.sprites[i];
      if (!sprite.visible) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        sprite.visible = false;
        continue;
      }
      const age = 1 - this.life[i] / this.ttl[i];
      const s = this.s0[i] + (this.s1[i] - this.s0[i]) * age;
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
  private readonly geometry: THREE.RingGeometry;
  private cursor = 0;

  constructor() {
    this.geometry = new THREE.RingGeometry(0.78, 1, 36);
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

  spawn(pos: Vec3, color: number, size0: number, size1: number, ttl: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % RINGS;
    const mesh = this.meshes[i];
    mesh.position.set(pos.x, 0.05, pos.z);
    mesh.scale.set(size0, 1, size0);
    mesh.visible = true;
    this.mats[i].color.setHex(color);
    this.mats[i].opacity = 0.9;
    this.life[i] = ttl;
    this.ttl[i] = ttl;
    this.s0[i] = size0;
    this.s1[i] = size1;
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
      const s = this.s0[i] + (this.s1[i] - this.s0[i]) * age;
      mesh.scale.set(s, 1, s);
      this.mats[i].opacity = 0.9 * (1 - age);
    }
  }

  dispose(): void {
    this.geometry.dispose();
    for (const m of this.mats) m.dispose();
  }
}

// ── Effects facade ───────────────────────────────────────────────────────────
export class Effects {
  private readonly scene: THREE.Scene;
  private readonly additive: ParticlePool;
  private readonly soft: ParticlePool;
  private readonly ribbons = new RibbonPool();
  private readonly decals = new DecalPool();
  private readonly numbers = new NumberPool();
  private readonly flashes = new FlashPool();
  private readonly rings = new RingPool();

  private readonly pointScale: { value: number };
  private readonly fovDeg: number;
  private shake = 0;

  private readonly handleResize = (): void => {
    this.pointScale.value =
      window.innerHeight / (2 * Math.tan((this.fovDeg * DEG2RAD) / 2));
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
    scene.add(this.rings.group);
  }

  /** Advance every pool; call once per rendered frame. */
  update(dt: number): void {
    this.additive.update(dt);
    this.soft.update(dt);
    this.ribbons.update(dt);
    this.decals.update(dt);
    this.numbers.update(dt);
    this.flashes.update(dt);
    this.rings.update(dt);
    this.shake *= Math.exp(-dt / SHAKE_TAU);
    if (this.shake < 0.0004) this.shake = 0;
  }

  // ── Event-shaped API (WP-I pipes GameEvents straight in) ──────────────────

  /** Swing arc ribbon trail at the attacker (`friendly` = player gold). */
  onSwing(pos: Vec3, yaw: number, range: number, arcDeg: number, friendly = false): void {
    this.ribbons.spawn(pos, yaw, range, arcDeg, friendly ? 0xffd786 : 0xffe8d8);
  }

  /**
   * Landed hit: sparks + floating damage number.
   * `blocked` → blue-white sparks; `crit` → finisher/ult styling + more kick.
   */
  onHit(pos: Vec3, damage: number, options: HitOptions = {}): void {
    const blocked = options.blocked === true;
    const crit = options.crit === true;
    const n = blocked ? 10 : crit ? 26 : 14;
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * TAU;
      const up = Math.random();
      const sp = 3.5 + Math.random() * 5;
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
        g = 0.3 + cr * 0.45;
        b = 0.08 + cr * 0.12;
      }
      this.additive.spawn(
        pos.x, pos.y + 1.0, pos.z,
        Math.cos(ang) * sp, 1.5 + up * 4.5, Math.sin(ang) * sp,
        0.3 + Math.random() * 0.22, 0.15, 0.05,
        r, g, b, 0.95, -20, 2.6,
      );
    }
    this.numbers.spawn(pos, damage, blocked ? 1 : crit ? 2 : 0);
    if (!blocked) this.flashes.spawn(pos, 1.0, crit ? 0xffb347 : 0xff7a3c, 0.4, crit ? 2.2 : 1.4, 0.18, 0.9);
    this.addShake(blocked ? 0.015 : crit ? 0.07 : 0.03);
  }

  /** Guard-break shatter: blue-white shard burst + shockwave ring. */
  onGuardBreak(pos: Vec3): void {
    for (let i = 0; i < 28; i++) {
      const ang = Math.random() * TAU;
      const sp = 3 + Math.random() * 5.5;
      const c = 0.8 + Math.random() * 0.2;
      this.additive.spawn(
        pos.x, pos.y + 1.1, pos.z,
        Math.cos(ang) * sp, 2 + Math.random() * 4, Math.sin(ang) * sp,
        0.45 + Math.random() * 0.25, 0.17, 0.06,
        c * 0.85, c * 0.95, 1, 0.95, -14, 1.8,
      );
    }
    this.rings.spawn(pos, 0x9cc8ff, 0.5, 4.2, 0.4);
    this.flashes.spawn(pos, 1.1, 0xbfe0ff, 0.8, 2.6, 0.22, 0.95);
    this.addShake(0.06);
  }

  /** Dust puff (footsteps, landings, burrow, crate breaks). */
  onDust(pos: Vec3, scale = 1): void {
    const n = Math.min(12, Math.round(9 * scale));
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
      const shade = 0.55 + Math.random() * 0.45;
      this.additive.spawn(
        pos.x, pos.y + 0.9, pos.z,
        Math.cos(ang) * sp, 1 + Math.random() * 4, Math.sin(ang) * sp,
        0.5 + Math.random() * 0.3, 0.16, 0.05,
        Math.min(1, _c.r * shade + 0.25), _c.g * shade, _c.b * shade, 0.9, -16, 2.0,
      );
    }
    this.rings.spawn(pos, 0xc8402f, 0.5, 3.4, 0.45);
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

  /** Ultimate activation flash, tinted with the animal's accent color (§8). */
  onUltimate(pos: Vec3, animal: AnimalId): void {
    _c.set(ANIMALS[animal].accent);
    const hex = _c.getHex();
    this.flashes.spawn(pos, 1.2, hex, 1.5, 8.5, 0.45, 1);
    this.flashes.spawn(pos, 3.2, hex, 1.2, 2.2, 0.5, 0.8, 5); // light column
    this.rings.spawn(pos, hex, 0.8, 9, 0.55);
    for (let i = 0; i < 22; i++) {
      const ang = Math.random() * TAU;
      const sp = 1 + Math.random() * 2.5;
      this.additive.spawn(
        pos.x + Math.cos(ang) * 0.5, pos.y + 0.3, pos.z + Math.sin(ang) * 0.5,
        Math.cos(ang) * sp, 3 + Math.random() * 5, Math.sin(ang) * sp,
        0.5 + Math.random() * 0.35, 0.18, 0.06,
        Math.min(1, _c.r + 0.25), Math.min(1, _c.g + 0.25), Math.min(1, _c.b + 0.25),
        0.95, -4, 1.2,
      );
    }
    this.addShake(0.1);
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

  dispose(): void {
    window.removeEventListener('resize', this.handleResize);
    this.scene.remove(this.additive.points, this.soft.points);
    this.scene.remove(
      this.ribbons.group,
      this.decals.group,
      this.numbers.group,
      this.flashes.group,
      this.rings.group,
    );
    this.additive.dispose();
    this.soft.dispose();
    this.ribbons.dispose();
    this.decals.dispose();
    this.numbers.dispose();
    this.flashes.dispose();
    this.rings.dispose();
  }
}
