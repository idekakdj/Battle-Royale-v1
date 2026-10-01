/**
 * Ultimate VFX registry + dispatcher (v1.3 WP-T).
 *
 * Auto-discovers `src/render/ultFx/<animal>.ts` modules with `import.meta.glob`
 * (eager) — drop a file in, nothing else to edit. See `./types.ts` for the
 * {@link UltFx} contract and `./_example.ts` for a worked example (files starting
 * with `_`, and `index` / `primitives` / `types` / `targetingBridge`, are not
 * registered; so is any file whose name is not an animal id).
 *
 * {@link UltFxDispatcher} is owned by the MatchController: it routes
 * `ultimateTarget` / `ultimateStage` / `blink` / `projectileImpact` to the module
 * of the casting animal (animals without a module get the generic indicator in
 * `_default.ts`), calls every module's `onFrame` once per render frame, and
 * detects the end of each fighter's ultimate (ultPhase gone / action leaves
 * 'ultimate' / death) to fire `onEnd` and fade the markers that fighter owns.
 */

import * as THREE from 'three';
import { ANIMAL_IDS } from '../../config/animals';
import type { AnimalId, GameEventOf, Vec3, WorldSnapshot } from '../../core/types';
import { defaultUltFx } from './_default';
import type { IndicatorStyle, UltIndicators } from './primitives';
import type { Effects } from '../Effects';
import { nearFadeFactor } from '../fpFade';
import type { UltFx, UltFxContext, UltFxModule } from './types';

export type { UltFx, UltFxContext, UltFxModule } from './types';

const found = import.meta.glob<{ default?: UltFxModule }>(
  ['./*.ts', '!./index.ts', '!./primitives.ts', '!./types.ts', '!./targetingBridge.ts', '!./_*.ts'],
  { eager: true },
);

/** `./lion.ts` → 'lion' (null when the file name is not an animal id). */
function animalOfPath(path: string): AnimalId | null {
  const m = /([^/]+)\.ts$/.exec(path);
  if (m === null) return null;
  return (ANIMAL_IDS as readonly string[]).includes(m[1]) ? (m[1] as AnimalId) : null;
}

const registry: Partial<Record<AnimalId, UltFxModule>> = {};
for (const path of Object.keys(found)) {
  const animal = animalOfPath(path);
  const def = found[path].default;
  if (animal !== null && def !== undefined) registry[animal] = def;
}

/** Animals that ship their own ultimate VFX module (debug / tests). */
export function registeredUltFxAnimals(): AnimalId[] {
  return (Object.keys(registry) as AnimalId[]).sort();
}

/** What the MatchController hands the dispatcher. */
export interface UltFxHost {
  scene: THREE.Scene;
  effects: Effects;
  indicators: UltIndicators;
  camera: THREE.PerspectiveCamera;
  /** Latest sim snapshot. */
  snapshot(): WorldSnapshot;
  /** Rig root of fighter `id` (interpolated position / yaw are read from it). */
  root(id: number): THREE.Object3D;
  /** Fighter the camera follows (player, or the spectated fighter). */
  focusId(): number;
  /** The local player's fighter id. */
  playerId: number;
  /** Fired when a fighter's ultimate ends (audio `onEnd` hook, HUD …). */
  onUltEnd?(fighterId: number, animal: AnimalId): void;
}

const _warned = new Set<string>();

function safe(label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    if (!_warned.has(label)) {
      _warned.add(label);
      console.error(`[ultFx] ${label} threw`, err);
    }
  }
}

// ── v1.3 FP ult: near-camera fade of the ultimate VFX (first person) ──────────────────────────────────────────────
// In first person the camera sits INSIDE the local caster's own effects: columns / shells / beams centred on the
// player, and the shared ground ribbons / arcs that start at the caster's feet or hands. This pass (run after the
// camera is placed) fades them near the camera: dispatcher-owned transparent meshes by distance to their bounds,
// ribbon / arc indicators by distance to their footprint / start. Everything is restored when it is off.

/** Meshes thinner than this (m) are ground decals / ribbons / rings: left alone (they sit under the camera, not around it). */
const FADE_FLAT = 0.25;
/** Distance (m) from a volumetric mesh's bounds at which it is fully visible again. */
const FADE_VOL = 1.2;
/** Ribbon footprint distance (m) at which it is back to full alpha, and the floor alpha for the local caster's own / others'. */
const FADE_RIBBON_D = 2.2;
const FADE_RIBBON_OWN = 0.22;
const FADE_RIBBON_OTHER = 0.45;
const FADE_ARC_D = 1.6;
const FADE_ARC_OWN = 0.3;
/** `UltPreview`'s owner id for the ready-state markers (the player's own preview). */
const PREVIEW_OWNER = -2;

