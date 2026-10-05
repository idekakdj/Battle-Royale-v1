/**
 * Champions League — stage geometry (plan §4; v1.6 dynamic stages: docs/CL-MAPS-PLAN.md). Coordinates in metres, y = 0 is the top of
 * the main platform(s). Visuals live in `src/brawl/render/stages/**`; this file is geometry only.
 * No stage has hazards; every moving platform is a deterministic pure function of the frame.
 *
 *   brokenColosseum        one wide solid stage + three soft tiers
 *   skyAqueduct            two islands + a sinusoidal drifter
 *   clockworkHeights       v1.6: a solid `core` that drifts along a looping `path` + four soft satellites that glide between three layouts
 *   crumblingAmphitheatre  v1.6: six `breakable` pieces; destroying the last one switches the arena to its FINAL form (`finalOnly` platforms)
 */

import type { MovingSpec, PathSpec, PlatformDef, StageDef, StageId } from '../types';
import { pathOffsetAt } from '../sim/geometry';

const BROKEN_COLOSSEUM: StageDef = {
  id: 'brokenColosseum',
  name: 'Broken Colosseum',
  blurb: 'A floating slab of colosseum floor in a golden-hour sky. One wide stage, three broken-beam tiers.',
  blast: { left: -30, right: 30, top: 22, bottom: -16 },
  platforms: [
    { id: 'main', kind: 'solid', x0: -11, x1: 11, y: 0, thickness: 3.5, ledgeLeft: true, ledgeRight: true },
    { id: 'left', kind: 'soft', x0: -9, x1: -4, y: 4.2, thickness: 0.4 },
    { id: 'right', kind: 'soft', x0: 4, x1: 9, y: 4.2, thickness: 0.4 },
    { id: 'top', kind: 'soft', x0: -2.5, x1: 2.5, y: 7.6, thickness: 0.4 },
  ],
  spawns: [
    { x: -7, y: 0 },
    { x: -2.5, y: 0 },
    { x: 2.5, y: 0 },
    { x: 7, y: 0 },
  ],
  respawn: { x: 0, y: 12 },
  cameraFocus: { x: 0, y: 4 },
  camera: { minHalfW: 11, maxHalfW: 19 },
};

const SKY_AQUEDUCT: StageDef = {
  id: 'skyAqueduct',
  name: 'Sky Aqueduct',
  blurb: 'Two floating aqueduct islands over open sky, a drifting stone platform in the gap and a high bridge above.',
  blast: { left: -30, right: 30, top: 22, bottom: -18 },
  platforms: [
    { id: 'islandL', kind: 'solid', x0: -13, x1: -3, y: 0, thickness: 3, ledgeLeft: true, ledgeRight: true },
    { id: 'islandR', kind: 'solid', x0: 3, x1: 13, y: 0, thickness: 3, ledgeLeft: true, ledgeRight: true },
    {
      id: 'drifter',
      kind: 'soft',
      x0: -2.5,
      x1: 2.5,
      y: 2.6,
      thickness: 0.4,
      moving: { axis: 'x', amplitude: 3.2, periodS: 9, phase: 0 },
    },
    { id: 'high', kind: 'soft', x0: -3, x1: 3, y: 7.8, thickness: 0.4 },
    { id: 'smallL', kind: 'soft', x0: -12, x1: -8, y: 4.6, thickness: 0.4 },
    { id: 'smallR', kind: 'soft', x0: 8, x1: 12, y: 4.6, thickness: 0.4 },
  ],
  spawns: [
    { x: -10, y: 0 },
    { x: -6, y: 0 },
    { x: 6, y: 0 },
    { x: 10, y: 0 },
  ],
  respawn: { x: 0, y: 12 },
  cameraFocus: { x: 0, y: 4 },
  camera: { minHalfW: 12, maxHalfW: 21 },
};

// ── v1.6: Clockwork Heights ──────────────────────────────────────────────────

/** Round a derived key offset to 4 decimals (keeps the shipped data free of float noise like 0.30000000000000004). */
function r4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/**
 * The core's loop (offsets from its defined position, 40 s, eight 5 s legs with cosine easing, so it eases to a rest at every key): a lazy
 * wander of about ±3.5 m sideways and −0.6 … +1.5 m vertically. Peak speed ≈ 0.95 m/s (limit: PHYS.dynCoreMaxSpeed).
 */
