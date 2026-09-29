/**
 * Stadium (BLUEPRINT §9 / §11.2, upgraded in v1.1 WP-K) — the whole colosseum,
 * built procedurally and ENTIRELY from `config/arena.ts` data:
 *
 * - sand disc with a procedural canvas texture (grain, ripples, tracks,
 *   compacted gutter) + tiling bump, an inlaid stone ring and a sun emblem,
 * - 5 m wall of block courses with plinth, red/gold frieze, pilasters and cap,
 *   4 gates (N/E/S/W) with flanking torches, 8 waving cloth banners,
 * - tiered stands r 31→44 with lipped risers, an InstancedMesh crowd (≥1200,
 *   tunic + skin-tone variety, 10 Hz bob) and waving crowd flags,
 * - Emperor's box at north with braziers, 6 fluted pillars topped by braziers,
 *   2 fallen columns, 4 crate clusters (`breakCrate(id)` + pooled debris),
 *   central dais, 6 pickup pads with floating icons (`setPickupVisible`),
 * - ambience: 16 flickering flames + embers, ≤4 real torch point lights (tier),
 *   god-ray light shafts and drifting dust motes (tier).
 *
 * Draw calls (high): sand 1 + stone 1 + stands 1 + crowd 1 + flags 1 +
 * banners 1 + crates 1 + debris 1 + flames 1 + embers 1 + shafts 1 + motes 1
 * + pickup beacons (3 icon instancers + ring + column + sparks, ≤6, + ≤2 labels)
 * ≈ 20 (+ shadow pass).
 */

import * as THREE from 'three';
import type { PickupState } from '../core/types';
import { mulberry32, TAU } from '../core/math';
import {
  CRATES,
  CRATE_SIZE,
  DAIS,
  FALLEN_COLUMNS,
  GATE_ANGLES_DEG,
  PICKUP_PADS,
  PILLARS,
  STANDS_INNER,
  STANDS_OUTER,
  WALL_HEIGHT,
  WALL_RADIUS,
} from '../config/arena';
import { GeoAccumulator, matAt, matQuatAt, ringFacingYaw } from './geo';
import { Crowd, type CrowdSeat } from './crowd';
import {
  DustMotes,
  Fires,
  LightShafts,
  clothPlane,
  flagGeometry,
  makeBannerTexture,
  makeClothMaterial,
  makeGrainTexture,
  makeSandTexture,
  type FireSpot,
} from './arenaFx';
import { SUN_POSITION } from './SceneManager';
import { getQualityTier, onQualityChange, tierProfile, type QualityTier } from './quality';
import { PickupBeacons } from './pickupBeacons';

export type PickupKind = PickupState['kind'];

// ── Palette (warm stone / sand / cloth) ──────────────────────────────────────
const COL_WALL = 0xb8a47f;
const COL_WALL_DARK = 0x7d6a4f;
const COL_WALL_CAP = 0x93805f;
const COL_PLINTH = 0x8a7656;
const COL_STONE = 0xae9a74;
const COL_STONE_DARK = 0x8b7757;
const COL_TIER_A = 0xa5906d;
const COL_TIER_B = 0x98845f;
const COL_TIER_LIP = 0xc2b08b;
const COL_MARBLE = 0xd3c7aa;
const COL_GATE_DARK = 0x241c12;
const COL_BARS = 0x3d372e;
const COL_CLOTH = 0x8f2118;
const COL_GOLD = 0xb3944f;
const COL_BRONZE = 0x6e4a2a;
const COL_COALS = 0x3a1a0c;
const COL_WOOD = 0x8a6238;
const COL_WOOD_DARK = 0x5f4326;

// Stands layout (cosmetic; §9 gives only the r 31→44 envelope).
const TIERS = 8;
const TIER_DEPTH = (STANDS_OUTER - STANDS_INNER) / TIERS;
const TIER_RISE = 0.85;
const TIER_BASE_Y = 4.3;

// Emperor's box angular gap in the crowd (north = layout angle 90°).
const EMPEROR_ANGLE = 90;
const EMPEROR_HALF_ARC = 9;

const DEBRIS_MAX = 72;
const DEBRIS_PER_CRATE = 6;
const FLAGS = 72;
const PICKUP_KINDS: readonly PickupKind[] = ['heal', 'speed', 'rage'];
const FLAG_COLORS: readonly number[] = [0xb3261a, 0xd9a441, 0x2f5a9e, 0x3f7a3a, 0xece4d2, 0x6b3d8a];

// Scratch (no per-frame allocation).
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const ZERO_SCALE = new THREE.Matrix4().makeScale(0, 0, 0);

export class Stadium {
  readonly root = new THREE.Group();

  private readonly crowd: Crowd;
  private readonly sandMesh: THREE.Mesh;
  private readonly stoneMesh: THREE.Mesh;
  private readonly standsMesh: THREE.Mesh;
  private readonly bannerMesh: THREE.Mesh;
  private readonly flagMesh: THREE.InstancedMesh;
  private readonly fires: Fires;
  private readonly shafts: LightShafts;
  private readonly motes: DustMotes;
  private readonly textures: THREE.Texture[] = [];

