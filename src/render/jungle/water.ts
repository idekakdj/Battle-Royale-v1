/**
 * The jungle pool surface (WP-J3): ONE translucent, GPU-animated water mesh.
 *
 *  - The sim's ground is flat, so the pool is a SUNK BASIN (ground.ts builds the bowl): the water surface is a flat disc a hair
 *    below the rim (`POOL_SURFACE_Y`), the floor falls to `depth` (0.55 m) over {@link POOL_BANK_WIDTH} (`poolDepthFraction`).
 *    The shader tints by that depth (shallow teal → deep, foam where it reaches the bank) — the swimming rigs lower themselves
 *    into the bowl, so animals visibly stand IN the water and wade out through a soft bank with no wall.
 *  - Vertex shader: gentle layered waves (amplitude ~1 cm, faded toward the shore).
 *  - Fragment shader: depth-tinted teal (lighter in the shallows), fresnel sky reflection, sun glint, animated caustic shimmer
 *    over the pebbly floor, a bright foam line at the shore, and — for every swimmer reported through the FX `wake` hook
 *    (`waterContacts`, 12 slots) — a bright waterline ring + travelling ripples around its legs. Alpha 0.4–0.65 so submerged legs
 *    read through the water. No depth write; drawn after the opaque scene, before the ripple field and sprite FX.
 *
 * The matching wet-stone shoreline, lily pads and reeds live in `props.ts` / the ground texture.
 */

import * as THREE from 'three';
import type { TerrainZoneDef } from '../../config/arenas';
import { POOL_BANK_WIDTH, POOL_SURFACE_Y } from '../arenaContext';
import { WATER_CONTACT_SLOTS, waterContacts } from '../waterFx';

/** Radial tessellation: denser rings toward the shore where the surface height changes. */
const RING_FRACTIONS = [0, 0.16, 0.32, 0.48, 0.62, 0.74, 0.84, 0.91, 0.96, 0.985, 1.0];
const SEGMENTS = 72;

