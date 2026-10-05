/**
 * Clockwork Heights (v1.6, docs/CL-MAPS-PLAN.md map 3): a floating brass-and-stone clockwork in a dusk-teal / violet sky. A wide solid
 * `core` slab drifts along a looping path and four soft satellites glide between three layouts; the scene never recomputes that motion
 * — every platform group follows the interpolated `snapshot.platforms` (position AND width) each frame.
 *
 * Scenery: giant slowly turning cogs and an astrolabe ring far behind (perspective parallax), floating rubble islands, thin brass rails
 * tracing the platform paths, brass-trimmed stone with glowing rune strips, a soft underglow + motion streak on every moving platform,
 * a dial with a ticking second hand and a swinging pendulum under the core. Everything that turns is TICK-synced (a clockwork
 * escapement: a quick advance every second, then a hold). All static geometry is merged per material, the cogs are instanced.
 */

import * as THREE from 'three';
import { mulberry32 } from '../../../core/math';
import { platformAt } from '../../data/stages';
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
import { buildGear, tickAngle } from './gears';

const C = {
  stone: 0x6e6990,
  stoneLight: 0x9a94bd,
  stoneDark: 0x403b66,
  stoneDeep: 0x2a2749,
  brass: 0xc99a3c,
  brassLight: 0xf1cd72,
  brassDark: 0x7d5b22,
  teal: 0x4fe6d6,
  tealDark: 0x1f8f9a,
  violet: 0xa886ff,
  steel: 0x4c6f93,
  steelDark: 0x2f4666,
  rock: 0x5b567e,
  rockDark: 0x3a3659,
};

const FRONT_Z = 2.6;

const SETUP: StageSetup = {
  fog: { color: 0x4a4390, near: 42, far: 250 },
  hemi: { sky: 0x8a96e6, ground: 0x41336a, intensity: 1.0 },
  key: { color: 0xffdcb4, intensity: 2.5, pos: [18, 15, 22] },
  rim: { color: 0x74e0ff, intensity: 1.4, pos: [-22, 10, -16] },
  exposure: 1.06,
  grade: { tint: [0.97, 1.0, 1.06], vignette: 0.34, sat: 1.18 },
  shadow: 0x1c1640,
};

const GLOW_TEX_POWER = 1.5;

// ── piece builders ───────────────────────────────────────────────────────────

function arch(b: GeoBuilder, w: number, h: number, color: number, x: number, y: number, z: number): void {
  const g = archGeo(w, h);
  b.add(g, color, x, y, z, { jitter: 0.02 });
  g.dispose();
}

