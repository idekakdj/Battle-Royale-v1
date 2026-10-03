/**
 * Champions League bots — stage knowledge. A bot knows the map like a player does: platform kinds,
 * ledges, blast zones. Positions of moving platforms come from the snapshot every frame.
 */

import type { BrawlSnapshot, PlatformDef, PlatformState, StageDef } from '../types';
import { STAGES } from '../data';

export interface Plat {
  id: string;
  solid: boolean;
  x0: number;
  x1: number;
  /** Current top-surface Y. */
  y: number;
  thickness: number;
  moving: boolean;
}

export interface LedgeInfo {
  /** Index into `StageInfo.plats`. */
  plat: number;
  /** −1 = the left end of the platform, +1 = the right end. */
  side: -1 | 1;
  /** Corner x. */
  x: number;
}

const FOOT_HALF_MAX = 0.6;
const SUPPORT_TOL = 0.5;

export function supportedBy(x: number, width: number, x0: number, x1: number): boolean {
  const fw = Math.min(width * 0.5, FOOT_HALF_MAX);
  const tol = fw * SUPPORT_TOL;
  return x + tol > x0 && x - tol < x1;
}

export class StageInfo {
  readonly def: StageDef;
  readonly plats: Plat[];
  readonly ledges: LedgeInfo[] = [];
  /** Index of the widest solid platform's... centre of the stage (mean of the solids' span). */
  readonly centerX: number;
  /** Lowest solid top (the "floor" level). */
  readonly floorY: number;
  readonly blast: StageDef['blast'];

  constructor(def: StageDef) {
    this.def = def;
    this.blast = def.blast;
    this.plats = def.platforms.map((p: PlatformDef) => ({
      id: p.id,
      solid: p.kind === 'solid',
      x0: p.x0,
      x1: p.x1,
      y: p.y,
      thickness: p.thickness,
      moving: !!p.moving,
    }));
    let lo = Infinity;
    let hi = -Infinity;
    let floor = Infinity;
    def.platforms.forEach((p, i) => {
      if (p.kind !== 'solid') return;
      lo = Math.min(lo, p.x0);
      hi = Math.max(hi, p.x1);
      floor = Math.min(floor, p.y);
      if (p.ledgeLeft) this.ledges.push({ plat: i, side: -1, x: p.x0 });
      if (p.ledgeRight) this.ledges.push({ plat: i, side: 1, x: p.x1 });
    });
    this.centerX = Number.isFinite(lo) ? (lo + hi) * 0.5 : 0;
    this.floorY = Number.isFinite(floor) ? floor : 0;
  }

  /** Copy current (moving) platform geometry from a snapshot. */
  sync(platforms: readonly PlatformState[]): void {
    const n = Math.min(platforms.length, this.plats.length);
    for (let i = 0; i < n; i++) {
      const s = platforms[i];
      const p = this.plats[i];
      p.x0 = s.x0;
      p.x1 = s.x1;
      p.y = s.y;
    }
  }

  platIndex(id: string | null): number {
    if (id === null) return -1;
    for (let i = 0; i < this.plats.length; i++) if (this.plats[i].id === id) return i;
    return -1;
  }

  /** Highest platform whose top is at or below `y + tol` and that supports a body of `width` at x (−1 = none). */
  platformBelow(x: number, y: number, width: number, tol = 0.3): number {
    let best = -1;
    let by = -Infinity;
    for (let i = 0; i < this.plats.length; i++) {
      const p = this.plats[i];
      if (p.y > y + tol || p.y <= by) continue;
      if (!supportedBy(x, width, p.x0, p.x1)) continue;
      best = i;
      by = p.y;
    }
    return best;
  }

  /** Nearest solid-ledge corner measured from a point (optionally only a side). */
  nearestLedge(x: number, y: number, skip?: (l: LedgeInfo) => boolean): LedgeInfo | null {
    let best: LedgeInfo | null = null;
    let bd = Infinity;
    for (const l of this.ledges) {
      if (skip && skip(l)) continue;
      const p = this.plats[l.plat];
      const d = Math.hypot(l.x - x, p.y - y);
      if (d < bd) {
        bd = d;
        best = l;
      }
    }
    return best;
  }

  /** The solid platform spans, merged for a quick "over the stage" test. */
  overSolid(x: number, margin = 0): boolean {
    for (const p of this.plats) if (p.solid && x > p.x0 - margin && x < p.x1 + margin) return true;
    return false;
  }
}

/** Identify the stage a snapshot belongs to (platform ids), falling back to a guess from geometry. */
export function stageFromSnapshot(snap: BrawlSnapshot): StageInfo {
  const ids = snap.platforms.map((p) => p.id).join(',');
  for (const def of Object.values(STAGES)) {
    if (def.platforms.map((p) => p.id).join(',') === ids) return new StageInfo(def);
  }
  // unknown stage: lowest wide platforms are solid with ledges, the rest soft
  let floor = Infinity;
  for (const p of snap.platforms) floor = Math.min(floor, p.y);
  const platforms: PlatformDef[] = snap.platforms.map((p) => {
    const solid = p.y <= floor + 0.01 && p.x1 - p.x0 >= 6;
    return {
      id: p.id,
      kind: solid ? 'solid' : 'soft',
      x0: p.x0,
      x1: p.x1,
      y: p.y,
      thickness: solid ? 3 : 0.4,
      ...(solid ? { ledgeLeft: true, ledgeRight: true } : {}),
    } as PlatformDef;
  });
  const def: StageDef = {
    id: 'brokenColosseum',
    name: 'unknown',
    blurb: '',
    blast: { left: -30, right: 30, top: 22, bottom: -16 },
    platforms,
    spawns: [],
    respawn: { x: 0, y: 12 },
    cameraFocus: { x: 0, y: 4 },
    camera: { minHalfW: 11, maxHalfW: 19 },
  };
  return new StageInfo(def);
}