const CORE_PATH: PathSpec = {
  periodS: 40,
  phase: 0,
  keys: [
    { t: 0, x: 0, y: 0 },
    { t: 0.125, x: 2, y: 1.2 },
    { t: 0.25, x: 3.5, y: 0.6 },
    { t: 0.375, x: 2.6, y: -0.6 },
    { t: 0.5, x: 0, y: 0.2 },
    { t: 0.625, x: -2.4, y: -0.2 },
    { t: 0.75, x: -3.5, y: 1 },
    { t: 0.875, x: -2, y: 1.5 },
  ],
};

interface SatPose {
  /** Centre x and top y of the satellite in this layout. */
  x: number;
  y: number;
}

const SAT_W = 4.5;
const SAT_T = 0.5;

/**
 * A soft satellite that holds layout A, glides to B, holds, glides to C, holds, glides back to A on a shared 36 s loop (6 s holds, 6 s
 * glides, cosine eased). The defined position IS layout A; the keys are offsets from it. All four satellites share these key times.
 */
function satellite(id: string, a: SatPose, b: SatPose, c: SatPose): PlatformDef {
  const off = (p: SatPose): { x: number; y: number } => ({ x: r4(p.x - a.x), y: r4(p.y - a.y) });
  const B = off(b);
  const C = off(c);
  return {
    id,
    kind: 'soft',
    x0: r4(a.x - SAT_W / 2),
    x1: r4(a.x + SAT_W / 2),
    y: a.y,
    thickness: SAT_T,
    path: {
      periodS: 36,
      phase: 0,
      keys: [
        { t: 0, x: 0, y: 0 },
        { t: r4(1 / 6), x: 0, y: 0 },
        { t: r4(2 / 6), x: B.x, y: B.y },
        { t: 0.5, x: B.x, y: B.y },
        { t: r4(4 / 6), x: C.x, y: C.y },
        { t: r4(5 / 6), x: C.x, y: C.y },
      ],
    },
  };
}

/**
 * Layouts (centre x, top y). The two centre planks `satML` / `satMR` always stay between 2.9 and 3.9 m (reachable from the core at every
 * frame whatever its own phase); the outer pair `satL` / `satR` does the dramatic changes. The satellites keep their left-to-right order,
 * so the x gaps (≥ 1.1 m at every layout, linear in between) keep them from ever touching.
 *   A "cross"  — two high wings and two centre planks over the core
 *   B "stair"  — a diagonal staircase rising from the low left to the high right
 *   C "orbit"  — a tight centre bridge with two high planks circling above it
 */
const SAT_L = satellite('satL', { x: -10.5, y: 6.4 }, { x: -12.5, y: 2.6 }, { x: -6.5, y: 7.6 });
const SAT_ML = satellite('satML', { x: -3.6, y: 3.4 }, { x: -6.5, y: 3.3 }, { x: -2.8, y: 3.7 });
const SAT_MR = satellite('satMR', { x: 3.6, y: 3.4 }, { x: 0.2, y: 3.9 }, { x: 2.8, y: 3.7 });
const SAT_R = satellite('satR', { x: 10.5, y: 6.4 }, { x: 7.2, y: 6.8 }, { x: 6.5, y: 7.6 });

const CLOCKWORK_HEIGHTS: StageDef = {
  id: 'clockworkHeights',
  name: 'Clockwork Heights',
  blurb: 'A drifting brass-and-stone clockwork. The platforms never stop re-forming.',
  blast: { left: -32, right: 32, top: 24, bottom: -18 },
  platforms: [
    // the only solid platform — and it MOVES: riders are carried, bystanders are pushed out
    { id: 'core', kind: 'solid', x0: -6.5, x1: 6.5, y: 0, thickness: 3.2, ledgeLeft: true, ledgeRight: true, path: CORE_PATH },
    SAT_L,
    SAT_ML,
    SAT_MR,
    SAT_R,
  ],
  spawns: [
    { x: -5, y: 0 },
    { x: -1.7, y: 0 },
    { x: 1.7, y: 0 },
    { x: 5, y: 0 },
  ],
  respawn: { x: 0, y: 12 },
  cameraFocus: { x: 0, y: 4 },
  camera: { minHalfW: 12, maxHalfW: 22 },
};

// ── v1.6: Crumbling Amphitheatre ─────────────────────────────────────────────