/** The drifting core: a solid brass-banded stone slab with an arcade, a clock dial, ledge caps and a hanging engine. */
function coreGeo(rng: () => number, w: number, th: number): { body: THREE.BufferGeometry | null; glow: THREE.BufferGeometry | null } {
  const b = new GeoBuilder(rng);
  const g = new GeoBuilder(rng);
  const depth = 5.2;
  const hw = w / 2;
  // deck
  b.box(w, 0.5, depth, C.stone, 0, -0.25, 0, { ao: 0.15, jitter: 0.02 });
  b.box(w - 0.5, 0.03, depth - 0.6, C.stoneLight, 0, 0.005, 0, { jitter: 0.03 });
  for (const z of [-1.55, 1.2]) b.box(w - 0.9, 0.025, 0.07, C.brass, 0, 0.022, z, { jitter: 0 });
  for (let i = -5; i <= 5; i++) b.box(0.07, 0.025, 2.75, C.brassDark, i * 1.1, 0.02, -0.18, { jitter: 0 });
  // front wall: pilasters + arches around a central dial
  const wallH = th - 0.5;
  b.box(w, wallH, 1.3, C.stone, 0, -0.5 - wallH / 2, FRONT_Z - 0.65, { ao: 0.32, jitter: 0.02 });
  b.box(w + 0.32, 0.3, 0.62, C.brass, 0, -0.42, FRONT_Z - 0.2, { ao: 0.15, jitter: 0.02 });
  b.box(w + 0.1, 0.1, 0.7, C.brassLight, 0, -0.24, FRONT_Z - 0.18, { jitter: 0 });
  const pil = [-hw + 0.25, -4.45, -2.5, 2.5, 4.45, hw - 0.25];
  for (const px of pil) b.box(0.5, wallH + 0.05, 0.5, C.stoneLight, px, -0.5 - wallH / 2, FRONT_Z + 0.02, { ao: 0.22, jitter: 0.04 });
  for (const ax of [-5.43, -3.47, 3.47, 5.43]) {
    arch(b, 1.35, wallH - 0.5, C.stoneDeep, ax, -th + 0.1, FRONT_Z + 0.06);
    arch(b, 1.0, wallH - 0.85, 0x1b1936, ax, -th + 0.1, FRONT_Z + 0.09);
    // a lit lantern pane inside each arch
    g.box(0.34, 0.5, 0.05, C.brassLight, ax, -th + 0.95, FRONT_Z + 0.1, { jitter: 0 });
  }
  // clock dial (centre)
  const dy = -0.5 - wallH / 2 + 0.05;
  const dial = new THREE.CircleGeometry(1.12, 28);
  b.add(dial, 0x211f42, 0, dy, FRONT_Z + 0.075, { jitter: 0 });
  dial.dispose();
  const bezel = new THREE.RingGeometry(1.12, 1.3, 28);
  b.add(bezel, C.brass, 0, dy, FRONT_Z + 0.085, { jitter: 0 });
  bezel.dispose();
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const long = i % 3 === 0;
    g.box(long ? 0.1 : 0.06, long ? 0.26 : 0.16, 0.05, C.teal, Math.sin(a) * 0.92, dy + Math.cos(a) * 0.92, FRONT_Z + 0.1, { rz: -a, jitter: 0 });
  }
  b.cyl(0.1, 0.1, 0.14, C.brassLight, 0, dy, FRONT_Z + 0.12, 8, { rx: Math.PI / 2, jitter: 0 });
  // ledge caps (solid platform: both ends grab) — bright brass so the grab corners read
  for (const s of [-1, 1]) {
    b.box(0.55, 0.22, depth + 0.2, C.brassLight, s * (hw - 0.12), 0.0, 0, { jitter: 0 });
    b.box(0.3, wallH + 0.3, 0.3, C.brassLight, s * hw, -0.5 - wallH / 2, FRONT_Z + 0.05, { jitter: 0.02 });
    g.box(0.18, 0.05, depth - 0.4, C.teal, s * (hw - 0.12), 0.115, 0, { jitter: 0 });
  }
  // rune strip along the deck's front lip + back edge
  g.box(w - 1.3, 0.06, 0.1, C.teal, 0, 0.03, FRONT_Z - 0.18, { jitter: 0 });
  for (let i = -5; i <= 5; i++) g.box(0.3, 0.05, 0.16, i % 2 === 0 ? C.teal : C.violet, i * 1.15, 0.03, -FRONT_Z + 0.45, { jitter: 0 });
  // hull under the deck: stepped stone + a hanging axle cone
  b.box(w - 1.2, 1.1, depth - 0.8, C.stoneDark, 0, -th - 0.55, 0, { ao: 0.5 });
  b.box(w - 3.8, 1.3, depth - 1.8, C.stoneDeep, 0, -th - 1.7, 0, { ao: 0.5 });
  b.cone(1.5, 3.4, C.rockDark, 0, -th - 3.9, 0, 8, { rx: Math.PI, ao: 0.5, ry: 0.5 });
  for (const s of [-1, 1]) {
    b.cyl(0.22, 0.22, w - 3.0, C.brassDark, 0, -th + 0.05, s * 1.7, 8, { rz: Math.PI / 2, jitter: 0 });
    b.cone(0.5, 1.6, C.steel, s * 3.2, -th - 1.1, s * 0.5, 6, { rx: Math.PI, ao: 0.5, jitter: 0.05 });
  }
  return { body: b.build(), glow: g.build() };
}

