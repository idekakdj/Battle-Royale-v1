/**
 * OceanScene (v1.9, WP-O3) - the Ocean Dome, built procedurally and ENTIRELY from the arena's `ArenaDef` data:
 *
 *  - the SEABED floor (sand ripples + caustics inside, dunes outside), the LEVELS from `heightfield` (terrace ring, plateau, the level
 *    ramps with kerbs + glowing coral inlays, cliff faces and, since v1.10, the three sea-stack TOWERS with their two-piece climbs and
 *    coral crowns), coral pillars / rock outcrops / arches at their collider positions on their `baseY`, sea-crates (same destruction
 *    hooks as the other arenas), the pickup pads on their own levels (the tower tops included),
 *  - the GLASS DOME (fresnel hemisphere, panel seams, metal base ring, 24 ribs + hoops, apex hub), god-ray shafts and a shimmering
 *    surface overhead, marine snow outside,
 *  - the OCEAN BEYOND: kelp forest, coral reef ring, a far shipwreck, fish schools, sharks, whales, mantas, turtles, jellyfish
 *    (GPU-animated, deterministic - see `life.ts`),
 *  - the SEA-SERPENT set pieces (`serpentState` / `serpentModel` / `serpentFx`): TWO of them since v1.10 - the LOW serpent driven by
 *    `snapshot.serpent`, the HIGH serpent (violet, flies over the tower tops) driven ONLY by `snapshot.serpentHigh` - each with its own
 *    glass breach, strip, model and FX pools, both able to run at once (persistent state, rollback / late-join safe); `onEvent` only fires
 *    the one-shot FX (shards, splash, hit flash; events with `tier: 'high'` go to the high serpent) and the FALL burst (`fall` event).
 *
 * Public surface = `ArenaScene` (render/arenaScene.ts) + the two optional hooks `setSnapshot` / `onEvent`. Create it through
 * `createArenaScene(sceneManager, arenaDef)`.
 */

import * as THREE from 'three';
import type { ArenaDef } from '../../config/arenas';
import { arenaGroundHeight } from '../../config/arenas';
import { mulberry32, TAU } from '../../core/math';
import type { GameEvent, SerpentState, SerpentTier, WorldSnapshot } from '../../core/types';
import { SERPENT } from '../../config/serpent';
import type { ArenaScene, PickupKind } from '../arenaScene';
import type { SceneManager } from '../SceneManager';
import { arenaShake } from '../arenaContext';
import { PickupBeacons } from '../pickupBeacons';
import { getQualityTier, onQualityChange, tierProfile, type QualityTier } from '../quality';
import { kickFov } from '../fxBus';
import { DomeGlass, MarineSnow, OceanRays, SurfacePlane, buildDomeFrame, frameMaterial } from './dome';
import { SeaLife, type SeaLifeStats } from './life';
import { createShared, patchLit, type OceanShared } from './materials';
import { buildOceanProps, buildPlankGeometry, buildSeaCrateGeometry } from './props';
import { FallFx } from './fallFx';
import { SerpentFx } from './serpentFx';
import { SerpentModel } from './serpentModel';
import { EXIT_S, blank, breachHeight, serpentVisualState, type SerpentVisual } from './serpentState';
import { DOME_HEIGHT, buildLevelsGeometry, buildSeabedGeometry, domeRadius } from './terrain';

const PICKUP_KINDS: readonly PickupKind[] = ['heal', 'speed', 'rage'];
const DEBRIS_MAX = 72;
const DEBRIS_PER_CRATE = 6;
const ZERO_SCALE = new THREE.Matrix4().makeScale(0, 0, 0);

/** Per-tier ocean budgets. */
export interface OceanBudget {
  snow: number;
  rays: number;
  surface: boolean;
  glowRays: boolean;
}
const BUDGETS: Record<QualityTier, OceanBudget> = {
  low: { snow: 0, rays: 0, surface: false, glowRays: false },
  medium: { snow: 200, rays: 0.11, surface: true, glowRays: true },
  high: { snow: 420, rays: 0.15, surface: true, glowRays: true },
};
export function oceanBudget(tier: QualityTier): Readonly<OceanBudget> {
  return BUDGETS[tier];
}

