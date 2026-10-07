/**
 * JungleScene (v1.8, WP-J3) — the Jungle Clearing, built procedurally and ENTIRELY from the arena's `ArenaDef` data:
 *
 *  - ground: mossy earth texture (roots, leaf litter, wet shoreline, pebbly pool floor) + animated canopy dapple,
 *  - 14 TREES drawn exactly at their collider positions/radii (huge trunks with buttress roots, canopy clumps above 9 m, hanging
 *    vines) — one InstancedMesh with a per-tree fade, so a trunk between the third-person camera and the followed fighter
 *    dithers out smoothly (`treeFade.ts`) and never pops,
 *  - 4 fallen LOGS along the segments, 12 wicker/vine CRATES (same ids, same `breakCrate` debris hooks as the colosseum),
 *    6 pickup PADS (stone disc + flower bed + glowing flowers) under the unchanged pickup beacons,
 *  - the foliage / mossy-cliff WALL ring with light gaps (+ a taller backdrop on medium/high),
 *  - MOSS PATCHES (glowing soft decals + tufts) at the sim's moss discs and the central POOL (sunk-looking basin, translucent
 *    animated water, wet-stone shoreline, reeds, lily pads),
 *  - ambience: layered mist, god-rays, fireflies + pollen, instanced ferns / reeds / glow flowers.
 *
 * Draw calls (high, before beacons / Effects / rigs) ≈ 26: ground, props, wall, backdrop, trunks, canopy, vines, crates, debris,
 * ferns, reeds, flowers, moss decal + tufts, water, 2 mist, shafts, 2 mote clouds (+ shadow pass). Lower tiers cut foliage density,
 * the backdrop, mist, shafts and motes (`applyTier`).
 *
 * Public surface = `ArenaScene` (render/arenaScene.ts) — identical to the colosseum's `Stadium`. Create it with
 * `createArenaScene(sceneManager, arenaDef)`.
 */

import * as THREE from 'three';
import type { ArenaDef } from '../../config/arenas';
import { mulberry32, TAU } from '../../core/math';
import type { ArenaScene, PickupKind } from '../arenaScene';
import type { SceneManager } from '../SceneManager';
import { PickupBeacons } from '../pickupBeacons';
import { getQualityTier, onQualityChange, tierProfile, type QualityTier } from '../quality';
import { makeGrainTexture } from '../arenaFx';
import { GodRays, Mist, Motes } from './atmosphere';
import { buildGroundGeometry, makeGroundTexture, GROUND_MARGIN } from './ground';
import { MossPatches } from './moss';
import {
  addLilyPads,
  addLogs,
  addPads,
  addRocks,
  buildFernGeometry,
  buildGlowFlowerGeometry,
  buildReedGeometry,
  buildWallGeometry,
  buildWickerCrateGeometry,
  isScatterClear,
} from './props';
import { TRUNK_HEIGHT, buildLeafClumpGeometry, buildTrunkGeometry, buildVinesGeometry, type VineAnchor } from './trees';
import { stepFade, trunkFadeTarget } from './treeFade';
import { VGeo, composeMat } from './vgeo';
import { PoolWater } from './water';

const PICKUP_KINDS: readonly PickupKind[] = ['heal', 'speed', 'rage'];
const DEBRIS_MAX = 72;
const DEBRIS_PER_CRATE = 6;
const ZERO_SCALE = new THREE.Matrix4().makeScale(0, 0, 0);
/** Height (m) of the followed fighter's head used as the trunk-fade sight-line target. */
const FOCUS_HEAD_Y = 1.3;

/** Per-tier foliage budgets (instances / counts). */
interface JungleBudget {
  ferns: number;
  reeds: number;
  tufts: number;
  fireflies: number;
  pollen: number;
  mist: number;
  rays: boolean;
  backdrop: boolean;
  ceiling: number;
}
const BUDGETS: Record<QualityTier, JungleBudget> = {
  low: { ferns: 70, reeds: 10, tufts: 0.45, fireflies: 0, pollen: 50, mist: 0, rays: false, backdrop: true, ceiling: 8 },
  medium: { ferns: 170, reeds: 20, tufts: 0.8, fireflies: 26, pollen: 120, mist: 1, rays: true, backdrop: true, ceiling: 20 },
  high: { ferns: 240, reeds: 26, tufts: 1, fireflies: 52, pollen: 220, mist: 2, rays: true, backdrop: true, ceiling: 28 },
};
export function jungleBudget(tier: QualityTier): Readonly<JungleBudget> {
  return BUDGETS[tier];
}

