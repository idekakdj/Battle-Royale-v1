/**
 * Broken Colosseum (plan §4): a floating slab of colosseum floor in a golden-hour sky. The slab shows an arcaded
 * facade to the camera; the three soft platforms are broken stone beams with wooden planks. Behind: ruined arches and
 * fallen columns (silhouettes), a far ring of colosseum tiers with a crowd, banners, braziers, drifting embers and
 * warm cloud banks below.
 */

import * as THREE from 'three';
import { mulberry32 } from '../../../core/math';
import type { PlatformDef, PlatformState, StageDef } from '../../types';
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
  softDiscTexture,
  stoneMaterial,
  syncPlatforms,
  type PlatformVisual,
  type StageSetup,
  type StageVisual,
} from './common';

const C = {
  sandTop: 0xe6c999,
  sand: 0xd9b985,
  sandLight: 0xefd6a8,
  sandDark: 0xb48f63,
  stone: 0xc6a577,
  stoneDark: 0x8f7050,
  stoneShade: 0x6d543f,
  rock: 0x7a5a45,
  rockDark: 0x4a3830,
  rockLight: 0x9a7556,
  wood: 0xa97544,
  woodLight: 0xc08a50,
  woodDark: 0x6b4627,
  gold: 0xf0bd4f,
  goldDark: 0xb78a2c,
  crimson: 0xa3252c,
  crimsonDark: 0x6e1a20,
  bronze: 0x9d6d2f,
  vine: 0x62843c,
  arch: 0x4a3426,
  iron: 0x34302d,
};

const FRONT_Z = 2.8;
const BACK_Z = -3.6;

const SETUP: StageSetup = {
  fog: { color: 0xdc9a6c, near: 38, far: 240 },
  hemi: { sky: 0xc9c4ff, ground: 0x8a5a3a, intensity: 0.95 },
  key: { color: 0xffc98a, intensity: 2.7, pos: [-20, 12, 22] },
  rim: { color: 0xff9a55, intensity: 1.3, pos: [22, 10, -18] },
  exposure: 1.08,
  grade: { tint: [1.05, 1.0, 0.93], vignette: 0.34, sat: 1.16 },
  shadow: 0x2a1608,
};

// ── piece builders ───────────────────────────────────────────────────────────

/** A broken pillar: base, shaft segments, optional capital; broken pillars end in a jagged lump. */
function pillar(b: GeoBuilder, x: number, y0: number, z: number, h: number, r: number, color: number, broken: boolean): void {
  b.box(r * 2.5, 0.35, r * 2.5, C.stoneDark, x, y0 + 0.17, z, { ao: 0.3 });
  const segs = Math.max(1, Math.round(h / 1.4));
  const sh = (h - 0.35 - (broken ? 0.4 : 0.6)) / segs;
  for (let i = 0; i < segs; i++) {
    b.cyl(r * 0.92, r, sh, color, x, y0 + 0.35 + sh * (i + 0.5), z, 9, { ao: 0.18, jitter: 0.04 });
  }
  if (broken) {
    b.lump(r * 0.95, C.stoneDark, x + r * 0.2, y0 + h - 0.2, z, { sy: 0.7 });
  } else {
    b.box(r * 2.7, 0.3, r * 2.7, C.sandLight, x, y0 + h - 0.45, z);
    b.box(r * 3.1, 0.3, r * 3.1, color, x, y0 + h - 0.15, z);
  }
}

/** A ruined arch: two piers + a ring of voussoirs with some missing. */
function ruinArch(b: GeoBuilder, cx: number, y0: number, z: number, span: number, h: number, depth: number, missing: number[]): void {
  const r = span / 2;
  const pierH = h - r;
  for (const s of [-1, 1]) {
    b.box(1.5, pierH, depth, C.stone, cx + s * (r + 0.75), y0 + pierH / 2, z, { ao: 0.28, jitter: 0.07 });
    b.box(1.8, 0.4, depth * 1.1, C.sandLight, cx + s * (r + 0.75), y0 + pierH + 0.15, z);
  }
  const n = 9;
  for (let i = 0; i < n; i++) {
    if (missing.includes(i)) continue;
    const t = (i + 0.5) / n;
    const a = Math.PI * (1 - t);
    const px = cx + Math.cos(a) * (r + 0.1);
    const py = y0 + pierH + Math.sin(a) * (r + 0.1);
    b.box(1.0, 1.35, depth, i % 2 === 0 ? C.sand : C.stone, px, py, z, { rz: a - Math.PI / 2, ao: 0.2, jitter: 0.07 });
  }
  b.box(span + 3.6, 0.5, depth * 1.05, C.sandLight, cx, y0 + h + 0.55, z, { jitter: 0.05 });
}

