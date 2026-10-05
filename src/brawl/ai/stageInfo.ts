/**
 * Champions League bots — stage knowledge. A bot knows the map like a player does: platform kinds,
 * ledges, blast zones. Positions of moving platforms come from the snapshot every frame; v1.6 dynamic stages
 * (docs/CL-MAPS-PLAN.md) add: platforms that exist only sometimes (`active`: destroyed breakables, final-form
 * platforms), a velocity estimate for the drifting ones, ledges that are open only while their corner is not covered,
 * and a look-ahead (`setHorizon`) so recovery plans can use where a moving platform WILL be (every stage is a pure
 * function of the frame, public data like the move tables).
 */

import type { BrawlSnapshot, PlatformDef, PlatformState, StageDef } from '../types';
import { STAGES } from '../data';
import { platformAt } from '../data/stages';
import { PHYS } from '../config';

export interface Plat {
  id: string;
  solid: boolean;
  x0: number;
  x1: number;
  /** Current top-surface Y. */
  y: number;
  thickness: number;
  /** Drifts (`moving` or `path`). */
  moving: boolean;
  /** Exists / collides right now (false: a destroyed breakable, a final-form platform before the final form). */
  active: boolean;
  /** Takes counted hits and breaks; `hp` / `maxHp` are the hits left / total. */
  breakable: boolean;
  hp: number;
  maxHp: number;
  /** Appears with the final form. */
  finalOnly: boolean;
  /** Estimated velocity (m/s) from consecutive frames. */
  vx: number;
  vy: number;
}

export interface LedgeInfo {
  /** Index into `StageInfo.plats`. */
  plat: number;
  /** −1 = the left end of the platform, +1 = the right end. */
  side: -1 | 1;
  /** Current corner x (follows a moving platform). */
  x: number;
  /** Grabbable right now: its platform is active and the corner is not covered by another active platform at the same height. */
  open: boolean;
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
  /** All ledge candidates of the solid platforms (stable indices); only the `open` ones can be grabbed. */
  readonly ledges: LedgeInfo[] = [];
  /** Centre of the stage: mean of the ACTIVE solids' span (follows a drifting core; constant on static stages). */
  centerX: number;
  /** Lowest active solid top (the "floor" level). */
  floorY: number;
  readonly blast: StageDef['blast'];
  /** v1.6 dynamic stage (a `path`, `breakable` or `finalOnly` platform): enables the new awareness paths. */
  readonly dyn: boolean;
  /** Some platform drifts along a deterministic loop (`path` / `moving`) — recovery sims look ahead. */
  readonly drifts: boolean;
  /** Any breakable platform? */
  readonly hasBreakables: boolean;
  /** Indices of the breakable platforms. */
  readonly breakIdx: number[] = [];
  /** Frame of the last `sync` (−1 before the first). */
  frame = -1;
  /** Bumped whenever the set of active platforms changes (a piece broke, the final form arrived). */
  version = 0;

  private readonly defs: readonly PlatformDef[];
  private readonly driftIdx: number[] = [];
  // look-ahead tables (per drifting platform: x0 / x1 / y for k = 0 … horizonLen frames ahead of `horizonFrame`)
  private horizonFrame = -1;
  private horizonLen = 0;
  private hx0: Float64Array[] = [];
  private hx1: Float64Array[] = [];
  private hy: Float64Array[] = [];
  private saved: { x0: number; x1: number; y: number }[] = [];
  private projected = false;

  constructor(def: StageDef) {
    this.def = def;
    this.defs = def.platforms;
    this.blast = def.blast;
    this.plats = def.platforms.map((p: PlatformDef) => ({
      id: p.id,
      solid: p.kind === 'solid',
      x0: p.x0,
      x1: p.x1,
      y: p.y,
      thickness: p.thickness,
      moving: !!p.moving || !!p.path,
      active: !p.finalOnly,
      breakable: !!p.breakable,
      hp: p.breakable ? p.breakable.hits : 0,
      maxHp: p.breakable ? p.breakable.hits : 0,
      finalOnly: !!p.finalOnly,
      vx: 0,
      vy: 0,
    }));
    this.dyn = def.platforms.some((p) => !!p.path || !!p.breakable || !!p.finalOnly);
    this.hasBreakables = def.platforms.some((p) => !!p.breakable);
    def.platforms.forEach((p, i) => {
      if (p.breakable) this.breakIdx.push(i);
      if (p.moving || p.path) this.driftIdx.push(i);
      if (p.kind !== 'solid') return;
      if (p.ledgeLeft) this.ledges.push({ plat: i, side: -1, x: p.x0, open: !p.finalOnly });
      if (p.ledgeRight) this.ledges.push({ plat: i, side: 1, x: p.x1, open: !p.finalOnly });
    });
    this.drifts = this.driftIdx.length > 0;
    this.saved = this.plats.map(() => ({ x0: 0, x1: 0, y: 0 }));
    this.centerX = 0;
    this.floorY = 0;
    this.recompute();
  }