  private readonly crateMesh: THREE.InstancedMesh;
  private readonly crateBase: Float32Array; // saved instance matrices
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

  /** Pickup medallions + pad rings/columns/labels (kind order: heal, speed, rage). */
  private readonly beacons: PickupBeacons;
  private readonly materials: THREE.Material[] = [];
  private readonly unsubscribe: () => void;

  private readonly rng = mulberry32(0xd00d);
  private readonly timeU = { value: 0 };
  private time = 0;

  constructor() {
    const rng = mulberry32(0x57ad1a);

    // ── Sand disc: procedural texture + tiling grain bump (§11.2) ───────────
    const sandGeo = new THREE.CircleGeometry(WALL_RADIUS, 96);
    sandGeo.rotateX(-Math.PI / 2);
    // (No bump map: three's derivative bump can emit NaN texels at grazing
    // distance, which the bloom blur smears into blocks. Grain lives in the
    // colour map + a tiling detail multiply instead.)
    const sandTex = makeSandTexture(1024);
    const grainTex = makeGrainTexture(256);
    grainTex.repeat.set(22, 22);
    this.textures.push(sandTex, grainTex);
    const sandMat = new THREE.MeshStandardMaterial({
      map: sandTex,
      roughness: 0.97,
      metalness: 0,
    });
    sandMat.onBeforeCompile = (shader) => {
      shader.uniforms.uGrain = { value: grainTex };
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uGrain;')
        .replace(
          '#include <map_fragment>',
          '#include <map_fragment>\n#ifdef USE_MAP\n' +
            'diffuseColor.rgb *= 0.82 + 0.36 * texture2D(uGrain, vMapUv * 22.0).r;\n#endif',
        );
    };
    sandMat.customProgramCacheKey = () => 'gk-sand-grain';
    this.materials.push(sandMat);
    this.sandMesh = new THREE.Mesh(sandGeo, sandMat);
    this.sandMesh.receiveShadow = true;
    this.root.add(this.sandMesh);

    // Shared flat-shaded vertex-color stone material.
    const stoneMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.9,
      metalness: 0,
    });
    this.materials.push(stoneMat);

    // Fire spots (pillar braziers, gate torches, Emperor's box braziers).
    const fireSpots: FireSpot[] = [];
    const lightSpots: FireSpot[] = [];

    // ── Inner structures (cast shadows) — one merged mesh ────────────────────
    const stone = new GeoAccumulator();
    this.buildWall(stone, rng);
    this.buildGates(stone, fireSpots, lightSpots);
    this.buildPillars(stone, rng, fireSpots);
    this.buildFallenColumns(stone);
    this.buildDais(stone);
    this.buildPads(stone);
    this.stoneMesh = stone.build(stoneMat);
    this.stoneMesh.castShadow = true;
    this.stoneMesh.receiveShadow = true;
    this.root.add(this.stoneMesh);

    // ── Outer structures (no shadow casting) ─────────────────────────────────
    const stands = new GeoAccumulator();
    this.buildStands(stands, rng);
    this.buildParapet(stands, rng);
    this.buildEmperorBox(stands, fireSpots);
    this.buildBannerPoles(stands);
    this.standsMesh = stands.build(stoneMat);
    this.standsMesh.castShadow = false;
    this.standsMesh.receiveShadow = false;
    this.root.add(this.standsMesh);

    // ── Waving banners (one merged cloth mesh) ───────────────────────────────
    const bannerTex = makeBannerTexture();
    this.textures.push(bannerTex);
    const bannerMat = makeClothMaterial(
      { map: bannerTex, side: THREE.DoubleSide, alphaTest: 0.5, roughness: 0.85, metalness: 0 },
      this.timeU,
      0.11,
      1.7,
    );
    this.materials.push(bannerMat);
    this.bannerMesh = new THREE.Mesh(this.buildBanners(), bannerMat);
    this.bannerMesh.castShadow = true;
    this.root.add(this.bannerMesh);

    // ── Crowd + flags ────────────────────────────────────────────────────────
    const seats = this.buildSeats(rng);
    this.crowd = new Crowd(seats, rng);
    this.root.add(this.crowd.mesh);
    const flagMat = makeClothMaterial(
      { vertexColors: true, side: THREE.DoubleSide, roughness: 0.9, metalness: 0 },
      this.timeU,
      0.07,
      6.5,
    );
    this.materials.push(flagMat);
    this.flagMesh = new THREE.InstancedMesh(flagGeometry(), flagMat, FLAGS);
    this.flagMesh.frustumCulled = false;
    {
      const c = new THREE.Color();
      for (let i = 0; i < FLAGS; i++) {
        const s = seats[Math.floor(rng() * seats.length)];
        this.flagMesh.setMatrixAt(i, matAt(s.x, s.y + 0.1, s.z, s.yaw + Math.PI / 2 + (rng() - 0.5) * 0.8, 1));
        c.setHex(FLAG_COLORS[Math.floor(rng() * FLAG_COLORS.length)]).multiplyScalar(0.85 + rng() * 0.3);
        this.flagMesh.setColorAt(i, c);
      }
      this.flagMesh.instanceMatrix.needsUpdate = true;
      if (this.flagMesh.instanceColor !== null) this.flagMesh.instanceColor.needsUpdate = true;
    }
    this.root.add(this.flagMesh);

    // ── Ambience: fires + lights, shafts, dust motes ─────────────────────────
    this.fires = new Fires(fireSpots, lightSpots, this.timeU);
    this.root.add(this.fires.group);
    const sunDir = new THREE.Vector3(SUN_POSITION.x, SUN_POSITION.y, SUN_POSITION.z).normalize();
    this.shafts = new LightShafts(sunDir, this.timeU);
    this.root.add(this.shafts.mesh);
    this.motes = new DustMotes(tierProfile('high').dustMotes, this.timeU);
    this.root.add(this.motes.points);

    // ── Crates (InstancedMesh; ids = CRATES array order) ────────────────────
    const crateMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.95,
      metalness: 0,
    });
    this.materials.push(crateMat);
    this.crateMesh = new THREE.InstancedMesh(buildCrateGeometry(), crateMat, CRATES.length);
    this.crateMesh.castShadow = true;
    this.crateMesh.receiveShadow = true;
    this.crateAlive = new Array<boolean>(CRATES.length).fill(true);
    const tint = new THREE.Color();
    for (let i = 0; i < CRATES.length; i++) {
      const cr = CRATES[i];
      this.crateMesh.setMatrixAt(i, matAt(cr.x, CRATE_SIZE / 2, cr.z, (rng() - 0.5) * 0.5));
      tint.setHex(0xffffff).multiplyScalar(0.85 + rng() * 0.3);
      this.crateMesh.setColorAt(i, tint);
    }
    this.crateBase = Float32Array.from(this.crateMesh.instanceMatrix.array as Float32Array);
    this.crateMesh.instanceMatrix.needsUpdate = true;
    if (this.crateMesh.instanceColor !== null) this.crateMesh.instanceColor.needsUpdate = true;
    this.root.add(this.crateMesh);

    // ── Debris pool (crate break chunks) ─────────────────────────────────────
    const debrisMat = new THREE.MeshStandardMaterial({
      color: COL_WOOD_DARK,
      flatShading: true,
      roughness: 1,
      metalness: 0,
    });
    this.materials.push(debrisMat);
    this.debrisMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.28, 0.2, 0.24), debrisMat, DEBRIS_MAX);
    this.debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debrisMesh.castShadow = false;
    this.debrisMesh.frustumCulled = false;
    for (let i = 0; i < DEBRIS_MAX; i++) this.debrisMesh.setMatrixAt(i, ZERO_SCALE);
    this.debrisMesh.instanceMatrix.needsUpdate = true;
    this.root.add(this.debrisMesh);

    // ── Pickup pad beacons (v1.2: heal cross / speed bolt / power swords) ────
    this.beacons = new PickupBeacons(PICKUP_PADS);
    this.root.add(this.beacons.root);

    this.applyTier(getQualityTier());
    this.unsubscribe = onQualityChange((t) => this.applyTier(t));
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Number of crowd instances (≥1200 per §11.2). */
  get crowdCount(): number {
    return this.crowd.count;
  }

  /**
   * Advance crowd bob (10 Hz coarse tick, amplitude scaled by `excitement`
   * 0–1 — pass `SceneManager.excitement`), debris physics, icon spin, and the
   * GPU-animated ambience clock (flames, embers, motes, shafts, cloth).
   */
  update(dt: number, excitement: number): void {
    this.time += dt;
    this.timeU.value = this.time;
    this.crowd.update(dt, excitement);
    this.updateDebris(dt);
    this.fires.update(this.time);
    this.motes.update();

    // Floating pickup medallions, pad rings, light columns, labels.
    this.beacons.update(dt, this.time);
  }

  /**
   * Remove crate `id` (index into `config/arena.ts` CRATES order) and burst a
   * pooled debris pile in its place. Safe to call twice.
   */
  breakCrate(id: number): void {
    if (id < 0 || id >= CRATES.length || !this.crateAlive[id]) return;
    this.crateAlive[id] = false;
    this.crateMesh.setMatrixAt(id, ZERO_SCALE);
    this.crateMesh.instanceMatrix.needsUpdate = true;

    const cr = CRATES[id];
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

  /** Whether crate `id` is still standing (demo/collision helpers). */
  isCrateAlive(id: number): boolean {
    return id >= 0 && id < this.crateAlive.length && this.crateAlive[id];
  }

  /** Restore all crates (rematch). */
  resetCrates(): void {
    (this.crateMesh.instanceMatrix.array as Float32Array).set(this.crateBase);
    this.crateAlive.fill(true);
    this.crateMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Show/hide the floating icon of `kind` on pad `padIndex` (0–5, matching
   * `config/arena.ts` PICKUP_PADS order). Showing a kind hides the other two.
   */
  setPickupVisible(padIndex: number, kind: PickupKind, visible: boolean): void {
    if (padIndex < 0 || padIndex >= PICKUP_PADS.length) return;
    const kindIdx = PICKUP_KINDS.indexOf(kind);
    if (kindIdx < 0) return;
    if (visible) this.beacons.setVisible(padIndex, kindIdx, true);
    else for (let k = 0; k < PICKUP_KINDS.length; k++) this.beacons.setVisible(padIndex, k, false);
  }

  /**
   * Optional: the local player's ground position, for the pickup proximity
   * labels (HEAL / SPEED / POWER fade in within ≈10 m). Without it the labels
   * estimate the player ≈5.5 m ahead of the chase camera.
   */
  setPickupFocus(x: number, z: number): void {
    this.beacons.setFocus(x, z);
  }

  dispose(): void {
    this.unsubscribe();
    this.crowd.dispose();
    this.fires.dispose();
    this.shafts.dispose();
    this.motes.dispose();
    this.sandMesh.geometry.dispose();
    this.stoneMesh.geometry.dispose();
    this.standsMesh.geometry.dispose();
    this.bannerMesh.geometry.dispose();
    this.flagMesh.geometry.dispose();
    this.crateMesh.geometry.dispose();
    this.debrisMesh.geometry.dispose();
    this.beacons.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
  }

  // ── Quality tier ─────────────────────────────────────────────────────────

  private applyTier(tier: QualityTier): void {
    const prof = tierProfile(tier);
    this.fires.setLightCount(prof.pointLights);
    this.shafts.mesh.visible = prof.lightShafts;
    this.motes.setCount(prof.dustMotes);
    this.flagMesh.visible = prof.crowdFlags;
    this.beacons.setTier(tier);
  }

  // ── Builders (init-time only; all data from config/arena.ts) ──────────────

  private buildWall(acc: GeoAccumulator, rng: () => number): void {
    const segments = 36;
    const wallR = WALL_RADIUS + 0.45; // panel centerline (inner face ≈ r 30)
    const panelW = (TAU * wallR) / segments + 0.12;
    const c = new THREE.Color();
    const courses = [0.62, 1.95, 3.25, 4.45]; // block course boundaries
    for (let i = 0; i < segments; i++) {
      const th = (i / segments) * TAU;
      const base = matAt(Math.cos(th) * wallR, 0, Math.sin(th) * wallR, ringFacingYaw(th));
      const at = (x: number, y: number, z: number): THREE.Matrix4 => base.clone().multiply(matAt(x, y, z));
      // Dark mortar backing panel.
      acc.add(new THREE.BoxGeometry(panelW, WALL_HEIGHT, 0.9), COL_WALL_DARK, at(0, WALL_HEIGHT / 2, 0));
      // Plinth.
      acc.add(new THREE.BoxGeometry(panelW + 0.04, courses[0], 1.08), COL_PLINTH, at(0, courses[0] / 2, 0.05));
      // Block courses (two blocks per panel, staggered).
      for (let k = 0; k < 3; k++) {
        const y0 = courses[k];
        const y1 = courses[k + 1];
        const h = y1 - y0 - 0.05;
        // Even courses: two half blocks; odd courses: centre block + two quarters.
        const xs = k % 2 === 0 ? [-0.25, 0.25] : [-0.375, 0, 0.375];
        const ws = k % 2 === 0 ? [0.5, 0.5] : [0.25, 0.5, 0.25];
        for (let b = 0; b < xs.length; b++) {
          c.setHex(COL_WALL).multiplyScalar(0.88 + rng() * 0.2);
          acc.add(new THREE.BoxGeometry(panelW * ws[b] - 0.05, h, 0.96), c, at(panelW * xs[b], y0 + h / 2 + 0.025, 0.02));
        }
      }
      // Red frieze with gold trim lines.
      acc.add(new THREE.BoxGeometry(panelW, 0.36, 0.98), COL_CLOTH, at(0, 4.64, 0.02));
      acc.add(new THREE.BoxGeometry(panelW, 0.05, 1.0), COL_GOLD, at(0, 4.46, 0.02));
      acc.add(new THREE.BoxGeometry(panelW, 0.05, 1.0), COL_GOLD, at(0, 4.82, 0.02));
      // Cap course on top of the wall.
      acc.add(new THREE.BoxGeometry(panelW + 0.2, 0.45, 1.25), COL_WALL_CAP, at(0, WALL_HEIGHT + 0.22, 0));
      // Pilaster every third panel.
      if (i % 3 === 0) {
        acc.add(new THREE.BoxGeometry(0.5, WALL_HEIGHT - 0.2, 0.3), COL_STONE, at(-panelW / 2, (WALL_HEIGHT - 0.2) / 2, 0.55));
        acc.add(new THREE.BoxGeometry(0.66, 0.2, 0.42), COL_WALL_CAP, at(-panelW / 2, WALL_HEIGHT - 0.2, 0.55));
      }
    }
  }

  private buildGates(acc: GeoAccumulator, fires: FireSpot[], lights: FireSpot[]): void {
    const v = new THREE.Vector3();
    for (const deg of GATE_ANGLES_DEG) {
      const th = (deg * Math.PI) / 180;
      const r = WALL_RADIUS - 0.1;
      const base = matAt(Math.cos(th) * r, 0, Math.sin(th) * r, ringFacingYaw(th));
      const at = (x: number, y: number, z: number): THREE.Matrix4 => base.clone().multiply(matAt(x, y, z));
      // Jambs + lintel + keystone.
      acc.add(new THREE.BoxGeometry(0.55, 4.4, 0.6), COL_STONE_DARK, at(-1.35, 2.2, 0));
      acc.add(new THREE.BoxGeometry(0.55, 4.4, 0.6), COL_STONE_DARK, at(1.35, 2.2, 0));
      acc.add(new THREE.BoxGeometry(3.4, 0.65, 0.7), COL_STONE_DARK, at(0, 4.5, 0));
      acc.add(new THREE.BoxGeometry(0.5, 0.8, 0.78), COL_GOLD, at(0, 4.5, 0.02));
      // Dark recess behind the bars (toward the wall = local −Z).
      acc.add(new THREE.BoxGeometry(2.25, 4.1, 0.25), COL_GATE_DARK, at(0, 2.05, -0.28));
      // 5 vertical bars + 2 cross bars.
      for (let b = -2; b <= 2; b++) {
        acc.add(new THREE.BoxGeometry(0.09, 4.0, 0.09), COL_BARS, at(b * 0.42, 2.0, 0.05));
      }
      acc.add(new THREE.BoxGeometry(2.2, 0.08, 0.08), COL_BARS, at(0, 1.3, 0.07));
      acc.add(new THREE.BoxGeometry(2.2, 0.08, 0.08), COL_BARS, at(0, 3.0, 0.07));
      // Flanking torches: bracket + cup.
      for (const sx of [-1, 1]) {
        acc.add(new THREE.BoxGeometry(0.1, 0.1, 0.5), COL_BARS, at(sx * 2.05, 3.35, 0.3));
        acc.add(new THREE.CylinderGeometry(0.16, 0.08, 0.3, 8), COL_BRONZE, at(sx * 2.05, 3.55, 0.55));
        acc.add(new THREE.CylinderGeometry(0.13, 0.13, 0.04, 8), COL_COALS, at(sx * 2.05, 3.7, 0.55));
        v.set(sx * 2.05, 3.72, 0.55).applyMatrix4(base);
        fires.push({ x: v.x, y: v.y, z: v.z, scale: 0.75 });
      }
      v.set(0, 3.9, 1.3).applyMatrix4(base);
      lights.push({ x: v.x, y: v.y, z: v.z, scale: 1 });
    }
    // Light priority: N & S first (medium tier lights two), then E & W.
    lights.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  }

  private buildPillars(acc: GeoAccumulator, rng: () => number, fires: FireSpot[]): void {
    const c = new THREE.Color();
    for (const p of PILLARS) {
      c.setHex(COL_STONE).multiplyScalar(0.95 + rng() * 0.1);
      acc.add(new THREE.CylinderGeometry(p.radius, p.radius + 0.1, p.height, 16), c, matAt(p.x, p.height / 2, p.z));
      // Fluting: thin darker grooves.
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * TAU + 0.2;
        acc.add(
          new THREE.BoxGeometry(0.08, p.height - 0.9, 0.08),
          COL_STONE_DARK,
          matAt(p.x + Math.cos(a) * (p.radius + 0.02), p.height / 2, p.z + Math.sin(a) * (p.radius + 0.02), -a),
        );
      }
      const side = p.radius * 2 + 0.5;
      acc.add(new THREE.BoxGeometry(side, 0.35, side), COL_STONE_DARK, matAt(p.x, 0.17, p.z));
      acc.add(new THREE.CylinderGeometry(p.radius + 0.18, p.radius + 0.25, 0.25, 16), COL_STONE, matAt(p.x, 0.47, p.z));
      acc.add(new THREE.CylinderGeometry(p.radius + 0.3, p.radius + 0.05, 0.35, 16), COL_STONE, matAt(p.x, p.height - 0.3, p.z));
      acc.add(new THREE.BoxGeometry(side, 0.22, side), COL_STONE_DARK, matAt(p.x, p.height - 0.05, p.z));
      // Bronze brazier bowl with glowing coals on top.
      acc.add(new THREE.CylinderGeometry(0.2, 0.28, 0.3, 10), COL_BRONZE, matAt(p.x, p.height + 0.2, p.z));
      acc.add(new THREE.CylinderGeometry(0.62, 0.3, 0.32, 12), COL_BRONZE, matAt(p.x, p.height + 0.5, p.z));
      acc.add(new THREE.CylinderGeometry(0.56, 0.56, 0.05, 12), COL_COALS, matAt(p.x, p.height + 0.64, p.z));
      fires.push({ x: p.x, y: p.height + 0.66, z: p.z, scale: 1.35 });
    }
  }

  private buildFallenColumns(acc: GeoAccumulator): void {
    const up = new THREE.Vector3(0, 1, 0);
    for (const seg of FALLEN_COLUMNS) {
      const dx = seg.bx - seg.ax;
      const dz = seg.bz - seg.az;
      const len = Math.hypot(dx, dz);
      const dir = new THREE.Vector3(dx / len, 0, dz / len);
      const q = new THREE.Quaternion().setFromUnitVectors(up, dir);
      const midX = (seg.ax + seg.bx) / 2;
      const midZ = (seg.az + seg.bz) / 2;
      const rad = seg.thickness / 2 - 0.05;
      const y = seg.height / 2;
      acc.add(new THREE.CylinderGeometry(rad, rad, len, 12), COL_STONE, matQuatAt(midX, y, midZ, q));
      // Broken-column collars.
      for (const f of [-0.3, 0.25]) {
        acc.add(
          new THREE.CylinderGeometry(rad + 0.08, rad + 0.08, 0.35, 12),
          COL_STONE_DARK,
          matQuatAt(midX + dir.x * len * f, y, midZ + dir.z * len * f, q),
        );
      }
      // Rubble chunks at the broken end.
      acc.add(new THREE.DodecahedronGeometry(0.28, 0), COL_STONE_DARK, matAt(seg.bx + dir.x * 0.5, 0.2, seg.bz + dir.z * 0.5 + 0.4));
      acc.add(new THREE.DodecahedronGeometry(0.2, 0), COL_STONE, matAt(seg.bx + dir.x * 0.7 + 0.4, 0.14, seg.bz + dir.z * 0.7 - 0.3));
    }
  }

  private buildDais(acc: GeoAccumulator): void {
    acc.add(
      new THREE.CylinderGeometry(DAIS.radius, DAIS.radius + 0.35, DAIS.height, 36),
      COL_MARBLE,
      matAt(DAIS.x, DAIS.height / 2, DAIS.z),
    );
    acc.add(
      new THREE.CylinderGeometry(DAIS.radius + 0.38, DAIS.radius + 0.42, 0.12, 36),
      COL_STONE_DARK,
      matAt(DAIS.x, 0.06, DAIS.z),
    );
    const inlay = new THREE.RingGeometry(DAIS.radius * 0.62, DAIS.radius * 0.82, 36);
    inlay.rotateX(-Math.PI / 2);
    acc.add(inlay, COL_GOLD, matAt(DAIS.x, DAIS.height + 0.012, DAIS.z));
    const inner = new THREE.RingGeometry(DAIS.radius * 0.16, DAIS.radius * 0.24, 24);
    inner.rotateX(-Math.PI / 2);
    acc.add(inner, 0x7a3322, matAt(DAIS.x, DAIS.height + 0.012, DAIS.z));
  }

  private buildPads(acc: GeoAccumulator): void {
    for (const pad of PICKUP_PADS) {
      acc.add(new THREE.CylinderGeometry(1.35, 1.5, 0.1, 20), COL_MARBLE, matAt(pad.x, 0.05, pad.z));
      const ring = new THREE.RingGeometry(0.95, 1.2, 24);
      ring.rotateX(-Math.PI / 2);
      acc.add(ring, COL_GOLD, matAt(pad.x, 0.105, pad.z));
    }
  }

  private buildStands(acc: GeoAccumulator, rng: () => number): void {
    const c = new THREE.Color();
    for (let i = 0; i < TIERS; i++) {
      const r0 = STANDS_INNER + i * TIER_DEPTH;
      const r1 = r0 + TIER_DEPTH;
      const y = TIER_BASE_Y + i * TIER_RISE;
      c.setHex(i % 2 === 0 ? COL_TIER_A : COL_TIER_B).multiplyScalar(0.96 + rng() * 0.08);
      const floor = new THREE.RingGeometry(r0, r1, 64);
      floor.rotateX(-Math.PI / 2);
      acc.add(floor, c, matAt(0, y, 0));
      // Riser up to the next tier floor, seen from the arena → flip winding.
      acc.add(
        new THREE.CylinderGeometry(r1, r1, TIER_RISE, 64, 1, true),
        COL_STONE_DARK,
        matAt(0, y + TIER_RISE / 2, 0),
        true,
      );
      // Light stone lip at the front edge of each tier.
      acc.add(new THREE.CylinderGeometry(r0 + 0.06, r0 + 0.06, 0.09, 64, 1, true), COL_TIER_LIP, matAt(0, y + 0.04, 0), true);
    }
    // Filler ring from the wall cap up to the first tier.
    acc.add(
      new THREE.CylinderGeometry(STANDS_INNER, STANDS_INNER, TIER_BASE_Y - 3.4, 64, 1, true),
      COL_STONE_DARK,
      matAt(0, (TIER_BASE_Y + 3.4) / 2, 0),
      true,
    );
  }

  private buildParapet(acc: GeoAccumulator, rng: () => number): void {
    const segments = 30;
    const r = STANDS_OUTER + 0.4;
    const topY = TIER_BASE_Y + TIERS * TIER_RISE;
    const w = (TAU * r) / segments + 0.1;
    const c = new THREE.Color();
    for (let i = 0; i < segments; i++) {
      const th = (i / segments) * TAU;
      const yaw = ringFacingYaw(th);
      c.setHex(COL_WALL_CAP).multiplyScalar(0.92 + rng() * 0.14);
      acc.add(new THREE.BoxGeometry(w, 2.6, 0.7), c, matAt(Math.cos(th) * r, topY + 1.0, Math.sin(th) * r, yaw));
      // Crenellation + mast every other segment.
      if (i % 2 === 0) {
        acc.add(new THREE.BoxGeometry(0.9, 0.7, 0.8), COL_WALL_CAP, matAt(Math.cos(th) * r, topY + 2.6, Math.sin(th) * r, yaw));
        acc.add(new THREE.CylinderGeometry(0.06, 0.06, 3.2, 5), COL_WOOD_DARK, matAt(Math.cos(th) * r, topY + 4.2, Math.sin(th) * r));
        acc.add(new THREE.BoxGeometry(0.04, 1.1, 0.9), i % 4 === 0 ? COL_CLOTH : COL_GOLD, matAt(Math.cos(th) * r, topY + 5.1, Math.sin(th) * r + 0, yaw + Math.PI / 2, 1, 1, 1));
      }
    }
  }

  private buildEmperorBox(acc: GeoAccumulator, fires: FireSpot[]): void {
    const th = (EMPEROR_ANGLE * Math.PI) / 180; // north (§9)
    const r = 33.9;
    const base = matAt(Math.cos(th) * r, 0, Math.sin(th) * r, ringFacingYaw(th));
    const at = (x: number, y: number, z: number): THREE.Matrix4 => base.clone().multiply(matAt(x, y, z));
    // Local frame: +Z faces arena center, +X tangent. Floor slab over tiers 0–2.
    acc.add(new THREE.BoxGeometry(7.4, 0.5, 5.2), COL_MARBLE, at(0, 5.9, 0));
    acc.add(new THREE.BoxGeometry(7.4, 0.9, 0.35), COL_MARBLE, at(0, 6.6, 2.45));
    // Four columns.
    for (const cx of [-3.3, 3.3]) {
      for (const cz of [-2.2, 2.2]) {
        acc.add(new THREE.CylinderGeometry(0.24, 0.26, 3.4, 10), COL_MARBLE, at(cx, 7.85, cz));
      }
    }
    // Roof + pediment + gold trim + red canopy strip at the front.
    acc.add(new THREE.BoxGeometry(8.2, 0.4, 5.8), COL_STONE, at(0, 9.75, 0));
    acc.add(new THREE.BoxGeometry(8.4, 0.2, 0.4), COL_GOLD, at(0, 9.6, 2.75));
    acc.add(new THREE.BoxGeometry(8.2, 0.28, 1.5), COL_CLOTH, at(0, 9.95, 2.2));
    acc.add(new THREE.ConeGeometry(4.2, 1.3, 4, 1), COL_STONE, at(0, 10.6, 0));
    // Throne.
    acc.add(new THREE.BoxGeometry(1.4, 0.55, 1.0), COL_GOLD, at(0, 6.45, -1.4));
    acc.add(new THREE.BoxGeometry(1.4, 1.5, 0.3), COL_GOLD, at(0, 7.3, -1.95));
    // Hanging red drops at the front corners.
    for (const cx of [-3.6, 3.6]) {
      acc.add(new THREE.BoxGeometry(0.9, 2.0, 0.08), COL_CLOTH, at(cx, 8.5, 2.55));
      // Braziers on the balustrade.
      acc.add(new THREE.CylinderGeometry(0.34, 0.16, 0.3, 10), COL_BRONZE, at(cx * 0.83, 7.2, 2.45));
      const v = new THREE.Vector3(cx * 0.83, 7.38, 2.45).applyMatrix4(base);
      fires.push({ x: v.x, y: v.y, z: v.z, scale: 0.85 });
    }
  }

  /** Banner poles (static, merged into the stands mesh). */
  private buildBannerPoles(acc: GeoAccumulator): void {
    for (const deg of bannerAngles()) {
      const th = (deg * Math.PI) / 180;
      const r = WALL_RADIUS - 0.35;
      const base = matAt(Math.cos(th) * r, 0, Math.sin(th) * r, ringFacingYaw(th));
      const at = (x: number, y: number, z: number): THREE.Matrix4 => base.clone().multiply(matAt(x, y, z));
      acc.add(new THREE.BoxGeometry(1.7, 0.12, 0.12), COL_WOOD_DARK, at(0, 5.3, 0.05));
      acc.add(new THREE.SphereGeometry(0.1, 6, 4), COL_GOLD, at(-0.88, 5.3, 0.05));
      acc.add(new THREE.SphereGeometry(0.1, 6, 4), COL_GOLD, at(0.88, 5.3, 0.05));
    }
  }

  /** Cloth banners hanging from the poles (merged, world-space, waving). */
  private buildBanners(): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    for (const deg of bannerAngles()) {
      const th = (deg * Math.PI) / 180;
      const r = WALL_RADIUS - 0.42;
      const g = clothPlane(1.35, 2.5, 3, 8);
      g.applyMatrix4(matAt(Math.cos(th) * r, 4.02, Math.sin(th) * r, ringFacingYaw(th)));
      parts.push(g);
    }
    // Merge manually (all share attributes: position, normal, uv, aFlap).
    let v = 0;
    let idx = 0;
    for (const p of parts) {
      v += p.getAttribute('position').count;
      idx += p.getIndex()?.count ?? 0;
    }
    const pos = new Float32Array(v * 3);
    const nor = new Float32Array(v * 3);
    const uv = new Float32Array(v * 2);
    const flap = new Float32Array(v);
    const index = new Uint32Array(idx);
    let vo = 0;
    let io = 0;
    for (const p of parts) {
      const n = p.getAttribute('position').count;
      pos.set(p.getAttribute('position').array as Float32Array, vo * 3);
      nor.set(p.getAttribute('normal').array as Float32Array, vo * 3);
      uv.set(p.getAttribute('uv').array as Float32Array, vo * 2);
      flap.set(p.getAttribute('aFlap').array as Float32Array, vo);
      const pi = p.getIndex();
      if (pi !== null) {
        for (let k = 0; k < pi.count; k++) index[io + k] = pi.getX(k) + vo;
        io += pi.count;
      }
      vo += n;
      p.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    out.setAttribute('aFlap', new THREE.BufferAttribute(flap, 1));
    out.setIndex(new THREE.BufferAttribute(index, 1));
    return out;
  }

  private buildSeats(rng: () => number): CrowdSeat[] {
    const seats: CrowdSeat[] = [];
    for (let tier = 0; tier < TIERS; tier++) {
      const rm = STANDS_INNER + (tier + 0.55) * TIER_DEPTH;
      const y = TIER_BASE_Y + tier * TIER_RISE + 0.03;
      const count = Math.floor((TAU * rm) / 1.15);
      for (let s = 0; s < count; s++) {
        if (rng() < 0.16) continue; // empty seats for variety
        const deg = (s / count) * 360;
        // Leave the Emperor's box gap in the lower tiers.
        if (tier <= 4 && Math.abs(deg - EMPEROR_ANGLE) < EMPEROR_HALF_ARC) continue;
        const th = (deg / 180) * Math.PI;
        const rr = rm + (rng() - 0.5) * 0.5;
        const x = Math.cos(th) * rr;
        const z = Math.sin(th) * rr;
        seats.push({
          x,
          y,
          z,
          yaw: Math.atan2(-x, -z) + (rng() - 0.5) * 0.5,
          scale: 0.86 + rng() * 0.3,
          phase: th * 2 + rng() * 1.4,
        });
      }
    }
    return seats;
  }

  // ── Debris ────────────────────────────────────────────────────────────────

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
      if (this.dPos[o + 1] < 0.11) {
        this.dPos[o + 1] = 0.11;
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

/** One banner above each gate, plus one at each midpoint (8 total). */
function bannerAngles(): number[] {
  const angles: number[] = [...GATE_ANGLES_DEG];
  for (const d of GATE_ANGLES_DEG) angles.push(d + 45);
  return angles;
}

// ── Shared geometry builders (init-time) ─────────────────────────────────────

/** Crate: wood box + darker planks and iron corners (vertex-colored). */
function buildCrateGeometry(): THREE.BufferGeometry {
  const acc = new GeoAccumulator();
  const s = CRATE_SIZE * 0.98;
  acc.add(new THREE.BoxGeometry(s, s, s), COL_WOOD, matAt(0, 0, 0));
  acc.add(new THREE.BoxGeometry(s + 0.04, s * 0.16, s * 0.16), COL_WOOD_DARK, matAt(0, 0, s / 2));
  acc.add(new THREE.BoxGeometry(s * 0.16, s * 0.16, s + 0.04), COL_WOOD_DARK, matAt(s / 2, 0, 0));
  acc.add(new THREE.BoxGeometry(s + 0.04, s * 0.16, s * 0.16), COL_WOOD_DARK, matAt(0, 0, -s / 2));
  acc.add(new THREE.BoxGeometry(s * 0.16, s * 0.16, s + 0.04), COL_WOOD_DARK, matAt(-s / 2, 0, 0));
  acc.add(new THREE.BoxGeometry(s + 0.03, 0.06, s + 0.03), COL_BARS, matAt(0, s / 2 - 0.03, 0));
  acc.add(new THREE.BoxGeometry(s + 0.03, 0.06, s + 0.03), COL_BARS, matAt(0, -s / 2 + 0.03, 0));
  return acc.buildGeometry();
}
