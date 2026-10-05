/**
 * Crumbling Amphitheatre (v1.6, docs/CL-MAPS-PLAN.md map 4): the torch-lit interior of a ruined arena — tiers of seats and arches,
 * braziers, a broken colossus, a hypogeum shaft under the floor — that transforms when its last breakable piece falls.
 *
 * PERSISTENT state is derived every frame from `snapshot.platforms[].active / hp / maxHp` (never from events), so a rollback or a late join
 * can never leave the scene wrong:
 *   - a piece is drawn only while `active`; its crack stage (0..3) comes from `hp / maxHp` and swaps a pre-baked geometry (no extra draws);
 *   - `finalOnly` platforms are ghosted (faint gold outlines) until they are active, then RISE in with a glow flare;
 *   - the FINAL-FORM look (`finalK` 0..1: night -> dawn sky, torches flip to blue-white, warm light, god-rays, dawn motes) is a smooth
 *     function of "any finalOnly platform active", snapped on the first frame when joining a match already in its final form.
 * One-off effects ride on the cosmetic events (`onEvents`): dust + chips on every counted hit, a 3D chunk burst + dust + rumble on a
 * break, a white-gold shockwave + flash + big rumble on `stageFinal`.
 */

import * as THREE from 'three';
import { mulberry32 } from '../../../core/math';
import type { BrawlEvent, PlatformDef, PlatformState, StageDef } from '../../types';
import { tierProfile, type QualityTier } from '../../../render/quality';
import { ChunkPool } from './chunkPool';
import {
  GeoBuilder,
  Motes,
  ResourceBag,
  SkyDome,
  archGeo,
  bakeMesh,
  buildBlastTelegraph,
  softDiscTexture,
  stoneMaterial,
  type SkyParams,
  type StageFxCtx,
  type StageLights,
  type StageSetup,
  type StageVisual,
} from './common';
import { AC, CHUNK_COLORS, buildPiece } from './crumbleParts';
import { crackStage, finalFormReached, isActive } from './dynamic';
import { buildGodRays } from './skyAqueduct';

// ── look tables ──────────────────────────────────────────────────────────────

const SETUP: StageSetup = {
  fog: { color: 0x1a1534, near: 22, far: 150 },
  hemi: { sky: 0x6474c8, ground: 0x34262e, intensity: 0.8 },
  key: { color: 0xffb070, intensity: 1.85, pos: [-16, 12, 22] },
  rim: { color: 0x6a8cff, intensity: 1.5, pos: [20, 12, -14] },
  exposure: 1.05,
  grade: { tint: [1.03, 1.0, 0.95], vignette: 0.4, sat: 1.12 },
  shadow: 0x120a10,
};

/** The dawn the arena flips to (lerped in by `finalK`). */
const DAWN = {
  fog: 0xf0c6a6,
  fogNear: 46,
  fogFar: 260,
  hemiSky: 0xd0e0ff,
  hemiGround: 0xc89a78,
  hemiI: 1.08,
  key: 0xfff0d2,
  keyI: 2.9,
  keyPos: [-18, 15, 22] as const,
  rim: 0xffd2a4,
  rimI: 1.5,
  exposure: 1.1,
  tint: [1.03, 1.0, 0.95] as const,
  vignette: 0.3,
  sat: 1.2,
};

const NIGHT_SKY: SkyParams = {
  top: 0x070a26,
  mid: 0x141b4e,
  horizon: 0x3c2c5c,
  bottom: 0x1a1230,
  sunColor: 0xcfdcff,
  sunDir: [0.3, 0.12, -1],
  sunSize: 2200,
  glow: 0.35,
  cloudLit: 0x4a4a86,
  cloudShade: 0x1c1b40,
  clouds: 0.8,
  horizonY: -0.14,
};

const DAWN_SKY: SkyParams = {
  top: 0x6d93e0,
  mid: 0xe8a8b0,
  horizon: 0xffc88e,
  bottom: 0xffe2b4,
  sunColor: 0xffd890,
  sunDir: [-0.12, 0.02, -1],
  sunSize: 420,
  glow: 1,
  cloudLit: 0xfff0dc,
  cloudShade: 0xd69aa8,
  clouds: 1,
  horizonY: -0.14,
};

interface Torch {
  x: number;
  y: number;
  z: number;
  s: number;
  ph: number;
}

const TORCHES: Torch[] = [
  { x: -15.5, y: 2.1, z: -1.8, s: 1.3, ph: 0.0 },
  { x: 15.5, y: 2.1, z: -1.8, s: 1.3, ph: 1.7 },
  { x: -6.2, y: 4.9, z: -3.0, s: 0.9, ph: 3.1 },
  { x: 6.2, y: 4.9, z: -3.0, s: 0.9, ph: 4.4 },
  { x: -24, y: 4.9, z: -3.0, s: 1.0, ph: 0.8 },
  { x: 24, y: 4.9, z: -3.0, s: 1.0, ph: 2.6 },
  { x: -11, y: 13.2, z: -22, s: 1.4, ph: 5.2 },
  { x: 11, y: 13.2, z: -22, s: 1.4, ph: 3.9 },
];

