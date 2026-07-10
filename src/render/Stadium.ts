/**
 * Stadium (BLUEPRINT §9 / §11.2) — the whole colosseum, built procedurally and
 * ENTIRELY from `config/arena.ts` data (no re-hard-coded positions):
 *
 * - vertex-color sand disc (radial gradient),
 * - 5 m wall ring with 4 cosmetic gates (N/E/S/W) + banners,
 * - tiered stands r 31→44 with an InstancedMesh crowd (≥1200 torsos,
 *   per-instance color, 10 Hz bob/wave scaled by `excitement`),
 * - Emperor's box at north, 6 pillars, 2 fallen columns,
 * - 4 crate clusters — each crate individually removable via `breakCrate(id)`
 *   (ids follow `CRATES` array order) with a pooled debris burst,
 * - central dais, 6 pickup pads with floating rotating icons per kind
 *   (meat / feather / war-drum) toggled via `setPickupVisible`.
 *
 * Draw calls: sand 1 + stone 1 + stands 1 + crowd 1 + crates 1 + debris 1
 * + ≤6 visible pickup icons ≈ 12.
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

export type PickupKind = PickupState['kind'];

// ── Palette (warm stone / sand / cloth) ──────────────────────────────────────
const COL_SAND_IN = new THREE.Color(0xe6c68e);
const COL_SAND_OUT = new THREE.Color(0xbd9257);
const COL_WALL = 0xb19d79;
const COL_WALL_CAP = 0x93805f;
const COL_STONE = 0xa8946f;
const COL_STONE_DARK = 0x8b7757;
const COL_TIER_A = 0xa5906d;
const COL_TIER_B = 0x99855f;
const COL_MARBLE = 0xcfc3a6;
const COL_GATE_DARK = 0x241c12;
const COL_BARS = 0x3d372e;
const COL_CLOTH = 0x8f2118;
const COL_GOLD = 0xb3944f;
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
const PICKUP_KINDS: readonly PickupKind[] = ['heal', 'speed', 'rage'];

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

  /** padIcons[padIndex][kindIndex] — kind order: heal, speed, rage. */
  private readonly padIcons: THREE.Mesh[][] = [];
  private readonly materials: THREE.Material[] = [];

  private readonly rng = mulberry32(0xd00d);
  private time = 0;

  constructor() {
    const rng = mulberry32(0x57ad1a);

    // ── Sand disc: radial vertex-color gradient (§11.2) ─────────────────────
    const sandGeo = new THREE.CircleGeometry(WALL_RADIUS, 72);
    sandGeo.rotateX(-Math.PI / 2);
    {
      const pos = sandGeo.getAttribute('position');
      const col = new Float32Array(pos.count * 3);
      const c = new THREE.Color();
      for (let i = 0; i < pos.count; i++) {
        const r = Math.hypot(pos.getX(i), pos.getZ(i)) / WALL_RADIUS;
        c.copy(COL_SAND_IN).lerp(COL_SAND_OUT, Math.pow(r, 1.35));
        const n = 0.94 + rng() * 0.12;
        col[i * 3] = c.r * n;
        col[i * 3 + 1] = c.g * n;
        col[i * 3 + 2] = c.b * n;
      }
      sandGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    const sandMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
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

    // ── Inner structures (cast shadows): wall, gates, pillars, columns, dais,
    //    pads — one merged mesh ───────────────────────────────────────────────
    const stone = new GeoAccumulator();
    this.buildWall(stone, rng);
    this.buildGates(stone);
    this.buildPillars(stone, rng);
    this.buildFallenColumns(stone);
    this.buildDais(stone);
    this.buildPads(stone);
    this.stoneMesh = stone.build(stoneMat);
    this.stoneMesh.castShadow = true;
    this.stoneMesh.receiveShadow = true;
    this.root.add(this.stoneMesh);

    // ── Outer structures (no shadow casting — outside the 2048 sun frustum):
    //    stands, parapet, Emperor's box, banners ──────────────────────────────
    const stands = new GeoAccumulator();
    this.buildStands(stands, rng);
    this.buildParapet(stands);
    this.buildEmperorBox(stands);
    this.buildBanners(stands);
    this.standsMesh = stands.build(stoneMat);
    this.standsMesh.castShadow = false;
    this.standsMesh.receiveShadow = false;
    this.root.add(this.standsMesh);

    // ── Crowd ────────────────────────────────────────────────────────────────
    this.crowd = new Crowd(this.buildSeats(rng), rng);
    this.root.add(this.crowd.mesh);

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
    this.debrisMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.28, 0.2, 0.24),
      debrisMat,
      DEBRIS_MAX,
    );
    this.debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debrisMesh.castShadow = false;
    this.debrisMesh.frustumCulled = false;
    for (let i = 0; i < DEBRIS_MAX; i++) this.debrisMesh.setMatrixAt(i, ZERO_SCALE);
    this.debrisMesh.instanceMatrix.needsUpdate = true;
    this.root.add(this.debrisMesh);

    // ── Pickup pad icons (meat / feather / war-drum) ─────────────────────────
    const iconMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.8,
      metalness: 0,
    });
    this.materials.push(iconMat);
    const iconGeos: readonly THREE.BufferGeometry[] = [
      buildMeatGeometry(),
      buildFeatherGeometry(),
      buildDrumGeometry(),
    ];
    for (const pad of PICKUP_PADS) {
      const set: THREE.Mesh[] = [];
      for (let k = 0; k < 3; k++) {
        const mesh = new THREE.Mesh(iconGeos[k], iconMat);
        mesh.position.set(pad.x, 1.05, pad.z);
        mesh.visible = false;
        mesh.castShadow = true;
        this.root.add(mesh);
        set.push(mesh);
      }
      this.padIcons.push(set);
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Number of crowd instances (≥1200 per §11.2). */
  get crowdCount(): number {
    return this.crowd.count;
  }

  /**
   * Advance crowd bob (10 Hz coarse tick, amplitude scaled by `excitement`
   * 0–1 — pass `SceneManager.excitement`), debris physics, and icon spin.
   */
  update(dt: number, excitement: number): void {
    this.time += dt;
    this.crowd.update(dt, excitement);
    this.updateDebris(dt);

    // Floating, rotating pickup icons (visible ones only; ≤6).
    const bobT = this.time * 2;
    for (let padIdx = 0; padIdx < this.padIcons.length; padIdx++) {
      const set = this.padIcons[padIdx];
      for (let k = 0; k < 3; k++) {
        const mesh = set[k];
        if (!mesh.visible) continue;
        mesh.rotation.y += dt * 1.5;
        mesh.position.y = 1.05 + Math.sin(bobT + padIdx * 1.1) * 0.12;
      }
    }
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
    if (padIndex < 0 || padIndex >= this.padIcons.length) return;
    const kindIdx = PICKUP_KINDS.indexOf(kind);
    if (kindIdx < 0) return;
    const set = this.padIcons[padIndex];
    for (let k = 0; k < 3; k++) set[k].visible = visible && k === kindIdx;
  }

  dispose(): void {
    this.crowd.dispose();
    this.sandMesh.geometry.dispose();
    this.stoneMesh.geometry.dispose();
    this.standsMesh.geometry.dispose();
    this.crateMesh.geometry.dispose();
    this.debrisMesh.geometry.dispose();
    for (const set of this.padIcons) for (const m of set) m.geometry.dispose();
    for (const m of this.materials) m.dispose();
  }

  // ── Builders (init-time only; all data from config/arena.ts) ──────────────

  private buildWall(acc: GeoAccumulator, rng: () => number): void {
    const segments = 36;
    const wallR = WALL_RADIUS + 0.45; // panel centerline (inner face ≈ r 30)
    const panelW = (TAU * wallR) / segments + 0.12;
    const c = new THREE.Color();
    for (let i = 0; i < segments; i++) {
      const th = (i / segments) * TAU;
      const x = Math.cos(th) * wallR;
      const z = Math.sin(th) * wallR;
      const yaw = ringFacingYaw(th);
      c.setHex(COL_WALL).multiplyScalar(0.93 + rng() * 0.14);
      acc.add(
        new THREE.BoxGeometry(panelW, WALL_HEIGHT, 0.9),
        c,
        matAt(x, WALL_HEIGHT / 2, z, yaw),
      );
      // Cap course on top of the wall.
      acc.add(
        new THREE.BoxGeometry(panelW + 0.2, 0.45, 1.25),
        COL_WALL_CAP,
        matAt(x, WALL_HEIGHT + 0.22, z, yaw),
      );
    }
  }

  private buildGates(acc: GeoAccumulator): void {
    for (const deg of GATE_ANGLES_DEG) {
      const th = (deg * Math.PI) / 180;
      const r = WALL_RADIUS - 0.1;
      const base = matAt(Math.cos(th) * r, 0, Math.sin(th) * r, ringFacingYaw(th));
      const at = (x: number, y: number, z: number): THREE.Matrix4 =>
        base.clone().multiply(matAt(x, y, z));
      // Jambs + lintel.
      acc.add(new THREE.BoxGeometry(0.55, 4.4, 0.6), COL_STONE_DARK, at(-1.35, 2.2, 0));
      acc.add(new THREE.BoxGeometry(0.55, 4.4, 0.6), COL_STONE_DARK, at(1.35, 2.2, 0));
      acc.add(new THREE.BoxGeometry(3.4, 0.65, 0.7), COL_STONE_DARK, at(0, 4.5, 0));
      // Dark recess behind the bars (toward the wall = local −Z).
      acc.add(new THREE.BoxGeometry(2.25, 4.1, 0.25), COL_GATE_DARK, at(0, 2.05, -0.28));
      // 5 vertical bars.
      for (let b = -2; b <= 2; b++) {
        acc.add(new THREE.BoxGeometry(0.09, 4.0, 0.09), COL_BARS, at(b * 0.42, 2.0, 0.05));
      }
    }
  }

  private buildPillars(acc: GeoAccumulator, rng: () => number): void {
    const c = new THREE.Color();
    for (const p of PILLARS) {
      c.setHex(COL_STONE).multiplyScalar(0.95 + rng() * 0.1);
      acc.add(
        new THREE.CylinderGeometry(p.radius, p.radius + 0.12, p.height, 10),
        c,
        matAt(p.x, p.height / 2, p.z),
      );
      const side = p.radius * 2 + 0.5;
      acc.add(new THREE.BoxGeometry(side, 0.35, side), COL_STONE_DARK, matAt(p.x, 0.17, p.z));
      acc.add(
        new THREE.BoxGeometry(side - 0.2, 0.3, side - 0.2),
        COL_STONE_DARK,
        matAt(p.x, p.height - 0.15, p.z),
      );
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
      acc.add(
        new THREE.CylinderGeometry(rad, rad, len, 10),
        COL_STONE,
        matQuatAt(midX, y, midZ, q),
      );
      // Broken-column collars.
      for (const f of [-0.3, 0.25]) {
        acc.add(
          new THREE.CylinderGeometry(rad + 0.08, rad + 0.08, 0.35, 10),
          COL_STONE_DARK,
          matQuatAt(midX + dir.x * len * f, y, midZ + dir.z * len * f, q),
        );
      }
    }
  }

  private buildDais(acc: GeoAccumulator): void {
    acc.add(
      new THREE.CylinderGeometry(DAIS.radius, DAIS.radius + 0.35, DAIS.height, 28),
      COL_MARBLE,
      matAt(DAIS.x, DAIS.height / 2, DAIS.z),
    );
    const inlay = new THREE.RingGeometry(DAIS.radius * 0.62, DAIS.radius * 0.82, 28);
    inlay.rotateX(-Math.PI / 2);
    acc.add(inlay, COL_GOLD, matAt(DAIS.x, DAIS.height + 0.012, DAIS.z));
  }

  private buildPads(acc: GeoAccumulator): void {
    for (const pad of PICKUP_PADS) {
      acc.add(
        new THREE.CylinderGeometry(1.35, 1.5, 0.1, 16),
        COL_MARBLE,
        matAt(pad.x, 0.05, pad.z),
      );
      const ring = new THREE.RingGeometry(0.95, 1.2, 20);
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
      const floor = new THREE.RingGeometry(r0, r1, 48);
      floor.rotateX(-Math.PI / 2);
      acc.add(floor, c, matAt(0, y, 0));
      // Riser up to the next tier floor, seen from the arena → flip winding.
      acc.add(
        new THREE.CylinderGeometry(r1, r1, TIER_RISE, 48, 1, true),
        COL_STONE_DARK,
        matAt(0, y + TIER_RISE / 2, 0),
        true,
      );
    }
    // Filler ring from the wall cap up to the first tier.
    acc.add(
      new THREE.CylinderGeometry(STANDS_INNER, STANDS_INNER, TIER_BASE_Y - 3.4, 48, 1, true),
      COL_STONE_DARK,
      matAt(0, (TIER_BASE_Y + 3.4) / 2, 0),
      true,
    );
  }

  private buildParapet(acc: GeoAccumulator): void {
    const segments = 30;
    const r = STANDS_OUTER + 0.4;
    const topY = TIER_BASE_Y + TIERS * TIER_RISE;
    const w = (TAU * r) / segments + 0.1;
    for (let i = 0; i < segments; i++) {
      const th = (i / segments) * TAU;
      acc.add(
        new THREE.BoxGeometry(w, 2.6, 0.7),
        COL_WALL_CAP,
        matAt(Math.cos(th) * r, topY + 1.0, Math.sin(th) * r, ringFacingYaw(th)),
      );
    }
  }

  private buildEmperorBox(acc: GeoAccumulator): void {
    const th = (EMPEROR_ANGLE * Math.PI) / 180; // north (§9)
    const r = 33.9;
    const base = matAt(Math.cos(th) * r, 0, Math.sin(th) * r, ringFacingYaw(th));
    const at = (x: number, y: number, z: number): THREE.Matrix4 =>
      base.clone().multiply(matAt(x, y, z));
    // Local frame: +Z faces arena center, +X tangent. Floor slab over tiers 0–2.
    acc.add(new THREE.BoxGeometry(7.4, 0.5, 5.2), COL_MARBLE, at(0, 5.9, 0));
    acc.add(new THREE.BoxGeometry(7.4, 0.9, 0.35), COL_MARBLE, at(0, 6.6, 2.45));
    // Four columns.
    for (const cx of [-3.3, 3.3]) {
      for (const cz of [-2.2, 2.2]) {
        acc.add(new THREE.BoxGeometry(0.45, 3.4, 0.45), COL_MARBLE, at(cx, 7.85, cz));
      }
    }
    // Roof + gold trim + red canopy strip at the front.
    acc.add(new THREE.BoxGeometry(8.2, 0.4, 5.8), COL_STONE, at(0, 9.75, 0));
    acc.add(new THREE.BoxGeometry(8.4, 0.2, 0.4), COL_GOLD, at(0, 9.6, 2.75));
    acc.add(new THREE.BoxGeometry(8.2, 0.28, 1.5), COL_CLOTH, at(0, 9.95, 2.2));
    // Throne.
    acc.add(new THREE.BoxGeometry(1.4, 0.55, 1.0), COL_GOLD, at(0, 6.45, -1.4));
    acc.add(new THREE.BoxGeometry(1.4, 1.5, 0.3), COL_GOLD, at(0, 7.3, -1.95));
    // Hanging red drops at the front corners.
    for (const cx of [-3.6, 3.6]) {
      acc.add(new THREE.BoxGeometry(0.9, 2.0, 0.08), COL_CLOTH, at(cx, 8.5, 2.55));
    }
  }

  private buildBanners(acc: GeoAccumulator): void {
    // One banner above each gate, plus one at each midpoint (8 total).
    const angles: number[] = [...GATE_ANGLES_DEG];
    for (const d of GATE_ANGLES_DEG) angles.push(d + 45);
    const r = WALL_RADIUS - 0.35;
    for (const deg of angles) {
      const th = (deg * Math.PI) / 180;
      const base = matAt(Math.cos(th) * r, 0, Math.sin(th) * r, ringFacingYaw(th));
      const at = (x: number, y: number, z: number): THREE.Matrix4 =>
        base.clone().multiply(matAt(x, y, z));
      acc.add(new THREE.BoxGeometry(1.7, 0.12, 0.12), COL_WOOD_DARK, at(0, 4.8, 0));
      acc.add(new THREE.BoxGeometry(1.35, 2.3, 0.07), COL_CLOTH, at(0, 3.6, 0.04));
      acc.add(new THREE.BoxGeometry(0.52, 0.52, 0.09), COL_GOLD, at(0, 3.95, 0.07));
    }
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

// ── Shared geometry builders (init-time) ─────────────────────────────────────

/** Crate: wood box + darker planks (vertex-colored); instance tint = shade. */
function buildCrateGeometry(): THREE.BufferGeometry {
  const acc = new GeoAccumulator();
  const s = CRATE_SIZE * 0.98;
  acc.add(new THREE.BoxGeometry(s, s, s), COL_WOOD, matAt(0, 0, 0));
  acc.add(new THREE.BoxGeometry(s + 0.04, s * 0.16, s * 0.16), COL_WOOD_DARK, matAt(0, 0, s / 2));
  acc.add(new THREE.BoxGeometry(s * 0.16, s * 0.16, s + 0.04), COL_WOOD_DARK, matAt(s / 2, 0, 0));
  return acc.buildGeometry();
}

/** Haunch of meat (heal pickup, §9 icons). */
function buildMeatGeometry(): THREE.BufferGeometry {
  const acc = new GeoAccumulator();
  const boneQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 2));
  acc.add(new THREE.CylinderGeometry(0.05, 0.05, 0.72, 6), 0xe8dcc0, matQuatAt(0.12, 0, 0, boneQ));
  acc.add(new THREE.SphereGeometry(0.09, 6, 4), 0xe8dcc0, matAt(0.48, 0, 0));
  acc.add(new THREE.SphereGeometry(0.09, 6, 4), 0xe8dcc0, matAt(0.48, 0.08, 0.05));
  acc.add(new THREE.SphereGeometry(0.3, 7, 5), 0xa5432e, matAt(-0.18, 0, 0, 0, 1.25, 0.85, 0.85));
  acc.add(new THREE.SphereGeometry(0.22, 7, 5), 0x7d2f1f, matAt(-0.34, 0.02, 0, 0, 1.1, 0.9, 0.9));
  return acc.buildGeometry();
}