/** A tilted fallen column lying across. */
function fallenColumn(b: GeoBuilder, x: number, y: number, z: number, len: number, r: number, rotZ: number): void {
  const segs = Math.round(len / 1.3);
  for (let i = 0; i < segs; i++) {
    const t = (i + 0.5) / segs - 0.5;
    b.cyl(r, r, len / segs - 0.08, C.sand, x + Math.cos(rotZ) * t * len, y + Math.sin(rotZ) * t * len, z, 9, {
      rz: rotZ + Math.PI / 2,
      ao: 0.2,
      jitter: 0.08,
    });
  }
}

/** Soft platform (broken stone beam + wooden planks), origin at the top-surface centre. */
function softBeam(rng: () => number, w: number): THREE.BufferGeometry | null {
  const b = new GeoBuilder(rng);
  const planks = Math.max(4, Math.round(w / 0.9));
  const pw = w / planks;
  for (let i = 0; i < planks; i++) {
    const x = -w / 2 + pw * (i + 0.5);
    b.box(pw - 0.05, 0.14, 1.7, i % 2 === 0 ? C.wood : C.woodLight, x, -0.07, 0, { jitter: 0.07, ao: 0.2 });
  }
  // Cross beams under the planks
  for (const t of [-0.32, 0.32]) b.box(w * 0.96, 0.16, 0.22, C.woodDark, 0, -0.22, t * 2.2, { jitter: 0.04 });
  // Stone beam
  b.box(w * 0.88, 0.34, 1.0, C.stone, 0, -0.45, 0, { ao: 0.35, jitter: 0.05 });
  b.box(w * 0.64, 0.3, 0.86, C.stoneDark, 0.2, -0.78, 0, { ao: 0.4, jitter: 0.06 });
  // Broken ends: chipped chunks
  for (const s of [-1, 1]) {
    b.box(0.5, 0.3, 0.9, C.stone, s * (w * 0.44 + 0.1), -0.48, 0, { rz: s * 0.25, jitter: 0.08 });
    b.lump(0.32, C.stoneDark, s * (w * 0.5), -0.7, 0.1, { sy: 0.7 });
  }
  // Gold rope along the front edge marks "pass-through"
  b.box(w, 0.05, 0.05, C.gold, 0, -0.03, 0.88);
  b.box(w, 0.05, 0.05, C.goldDark, 0, -0.03, -0.88);
  // Iron brackets + dangling chains
  for (const s of [-0.28, 0.28]) {
    b.box(0.12, 0.5, 0.12, C.iron, s * w, -0.58, 0.55);
    b.box(0.06, 1.0, 0.06, C.iron, s * w * 1.05, -1.2, 0.0, { rz: s * 0.05 });
  }
  // A few hanging rocks
  b.lump(0.34, C.rock, -w * 0.18, -1.15, 0.0, { sy: 1.2 });
  b.lump(0.24, C.rockDark, w * 0.12, -1.35, 0.1, { sy: 1.3 });
  return b.build();
}

// ── the stage ───────────────────────────────────────────────────────────────

