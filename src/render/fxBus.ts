/**
 * Render-internal FX channel (v1.1 WP-K). Lets systems inside `src/render`
 * talk without new wiring in match code:
 *
 *  - animal rigs report footfalls, landings and slam impacts (they know the
 *    exact animation instant, e.g. u = 0.55) → the live {@link Effects} spawns
 *    dust / ground-crack decals;
 *  - Effects raises a FOV kick on ultimates / heavy hits → {@link CameraRig}
 *    applies and decays it.
 *
 * Only one match renders at a time, so a single module-level sink is enough.
 * The sink ignores rigs that are not in its own scene (lobby previews).
 */

import type * as THREE from 'three';

export type SlamKind = 'crack' | 'ring';

export interface FxSink {
  /** A foot planted while running. `scale` ~0.5 (small) … 1.5 (heavy). */
  footstep(source: THREE.Object3D, x: number, z: number, scale: number): void;
  /** Landing after a jump / glide / pounce. */
  land(source: THREE.Object3D, x: number, z: number, scale: number): void;
  /** Ground slam at the impact instant (gorilla leap, hippo rush, …). */
  slam(source: THREE.Object3D, x: number, z: number, radius: number, color: number, kind: SlamKind): void;
  /**
   * v1.8 jungle pool: a water splash at the surface (a swimming animal's attack impact, a paddle stroke, a heavy step).
   * `radius` metres, `strength` 0..1. Optional so older sinks keep compiling; rigs call it with optional chaining.
   */
  splash?(source: THREE.Object3D, x: number, z: number, radius: number, strength: number): void;
  /** v1.8: a swimming animal's wake / ripple ring while it moves in the water (`speed` m/s, `scale` ≈ body size). */
  wake?(source: THREE.Object3D, x: number, z: number, speed: number, scale: number): void;
}

let sink: FxSink | null = null;

export function setFxSink(s: FxSink | null): void {
  sink = s;
}

export function getFxSink(): FxSink | null {
  return sink;
}

/** Shared camera FOV kick in degrees (Effects writes, CameraRig decays). */
export const fovKick = { deg: 0 };

export function kickFov(deg: number): void {
  if (deg > fovKick.deg) fovKick.deg = deg > 7 ? 7 : deg;
}
