/**
 * v1.6 dynamic-stage helpers shared by the scenes, the view and the tests (node-safe, pure): which platforms exist, which crack stage a
 * breakable shows, whether the stage has reached its final form, and the extents a moving platform sweeps over its whole loop.
 *
 * Everything here is derived from `PlatformState` snapshots (`active` / `hp` / `maxHp`) so the look is correct after a rollback or a late
 * join; the cosmetic events (`platformHit` / `platformBreak` / `stageFinal`) only add one-off effects on top.
 */

import { pathOffset } from '../../data/stages';
import type { PlatformDef, PlatformState, StageDef } from '../../types';

/** `active` is undefined for ordinary platforms (= exists). */
export function isActive(p: PlatformState | undefined): boolean {
  return p !== undefined && p.active !== false;
}

/** Number of crack stages a breakable can show (0 = intact). */
export const CRACK_STAGES = 3;

/**
 * Crack stage 0..3 from the hits remaining: stage = ceil(3 * hitsTaken / maxHp). A 4-hit piece goes 0 → 1 → 2 → 3 → (gone); a 6-hit piece
 * 0 → 1 → 1 → 2 → 2 → 3 → (gone). Non-breakables and destroyed pieces report 0 (callers hide destroyed pieces through `isActive`).
 */
export function crackStage(hp: number | undefined, maxHp: number | undefined): 0 | 1 | 2 | 3 {
  if (hp === undefined || maxHp === undefined || maxHp <= 0 || hp <= 0) return 0;
  const taken = Math.max(0, Math.min(maxHp, maxHp - hp));
  if (taken === 0) return 0;
  const s = Math.ceil((CRACK_STAGES * taken) / maxHp);
  return (s < 1 ? 1 : s > CRACK_STAGES ? CRACK_STAGES : s) as 1 | 2 | 3;
}

/** True once any `finalOnly` platform of the stage is active in the snapshot (the arena is in its final form). */
export function finalFormReached(defs: readonly PlatformDef[], states: readonly PlatformState[]): boolean {
  for (let i = 0; i < defs.length; i++) {
    if (defs[i].finalOnly !== true) continue;
    for (let k = 0; k < states.length; k++) {
      if (states[k].id === defs[i].id) {
        // `active` is undefined for ordinary platforms (= exists); the sim always reports it explicitly for finalOnly ones
        if (states[k].active !== false) return true;
        break;
      }
    }
  }
  return false;
}

export interface Extent {
  x0: number;
  x1: number;
  yMin: number;
  yMax: number;
}

/**
 * The box a platform's TOP SURFACE sweeps over its entire `path` / `moving` loop (sampled; the same evaluators the sim uses): the left
 * edge min, the right edge max, the lowest and highest top surface.
 */
export function platformExtent(p: PlatformDef, samples = 240): Extent {
  let x0 = p.x0;
  let x1 = p.x1;
  let yMin = p.y;
  let yMax = p.y;
  const consider = (ox: number, oy: number): void => {
    if (p.x0 + ox < x0) x0 = p.x0 + ox;
    if (p.x1 + ox > x1) x1 = p.x1 + ox;
    if (p.y + oy < yMin) yMin = p.y + oy;
    if (p.y + oy > yMax) yMax = p.y + oy;
  };
  if (p.moving !== undefined) {
    const a = p.moving.amplitude;
    if (p.moving.axis === 'x') consider(-a, 0);
    else consider(0, -a);
    if (p.moving.axis === 'x') consider(a, 0);
    else consider(0, a);
  }
  if (p.path !== undefined) {
    const n = Math.max(8, samples);
    const frames = p.path.periodS * 60;
    // moving + path together: add the path offset on top of every extreme of the moving offset (conservative box)
    const mx = p.moving !== undefined && p.moving.axis === 'x' ? p.moving.amplitude : 0;
    const my = p.moving !== undefined && p.moving.axis === 'y' ? p.moving.amplitude : 0;
    for (let i = 0; i < n; i++) {
      const o = pathOffset(p.path, (i / n) * frames);
      consider(o.x - mx, o.y - my);
      consider(o.x + mx, o.y + my);
    }
    // the keys themselves (the loop passes exactly through them)
    for (const k of p.path.keys) consider(k.x, k.y);
  }
  return { x0, x1, yMin, yMax };
}

/**
 * Extents of the whole stage over every loop and every form: all platforms, `finalOnly` ones included (they exist in the match's second
 * half), moving ones over their full travel. The camera frames from this so nothing is ever cut off and the zoom never pumps.
 */
export function stageExtent(stage: StageDef): Extent {
  let x0 = Infinity;
  let x1 = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const p of stage.platforms) {
    const e = platformExtent(p);
    if (e.x0 < x0) x0 = e.x0;
    if (e.x1 > x1) x1 = e.x1;
    if (e.yMin < yMin) yMin = e.yMin;
    if (e.yMax > yMax) yMax = e.yMax;
  }
  return { x0, x1, yMin, yMax };
}

/** Does the stage have anything dynamic worth a badge / special handling? */
export function stageTraits(stage: StageDef): { moving: boolean; breakable: boolean } {
  let moving = false;
  let breakable = false;
  for (const p of stage.platforms) {
    if (p.moving !== undefined || p.path !== undefined) moving = true;
    if (p.breakable !== undefined) breakable = true;
  }
  return { moving, breakable };
}