// Scratch.
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/**
 * Camera shake (m) the serpent set piece asks for: a low rumble while it coils (rising with the urgency), a heavy jolt at the strike,
 * dying through hold / retreat; stronger when the viewer stands on the strike side. Pure - exported for the tests.
 */
export function serpentShake(v: SerpentVisual, focusX: number, focusZ: number, hasFocus: boolean, wallRadius: number): number {
  if (!v.active) return 0;
  const side = hasFocus ? (focusX * v.dirX + focusZ * v.dirZ) / wallRadius : 0.4; // -1 .. 1, 1 at the strike edge
  const p = Math.min(1, Math.max(0, side * 0.5 + 0.5));
  const near = 0.4 + 0.6 * p;
  switch (v.phase) {
    case 'warn':
      return (0.004 + 0.022 * v.urgency * v.urgency) * near;
    case 'strike':
      return 0.115 * (0.55 + 0.45 * p);
    case 'hold':
      return 0.1 * (1 - v.t / SERPENT.holdS) * near;
    case 'retreat':
      return 0.035 * (1 - v.t / SERPENT.retreatS) * near;
    default:
      return 0;
  }
}

export interface OceanStats {
  coral: number;
  rocks: number;
  arches: number;
  pads: number;
  crates: number;
  /** Ramp PIECES (a two-piece tower climb counts twice). */
  ramps: number;
  /** Ramps that arrive at a tower (3 causeways + 2 chords). */
  climbs: number;
  /** The upper-tier towers and their coral crowns. */
  towers: number;
  crowns: number;
  bulbs: number;
  life: SeaLifeStats;
}

/** One sea serpent's scene state (the low and the high one run the same machinery on their own block / visual / pools). */
interface Lane {
  tier: SerpentTier;
  block: Pick<SerpentState, 'phase' | 'angleDeg' | 't'> | null;
  alpha: number;
  visual: SerpentVisual;
  exitT: number;
  dirty: boolean;
  model: SerpentModel;
  fx: SerpentFx;
  /** The camera shake (m) this serpent asks for this frame. */
  shake: number;
}

export class OceanScene implements ArenaScene {
  readonly arena: ArenaDef;
  readonly root = new THREE.Group();
  readonly crowdCount = 0;

  private readonly shared: OceanShared;
  private time = 0;
  private tier: QualityTier;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly unsubscribe: () => void;

  private readonly seabed: THREE.Mesh;
  private readonly levels: THREE.Mesh;
  private readonly props: THREE.Mesh;
  private readonly frame: THREE.Mesh;
  private readonly glowMesh: THREE.Mesh;
  private readonly glass: DomeGlass;
  private readonly rays: OceanRays;
  private readonly surface: SurfacePlane;
  private readonly snow: MarineSnow;
  private readonly life: SeaLife;
  /** The LOW serpent (v1.9). */
  readonly serpentModel: SerpentModel;
  readonly serpentFx: SerpentFx;
  /** The HIGH serpent (v1.10): own model, FX and glass breach, driven by `snapshot.serpentHigh`. */
  readonly serpentModelHigh: SerpentModel;
  readonly serpentFxHigh: SerpentFx;
  /** The fall-damage impact burst. */
  readonly fallFx: FallFx;
  private readonly beacons: PickupBeacons;
  private readonly stats: Omit<OceanStats, 'life'>;

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
  private readonly dFloor = new Float32Array(DEBRIS_MAX);
  private dCursor = 0;
  private debrisDirty = false;
  private readonly rng = mulberry32(0x0cea);

  // Focus + serpent state.
  private focusX = 0;
  private focusZ = 0;
  private hasFocus = false;
  private readonly lanes: Record<SerpentTier, Lane>;
  private hitShake = 0;
  private fallShake = 0;
  private strikeKick = 0;