/** A soft satellite plank: stone slab, brass end caps and lip, an underside gear housing and counterweights. */
function satGeo(rng: () => number, w: number): { body: THREE.BufferGeometry | null; glow: THREE.BufferGeometry | null } {
  const b = new GeoBuilder(rng);
  const g = new GeoBuilder(rng);
  const depth = 2.0;
  b.box(w, 0.34, depth, C.stone, 0, -0.17, 0, { ao: 0.3, jitter: 0.02 });
  b.box(w - 0.14, 0.05, depth - 0.2, C.stoneLight, 0, -0.015, 0, { jitter: 0.03 });
  b.box(w + 0.1, 0.12, 0.2, C.brass, 0, -0.1, depth / 2 - 0.02, { jitter: 0 });
  b.box(w + 0.02, 0.07, 0.14, C.brassLight, 0, -0.01, depth / 2 - 0.02, { jitter: 0 });
  for (const s of [-1, 1]) {
    b.box(0.28, 0.4, depth + 0.1, C.brassLight, s * (w / 2 - 0.08), -0.15, 0, { jitter: 0 });
    // gear housing + counterweight under each end
    b.cyl(0.32, 0.32, 0.9, C.brassDark, s * (w / 2 - 0.9), -0.55, 0, 8, { rx: Math.PI / 2, jitter: 0 });
    b.cone(0.26, 0.75, C.steelDark, s * (w / 2 - 0.9), -1.1, 0, 6, { rx: Math.PI, ao: 0.4 });
  }
  b.cyl(0.5, 0.5, 1.1, C.brass, 0, -0.62, 0, 10, { rx: Math.PI / 2, jitter: 0 });
  b.cone(0.45, 1.0, C.rock, 0, -1.2, 0, 6, { rx: Math.PI, ao: 0.5, ry: 0.4 });
  // rune strip + three glyph blocks on the front face
  g.box(w - 0.9, 0.06, 0.09, C.teal, 0, -0.012, depth / 2 + 0.03, { jitter: 0 });
  for (const gx of [-0.9, 0, 0.9]) g.box(0.3, 0.12, 0.05, gx === 0 ? C.violet : C.teal, gx, -0.19, depth / 2 + 0.04, { jitter: 0 });
  return { body: b.build(), glow: g.build() };
}

/** Thin brass rails along a platform's looping path with a node at every key (static hint scenery, z behind the platforms). */
function railsGeo(rng: () => number, defs: readonly PlatformDef[]): THREE.BufferGeometry | null {
  const b = new GeoBuilder(rng);
  for (const p of defs) {
    if (p.path === undefined) continue;
    const frames = p.path.periodS * 60;
    const N = 120;
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i <= N; i++) {
      const r = platformAt(p, (i / N) * frames);
      const x = (r.x0 + r.x1) / 2;
      const y = r.y - 0.3;
      const last = pts[pts.length - 1];
      if (last === undefined || Math.hypot(x - last.x, y - last.y) > 0.22) pts.push({ x, y });
    }
    const soft = p.kind === 'soft';
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const c = pts[i];
      const len = Math.hypot(c.x - a.x, c.y - a.y);
      b.box(len + 0.04, soft ? 0.06 : 0.1, 0.06, soft ? C.brassDark : C.brass, (a.x + c.x) / 2, (a.y + c.y) / 2, -3.4, { rz: Math.atan2(c.y - a.y, c.x - a.x), jitter: 0.04 });
    }
    for (const k of p.path.keys) {
      const r = platformAt(p, k.t * frames);
      const x = (r.x0 + r.x1) / 2;
      b.cyl(0.2, 0.2, 0.12, C.brassLight, x, r.y - 0.3, -3.4, 8, { rx: Math.PI / 2, jitter: 0 });
    }
  }
  return b.build();
}

/** The astrolabe: concentric brass rings with tick marks, orbiting beads and a few star glyphs (unlit, far behind). */
function ringGeo(rng: () => number, r0: number, r1: number, ticks: number, bead: boolean, color: number, accent: number): THREE.BufferGeometry | null {
  const b = new GeoBuilder(rng);
  const ring = new THREE.RingGeometry(r0, r1, 96);
  b.add(ring, color, 0, 0, 0, { jitter: 0 });
  ring.dispose();
  for (let i = 0; i < ticks; i++) {
    const a = (i / ticks) * Math.PI * 2;
    const big = i % 5 === 0;
    const rr = r1 + (big ? 0.55 : 0.28);
    b.box(big ? 0.22 : 0.12, big ? 1.1 : 0.55, 0.05, big ? accent : color, Math.cos(a) * rr, Math.sin(a) * rr, 0.02, { rz: a - Math.PI / 2, jitter: 0 });
  }
  if (bead) {
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.5;
      b.cyl(0.9, 0.9, 0.1, accent, Math.cos(a) * ((r0 + r1) / 2), Math.sin(a) * ((r0 + r1) / 2), 0.04, 12, { rx: Math.PI / 2, jitter: 0 });
    }
  }
  return b.build();
}

