/**
 * Arena ambience for the v1.1 stadium (WP-K): procedural sand textures, torch
 * flames + embers + (≤4) flickering point lights, god-ray light shafts,
 * drifting dust motes, waving banners and crowd flags.
 *
 * Every system is ONE draw call and animates on the GPU from a shared `uTime`
 * uniform (no per-frame CPU work beyond a handful of light intensities).
 * Everything here is built once at init.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DAIS, PICKUP_PADS, PILLARS, CRATE_CLUSTER_CENTERS, WALL_RADIUS } from '../config/arena';
import { mulberry32 } from '../core/math';

export type TimeUniform = { value: number };

const NOISE_GLSL = /* glsl */ `
float gkHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float gkNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(gkHash(i), gkHash(i + vec2(1.0, 0.0)), f.x),
             mix(gkHash(i + vec2(0.0, 1.0)), gkHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
`;

// ── Sand textures ────────────────────────────────────────────────────────────

/**
 * Whole-arena colour map (1 texel ≈ 6 cm): radial sand gradient, fine grain,
 * wind ripples, faint drag tracks, a darker compacted gutter by the wall, the
 * inlaid stone ring between pads and pillars, and a sun emblem around the dais.
 * Canvas x → world x, canvas y → world z (CircleGeometry UVs, rotated flat).
 */