const WALL_Z = -3.5;

// ── backdrop geometry ────────────────────────────────────────────────────────

function arch(b: GeoBuilder, w: number, h: number, color: number, x: number, y: number, z: number): void {
  const g = archGeo(w, h);
  b.add(g, color, x, y, z, { jitter: 0.02 });
  g.dispose();
}

/** Inner arena wall (arches at floor level), the hypogeum shaft below the floor, and the braziers' stands. */
function wallGeo(rng: () => number): THREE.BufferGeometry | null {
  const b = new GeoBuilder(rng);
  const layers: [number, number, number][] = [
    [-36, -16, 0x16111c],
    [-16, -7, 0x241b25],
    [-7, 0, 0x30262a],
    [0, 4.2, 0x54463f],
  ];
  for (const [y0, y1, c] of layers) b.box(110, y1 - y0, 1.6, c, 0, (y0 + y1) / 2, WALL_Z - 0.8, { jitter: 0.02 });
  b.box(110, 0.55, 2.2, AC.stoneLight, 0, 4.45, WALL_Z - 0.6, { jitter: 0.02 });
  for (let x = -52; x <= 52; x += 6.6) {
    arch(b, 4.4, 3.7, 0x120d17, x, 0.25, WALL_Z + 0.04);
    arch(b, 3.5, 3.1, 0x0a070d, x, 0.25, WALL_Z + 0.07);
    b.box(0.8, 4.2, 0.5, AC.stoneDark, x + 3.3, 2.1, WALL_Z + 0.1, { ao: 0.2, jitter: 0.04 });
    // hypogeum arcade below the floor (the pits look into this)
    arch(b, 5.2, 4.6, 0x0c0910, x, -8.8, WALL_Z + 0.04);
    arch(b, 5.2, 3.2, 0x08060b, x, -17.2, WALL_Z + 0.04);
    b.box(0.9, 5.6, 0.5, 0x2a2128, x + 3.3, -6.2, WALL_Z + 0.1, { jitter: 0.04 });
  }
  // braziers: iron bowl on a stone stand, in front of the wall, flanking the arena
  for (const t of TORCHES.slice(0, 2)) {
    b.cyl(0.5, 0.7, 1.6, AC.stoneDark, t.x, 0.8, t.z, 8, { ao: 0.3 });
    b.cyl(0.9, 0.55, 0.5, AC.iron, t.x, 1.75, t.z, 10, { jitter: 0.02 });
    b.cyl(0.95, 0.95, 0.12, AC.gold, t.x, 2.0, t.z, 10, { jitter: 0 });
  }
  // wall sconces
  for (const t of TORCHES.slice(2, 6)) {
    b.box(0.3, 0.9, 0.3, AC.iron, t.x, t.y - 0.6, t.z, { jitter: 0 });
    b.cyl(0.32, 0.22, 0.3, AC.iron, t.x, t.y - 0.1, t.z, 7, { jitter: 0 });
  }
  return b.build();
}

/** Curved-looking stepped seating (collapsed gaps, aisles, benches) rising behind the wall. */
function seatingGeo(rng: () => number): THREE.BufferGeometry | null {
  const b = new GeoBuilder(rng);
  const seg = 8;
  for (let t = 0; t < 7; t++) {
    const zc = -6.4 - t * 2.3;
    const yTop = 4.6 + t * 1.2;
    const tone = 0x625247 - t * 0x020202;
    for (let x = -56; x < 56; x += seg) {
      if (t >= 2 && rng() < 0.12) continue; // a collapsed section
      b.box(seg - 0.05, 1.3, 2.3, tone, x + seg / 2, yTop - 0.65, zc, { ao: 0.3, jitter: 0.04 });
      b.box(seg - 0.05, yTop + 8, 2.0, 0x2a2128, x + seg / 2, (yTop - 1.3 - 8) / 2, zc - 0.1, { ao: 0.5 });
      for (let k = 0; k < 5; k++) {
        if (rng() < 0.12) continue;
        b.box(0.95, 0.42, 0.62, k % 2 === 0 ? 0x9a8873 : 0x86745f, x + 0.9 + k * 1.55, yTop + 0.2, zc - 0.2, { jitter: 0.05 });
      }
      if (Math.round(x / seg) % 2 === 0) b.box(0.9, 0.06, 2.3, 0x2a2128, x, yTop + 0.01, zc, { jitter: 0 });
    }
  }
  return b.build();
}