function islandGeo(rng: () => number, sc: number): THREE.BufferGeometry | null {
  const b = new GeoBuilder(rng);
  b.box(3.6 * sc, 0.6 * sc, 2.6 * sc, C.stone, 0, 0, 0, { ao: 0.3, rz: (rng() - 0.5) * 0.2, jitter: 0.06 });
  b.cone(1.6 * sc, 2.6 * sc, C.rock, 0, -1.5 * sc, 0, 6, { rx: Math.PI, ao: 0.5 });
  b.box(3.3 * sc, 0.12 * sc, 2.3 * sc, C.stoneLight, 0, 0.34 * sc, 0, { jitter: 0.05 });
  b.cyl(0.4 * sc, 0.46 * sc, 2.0 * sc, C.brassDark, -0.7 * sc, 1.3 * sc, 0, 8, { ao: 0.2 });
  b.cyl(0.55 * sc, 0.55 * sc, 0.2 * sc, C.brass, -0.7 * sc, 2.4 * sc, 0, 10, { rx: Math.PI / 2, jitter: 0 });
  b.lump(0.5 * sc, C.rockDark, 0.9 * sc, 0.55 * sc, 0.1, { sy: 0.8 });
  b.cone(0.18 * sc, 1.1 * sc, C.teal, 0.2 * sc, -0.9 * sc, 0.5, 5, { rx: Math.PI, jitter: 0.06 });
  return b.build();
}

// ── background cog table ─────────────────────────────────────────────────────

interface CogSpec {
  x: number;
  y: number;
  z: number;
  r: number;
  /** 1 | -1 spin direction, and which gear mesh (0 coarse / 1 fine). */
  dir: 1 | -1;
  kind: 0 | 1;
  /** Colour multiplier per channel (instance colour). */
  tint: [number, number, number];
  /** Minimum tier to show (0 low … 2 high). */
  tier: 0 | 1 | 2;
  phase: number;
}

const COGS: CogSpec[] = [
  // far, huge (hazy)
  { x: -52, y: 30, z: -92, r: 42, dir: 1, kind: 0, tint: [0.7, 0.72, 1.0], tier: 0, phase: 0.0 },
  { x: 38, y: 10, z: -88, r: 34, dir: -1, kind: 1, tint: [0.95, 0.8, 0.55], tier: 0, phase: 0.4 },
  { x: -4, y: -26, z: -96, r: 36, dir: -1, kind: 0, tint: [0.6, 0.8, 1.0], tier: 1, phase: 0.2 },
  { x: 78, y: 42, z: -100, r: 30, dir: 1, kind: 0, tint: [0.8, 0.7, 1.0], tier: 2, phase: 0.7 },
  { x: -92, y: -8, z: -100, r: 30, dir: -1, kind: 1, tint: [0.9, 0.85, 0.7], tier: 2, phase: 0.1 },
  // mid
  { x: 26, y: 26, z: -52, r: 17, dir: 1, kind: 1, tint: [0.75, 0.85, 1.0], tier: 0, phase: 0.3 },
  { x: 41, y: 19, z: -52, r: 9.5, dir: -1, kind: 0, tint: [1.0, 0.82, 0.5], tier: 1, phase: 0.55 },
  { x: -30, y: 18, z: -46, r: 13, dir: -1, kind: 0, tint: [0.9, 0.8, 1.0], tier: 0, phase: 0.8 },
  { x: -43, y: 9, z: -46, r: 7.5, dir: 1, kind: 1, tint: [1.0, 0.85, 0.55], tier: 1, phase: 0.15 },
  { x: 6, y: -22, z: -44, r: 15, dir: 1, kind: 1, tint: [0.7, 0.9, 1.0], tier: 1, phase: 0.45 },
  { x: -24, y: -28, z: -48, r: 11, dir: -1, kind: 0, tint: [0.95, 0.8, 0.6], tier: 2, phase: 0.65 },
  // near, small (dim so the fight stays readable)
  { x: 24, y: -9, z: -22, r: 6.5, dir: -1, kind: 0, tint: [0.55, 0.62, 0.85], tier: 1, phase: 0.9 },
  { x: -25, y: 20, z: -24, r: 5.5, dir: 1, kind: 1, tint: [0.62, 0.6, 0.85], tier: 2, phase: 0.25 },
];

// ── the stage ───────────────────────────────────────────────────────────────

interface Mover {
  vis: PlatformVisual;
  def: PlatformDef;
  runeMat: THREE.MeshBasicMaterial;
  glowIdx: number;
  streakIdx: number;
  /** previous centre (for the visual-only speed estimate) + smoothed speed (m/s) + smoothed direction */
  px: number;
  py: number;
  have: boolean;
  speed: number;
  dx: number;
  dy: number;
  phase: number;
}