// Scratch.
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

// ── Trunk material: flat vertex-coloured standard material + per-instance dither fade ──

function makeTrunkMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aFade;\nvarying float vFade;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFade = aFade;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vFade;
float gkBayer(vec2 p) {
  int x = int(mod(p.x, 4.0));
  int y = int(mod(p.y, 4.0));
  int i = x + y * 4;
  float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[i] + 0.5) / 16.0;
}`,
      )
      .replace(
        '#include <alphatest_fragment>',
        '#include <alphatest_fragment>\nif (vFade < 0.985 && vFade <= gkBayer(gl_FragCoord.xy)) discard;',
      );
  };
  mat.customProgramCacheKey = () => 'gk-jungle-trunk-fade';
  return mat;
}

function makeGroundMaterial(map: THREE.Texture, grain: THREE.Texture, time: { value: number }): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.97, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGrain = { value: grain };
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGkW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGkW = (modelMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uGrain;\nuniform float uTime;\nvarying vec2 vGkW;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
#ifdef USE_MAP
diffuseColor.rgb *= 0.86 + 0.28 * texture2D(uGrain, vGkW * 0.33).r;
float gkDap = sin(vGkW.x * 0.37 + uTime * 0.11) * sin(vGkW.y * 0.43 - uTime * 0.09) + sin((vGkW.x + vGkW.y) * 0.21 + uTime * 0.05);
diffuseColor.rgb *= 0.94 + 0.06 * gkDap;
#endif`,
      );
  };
  mat.customProgramCacheKey = () => 'gk-jungle-ground';
  return mat;
}

export interface JungleStats {
  trees: number;
  canopyClumps: number;
  crates: number;
  moss: number;
  ferns: number;
  reeds: number;
  glowFlowers: number;
  vines: number;
}

export class JungleScene implements ArenaScene {
  readonly arena: ArenaDef;
  readonly root = new THREE.Group();
  readonly crowdCount = 0;

  private readonly sm: SceneManager;
  private readonly timeU = { value: 0 };
  private time = 0;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly unsubscribe: () => void;
  private tier: QualityTier;

  // Ground / props / wall.
  private readonly groundMesh: THREE.Mesh;
  private readonly propsMesh: THREE.Mesh;
  private readonly wallMesh: THREE.Mesh;
  private readonly backdropMesh: THREE.Mesh;

  // Trees.
  private readonly trees: { x: number; z: number; r: number; h: number }[] = [];
  private readonly trunkMesh: THREE.InstancedMesh;
  private readonly fade: Float32Array;
  private readonly fadeAttr: THREE.InstancedBufferAttribute;
  private readonly canopyMesh: THREE.InstancedMesh;
  private readonly canopyTree: number; // canopy instances that belong to trees (the rest is the ceiling ring)
  private readonly canopyTotal: number;
  private readonly vineMesh: THREE.Mesh;
  private readonly vineCount: number;

  // Crates + debris.
  private readonly crateMesh: THREE.InstancedMesh;
  private readonly crateBase: Float32Array;
  private readonly crateAlive: boolean[];
  private readonly debrisMesh: THREE.InstancedMesh;
  private readonly dActive = new Uint8Array(DEBRIS_MAX);
  private readonly dPos = new Float32Array(DEBRIS_MAX * 3);
  private readonly dVel = new Float32Array(DEBRIS_MAX * 3);
  private readonly dRot = new Float32Array(DEBRIS_MAX * 3);
  private readonly dRotVel = new Float32Array(DEBRIS_MAX * 3);
  private readonly dLife = new Float32Array(DEBRIS_MAX);
  private dCursor = 0;
  private debrisDirty = false;
  private readonly rng = mulberry32(0xd00d);

  // Scatter.
  private readonly fernMesh: THREE.InstancedMesh;
  private readonly reedMesh: THREE.InstancedMesh;
  private readonly flowerMesh: THREE.InstancedMesh;

  // Terrain + water + atmosphere.
  private readonly moss: MossPatches;
  private readonly water: PoolWater | null;
  private readonly mist: Mist;
  private readonly rays: GodRays;
  private readonly fireflies: Motes;
  private readonly pollen: Motes;
  private readonly beacons: PickupBeacons;