const CRUMBLING_AMPHITHEATRE: StageDef = {
  id: 'crumblingAmphitheatre',
  name: 'Crumbling Amphitheatre',
  blurb: 'Smash the ruins: break every piece and the arena transforms.',
  blast: { left: -30, right: 30, top: 22, bottom: -17 },
  platforms: [
    // unbreakable outer floors (their OUTER ledges are always grabbable; the inner ones only while the corner is exposed)
    { id: 'floorL', kind: 'solid', x0: -13, x1: -8.5, y: 0, thickness: 3.5, ledgeLeft: true, ledgeRight: true },
    { id: 'floorR', kind: 'solid', x0: 8.5, x1: 13, y: 0, thickness: 3.5, ledgeLeft: true, ledgeRight: true },
    // intact layout — six breakable pieces. Tiles open pits to the bottom blast zone; each tile has a ledge on the side that faces a neighbour
    // (grabbable only once that neighbour is gone — see PHYS.ledgeCover*).
    { id: 'tileL', kind: 'solid', x0: -8.5, x1: -3, y: 0, thickness: 3.5, ledgeRight: true, breakable: { hits: 6 } },
    { id: 'tileC', kind: 'solid', x0: -3, x1: 3, y: 0, thickness: 3.5, ledgeLeft: true, ledgeRight: true, breakable: { hits: 6 } },
    { id: 'tileR', kind: 'solid', x0: 3, x1: 8.5, y: 0, thickness: 3.5, ledgeLeft: true, breakable: { hits: 6 } },
    { id: 'archL', kind: 'soft', x0: -10, x1: -5.5, y: 4.4, thickness: 0.5, breakable: { hits: 4 } },
    { id: 'archR', kind: 'soft', x0: 5.5, x1: 10, y: 4.4, thickness: 0.5, breakable: { hits: 4 } },
    { id: 'crown', kind: 'soft', x0: -2.5, x1: 2.5, y: 7.8, thickness: 0.5, breakable: { hits: 4 } },
    // final form — exists only once every breakable is destroyed
    { id: 'sunL', kind: 'soft', x0: -11, x1: -6, y: 3, thickness: 0.5, finalOnly: true },
    { id: 'sunR', kind: 'soft', x0: 6, x1: 11, y: 3, thickness: 0.5, finalOnly: true },
    { id: 'core', kind: 'solid', x0: -3, x1: 3, y: 1.4, thickness: 2, ledgeLeft: true, ledgeRight: true, finalOnly: true },
    { id: 'halo', kind: 'soft', x0: -2.5, x1: 2.5, y: 6.4, thickness: 0.5, finalOnly: true },
  ],
  spawns: [
    { x: -7, y: 0 },
    { x: -2.5, y: 0 },
    { x: 2.5, y: 0 },
    { x: 7, y: 0 },
  ],
  respawn: { x: 0, y: 12 },
  cameraFocus: { x: 0, y: 4 },
  camera: { minHalfW: 11, maxHalfW: 19 },
};

export const STAGE_DEFS: Record<StageId, StageDef> = {
  brokenColosseum: BROKEN_COLOSSEUM,
  skyAqueduct: SKY_AQUEDUCT,
  clockworkHeights: CLOCKWORK_HEIGHTS,
  crumblingAmphitheatre: CRUMBLING_AMPHITHEATRE,
};

/**
 * Horizontal/vertical offset of a moving platform at simulation frame `frame` (60 Hz):
 * `amplitude × sin(2π (t / period + phase))`. Pure function of the frame — the sim, the view and the
 * bots should all use this (or the identical formula) so the platform is deterministic.
 */
export function movingOffset(spec: MovingSpec, frame: number): number {
  return spec.amplitude * Math.sin(2 * Math.PI * (frame / 60 / spec.periodS + spec.phase));
}

/**
 * v1.6: the offset a looping `PathSpec` adds to its platform at `frame` (cosine-eased key interpolation, see `pathOffsetAt` in
 * `sim/geometry.ts` — the sim uses the very same function, built on the deterministic `dcos`). Returns a fresh `{x, y}`.
 */
export function pathOffset(path: PathSpec, frame: number): { x: number; y: number } {
  const out = { x: 0, y: 0 };
  pathOffsetAt(path, frame, out);
  return out;
}

/**
 * Current top-surface rectangle `[x0, x1, y]` of a platform at `frame`: the defined position displaced by its `moving` offset (along its
 * axis) PLUS its `path` offset (v1.6). Same numbers the simulation computes (modulo the last bit of `Math.sin` for `moving`).
 */
export function platformAt(p: PlatformDef, frame: number): { x0: number; x1: number; y: number } {
  let ox = 0;
  let oy = 0;
  if (p.moving) {
    const o = movingOffset(p.moving, frame);
    if (p.moving.axis === 'x') ox = o;
    else oy = o;
  }
  if (p.path) {
    const o = pathOffset(p.path, frame);
    ox += o.x;
    oy += o.y;
  }
  return { x0: p.x0 + ox, x1: p.x1 + ox, y: p.y + oy };
}
