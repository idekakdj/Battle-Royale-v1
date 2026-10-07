/**
 * Jungle atmosphere (WP-J3): layered ground mist, canopy god-rays, and drifting fireflies + pollen motes. Every system is ONE
 * draw call and animates on the GPU from a shared time uniform (no per-frame CPU work). Tier scaling is done by the scene
 * (mist layers shown, shafts on/off, point counts).
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32, TAU } from '../../core/math';

export type TimeUniform = { value: number };

// ── Mist ─────────────────────────────────────────────────────────────────────

const MIST_VERTEX = /* glsl */ `
varying vec3 vW;
void main() {
  vW = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
}
`;

const MIST_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uAlpha;
uniform float uScroll;
uniform float uWall;
uniform vec3 uColor;
uniform vec3 uPool;
varying vec3 vW;
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  vec2 p = vW.xz;
  float n = vn(p * 0.11 + vec2(uTime * 0.05 * uScroll, uTime * 0.03)) * 0.6 + vn(p * 0.27 - vec2(uTime * 0.04, uTime * 0.05 * uScroll)) * 0.4;
  float m = smoothstep(0.38, 0.85, n);
  float pool = 1.0 - smoothstep(0.0, uPool.z * 1.6, length(p - uPool.xy));
  m = clamp(m + pool * 0.3, 0.0, 1.0);
  float dCam = distance(cameraPosition, vW);
  float fade = smoothstep(1.2, 6.5, dCam);
  float r = length(p);
  float edge = 1.0 - smoothstep(uWall - 5.0, uWall + 1.0, r);
  float a = m * uAlpha * fade * edge;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class Mist {
  readonly group = new THREE.Group();
  private readonly meshes: THREE.Mesh[] = [];
  private readonly mats: THREE.ShaderMaterial[] = [];
  private readonly geo: THREE.CircleGeometry;

  constructor(radius: number, wallRadius: number, pool: { x: number; z: number; radius: number } | null, time: TimeUniform) {
    this.geo = new THREE.CircleGeometry(radius, 40);
    this.geo.rotateX(-Math.PI / 2);
    const layers = [
      { y: 0.32, alpha: 0.11, scroll: 1.0 },
      { y: 1.15, alpha: 0.075, scroll: -0.7 },
    ];
    layers.forEach((l, i) => {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: time,
          uAlpha: { value: l.alpha },
          uScroll: { value: l.scroll },
          uWall: { value: wallRadius },
          uColor: { value: new THREE.Color(0xcfe3cf) },
          uPool: { value: new THREE.Vector3(pool?.x ?? 0, pool?.z ?? 0, pool?.radius ?? 1) },
        },
        vertexShader: MIST_VERTEX,
        fragmentShader: MIST_FRAGMENT,
        transparent: true,
        depthWrite: false,
        fog: false,
      });
      const mesh = new THREE.Mesh(this.geo, mat);
      mesh.position.y = l.y;
      mesh.renderOrder = 2 + i * 0.01;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.meshes.push(mesh);
      this.mats.push(mat);
    });
  }

  /** Show the first `n` layers (tier budget). */
  setLayers(n: number): void {
    for (let i = 0; i < this.meshes.length; i++) this.meshes[i].visible = i < n;
  }

  dispose(): void {
    this.geo.dispose();
    for (const m of this.mats) m.dispose();
  }
}

// ── God-rays ─────────────────────────────────────────────────────────────────

const RAY_VERTEX = /* glsl */ `
varying float vAlong;
varying float vFacing;
varying float vAng;
void main() {
  vAlong = uv.y;
  vAng = uv.x;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  vFacing = abs(dot(n, normalize(-mv.xyz)));
  gl_Position = projectionMatrix * mv;
}
`;