  /** Recompute the derived stage-wide numbers (centre, floor) and the ledge exposure from the current platform state. */
  private recompute(): void {
    let lo = Infinity;
    let hi = -Infinity;
    let floor = Infinity;
    for (const p of this.plats) {
      if (!p.solid || !p.active) continue;
      lo = Math.min(lo, p.x0);
      hi = Math.max(hi, p.x1);
      floor = Math.min(floor, p.y);
    }
    if (Number.isFinite(lo)) {
      this.centerX = (lo + hi) * 0.5;
      this.floorY = floor;
    }
    for (const l of this.ledges) {
      const p = this.plats[l.plat];
      l.x = l.side < 0 ? p.x0 : p.x1;
      l.open = this.ledgeOpen(l);
    }
  }

  /** Same exposure rule as the sim: active platform, corner not covered by another ACTIVE platform at the same height. */
  private ledgeOpen(l: LedgeInfo): boolean {
    const p = this.plats[l.plat];
    if (!p.active) return false;
    if (!this.dyn) return true;
    for (let j = 0; j < this.plats.length; j++) {
      if (j === l.plat) continue;
      const q = this.plats[j];
      if (!q.active) continue;
      if (Math.abs(q.y - p.y) <= PHYS.ledgeCoverDy && l.x >= q.x0 - PHYS.ledgeCoverTol && l.x <= q.x1 + PHYS.ledgeCoverTol) return false;
    }
    return true;
  }

  /** Copy the current platform state from a snapshot (positions, `active`, hp) and estimate the platform velocities from the previous call. */
  sync(platforms: readonly PlatformState[], frame = -1): void {
    this.endHorizon();
    const n = Math.min(platforms.length, this.plats.length);
    const dt = this.frame >= 0 && frame > this.frame ? frame - this.frame : 0;
    for (let i = 0; i < n; i++) {
      const s = platforms[i];
      const p = this.plats[i];
      if (dt > 0 && dt <= 6 && p.moving) {
        p.vx = ((s.x0 - p.x0) / dt) * 60;
        p.vy = ((s.y - p.y) / dt) * 60;
      } else if (!p.moving) {
        p.vx = 0;
        p.vy = 0;
      }
      p.x0 = s.x0;
      p.x1 = s.x1;
      p.y = s.y;
      if (this.dyn) {
        const act = s.active !== false;
        if (act !== p.active) this.version++;
        p.active = act;
        if (s.hp !== undefined) p.hp = s.hp;
        if (s.maxHp !== undefined) p.maxHp = s.maxHp;
      }
    }
    if (frame >= 0) this.frame = frame;
    if (this.dyn) this.recompute();
    else {
      // static ledges of the original stages never move (only the soft drifter does): nothing to recompute
    }
  }

  /** How many breakable platforms still exist. */
  activeBreakCount(): number {
    let n = 0;
    for (const i of this.breakIdx) if (this.plats[i].active && this.plats[i].hp > 0) n++;
    return n;
  }

  platIndex(id: string | null): number {
    if (id === null) return -1;
    for (let i = 0; i < this.plats.length; i++) if (this.plats[i].id === id) return i;
    return -1;
  }

  /** Highest ACTIVE platform whose top is at or below `y + tol` and that supports a body of `width` at x (−1 = none). */
  platformBelow(x: number, y: number, width: number, tol = 0.3): number {
    let best = -1;
    let by = -Infinity;
    for (let i = 0; i < this.plats.length; i++) {
      const p = this.plats[i];
      if (!p.active || p.y > y + tol || p.y <= by) continue;
      if (!supportedBy(x, width, p.x0, p.x1)) continue;
      best = i;
      by = p.y;
    }
    return best;
  }

