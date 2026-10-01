/**
 * First-person screen-space clear zone (v1.3.x). The local player's OWN rig must never draw a fragment inside the centre of
 * the screen (the crosshair / aim area): a profile with `clip: { w, h }` gets every own-rig colour material (body, glow,
 * outline hull) patched so fragments whose NDC position falls inside the centred `w × h` (fractions of the screen) rectangle
 * are discarded. The test runs on the interpolated CLIP-space position (`gl_Position` varying, perspective-correct), so it
 * is independent of the viewport / resolution / render target and works for skinned meshes, the inverted-hull outline and
 * unlit glow alike.
 *
 * Cost model: nothing is patched until a clip profile is first applied to a rig (`FpClipControl.set`); after that the patch
 * stays compiled and a single uniform (`uGkClip.z`) switches it on (first person) / off (third person, other views), so the
 * toggle never recompiles a program. Every rig owns its own materials, so other fighters are untouched.
 */

import * as THREE from 'three';
import type { FpClip } from './types';

/** Half extents of the clear zone in NDC (a fraction `f` of the screen is `f` NDC units each side of centre: NDC spans 2). */
export function clipHalfExtents(c: FpClip): { x: number; y: number } {
  return { x: clamp01(c.w), y: clamp01(c.h) };
}

/** True when an NDC point lies strictly inside the clear zone. */
export function inClipZone(ndcX: number, ndcY: number, c: FpClip): boolean {
  const h = clipHalfExtents(c);
  return Math.abs(ndcX) < h.x && Math.abs(ndcY) < h.y;
}

/** The clear zone as a pixel rectangle `[x0, y0, x1, y1)` (y down, from the top-left) of a `width × height` frame. */
export function clipZoneRect(c: FpClip, width: number, height: number): { x0: number; y0: number; x1: number; y1: number } {
  const h = clipHalfExtents(c);
  return {
    x0: Math.ceil(width * 0.5 * (1 - h.x)),
    x1: Math.floor(width * 0.5 * (1 + h.x)),
    y0: Math.ceil(height * 0.5 * (1 - h.y)),
    y1: Math.floor(height * 0.5 * (1 + h.y)),
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Marker so a shader is never patched twice. */
const MARK = 'gkFpClip';

/** The shader fragments the clip needs (exported for tests). */
export const CLIP_CHUNKS = {
  vertexDecl: 'varying vec4 vGkClip;',
  vertexSet: 'vGkClip = gl_Position;',
  fragmentDecl: 'varying vec4 vGkClip;\nuniform vec3 uGkClip;',
  fragmentTest:
    'if (uGkClip.z > 0.5) { vec2 gkN = vGkClip.xy / vGkClip.w; if (abs(gkN.x) < uGkClip.x && abs(gkN.y) < uGkClip.y) discard; }',
};

interface ShaderLike {
  vertexShader: string;
  fragmentShader: string;
  uniforms: Record<string, { value: unknown }>;
}

/** Patch a three.js built-in material shader (MeshStandard / MeshBasic) with the clear-zone discard. Idempotent. */
export function patchClipShader(shader: ShaderLike, uniform: { value: THREE.Vector3 }): void {
  if (shader.fragmentShader.includes(MARK)) return;
  shader.uniforms.uGkClip = uniform;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n// ${MARK}\n${CLIP_CHUNKS.vertexDecl}`)
    .replace('#include <project_vertex>', `#include <project_vertex>\n${CLIP_CHUNKS.vertexSet}`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n// ${MARK}\n${CLIP_CHUNKS.fragmentDecl}`)
    .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${CLIP_CHUNKS.fragmentTest}`);
}

/**
 * Owns the clear-zone uniform of ONE rig and the materials it is attached to. `set(clip)` enables (a clip) / disables
 * (`undefined`) the discard; the first enable patches the materials (one recompile), later toggles only flip the uniform.
 */
export class FpClipControl {
  /** x, y = half extents (NDC); z = 1 when active. */
  readonly uniform = { value: new THREE.Vector3(0, 0, 0) };
  private readonly mats: THREE.Material[];
  private patched = false;

  constructor(mats: readonly THREE.Material[]) {
    this.mats = mats.slice();
  }

  get active(): boolean {
    return this.uniform.value.z > 0.5;
  }

  set(clip: FpClip | undefined): void {
    if (clip === undefined) {
      this.uniform.value.z = 0;
      return;
    }
    const h = clipHalfExtents(clip);
    this.uniform.value.set(h.x, h.y, 1);
    if (!this.patched) this.patch();
  }

  private patch(): void {
    this.patched = true;
    const uniform = this.uniform;
    for (const mat of this.mats) {
      const prev = mat.onBeforeCompile;
      const prevKey = mat.customProgramCacheKey;
      mat.onBeforeCompile = (shader, renderer) => {
        prev.call(mat, shader, renderer);
        patchClipShader(shader as unknown as ShaderLike, uniform);
      };
      mat.customProgramCacheKey = () => `${prevKey.call(mat)}|${MARK}`;
      mat.needsUpdate = true;
    }
  }
}