/** The ruined upper arcade (broken columns, lintels with sky between them) and the two end towers. */
function arcadeGeo(rng: () => number): THREE.BufferGeometry | null {
  const b = new GeoBuilder(rng);
  const z = -23.5;
  const baseY = 11.9;
  const cols: number[] = [];
  for (let x = -49; x <= 49; x += 5.2) {
    const full = rng() > 0.35;
    const h = full ? 4.2 : 1.2 + rng() * 2.4;
    cols.push(full ? 1 : 0);
    b.box(1.5, 0.5, 1.5, AC.stoneDark, x, baseY + 0.25, z, { ao: 0.3 });
    b.cyl(0.55, 0.65, h, 0x6e5f58, x, baseY + 0.5 + h / 2, z, 9, { ao: 0.2, jitter: 0.04 });
    if (full) b.box(1.4, 0.4, 1.4, AC.stoneLight, x, baseY + 0.5 + h + 0.2, z, { jitter: 0.03 });
    else b.lump(0.7, AC.stoneDark, x + 0.1, baseY + 0.5 + h, z, { sy: 0.7 });
  }
  for (let i = 1; i < cols.length; i++) {
    if (cols[i] === 1 && cols[i - 1] === 1 && rng() > 0.25) b.box(4.4, 0.8, 1.3, 0x75675c, -49 + (i - 0.5) * 5.2, baseY + 5.1, z, { ao: 0.2, jitter: 0.03 });
  }
  for (const s of [-1, 1]) {
    const x = s * 45;
    b.box(11, 22, 8, 0x4f4343, x, 7, -14, { ao: 0.4, ry: s * 0.35 });
    for (let k = 0; k < 3; k++) arch(b, 2.2, 4.2, 0x0e0a12, x - s * 2 + k * 0.01, 9 + k * 4.4 - 4, -9.5);
    b.lump(4.2, AC.stoneDark, x - s * 1.5, 18.6, -14, { sy: 0.6 });
  }
  return b.build();
}

/** A broken colossus standing far behind the seating: legs, kilt, torso, one raised arm snapped at the elbow, a headless neck. */
function colossusGeo(rng: () => number): THREE.BufferGeometry | null {
  const b = new GeoBuilder(rng);
  const X = 27;
  const Z = -44;
  const F = -9;
  const c = 0x6b5f78;
  const cl = 0x82768f;
  const cd = 0x4a4258;
  for (const s of [-1, 1]) {
    b.cyl(2.7, 3.0, 10, c, X + s * 3.4, F + 5.4, Z, 9, { ao: 0.3, jitter: 0.03 });
    b.box(6.2, 1.8, 8, cd, X + s * 3.4, F + 0.9, Z + 1.4, { ao: 0.3 });
  }
  b.box(12.5, 4, 6.4, cl, X, F + 12.2, Z, { ao: 0.3, jitter: 0.03 });
  b.box(13, 0.9, 6.8, AC.goldDark, X, F + 14.4, Z, { jitter: 0 });
  b.box(13.4, 10, 5.8, c, X, F + 19.6, Z, { ao: 0.25, jitter: 0.03 });
  b.lump(4.2, cl, X, F + 21.4, Z + 2.4, { sy: 0.75 }, 1);
  for (const s of [-1, 1]) b.box(4.4, 4.4, 4.6, cl, X + s * 8.7, F + 23.4, Z, { ao: 0.3, jitter: 0.03 });
  b.box(3.5, 9.5, 3.7, c, X + 10.2, F + 17.6, Z, { ao: 0.3, rz: -0.07 });
  b.box(3.4, 6.8, 3.6, c, X - 11.4, F + 27.2, Z, { ao: 0.3, rz: 0.55 });
  for (let i = 0; i < 5; i++) b.lump(1.2 + rng() * 0.8, cd, X - 13.6 + rng() * 2, F + 30.2 + rng() * 1.6, Z + (rng() - 0.5) * 2, { sy: 0.9 });
  b.cyl(1.9, 2.3, 2.6, c, X, F + 26.1, Z, 8, { ao: 0.2 });
  for (let i = 0; i < 4; i++) b.cone(0.9, 1.6 + rng(), cd, X - 1.2 + i * 0.8, F + 28 + rng() * 0.4, Z, 4, { jitter: 0.05 });
  // the fallen head at the foot of the statue
  b.lump(4.4, cl, X - 17, F + 3.6, Z + 9, { sy: 0.95 }, 1);
  b.box(1.1, 2.4, 1.6, cl, X - 17, F + 3.2, Z + 12.8, { rz: 0.1 });
  return b.build();
}

// ── the stage ───────────────────────────────────────────────────────────────

interface Piece {
  def: PlatformDef;
  idx: number;
  group: THREE.Group;
  mesh: THREE.Mesh;
  glowMesh: THREE.Mesh | null;
  glowMat: THREE.MeshBasicMaterial | null;
  /** Baked geometry per crack stage (lazily built; index 0 always present). */
  geos: (THREE.BufferGeometry | null)[];
  stage: number;
  active: boolean;
  jolt: number;
  delay: number;
  rise: number;
  phase: number;
}

interface Cap {
  piece: number;
  side: -1 | 1;
  k: number;
}

const _c1 = new THREE.Color();
const _c2 = new THREE.Color();

