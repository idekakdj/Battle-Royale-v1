/**
 * Moss patches (WP-J3): the slow-down discs of the jungle read as soft, softly GLOWING green carpets with an irregular fuzzy edge
 * that blends into the ground, scattered moss tufts and tiny mushrooms, and drifting spore twinkles. One merged decal mesh (a
 * quad per patch, all patches in ONE draw call, GPU animated) + one instanced tuft mesh. The patch discs come from
 * `arena.terrain` (kind 'moss'), so the picture always matches the sim's collision discs.
 */

import * as THREE from 'three';
import type { TerrainZoneDef } from '../../config/arenas';
import { mulberry32, TAU } from '../../core/math';
import { composeMat, hash2, smoothstep, VGeo } from './vgeo';
import { rockGeometry } from './props';

/** Quad half-extent as a multiple of the disc radius (room for the fuzzy edge to fade out). */
export const MOSS_QUAD = 1.3;

const MOSS_VERTEX = /* glsl */ `
attribute vec3 aMoss; // centre x, centre z, radius
varying vec2 vWorld;
varying vec3 vMoss;
void main() {
  vWorld = position.xz;
  vMoss = aMoss;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`;

const MOSS_FRAGMENT = /* glsl */ `
uniform float uTime;
varying vec2 vWorld;
varying vec3 vMoss;
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) { return vn(p) * 0.55 + vn(p * 2.03 + 7.1) * 0.3 + vn(p * 4.1 + 3.7) * 0.15; }
void main() {
  vec2 d = (vWorld - vMoss.xy) / vMoss.z;
  float r = length(d);
  float n = fbm(vWorld * 1.15 + vMoss.xy * 0.37);
  float edge = r + (n - 0.5) * 0.55;
  float a = 1.0 - smoothstep(0.58, 1.02, edge);
  if (a < 0.01) discard;
  float core = 1.0 - smoothstep(0.05, 0.85, edge);
  float fuzz = fbm(vWorld * 7.0) * 0.6 + fbm(vWorld * 19.0) * 0.4;
  vec3 deep = vec3(0.07, 0.3, 0.07);
  vec3 mid = vec3(0.2, 0.55, 0.12);
  vec3 lime = vec3(0.5, 0.82, 0.22);
  vec3 col = mix(deep, mid, fuzz * 0.9 + (1.0 - core) * 0.25);
  col = mix(col, lime, smoothstep(0.62, 0.95, fuzz) * 0.65);
  // glowing rim + pulsing inner glow
  float rim = smoothstep(0.5, 0.88, edge) * (1.0 - smoothstep(0.9, 1.06, edge));
  float pulse = 0.82 + 0.18 * sin(uTime * 1.25 + n * 18.0);
  col += vec3(0.28, 0.8, 0.22) * rim * 0.42 * pulse;
  col += vec3(0.05, 0.22, 0.06) * core * pulse;
  // tiny twinkling spores
  float sp = smoothstep(0.88, 0.97, vn(vWorld * 15.0 + floor(uTime * 0.35) * 3.1)) * core;
  col += vec3(0.6, 1.0, 0.5) * sp * (0.5 + 0.5 * sin(uTime * 3.0 + n * 40.0));
  gl_FragColor = vec4(col * 0.9, a * 0.94);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class MossPatches {
  readonly group = new THREE.Group();
  readonly decal: THREE.Mesh;
  readonly tufts: THREE.InstancedMesh;
  private readonly mat: THREE.ShaderMaterial;
  private readonly tuftMat: THREE.MeshStandardMaterial;
  private readonly timeU: { value: number };
  private readonly tuftTotal: number;

  constructor(zones: readonly TerrainZoneDef[], time: { value: number }) {
    this.timeU = time;
    const moss = zones.filter((z) => z.kind === 'moss');
    // ── Decal quads ──
    const pos = new Float32Array(moss.length * 4 * 3);
    const info = new Float32Array(moss.length * 4 * 3);
    const idx: number[] = [];
    moss.forEach((z, i) => {
      const e = z.radius * MOSS_QUAD;
      const corners: [number, number][] = [[-e, -e], [e, -e], [e, e], [-e, e]];
      corners.forEach(([dx, dz], k) => {
        const o = (i * 4 + k) * 3;
        pos[o] = z.x + dx;
        pos[o + 1] = 0.018;
        pos[o + 2] = z.z + dz;
        info[o] = z.x;
        info[o + 1] = z.z;
        info[o + 2] = z.radius;
      });
      const b = i * 4;
      idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aMoss', new THREE.BufferAttribute(info, 3));
    geo.setIndex(idx);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.timeU },
      vertexShader: MOSS_VERTEX,
      fragmentShader: MOSS_FRAGMENT,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      fog: false,
    });
    this.decal = new THREE.Mesh(geo, this.mat);
    this.decal.renderOrder = 1;
    this.decal.frustumCulled = false;
    this.group.add(this.decal);

    // ── Tufts + mushrooms (instanced lumps) ──
    const rng = mulberry32(0x6055);
    const lump = rockGeometry(0x51, 0);
    const lg = new VGeo();
    lg.add(lump, composeMat(0, 0.5, 0), (x, y, z, nx, ny, nz, out) => {
      const t = hash2(Math.floor(nx * 5 + 3), Math.floor(nz * 5 + ny * 2));
      const top = smoothstep(-0.2, 0.8, y);
      out[0] = (0.18 + 0.2 * t) * (0.7 + 0.5 * top);
      out[1] = (0.46 + 0.24 * t) * (0.75 + 0.45 * top);
      out[2] = (0.1 + 0.08 * t) * (0.7 + 0.4 * top);
      void x;
      void z;
    });
    lump.dispose();
    const per = 16;
    this.tuftTotal = moss.length * per;
    this.tuftMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0 });
    this.tufts = new THREE.InstancedMesh(lg.build(), this.tuftMat, Math.max(1, this.tuftTotal));
    const tint = new THREE.Color();
    let n = 0;
    // Interleave patches so any prefix of the instances is an even sample of every patch (quality scaling).
    for (let i = 0; i < per; i++) {
      for (const z of moss) {
        const a = rng() * TAU;
        const rr = Math.sqrt(rng()) * z.radius * 0.88;
        const s = 0.1 + rng() * rng() * 0.26;
        this.tufts.setMatrixAt(n, composeMat(z.x + Math.cos(a) * rr, 0.0, z.z + Math.sin(a) * rr, 0, rng() * TAU, 0, s * 1.4, s * 0.85, s * 1.4).clone());
        tint.setRGB(0.8 + rng() * 0.45, 0.85 + rng() * 0.4, 0.7 + rng() * 0.4);
        this.tufts.setColorAt(n, tint);
        n++;
      }
    }
    this.tufts.instanceMatrix.needsUpdate = true;
    if (this.tufts.instanceColor !== null) this.tufts.instanceColor.needsUpdate = true;
    this.tufts.receiveShadow = true;
    this.tufts.frustumCulled = false;
    this.group.add(this.tufts);
  }

  /** Quality scaling: fraction of the tufts drawn (instances are shuffled by construction, so a prefix is a fair sample). */
  setDetail(fraction: number): void {
    this.tufts.count = Math.max(0, Math.round(this.tuftTotal * Math.min(1, Math.max(0, fraction))));
  }

  get tuftCount(): number {
    return this.tuftTotal;
  }

  dispose(): void {
    this.decal.geometry.dispose();
    this.mat.dispose();
    this.tufts.geometry.dispose();
    this.tuftMat.dispose();
    this.tufts.dispose();
  }
}
