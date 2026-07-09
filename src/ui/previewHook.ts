/**
 * Preview decoupling seam (WP-F ↔ WP-E, wired by WP-I).
 *
 * The lobby and character-select screens want a live 3D turntable of the
 * currently-selected gladiator, but WP-F must not import `src/render/`. Instead
 * WP-I registers a {@link PreviewFactory} (backed by `render/preview.ts`) at boot
 * via {@link setPreviewFactory}. If none is registered — during the `?demo=ui`
 * flow, or before render wiring — the screens fall back to a styled inline-SVG
 * silhouette. This keeps the UI independently demoable.
 */

import type { AnimalId } from '../core/types';

/** Live handle over a mounted preview scene. */
export interface PreviewHandle {
  /** Swap the displayed animal without recreating the scene. */
  setAnimal(a: AnimalId): void;
  /** Tear down the scene and release its WebGL/rAF resources. */
  dispose(): void;
}

/** Builds a preview bound to a canvas (implemented by WP-E, injected by WP-I). */
export type PreviewFactory = (canvas: HTMLCanvasElement, animal: AnimalId) => PreviewHandle;

let currentFactory: PreviewFactory | null = null;

/** Register the real 3D preview factory (called once by WP-I at boot). */
export function setPreviewFactory(f: PreviewFactory): void {
  currentFactory = f;
}

/** The registered factory, or `null` when the UI should use its SVG fallback. */
export function getPreviewFactory(): PreviewFactory | null {
  return currentFactory;
}
