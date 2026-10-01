/**
 * Per-animal ultimate VFX contract (v1.3 WP-T).
 *
 * A per-animal module is a file `src/render/ultFx/<animal>.ts` (animal id as the
 * file name: `lion.ts`, `crocodile.ts`, …) whose DEFAULT export is either
 *
 *   - a plain {@link UltFx} object, or
 *   - a factory `(ctx: UltFxContext) => UltFx` (handy when you want per-match
 *     closure state; the factory runs once per match).
 *
 * The registry in `./index.ts` discovers these with `import.meta.glob`, so adding
 * a file is all that is needed — no shared file is edited. Files whose name is
 * not an animal id, or that start with `_`, are ignored.
 *
 * Every hook receives the shared {@link UltFxContext}; all of them are optional.
 * Hooks run on the render side only (never touch the sim) and must not allocate
 * per frame: reserve pooled markers from `ctx.indicators`, keep state in
 * module-level slots keyed by fighter id, and clean up in `onEnd` / `dispose`.
 */

import type * as THREE from 'three';
import type { GameEventOf, Vec3, WorldSnapshot } from '../../core/types';
import type { Effects } from '../Effects';
import type { IndicatorStyle, UltIndicators } from './primitives';

export interface UltFxContext {
  readonly scene: THREE.Scene;
  /** Shared pooled FX (hits, dust, rings, flashes, cracks, particles …). */
  readonly effects: Effects;
  /** Shared indicator primitives (ring / ribbon / reticle / arc / zone). */
  readonly indicators: UltIndicators;
  readonly camera: THREE.PerspectiveCamera;
  /** Render-clock seconds since the match mounted (advances only while rendering). */
  readonly time: number;
  /** Latest sim snapshot (fighter states are sim-rate, not interpolated). */
  readonly snapshot: WorldSnapshot;
  /** Interpolated (as drawn) fighter position written into `out`. */
  fighterPos(id: number, out: THREE.Vector3): THREE.Vector3;
  /** Interpolated (as drawn) fighter yaw. */
  fighterYaw(id: number): number;
  /** The rig root (attach transient meshes / read bones). */
  fighterObject(id: number): THREE.Object3D;
  /** True when `id` is the local player. */
  isPlayer(id: number): boolean;
  /** Indicator style for something `id` causes: gold 'friendly' for the player, red 'hostile' otherwise. */
  styleFor(id: number): IndicatorStyle;
  /** 0..1: how close `pos` is to the camera's fighter (1 = on top, 0 = ≥ range); for shakes / kicks. */
  nearness(pos: Vec3, range: number): number;
}

export interface UltFx {
  /** The ultimate resolved its target and starts (`windup` seconds until active). */
  onTarget?(ctx: UltFxContext, ev: GameEventOf<'ultimateTarget'>): void;
  /** A discrete beat of the ultimate (each maul strike / slam / blink …). */
  onStage?(ctx: UltFxContext, ev: GameEventOf<'ultimateStage'>): void;
  /** The caster (or a fighter of this animal) blinked; interpolation is already snapped. */
  onBlink?(ctx: UltFxContext, ev: GameEventOf<'blink'>): void;
  /** A projectile owned by a fighter of this animal landed. */
  onImpact?(ctx: UltFxContext, ev: GameEventOf<'projectileImpact'>): void;
  /** Every render frame (real dt); must early-out cheaply when idle. */
  onFrame?(ctx: UltFxContext, snapshot: WorldSnapshot, dt: number): void;
  /** The fighter's ultimate ended (or it died): drop any per-fighter state. Markers owned by that fighter are auto-faded. */
  onEnd?(ctx: UltFxContext, fighterId: number): void;
  /** Match teardown. */
  dispose?(): void;
}

export type UltFxModule = UltFx | ((ctx: UltFxContext) => UltFx);