function smooth(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

export function buildCrumblingAmphitheatre(def: StageDef, tier: QualityTier = 'high'): StageVisual {
  const bag = new ResourceBag();
  const group = new THREE.Group();
  group.name = 'stage-crumblingAmphitheatre';
  const rng = mulberry32(0xa3b7c1d9);
  const stone = bag.mat(stoneMaterial(0.9));
  const glowTex = bag.tex(softDiscTexture(64, 1.5));
  let drawables = 0;

  const sky = new SkyDome(bag, NIGHT_SKY);
  group.add(sky.mesh);

  // ── backdrop (static, merged) ──
  bakeMesh(bag, group, wallGeo(rng), stone, 'arena-wall');
  bakeMesh(bag, group, seatingGeo(rng), stone, 'seating');
  const arcade = bakeMesh(bag, group, arcadeGeo(rng), stone, 'arcade');
  const colossus = bakeMesh(bag, group, colossusGeo(rng), stone, 'colossus');
  drawables += 4;
  if (arcade !== null) arcade.frustumCulled = false;
  if (colossus !== null) colossus.frustumCulled = false;

  // ── platform pieces ──
  const pieces: Piece[] = [];
  const goldMatProto = new THREE.Color(1.6, 1.15, 0.5);
  const finals = def.platforms.filter((p) => p.finalOnly === true);
  def.platforms.forEach((p, idx) => {
    const g = new THREE.Group();
    g.name = `plat-${p.id}`;
    g.position.set((p.x0 + p.x1) / 2, p.y, 0);
    const first = buildPiece(p, 0);
    if (first.body !== null) bag.geo(first.body);
    const mesh = new THREE.Mesh(first.body ?? new THREE.BufferGeometry(), stone);
    mesh.name = `body-${p.id}`;
    g.add(mesh);
    drawables++;
    let glowMesh: THREE.Mesh | null = null;
    let glowMat: THREE.MeshBasicMaterial | null = null;
    if (first.glow !== null) {
      bag.geo(first.glow);
      glowMat = bag.mat(new THREE.MeshBasicMaterial({ color: goldMatProto.clone(), fog: false }));
      glowMesh = new THREE.Mesh(first.glow, glowMat);
      glowMesh.name = `glow-${p.id}`;
      g.add(glowMesh);
      drawables++;
    }
    group.add(g);
    const fi = finals.indexOf(p);
    pieces.push({
      def: p,
      idx,
      group: g,
      mesh,
      glowMesh,
      glowMat,
      geos: [first.body, null, null, null],
      stage: 0,
      active: p.finalOnly !== true,
      jolt: 0,
      delay: fi < 0 ? 0 : p.id === 'core' ? 0.12 : p.id === 'halo' ? 0.28 : 0,
      rise: 0,
      phase: rng() * 6.28,
    });
    // final-form pieces start hidden (the first update decides)
    if (p.finalOnly === true) g.visible = false;
  });

  const pieceById = new Map<string, Piece>();
  for (const pc of pieces) pieceById.set(pc.def.id, pc);

  // ── ledge caps (dynamic: inner corners appear once the neighbour is gone) ──
  const capGeoB = new GeoBuilder(rng);
  capGeoB.box(0.6, 0.24, 5.4, AC.goldLight, 0, 0.02, -0.15, { jitter: 0 });
  capGeoB.box(0.3, 0.9, 0.3, AC.goldLight, 0, -0.4, 2.55, { jitter: 0 });
  capGeoB.box(0.18, 0.06, 5.0, AC.gold, 0, 0.15, -0.15, { jitter: 0 });
  const capGeo = bag.geo(capGeoB.build() ?? new THREE.BufferGeometry());
  const capMat = bag.mat(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.5, metalness: 0.2, emissive: 0x7a5410, emissiveIntensity: 0.55 }));
  const caps: Cap[] = [];
  def.platforms.forEach((p, i) => {
    if (p.kind !== 'solid') return;
    if (p.ledgeLeft === true) caps.push({ piece: i, side: -1, k: 0 });
    if (p.ledgeRight === true) caps.push({ piece: i, side: 1, k: 0 });
  });
  const capMesh = new THREE.InstancedMesh(capGeo, capMat, Math.max(1, caps.length));
  capMesh.frustumCulled = false;
  capMesh.name = 'ledge-caps';
  group.add(capMesh);
  drawables++;

  // ── torches: halo + body + core per torch in ONE instanced additive draw ──
  const flameGeo = bag.geo(new THREE.PlaneGeometry(1, 1));
  const flameMat = bag.mat(new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  const flames = new THREE.InstancedMesh(flameGeo, flameMat, TORCHES.length * 3 + 1);
  flames.frustumCulled = false;
  flames.renderOrder = 9;
  flames.name = 'torch-flames';
  group.add(flames);
  drawables++;
  const dummy = new THREE.Object3D();
  const abyssIdx = TORCHES.length * 3;

  // ── ghost outline of the final form (hint) ──
  let ghost: THREE.LineSegments | null = null;
  let ghostMat: THREE.LineBasicMaterial | null = null;
  {
    const pts: number[] = [];
    const seg = (x0: number, y0: number, x1: number, y1: number): void => void pts.push(x0, y0, 0.2, x1, y1, 0.2);
    for (const p of finals) {
      const th = Math.min(p.thickness, 0.6);
      seg(p.x0, p.y, p.x1, p.y);
      seg(p.x1, p.y, p.x1, p.y - th);
      seg(p.x1, p.y - th, p.x0, p.y - th);
      seg(p.x0, p.y - th, p.x0, p.y);
    }
    const g = bag.geo(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    ghostMat = bag.mat(new THREE.LineBasicMaterial({ color: 0xffd98a, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    ghost = new THREE.LineSegments(g, ghostMat);
    ghost.frustumCulled = false;
    ghost.renderOrder = 7;
    ghost.name = 'final-form-ghost';
    group.add(ghost);
    drawables++;
  }

  // ── stars, embers / dawn motes, god-rays, rubble ──
  const starPos: number[] = [];
  const starRnd: number[] = [];
  for (let i = 0; i < 260; i++) {
    starPos.push((rng() - 0.5) * 320, 6 + rng() * 80, -170);
    starRnd.push(rng(), rng(), rng(), rng());
  }
  const starGeo = bag.geo(new THREE.BufferGeometry());
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
  starGeo.setAttribute('aRand', new THREE.Float32BufferAttribute(starRnd, 4));
  const starMat = bag.mat(
    new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uFade: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute vec4 aRand; uniform float uTime; varying float vA;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          vA = 0.45 + 0.55 * sin(uTime * (1.5 + aRand.x * 3.0) + aRand.y * 40.0);
          gl_PointSize = (1.4 + aRand.z * 2.2) * 1.4;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uFade; varying float vA;
        void main() {
          float r = length(gl_PointCoord - 0.5) * 2.0;
          float a = (1.0 - smoothstep(0.0, 1.0, r)) * vA * uFade;
          gl_FragColor = vec4(vec3(0.85, 0.9, 1.3), a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    }),
  );
  const stars = new THREE.Points(starGeo, starMat);
  stars.frustumCulled = false;
  stars.renderOrder = -90;
  group.add(stars);
  drawables++;
  const embers = new Motes(bag, { count: 90, cx: 0, cy: 4, cz: -2, hx: 22, hy: 8, hz: 3, speed: 0.9, sway: 0.7, size: 3.6, colorA: 0xff9a3c, colorB: 0xffd36a, boost: 1.8, seed: 31 });
  const dawnMotes = new Motes(bag, { count: 90, cx: 0, cy: 6, cz: -3, hx: 24, hy: 10, hz: 5, speed: 0.3, sway: 1.1, size: 4.4, colorA: 0xfff0c8, colorB: 0xffffff, boost: 1.4, seed: 47 });
  dawnMotes.setFade(0);
  group.add(embers.points, dawnMotes.points);
  drawables += 2;
  const rays = buildGodRays(bag, rng);
  rays.setStrength(0);
  rays.mesh.visible = false;
  group.add(rays.mesh);
  drawables++;
  const chunks = new ChunkPool(72);
  group.add(chunks.mesh);
  drawables++;
  const blast = buildBlastTelegraph(bag, def, 0xff5a50);
  group.add(blast.mesh);
  drawables += 2;

  // ── state ──
  let finalK = 0;
  let riseT = 0;
  let wasFinal = false;
  let firstUpdate = true;
  let lightK = -1;
  let curTier: QualityTier = tier;
  let lastTime = 0;
  let flip = 0;

  const apply = (t: QualityTier): void => {
    curTier = t;
    const lo = t === 'low';
    const hi = t === 'high';
    stars.visible = !lo;
    embers.setDensity(lo ? 0.3 : hi ? 1 : 0.6);
    dawnMotes.setDensity(lo ? 0.3 : hi ? 1 : 0.6);
    sky.setClouds(tierProfile(t).skyClouds);
  };
  apply(tier);

  const ensureGeo = (pc: Piece, stage: number): void => {
    if (pc.geos[stage] === null) {
      const built = buildPiece(pc.def, stage).body;
      if (built !== null) bag.geo(built);
      pc.geos[stage] = built;
    }
  };

  const update = (pf: readonly PlatformState[], dt: number, time: number, cam: THREE.Camera): void => {
    lastTime = time;
    // ── persistent state from the snapshot ──
    const target = finalFormReached(def.platforms, pf);
    if (firstUpdate) {
      finalK = target ? 1 : 0;
      riseT = target ? 99 : 0;
      wasFinal = target;
    } else if (target) {
      if (!wasFinal) {
        riseT = 0;
        flip = 1;
      }
      finalK = Math.min(1, finalK + dt / 3.0);
      riseT += dt;
    } else {
      finalK = Math.max(0, finalK - dt / 0.6);
      riseT = 0;
    }
    wasFinal = target;
    flip = Math.max(0, flip - dt * 0.7);
    const dk = smooth(finalK);

    for (const pc of pieces) {
      let st: PlatformState | undefined = pf[pc.idx];
      if (st === undefined || st.id !== pc.def.id) st = pf.find((q) => q.id === pc.def.id);
      const fin = pc.def.finalOnly === true;
      const active = st === undefined ? !fin : isActive(st);
      pc.active = active;
      if (!active) {
        pc.group.visible = false;
        pc.rise = 0;
        continue;
      }
      pc.group.visible = true;
      if (st !== undefined) pc.group.position.x = (st.x0 + st.x1) / 2;
      let y = st !== undefined ? st.y : pc.def.y;
      if (pc.def.breakable !== undefined) {
        const s = crackStage(st?.hp, st?.maxHp);
        if (s !== pc.stage) {
          pc.stage = s;
          ensureGeo(pc, s);
          const g = pc.geos[s];
          if (g !== null) pc.mesh.geometry = g;
        }
        pc.jolt = Math.max(0, pc.jolt - dt * 5.5);
        const j = pc.jolt * pc.jolt;
        y -= 0.05 * j;
        pc.group.position.x += Math.sin(time * 90 + pc.phase) * 0.03 * j;
      }
      if (fin) {
        const p = riseT >= 99 ? 1 : Math.max(0, Math.min(1, (riseT - pc.delay) / 0.7));
        pc.rise = p;
        const e = 1 - (1 - p) * (1 - p) * (1 - p);
        pc.group.visible = p > 0.001;
        y -= (1 - e) * 3.4;
        pc.group.scale.setScalar(0.88 + 0.12 * e);
        if (pc.glowMat !== null) {
          const flare = riseT >= 99 ? 0 : Math.exp(-Math.max(0, riseT - pc.delay) * 1.5);
          const k = 0.9 + 2.2 * flare + 0.25 * Math.sin(time * 2 + pc.phase);
          pc.glowMat.color.setRGB(goldMatProto.r * k, goldMatProto.g * k, goldMatProto.b * k);
        }
      }
      pc.group.position.y = y;
    }

    // ledge caps: gold corners that pop in when a corner is exposed (inner corners once the neighbour breaks)
    const k = dt > 1e-5 ? 1 - Math.exp(-dt * 14) : 1;
    for (let i = 0; i < caps.length; i++) {
      const cp = caps[i];
      const pc = pieces[cp.piece];
      let on = pc.active && (pc.def.finalOnly !== true || pc.rise > 0.95);
      if (on) {
        const sp = pf.find((q) => q.id === pc.def.id);
        const cx = sp !== undefined ? (cp.side < 0 ? sp.x0 : sp.x1) : cp.side < 0 ? pc.def.x0 : pc.def.x1;
        const cy = sp !== undefined ? sp.y : pc.def.y;
        for (let j = 0; j < pieces.length && on; j++) {
          if (j === cp.piece) continue;
          const q = pieces[j];
          if (!q.active || q.def.kind !== 'solid') continue;
          if (q.def.finalOnly === true && q.rise < 0.5) continue;
          if (Math.abs(q.def.y - cy) < 0.6 && cx >= q.def.x0 - 0.05 && cx <= q.def.x1 + 0.05) on = false;
        }
        cp.k += ((on ? 1 : 0) - cp.k) * k;
        const sc = Math.max(0.0001, cp.k);
        dummy.position.set(cx - cp.side * 0.12, cy, 0);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(sc, sc, sc);
      } else {
        cp.k = 0;
        dummy.position.set(0, -999, 0);
        dummy.scale.setScalar(0.0001);
      }
      dummy.updateMatrix();
      capMesh.setMatrixAt(i, dummy.matrix);
    }
    capMesh.instanceMatrix.needsUpdate = true;

    // ghost of the final form
    if (ghost !== null && ghostMat !== null) {
      ghost.visible = dk < 0.99;
      ghostMat.opacity = (0.06 + 0.05 * Math.sin(time * 1.6)) * (1 - dk);
    }

    // sky, stars, torches, motes, rays
    sky.update(cam, time);
    sky.mix(NIGHT_SKY, DAWN_SKY, dk);
    starMat.uniforms.uTime.value = time;
    starMat.uniforms.uFade.value = 1 - dk;
    stars.position.copy(cam.position);
    embers.update(time);
    dawnMotes.update(time);
    embers.setFade(1 - dk);
    dawnMotes.setFade(dk);
    rays.update(time);
    rays.setStrength(0.2 * dk);
    rays.mesh.visible = dk > 0.02 && tierProfile(curTier).lightShafts;
    for (let i = 0; i < TORCHES.length; i++) {
      const t = TORCHES[i];
      const fl = 0.85 + 0.15 * Math.sin(time * 9 + t.ph * 3) * Math.sin(time * 5.3 + t.ph);
      const boost = 1 + flip * 1.4;
      // halo
      _c1.setRGB(1.0, 0.45, 0.14).lerp(_c2.setRGB(0.55, 0.75, 1.0), dk).multiplyScalar(0.34 * boost);
      flames.setColorAt(i * 3, _c1);
      dummy.position.set(t.x, t.y + 0.4, t.z + 0.5);
      dummy.scale.set(t.s * 6.5 * fl * (1 + flip * 0.5), t.s * 6.5 * fl * (1 + flip * 0.5), 1);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      flames.setMatrixAt(i * 3, dummy.matrix);
      // body (taller than wide)
      _c1.setRGB(1.0, 0.58, 0.18).lerp(_c2.setRGB(0.72, 0.86, 1.25), dk).multiplyScalar(1.7);
      flames.setColorAt(i * 3 + 1, _c1);
      dummy.position.set(t.x + Math.sin(time * 7 + t.ph) * 0.05, t.y + 0.55 * t.s * fl, t.z + 0.6);
      dummy.scale.set(t.s * 1.1, t.s * 2.0 * fl, 1);
      dummy.updateMatrix();
      flames.setMatrixAt(i * 3 + 1, dummy.matrix);
      // hot core
      _c1.setRGB(1.0, 0.92, 0.65).lerp(_c2.setRGB(1.0, 1.0, 1.15), dk).multiplyScalar(1.9);
      flames.setColorAt(i * 3 + 2, _c1);
      dummy.position.set(t.x, t.y + 0.25 * t.s, t.z + 0.65);
      dummy.scale.set(t.s * 0.55, t.s * 0.9 * fl, 1);
      dummy.updateMatrix();
      flames.setMatrixAt(i * 3 + 2, dummy.matrix);
    }
    // the hypogeum glow under the floor (magma at night, pale gold after)
    _c1.setRGB(0.95, 0.3, 0.12).lerp(_c2.setRGB(0.8, 0.62, 0.34), dk).multiplyScalar(0.7);
    flames.setColorAt(abyssIdx, _c1);
    dummy.position.set(0, -23, -8);
    dummy.scale.set(130, 18, 1);
    dummy.updateMatrix();
    flames.setMatrixAt(abyssIdx, dummy.matrix);
    flames.instanceMatrix.needsUpdate = true;
    if (flames.instanceColor !== null) flames.instanceColor.needsUpdate = true;

    chunks.update(dt, def.blast.bottom - 3);
    blast.update(time);
    firstUpdate = false;
  };

  const updateLights = (l: StageLights): boolean => {
    const dk = smooth(finalK);
    if (Math.abs(dk - lightK) < 1e-4 && lightK >= 0) return false;
    lightK = dk;
    l.hemi.color.set(SETUP.hemi.sky).lerp(_c2.set(DAWN.hemiSky), dk);
    l.hemi.groundColor.set(SETUP.hemi.ground).lerp(_c2.set(DAWN.hemiGround), dk);
    l.hemi.intensity = SETUP.hemi.intensity + (DAWN.hemiI - SETUP.hemi.intensity) * dk;
    l.key.color.set(SETUP.key.color).lerp(_c2.set(DAWN.key), dk);
    l.key.intensity = SETUP.key.intensity + (DAWN.keyI - SETUP.key.intensity) * dk;
    l.key.position.set(
      SETUP.key.pos[0] + (DAWN.keyPos[0] - SETUP.key.pos[0]) * dk,
      SETUP.key.pos[1] + (DAWN.keyPos[1] - SETUP.key.pos[1]) * dk,
      SETUP.key.pos[2] + (DAWN.keyPos[2] - SETUP.key.pos[2]) * dk,
    );
    l.rim.color.set(SETUP.rim.color).lerp(_c2.set(DAWN.rim), dk);
    l.rim.intensity = SETUP.rim.intensity + (DAWN.rimI - SETUP.rim.intensity) * dk;
    if (l.fog !== null) {
      l.fog.color.set(SETUP.fog.color).lerp(_c2.set(DAWN.fog), dk);
      l.fog.near = SETUP.fog.near + (DAWN.fogNear - SETUP.fog.near) * dk;
      l.fog.far = SETUP.fog.far + (DAWN.fogFar - SETUP.fog.far) * dk;
    }
    l.exposure = SETUP.exposure + (DAWN.exposure - SETUP.exposure) * dk;
    l.gradeTint[0] = SETUP.grade.tint[0] + (DAWN.tint[0] - SETUP.grade.tint[0]) * dk;
    l.gradeTint[1] = SETUP.grade.tint[1] + (DAWN.tint[1] - SETUP.grade.tint[1]) * dk;
    l.gradeTint[2] = SETUP.grade.tint[2] + (DAWN.tint[2] - SETUP.grade.tint[2]) * dk;
    l.gradeVignette = SETUP.grade.vignette + (DAWN.vignette - SETUP.grade.vignette) * dk;
    l.gradeSat = SETUP.grade.sat + (DAWN.sat - SETUP.grade.sat) * dk;
    return true;
  };

  const onEvents = (events: readonly BrawlEvent[], ctx: StageFxCtx): void => {
    const v = ctx.vfx;
    const cnt = (n: number): number => Math.max(1, Math.round(n * v.scale));
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.type === 'platformHit') {
        const pc = pieceById.get(e.platformId);
        if (pc !== undefined) pc.jolt = 1;
        const heavy = e.maxHp > 0 ? 1 - e.hpLeft / e.maxHp : 0;
        for (let k = cnt(4); k > 0; k--) v.puff(e.pos.x + v.rng.signed() * 0.5, e.pos.y + 0.1, v.rng.signed() * 2.2, v.rng.range(0.4, 1.8), 0.3, v.rng.range(0.8, 1.3), v.rng.range(0.4, 0.7), AC.dust, 0.55, -0.4);
        for (let k = cnt(4); k > 0; k--) v.clod(e.pos.x, e.pos.y, v.rng.signed() * 3.2, v.rng.range(1.5, 5), v.rng.range(0.07, 0.15), v.rng.range(0.4, 0.7), k % 2 === 0 ? AC.rubble : AC.stoneLight, 18);
        v.star(e.pos.x, e.pos.y, 0.3, 1.0 + heavy * 0.6, 0.14, 0xfff0d0, 2.4, 0.4);
        ctx.rumble(0.05 + heavy * 0.05);
      } else if (e.type === 'platformBreak') {
        const pc = pieceById.get(e.platformId);
        const th = pc !== undefined ? pc.def.thickness : 0.5;
        const wide = e.x1 - e.x0;
        chunks.burst(e.x0, e.x1, e.y - th, e.y, 2.0, Math.round(Math.min(26, 8 + wide * (th > 1 ? 3.2 : 1.6)) * Math.max(0.5, v.scale)), th > 1 ? 0.8 : 0.45, CHUNK_COLORS);
        for (let k = cnt(14); k > 0; k--) {
          const x = e.x0 + v.rng.next() * wide;
          v.puff(x, e.y - th * v.rng.next(), v.rng.signed() * 3.4, v.rng.range(-1.5, 2.6), 0.5, v.rng.range(1.3, 2.2), v.rng.range(0.6, 1.1), k % 2 === 0 ? AC.dust : 0x8d7e70, 0.6, -0.2);
        }
        v.ring(e.pos.x, e.y, 0.4, Math.max(2.5, wide * 0.6), 0.35, 0xffe0b0, 1.3, 0.12, 0.35, 0.8);
        v.flash = Math.max(v.flash, 0.18);
        v.flashR = 1;
        v.flashG = 0.9;
        v.flashB = 0.75;
        ctx.rumble(th > 1 ? 0.34 : 0.24);
      } else if (e.type === 'stageFinal') {
        const cx = 0;
        const cy = 3.5;
        v.ring(cx, cy, 0.6, 36, 1.05, 0xfff0c0, 3.2, 0.07, 1, 1);
        v.ring(cx, cy, 0.4, 26, 0.75, 0xffffff, 3.0, 0.1, 1, 0.9);
        v.ring(cx, cy, 0.3, 16, 0.55, 0xffc860, 2.6, 0.16, 1, 0.9);
        v.glow(cx, cy, 6, 34, 0.9, 0xffe6a8, 2.4, 0.9);
        v.star(cx, cy, 4, 22, 0.5, 0xffffff, 4, 0.3);
        for (let k = cnt(38); k > 0; k--) {
          const a = v.rng.next() * 6.28;
          v.spark(cx + Math.cos(a) * 3, cy + Math.sin(a) * 2, Math.cos(a) * v.rng.range(4, 15), Math.sin(a) * v.rng.range(2, 12) + 4, v.rng.range(0.14, 0.34), v.rng.range(0.8, 1.7), k % 2 === 0 ? 0xffd86a : 0xffffff, 3, -2.5);
        }
        for (let k = cnt(10); k > 0; k--) v.streak(v.rng.range(-12, 12), v.rng.range(-4, 3), Math.PI / 2, v.rng.range(10, 18), 3, 1.2, 0.12, v.rng.range(0.6, 1.0), 0xffe6a8, 2.6, 0.9, 1.5);
        v.flash = 0.7;
        v.flashR = 1;
        v.flashG = 0.95;
        v.flashB = 0.8;
        ctx.rumble(0.8);
        chunks.burst(-10, 10, 4, 9, 1.5, cnt(14), 0.5, CHUNK_COLORS, 1.3);
      }
    }
  };

  return {
    group,
    setup: SETUP,
    update,
    setTier: apply,
    countDrawables: () => drawables,
    updateLights,
    onEvents,
    dynamicState: () => ({ finalK, riseT: Math.min(riseT, 99), time: lastTime, chunks: chunks.n, pieces: pieces.filter((p) => p.active).length }),
    dispose: () => {
      group.removeFromParent();
      capMesh.dispose();
      flames.dispose();
      chunks.dispose();
      bag.dispose();
    },
  };
}