  /** Nearest OPEN ledge corner measured from a point (optionally skipping some). */
  nearestLedge(x: number, y: number, skip?: (l: LedgeInfo) => boolean): LedgeInfo | null {
    let best: LedgeInfo | null = null;
    let bd = Infinity;
    for (const l of this.ledges) {
      if (!l.open) continue;
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

  /** The active solid platform spans, merged for a quick "over the stage" test. */
  overSolid(x: number, margin = 0): boolean {
    for (const p of this.plats) if (p.solid && p.active && x > p.x0 - margin && x < p.x1 + margin) return true;
    return false;
  }

  /**
   * The walkable run around platform `i`: the platform plus every ACTIVE platform that touches it at (nearly) the same height,
   * transitively (the Amphitheatre's tiles form one long floor). Returns the span `[lo, hi]` of the run (x0/x1 of the outermost).
   */
  runSpan(i: number, out: { lo: number; hi: number }): void {
    const p = this.plats[i];
    let lo = p.x0;
    let hi = p.x1;
    let grew = true;
    let guard = 0;
    while (grew && guard++ < 8) {
      grew = false;
      for (const q of this.plats) {
        if (q === p || !q.active || Math.abs(q.y - p.y) > 0.12) continue;
        if (q.x1 >= lo - 0.1 && q.x0 < lo - 1e-6) {
          lo = q.x0;
          grew = true;
        }
        if (q.x0 <= hi + 0.1 && q.x1 > hi + 1e-6) {
          hi = q.x1;
          grew = true;
        }
      }
    }
    out.lo = lo;
    out.hi = hi;
  }

  // ── look-ahead (deterministic platform motion) ────────────────────────────

  /**
   * Prepare the predicted rects of the drifting platforms for `frame … frame + len` (the data is a pure function of the frame, so a bot
   * knows it like it knows the move tables). Cheap no-op on stages without drifting platforms.
   */
  prepareHorizon(frame: number, len: number): void {
    if (!this.drifts) return;
    if (this.horizonFrame === frame && this.horizonLen >= len) return;
    if (this.hx0.length === 0) {
      this.hx0 = this.driftIdx.map(() => new Float64Array(0));
      this.hx1 = this.hx0.slice();
      this.hy = this.hx0.slice();
    }
    const cap = Math.max(len, 1) + 1;
    for (let n = 0; n < this.driftIdx.length; n++) {
      const d = this.defs[this.driftIdx[n]];
      if (this.hx0[n].length < cap) {
        this.hx0[n] = new Float64Array(cap);
        this.hx1[n] = new Float64Array(cap);
        this.hy[n] = new Float64Array(cap);
      }
      for (let k = 0; k < cap; k++) {
        const r = platformAt(d, frame + k);
        this.hx0[n][k] = r.x0;
        this.hx1[n][k] = r.x1;
        this.hy[n][k] = r.y;
      }
    }
    this.horizonFrame = frame;
    this.horizonLen = cap - 1;
  }

  /**
   * Put the drifting platforms where they will be `k` frames after the prepared frame (`prepareHorizon` first). The caller MUST finish with
   * `endHorizon()`; `sync` also restores. No-op without drifting platforms.
   */
  setHorizon(k: number): void {
    if (!this.drifts || this.horizonFrame < 0) return;
    const kk = k < 0 ? 0 : k > this.horizonLen ? this.horizonLen : Math.floor(k);
    if (!this.projected) {
      for (let i = 0; i < this.plats.length; i++) {
        const p = this.plats[i];
        const s = this.saved[i];
        s.x0 = p.x0;
        s.x1 = p.x1;
        s.y = p.y;
      }
      this.projected = true;
    }
    for (let n = 0; n < this.driftIdx.length; n++) {
      const p = this.plats[this.driftIdx[n]];
      p.x0 = this.hx0[n][kk];
      p.x1 = this.hx1[n][kk];
      p.y = this.hy[n][kk];
    }
  }

  /** Restore the synced platform rects after `setHorizon`. */
  endHorizon(): void {
    if (!this.projected) return;
    for (let i = 0; i < this.plats.length; i++) {
      const p = this.plats[i];
      const s = this.saved[i];
      p.x0 = s.x0;
      p.x1 = s.x1;
      p.y = s.y;
    }
    this.projected = false;
  }

  /** Where platform `i` will be `k` frames from the synced frame (a drifting platform follows its loop; others stay). */
  rectAt(i: number, k: number, out: { x0: number; x1: number; y: number }): void {
    const p = this.plats[i];
    if (this.drifts && p.moving && this.frame >= 0) {
      const r = platformAt(this.defs[i], this.frame + k);
      out.x0 = r.x0;
      out.x1 = r.x1;
      out.y = r.y;
      return;
    }
    out.x0 = p.x0;
    out.x1 = p.x1;
    out.y = p.y;
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
