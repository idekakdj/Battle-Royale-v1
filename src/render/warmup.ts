/**
 * Shader warm-up (v1.10.1, WP-L2): compile every program a match will use BEFORE the first live frame.
 *
 * three.js links a material's GLSL program the first time it is drawn, which on the newer maps (Jungle, Ocean Dome: custom
 * ShaderMaterials, serpent / fall / water FX, ten rigs) is a 100-300 ms main-thread stall in the middle of the first frames. For
 * the online host that stall delays snapshots and pongs for everybody. This module moves the cost to the loading moment:
 *
 *  1. `renderer.compile(scene, camera)` - since r16x this walks EVERY mesh in the scene (visible or not), so the hidden serpent
 *     models, serpent FX, fall FX, the pooled effect sprites and the water ripples are all built here;
 *  2. the same compile against a tiny HalfFloat render target - programs are keyed by output colour space / tone mapping, and the
 *     post-processing tiers draw the scene into a render target while the damage-number overlay pass draws straight to the canvas,
 *     so both variants are needed;
 *  3. one throwaway frame through the real pipeline (`SceneManager.render`): composes the grade / bloom / output passes and the
 *     shadow-depth programs, which `compile` does not touch. The canvas is cleared afterwards so the throwaway frame can never be
 *     shown.
 *
 * It changes no visual state (the frame is thrown away) and is wrapped in try/catch: a failure only costs the old first-frame hitch.
 */

import * as THREE from 'three';
import type { Effects } from './Effects';
import { tierProfile } from './quality';
import type { SceneManager } from './SceneManager';

export interface WarmUpReport {
  /** Wall time spent warming up (ms). */
  ms: number;
  /** Shader programs the renderer held before / after (renderer.info.programs). */
  programsBefore: number;
  programsAfter: number;
  ok: boolean;
  error?: string;
}

export interface WarmUpOptions {
  /** The match's effects layer: its lazily created water FX is built here on maps that have water. */
  effects?: Pick<Effects, 'getWater'> | null;
  /** Build the water FX (jungle / ocean). */
  water?: boolean;
}

export function warmUpRenderer(sm: SceneManager, opts: WarmUpOptions = {}): WarmUpReport {
  const r = sm.renderer;
  const t0 = performance.now();
  const programsBefore = r.info.programs?.length ?? 0;
  let ok = true;
  let error: string | undefined;
  let target: THREE.WebGLRenderTarget | null = null;
  const prevTarget = r.getRenderTarget();
  try {
    if (opts.water === true) opts.effects?.getWater();

    // (1) programs for drawing straight to the canvas (low tier, the overlay pass).
    r.setRenderTarget(null);
    r.compile(sm.scene, sm.camera);

    // (2) programs for drawing into the post-processing render target (medium / high).
    if (tierProfile(sm.getQualityTier()).composer) {
      target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
      r.setRenderTarget(target);
      r.compile(sm.scene, sm.camera);
      r.setRenderTarget(null);
    }

    // (3) one throwaway frame through the real pipeline (post passes + shadow-depth programs), then wipe it.
    sm.render();
    r.setRenderTarget(null);
    r.clear(true, true, true);
  } catch (err) {
    ok = false;
    error = err instanceof Error ? err.message : String(err);
  } finally {
    r.setRenderTarget(prevTarget);
    if (target !== null) target.dispose();
  }
  return {
    ms: performance.now() - t0,
    programsBefore,
    programsAfter: r.info.programs?.length ?? 0,
    ok,
    ...(error !== undefined ? { error } : {}),
  };
}