export function buildBrokenColosseum(def: StageDef, tier: QualityTier = 'high'): StageVisual {
  const bag = new ResourceBag();
  const group = new THREE.Group();
  group.name = 'stage-brokenColosseum';
  const rng = mulberry32(0xc0105eed);
  const stone = bag.mat(stoneMaterial());
  const glowTex = bag.tex(softDiscTexture(64, 1.6));
  const platforms: PlatformVisual[] = [];
  let drawables = 0;

  // Sky
  const sky = new SkyDome(bag, {
    top: 0x4a6fb5,
    mid: 0xe49b72,
    horizon: 0xffb36e,
    bottom: 0xd48e62,
    sunColor: 0xffd9a0,
    sunDir: [-0.21, 0.09, -1],
    sunSize: 1400,
    glow: 0.55,
    cloudLit: 0xffe2bc,
    cloudShade: 0xc98e7c,
    clouds: 1,
    horizonY: -0.03,
  });
  group.add(sky.mesh);

  // ── the main slab (static, near) ──
  const near = new GeoBuilder(rng);
  const main = def.platforms.find((p) => p.id === 'main') ?? def.platforms[0];
  const x0 = main.x0;
  const x1 = main.x1;
  const mw = x1 - x0;
  const midX = (x0 + x1) / 2;
  const th = main.thickness;
  // top plateau (floor tiles)
  near.box(mw, 0.5, FRONT_Z - BACK_Z, C.sandTop, midX, -0.25, (FRONT_Z + BACK_Z) / 2, { ao: 0.1, jitter: 0.0 });
  for (let i = 1; i < 10; i++) {
    near.box(0.05, 0.03, FRONT_Z - BACK_Z - 0.3, C.sandDark, x0 + (mw / 10) * i, 0.005, (FRONT_Z + BACK_Z) / 2, { jitter: 0.02 });
  }
  // sand arena inlay in the middle (a long low ellipse of darker sand)
  near.cyl(1, 1, 0.04, 0xcfa670, midX, 0.01, -0.3, 24, { sx: 7.2, sz: 2.2, jitter: 0.02 });
  // front facade wall (arcade)
  const wallH = th - 0.5;
  near.box(mw, wallH, 1.0, C.stone, midX, -0.5 - wallH / 2, FRONT_Z - 0.5, { ao: 0.32, jitter: 0.02 });
  const bays = 8;
  const bayW = mw / bays;
  for (let i = 0; i <= bays; i++) {
    near.box(0.62, wallH + 0.1, 0.5, C.sandLight, x0 + bayW * i, -0.5 - wallH / 2, FRONT_Z + 0.02, { ao: 0.25, jitter: 0.05 });
  }
  const archG = bag.geo(archGeo(bayW - 0.95, wallH - 0.7));
  const archDark = bag.geo(archGeo(bayW - 1.25, wallH - 0.95));
  for (let i = 0; i < bays; i++) {
    const cx = x0 + bayW * (i + 0.5);
    near.add(archG, C.stoneShade, cx, -th + 0.15, FRONT_Z + 0.06, { jitter: 0.03 });
    near.add(archDark, C.arch, cx, -th + 0.15, FRONT_Z + 0.09, { jitter: 0.03 });
  }
  // cornice band + dentils
  near.box(mw + 0.5, 0.34, 1.3, C.sandLight, midX, -0.17, FRONT_Z - 0.35, { jitter: 0.02 });
  for (let i = 0; i < Math.floor(mw / 0.55); i++) {
    near.box(0.28, 0.2, 0.2, C.sand, x0 + 0.3 + i * 0.55, -0.5, FRONT_Z + 0.15, { jitter: 0.04 });
  }
  // golden ledge caps + corner trim (the ledge corners read clearly)
  for (const s of [-1, 1]) {
    const ex = s < 0 ? x0 : x1;
    near.box(0.55, 0.22, FRONT_Z - BACK_Z + 0.2, C.gold, ex - s * 0.12, 0.0, (FRONT_Z + BACK_Z) / 2, { jitter: 0 });
    near.box(0.3, wallH + 0.4, 0.3, C.goldDark, ex + s * 0.02, -0.5 - wallH / 2, FRONT_Z + 0.05, { jitter: 0.02 });
    near.cyl(0.25, 0.25, 0.4, C.gold, ex + s * 0.22, -0.95, FRONT_Z - 0.2, 6, { jitter: 0 }); // ledge lantern body
  }
  // underside: stepped broken masonry then a tapering rock
  near.box(mw - 1.2, 1.4, FRONT_Z - BACK_Z - 0.8, C.stoneDark, midX, -th - 0.7, (FRONT_Z + BACK_Z) / 2, { ao: 0.45 });
  near.box(mw - 4.4, 1.6, FRONT_Z - BACK_Z - 1.6, C.rock, midX + 0.4, -th - 2.2, (FRONT_Z + BACK_Z) / 2 - 0.2, { ao: 0.5 });
  near.cone(8.2, 10, C.rock, midX, -th - 7.4, (FRONT_Z + BACK_Z) / 2 - 0.2, 7, { rx: Math.PI, ao: 0.55, jitter: 0.04, ry: 0.3 });
  near.cone(4.0, 7, C.rockDark, midX - 5, -th - 5.2, -0.4, 6, { rx: Math.PI, ao: 0.5, ry: 0.8 });
  near.cone(3.2, 6, C.rockDark, midX + 6, -th - 4.7, -0.2, 6, { rx: Math.PI, ao: 0.5, ry: 1.9 });
  near.cone(2.2, 5, C.rockLight, midX + 1.5, -th - 11.5, -0.6, 6, { rx: Math.PI, ao: 0.5 });
  for (let i = 0; i < 10; i++) {
    const ex = x0 + 1.5 + rng() * (mw - 3);
    near.lump(0.5 + rng() * 0.8, i % 2 === 0 ? C.rock : C.rockLight, ex, -th - 0.8 - rng() * 2.2, FRONT_Z - 0.4 - rng() * 1.5, { sy: 1.1, jitter: 0.08 });
  }
  // fallen arcade chunks hanging below the front: a broken arch dangling under the slab, vines
  ruinArch(near, midX - 5.4, -th - 3.8, 0.8, 2.8, 3.2, 0.9, [2, 3, 4, 5]);
  for (let i = 0; i < 9; i++) {
    const vx = x0 + 1 + rng() * (mw - 2);
    const vl = 1.2 + rng() * 2.6;
    near.box(0.07, vl, 0.07, C.vine, vx, -th - vl / 2 - 0.1, FRONT_Z - 0.1, { rz: (rng() - 0.5) * 0.1, jitter: 0.12 });
    near.lump(0.14, C.vine, vx, -th - vl - 0.1, FRONT_Z - 0.1, {});
  }
  // rubble clusters on top at the back corners (behind the fighters)
  for (const s of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      near.lump(0.3 + rng() * 0.35, C.stone, s * (9.4 + rng() * 1.4), 0.15 + rng() * 0.15, -2.4 - rng() * 0.9, { sy: 0.8, jitter: 0.1 });
    }
  }

  // ── braziers on the back corners ──
  const brazierPos: [number, number, number][] = [
    [-9.6, 0, -2.6],
    [9.6, 0, -2.6],
  ];
  for (const [bx, by, bz] of brazierPos) {
    near.box(0.9, 0.5, 0.9, C.stoneDark, bx, by + 0.25, bz, { ao: 0.3 });
    near.cyl(0.28, 0.4, 1.1, C.stone, bx, by + 1.05, bz, 8, { ao: 0.25 });
    near.cyl(0.62, 0.34, 0.5, C.bronze, bx, by + 1.8, bz, 10, { jitter: 0.03 });
    near.cyl(0.62, 0.62, 0.07, C.goldDark, bx, by + 2.06, bz, 10);
  }

  // ── mid layer: ruined arches, pillars, fallen columns (silhouettes behind the fight) ──
  const mid = new GeoBuilder(rng);
  ruinArch(mid, -19, -4.5, -11, 5.2, 11.5, 2.2, [6, 7]);
  ruinArch(mid, 20.5, -6.5, -12, 4.6, 10, 2.2, [1, 2, 3]);
  ruinArch(mid, 0, -9.5, -26, 6.4, 14, 2.6, [4, 5]);
  pillar(mid, -13.2, -3.5, -9, 8.5, 0.8, C.sand, false);
  pillar(mid, -12.9, -3.5, -14, 5.4, 0.8, C.sand, true);
  pillar(mid, 14.6, -3.5, -9, 7.0, 0.85, C.sand, true);
  pillar(mid, 25.5, -6, -14, 9.4, 0.9, C.sand, false);
  pillar(mid, -27, -6, -13, 7.2, 0.9, C.sand, true);
  fallenColumn(mid, -15.5, -3.2, -7.2, 7, 0.75, 0.18);
  fallenColumn(mid, 17.5, -4.6, -8, 6, 0.7, -0.14);
  // a floating slab fragment with a column lying on it (mid-low left)
  mid.box(7, 0.8, 4, C.stone, -22, -8, -9, { ao: 0.3, rz: 0.06 });
  mid.cone(3.6, 5, C.rock, -22, -11, -9, 6, { rx: Math.PI, ao: 0.5 });
  fallenColumn(mid, -22, -7, -9, 5, 0.6, 0.0);
  mid.box(6, 0.8, 3.6, C.stone, 23, -11, -8, { ao: 0.3, rz: -0.05 });
  mid.cone(3.2, 4.5, C.rockDark, 23, -13.8, -8, 6, { rx: Math.PI, ao: 0.5 });
  pillar(mid, 24, -10.4, -8, 4.6, 0.65, C.sand, true);

  // ── far ring of colosseum tiers with a crowd ──
  const far = new GeoBuilder(rng);
  const crowdItems: { m: THREE.Matrix4; col: THREE.Color }[] = [];
  const R = 112;
  const wedgeDeg = 8;
  const wedgeW = 2 * R * Math.tan(((wedgeDeg / 2) * Math.PI) / 180) + 0.4;
  const palette = [0xb8322f, 0xe8d9b8, 0xc89a3a, 0x3a5f9a, 0x7a3d6a, 0x4f8a4f, 0xd8672b, 0xefe6d2, 0x2c2c34];
  const tmpM = new THREE.Matrix4();
  const sc = 1.55;
  for (let k = -5; k <= 5; k++) {
    const phi = (k * wedgeDeg * Math.PI) / 180;
    // A broken ring: a couple of missing wedges (one lets the low sun shine through).
    if (k === -2 || k === 3) continue;
    const m = new THREE.Matrix4()
      .makeTranslation(R * Math.sin(phi), 0, -6 - R * Math.cos(phi))
      .multiply(new THREE.Matrix4().makeRotationY(-phi));
    const dropL = rng() * 3.5;
    far.withTransform(m, () => {
      // seat tiers (each a step)
      for (let t = 0; t < 3; t++) {
        far.box(wedgeW, 1.3 * sc, 2.8 * sc, t % 2 === 0 ? C.stone : C.stoneDark, 0, 4 + t * 2.5 * sc - dropL * 0.1, -t * 2.6 * sc, { ao: 0.3, jitter: 0.05 });
      }
      // back arcade wall (two storeys with arches)
      const wallZ = -9.5 * sc;
      for (let st = 0; st < 2; st++) {
        const y0 = 4 + 3 * 2.5 * sc + st * 6.2 * sc - 1.5;
        far.box(wedgeW, 6.0 * sc, 1.4 * sc, st === 0 ? C.stone : C.stoneDark, 0, y0 + 3 * sc, wallZ, { ao: 0.3, jitter: 0.04 });
        far.box(wedgeW + 0.5, 0.5 * sc, 1.7 * sc, C.sandDark, 0, y0 + 6.1 * sc, wallZ + 0.3);
        const nA = 4;
        const aw = wedgeW / nA;
        for (let a = 0; a < nA; a++) {
          const ag = archGeo(aw - 2.0, 4.4 * sc);
          bag.geo(ag);
          far.add(ag, C.arch, -wedgeW / 2 + aw * (a + 0.5), y0 + 0.4 * sc, wallZ + 0.8 * sc, { jitter: 0.02 });
        }
      }
      // the rock beneath the ring piece
      far.cone(wedgeW * 0.72, 34 + dropL * 3, C.rock, 0, -18 - dropL, -6, 7, { rx: Math.PI, ao: 0.55, ry: k });
      // crowd: spectators on the tiers
      for (let t = 0; t < 3; t++) {
        const nS = Math.floor(wedgeW / 1.05);
        for (let i = 0; i < nS; i++) {
          if (rng() < 0.1) continue;
          const lx = -wedgeW / 2 + 0.7 + i * 1.05 + (rng() - 0.5) * 0.2;
          const ly = 4 + t * 2.5 * sc + 0.65 * sc + 0.5;
          const lz = -t * 2.6 * sc + 0.3;
          tmpM.copy(m).multiply(new THREE.Matrix4().makeTranslation(lx, ly, lz));
          const col = new THREE.Color(palette[Math.floor(rng() * palette.length)]);
          col.multiplyScalar(0.8 + rng() * 0.3);
          crowdItems.push({ m: tmpM.clone(), col });
        }
      }
    });
  }

  // Bake meshes
  const nearGeo = near.build();
  const midGeo = mid.build();
  const farGeo = far.build();
  const nearMesh = bakeMesh(bag, group, nearGeo, stone, 'slab');
  const midMesh = bakeMesh(bag, group, midGeo, stone, 'ruins-mid');
  const farMesh = bakeMesh(bag, group, farGeo, stone, 'ruins-far');
  drawables += 3;
  if (nearMesh !== null) nearMesh.frustumCulled = false;
  if (midMesh !== null) midMesh.frustumCulled = false;
  if (farMesh !== null) farMesh.frustumCulled = false;

  // Crowd (two instanced halves that bob out of phase)
  const crowdGeo = bag.geo(new THREE.BoxGeometry(0.8, 1.35, 0.6));
  const crowdMat = bag.mat(new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }));
  const half = Math.ceil(crowdItems.length / 2);
  const crowdA = new THREE.InstancedMesh(crowdGeo, crowdMat, half);
  const crowdB = new THREE.InstancedMesh(crowdGeo, crowdMat, crowdItems.length - half);
  crowdItems.forEach((it, i) => {
    const mesh = i < half ? crowdA : crowdB;
    const idx = i < half ? i : i - half;
    mesh.setMatrixAt(idx, it.m);
    mesh.setColorAt(idx, it.col);
  });
  for (const cm of [crowdA, crowdB]) {
    cm.frustumCulled = false;
    if (cm.instanceColor) cm.instanceColor.needsUpdate = true;
    group.add(cm);
  }
  drawables += 2;

  // ── soft platforms (broken beams) + the solid platform group ──
  for (const p of def.platforms) {
    const g = new THREE.Group();
    g.name = `plat-${p.id}`;
    g.position.set((p.x0 + p.x1) / 2, p.y, 0);
    if (p.kind === 'soft') {
      const geo = softBeam(mulberry32(p.id.length * 977 + 3), p.x1 - p.x0);
      bakeMesh(bag, g, geo, stone, `beam-${p.id}`);
      drawables++;
    }
    group.add(g);
    platforms.push({ id: p.id, group: g, x0: (p.x0 + p.x1) / 2, y: p.y, moving: !!(p as PlatformDef).moving });
  }

  // ── floating debris around (bobbing) ──
  const debris: { g: THREE.Group; ph: number; amp: number; y0: number; rot: number }[] = [];
  const debrisSpots: [number, number, number, number][] = [
    [-17, -9, -4, 0.8],
    [16.5, -10, -3, 1.1],
    [-24, 3, -14, 0.9],
    [26, 8, -15, 1.0],
    [-6, -16, -10, 1.2],
    [9, -17, -12, 0.7],
  ];
  for (const [dx, dy, dz, sc] of debrisSpots) {
    const db = new GeoBuilder(rng);
    db.box(2.2 * sc, 0.6 * sc, 1.8 * sc, C.stone, 0, 0, 0, { ao: 0.3, rz: (rng() - 0.5) * 0.3, jitter: 0.08 });
    db.cone(1.1 * sc, 1.8 * sc, C.rock, 0, -0.9 * sc, 0, 6, { rx: Math.PI, ao: 0.5 });
    if (rng() < 0.7) db.cyl(0.34 * sc, 0.36 * sc, 1.4 * sc, C.sandLight, 0.3 * sc, 0.9 * sc, 0, 8, { rz: (rng() - 0.5) * 0.7, ao: 0.2 });
    const dg = new THREE.Group();
    bakeMesh(bag, dg, db.build(), stone, 'debris');
    dg.position.set(dx, dy, dz);
    group.add(dg);
    debris.push({ g: dg, ph: rng() * 6.28, amp: 0.25 + rng() * 0.25, y0: dy, rot: (rng() - 0.5) * 0.12 });
    drawables++;
  }

  // ── banners (sway) ──
  const banners: { m: THREE.Mesh; ph: number }[] = [];
  const bannerMat = bag.mat(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85, side: THREE.DoubleSide }));
  const bannerSpots: [number, number, number, number][] = [
    [-11.4, -0.9, 2.5, 1.0],
    [11.4, -0.9, 2.5, 1.0],
    [-19, 5.5, -9.2, 1.5],
    [20.5, 4.5, -9.8, 1.5],
    [-13.2, 3.2, -8.2, 1.2],
    [14.6, 1.5, -8.2, 1.2],
  ];
  for (const [bx, by, bz, sc] of bannerSpots) {
    const bb = new GeoBuilder(rng);
    const bw = 1.3 * sc;
    const bh = 3.4 * sc;
    bb.box(bw, bh, 0.05, C.crimson, 0, -bh / 2, 0, { topColor: C.crimsonDark, ao: 0.1, jitter: 0 });
    bb.box(bw, 0.2 * sc, 0.08, C.gold, 0, -0.1 * sc, 0.01, { jitter: 0 });
    bb.box(bw, 0.16 * sc, 0.08, C.gold, 0, -bh + 0.12 * sc, 0.01, { jitter: 0 });
    bb.box(0.46 * sc, 0.46 * sc, 0.08, C.gold, 0, -bh * 0.42, 0.02, { rz: Math.PI / 4, jitter: 0 });
    bb.box(0.18 * sc, 0.18 * sc, 0.09, C.crimsonDark, 0, -bh * 0.42, 0.03, { rz: Math.PI / 4, jitter: 0 });
    for (let i = 0; i < 6; i++) bb.box(0.07 * sc, 0.3 * sc, 0.05, C.gold, -bw / 2 + 0.12 * sc + i * (bw - 0.24 * sc) / 5, -bh - 0.1 * sc, 0.01, { jitter: 0 });
    bb.box(bw + 0.3 * sc, 0.1 * sc, 0.12, C.iron, 0, 0.05 * sc, 0, { jitter: 0 });
    const geo = bb.build();
    if (geo === null) continue;
    bag.geo(geo);
    const m = new THREE.Mesh(geo, bannerMat);
    m.position.set(bx, by, bz);
    group.add(m);
    banners.push({ m, ph: rng() * 6.28 });
    drawables++;
  }

  // ── braziers: flame + glow sprites ──
  const flameMat = bag.mat(
    new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color(1.0, 0.55, 0.16).multiplyScalar(2.6), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }),
  );
  const flameCore = bag.mat(
    new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color(1.0, 0.86, 0.45).multiplyScalar(3.2), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }),
  );
  const haloMat = bag.mat(
    new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color(1.0, 0.45, 0.12).multiplyScalar(0.55), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }),
  );
  const flames: { s: THREE.Sprite; c: THREE.Sprite; h: THREE.Sprite; ph: number; base: [number, number, number] }[] = [];
  for (const [bx, by, bz] of brazierPos) {
    const s = new THREE.Sprite(flameMat);
    const c = new THREE.Sprite(flameCore);
    const h = new THREE.Sprite(haloMat);
    s.position.set(bx, by + 2.5, bz + 0.1);
    c.position.set(bx, by + 2.3, bz + 0.15);
    h.position.set(bx, by + 2.6, bz + 0.05);
    group.add(h, s, c);
    flames.push({ s, c, h, ph: rng() * 6.28, base: [bx, by, bz] });
    drawables += 3;
  }

  // ── warm cloud banks below / far ──
  const cloudTex = glowTex;
  const cloudsNear = new CloudLayer(bag, cloudTex, {
    count: 46,
    cx: 0,
    span: 220,
    y0: -30,
    y1: -17,
    z: -40,
    sizeMin: 22,
    sizeMax: 40,
    speed: 0.7,
    colorTop: 0xffd6a2,
    colorBottom: 0xc9806a,
    opacity: 0.85,
    seed: 11,
  });
  const cloudsFar = new CloudLayer(bag, cloudTex, {
    count: 40,
    cx: 0,
    span: 340,
    y0: -30,
    y1: -2,
    z: -120,
    sizeMin: 34,
    sizeMax: 60,
    speed: 0.35,
    colorTop: 0xffc58a,
    colorBottom: 0xd18b78,
    opacity: 0.7,
    seed: 23,
  });
  cloudsNear.mesh.renderOrder = -50;
  cloudsFar.mesh.renderOrder = -60;
  group.add(cloudsFar.mesh, cloudsNear.mesh);
  drawables += 2;

  // ── embers ──
  const embers = new Motes(bag, {
    count: 140,
    cx: 0,
    cy: 6,
    cz: -3,
    hx: 20,
    hy: 11,
    hz: 5,
    speed: 0.9,
    sway: 0.9,
    size: 5.2,
    colorA: 0xff7a22,
    colorB: 0xffc860,
    boost: 2.4,
    seed: 31,
  });
  group.add(embers.points);
  const dust = new Motes(bag, {
    count: 90,
    cx: 0,
    cy: 4,
    cz: -6,
    hx: 26,
    hy: 12,
    hz: 9,
    speed: 0.12,
    sway: 1.4,
    size: 3.4,
    colorA: 0xffe7b8,
    colorB: 0xffd7a0,
    boost: 0.55,
    seed: 5,
  });
  group.add(dust.points);
  drawables += 2;

  // ── blast zone telegraph ──
  const blast = buildBlastTelegraph(bag, def);
  group.add(blast.mesh);
  drawables++;
  drawables++; // sky

  let curTier: QualityTier = tier;
  const apply = (t: QualityTier): void => {
    curTier = t;
    const prof = tierProfile(t);
    const hi = t === 'high';
    const lo = t === 'low';
    crowdA.visible = !lo;
    crowdB.visible = !lo;
    cloudsFar.mesh.visible = !lo;
    embers.setDensity(lo ? 0.35 : hi ? 1 : 0.7);
    dust.setDensity(lo ? 0 : hi ? 1 : 0.6);
    sky.setClouds(prof.skyClouds);
    for (const f of flames) f.h.visible = !lo;
  };
  apply(tier);

  const update = (pf: readonly PlatformState[], dt: number, time: number, cam: THREE.Camera): void => {
    void dt;
    syncPlatforms(platforms, pf);
    sky.update(cam, time);
    const bobA = Math.sin(time * 2.6) * 0.1;
    const bobB = Math.sin(time * 2.6 + 2.2) * 0.1;
    crowdA.position.y = bobA;
    crowdB.position.y = bobB;
    for (const d of debris) {
      d.g.position.y = d.y0 + Math.sin(time * 0.6 + d.ph) * d.amp;
      d.g.rotation.z = Math.sin(time * 0.35 + d.ph) * d.rot;
    }
    for (const b of banners) b.m.rotation.z = Math.sin(time * 1.5 + b.ph) * 0.05 + Math.sin(time * 3.1 + b.ph * 2) * 0.015;
    for (const f of flames) {
      const fl = 0.85 + 0.15 * Math.sin(time * 13 + f.ph) + 0.1 * Math.sin(time * 23 + f.ph * 3);
      f.s.scale.set(1.5 * fl, 2.2 * fl, 1);
      f.s.position.y = f.base[1] + 2.45 + 0.1 * fl;
      f.c.scale.set(0.8 * fl, 1.2 * fl, 1);
      f.h.scale.set(5.5 * (0.92 + 0.08 * fl), 5.5 * (0.92 + 0.08 * fl), 1);
    }
    cloudsNear.update(time, 0);
    if (curTier !== 'low') cloudsFar.update(time, 0);
    embers.update(time);
    dust.update(time);
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
      crowdA.dispose();
      crowdB.dispose();
      cloudsNear.mesh.dispose();
      cloudsFar.mesh.dispose();
      bag.dispose();
    },
  };
}