export function makeSandTexture(size: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  if (ctx === null) return tex;
  const R = WALL_RADIUS;
  const px = (m: number): number => (m / (2 * R) + 0.5) * size;
  const pm = size / (2 * R); // pixels per metre

  // Low-frequency noise grid for ripples / patchiness.
  const G = 64;
  const grid = new Float32Array(G * G);
  const rng = mulberry32(0x5a4d);
  for (let i = 0; i < grid.length; i++) grid[i] = rng();
  const lowNoise = (u: number, v: number): number => {
    const x = u * (G - 1);
    const y = v * (G - 1);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const x1 = Math.min(G - 1, x0 + 1);
    const y1 = Math.min(G - 1, y0 + 1);
    const a = grid[y0 * G + x0];
    const b = grid[y0 * G + x1];
    const c = grid[y1 * G + x0];
    const d = grid[y1 * G + x1];
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };

  const img = ctx.createImageData(size, size);
  const data = img.data;
  const inR = 232;
  const inG = 202;
  const inB = 148;
  const outR = 196;
  const outG = 152;
  const outB = 94;
  let seed = 0x1234567;
  for (let y = 0; y < size; y++) {
    const v = y / size;
    const wz = (v - 0.5) * 2 * R;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const wx = (u - 0.5) * 2 * R;
      const r = Math.hypot(wx, wz) / R;
      const t = Math.min(1, Math.pow(r, 1.35));
      let cr = inR + (outR - inR) * t;
      let cg = inG + (outG - inG) * t;
      let cb = inB + (outB - inB) * t;
      const ln = lowNoise(u, v);
      const ln2 = lowNoise((u * 3.7) % 1, (v * 3.7) % 1);
      // Wind ripples: long bands bent by low noise.
      const rip = Math.sin((wx * 0.8 + wz * 0.55) * 5.2 + ln * 9 + ln2 * 3);
      let f = 0.93 + ln * 0.1 + ln2 * 0.05 + (rip > 0.6 ? -0.035 : rip < -0.7 ? 0.02 : 0);
      // Fine grain.
      seed = (seed * 1664525 + 1013904223) >>> 0;
      f += ((seed >>> 8) / 16777216 - 0.5) * 0.09;
      // Compacted gutter by the wall.
      if (r > 0.93) f *= 0.86 + 0.14 * Math.max(0, (0.985 - r) / 0.055);
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

  const cx = px(0);
  const cz = px(0);
  // Faint drag tracks / footprints (arcs).
  const trng = mulberry32(0x7ac4);
  ctx.lineCap = 'round';
  for (let i = 0; i < 70; i++) {
    const a0 = trng() * Math.PI * 2;
    const rr = (5 + trng() * 22) * pm;
    const len = 0.2 + trng() * 0.6;
    ctx.strokeStyle = `rgba(110,78,40,${0.05 + trng() * 0.07})`;
    ctx.lineWidth = (0.12 + trng() * 0.25) * pm;
    ctx.beginPath();
    ctx.arc(cx + (trng() - 0.5) * 6 * pm, cz + (trng() - 0.5) * 6 * pm, rr, a0, a0 + len);
    ctx.stroke();
  }

  // Inlaid stone ring (between pickup pads r10 and pillars r15).
  const ringIn = 12.15 * pm;
  const ringOut = 12.95 * pm;
  const segs = 60;
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2 + 0.006;
    const a1 = ((i + 1) / segs) * Math.PI * 2 - 0.006;
    const shadeV = 160 + Math.floor(trng() * 26);
    ctx.fillStyle = `rgb(${shadeV + 22},${shadeV}, ${shadeV - 36})`;
    ctx.beginPath();
    ctx.arc(cx, cz, ringOut, a0, a1);
    ctx.arc(cx, cz, ringIn, a1, a0, true);
    ctx.closePath();
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(176,138,60,0.95)';
  ctx.lineWidth = 0.09 * pm;
  for (const rr of [ringIn - 0.1 * pm, ringOut + 0.1 * pm]) {
    ctx.beginPath();
    ctx.arc(cx, cz, rr, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Red meander band just inside the ring.
  ctx.strokeStyle = 'rgba(140,48,30,0.55)';
  ctx.lineWidth = 0.18 * pm;
  ctx.setLineDash([0.9 * pm, 0.5 * pm]);
  ctx.beginPath();
  ctx.arc(cx, cz, ringIn - 0.45 * pm, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // Sun emblem radiating from the dais.
  const dr = (DAIS.radius + 0.35) * pm;
  ctx.fillStyle = 'rgba(150,96,46,0.5)';
  ctx.beginPath();
  ctx.arc(cx, cz, dr + 0.35 * pm, 0, Math.PI * 2);
  ctx.arc(cx, cz, dr, 0, Math.PI * 2, true);
  ctx.fill();
  const rays = 16;
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2;
    const long = i % 2 === 0;
    const r1 = dr + 0.5 * pm;
    const r2 = (long ? 8.6 : 6.9) * pm;
    const w = (long ? 0.13 : 0.09) * Math.PI;
    ctx.fillStyle = long ? 'rgba(168,108,52,0.42)' : 'rgba(186,132,70,0.36)';
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a - w / 2) * r1, cz + Math.sin(a - w / 2) * r1);
    ctx.lineTo(cx + Math.cos(a) * r2, cz + Math.sin(a) * r2);
    ctx.lineTo(cx + Math.cos(a + w / 2) * r1, cz + Math.sin(a + w / 2) * r1);
    ctx.closePath();
    ctx.fill();
  }

  // Disturbed sand around pads, pillars and crates.
  const scuff = (x: number, z: number, r: number, a: number): void => {
    const g = ctx.createRadialGradient(px(x), px(z), r * 0.3 * pm, px(x), px(z), r * pm);
    g.addColorStop(0, `rgba(120,86,46,${a})`);
    g.addColorStop(1, 'rgba(120,86,46,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px(x), px(z), r * pm, 0, Math.PI * 2);
    ctx.fill();
  };
  for (const p of PICKUP_PADS) scuff(p.x, p.z, 2.6, 0.18);
  for (const p of PILLARS) scuff(p.x, p.z, 2.8, 0.26);
  for (const c of CRATE_CLUSTER_CENTERS) scuff(c.x + 0.5, c.z + 0.5, 2.4, 0.2);

  tex.needsUpdate = true;
  return tex;
}

/** Tiling grain/ripple height map for the sand bump (repeat ~16×). */
export function makeGrainTexture(size: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  if (ctx === null) return tex;
  const img = ctx.createImageData(size, size);
  const d = img.data;
  let seed = 0xabcdef;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const n = (seed >>> 8) / 16777216;
      const u = (x / size) * Math.PI * 2;
      const v = (y / size) * Math.PI * 2;
      const rip = Math.sin(u * 6 + Math.sin(v * 2) * 1.3) * 0.5 + 0.5;
      const val = 110 + rip * 60 + n * 70;
      const o = (y * size + x) * 4;
      d[o] = d[o + 1] = d[o + 2] = val;
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  tex.needsUpdate = true;
  return tex;
}

// ── Fires (flames + embers + point lights) ───────────────────────────────────

export interface FireSpot {
  x: number;
  y: number;
  z: number;
  scale: number;
}

const FLAME_VERTEX = /* glsl */ `
attribute vec4 aFlame;
attribute float aPhase;
varying vec2 vUv;
varying float vPhase;
void main() {
  vUv = uv;
  vPhase = aPhase;
  vec4 mv = viewMatrix * vec4(aFlame.xyz, 1.0);
  mv.xy += (uv - vec2(0.5, 0.18)) * vec2(1.05, 1.9) * aFlame.w;
  gl_Position = projectionMatrix * mv;
}
`;

const FLAME_FRAGMENT = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying float vPhase;
${NOISE_GLSL}
void main() {
  float t = uTime + vPhase * 7.0;
  vec2 p = vUv;
  float n1 = gkNoise(vec2(p.x * 4.0 + vPhase * 3.0, p.y * 3.0 - t * 3.2));
  float n2 = gkNoise(vec2(p.x * 9.0 - vPhase, p.y * 7.0 - t * 5.5));
  float y = (p.y - 0.12) / 0.88;
  float x = (p.x - 0.5) * 2.0 + (n1 - 0.5) * 0.55 * y;
  float width = 0.62 * (1.0 - smoothstep(0.0, 1.0, y)) * (0.75 + 0.25 * sin(t * 9.0 + vPhase));
  float body = 1.0 - smoothstep(width * 0.55, width + 0.02, abs(x) + (n2 - 0.5) * 0.25);
  body *= smoothstep(-0.06, 0.08, y) * (1.0 - smoothstep(0.55, 0.98, y + (n2 - 0.5) * 0.3));
  float core = body * (1.0 - smoothstep(0.0, width * 0.5 + 0.05, abs(x))) * (1.0 - smoothstep(0.1, 0.55, y));
  vec3 col = mix(vec3(1.6, 0.34, 0.05), vec3(3.4, 1.55, 0.35), body);
  col = mix(col, vec3(4.2, 3.2, 1.6), core);
  float flick = 0.85 + 0.15 * sin(t * 13.0) * sin(t * 7.3);
  float halo = exp(-length((p - vec2(0.5, 0.26)) * vec2(1.6, 1.1)) * 5.0) * 0.32 * flick;
  vec3 outc = (col * body * flick) * 0.62 + vec3(1.0, 0.45, 0.12) * halo;
  float a = clamp(max(body, halo), 0.0, 1.0);
  if (a < 0.01) discard;
  gl_FragColor = vec4(outc, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const EMBER_VERTEX = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform float uScale;
varying float vA;
void main() {
  float life = fract(uTime * (0.32 + aSeed.w * 0.3) + aSeed.w * 13.7);
  vec3 p = position;
  p.x += sin(uTime * 2.1 + aSeed.w * 40.0) * 0.28 * life;
  p.z += cos(uTime * 1.7 + aSeed.w * 23.0) * 0.28 * life;
  p.y += life * (1.6 + aSeed.w * 1.4) * aSeed.x;
  vA = (1.0 - life) * smoothstep(0.0, 0.08, life);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = 0.075 * aSeed.x * uScale / max(0.2, -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

const EMBER_FRAGMENT = /* glsl */ `
varying float vA;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = vA * (1.0 - smoothstep(0.2, 1.0, d));
  if (a < 0.01) discard;
  gl_FragColor = vec4(vec3(3.0, 1.2, 0.3), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class Fires {
  readonly group = new THREE.Group();
  private readonly flameMat: THREE.ShaderMaterial;
  private readonly emberMat: THREE.ShaderMaterial;
  private readonly flameGeo: THREE.InstancedBufferGeometry;
  private readonly emberGeo: THREE.BufferGeometry;
  private readonly lights: THREE.PointLight[] = [];
  private readonly lightBase: number[] = [];
  private readonly scaleU = { value: 600 };

  /** `lightSpots` in priority order: the first N are lit per tier. */
  constructor(spots: readonly FireSpot[], lightSpots: readonly FireSpot[], time: TimeUniform) {
    const plane = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = plane.index;
    geo.setAttribute('position', plane.getAttribute('position'));
    geo.setAttribute('uv', plane.getAttribute('uv'));
    const fl = new Float32Array(spots.length * 4);
    const ph = new Float32Array(spots.length);
    spots.forEach((s, i) => {
      fl.set([s.x, s.y, s.z, s.scale], i * 4);
      ph[i] = i * 0.618;
    });
    geo.setAttribute('aFlame', new THREE.InstancedBufferAttribute(fl, 4));
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(ph, 1));
    geo.instanceCount = spots.length;
    this.flameGeo = geo;
    this.flameMat = new THREE.ShaderMaterial({
      uniforms: { uTime: time },
      vertexShader: FLAME_VERTEX,
      fragmentShader: FLAME_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const flames = new THREE.Mesh(geo, this.flameMat);
    flames.frustumCulled = false;
    flames.renderOrder = 4;
    this.group.add(flames);

    // Embers: 7 per fire, animated entirely in the vertex shader.
    const per = 7;
    const n = spots.length * per;
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n * 4);
    const rng = mulberry32(0xe3be);
    for (let i = 0; i < spots.length; i++) {
      for (let k = 0; k < per; k++) {
        const j = i * per + k;
        const s = spots[i];
        pos[j * 3] = s.x + (rng() - 0.5) * 0.3 * s.scale;
        pos[j * 3 + 1] = s.y + 0.1;
        pos[j * 3 + 2] = s.z + (rng() - 0.5) * 0.3 * s.scale;
        seed[j * 4] = s.scale;
        seed[j * 4 + 3] = rng();
      }
    }
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    eg.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    this.emberGeo = eg;
    this.emberMat = new THREE.ShaderMaterial({
      uniforms: { uTime: time, uScale: this.scaleU },
      vertexShader: EMBER_VERTEX,
      fragmentShader: EMBER_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const embers = new THREE.Points(eg, this.emberMat);
    embers.frustumCulled = false;
    embers.renderOrder = 5;
    this.group.add(embers);

    for (const s of lightSpots) {
      const l = new THREE.PointLight(0xff9448, 26, 17, 2);
      l.position.set(s.x, s.y, s.z);
      l.castShadow = false;
      l.visible = false;
      this.lights.push(l);
      this.lightBase.push(26 * s.scale);
      this.group.add(l);
    }
  }

  /** Enable the first `n` real point lights (tier budget, ≤4). */
  setLightCount(n: number): void {
    for (let i = 0; i < this.lights.length; i++) this.lights[i].visible = i < n;
  }

  update(time: number): void {
    this.scaleU.value = (window.innerHeight * Math.min(2, window.devicePixelRatio || 1)) / 1.04;
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      if (!l.visible) continue;
      const f = 0.82 + 0.1 * Math.sin(time * 11 + i * 2.1) + 0.08 * Math.sin(time * 23.7 + i);
      l.intensity = this.lightBase[i] * f;
    }
  }

  dispose(): void {
    this.flameGeo.dispose();
    this.emberGeo.dispose();
    this.flameMat.dispose();
    this.emberMat.dispose();
    for (const l of this.lights) l.dispose();
  }
}

// ── God-ray light shafts ─────────────────────────────────────────────────────

const SHAFT_VERTEX = /* glsl */ `
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

const SHAFT_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uIntensity;
uniform vec3 uColor;
varying float vAlong;
varying float vFacing;
void main() {
  float a = pow(vFacing, 2.2);
  a *= smoothstep(0.0, 0.1, vAlong) * (1.0 - smoothstep(0.45, 0.95, vAlong));
  a *= 0.75 + 0.25 * sin(uTime * 0.6 + vAlong * 9.0);
  a *= uIntensity;
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class LightShafts {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.ShaderMaterial;

  constructor(sunDir: THREE.Vector3, time: TimeUniform) {
    const rng = mulberry32(0x5ab7);
    const parts: THREE.BufferGeometry[] = [];
    const up = new THREE.Vector3(0, 1, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(up, sunDir.clone().normalize());
    const L = 46;
    for (let i = 0; i < 5; i++) {
      const r = 1.6 + rng() * 2.2;
      const g = new THREE.CylinderGeometry(r * 1.25, r, L, 14, 1, true);
      g.translate(0, L / 2, 0); // bottom at the ground point
      g.applyQuaternion(q);
      const a = rng() * Math.PI * 2;
      const d = 4 + rng() * 16;
      g.translate(Math.cos(a) * d, 0, Math.sin(a) * d);
      parts.push(g);
    }
    const merged = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: time,
        uIntensity: { value: 0.085 },
        uColor: { value: new THREE.Color(0xffe0a8) },
      },
      vertexShader: SHAFT_VERTEX,
      fragmentShader: SHAFT_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.mesh = new THREE.Mesh(merged ?? new THREE.BufferGeometry(), this.mat);
    this.mesh.renderOrder = 8;
    this.mesh.frustumCulled = false;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}

// ── Dust motes ───────────────────────────────────────────────────────────────

const MOTE_VERTEX = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform float uScale;
varying float vA;
void main() {
  vec3 p = position;
  float t = uTime * (0.08 + aSeed.x * 0.08);
  p.x += sin(t * 6.2831 + aSeed.y * 30.0) * 1.6 + uTime * 0.12;
  p.z += cos(t * 5.1 + aSeed.z * 30.0) * 1.6;
  p.y = 0.25 + mod(p.y + uTime * (0.05 + aSeed.x * 0.08), 7.0);
  p.x = mod(p.x + 26.0, 52.0) - 26.0;
  float tw = 0.55 + 0.45 * sin(uTime * (1.5 + aSeed.z * 2.0) + aSeed.y * 20.0);
  vA = tw * smoothstep(0.25, 1.0, p.y) * (1.0 - smoothstep(5.5, 7.2, p.y));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = (0.035 + aSeed.w * 0.03) * uScale / max(0.3, -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

const MOTE_FRAGMENT = /* glsl */ `
varying float vA;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = vA * (1.0 - smoothstep(0.1, 1.0, d)) * 0.7;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vec3(1.25, 1.05, 0.78), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class DustMotes {
  readonly points: THREE.Points;
  readonly max: number;
  private readonly mat: THREE.ShaderMaterial;
  private readonly scaleU = { value: 600 };

  constructor(max: number, time: TimeUniform) {
    this.max = max;
    const rng = mulberry32(0xd057);
    const pos = new Float32Array(max * 3);
    const seed = new Float32Array(max * 4);
    for (let i = 0; i < max; i++) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * 25;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = rng() * 7;
      pos[i * 3 + 2] = Math.sin(a) * r;
      seed.set([rng(), rng(), rng(), rng()], i * 4);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: time, uScale: this.scaleU },
      vertexShader: MOTE_VERTEX,
      fragmentShader: MOTE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
  }

  setCount(n: number): void {
    this.points.geometry.setDrawRange(0, Math.min(this.max, n));
    this.points.visible = n > 0;
  }

  update(): void {
    this.scaleU.value = (window.innerHeight * Math.min(2, window.devicePixelRatio || 1)) / 1.04;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.mat.dispose();
  }
}

// ── Waving cloth (banners + crowd flags) ─────────────────────────────────────

/**
 * Standard material whose vertices wave along their normal, weighted by the
 * `aFlap` attribute (0 = pinned, 1 = free edge). Instanced meshes get a
 * per-instance phase from their translation.
 */
export function makeClothMaterial(
  params: THREE.MeshStandardMaterialParameters,
  time: TimeUniform,
  amp: number,
  freq: number,
): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial(params);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aFlap;\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = vec3(position);
float gkPhase = position.x * 0.9 + position.z * 0.7;
#ifdef USE_INSTANCING
gkPhase += instanceMatrix[3].x * 1.3 + instanceMatrix[3].z * 0.7;
#endif
float gkW = sin(uTime * ${freq.toFixed(2)} + gkPhase + position.y * 2.4) * 0.7 + sin(uTime * ${(freq * 1.9).toFixed(2)} + gkPhase * 1.7) * 0.3;
transformed += normal * gkW * ${amp.toFixed(3)} * aFlap;`,
      );
  };
  mat.customProgramCacheKey = () => `gk-cloth-${amp}-${freq}`;
  return mat;
}

/** Banner cloth texture: deep red, gold border + sun emblem, cut fringe. */
export function makeBannerTexture(): THREE.CanvasTexture {
  const w = 128;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (ctx === null) return tex;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#7a1a12');
  g.addColorStop(0.5, '#9c2518');
  g.addColorStop(1, '#6a150f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h - 26);
  // Swallowtail fringe (alpha-tested).
  ctx.beginPath();
  ctx.moveTo(0, h - 26);
  ctx.lineTo(w, h - 26);
  ctx.lineTo(w, h);
  ctx.lineTo(w / 2, h - 30);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#d4a43c';
  ctx.lineWidth = 6;
  ctx.strokeRect(8, 8, w - 16, h - 44);
  ctx.lineWidth = 2;
  ctx.strokeRect(16, 16, w - 32, h - 60);
  // Sun emblem.
  const cx = w / 2;
  const cy = 104;
  ctx.fillStyle = '#e0b04b';
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a - 0.12) * 22, cy + Math.sin(a - 0.12) * 22);
    ctx.lineTo(cx + Math.cos(a) * 38, cy + Math.sin(a) * 38);
    ctx.lineTo(cx + Math.cos(a + 0.12) * 22, cy + Math.sin(a + 0.12) * 22);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(cx, cy, 20, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#9c2518';
  ctx.beginPath();
  ctx.arc(cx, cy, 11, 0, Math.PI * 2);
  ctx.fill();
  // Laurel stripes.
  ctx.fillStyle = '#d4a43c';
  ctx.fillRect(28, 170, w - 56, 5);
  ctx.fillRect(40, 182, w - 80, 3);
  tex.needsUpdate = true;
  return tex;
}

/** Plane with an `aFlap` weight rising from the pinned top edge (y = +h/2). */
export function clothPlane(w: number, h: number, sx: number, sy: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h, sx, sy);
  const pos = g.getAttribute('position');
  const flap = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) flap[i] = Math.pow((h / 2 - pos.getY(i)) / h, 1.2);
  g.setAttribute('aFlap', new THREE.BufferAttribute(flap, 1));
  return g;
}

/** Flag on a short pole: cloth flaps from the pole (x = 0) outward. */
export function flagGeometry(): THREE.BufferGeometry {
  const cloth = new THREE.PlaneGeometry(0.55, 0.34, 5, 2);
  cloth.translate(0.3, 1.08, 0);
  const cp = cloth.getAttribute('position');
  const cf = new Float32Array(cp.count);
  const cc = new Float32Array(cp.count * 3);
  for (let i = 0; i < cp.count; i++) {
    cf[i] = Math.max(0, (cp.getX(i) - 0.02) / 0.55);
    cc[i * 3] = cc[i * 3 + 1] = cc[i * 3 + 2] = 1;
  }
  cloth.setAttribute('aFlap', new THREE.BufferAttribute(cf, 1));
  cloth.setAttribute('color', new THREE.BufferAttribute(cc, 3));
  const pole = new THREE.BoxGeometry(0.035, 1.3, 0.035);
  pole.translate(0, 0.6, 0);
  const pp = pole.getAttribute('position');
  pole.setAttribute('aFlap', new THREE.BufferAttribute(new Float32Array(pp.count), 1));
  const pc = new Float32Array(pp.count * 3);
  for (let i = 0; i < pp.count; i++) {
    pc[i * 3] = 0.3;
    pc[i * 3 + 1] = 0.22;
    pc[i * 3 + 2] = 0.14;
  }
  pole.setAttribute('color', new THREE.BufferAttribute(pc, 3));
  const merged = mergeGeometries([cloth, pole], false);
  cloth.dispose();
  pole.dispose();
  return merged ?? new THREE.BufferGeometry();
}
