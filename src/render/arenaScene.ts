/**
 * ARENA SCENE ENTRY POINT (v1.8 jungle, WP-J3) — the one clean call the match controller makes to get the scenery of an arena.
 *
 *     const arenaScene = createArenaScene(this.sceneManager, getArena(config.arena));   // replaces
 *     //   this.stadium = new Stadium(); this.sceneManager.scene.add(this.stadium.root);
 *
 * It (1) styles the shared light rig / fog / sky / colour grade for the arena (`SceneManager.setArena`, which also publishes
 * the arena to `render/arenaContext` so CameraRig, the first-person eye clamp, Effects and the audio ambience follow it),
 * (2) builds the matching scenery — the unchanged {@link Stadium} for the colosseum, `render/jungle/JungleScene` for the
 * jungle — and (3) adds its `root` to `sceneManager.scene`. Call it once per match, BEFORE the first rendered frame (CameraRig /
 * Effects read the arena lazily, so the order against them does not matter). Pass nothing / `undefined` for the colosseum.
 *
 * Both scenes implement {@link ArenaScene}, which is exactly the surface MatchController already uses on `Stadium`
 * (`update`, `breakCrate`, `resetCrates`, `isCrateAlive`, `setPickupVisible`, `setPickupFocus`, `crowdCount`, `dispose`), so the
 * rest of the controller needs no change beyond the field's type (`private stadium!: ArenaScene`).
 */

import type * as THREE from 'three';
import type { ArenaId, PickupState } from '../core/types';
import { getArena, type ArenaDef } from '../config/arenas';
import type { SceneManager } from './SceneManager';
import { Stadium } from './Stadium';
import { JungleScene } from './jungle/JungleScene';

export type PickupKind = PickupState['kind'];

/** What every arena's scenery offers the match (identical to the v1.7 `Stadium` public surface + the arena it was built for). */
export interface ArenaScene {
  /** The arena definition this scene dresses. */
  readonly arena: ArenaDef;
  /** Scene-graph root (already added to the scene by {@link createArenaScene}). */
  readonly root: THREE.Group;
  /** Crowd instance count (the colosseum's spectators; 0 in the jungle). */
  readonly crowdCount: number;
  /** Advance ambience / debris / icon spin (call once per rendered frame; `excitement` 0..1). */
  update(dt: number, excitement: number): void;
  /** Remove crate `id` (index into `arena.crates`) and burst a pooled debris pile. Safe to call twice. */
  breakCrate(id: number): void;
  isCrateAlive(id: number): boolean;
  /** Restore all crates (rematch). */
  resetCrates(): void;
  /** Show/hide the floating icon of `kind` on pad `padIndex` (matches `arena.pickupPads` order). */
  setPickupVisible(padIndex: number, kind: PickupKind, visible: boolean): void;
  /** The focused fighter's ground position (pickup labels; the jungle also uses it for the trunk fade). */
  setPickupFocus(x: number, z: number): void;
  dispose(): void;
}

/**
 * Build the scenery for `arena` (an {@link ArenaDef}, an {@link ArenaId}, or nothing = colosseum) on `sceneManager`:
 * styles the light rig, builds the scene and adds its root to `sceneManager.scene`.
 */
export function createArenaScene(sceneManager: SceneManager, arena?: ArenaDef | ArenaId): ArenaScene {
  const def = typeof arena === 'string' || arena === undefined ? getArena(arena) : arena;
  sceneManager.setArena(def);
  const scene: ArenaScene = def.id === 'jungle' ? new JungleScene(sceneManager, def) : new Stadium();
  sceneManager.scene.add(scene.root);
  return scene;
}