export function buildClockworkHeights(def: StageDef, tier: QualityTier = 'high'): StageVisual {
  const bag = new ResourceBag();
  const group = new THREE.Group();
  group.name = 'stage-clockworkHeights';
  const rng = mulberry32(0xc10c4001);
  const stone = bag.mat(stoneMaterial(0.88));
  const glowTex = bag.tex(softDiscTexture(64, GLOW_TEX_POWER));
  const platforms: PlatformVisual[] = [];
  const movers: Mover[] = [];
  let drawables = 0;

  const sky = new SkyDome(bag, {
    top: 0x1d1658,
    mid: 0x3b4a9c,
    horizon: 0x8be0dc,
    bottom: 0x7258b0,
    sunColor: 0xffd0a0,
    sunDir: [-0.5, 0.05, -1],
    sunSize: 1100,
    glow: 0.5,
    cloudLit: 0xc2b4f0,
    cloudShade: 0x4f4690,
    clouds: 1,
    horizonY: -0.12,
  });
  group.add(sky.mesh);

  // ── platforms ──
  const runeBase = new THREE.Color(0.35, 1.3, 1.2);
  let hands: { sec: THREE.Mesh; min: THREE.Mesh } | null = null;
  const underGears: { mesh: THREE.Mesh; dir: number; step: number; period: number; phase: number }[] = [];
  let pendulum: THREE.Group | null = null;
  const handGeo = bag.geo(new THREE.BoxGeometry(0.07, 1, 0.05));
  handGeo.translate(0, 0.5, 0);
  const handMat = bag.mat(new THREE.MeshStandardMaterial({ color: C.brassLight, roughness: 0.5, metalness: 0.2, flatShading: true }));
  for (const p of def.platforms) {
    const g = new THREE.Group();
    g.name = `plat-${p.id}`;
    const cx = (p.x0 + p.x1) / 2;
    g.position.set(cx, p.y, 0);
    const w = p.x1 - p.x0;
    const geos = p.kind === 'solid' ? coreGeo(mulberry32(p.id.length * 97 + 3), w, p.thickness) : satGeo(mulberry32(p.id.length * 53 + 11), w);
    bakeMesh(bag, g, geos.body, stone, `body-${p.id}`);
    const runeMat = bag.mat(new THREE.MeshBasicMaterial({ color: runeBase.clone(), fog: false }));
    bakeMesh(bag, g, geos.glow, runeMat, `runes-${p.id}`);
    drawables += 2;
    if (p.kind === 'solid') {
      // dial hands (tick-synced), under-core cogs, pendulum
      const dy = -0.5 - (p.thickness - 0.5) / 2 + 0.05;
      const sec = new THREE.Mesh(handGeo, handMat);
      sec.scale.set(0.8, 0.95, 1);
      sec.position.set(0, dy, FRONT_Z + 0.16);
      const min = new THREE.Mesh(handGeo, handMat);
      min.scale.set(1.5, 0.62, 1);
      min.position.set(0, dy, FRONT_Z + 0.15);
      g.add(min, sec);
      hands = { sec, min };
      drawables += 2;
      const mkGear = (r: number, teeth: number, x: number, y: number, z: number, dir: number, period: number): void => {
        const geo = bag.geo(buildGear({ radius: r, teeth, depth: 0.5, holes: 5, body: C.brassDark, rim: C.brass, hub: C.brassLight }, rng));
        const m = new THREE.Mesh(geo, stone);
        m.position.set(x, y, z);
        g.add(m);
        underGears.push({ mesh: m, dir, step: (Math.PI * 2) / teeth, period, phase: rng() });
        drawables++;
      };
      mkGear(2.3, 16, 0, -p.thickness - 3.5, -0.6, 1, 1);
      mkGear(1.15, 10, -2.9, -p.thickness - 1.0, 2.55, -1, 1);
      mkGear(1.15, 10, 2.9, -p.thickness - 1.0, 2.55, -1, 1);
      const pend = new THREE.Group();
      pend.position.set(0, -p.thickness - 0.15, 2.6);
      const pg = new GeoBuilder(rng);
      pg.box(0.06, 4.2, 0.06, C.brassDark, 0, -2.1, 0, { jitter: 0 });
      pg.cyl(0.75, 0.75, 0.14, C.brassLight, 0, -4.4, 0, 14, { rx: Math.PI / 2, jitter: 0 });
      pg.cyl(0.4, 0.4, 0.18, C.tealDark, 0, -4.4, 0, 12, { rx: Math.PI / 2, jitter: 0 });
      bakeMesh(bag, pend, pg.build(), stone, 'pendulum');
      g.add(pend);
      pendulum = pend;
      drawables++;
    }
    group.add(g);
    const moving = p.path !== undefined || p.moving !== undefined;
    const vis: PlatformVisual = { id: p.id, group: g, x0: p.x0, y: p.y, moving };
    platforms.push(vis);
    if (moving) {
      movers.push({ vis, def: p, runeMat, glowIdx: movers.length, streakIdx: 0, px: cx, py: p.y, have: false, speed: 0, dx: 1, dy: 0, phase: rng() * 6.28 });
    }
  }

  // ── underglow + motion streaks of the moving platforms (one instanced draw) ──
  const glowGeo = bag.geo(new THREE.PlaneGeometry(1, 1));
  const glowMat = bag.mat(new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  const glowInst = new THREE.InstancedMesh(glowGeo, glowMat, Math.max(1, movers.length * 2));
  glowInst.frustumCulled = false;
  glowInst.renderOrder = 8;
  glowInst.name = 'platform-glows';
  const dummy = new THREE.Object3D();
  const tmpC = new THREE.Color();
  for (let i = 0; i < movers.length; i++) {
    movers[i].glowIdx = i * 2;
    movers[i].streakIdx = i * 2 + 1;
    glowInst.setColorAt(i * 2, tmpC.setRGB(0, 0, 0));
    glowInst.setColorAt(i * 2 + 1, tmpC.setRGB(0, 0, 0));
    dummy.scale.setScalar(0.0001);
    dummy.updateMatrix();
    glowInst.setMatrixAt(i * 2, dummy.matrix);
    glowInst.setMatrixAt(i * 2 + 1, dummy.matrix);
  }
  group.add(glowInst);
  drawables++;

  // ── rails hinting at the paths ──
  const railMat = bag.mat(stoneMaterial(0.7));
  bakeMesh(bag, group, railsGeo(rng, def.platforms), railMat, 'rails');
  drawables++;

  // ── background cogs (two instanced meshes: coarse / fine teeth) ──
  const gearA = bag.geo(buildGear({ radius: 1, teeth: 14, toothH: 0.14, depth: 0.12, holes: 6, body: 0x7e76b8, rim: 0xa497d8, hub: C.brassDark }, rng));
  const gearB = bag.geo(buildGear({ radius: 1, teeth: 22, toothH: 0.1, depth: 0.1, holes: 8, body: 0x6b83b4, rim: 0x93a8d6, hub: C.brassDark }, rng));
  const cogMat = bag.mat(stoneMaterial(0.8));
  const cogMeshes: THREE.InstancedMesh[] = [];
  /** Per mesh: the specs in instance order, sorted by tier so `count` can simply truncate (low shows the first N). */
  const cogList: CogSpec[][] = [[], []];
  for (const k of [0, 1] as const) {
    const specs = COGS.filter((c) => c.kind === k).sort((a, b) => a.tier - b.tier);
    const m = new THREE.InstancedMesh(k === 0 ? gearA : gearB, cogMat, specs.length);
    m.frustumCulled = false;
    m.name = `bg-cogs-${k}`;
    specs.forEach((spec, i) => {
      m.setColorAt(i, tmpC.setRGB(spec.tint[0] * 0.56, spec.tint[1] * 0.56, spec.tint[2] * 0.6));
      cogList[k].push(spec);
    });
    cogMeshes.push(m);
    group.add(m);
    drawables++;
  }

  // ── astrolabe (far behind) ──
  const astroMat = bag.mat(new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(0.8, 0.78, 0.74), fog: false, side: THREE.DoubleSide }));
  const astro = new THREE.Group();
  astro.position.set(2, 14, -66);
  const rings: { mesh: THREE.Mesh; speed: number }[] = [];
  const ringDefs: [number, number, number, boolean, number, number, number][] = [
    [27, 28.2, 72, true, 0xb98f45, 0x5ff0e0, 0.011],
    [20, 20.9, 48, false, 0x9a8cd8, 0xffd27a, -0.019],
    [14, 14.7, 36, true, 0xc9a24e, 0x9a7cff, 0.03],
  ];
  for (const [r0, r1, ticks, bead, col, acc, spd] of ringDefs) {
    const m = bakeMesh(bag, astro, ringGeo(rng, r0, r1, ticks, bead, col, acc), astroMat, 'astro-ring');
    if (m !== null) rings.push({ mesh: m, speed: spd });
    drawables++;
  }
  // cross spokes (static) tying the rings together
  {
    const sb = new GeoBuilder(rng);
    for (let i = 0; i < 4; i++) sb.box(54, 0.22, 0.04, 0xa88a45, 0, 0, -0.05, { rz: (i / 4) * Math.PI, jitter: 0 });
    bakeMesh(bag, astro, sb.build(), astroMat, 'astro-spokes');
    drawables++;
  }
  group.add(astro);

  // ── floating rubble islands ──
  const islands: { g: THREE.Group; ph: number; amp: number; y0: number; rot: number }[] = [];
  const islandSpots: [number, number, number, number][] = [
    [-23, 7, -12, 1.0],
    [24, 13, -15, 1.15],
    [-11, -14, -10, 0.9],
    [12, -16, -13, 1.0],
    [-34, -2, -26, 1.5],
    [36, 4, -29, 1.6],
  ];
  for (const [ix, iy, iz, sc] of islandSpots) {
    const ig = new THREE.Group();
    bakeMesh(bag, ig, islandGeo(rng, sc), stone, 'island');
    ig.position.set(ix, iy, iz);
    group.add(ig);
    islands.push({ g: ig, ph: rng() * 6.28, amp: 0.3 + rng() * 0.3, y0: iy, rot: (rng() - 0.5) * 0.12 });
    drawables++;
  }

  // ── clouds + motes ──
  const cloudsFar = new CloudLayer(bag, glowTex, {
    count: 38,
    cx: 0,
    span: 320,
    y0: -36,
    y1: -6,
    z: -100,
    sizeMin: 30,
    sizeMax: 56,
    speed: 0.5,
    colorTop: 0xd2c6f8,
    colorBottom: 0x6a5aa8,
    opacity: 0.75,
    seed: 61,
  });
  const cloudsNear = new CloudLayer(bag, glowTex, {
    count: 30,
    cx: 0,
    span: 170,
    y0: -34,
    y1: -20,
    z: -28,
    sizeMin: 18,
    sizeMax: 32,
    speed: 1.1,
    colorTop: 0xcdbff2,
    colorBottom: 0x5c4c9c,
    opacity: 0.85,
    seed: 73,
  });
  cloudsFar.mesh.renderOrder = -60;
  cloudsNear.mesh.renderOrder = -40;
  group.add(cloudsFar.mesh, cloudsNear.mesh);
  drawables += 2;
  const sparks = new Motes(bag, {
    count: 110,
    cx: 0,
    cy: 5,
    cz: -3,
    hx: 24,
    hy: 11,
    hz: 6,
    speed: 0.3,
    sway: 1.0,
    size: 4,
    colorA: 0xffe2a8,
    colorB: 0x8ff6ff,
    boost: 1.3,
    seed: 21,
  });
  group.add(sparks.points);
  drawables++;

  const blast = buildBlastTelegraph(bag, def, 0xff5a50);
  group.add(blast.mesh);
  drawables += 2;

  let curTier: QualityTier = tier;
  const tierN = (t: QualityTier): 0 | 1 | 2 => (t === 'low' ? 0 : t === 'medium' ? 1 : 2);
  const apply = (t: QualityTier): void => {
    curTier = t;
    const prof = tierProfile(t);
    const lo = t === 'low';
    const hi = t === 'high';
    const tn = tierN(t);
    for (const k of [0, 1] as const) cogMeshes[k].count = cogList[k].filter((c) => c.tier <= tn).length;
    cloudsFar.mesh.visible = !lo;
    islands.forEach((isl, i) => (isl.g.visible = !lo || i < 3));
    sparks.setDensity(lo ? 0.3 : hi ? 1 : 0.6);
    sky.setClouds(prof.skyClouds);
  };
  apply(tier);

  const update = (pf: readonly PlatformState[], dt: number, time: number, cam: THREE.Camera): void => {
    syncPlatforms(platforms, pf);
    sky.update(cam, time);
    const tickFrac = time - Math.floor(time);
    const tickPulse = Math.exp(-tickFrac * 6.5);

    // movers: visual-only speed estimate (smoothed) -> rune glow, underglow and streak
    const k = dt > 1e-5 ? 1 - Math.exp(-dt * 6) : 0;
    for (let i = 0; i < movers.length; i++) {
      const m = movers[i];
      const g = m.vis.group;
      // width follows the snapshot too (a platform whose span changes is stretched; constant widths keep scale 1)
      for (let q = 0; q < pf.length; q++) {
        if (pf[q].id !== m.def.id) continue;
        const sw = (pf[q].x1 - pf[q].x0) / (m.def.x1 - m.def.x0);
        g.scale.x = sw > 0.05 && Number.isFinite(sw) ? sw : 1;
        break;
      }
      const cx = g.position.x;
      const cy = g.position.y;
      if (m.have && dt > 1e-5) {
        const vx = (cx - m.px) / dt;
        const vy = (cy - m.py) / dt;
        const sp = Math.min(6, Math.hypot(vx, vy));
        m.speed += (sp - m.speed) * k;
        if (sp > 0.05) {
          m.dx += (vx / sp - m.dx) * k;
          m.dy += (vy / sp - m.dy) * k;
        }
      }
      m.px = cx;
      m.py = cy;
      m.have = true;
      const sk = Math.min(1, m.speed / 2.2);
      const w = m.def.x1 - m.def.x0;
      const solid = m.def.kind === 'solid';
      const boost = 0.55 + 0.5 * sk + 0.75 * tickPulse * (0.7 + 0.3 * Math.sin(m.phase));
      m.runeMat.color.setRGB(runeBase.r * boost, runeBase.g * boost, runeBase.b * boost);
      // underglow: a soft ellipse under the platform
      dummy.position.set(cx, cy - (solid ? m.def.thickness + 1.2 : 0.75), 0.4);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(w * (solid ? 0.9 : 1.15), solid ? 2.6 : 1.0, 1);
      dummy.updateMatrix();
      glowInst.setMatrixAt(m.glowIdx, dummy.matrix);
      const gi = (solid ? 0.35 : 0.3) + 0.55 * sk;
      glowInst.setColorAt(m.glowIdx, tmpC.setRGB(0.12 * gi, 0.95 * gi, 0.9 * gi));
      // motion streak behind the platform (along the smoothed velocity)
      const len = Math.min(3.6, m.speed * 0.9);
      const ang = Math.atan2(m.dy, m.dx);
      dummy.position.set(cx - m.dx * (len / 2 + w * 0.12), cy - m.dy * (len / 2 + w * 0.12) - (solid ? 0.6 : 0.2), 0.5);
      dummy.rotation.set(0, 0, ang);
      dummy.scale.set(Math.max(0.0001, len + 0.6), solid ? 1.2 : 0.55, 1);
      dummy.updateMatrix();
      glowInst.setMatrixAt(m.streakIdx, dummy.matrix);
      const si = sk < 0.05 ? 0 : 0.85 * sk;
      glowInst.setColorAt(m.streakIdx, tmpC.setRGB(0.55 * si, 0.9 * si, 1.0 * si));
    }
    glowInst.instanceMatrix.needsUpdate = true;
    if (glowInst.instanceColor !== null) glowInst.instanceColor.needsUpdate = true;

    // dial hands + under-core cogs + pendulum (tick-synced)
    if (hands !== null) {
      hands.sec.rotation.z = -tickAngle(time, 1, (Math.PI * 2) / 60);
      hands.min.rotation.z = -tickAngle(time, 5, (Math.PI * 2) / 60, 1.3);
    }
    for (const ug of underGears) ug.mesh.rotation.z = ug.dir * tickAngle(time, ug.period, ug.step * 0.5, ug.phase);
    if (pendulum !== null) pendulum.rotation.z = Math.sin(time * Math.PI) * 0.32;

    // background cogs
    for (const kk of [0, 1] as const) {
      const mesh = cogMeshes[kk];
      for (let i = 0; i < mesh.count; i++) {
        const c = cogList[kk][i];
        const teeth = kk === 0 ? 14 : 22;
        const period = c.r > 25 ? 2 : 1;
        dummy.position.set(c.x, c.y, c.z);
        dummy.rotation.set(0, 0, c.dir * tickAngle(time, period, ((Math.PI * 2) / teeth) * (c.r > 25 ? 0.18 : 0.3), c.phase * 3));
        dummy.scale.set(c.r, c.r, c.r);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
    for (const r of rings) r.mesh.rotation.z = time * r.speed;
    for (const isl of islands) {
      isl.g.position.y = isl.y0 + Math.sin(time * 0.55 + isl.ph) * isl.amp;
      isl.g.rotation.z = Math.sin(time * 0.3 + isl.ph) * isl.rot;
    }
    cloudsNear.update(time, 0);
    if (curTier !== 'low') cloudsFar.update(time, 0);
    sparks.update(time);
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
      for (const m of cogMeshes) m.dispose();
      glowInst.dispose();
      cloudsFar.mesh.dispose();
      cloudsNear.mesh.dispose();
      bag.dispose();
    },
  };
}
