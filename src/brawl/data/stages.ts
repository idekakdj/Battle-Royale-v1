/**
 * Champions League — stage geometry (plan §4). Coordinates in metres, y = 0 is the top of
 * the main platform(s). Visuals live in `src/brawl/render/stages/**`; this file is geometry only.
 * Both stages: no hazards, deterministic moving platform (a pure function of the frame).
 */

import type { MovingSpec, PlatformDef, StageDef, StageId } from '../types';

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

export const STAGE_DEFS: Record<StageId, StageDef> = {
  brokenColosseum: BROKEN_COLOSSEUM,
  skyAqueduct: SKY_AQUEDUCT,
};

/**
 * Horizontal/vertical offset of a moving platform at simulation frame `frame` (60 Hz):
 * `amplitude × sin(2π (t / period + phase))`. Pure function of the frame — the sim, the view and the
 * bots should all use this (or the identical formula) so the platform is deterministic.
 */
export function movingOffset(spec: MovingSpec, frame: number): number {
  return spec.amplitude * Math.sin(2 * Math.PI * (frame / 60 / spec.periodS + spec.phase));
}

/** Current top-surface rectangle `[x0, x1, y]` of a platform at `frame` (moving ones displaced along their axis). */
export function platformAt(p: PlatformDef, frame: number): { x0: number; x1: number; y: number } {
  if (!p.moving) return { x0: p.x0, x1: p.x1, y: p.y };
  const o = movingOffset(p.moving, frame);
  return p.moving.axis === 'x' ? { x0: p.x0 + o, x1: p.x1 + o, y: p.y } : { x0: p.x0, x1: p.x1, y: p.y + o };
}