/** A fadable alpha channel: a material's `opacity` or a shader uniform's `value`. */
type FadeChannel = THREE.Material | { value: number };

function readChannel(t: FadeChannel): number {
  return (t as THREE.Material).isMaterial === true ? (t as THREE.Material).opacity : (t as { value: number }).value;
}

function writeChannel(t: FadeChannel, v: number): void {
  if ((t as THREE.Material).isMaterial === true) (t as THREE.Material).opacity = v;
  else (t as { value: number }).value = v;
}

/** The alpha-like uniform names the per-animal ShaderMaterials use. */
const ALPHA_UNIFORMS = ['uAlpha', 'uFade', 'uOpacity'] as const;

function fadeChannelOf(mat: THREE.Material): FadeChannel | null {
  if ((mat as THREE.ShaderMaterial).isShaderMaterial === true) {
    const u = (mat as THREE.ShaderMaterial).uniforms;
    for (const k of ALPHA_UNIFORMS) if (u[k] !== undefined && typeof u[k].value === 'number') return u[k] as { value: number };
    return null;
  }
  return mat;
}

interface IndicatorLike {
  mesh: THREE.Mesh;
  owner: number;
  active: boolean;
}

const _fm = new THREE.Vector3();
const _fx = new THREE.Vector3();
const _fy = new THREE.Vector3();
const _fz = new THREE.Vector3();
const _fi = new THREE.Matrix4();
const _fl = new THREE.Vector3();