  // Focus for the trunk fade.
  private focusX = 0;
  private focusZ = 0;
  private hasFocus = false;

  constructor(sceneManager: SceneManager, arena: ArenaDef) {
    this.arena = arena;
    this.sm = sceneManager;
    const look = sceneManager.getLook();
    const rng = mulberry32(0x14c1);
    const own = <T extends { dispose(): void }>(x: T): T => {
      this.disposables.push(x);
      return x;
    };
    const flatMat = own(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.93, metalness: 0 }));
    const leafMat = own(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9, metalness: 0 }));
    const sunDir = new THREE.Vector3(look.sun.x, look.sun.y, look.sun.z).normalize();
    const R = arena.wallRadius;

    // ── Ground ──
    const gt = makeGroundTexture(arena, 1024);
    own(gt.map);
    const grain = own(typeof document === 'undefined' ? new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1) : makeGrainTexture(256));
    (grain as THREE.Texture).needsUpdate = true;
    const groundGeo = own(buildGroundGeometry(arena, gt.radius));
    this.groundMesh = new THREE.Mesh(groundGeo, own(makeGroundMaterial(gt.map, grain as THREE.Texture, this.timeU)));
    this.groundMesh.receiveShadow = true;
    this.root.add(this.groundMesh);

    // ── Static props (logs, pads + flower beds, rocks, shoreline stones, lily pads) ──
    const props = new VGeo();
    addLogs(props, arena, rng);
    addPads(props, arena, rng);
    addRocks(props, arena, rng);
    addLilyPads(props, arena, rng);
    this.propsMesh = new THREE.Mesh(own(props.build()), flatMat);
    this.propsMesh.castShadow = true;
    this.propsMesh.receiveShadow = true;
    this.root.add(this.propsMesh);

    // ── Wall ring ──
    const wall = buildWallGeometry(arena);
    this.wallMesh = new THREE.Mesh(own(wall.main), leafMat);
    this.wallMesh.receiveShadow = true;
    this.root.add(this.wallMesh);
    this.backdropMesh = new THREE.Mesh(own(wall.backdrop), leafMat);
    this.root.add(this.backdropMesh);

    // ── Trees: trunks (instanced, per-tree fade) + canopy + vines ──
    for (const c of arena.circles) {
      if (c.kind === 'tree') this.trees.push({ x: c.x, z: c.z, r: c.radius, h: c.height });
    }
    const n = this.trees.length;
    const trunkGeo = own(buildTrunkGeometry());
    this.fade = new Float32Array(n).fill(1);
    this.fadeAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.fade), 1);
    this.fadeAttr.setUsage(THREE.DynamicDrawUsage);
    trunkGeo.setAttribute('aFade', this.fadeAttr);
    this.trunkMesh = new THREE.InstancedMesh(trunkGeo, own(makeTrunkMaterial()), Math.max(1, n));
    this.trunkMesh.count = n;
    const tint = new THREE.Color();
    this.trees.forEach((t, i) => {
      _e.set(0, rng() * TAU, 0);
      _q.setFromEuler(_e);
      _p.set(t.x, 0, t.z);
      _s.set(t.r, 1, t.r);
      this.trunkMesh.setMatrixAt(i, _m.compose(_p, _q, _s));
      tint.setRGB(0.9 + rng() * 0.2, 0.9 + rng() * 0.2, 0.9 + rng() * 0.2);
      this.trunkMesh.setColorAt(i, tint);
    });
    this.trunkMesh.instanceMatrix.needsUpdate = true;
    if (this.trunkMesh.instanceColor !== null) this.trunkMesh.instanceColor.needsUpdate = true;
    this.trunkMesh.castShadow = true;
    this.trunkMesh.receiveShadow = true;
    this.trunkMesh.frustumCulled = false;
    this.root.add(this.trunkMesh);

    const leafGeo = own(buildLeafClumpGeometry());
    this.canopyTree = n * 5;
    this.canopyTotal = this.canopyTree + BUDGETS.high.ceiling;
    this.canopyMesh = new THREE.InstancedMesh(leafGeo, leafMat, this.canopyTotal);
    let ci = 0;
    const put = (x: number, y: number, z: number, sx: number, sy: number, sz: number): void => {
      _e.set(0, rng() * TAU, 0);
      _q.setFromEuler(_e);
      _p.set(x, y, z);
      _s.set(sx, sy, sz);
      this.canopyMesh.setMatrixAt(ci, _m.compose(_p, _q, _s));
      tint.setRGB(0.8 + rng() * 0.4, 0.85 + rng() * 0.35, 0.75 + rng() * 0.4);
      this.canopyMesh.setColorAt(ci, tint);
      ci++;
    };
    for (const t of this.trees) {
      // A crown of 5 clumps above 9 m (never below: the third-person camera must not be hidden by leaves).
      for (let k = 0; k < 5; k++) {
        const a = rng() * TAU;
        const off = k === 0 ? 0 : 1.6 + rng() * 2.4;
        const s = (k === 0 ? 3.9 : 2.6 + rng() * 1.5) * (0.8 + t.r * 0.18);
        put(t.x + Math.cos(a) * off, 13.4 + rng() * 2.2 + k * 0.15, t.z + Math.sin(a) * off, s * 1.2, s * 0.85, s * 1.2);
      }
    }
    for (let i = 0; i < BUDGETS.high.ceiling; i++) {
      // The ceiling ring: big overhead clumps around / beyond the clearing (reads as the layered canopy at the frame edge).
      const a = (i / BUDGETS.high.ceiling) * TAU + rng() * 0.2;
      const rr = 12 + rng() * 20;
      const s = 5 + rng() * 3.5;
      put(Math.cos(a) * rr, 15.5 + rng() * 3, Math.sin(a) * rr, s * 1.3, s * 0.8, s * 1.3);
    }
    this.canopyMesh.instanceMatrix.needsUpdate = true;
    if (this.canopyMesh.instanceColor !== null) this.canopyMesh.instanceColor.needsUpdate = true;
    this.canopyMesh.frustumCulled = false;
    this.root.add(this.canopyMesh);

    const vines: VineAnchor[] = [];
    for (const t of this.trees) {
      for (let k = 0; k < 2; k++) {
        const a = rng() * TAU;
        vines.push({ x: t.x + Math.cos(a) * t.r * 0.95, y: 11.5 + rng() * 1.5, z: t.z + Math.sin(a) * t.r * 0.95, length: 4.5 + rng() * 3.5 });
      }
    }
    for (let i = 0; i < 12; i++) {
      const a = rng() * TAU;
      const rr = 6 + rng() * 20;
      vines.push({ x: Math.cos(a) * rr, y: 13.5, z: Math.sin(a) * rr, length: 5 + rng() * 4 });
    }
    this.vineCount = vines.length;
    this.vineMesh = new THREE.Mesh(own(buildVinesGeometry(vines)), flatMat);
    this.vineMesh.frustumCulled = false;
    this.root.add(this.vineMesh);

    // ── Crates (wicker/vine) + debris ──
    const crates = arena.crates;
    const crateGeo = own(buildWickerCrateGeometry(crates.length > 0 ? crates[0].height : 1));
    this.crateMesh = new THREE.InstancedMesh(crateGeo, flatMat, Math.max(1, crates.length));
    this.crateMesh.count = crates.length;
    this.crateMesh.castShadow = true;
    this.crateMesh.receiveShadow = true;
    this.crateAlive = new Array<boolean>(crates.length).fill(true);
    for (let i = 0; i < crates.length; i++) {
      const cr = crates[i];
      _e.set(0, (rng() - 0.5) * 0.5, 0);
      _q.setFromEuler(_e);
      _p.set(cr.x, cr.height / 2, cr.z);
      _s.set(1, 1, 1);
      this.crateMesh.setMatrixAt(i, _m.compose(_p, _q, _s));
      tint.setRGB(0.88 + rng() * 0.24, 0.88 + rng() * 0.24, 0.88 + rng() * 0.24);
      this.crateMesh.setColorAt(i, tint);
    }
    this.crateBase = Float32Array.from(this.crateMesh.instanceMatrix.array as Float32Array);
    this.crateMesh.instanceMatrix.needsUpdate = true;
    if (this.crateMesh.instanceColor !== null) this.crateMesh.instanceColor.needsUpdate = true;
    this.root.add(this.crateMesh);

    const debrisMat = own(new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 1, metalness: 0 }));
    this.debrisMesh = new THREE.InstancedMesh(own(new THREE.BoxGeometry(0.26, 0.12, 0.2)), debrisMat, DEBRIS_MAX);
    this.debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debrisMesh.frustumCulled = false;
    const straw = [new THREE.Color(0xb59a5a), new THREE.Color(0x8c7040), new THREE.Color(0x4f7a2a), new THREE.Color(0xc9b06c)];
    for (let i = 0; i < DEBRIS_MAX; i++) {
      this.debrisMesh.setMatrixAt(i, ZERO_SCALE);
      this.debrisMesh.setColorAt(i, straw[i % straw.length]);
    }
    this.debrisMesh.instanceMatrix.needsUpdate = true;
    if (this.debrisMesh.instanceColor !== null) this.debrisMesh.instanceColor.needsUpdate = true;
    this.root.add(this.debrisMesh);

    // ── Scatter: ferns, reeds, glow flowers ──
    const water = arena.terrain.find((z) => z.kind === 'water') ?? null;
    const moss = arena.terrain.filter((z) => z.kind === 'moss');
    const fernMat = own(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9, metalness: 0, side: THREE.DoubleSide }));
    this.fernMesh = new THREE.InstancedMesh(own(buildFernGeometry()), fernMat, BUDGETS.high.ferns);
    let f = 0;
    for (let tries = 0; tries < 4000 && f < BUDGETS.high.ferns; tries++) {
      let x: number;
      let z: number;
      const roll = rng();
      if (roll < 0.5 && this.trees.length > 0) {
        const t = this.trees[Math.floor(rng() * this.trees.length)];
        const a = rng() * TAU;
        const d = t.r + 0.9 + rng() * 3.4;
        x = t.x + Math.cos(a) * d;
        z = t.z + Math.sin(a) * d;
      } else if (roll < 0.78) {
        const a = rng() * TAU;
        const d = R - 1.2 - rng() * 4.5;
        x = Math.cos(a) * d;
        z = Math.sin(a) * d;
      } else if (roll < 0.9 && moss.length > 0) {
        const m = moss[Math.floor(rng() * moss.length)];
        const a = rng() * TAU;
        const d = m.radius * (0.95 + rng() * 0.8);
        x = m.x + Math.cos(a) * d;
        z = m.z + Math.sin(a) * d;
      } else {
        const a = rng() * TAU;
        const d = Math.sqrt(rng()) * (R - 2);
        x = Math.cos(a) * d;
        z = Math.sin(a) * d;
      }
      if (!isScatterClear(arena, x, z, 0.75)) continue;
      const s = 0.75 + rng() * 0.8;
      this.fernMesh.setMatrixAt(f, composeMatrix(x, 0, z, rng() * TAU, s, s * (0.8 + rng() * 0.5), s));
      tint.setRGB(0.8 + rng() * 0.45, 0.85 + rng() * 0.4, 0.75 + rng() * 0.4);
      this.fernMesh.setColorAt(f, tint);
      f++;
    }
    this.fernMesh.count = f;
    this.fernMesh.instanceMatrix.needsUpdate = true;
    if (this.fernMesh.instanceColor !== null) this.fernMesh.instanceColor.needsUpdate = true;
    this.fernMesh.frustumCulled = false;
    this.fernMesh.receiveShadow = true;
    this.root.add(this.fernMesh);

    this.reedMesh = new THREE.InstancedMesh(own(buildReedGeometry()), fernMat, BUDGETS.high.reeds);
    let rcount = 0;
    if (water !== null) {
      for (let tries = 0; tries < 400 && rcount < BUDGETS.high.reeds - 4; tries++) {
        const a = rng() * TAU;
        const d = water.radius + 0.35 + rng() * 1.2;
        const x = water.x + Math.cos(a) * d;
        const z = water.z + Math.sin(a) * d;
        if (!isScatterClear(arena, x, z, 0.6, true)) continue;
        const s = 0.8 + rng() * 0.6;
        this.reedMesh.setMatrixAt(rcount, composeMatrix(x, 0, z, rng() * TAU, s, s, s));
        tint.setRGB(0.85 + rng() * 0.3, 0.9 + rng() * 0.25, 0.8 + rng() * 0.3);
        this.reedMesh.setColorAt(rcount, tint);
        rcount++;
      }
    }
    for (let tries = 0; tries < 200 && rcount < BUDGETS.high.reeds && moss.length > 0; tries++) {
      const m = moss[Math.floor(rng() * moss.length)];
      const a = rng() * TAU;
      const d = m.radius * (0.7 + rng() * 0.5);
      const x = m.x + Math.cos(a) * d;
      const z = m.z + Math.sin(a) * d;
      if (!isScatterClear(arena, x, z, 0.4, true)) continue;
      const s = 0.55 + rng() * 0.4;
      this.reedMesh.setMatrixAt(rcount, composeMatrix(x, 0, z, rng() * TAU, s, s, s));
      tint.setRGB(0.85 + rng() * 0.3, 0.9 + rng() * 0.25, 0.8 + rng() * 0.3);
      this.reedMesh.setColorAt(rcount, tint);
      rcount++;
    }
    this.reedMesh.count = rcount;
    this.reedMesh.instanceMatrix.needsUpdate = true;
    if (this.reedMesh.instanceColor !== null) this.reedMesh.instanceColor.needsUpdate = true;
    this.reedMesh.frustumCulled = false;
    this.root.add(this.reedMesh);

    // Glow flowers: a ring around every pad + scattered clusters (unlit, colours > 1 so bloom picks them up).
    const flowerMat = own(new THREE.MeshBasicMaterial({ vertexColors: true }));
    const GLOW: [number, number, number][] = [
      [2.3, 0.95, 1.5],
      [0.8, 1.9, 2.1],
      [2.3, 1.9, 0.7],
      [1.9, 1.9, 1.7],
    ];
    const flowerSpots: { x: number; z: number }[] = [];
    for (const pad of arena.pickupPads) {
      for (let k = 0; k < 9; k++) {
        const a = (k / 9) * TAU + rng() * 0.3;
        const d = 1.55 + rng() * 0.5;
        flowerSpots.push({ x: pad.x + Math.cos(a) * d, z: pad.z + Math.sin(a) * d });
      }
    }
    for (let tries = 0; tries < 300 && flowerSpots.length < 120; tries++) {
      const a = rng() * TAU;
      const d = 4 + Math.sqrt(rng()) * (R - 6);
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      if (!isScatterClear(arena, x, z, 0.8)) continue;
      const cnt = 2 + Math.floor(rng() * 3);
      for (let k = 0; k < cnt; k++) flowerSpots.push({ x: x + (rng() - 0.5) * 0.9, z: z + (rng() - 0.5) * 0.9 });
    }
    this.flowerMesh = new THREE.InstancedMesh(own(buildGlowFlowerGeometry()), flowerMat, Math.max(1, flowerSpots.length));
    flowerSpots.forEach((sp, i) => {
      const s = 0.85 + rng() * 0.7;
      this.flowerMesh.setMatrixAt(i, composeMatrix(sp.x, 0.1 + rng() * 0.05, sp.z, rng() * TAU, s, s, s));
      const g = GLOW[Math.floor(rng() * GLOW.length)];
      tint.setRGB(g[0], g[1], g[2]);
      this.flowerMesh.setColorAt(i, tint);
    });
    this.flowerMesh.count = flowerSpots.length;
    this.flowerMesh.instanceMatrix.needsUpdate = true;
    if (this.flowerMesh.instanceColor !== null) this.flowerMesh.instanceColor.needsUpdate = true;
    this.flowerMesh.frustumCulled = false;
    this.root.add(this.flowerMesh);

    // ── Moss + water ──
    this.moss = new MossPatches(arena.terrain, this.timeU);
    this.root.add(this.moss.group);
    this.water = water === null ? null : new PoolWater(water, this.timeU, sunDir, look.skySun, look.skyHorizon);
    if (this.water !== null) this.root.add(this.water.mesh);

    // ── Atmosphere ──
    this.mist = new Mist(R + GROUND_MARGIN, R, water === null ? null : { x: water.x, z: water.z, radius: water.radius }, this.timeU);
    this.root.add(this.mist.group);
    this.rays = new GodRays(sunDir, this.timeU);
    this.root.add(this.rays.mesh);
    this.fireflies = new Motes(BUDGETS.high.fireflies, true, R - 3, this.timeU, 0xf1f1);
    this.pollen = new Motes(BUDGETS.high.pollen, false, R - 2, this.timeU, 0x9011);
    this.root.add(this.fireflies.points, this.pollen.points);

    // ── Pickup beacons (the colosseum's icons / rings / lights, on the jungle's pads) ──
    this.beacons = new PickupBeacons(arena.pickupPads);
    this.root.add(this.beacons.root);

    this.tier = getQualityTier();
    this.applyTier(this.tier);
    this.unsubscribe = onQualityChange((t) => this.applyTier(t));
  }

  // ── ArenaScene ─────────────────────────────────────────────────────────────

  update(dt: number, excitement: number): void {
    void excitement;
    this.time += dt;
    this.timeU.value = this.time;
    this.fireflies.update();
    this.pollen.update();
    this.updateDebris(dt);
    this.updateTrunkFade(dt);
    this.beacons.update(dt, this.time);
  }

  breakCrate(id: number): void {
    const crates = this.arena.crates;
    if (id < 0 || id >= crates.length || !this.crateAlive[id]) return;
    this.crateAlive[id] = false;
    this.crateMesh.setMatrixAt(id, ZERO_SCALE);
    this.crateMesh.instanceMatrix.needsUpdate = true;
    const cr = crates[id];
    for (let n = 0; n < DEBRIS_PER_CRATE; n++) {
      const i = this.dCursor;
      this.dCursor = (this.dCursor + 1) % DEBRIS_MAX;
      this.dActive[i] = 1;
      this.dLife[i] = 2.2 + this.rng() * 0.5;
      const o = i * 3;
      this.dPos[o] = cr.x + (this.rng() - 0.5) * 0.6;
      this.dPos[o + 1] = 0.4 + this.rng() * 0.6;
      this.dPos[o + 2] = cr.z + (this.rng() - 0.5) * 0.6;
      const ang = this.rng() * TAU;
      const sp = 1.5 + this.rng() * 2.5;
      this.dVel[o] = Math.cos(ang) * sp;
      this.dVel[o + 1] = 2.5 + this.rng() * 2.5;
      this.dVel[o + 2] = Math.sin(ang) * sp;
      this.dRot[o] = this.rng() * TAU;
      this.dRot[o + 1] = this.rng() * TAU;
      this.dRot[o + 2] = this.rng() * TAU;
      this.dRotVel[o] = (this.rng() - 0.5) * 12;
      this.dRotVel[o + 1] = (this.rng() - 0.5) * 12;
      this.dRotVel[o + 2] = (this.rng() - 0.5) * 12;
    }
  }

  isCrateAlive(id: number): boolean {
    return id >= 0 && id < this.crateAlive.length && this.crateAlive[id];
  }

  resetCrates(): void {
    (this.crateMesh.instanceMatrix.array as Float32Array).set(this.crateBase);
    this.crateAlive.fill(true);
    this.crateMesh.instanceMatrix.needsUpdate = true;
  }

  setPickupVisible(padIndex: number, kind: PickupKind, visible: boolean): void {
    if (padIndex < 0 || padIndex >= this.arena.pickupPads.length) return;
    const kindIdx = PICKUP_KINDS.indexOf(kind);
    if (kindIdx < 0) return;
    if (visible) this.beacons.setVisible(padIndex, kindIdx, true);
    else for (let k = 0; k < PICKUP_KINDS.length; k++) this.beacons.setVisible(padIndex, k, false);
  }

  setPickupFocus(x: number, z: number): void {
    this.focusX = x;
    this.focusZ = z;
    this.hasFocus = true;
    this.beacons.setFocus(x, z);
  }

  dispose(): void {
    this.unsubscribe();
    this.root.removeFromParent();
    this.beacons.dispose();
    this.moss.dispose();
    this.water?.dispose();
    this.mist.dispose();
    this.rays.dispose();
    this.fireflies.dispose();
    this.pollen.dispose();
    this.trunkMesh.dispose();
    this.canopyMesh.dispose();
    this.crateMesh.dispose();
    this.debrisMesh.dispose();
    this.fernMesh.dispose();
    this.reedMesh.dispose();
    this.flowerMesh.dispose();
    this.vineMesh.geometry.dispose();
    this.wallMesh.geometry.dispose();
    this.backdropMesh.geometry.dispose();
    this.propsMesh.geometry.dispose();
    this.groundMesh.geometry.dispose();
    for (const d of this.disposables) d.dispose();
  }

  // ── Introspection (tests / QA demo) ────────────────────────────────────────

  /** Current per-tree fade values (1 = solid). */
  getTrunkFades(): Float32Array {
    return this.fade;
  }

  getStats(): JungleStats {
    return {
      trees: this.trees.length,
      canopyClumps: this.canopyMesh.count,
      crates: this.crateAlive.length,
      moss: this.arena.terrain.filter((z) => z.kind === 'moss').length,
      ferns: this.fernMesh.count,
      reeds: this.reedMesh.count,
      glowFlowers: this.flowerMesh.count,
      vines: this.vineCount,
    };
  }

  getTier(): QualityTier {
    return this.tier;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private applyTier(tier: QualityTier): void {
    this.tier = tier;
    const b = BUDGETS[tier];
    const prof = tierProfile(tier);
    this.fernMesh.visible = b.ferns > 0;
    this.fernMesh.count = Math.min(this.fernMesh.instanceMatrix.count, b.ferns);
    this.reedMesh.count = Math.min(this.reedMesh.instanceMatrix.count, b.reeds);
    this.moss.setDetail(b.tufts);
    this.fireflies.setCount(b.fireflies);
    this.pollen.setCount(b.pollen);
    this.mist.setLayers(b.mist);
    this.rays.mesh.visible = b.rays && prof.lightShafts;
    this.backdropMesh.visible = b.backdrop;
    this.canopyMesh.count = this.canopyTree + b.ceiling;
    this.beacons.setTier(tier);
  }

  private updateTrunkFade(dt: number): void {
    if (!this.hasFocus || this.trees.length === 0) return;
    const cam = this.sm.camera.position;
    let dirty = false;
    for (let i = 0; i < this.trees.length; i++) {
      const t = this.trees[i];
      const target = trunkFadeTarget(cam.x, cam.y, cam.z, this.focusX, FOCUS_HEAD_Y, this.focusZ, t.x, t.z, t.r, TRUNK_HEIGHT);
      const next = stepFade(this.fade[i], target, dt);
      if (next !== this.fade[i]) {
        this.fade[i] = next;
        this.fadeAttr.setX(i, next);
        dirty = true;
      }
    }
    if (dirty) this.fadeAttr.needsUpdate = true;
  }

  private updateDebris(dt: number): void {
    let any = false;
    for (let i = 0; i < DEBRIS_MAX; i++) {
      if (this.dActive[i] === 0) continue;
      any = true;
      const o = i * 3;
      this.dLife[i] -= dt;
      if (this.dLife[i] <= 0) {
        this.dActive[i] = 0;
        this.debrisMesh.setMatrixAt(i, ZERO_SCALE);
        continue;
      }
      this.dVel[o + 1] -= 18 * dt;
      this.dPos[o] += this.dVel[o] * dt;
      this.dPos[o + 1] += this.dVel[o + 1] * dt;
      this.dPos[o + 2] += this.dVel[o + 2] * dt;
      if (this.dPos[o + 1] < 0.08) {
        this.dPos[o + 1] = 0.08;
        this.dVel[o + 1] *= -0.25;
        this.dVel[o] *= 0.55;
        this.dVel[o + 2] *= 0.55;
        this.dRotVel[o] *= 0.4;
        this.dRotVel[o + 1] *= 0.4;
        this.dRotVel[o + 2] *= 0.4;
      }
      this.dRot[o] += this.dRotVel[o] * dt;
      this.dRot[o + 1] += this.dRotVel[o + 1] * dt;
      this.dRot[o + 2] += this.dRotVel[o + 2] * dt;
      const scale = this.dLife[i] < 0.4 ? this.dLife[i] / 0.4 : 1;
      _e.set(this.dRot[o], this.dRot[o + 1], this.dRot[o + 2]);
      _q.setFromEuler(_e);
      _p.set(this.dPos[o], this.dPos[o + 1], this.dPos[o + 2]);
      _s.set(scale, scale, scale);
      _m.compose(_p, _q, _s);
      this.debrisMesh.setMatrixAt(i, _m);
    }
    if (any || this.debrisDirty) this.debrisMesh.instanceMatrix.needsUpdate = true;
    this.debrisDirty = any;
  }
}

/** Short-lived translate · yaw · scale matrix (returned matrix is a fresh clone: safe to store). */
function composeMatrix(x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number): THREE.Matrix4 {
  return composeMat(x, y, z, 0, yaw, 0, sx, sy, sz).clone();
}