const RAY_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uIntensity;
uniform vec3 uColor;
varying float vAlong;
varying float vFacing;
varying float vAng;
void main() {
  float a = pow(vFacing, 2.0);
  a *= smoothstep(0.0, 0.12, vAlong) * (1.0 - smoothstep(0.5, 0.97, vAlong));
  float streak = 0.55 + 0.45 * sin(vAng * 37.0 + uTime * 0.4 + vAlong * 6.0) * sin(vAng * 13.0 - uTime * 0.27);
  a *= (0.7 + 0.3 * sin(uTime * 0.5 + vAlong * 8.0)) * streak;
  a *= uIntensity;
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class GodRays {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.ShaderMaterial;

  constructor(sunDir: THREE.Vector3, time: TimeUniform, count = 9) {
    const rng = mulberry32(0x6a95);
    const parts: THREE.BufferGeometry[] = [];
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), sunDir.clone().normalize());
    const L = 44;
    for (let i = 0; i < count; i++) {
      const r = 0.8 + rng() * 1.5;
      const g = new THREE.CylinderGeometry(r * 1.35, r, L, 12, 1, true);
      g.translate(0, L / 2, 0); // bottom at the ground point
      g.applyQuaternion(q);
      const a = rng() * TAU;
      const d = 3 + rng() * 19;
      g.translate(Math.cos(a) * d, 0, Math.sin(a) * d);
      parts.push(g);
    }
    const merged = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: time,
        uIntensity: { value: 0.16 },
        uColor: { value: new THREE.Color(0xfff2bd) },
      },
      vertexShader: RAY_VERTEX,
      fragmentShader: RAY_FRAGMENT,
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

// ── Fireflies + pollen ───────────────────────────────────────────────────────

const MOTE_VERTEX = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform float uScale;
uniform float uFirefly;
uniform float uSize;
varying float vA;
void main() {
  vec3 p = position;
  float t = uTime * (0.07 + aSeed.x * 0.09);
  p.x += sin(t * 6.2831 + aSeed.y * 30.0) * 1.5 + cos(t * 3.3 + aSeed.w * 20.0) * 0.8;
  p.z += cos(t * 5.1 + aSeed.z * 30.0) * 1.5 + sin(t * 2.7 + aSeed.y * 14.0) * 0.8;
  p.y += sin(uTime * (0.4 + aSeed.x * 0.5) + aSeed.z * 20.0) * 0.4;
  float tw;
  if (uFirefly > 0.5) {
    tw = smoothstep(0.35, 0.95, sin(uTime * (0.7 + aSeed.z * 0.9) + aSeed.y * 40.0) * 0.5 + 0.5);
  } else {
    tw = 0.5 + 0.5 * sin(uTime * (1.2 + aSeed.z * 2.0) + aSeed.y * 20.0);
    p.y = 0.3 + mod(p.y + uTime * (0.04 + aSeed.x * 0.06), 7.0);
  }
  vA = tw;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = uSize * (0.7 + aSeed.w * 0.6) * uScale / max(0.3, -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

const MOTE_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uFirefly;
varying float vA;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = vA * (1.0 - smoothstep(0.05, 1.0, d));
  a = uFirefly > 0.5 ? a * a * 1.6 : a * 0.55;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, clamp(a, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class Motes {
  readonly points: THREE.Points;
  readonly max: number;
  private readonly mat: THREE.ShaderMaterial;
  private readonly scaleU = { value: 600 };

  /** `firefly` true = bigger blinking yellow-green glows; false = tiny drifting pollen. */
  constructor(max: number, firefly: boolean, spread: number, time: TimeUniform, seed: number) {
    this.max = max;
    const rng = mulberry32(seed);
    const pos = new Float32Array(max * 3);
    const sd = new Float32Array(max * 4);
    for (let i = 0; i < max; i++) {
      const a = rng() * TAU;
      const r = Math.sqrt(rng()) * spread;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = firefly ? 0.4 + rng() * 3.4 : rng() * 7;
      pos[i * 3 + 2] = Math.sin(a) * r;
      sd.set([rng(), rng(), rng(), rng()], i * 4);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(sd, 4));
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: time,
        uScale: this.scaleU,
        uFirefly: { value: firefly ? 1 : 0 },
        uSize: { value: firefly ? 0.16 : 0.045 },
        uColor: { value: firefly ? new THREE.Color(1.1, 1.5, 0.35) : new THREE.Color(1.15, 1.1, 0.8) },
      },
      vertexShader: MOTE_VERTEX,
      fragmentShader: MOTE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = firefly ? 7 : 6;
  }

  setCount(n: number): void {
    this.points.geometry.setDrawRange(0, Math.min(this.max, Math.max(0, n)));
    this.points.visible = n > 0;
  }

  /** Point-size scale follows the viewport (call once per frame; cheap). */
  update(): void {
    if (typeof window !== 'undefined') this.scaleU.value = (window.innerHeight * Math.min(2, window.devicePixelRatio || 1)) / 1.04;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.mat.dispose();
  }
}