function smooth01(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

/** Fade factor 0..1 for one transparent scene mesh seen from `cam` (1 = leave alone). */
function meshFadeFactor(mesh: THREE.Mesh, cam: THREE.Vector3): number {
  const g = mesh.geometry;
  if (g.boundingBox === null) g.computeBoundingBox();
  const bb = g.boundingBox;
  if (bb === null) return 1;
  const m = mesh.matrixWorld;
  const sx = _fx.setFromMatrixColumn(m, 0).length();
  const sy = _fy.setFromMatrixColumn(m, 1).length();
  const sz = _fz.setFromMatrixColumn(m, 2).length();
  const wx = (bb.max.x - bb.min.x) * sx;
  const wy = (bb.max.y - bb.min.y) * sy;
  const wz = (bb.max.z - bb.min.z) * sz;
  const thin = Math.min(wx, wy, wz);
  if (thin < FADE_FLAT) {
    // Flat: a ground decal / ribbon (leave alone) or an upright billboard quad (sprite rule on its extent).
    const axis = thin === wx ? _fx.setFromMatrixColumn(m, 0) : thin === wy ? _fy.setFromMatrixColumn(m, 1) : _fz.setFromMatrixColumn(m, 2);
    axis.normalize();
    _fm.set((bb.min.x + bb.max.x) * 0.5, (bb.min.y + bb.max.y) * 0.5, (bb.min.z + bb.max.z) * 0.5).applyMatrix4(m);
    // A horizontal quad near the floor is a ground decal; a horizontal-looking quad up in the air is a camera-facing billboard.
    if ((axis.y > 0.8 || axis.y < -0.8) && _fm.y < 0.5) return 1;
    return nearFadeFactor(_fm.distanceTo(cam), Math.max(wx, wy, wz) * 0.5);
  }
  // Volumetric: distance from the camera to the (scaled) box; 0 inside.
  _fi.copy(m).invert();
  _fl.copy(cam).applyMatrix4(_fi);
  const dx = Math.max(bb.min.x - _fl.x, 0, _fl.x - bb.max.x) * sx;
  const dy = Math.max(bb.min.y - _fl.y, 0, _fl.y - bb.max.y) * sy;
  const dz = Math.max(bb.min.z - _fl.z, 0, _fl.z - bb.max.z) * sz;
  return smooth01(Math.hypot(dx, dy, dz) / FADE_VOL);
}

export class UltFxDispatcher implements UltFxContext {
  private readonly host: UltFxHost;
  /** Parent of every mesh the per-animal modules add (they see it as `ctx.scene`) — the near-camera fade walks it. */
  private readonly fxRoot = new THREE.Group();
  private readonly fadeBase = new WeakMap<object, { base: number; last: number }>();
  private readonly fadedMats = new Set<FadeChannel>();
  private readonly fadeNow = new Map<FadeChannel, number>();
  private readonly modules: Partial<Record<AnimalId, UltFx>> = {};
  private readonly moduleList: { animal: AnimalId; fx: UltFx }[] = [];
  private casting: Uint8Array;
  private timeS = 0;
  private snap: WorldSnapshot;

  constructor(host: UltFxHost) {
    this.host = host;
    this.fxRoot.name = 'ult-fx-root';
    host.scene.add(this.fxRoot);
    this.snap = host.snapshot();
    this.casting = new Uint8Array(this.snap.fighters.length);
    for (const animal of Object.keys(registry) as AnimalId[]) {
      const def = registry[animal];
      if (def === undefined) continue;
      let fx: UltFx | undefined;
      safe(`${animal} factory`, () => {
        fx = typeof def === 'function' ? def(this) : def;
      });
      if (fx !== undefined) {
        this.modules[animal] = fx;
        this.moduleList.push({ animal, fx });
      }
    }
  }

  // ── UltFxContext ───────────────────────────────────────────────────────────
  get scene(): THREE.Scene {
    // Modules only add / remove their meshes: hand them the dispatcher's own root so the fade pass can find them.
    return this.fxRoot as unknown as THREE.Scene;
  }
  get effects(): Effects {
    return this.host.effects;
  }
  get indicators(): UltIndicators {
    return this.host.indicators;
  }
  get camera(): THREE.PerspectiveCamera {
    return this.host.camera;
  }
  get time(): number {
    return this.timeS;
  }
  get snapshot(): WorldSnapshot {
    return this.snap;
  }
  fighterPos(id: number, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.host.root(id).position);
  }
  fighterYaw(id: number): number {
    return this.host.root(id).rotation.y;
  }
  fighterObject(id: number): THREE.Object3D {
    return this.host.root(id);
  }
  isPlayer(id: number): boolean {
    return id === this.host.playerId;
  }
  styleFor(id: number): IndicatorStyle {
    return id === this.host.playerId ? 'friendly' : 'hostile';
  }
  nearness(pos: Vec3, range: number): number {
    const p = this.host.root(this.host.focusId()).position;
    const d = Math.hypot(pos.x - p.x, pos.z - p.z);
    const n = 1 - d / range;
    return n < 0 ? 0 : n > 1 ? 1 : n;
  }

  // ── Event routing ──────────────────────────────────────────────────────────

  private fxOf(animal: AnimalId | undefined): UltFx | undefined {
    return animal === undefined ? undefined : this.modules[animal];
  }

  private animalOf(id: number): AnimalId | undefined {
    const f = this.snap.fighters[id];
    return f === undefined ? undefined : f.animal;
  }

  target(ev: GameEventOf<'ultimateTarget'>): void {
    const fx = this.fxOf(ev.animal);
    if (fx === undefined) safe('default.onTarget', () => defaultUltFx.onTarget?.(this, ev));
    else if (fx.onTarget !== undefined) safe(`${ev.animal}.onTarget`, () => fx.onTarget?.(this, ev));
  }

  stage(ev: GameEventOf<'ultimateStage'>): void {
    const fx = this.fxOf(ev.animal);
    if (fx === undefined) safe('default.onStage', () => defaultUltFx.onStage?.(this, ev));
    else if (fx.onStage !== undefined) safe(`${ev.animal}.onStage`, () => fx.onStage?.(this, ev));
  }

  blink(ev: GameEventOf<'blink'>): void {
    const fx = this.fxOf(this.animalOf(ev.fighterId));
    if (fx === undefined) safe('default.onBlink', () => defaultUltFx.onBlink?.(this, ev));
    else if (fx.onBlink !== undefined) safe('onBlink', () => fx.onBlink?.(this, ev));
  }

  impact(ev: GameEventOf<'projectileImpact'>): void {
    const fx = this.fxOf(this.animalOf(ev.ownerId));
    if (fx === undefined) safe('default.onImpact', () => defaultUltFx.onImpact?.(this, ev));
    else if (fx.onImpact !== undefined) safe('onImpact', () => fx.onImpact?.(this, ev));
  }

  /** Once per render frame (real dt, after the rigs were positioned). */
  update(dt: number): void {
    this.timeS += dt;
    this.snap = this.host.snapshot();
    const fighters = this.snap.fighters;
    if (this.casting.length !== fighters.length) this.casting = new Uint8Array(fighters.length);
    for (let i = 0; i < fighters.length; i++) {
      const f = fighters[i];
      const now = f.alive && (f.ultPhase !== undefined || f.action === 'ultimate') ? 1 : 0;
      if (this.casting[i] === 1 && now === 0) this.end(i, f.animal);
      this.casting[i] = now;
    }
    safe('default.onFrame', () => defaultUltFx.onFrame?.(this, this.snap, dt));
    for (let i = 0; i < this.moduleList.length; i++) {
      const m = this.moduleList[i];
      if (m.fx.onFrame !== undefined) safe(`${m.animal}.onFrame`, () => m.fx.onFrame?.(this, this.snap, dt));
    }
  }

  private end(id: number, animal: AnimalId): void {
    const fx = this.fxOf(animal);
    if (fx === undefined) safe('default.onEnd', () => defaultUltFx.onEnd?.(this, id));
    else if (fx.onEnd !== undefined) safe(`${animal}.onEnd`, () => fx.onEnd?.(this, id));
    this.host.indicators.releaseOwner(id);
    this.host.onUltEnd?.(id, animal);
  }

  /**
   * v1.3 FP ult: fade the ultimate VFX that surround / start at the first-person camera. Call once per frame after the
   * camera was placed and after `update()`. `enabled` = first person is (mostly) active; off restores everything.
   * Opacity bookkeeping: a material whose opacity changed since we last wrote it was re-assigned by its module, so that
   * value becomes the new base; indicator alphas are re-assigned every frame by their pool, so scaling is safe.
   */
  nearFade(camera: THREE.Camera, enabled: boolean): void {
    const now = this.fadeNow;
    now.clear();
    if (enabled) {
      const cam = camera.position;
      this.fxRoot.updateMatrixWorld(true);
      this.fxRoot.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh !== true || !o.visible || (o as THREE.InstancedMesh).isInstancedMesh === true) return;
        const mat = mesh.material;
        if (Array.isArray(mat) || !mat.transparent) return;
        const ch = fadeChannelOf(mat);
        if (ch === null) return;
        const f = meshFadeFactor(mesh, cam);
        const prev = now.get(ch);
        if (prev === undefined || f < prev) now.set(ch, f);
      });
      this.fadeIndicators(cam);
    }
    for (const [ch, f] of now) {
      const cur = readChannel(ch);
      let rec = this.fadeBase.get(ch);
      if (rec === undefined) {
        rec = { base: cur, last: cur };
        this.fadeBase.set(ch, rec);
      }
      if (cur !== rec.last) rec.base = cur;
      const v = rec.base * f;
      writeChannel(ch, v);
      rec.last = v;
      if (f < 1) this.fadedMats.add(ch);
    }
    for (const ch of this.fadedMats) {
      const f = now.get(ch);
      if (f !== undefined && f < 1) continue;
      const rec = this.fadeBase.get(ch);
      if (rec !== undefined && readChannel(ch) === rec.last) {
        writeChannel(ch, rec.base);
        rec.last = rec.base;
      }
      this.fadedMats.delete(ch);
    }
  }

  /** Dim ground ribbons that run under the camera and arcs that start at it (the pools re-assign `uAlpha` every frame). */
  private fadeIndicators(cam: THREE.Vector3): void {
    const all = (this.host.indicators as unknown as { all?: IndicatorLike[] }).all;
    if (all === undefined) return;
    const pid = this.host.playerId;
    for (let i = 0; i < all.length; i++) {
      const h = all[i];
      if (!h.active || !h.mesh.visible) continue;
      const mat = h.mesh.material as THREE.ShaderMaterial;
      const u = mat.uniforms;
      if (u === undefined || u.uAlpha === undefined) continue;
      const own = h.owner === pid || h.owner === 1000 + pid || h.owner === PREVIEW_OWNER;
      if (u.uLen !== undefined) {
        // Ribbon: distance from the camera to its footprint rectangle (position / yaw / half-extents = scale.x, scale.z).
        const p = h.mesh.position;
        const yaw = h.mesh.rotation.y;
        const rx = cam.x - p.x;
        const rz = cam.z - p.z;
        const lx = rx * Math.cos(yaw) - rz * Math.sin(yaw);
        const lz = rx * Math.sin(yaw) + rz * Math.cos(yaw);
        const d = Math.hypot(Math.max(Math.abs(lx) - h.mesh.scale.x, 0), Math.max(Math.abs(lz) - h.mesh.scale.z, 0));
        const floor = own ? FADE_RIBBON_OWN : FADE_RIBBON_OTHER;
        u.uAlpha.value *= floor + (1 - floor) * smooth01(d / FADE_RIBBON_D);
      } else if (u.uFrom !== undefined && own) {
        // Own dashed arc: dim while its start is right at the camera (the gorilla's hands).
        const from = u.uFrom.value as THREE.Vector3;
        const d = from.distanceTo(cam);
        u.uAlpha.value *= FADE_ARC_OWN + (1 - FADE_ARC_OWN) * smooth01((d - 0.6) / FADE_ARC_D);
      }
    }
  }

  /** Forget every per-fighter state (round reset / pause → resume is NOT one). */
  dispose(): void {
    safe('default.dispose', () => defaultUltFx.dispose?.());
    for (const m of this.moduleList) safe(`${m.animal}.dispose`, () => m.fx.dispose?.());
    this.moduleList.length = 0;
    this.host.scene.remove(this.fxRoot);
    this.fadedMats.clear();
  }
}