const WATER_VERTEX = /* glsl */ `
uniform vec2 uCenter;
uniform float uRadius;
uniform float uDepth;
uniform float uBank;
uniform float uTime;
uniform float uSurface;
varying vec3 vWorld;
varying float vH;
float gkWave(vec2 p, float t) {
  return sin(p.x * 1.1 + t * 1.2) * 0.5 + sin(p.y * 1.5 - t * 0.9) * 0.5 + sin((p.x + p.y) * 2.3 + t * 1.7) * 0.4 + sin((p.x - p.y) * 3.1 - t * 2.1) * 0.25;
}
void main() {
  vec2 pw = position.xz;
  float dist = length(pw - uCenter);
  float s = clamp((uRadius - dist) / uBank, 0.0, 1.0);
  float h = uDepth * (s * s * (3.0 - 2.0 * s));
  float fade = smoothstep(0.0, 0.4, h / uDepth);
  float y = uSurface + gkWave(pw, uTime) * 0.0105 * fade;
  vH = h;
  vWorld = vec3(pw.x, y, pw.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

const WATER_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform vec2 uCenter;
uniform float uRadius;
uniform float uDepth;
uniform float uBank;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSky;
uniform vec4 uContacts[${WATER_CONTACT_SLOTS}];
varying vec3 vWorld;
varying float vH;

float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
}
// cell-ish caustic pattern: bright thin network
float caustic(vec2 p, float t) {
  vec2 q = p + vec2(sin(p.y * 1.7 + t * 0.9), cos(p.x * 1.9 - t * 0.8)) * 0.35;
  float a = abs(sin(q.x * 3.1 + sin(q.y * 2.3 + t * 0.7) * 1.4));
  float b = abs(sin(q.y * 3.4 + sin(q.x * 2.6 - t * 0.6) * 1.3));
  return pow(1.0 - min(a, b), 5.0);
}
vec2 gkGrad(vec2 p, float t) {
  float dx = cos(p.x * 1.1 + t * 1.2) * 0.55 + cos((p.x + p.y) * 2.3 + t * 1.7) * 0.92 + cos((p.x - p.y) * 3.1 - t * 2.1) * 0.78;
  float dz = cos(p.y * 1.5 - t * 0.9) * 0.75 + cos((p.x + p.y) * 2.3 + t * 1.7) * 0.92 - cos((p.x - p.y) * 3.1 - t * 2.1) * 0.78;
  return vec2(dx, dz);
}
void main() {
  float depth01 = clamp(vH / uDepth, 0.0, 1.0);
  vec3 V = normalize(cameraPosition - vWorld);
  // Surface normal from the analytic wave gradient (+ the bank slope).
  vec2 g = gkGrad(vWorld.xz, uTime) * 0.0105 * smoothstep(0.0, 0.4, depth01);
  vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
  float ndv = max(dot(N, V), 0.0);
  float fres = pow(1.0 - ndv, 3.0);

  vec3 shallow = vec3(0.26, 0.58, 0.5);
  vec3 deepc = vec3(0.04, 0.24, 0.27);
  vec3 col = mix(shallow, deepc, smoothstep(0.08, 0.95, depth01));
  col = mix(col, uSky * vec3(0.78, 0.9, 0.85), fres * 0.4);

  // Sun glint.
  vec3 Rf = reflect(-V, N);
  float sp = pow(max(dot(Rf, normalize(uSunDir)), 0.0), 120.0);
  col += uSunColor * sp * 1.7;

  // Caustic shimmer over the pebbly floor.
  float c = caustic(vWorld.xz * 1.15, uTime) * 0.6 + caustic(vWorld.xz * 1.9 + 4.0, -uTime * 1.1) * 0.4;
  col += vec3(0.7, 1.0, 0.85) * c * 0.26 * (1.0 - fres) * smoothstep(0.05, 0.5, depth01);

  // Shoreline foam: a bright wobbling line where the water meets the bank.
  float wob = vn(vWorld.xz * 6.0 + uTime * 0.5);
  float foam = (1.0 - smoothstep(0.0, 0.13 + wob * 0.06, depth01)) * smoothstep(0.0, 0.025, depth01 + 0.02);
  col = mix(col, vec3(0.9, 1.0, 0.96), foam * 0.5);

  // Swimmer contacts: waterline ring + travelling ripples.
  float ring = 0.0;
  float wash = 0.0;
  for (int i = 0; i < ${WATER_CONTACT_SLOTS}; i++) {
    vec4 ct = uContacts[i];
    if (ct.w > 0.01) {
      float d = length(vWorld.xz - ct.xy);
      float x = d - ct.z;
      ring += exp(-x * x * 150.0) * ct.w;
      wash += (1.0 - smoothstep(0.0, 1.1, x)) * step(0.0, x) * (0.5 + 0.5 * sin(x * 20.0 - uTime * 5.5)) * ct.w;
    }
  }
  col += vec3(0.8, 0.95, 0.9) * (ring * 0.7 + wash * 0.14);

  float alpha = mix(0.36, 0.55, smoothstep(0.1, 1.0, depth01)) + fres * 0.2 + foam * 0.35 + ring * 0.3 + wash * 0.05;
  alpha *= smoothstep(0.0, 0.06, depth01 + 0.02);
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.95));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class PoolWater {
  readonly mesh: THREE.Mesh;
  readonly zone: TerrainZoneDef;
  private readonly mat: THREE.ShaderMaterial;
  private readonly timeU: { value: number };

  constructor(zone: TerrainZoneDef, time: { value: number }, sunDir: THREE.Vector3, sunColor: number, skyColor: number) {
    this.zone = zone;
    this.timeU = time;
    const R = zone.radius;
    const pos: number[] = [];
    const idx: number[] = [];
    const rings = RING_FRACTIONS.length;
    for (let i = 0; i < rings; i++) {
      const r = RING_FRACTIONS[i] * R;
      if (i === 0) {
        pos.push(zone.x, 0, zone.z);
        continue;
      }
      for (let s = 0; s < SEGMENTS; s++) {
        const a = (s / SEGMENTS) * Math.PI * 2;
        pos.push(zone.x + Math.cos(a) * r, 0, zone.z + Math.sin(a) * r);
      }
    }
    // centre fan
    for (let s = 0; s < SEGMENTS; s++) idx.push(0, 1 + ((s + 1) % SEGMENTS), 1 + s);
    for (let i = 1; i < rings - 1; i++) {
      const a0 = 1 + (i - 1) * SEGMENTS;
      const a1 = 1 + i * SEGMENTS;
      for (let s = 0; s < SEGMENTS; s++) {
        const s1 = (s + 1) % SEGMENTS;
        idx.push(a0 + s, a0 + s1, a1 + s, a0 + s1, a1 + s1, a1 + s);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setIndex(idx);
    const sky = new THREE.Color(skyColor);
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.timeU,
        uCenter: { value: new THREE.Vector2(zone.x, zone.z) },
        uRadius: { value: R },
        uDepth: { value: zone.depth ?? 0.55 },
        uBank: { value: POOL_BANK_WIDTH },
        uSurface: { value: POOL_SURFACE_Y },
        uSunDir: { value: sunDir.clone().normalize() },
        uSunColor: { value: new THREE.Color(sunColor) },
        uSky: { value: new THREE.Vector3(sky.r, sky.g, sky.b) },
        uContacts: { value: waterContacts },
      },
      vertexShader: WATER_VERTEX,
      fragmentShader: WATER_FRAGMENT,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      fog: false,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }

  /** Re-point the sun / sky tint (the look can change at runtime). */
  setLook(sunDir: THREE.Vector3, sunColor: number, skyColor: number): void {
    const u = this.mat.uniforms;
    (u.uSunDir.value as THREE.Vector3).copy(sunDir).normalize();
    (u.uSunColor.value as THREE.Color).setHex(sunColor);
    const sky = new THREE.Color(skyColor);
    (u.uSky.value as THREE.Vector3).set(sky.r, sky.g, sky.b);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