/** Winged-sandal-esque feather (speed pickup). */
function buildFeatherGeometry(): THREE.BufferGeometry {
  const acc = new GeoAccumulator();
  const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0.35));
  acc.add(new THREE.CylinderGeometry(0.024, 0.04, 0.95, 5), 0xd9a441, matQuatAt(0, 0, 0, tilt));
  acc.add(new THREE.SphereGeometry(0.3, 6, 4), 0xe9e2d0, matQuatAt(0.07, 0.12, 0, tilt, 0.5, 1.15, 0.14));
  acc.add(new THREE.SphereGeometry(0.24, 6, 4), 0xd6cbb2, matQuatAt(0.1, -0.18, 0, tilt, 0.45, 0.9, 0.12));
  return acc.buildGeometry();
}

/** Red war-drum (rage pickup). */
function buildDrumGeometry(): THREE.BufferGeometry {
  const acc = new GeoAccumulator();
  acc.add(new THREE.CylinderGeometry(0.28, 0.33, 0.42, 10), 0x8f2118, matAt(0, 0, 0));
  acc.add(new THREE.CylinderGeometry(0.29, 0.29, 0.05, 10), 0xe2cfa8, matAt(0, 0.21, 0));
  acc.add(new THREE.CylinderGeometry(0.325, 0.325, 0.06, 10), 0xd9a441, matAt(0, 0.18, 0));
  acc.add(new THREE.CylinderGeometry(0.35, 0.35, 0.06, 10), 0xd9a441, matAt(0, -0.18, 0));
  return acc.buildGeometry();
}