  constructor(sceneManager: SceneManager, arena: ArenaDef) {
    this.arena = arena;
    const look = sceneManager.getLook();
    const R = domeRadius(arena);
    const own = <T extends { dispose(): void }>(x: T): T => {
      this.disposables.push(x);
      return x;
    };
    const shared = createShared(R, DOME_HEIGHT);
    this.shared = shared;
    const sunDir = new THREE.Vector3(look.sun.x, look.sun.y, look.sun.z).normalize();
    const centreY = arenaGroundHeight(arena, 0, 0);

    // ── Seabed ──
    const seabedMat = own(patchLit(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.96, metalness: 0 }), shared, { key: 'seabed', ripple: true, caustic: 0.6, waterFog: true }));
    this.seabed = new THREE.Mesh(own(buildSeabedGeometry(arena)), seabedMat);
    this.seabed.name = 'ocean-seabed';
    this.seabed.receiveShadow = true;
    this.root.add(this.seabed);

    // ── Levels (cliffs, tops, ramps) ──
    const lv = buildLevelsGeometry(arena);
    const levelsMat = own(patchLit(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.92, metalness: 0 }), shared, { key: 'levels', caustic: 0.5 }));
    this.levels = new THREE.Mesh(own(lv.main), levelsMat);
    this.levels.name = 'ocean-levels';
    this.levels.castShadow = true;
    this.levels.receiveShadow = true;
    this.root.add(this.levels);
    const glowMat = own(new THREE.MeshBasicMaterial({ vertexColors: true }));

    // ── Props (coral, rocks, arches, pads) ──
    const pr = buildOceanProps(arena);
    const propsMat = own(patchLit(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.88, metalness: 0, side: THREE.DoubleSide }), shared, { key: 'props', caustic: 0.45 }));
    this.props = new THREE.Mesh(own(pr.main), propsMat);
    this.props.name = 'ocean-props';
    this.props.castShadow = true;
    this.props.receiveShadow = true;
    this.root.add(this.props);

    // ── Crates + debris ──
    const crates = arena.crates;
    const crateMat = own(patchLit(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9, metalness: 0 }), shared, { key: 'crate', caustic: 0.4 }));
    const crateGeo = own(buildSeaCrateGeometry(crates.length > 0 ? crates[0].height : 1));
    this.crateMesh = new THREE.InstancedMesh(crateGeo, crateMat, Math.max(1, crates.length));
    this.crateMesh.name = 'ocean-crates';
    this.crateMesh.count = crates.length;
    this.crateMesh.castShadow = true;
    this.crateMesh.receiveShadow = true;
    this.crateAlive = new Array<boolean>(crates.length).fill(true);
    const tint = new THREE.Color();
    for (let i = 0; i < crates.length; i++) {
      const cr = crates[i];
      _e.set(0, (this.rng() - 0.5) * 0.5, 0);
      _q.setFromEuler(_e);
      _p.set(cr.x, (cr.baseY ?? 0) + cr.height / 2, cr.z);
      _s.set(1, 1, 1);
      this.crateMesh.setMatrixAt(i, _m.compose(_p, _q, _s));
      tint.setRGB(0.9 + this.rng() * 0.2, 0.9 + this.rng() * 0.2, 0.9 + this.rng() * 0.2);
      this.crateMesh.setColorAt(i, tint);
    }
    this.crateBase = Float32Array.from(this.crateMesh.instanceMatrix.array as Float32Array);
    this.crateMesh.instanceMatrix.needsUpdate = true;
    if (this.crateMesh.instanceColor !== null) this.crateMesh.instanceColor.needsUpdate = true;
    this.root.add(this.crateMesh);

    const debrisMat = own(new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 1, metalness: 0 }));
    this.debrisMesh = new THREE.InstancedMesh(own(buildPlankGeometry()), debrisMat, DEBRIS_MAX);
    this.debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debrisMesh.frustumCulled = false;
    const wood = [new THREE.Color(0x6c7d74), new THREE.Color(0x445650), new THREE.Color(0x8da096), new THREE.Color(0xb89d6a)];
    for (let i = 0; i < DEBRIS_MAX; i++) {
      this.debrisMesh.setMatrixAt(i, ZERO_SCALE);
      this.debrisMesh.setColorAt(i, wood[i % wood.length]);
    }
    this.debrisMesh.visible = false;
    this.debrisMesh.instanceMatrix.needsUpdate = true;
    if (this.debrisMesh.instanceColor !== null) this.debrisMesh.instanceColor.needsUpdate = true;
    this.root.add(this.debrisMesh);

    // ── Dome ──
    this.glass = new DomeGlass(shared, sunDir);
    this.disposables.push(this.glass);
    this.glass.mesh.name = 'ocean-glass';
    this.root.add(this.glass.mesh);
    const fr = buildDomeFrame(R, DOME_HEIGHT);
    this.frame = new THREE.Mesh(own(fr.frame), own(frameMaterial()));
    this.frame.name = 'ocean-frame';
    this.root.add(this.frame);
    // ONE unlit glow draw for every emissive bit (ramp inlays + chevrons, rim accents, coral tips, pad lights, the collar's running lights).
    this.glowMesh = new THREE.Mesh(own(mergeGlow([lv.glow, pr.glow, fr.glow])), glowMat);
    this.glowMesh.name = 'ocean-glow';
    this.root.add(this.glowMesh);
    this.rays = new OceanRays(shared, sunDir, 18);
    this.disposables.push(this.rays);
    this.rays.mesh.name = 'ocean-rays';
    this.root.add(this.rays.mesh);
    this.surface = new SurfacePlane(shared);
    this.disposables.push(this.surface);
    this.surface.mesh.name = 'ocean-surface';
    this.root.add(this.surface.mesh);
    this.snow = new MarineSnow(shared, BUDGETS.high.snow, R);
    this.disposables.push(this.snow);
    this.snow.points.name = 'ocean-snow';
    this.root.add(this.snow.points);

    // ── The ocean beyond ──
    this.life = new SeaLife(shared, R);
    this.root.add(this.life.root);

    // ── The serpent ──
    this.serpentModel = new SerpentModel(shared, 'low');
    this.root.add(this.serpentModel.root);
    this.serpentFx = new SerpentFx(shared, arena, centreY, 'low');
    this.root.add(this.serpentFx.root);
    this.serpentModelHigh = new SerpentModel(shared, 'high');
    this.root.add(this.serpentModelHigh.root);
    this.serpentFxHigh = new SerpentFx(shared, arena, centreY, 'high');
    this.root.add(this.serpentFxHigh.root);
    this.lanes = {
      low: { tier: 'low', block: null, alpha: 1, visual: blank('low'), exitT: -1, dirty: false, model: this.serpentModel, fx: this.serpentFx, shake: 0 },
      high: { tier: 'high', block: null, alpha: 1, visual: blank('high'), exitT: -1, dirty: false, model: this.serpentModelHigh, fx: this.serpentFxHigh, shake: 0 },
    };
    this.fallFx = new FallFx(arena);
    this.root.add(this.fallFx.root);

    // ── Pickup beacons (the colosseum's icons / rings / lights, on the pads' own levels) ──
    this.beacons = new PickupBeacons(arena.pickupPads.map((p) => ({ x: p.x, z: p.z, y: arenaGroundHeight(arena, p.x, p.z) })));
    this.root.add(this.beacons.root);

    this.stats = { ...pr.stats, crates: crates.length, ramps: lv.stats.ramps, climbs: lv.stats.climbs, towers: lv.stats.towers, bulbs: lv.stats.bulbs };

    this.tier = getQualityTier();
    this.applyTier(this.tier);
    this.unsubscribe = onQualityChange((t) => this.applyTier(t));
  }

  // ── ArenaScene ─────────────────────────────────────────────────────────────

  setSnapshot(snapshot: WorldSnapshot, alpha = 1): void {
    this.setBlock(this.lanes.low, snapshot.serpent, alpha);
    this.setBlock(this.lanes.high, snapshot.serpentHigh, alpha);
  }

  private setBlock(lane: Lane, s: Pick<SerpentState, 'phase' | 'angleDeg' | 't'> | null | undefined, alpha: number): void {
    if (s === undefined || s === null) {
      lane.block = null;
    } else if (lane.block === null) {
      // Keep our own copy (the snapshot object may be reused / mutated by the driver).
      lane.block = { phase: s.phase, angleDeg: s.angleDeg, t: s.t };
    } else {
      lane.block.phase = s.phase;
      lane.block.angleDeg = s.angleDeg;
      lane.block.t = s.t;
    }
    lane.alpha = alpha;
  }

  /** QA / demo: set a serpent block directly (null = no event); `tier` picks the lane (default: the low serpent). */
  setSerpentBlock(block: Pick<SerpentState, 'phase' | 'angleDeg' | 't'> | null, alpha = 1, tier: SerpentTier = 'low'): void {
    this.setBlock(this.lanes[tier], block, alpha);
  }

  update(dt: number, excitement: number): void {
    void excitement;
    this.time += dt;
    this.shared.uTime.value = this.time;
    this.snow.update();
    this.beacons.update(dt, this.time);
    this.updateDebris(dt);
    this.updateSerpents(dt);
    this.fallFx.update(dt);
  }

  onEvent(e: GameEvent): void {
    switch (e.type) {
      case 'serpentWarning':
        this.lanes[e.tier ?? 'low'].exitT = -1;
        break;
      case 'serpentStrike': {
        const lane = this.lanes[e.tier ?? 'low'];
        const a = (e.angleDeg * Math.PI) / 180;
        lane.fx.onStrike(Math.cos(a), Math.sin(a));
        kickFov(2.2);
        this.strikeKick = 0.14;
        lane.exitT = -1;
        break;
      }
      case 'serpentHit':
        this.lanes[e.tier ?? 'low'].fx.onHit(e.pos.x, e.pos.y, e.pos.z);
        if (!this.hasFocus || Math.hypot(e.pos.x - this.focusX, e.pos.z - this.focusZ) < 2.6) {
          this.hitShake = 0.15;
          kickFov(5);
        }
        break;
      case 'fall':
        // the impact burst at the landing spot; the victim's own camera gets a thump (a bot far away does not shake the player)
        this.fallFx.burst(e.pos.x, e.pos.y, e.pos.z, e.drop);
        if (!this.hasFocus || Math.hypot(e.pos.x - this.focusX, e.pos.z - this.focusZ) < 2.2) {
          this.fallShake = 0.13;
          kickFov(4);
        }
        break;
      default:
        break;
    }
  }

  breakCrate(id: number): void {
    const crates = this.arena.crates;
    if (id < 0 || id >= crates.length || !this.crateAlive[id]) return;
    this.crateAlive[id] = false;
    this.crateMesh.setMatrixAt(id, ZERO_SCALE);
    this.crateMesh.instanceMatrix.needsUpdate = true;
    const cr = crates[id];
    const floor = cr.baseY ?? 0;
    this.debrisMesh.visible = true;
    for (let n = 0; n < DEBRIS_PER_CRATE; n++) {
      const i = this.dCursor;
      this.dCursor = (this.dCursor + 1) % DEBRIS_MAX;
      this.dActive[i] = 1;
      this.dLife[i] = 2.2 + this.rng() * 0.5;
      this.dFloor[i] = floor + 0.07;
      const o = i * 3;
      this.dPos[o] = cr.x + (this.rng() - 0.5) * 0.6;
      this.dPos[o + 1] = floor + 0.4 + this.rng() * 0.6;
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
    arenaShake.amount = 0;
    this.root.removeFromParent();
    this.beacons.dispose();
    this.life.dispose();
    this.serpentModel.dispose();
    this.serpentFx.dispose();
    this.serpentModelHigh.dispose();
    this.serpentFxHigh.dispose();
    this.fallFx.dispose();
    this.crateMesh.dispose();
    this.debrisMesh.dispose();
    for (const d of this.disposables) d.dispose();
  }

  // ── Introspection (tests / QA demo) ────────────────────────────────────────

  getStats(): OceanStats {
    return { ...this.stats, life: this.life.getStats() };
  }

  getTier(): QualityTier {
    return this.tier;
  }

  /** The low serpent's visual state (v1.9 name). */
  getVisual(): SerpentVisual {
    return this.lanes.low.visual;
  }

  /** The visual state of the serpent of `tier`. */
  getVisualOf(tier: SerpentTier): SerpentVisual {
    return this.lanes[tier].visual;
  }

  getGlass(): DomeGlass {
    return this.glass;
  }

  get sharedUniforms(): OceanShared {
    return this.shared;
  }

  getSeaLife(): SeaLife {
    return this.life;
  }

  /** QA: override the elapsed ocean time (whale passes, jelly drift, caustics). */
  setTime(t: number): void {
    this.time = t;
    this.shared.uTime.value = t;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private applyTier(tier: QualityTier): void {
    this.tier = tier;
    const b = BUDGETS[tier];
    const prof = tierProfile(tier);
    this.snow.setCount(b.snow);
    this.rays.mesh.visible = b.rays > 0 && prof.lightShafts;
    this.rays.setIntensity(b.rays);
    this.surface.mesh.visible = b.surface;
    this.life.setTier(tier);
    this.serpentModel.setTier(tier);
    this.serpentFx.setTier(tier);
    this.serpentModelHigh.setTier(tier);
    this.serpentFxHigh.setTier(tier);
    this.fallFx.setTier(tier);
    this.beacons.setTier(tier);
  }

  /** Advance one serpent's visual state (incl. the withdrawal after the sim ends the event). */
  private stepLane(lane: Lane, dt: number): void {
    const v = lane.visual;
    const wasActive = v.active && v.phase !== 'exit';
    serpentVisualState(this.arena, lane.block, lane.alpha, v, lane.exitT, lane.tier);
    if (lane.block === null) {
      if (wasActive && lane.exitT < 0) {
        // The sim ended the event: the serpent keeps withdrawing outside the glass for a moment.
        lane.exitT = 0;
        serpentVisualState(this.arena, null, 1, v, lane.exitT, lane.tier);
      } else if (lane.exitT >= 0) {
        lane.exitT += dt;
        if (lane.exitT >= EXIT_S) {
          lane.exitT = -1;
          serpentVisualState(this.arena, null, 1, v, -1, lane.tier);
        } else serpentVisualState(this.arena, null, 1, v, lane.exitT, lane.tier);
      }
    } else lane.exitT = -1;
  }

  private updateSerpents(dt: number): void {
    const low = this.lanes.low;
    const high = this.lanes.high;
    this.stepLane(low, dt);
    this.stepLane(high, dt);
    const g = this.glass.uniforms;

    // ── low serpent: glass breach near the ground, red-orange alarm ──
    {
      const v = low.visual;
      if (!v.active) {
        low.model.root.visible = false;
        low.fx.update(v, dt, 9);
        if (low.dirty) {
          g.uCrack.value = 0;
          g.uHole.value = 0;
          g.uShudder.value = 0;
          g.uFlash.value = 0;
          this.shared.uAlarm.value = 0;
          low.dirty = false;
        }
        low.shake = 0;
      } else {
        low.dirty = true;
        low.model.update(this.arena, v, this.time);
        low.fx.update(v, dt, v.phase === 'warn' ? v.t : 9);
        // Glass: breach point on the dome surface at the strike direction (just above the ground), cracks / hole / shudder / flash.
        const el = Math.asin(Math.min(0.9, 2.2 / DOME_HEIGHT));
        g.uBreach.value.set(v.dirX * Math.cos(el), Math.sin(el), v.dirZ * Math.cos(el)).normalize();
        g.uCrack.value = v.crack;
        g.uHole.value = v.hole;
        g.uShudder.value = v.shudder;
        g.uFlash.value = v.flash;
        this.shared.uAlarm.value = v.phase === 'warn' ? v.urgency * (0.5 + 0.5 * Math.sin(this.time * (10 + 22 * v.urgency))) : 0;
        low.shake = serpentShake(v, this.focusX, this.focusZ, this.hasFocus, this.arena.wallRadius);
      }
    }

    // ── high serpent: glass breach at its flight height, violet alarm, its own pools ──
    {
      const v = high.visual;
      if (!v.active) {
        high.model.root.visible = false;
        high.fx.update(v, dt, 9);
        if (high.dirty) {
          g.uCrack2.value = 0;
          g.uHole2.value = 0;
          g.uShudder2.value = 0;
          g.uFlash2.value = 0;
          this.shared.uAlarmHigh.value = 0;
          high.dirty = false;
        }
        high.shake = 0;
      } else {
        high.dirty = true;
        high.model.update(this.arena, v, this.time);
        high.fx.update(v, dt, v.phase === 'warn' ? v.t : 9);
        const el = Math.asin(Math.min(0.95, breachHeight(this.arena, 'high') / DOME_HEIGHT));
        g.uBreach2.value.set(v.dirX * Math.cos(el), Math.sin(el), v.dirZ * Math.cos(el)).normalize();
        g.uCrack2.value = v.crack;
        g.uHole2.value = v.hole;
        g.uShudder2.value = v.shudder;
        g.uFlash2.value = v.flash;
        this.shared.uAlarmHigh.value = v.phase === 'warn' ? v.urgency * (0.5 + 0.5 * Math.sin(this.time * (9 + 20 * v.urgency) + 1.3)) : 0;
        high.shake = serpentShake(v, this.focusX, this.focusZ, this.hasFocus, this.arena.wallRadius);
      }
    }

    this.hitShake = Math.max(0, this.hitShake - dt * 0.9);
    this.fallShake = Math.max(0, this.fallShake - dt * 0.7);
    this.strikeKick = Math.max(0, this.strikeKick - dt * 0.5);
    // (the rig caps the sum at its own 0.15 m)
    arenaShake.amount = low.shake + high.shake + this.hitShake + this.fallShake;
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
      if (this.dPos[o + 1] < this.dFloor[i]) {
        this.dPos[o + 1] = this.dFloor[i];
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
    this.debrisMesh.visible = any || this.debrisDirty;
  }
}

/** Merge several vertex-coloured (position + color [+ normal]) geometries into one position / color geometry; the parts are disposed. */
function mergeGlow(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let nv = 0;
  let ni = 0;
  for (const p of parts) {
    nv += p.getAttribute('position').count;
    ni += p.index?.count ?? 0;
  }
  const pos = new Float32Array(nv * 3);
  const col = new Float32Array(nv * 3);
  const idx = new Uint32Array(ni);
  let vo = 0;
  let io = 0;
  for (const p of parts) {
    const pa = p.getAttribute('position');
    const ca = p.getAttribute('color');
    for (let i = 0; i < pa.count; i++) {
      pos[(vo + i) * 3] = pa.getX(i);
      pos[(vo + i) * 3 + 1] = pa.getY(i);
      pos[(vo + i) * 3 + 2] = pa.getZ(i);
      col[(vo + i) * 3] = ca.getX(i);
      col[(vo + i) * 3 + 1] = ca.getY(i);
      col[(vo + i) * 3 + 2] = ca.getZ(i);
    }
    const ix = p.index;
    if (ix !== null) for (let k = 0; k < ix.count; k++) idx[io + k] = ix.getX(k) + vo;
    io += ix?.count ?? 0;
    vo += pa.count;
    p.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}
