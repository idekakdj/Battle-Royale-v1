/**
 * Sky Aqueduct (plan §4): two floating aqueduct islands over open sky, a drifting marble slab in the gap and a high
 * bridge above. Cool dawn palette: parallax cloud layers, waterfalls spilling off the broken channel ends into the
 * clouds, floating ruins, a flock of birds, god-rays and drifting motes. Soft platforms are pale marble with a glowing
 * teal trim; solid ground is grass-lipped stone over a rocky underside.
 */

import * as THREE from 'three';
import { mulberry32 } from '../../../core/math';
import type { PlatformState, StageDef } from '../../types';
import { tierProfile, type QualityTier } from '../../../render/quality';
import {
  CloudLayer,
  GeoBuilder,
  Motes,
  ResourceBag,
  SkyDome,
  archGeo,
  bakeMesh,
  buildBlastTelegraph,
  makeWaterfall,
  softDiscTexture,
  stoneMaterial,
  syncPlatforms,
  type PlatformVisual,
  type StageSetup,
  type StageVisual,
} from './common';

const C = {
  marble: 0xe8e4dc,
  marbleLight: 0xf6f2ea,
  marbleShade: 0xb9b4bd,
  stone: 0xc9c4c6,
  stoneDark: 0x8f8a9c,
  recess: 0x4b5675,
  recessDeep: 0x2f3858,
  rock: 0x7c7790,
  rockDark: 0x57546d,
  rockLight: 0x9a94ad,
  grass: 0x86bb6a,
  grassDark: 0x4f8c57,
  grassLight: 0xa6d27c,
  teal: 0x56d6e6,
  tealDark: 0x2c8fa3,
  gold: 0xf2c25e,
  wood: 0x9a7048,
  vine: 0x5d9b55,
};

const FRONT_Z = 2.6;
const BACK_Z = -3.2;

const SETUP: StageSetup = {
  fog: { color: 0xe6bcc4, near: 30, far: 215 },
  hemi: { sky: 0xbfd2ff, ground: 0x8f7fa6, intensity: 1.0 },
  key: { color: 0xfff0dc, intensity: 2.5, pos: [20, 14, 22] },
  rim: { color: 0xa9c8ff, intensity: 1.2, pos: [-22, 10, -16] },
  exposure: 1.08,
  grade: { tint: [0.98, 1.0, 1.04], vignette: 0.3, sat: 1.14 },
  shadow: 0x23203c,
};

// ── god-rays: a few additive soft shafts, GPU-animated ──────────────────────

const RAY_VERT = /* glsl */ `
attribute vec2 aUv;
attribute float aPhase;
varying vec2 vUv;
varying float vPhase;
void main() {
  vUv = aUv;
  vPhase = aPhase;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const RAY_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uCol;
uniform float uStrength;
varying vec2 vUv;
varying float vPhase;
void main() {
  float across = smoothstep(0.0, 0.5, vUv.x) * smoothstep(1.0, 0.5, vUv.x);
  float along = smoothstep(0.0, 0.18, vUv.y) * (1.0 - smoothstep(0.35, 1.0, vUv.y));
  float pulse = 0.6 + 0.4 * sin(uTime * 0.45 + vPhase * 6.28);
  float a = across * across * along * pulse * uStrength;
  gl_FragColor = vec4(uCol * 1.4, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function buildGodRays(bag: ResourceBag, rng: () => number): { mesh: THREE.Mesh; update: (t: number) => void } {
  const pos: number[] = [];
  const uv: number[] = [];
  const ph: number[] = [];
  const idx: number[] = [];
  const rays = 7;
  for (let i = 0; i < rays; i++) {
    const topX = -14 + i * 7 + rng() * 5;
    const topY = 34 + rng() * 6;
    const len = 52 + rng() * 14;
    const ang = -0.5 - rng() * 0.12; // leaning toward the lower-left
    const w = 3 + rng() * 5;
    const dx = Math.sin(ang) * len;
    const dy = -Math.cos(ang) * len;
    const z = -26 - rng() * 20;
    const base = pos.length / 3;
    pos.push(topX - w / 2, topY, z, topX + w / 2, topY, z, topX + dx + w * 1.6, topY + dy, z, topX + dx - w * 1.6, topY + dy, z);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    const p = rng();
    ph.push(p, p, p, p);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = bag.geo(new THREE.BufferGeometry());
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aUv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aPhase', new THREE.Float32BufferAttribute(ph, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  const m = bag.mat(
    new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uCol: { value: new THREE.Color(0xfff0d8) }, uStrength: { value: 0.16 } },
      vertexShader: RAY_VERT,
      fragmentShader: RAY_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    }),
  );
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  mesh.renderOrder = -20;
  return { mesh, update: (t: number): void => void ((m.uniforms.uTime as THREE.IUniform<number>).value = t) };
}

// ── birds ────────────────────────────────────────────────────────────────────

class Birds {
  readonly mesh: THREE.InstancedMesh;
  private readonly d = new THREE.Object3D();
  private readonly seeds: Float32Array;
  constructor(bag: ResourceBag, count: number, rng: () => number) {
    const g = bag.geo(new THREE.BufferGeometry());
    const v = new Float32Array([0, 0, 0, -0.95, 0.28, 0, -0.38, -0.04, 0, 0, 0, 0, 0.95, 0.28, 0, 0.38, -0.04, 0]);
    g.setAttribute('position', new THREE.BufferAttribute(v, 3));
    g.computeVertexNormals();
    const m = bag.mat(new THREE.MeshBasicMaterial({ color: 0x4a4868, side: THREE.DoubleSide }));
    this.mesh = new THREE.InstancedMesh(g, m, count);
    this.mesh.frustumCulled = false;
    this.seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      this.seeds[i * 4] = rng();
      this.seeds[i * 4 + 1] = rng();
      this.seeds[i * 4 + 2] = rng();
      this.seeds[i * 4 + 3] = rng();
    }
    this.update(0);
  }
  update(t: number): void {
    const n = this.seeds.length / 4;
    const d = this.d;
    for (let i = 0; i < n; i++) {
      const sx = this.seeds[i * 4];
      const sy = this.seeds[i * 4 + 1];
      const sz = this.seeds[i * 4 + 2];
      const sp = this.seeds[i * 4 + 3];
      // Two loose flocks crossing the sky at different depths and speeds.
      const flock = i < n / 2 ? 0 : 1;
      const speed = flock === 0 ? 2.4 : -1.7;
      const span = 160;
      let x = (((sx * span + t * speed * (0.85 + sp * 0.3) + 80) % span) + span) % span - span / 2;
      x += Math.sin(t * 0.5 + sy * 6) * 2;
      const y = (flock === 0 ? 16 : 6) + sy * 9 + Math.sin(t * 0.8 + sx * 9) * 1.2;
      const z = (flock === 0 ? -44 : -64) - sz * 14;
      d.position.set(x, y, z);
      const flap = Math.sin(t * (7 + sp * 3) + sx * 30);
      d.scale.set((speed > 0 ? 1 : -1) * (1.5 + sp * 0.8), 0.6 + 0.9 * flap, 1);
      d.rotation.z = Math.sin(t * 0.9 + sy * 10) * 0.08;
      d.updateMatrix();
      this.mesh.setMatrixAt(i, d.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ── piece builders ───────────────────────────────────────────────────────────

function column(b: GeoBuilder, x: number, y0: number, z: number, h: number, r: number, broken: boolean, color = C.marble): void {
  b.box(r * 2.6, 0.3, r * 2.6, C.marbleShade, x, y0 + 0.15, z, { ao: 0.3 });
  const segs = Math.max(1, Math.round(h / 1.2));
  const sh = (h - 0.3 - (broken ? 0.3 : 0.55)) / segs;
  for (let i = 0; i < segs; i++) b.cyl(r * 0.9, r, sh, color, x, y0 + 0.3 + sh * (i + 0.5), z, 10, { ao: 0.16, jitter: 0.03 });
  if (!broken) {
    b.box(r * 2.8, 0.26, r * 2.8, C.marbleLight, x, y0 + h - 0.38, z);
    b.box(r * 3.2, 0.26, r * 3.2, color, x, y0 + h - 0.13, z);
  } else {
    b.lump(r * 0.95, C.marbleShade, x + r * 0.15, y0 + h - 0.2, z, { sy: 0.7 });
  }
}

/** An aqueduct arcade (single tier of arches with a channel on top) spanning [x0, x1] at depth z. */
function aqueduct(b: GeoBuilder, bag: ResourceBag, x0: number, x1: number, y0: number, z: number, h: number, bay: number, gaps: number[] = [], far = false): void {
  const w = x1 - x0;
  const n = Math.max(1, Math.round(w / bay));
  const bw = w / n;
  const depth = 1.7;
  // wall block with arches carved as dark recesses on the front; piers between
  b.box(w, h, depth, C.marble, (x0 + x1) / 2, y0 + h / 2, z, { ao: 0.25, jitter: 0.02 });
  for (let i = 0; i <= n; i++) b.box(0.6, h + 0.05, depth + 0.3, C.marbleLight, x0 + bw * i, y0 + h / 2, z + 0.03, { ao: 0.2, jitter: 0.04 });
  for (let i = 0; i < n; i++) {
    if (gaps.includes(i)) continue;
    const ag = archGeo(bw - 1.0, h - 0.8);
    bag.geo(ag);
    b.add(ag, far ? 0x8d97b8 : C.recess, x0 + bw * (i + 0.5), y0, z + depth / 2 + 0.1, { jitter: 0.02 });
    const ag2 = archGeo(bw - 1.3, h - 1.1);
    bag.geo(ag2);
    b.add(ag2, far ? 0x6f7aa0 : C.recessDeep, x0 + bw * (i + 0.5), y0, z + depth / 2 + 0.13, { jitter: 0.02 });
  }
  // channel on top: two parapets + (emissive) water line is added by the caller as a glow strip
  b.box(w + 0.3, 0.45, depth + 0.5, C.marbleLight, (x0 + x1) / 2, y0 + h + 0.22, z, { ao: 0.2 });
  b.box(w, 0.4, 0.25, C.marble, (x0 + x1) / 2, y0 + h + 0.65, z + depth / 2 + 0.05, { ao: 0.2 });
  b.box(w, 0.25, 0.25, C.marble, (x0 + x1) / 2, y0 + h + 0.57, z - depth / 2 - 0.05, { ao: 0.2 });
}

function softSlab(rng: () => number, w: number, kind: 'small' | 'high' | 'drifter'): THREE.BufferGeometry | null {
  const b = new GeoBuilder(rng);
  b.box(w, 0.2, 1.8, C.marbleLight, 0, -0.1, 0, { jitter: 0.02, ao: 0.1 });
  b.box(w * 0.94, 0.24, 1.5, C.marble, 0, -0.32, 0, { jitter: 0.03, ao: 0.35 });
  b.box(w * 0.7, 0.28, 1.2, C.marbleShade, 0.1, -0.56, 0, { jitter: 0.04, ao: 0.5 });
  // teal trim along the front edge marks the pass-through surface
  b.box(w * 0.98, 0.06, 0.07, C.teal, 0, -0.02, FRONT_Z * 0.34 + 0.0, { jitter: 0 });
  b.box(w * 0.98, 0.05, 0.06, C.tealDark, 0, -0.03, -0.9, { jitter: 0 });
  for (const s of [-1, 1]) b.box(0.22, 0.14, 1.85, C.gold, s * (w / 2 - 0.1), -0.08, 0, { jitter: 0 });
  b.cone(w * 0.28, 1.1, C.rock, 0, -1.15, 0, 6, { rx: Math.PI, ao: 0.5, ry: 0.4 });
  b.lump(0.26, C.rockDark, -w * 0.3, -0.8, 0.2, {});
  b.lump(0.2, C.rockLight, w * 0.32, -0.7, -0.1, {});
  if (kind === 'high') {
    // little broken columns at the ends (behind the fighters)
    column(b, -w / 2 + 0.7, 0, -0.9, 2.3, 0.28, false);
    column(b, w / 2 - 0.7, 0, -0.9, 1.5, 0.28, true);
    b.box(w - 1.2, 0.25, 0.5, C.marble, 0, 2.2, -0.9, { rz: 0.03 });
  }
  if (kind === 'small') {
    for (const s of [-1, 1]) {
      b.box(0.04, 1.0, 0.04, C.vine, s * w * 0.3, -1.0, 0.5, { jitter: 0.1 });
      b.lump(0.1, C.vine, s * w * 0.3, -1.5, 0.5, {});
    }
  }
  return b.build();
}

/** A solid aqueduct island: grass-lipped stone, an arcade cliff face, rock underside, hanging crystals. */
function islandGeo(rng: () => number, bag: ResourceBag, w: number, th: number, mirror: number): THREE.BufferGeometry | null {
  const b = new GeoBuilder(rng);
  const midZ = (FRONT_Z + BACK_Z) / 2;
  const depth = FRONT_Z - BACK_Z;
  // top
  b.box(w, 0.5, depth, C.grass, 0, -0.25, midZ, { ao: 0.12, jitter: 0.02 });
  b.box(w - 0.2, 0.03, depth - 0.2, C.grassLight, 0, 0.005, midZ, { jitter: 0.03 });
  for (let i = 0; i < 14; i++) {
    const gx = (rng() - 0.5) * (w - 1);
    const gz = BACK_Z + 0.6 + rng() * (depth - 1.2);
    b.cone(0.1 + rng() * 0.08, 0.25 + rng() * 0.2, rng() < 0.5 ? C.grassDark : C.grassLight, gx, 0.12, gz, 5, { jitter: 0.1 });
  }
  // grass lip hanging over the front
  b.box(w + 0.35, 0.34, 0.6, C.grass, 0, -0.5, FRONT_Z + 0.1, { ao: 0.2, jitter: 0.02 });
  for (let i = 0; i < 12; i++) {
    const gx = (-w / 2 + 0.5) + ((w - 1) / 11) * i + (rng() - 0.5) * 0.3;
    b.cone(0.16, 0.5 + rng() * 0.4, C.grassDark, gx, -0.95, FRONT_Z + 0.25, 5, { rx: Math.PI, jitter: 0.1 });
  }
  // cliff face: marble cornice + arcade blocks + arches
  const wallH = th - 0.55;
  b.box(w, wallH, 1.2, C.stone, 0, -0.55 - wallH / 2, FRONT_Z - 0.6, { ao: 0.32, jitter: 0.02 });
  b.box(w + 0.2, 0.3, 1.4, C.marbleLight, 0, -0.62, FRONT_Z - 0.55, { jitter: 0.02 });
  const bays = Math.round(w / 2.5);
  const bw = w / bays;
  for (let i = 0; i <= bays; i++) b.box(0.5, wallH + 0.05, 0.5, C.marble, -w / 2 + bw * i, -0.55 - wallH / 2, FRONT_Z + 0.02, { ao: 0.22, jitter: 0.04 });
  for (let i = 0; i < bays; i++) {
    const ag = archGeo(bw - 0.9, wallH - 0.5);
    bag.geo(ag);
    b.add(ag, C.recess, -w / 2 + bw * (i + 0.5), -th + 0.05, FRONT_Z + 0.06, { jitter: 0.02 });
    const ag2 = archGeo(bw - 1.2, wallH - 0.8);
    bag.geo(ag2);
    b.add(ag2, C.recessDeep, -w / 2 + bw * (i + 0.5), -th + 0.05, FRONT_Z + 0.09, { jitter: 0.02 });
  }
  // gold ledge caps (the two ledge corners read clearly)
  for (const s of [-1, 1]) {
    b.box(0.5, 0.2, depth + 0.2, C.gold, s * (w / 2 - 0.1), 0.0, midZ, { jitter: 0 });
    b.box(0.28, wallH + 0.3, 0.28, C.gold, s * (w / 2), -0.55 - wallH / 2, FRONT_Z + 0.05, { jitter: 0.02 });
  }
  // underside: stepped ledges then a hanging cone, with a few boulders and crystals
  b.box(w - 1.0, 1.2, depth - 0.8, C.rockDark, 0, -th - 0.6, midZ, { ao: 0.5 });
  b.box(w - 3.2, 1.4, depth - 1.6, C.rock, 0.3 * mirror, -th - 1.9, midZ - 0.2, { ao: 0.5 });
  b.cone(w * 0.36, 9, C.rock, 0, -th - 6.2, midZ - 0.2, 7, { rx: Math.PI, ao: 0.55, jitter: 0.04, ry: 0.4 });
  b.cone(w * 0.16, 6, C.rockDark, -w * 0.28 * mirror, -th - 4.6, -0.3, 6, { rx: Math.PI, ao: 0.5, ry: 1.1 });
  b.cone(w * 0.12, 5, C.rockLight, w * 0.3 * mirror, -th - 4.2, 0.2, 6, { rx: Math.PI, ao: 0.5, ry: 2.0 });
  for (let i = 0; i < 8; i++) {
    b.lump(0.4 + rng() * 0.7, i % 2 === 0 ? C.rock : C.rockLight, (rng() - 0.5) * (w - 2), -th - 0.8 - rng() * 2.4, FRONT_Z - 0.3 - rng() * 1.8, { sy: 1.1, jitter: 0.08 });
  }
  for (let i = 0; i < 5; i++) {
    const cx = (rng() - 0.5) * (w - 3);
    b.cone(0.16, 0.9 + rng() * 0.8, C.teal, cx, -th - 1.3 - rng() * 1.4, FRONT_Z - 0.5 - rng(), 5, { rx: Math.PI, jitter: 0.06, rz: (rng() - 0.5) * 0.4 });
  }
  for (let i = 0; i < 7; i++) {
    const vx = (rng() - 0.5) * (w - 1);
    const vl = 1.1 + rng() * 2.4;
    b.box(0.06, vl, 0.06, C.vine, vx, -th - vl / 2 - 0.05, FRONT_Z - 0.1, { jitter: 0.12 });
  }
  return b.build();
}

// ── the stage ───────────────────────────────────────────────────────────────

export function buildSkyAqueduct(def: StageDef, tier: QualityTier = 'high'): StageVisual {
  const bag = new ResourceBag();
  const group = new THREE.Group();
  group.name = 'stage-skyAqueduct';
  const rng = mulberry32(0x5a1d0ce5);
  const stone = bag.mat(stoneMaterial(0.9));
  const glowTex = bag.tex(softDiscTexture(64, 1.5));
  const platforms: PlatformVisual[] = [];
  let drawables = 0;

  const sky = new SkyDome(bag, {
    top: 0x3552a4,
    mid: 0x839de6,
    horizon: 0xffbfa6,
    bottom: 0xf0d2d6,
    sunColor: 0xffe0c8,
    sunDir: [0.42, 0.07, -1],
    sunSize: 1500,
    glow: 0.55,
    cloudLit: 0xfff1ea,
    cloudShade: 0xc9a6c4,
    clouds: 1,
    horizonY: -0.14,
  });
  group.add(sky.mesh);

  // ── platforms: islands (solid) and marble slabs (soft) ──
  for (const p of def.platforms) {
    const g = new THREE.Group();
    g.name = `plat-${p.id}`;
    const cx = (p.x0 + p.x1) / 2;
    g.position.set(cx, p.y, 0);
    const w = p.x1 - p.x0;
    if (p.kind === 'solid') {
      bakeMesh(bag, g, islandGeo(mulberry32(p.id.length * 131 + 5), bag, w, p.thickness, cx < 0 ? -1 : 1), stone, `island-${p.id}`);
      drawables++;
    } else {
      const kind = p.id === 'high' ? 'high' : p.moving !== undefined ? 'drifter' : 'small';
      bakeMesh(bag, g, softSlab(mulberry32(p.id.length * 71 + 9), w, kind), stone, `slab-${p.id}`);
      drawables++;
    }
    group.add(g);
    platforms.push({ id: p.id, group: g, x0: p.x0, y: p.y, moving: p.moving !== undefined });
  }

  // ── aqueduct arcades behind the fight (static) ──
  const back = new GeoBuilder(rng);
  const isl = def.platforms.filter((p) => p.kind === 'solid');
  const channelY = 3.15;
  const channelEnds: { x: number; dir: number }[] = [];
  for (const p of isl) {
    const left = p.x0 < 0;
    // the arcade runs along the island's back edge and continues a little past the OUTER end as a broken span
    const x0 = p.x0 + (left ? 0.6 : 0.6);
    const x1 = p.x1 - 0.6;
    aqueduct(back, bag, x0, x1, 0, -3.9, channelY, 2.3, []);
    channelEnds.push({ x: left ? x0 : x1, dir: left ? -1 : 1 });
    channelEnds.push({ x: left ? x1 : x0, dir: left ? 1 : -1 });
  }
  // a tall far aqueduct spanning the gap behind everything, broken in the middle
  aqueduct(back, bag, -40, -16, 7, -34, 7.5, 3.4, [3], true);
  back.cone(11, 9, C.rock, -28, 2.5, -34, 7, { rx: Math.PI, ao: 0.55 });
  aqueduct(back, bag, 15, 39, 5, -36, 7.5, 3.4, [2, 3], true);
  back.cone(10, 8, C.rock, 27, 1.0, -36, 7, { rx: Math.PI, ao: 0.55 });
  column(back, -8.5, 0, -6.2, 6.5, 0.45, false);
  column(back, 8.8, 0, -6.4, 4.4, 0.45, true);
  column(back, -2.2, 0, -7.4, 3.2, 0.4, true);
  const backMesh = bakeMesh(bag, group, back.build(), stone, 'aqueducts');
  drawables++;
  if (backMesh !== null) backMesh.frustumCulled = false;

  // bright water line in the channels (emissive strip)
  const waterMat = bag.mat(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 0.75, 0.95).multiplyScalar(1.5), fog: false }));
  const waterGeo = bag.geo(new THREE.BoxGeometry(1, 0.16, 0.9));
  for (const p of isl) {
    const m = new THREE.Mesh(waterGeo, waterMat);
    m.scale.set(p.x1 - p.x0 - 1.4, 1, 1);
    m.position.set((p.x0 + p.x1) / 2, channelY + 0.62, -3.9);
    group.add(m);
    drawables++;
  }

  // ── waterfalls spilling off the channel ends ──
  const falls: { update: (t: number) => void; mesh: THREE.Mesh }[] = [];
  const mistSprites: { s: THREE.Sprite; base: number; ph: number }[] = [];
  const mistMat = bag.mat(new THREE.SpriteMaterial({ map: glowTex, color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false, fog: false }));
  for (const e of channelEnds) {
    const wf = makeWaterfall(bag, 1.5, 34, 0x4fc8e0, 0xeefcff);
    wf.mesh.position.set(e.x + e.dir * 0.2, channelY + 0.45, -3.4);
    group.add(wf.mesh);
    falls.push(wf);
    drawables++;
    for (let k = 0; k < 3; k++) {
      const s = new THREE.Sprite(mistMat);
      const sx = e.x + e.dir * 0.2 + (k - 1) * 1.3;
      s.position.set(sx, -29 + k * 0.8, -3.2);
      const base = 7 + k * 2;
      s.scale.set(base * 1.5, base, 1);
      group.add(s);
      mistSprites.push({ s, base, ph: rng() * 6.28 });
      drawables++;
    }
  }

  // ── floating ruins (bobbing) ──
  const ruins: { g: THREE.Group; ph: number; amp: number; y0: number; rot: number }[] = [];
  const ruinSpots: [number, number, number, number][] = [
    [-21, 8, -10, 1.0],
    [22, 13, -14, 1.2],
    [-9, -13, -9, 0.9],
    [10, -15, -12, 1.1],
    [-30, -2, -22, 1.5],
    [31, 3, -26, 1.6],
  ];
  for (const [rx, ry, rz, sc] of ruinSpots) {
    const rb = new GeoBuilder(rng);
    rb.box(3.4 * sc, 0.6 * sc, 2.4 * sc, C.stone, 0, 0, 0, { ao: 0.3, rz: (rng() - 0.5) * 0.2, jitter: 0.06 });
    rb.cone(1.5 * sc, 2.4 * sc, C.rock, 0, -1.4 * sc, 0, 6, { rx: Math.PI, ao: 0.5 });
    rb.box(3.2 * sc, 0.2 * sc, 2.2 * sc, C.grass, 0, 0.38 * sc, 0, { jitter: 0.04 });
    if (rng() < 0.8) column(rb, -0.7 * sc, 0.3 * sc, 0, 2.4 * sc, 0.28 * sc, rng() < 0.5);
    if (rng() < 0.6) column(rb, 0.8 * sc, 0.3 * sc, 0.1, 1.5 * sc, 0.26 * sc, true);
    const rg = new THREE.Group();
    bakeMesh(bag, rg, rb.build(), stone, 'ruin');
    rg.position.set(rx, ry, rz);
    group.add(rg);
    ruins.push({ g: rg, ph: rng() * 6.28, amp: 0.3 + rng() * 0.3, y0: ry, rot: (rng() - 0.5) * 0.14 });
    drawables++;
  }

  // ── distant floating islands in the haze ──
  const farB = new GeoBuilder(rng);
  const farIslands: [number, number, number, number][] = [
    [-52, -6, -78, 1.6],
    [46, 4, -92, 1.9],
    [4, -12, -118, 2.4],
    [-96, 14, -126, 2.0],
    [88, -10, -112, 2.1],
  ];
  for (const [fx, fy, fz, sc] of farIslands) {
    farB.box(9 * sc, 1.0 * sc, 5 * sc, C.grassDark, fx, fy, fz, { jitter: 0.05 });
    farB.cone(4.2 * sc, 8 * sc, C.rock, fx, fy - 4.5 * sc, fz, 7, { rx: Math.PI, ao: 0.5, ry: fx });
    farB.box(2.4 * sc, 1.6 * sc, 1.8 * sc, C.marble, fx + 1.2 * sc, fy + 1.3 * sc, fz, { ao: 0.2 });
    farB.cone(1.7 * sc, 1.0 * sc, C.recess, fx + 1.2 * sc, fy + 2.6 * sc, fz, 4, { ry: 0.78 });
    column(farB, fx - 2.2 * sc, fy + 0.5 * sc, fz + 0.5, 2.6 * sc, 0.25 * sc, false);
  }
  bakeMesh(bag, group, farB.build(), stone, 'far-islands');
  drawables++;

  // ── clouds (parallax layers) ──
  const cloudsHigh = new CloudLayer(bag, glowTex, {
    count: 26,
    cx: 0,
    span: 340,
    y0: 12,
    y1: 30,
    z: -130,
    sizeMin: 30,
    sizeMax: 52,
    speed: 0.5,
    colorTop: 0xfff0ec,
    colorBottom: 0xd8b8d4,
    opacity: 0.55,
    seed: 4,
  });
  const cloudsFar = new CloudLayer(bag, glowTex, {
    count: 44,
    cx: 0,
    span: 320,
    y0: -34,
    y1: -4,
    z: -100,
    sizeMin: 30,
    sizeMax: 56,
    speed: 0.45,
    colorTop: 0xfff2ee,
    colorBottom: 0xcdb0d2,
    opacity: 0.8,
    seed: 17,
  });
  const cloudsMid = new CloudLayer(bag, glowTex, {
    count: 44,
    cx: 0,
    span: 240,
    y0: -32,
    y1: -12,
    z: -58,
    sizeMin: 22,
    sizeMax: 40,
    speed: 0.8,
    colorTop: 0xffeae6,
    colorBottom: 0xc7a6cc,
    opacity: 0.85,
    seed: 29,
  });
  const cloudsNear = new CloudLayer(bag, glowTex, {
    count: 34,
    cx: 0,
    span: 160,
    y0: -34,
    y1: -20,
    z: -26,
    sizeMin: 18,
    sizeMax: 32,
    speed: 1.2,
    colorTop: 0xffeef0,
    colorBottom: 0xbd9fc6,
    opacity: 0.9,
    seed: 41,
  });
  cloudsHigh.mesh.renderOrder = -70;
  cloudsFar.mesh.renderOrder = -60;
  cloudsMid.mesh.renderOrder = -50;
  cloudsNear.mesh.renderOrder = -40;
  group.add(cloudsHigh.mesh, cloudsFar.mesh, cloudsMid.mesh, cloudsNear.mesh);
  drawables += 4;

  // ── god-rays, birds, motes ──
  const rays = buildGodRays(bag, rng);
  group.add(rays.mesh);
  const birds = new Birds(bag, 12, rng);
  group.add(birds.mesh);
  const pollen = new Motes(bag, {
    count: 120,
    cx: 0,
    cy: 5,
    cz: -3,
    hx: 24,
    hy: 11,
    hz: 6,
    speed: 0.35,
    sway: 1.2,
    size: 4.2,
    colorA: 0xfff0d0,
    colorB: 0xbfefff,
    boost: 1.3,
    seed: 13,
  });
  group.add(pollen.points);
  drawables += 3;

  const blast = buildBlastTelegraph(bag, def, 0xff5a50);
  group.add(blast.mesh);
  drawables += 2;

  let curTier: QualityTier = tier;
  const apply = (t: QualityTier): void => {
    curTier = t;
    const prof = tierProfile(t);
    const lo = t === 'low';
    const hi = t === 'high';
    cloudsHigh.mesh.visible = !lo;
    cloudsFar.mesh.visible = !lo;
    rays.mesh.visible = prof.lightShafts;
    birds.mesh.visible = !lo;
    pollen.setDensity(lo ? 0.3 : hi ? 1 : 0.6);
    for (const f of falls) f.mesh.visible = true;
    sky.setClouds(prof.skyClouds);
  };
  apply(tier);

  const update = (pf: readonly PlatformState[], dt: number, time: number, cam: THREE.Camera): void => {
    void dt;
    syncPlatforms(platforms, pf);
    sky.update(cam, time);
    for (const r of ruins) {
      r.g.position.y = r.y0 + Math.sin(time * 0.55 + r.ph) * r.amp;
      r.g.rotation.z = Math.sin(time * 0.3 + r.ph) * r.rot;
    }
    for (const f of falls) f.update(time);
    for (const m of mistSprites) {
      const k = 0.9 + 0.1 * Math.sin(time * 0.9 + m.ph);
      m.s.scale.set(m.base * 1.5 * k, m.base * k, 1);
    }
    cloudsNear.update(time, 0);
    cloudsMid.update(time, 0);
    if (curTier !== 'low') {
      cloudsFar.update(time, 0);
      cloudsHigh.update(time, 0);
      birds.update(time);
    }
    rays.update(time);
    pollen.update(time);
    blast.update(time);
  };

  return {
    group,
    setup: SETUP,
    update,
    setTier: apply,
    countDrawables: () => drawables,
    dispose: () => {
      group.removeFromParent();
      for (const c of [cloudsHigh, cloudsFar, cloudsMid, cloudsNear]) c.mesh.dispose();
      birds.mesh.dispose();
      bag.dispose();
    },
  };
}
