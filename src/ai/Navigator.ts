/**
 * Navigator (v1.9 WP-O2): one bot's path planning and path following on ELEVATED arenas (the Ocean Dome).
 *
 * `active` is false for arenas without a `heightfield` (colosseum, jungle) and then every method returns immediately, so those arenas
 * play byte-identically to v1.8. On the Ocean the brain keeps its normal straight-line steering whenever the straight line is not
 * blocked by TERRAIN (a cliff, or a ledge it does not want to drop off); when terrain is in the way, {@link steer} plans an A* path
 * over the {@link NavGrid} and replaces the heading with the next smoothed waypoint:
 *
 *  - ramps are entered along their middle (the grid penalises cells beside cliffs and ledges);
 *  - string-pulling: the waypoint is the farthest path cell the bot can walk to in a straight line from where it stands;
 *  - the plan is refreshed when the goal moves, on a timer, when the bot strays off the path, or when it stops making progress;
 *  - drops (walking off a ledge) are planned only when the mode and the bot's health allow them.
 *
 * Difficulty ({@link NAV_AI}): L1 re-plans late, plans with no safety margin (it bumps cliff corners) and follows the raw cells; L2
 * smooths with a small margin; L3/L4 re-plan fast, keep a clear margin, drop deliberately only when healthy, and prefer fights on their
 * own level ({@link Navigator.crossPenalty}).
 */

import type { ArenaDef } from '../config/arenas';
import { arenaGroundHeight } from '../config/arenas';
import type { Difficulty } from '../core/types';
import {
  EDGE_DROP,
  EDGE_JUMP,
  LINE_BLOCKED,
  LINE_OK,
  cellOf,
  cellX,
  cellZ,
  getNavGrid,
  lineWalk,
  nearestWalkCell,
  NavSearch,
  type NavGrid,
} from './NavGrid';
import { setDir, type Move2 } from './Steering';

export type NavMode = 'engage' | 'goto' | 'flee';

export interface NavAiLevel {
  /** Seconds between re-plans while a path is followed (late re-plans = a bot that is slow to notice the target moved). */
  replanS: number;
  /** Extra clearance (m) planned around cliffs and solids, on top of the body radius. */
  margin: number;
  /** String-pull the path (false: follow the raw cells, a few ahead). */
  smooth: boolean;
  /** Path metres considered for the waypoint (smooth) / cells ahead (raw). */
  lookahead: number;
  /** Health fraction above which the bot walks off a ledge deliberately while engaging (> 1 = never). */
  dropMinHp: number;
  /** Scale of the cross-level penalty in target scoring (0 = ignores levels). */
  levelBias: number;
  /** v1.10: how much nearer a pad on the upper tier (the Ocean's towers) counts when collecting pickups (0 = no pull, 0.3 = 30 % nearer). */
  upperPull: number;
}

export const NAV_AI: Record<Difficulty, NavAiLevel> = {
  1: { replanS: 1.1, margin: 0, smooth: false, lookahead: 3, dropMinHp: 0, levelBias: 0, upperPull: 0 },
  2: { replanS: 0.6, margin: 0.15, smooth: true, lookahead: 6, dropMinHp: 0.3, levelBias: 0.4, upperPull: 0.15 },
  3: { replanS: 0.35, margin: 0.3, smooth: true, lookahead: 9, dropMinHp: 0.55, levelBias: 1, upperPull: 0.3 },
  4: { replanS: 0.25, margin: 0.3, smooth: true, lookahead: 10, dropMinHp: 0.6, levelBias: 1, upperPull: 0.35 },
};

/** Extra A* cost (m) of walking off a ledge, by mode. */
const DROP_COST: Record<NavMode, number> = { engage: 3, goto: 4, flee: 1.5 };
/** Seconds the straight-line (terrain) test is reused. */
const NEED_DT = 0.1;
/** Metres a bot must progress per second window before the path counts as stalled. */
const STALL_WINDOW_S = 0.9;
const STALL_MIN_M = 0.35;
/** Walking-distance guess (m) for one level crossing, for target scoring. */
const CROSS_LEVEL_M = 7;
/** Two heights are the same level when they differ by less than this (m). */
const SAME_LEVEL = 0.7;
/** v1.10: string-pulled shortcuts keep at least this far (m) from a deadly edge (a tower rim, the side of a tower ramp) unless the bot already stands nearer. */
const RIM_LINE_MIN = 0.9;

export class Navigator {
  /** False on flat arenas: nothing below ever runs. */
  readonly active: boolean;
  level: NavAiLevel;
  /** Set by {@link steer}: the next path edge is a jump (the brain may press jump). */
  wantJump = false;
  /** Metres of the current path (0 when none) and the straight distance to its goal at planning time. */
  pathMetres = 0;
  pathStraight = 0;
  /** True while a planned path is being followed. */
  following = false;

  private readonly arena: ArenaDef;
  private readonly radius: number;
  private grid: NavGrid | null = null;
  private gridMargin = -1;
  private fallback: NavGrid | null = null;
  private search: NavSearch | null = null;
  private searchFb: NavSearch | null = null;
  /** v1.10: the HOP grid (low arches do not block) and its search, used only when the ordinary grids have no route. */
  private hopGrid: NavGrid | null = null;
  private searchHop: NavSearch | null = null;
  /** True while the followed path was planned on the hop grid (the follower presses jump at an arch ahead). */
  private pathHop = false;
  /** Jumpable low walls of the arena (the arches), for the hop follower. */
  private readonly hurdles: { ax: number; az: number; bx: number; bz: number; r: number }[] = [];

  private planAt = -1e9;
  private planGoal = -1;
  private ptr = 0;
  private pathCells = 0;
  private path: Int32Array = new Int32Array(0);
  private planUsedDrop = false;

  private needAt = -1e9;
  private needVal = false;
  private needMode: NavMode = 'engage';
  private needDrop = false;

  private progAt = 0;
  private progX = 0;
  private progZ = 0;
  private stalledUntil = -1;

  constructor(arena: ArenaDef, bodyRadius: number, difficulty: Difficulty) {
    this.arena = arena;
    this.radius = bodyRadius;
    this.active = arena.heightfield !== undefined;
    for (const ob of arena.solids) if (ob.shape === 'segment' && ob.jumpable) this.hurdles.push({ ax: ob.ax, az: ob.az, bx: ob.bx, bz: ob.bz, r: ob.thickness * 0.5 });
    this.level = NAV_AI[difficulty];
  }

  setDifficulty(d: Difficulty): void {
    this.level = NAV_AI[d];
  }

  private gridFor(): NavGrid {
    if (this.grid === null || this.gridMargin !== this.level.margin) {
      this.grid = getNavGrid(this.arena, this.radius, this.level.margin);
      this.gridMargin = this.level.margin;
      this.search = new NavSearch(this.grid.n * this.grid.n);
      this.path = new Int32Array(0);
      this.planGoal = -1;
    }
    return this.grid;
  }

  /** Ground height under (x, z). */
  heightAt(x: number, z: number): number {
    return arenaGroundHeight(this.arena, x, z);
  }

  /** Is deliberately walking off a ledge allowed for this mode and health? */
  dropAllowed(mode: NavMode, hpFrac: number): boolean {
    if (mode === 'flee') return true;
    if (mode === 'goto') return hpFrac >= this.level.dropMinHp * 0.7;
    return hpFrac >= this.level.dropMinHp;
  }

  /**
   * Extra walking metres a target on another level is worth, for target scoring (0 on flat arenas, for the same level, and for L1).
   */
  crossPenalty(selfH: number, tx: number, tz: number): number {
    if (!this.active || this.level.levelBias <= 0) return 0;
    const dh = Math.abs(selfH - this.heightAt(tx, tz));
    if (dh < SAME_LEVEL) return 0;
    return Math.round(dh / 1.5) * CROSS_LEVEL_M * this.level.levelBias;
  }

  /** Would a straight walk from (sx, sz) to (gx, gz) run into TERRAIN (a cliff, or a ledge the mode forbids)? */
  terrainBlocked(sx: number, sz: number, gx: number, gz: number, mode: NavMode, hpFrac: number): boolean {
    if (!this.active) return false;
    return lineWalk(this.gridFor(), sx, sz, gx, gz, this.dropAllowed(mode, hpFrac), false) === LINE_BLOCKED;
  }

  /** Forget the current plan (the goal changed meaning). */
  reset(): void {
    this.planGoal = -1;
    this.pathCells = 0;
    this.following = false;
    this.needAt = -1e9;
  }

  /**
   * If a straight walk to (gx, gz) is blocked by terrain, overwrite `out` with the heading of the next waypoint of an A* path and
   * return true. Returns false (leaving `out` alone) on flat arenas, when the straight walk is fine, or when no path exists.
   */
  steer(out: Move2, now: number, sx: number, sz: number, gx: number, gz: number, mode: NavMode, hpFrac: number): boolean {
    this.wantJump = false;
    if (!this.active) return false;
    const grid = this.gridFor();
    const allowDrop = this.dropAllowed(mode, hpFrac);

    // 1. Is the terrain in the way at all? (cached for a tenth of a second)
    if (now - this.needAt >= NEED_DT || mode !== this.needMode || allowDrop !== this.needDrop) {
      this.needVal = lineWalk(grid, sx, sz, gx, gz, allowDrop, false) === LINE_BLOCKED;
      this.needAt = now;
      this.needMode = mode;
      this.needDrop = allowDrop;
    }
    if (!this.needVal) {
      this.following = false;
      this.planGoal = -1;
      return false;
    }

    // 2. Progress watch: a bot that follows a path but does not move re-plans (and widens its berth) at once.
    if (now - this.progAt >= STALL_WINDOW_S) {
      const moved = Math.hypot(sx - this.progX, sz - this.progZ);
      if (this.following && moved < STALL_MIN_M) this.stalledUntil = now + 1.5;
      this.progAt = now;
      this.progX = sx;
      this.progZ = sz;
    }

    // 3. (Re)plan.
    const goalH = this.heightAt(gx, gz);
    const goalCell = nearestWalkCell(grid, gx, gz, 6, goalH);
    if (goalCell < 0) return false;
    let replan = this.planGoal < 0 || now - this.planAt >= this.level.replanS || this.planUsedDrop !== allowDrop;
    if (!replan && goalCell !== this.planGoal) {
      const dx = cellX(grid, goalCell) - cellX(grid, this.planGoal);
      const dz = cellZ(grid, goalCell) - cellZ(grid, this.planGoal);
      if (dx * dx + dz * dz > 2.3 * 2.3 && now - this.planAt >= this.level.replanS * 0.4) replan = true;
    }
    if (!replan && this.pathCells > 0) {
      // strayed off the path?
      const near = this.nearestOnPath(grid, sx, sz);
      if (near.d > 2.2) replan = true;
    }
    // a stalled bot re-plans too (at most 4x per second)
    if (replan || (now < this.stalledUntil && now - this.planAt >= 0.25)) {
      if (!this.plan(grid, now, sx, sz, goalCell, allowDrop, mode)) {
        this.following = false;
        return false;
      }
    }
    if (this.pathCells === 0) {
      this.following = false;
      return false;
    }

    // 4. Waypoint.
    this.following = true;
    return this.waypoint(out, grid, sx, sz, gx, gz);
  }

  private plan(grid: NavGrid, now: number, sx: number, sz: number, goalCell: number, allowDrop: boolean, mode: NavMode): boolean {
    const search = this.search as NavSearch;
    const startCell = nearestWalkCell(grid, sx, sz, 4, this.heightAt(sx, sz));
    this.planAt = now;
    this.planUsedDrop = allowDrop;
    const dropExtra = allowDrop ? DROP_COST[mode] : Infinity;
    let ok = search.find(grid, startCell, goalCell, dropExtra, true);
    if (!ok && grid.margin > 0) {
      // a gap narrower than the berth: retry with the bare body
      if (this.fallback === null || this.fallback.radius !== grid.radius) this.fallback = getNavGrid(this.arena, grid.radius, 0);
      const g = this.fallback;
      const s2 = nearestWalkCell(g, sx, sz, 4, this.heightAt(sx, sz));
      const g2 = nearestWalkCell(g, cellX(grid, goalCell), cellZ(grid, goalCell), 4, grid.h[goalCell]);
      if (this.searchFb === null) this.searchFb = new NavSearch(g.n * g.n);
      ok = this.searchFb.find(g, s2, g2, dropExtra, true);
      if (ok) {
        this.adoptPath(this.searchFb);
        this.pathStraight = Math.hypot(cellX(grid, goalCell) - sx, cellZ(grid, goalCell) - sz);
        this.planGoal = goalCell;
        return true;
      }
    }
    if (!ok && this.hurdles.length > 0) {
      // shut in (a crevice closed by a low coral arch)? plan on the grid where a jump clears the arches
      if (this.hopGrid === null) this.hopGrid = getNavGrid(this.arena, grid.radius, 0, true);
      const hg = this.hopGrid;
      const s3 = nearestWalkCell(hg, sx, sz, 4, this.heightAt(sx, sz));
      const g3 = nearestWalkCell(hg, cellX(grid, goalCell), cellZ(grid, goalCell), 4, grid.h[goalCell]);
      if (this.searchHop === null) this.searchHop = new NavSearch(hg.n * hg.n);
      if (this.searchHop.find(hg, s3, g3, dropExtra, true)) {
        this.adoptPath(this.searchHop, true);
        this.pathStraight = Math.hypot(cellX(grid, goalCell) - sx, cellZ(grid, goalCell) - sz);
        this.planGoal = goalCell;
        return true;
      }
    }
    if (!ok) {
      this.pathCells = 0;
      this.planGoal = -1;
      return false;
    }
    this.adoptPath(search);
    this.pathStraight = Math.hypot(cellX(grid, goalCell) - sx, cellZ(grid, goalCell) - sz);
    this.planGoal = goalCell;
    return true;
  }

  private adoptPath(search: NavSearch, hop = false): void {
    this.pathHop = hop;
    // cell indices are valid on every grid of the arena (same cell size/origin/heights, only walkability differs)
    if (this.path.length < search.pathLen) this.path = new Int32Array(search.pathLen * 2);
    for (let i = 0; i < search.pathLen; i++) this.path[i] = search.path[i];
    this.pathCells = search.pathLen;
    this.pathMetres = search.pathMetres;
    this.ptr = 0;
  }

  private nearestOnPath(grid: NavGrid, sx: number, sz: number): { i: number; d: number } {
    let bi = this.ptr;
    let bd = Infinity;
    const lo = Math.max(0, this.ptr - 2);
    const hi = Math.min(this.pathCells - 1, this.ptr + 14);
    for (let i = lo; i <= hi; i++) {
      const c = this.path[i];
      const d = Math.hypot(cellX(grid, c) - sx, cellZ(grid, c) - sz);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    return { i: bi, d: bd };
  }

  private waypoint(out: Move2, grid: NavGrid, sx: number, sz: number, gx: number, gz: number): boolean {
    // advance the pointer to the path cell nearest ahead
    const near = this.nearestOnPath(grid, sx, sz);
    if (near.i > this.ptr) this.ptr = near.i;
    while (this.ptr + 1 < this.pathCells && Math.hypot(cellX(grid, this.path[this.ptr]) - sx, cellZ(grid, this.path[this.ptr]) - sz) < 0.7) this.ptr++;
    const last = this.pathCells - 1;
    if (this.ptr >= last) {
      // on the final cell: head for the exact goal
      setDir(out, gx - sx, gz - sz);
      return true;
    }
    let pick = Math.min(last, this.ptr + 1);
    if (!this.level.smooth) {
      pick = Math.min(last, this.ptr + Math.max(1, Math.round(this.level.lookahead)));
      // never past a drop / jump edge (those are taken one cell at a time)
      for (let k = this.ptr; k < pick; k++) {
        if (this.edgeKind(grid, k) !== 0) {
          pick = k + 1;
          break;
        }
      }
    } else {
      let metres = 0;
      for (let k = this.ptr + 1; k <= last; k++) {
        const kind = this.edgeKind(grid, k - 1);
        const ex = cellX(grid, this.path[k]) - cellX(grid, this.path[k - 1]);
        const ez = cellZ(grid, this.path[k]) - cellZ(grid, this.path[k - 1]);
        metres += Math.sqrt(ex * ex + ez * ez);
        if (kind !== 0) {
          // ledge or jump: stop at the far side of it (the bot walks off / hops there in a straight line) - but only once it stands at
          // the edge's top; from afar it walks to the top cell first (a straight line to the far side would leave a ramp by its side
          // many metres higher up: v1.10, where that is a fall)
          const tx = cellX(grid, this.path[k - 1]);
          const tz = cellZ(grid, this.path[k - 1]);
          if (k - 1 > this.ptr && Math.hypot(tx - sx, tz - sz) > 1.1) break;
          pick = k;
          break;
        }
        if (metres > this.level.lookahead) break;
        const cx = cellX(grid, this.path[k]);
        const cz = cellZ(grid, this.path[k]);
        if (lineWalk(grid, sx, sz, cx, cz, false, true, RIM_LINE_MIN) === LINE_OK) pick = k;
      }
      if (pick === last && lineWalk(grid, sx, sz, gx, gz, false, true, RIM_LINE_MIN) === LINE_OK) {
        setDir(out, gx - sx, gz - sz);
        return true;
      }
    }
    // a jump edge right ahead: ask for the hop once the bot stands at its foot
    const k0 = pick - 1;
    if (k0 >= this.ptr && this.edgeKind(grid, k0) === EDGE_JUMP) {
      const fx = cellX(grid, this.path[k0]);
      const fz = cellZ(grid, this.path[k0]);
      if (Math.hypot(fx - sx, fz - sz) < 1.1) this.wantJump = true;
    }
    setDir(out, cellX(grid, this.path[pick]) - sx, cellZ(grid, this.path[pick]) - sz);
    if (this.pathHop && this.hurdleAhead(sx, sz, out.x, out.z)) this.wantJump = true;
    return true;
  }

  /** Is a low arch within a jump's reach right ahead along the unit heading (hx, hz)? (followers of a hop path press jump) */
  private hurdleAhead(sx: number, sz: number, hx: number, hz: number): boolean {
    for (const w of this.hurdles) {
      for (const d of [0.7, 1.3, 1.9]) {
        const px = sx + hx * d;
        const pz = sz + hz * d;
        const ex = w.bx - w.ax;
        const ez = w.bz - w.az;
        const l2 = ex * ex + ez * ez;
        const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((px - w.ax) * ex + (pz - w.az) * ez) / l2)) : 0;
        if (Math.hypot(px - (w.ax + ex * t), pz - (w.az + ez * t)) < w.r + this.radius + 0.1) return true;
      }
    }
    return false;
  }

  /** Kind of the path edge from cell index k to k+1 (0 walk, EDGE_DROP, EDGE_JUMP), read from the heights. */
  private edgeKind(grid: NavGrid, k: number): number {
    if (k + 1 >= this.pathCells) return 0;
    const dh = grid.h[this.path[k + 1]] - grid.h[this.path[k]];
    if (dh < -0.45) return EDGE_DROP;
    if (dh > 0.6) return EDGE_JUMP;
    return 0;
  }

  /**
   * A point to run to when fleeing `(tx, tz)` from `(sx, sz)`: among the cells reachable within ~14 m, the one that keeps the most
   * distance from the threat (path distance counted against it), as a world point; null on flat arenas or when nothing is reachable.
   */
  fleePoint(sx: number, sz: number, tx: number, tz: number, out: Move2): boolean {
    if (!this.active) return false;
    const grid = this.gridFor();
    const s = nearestWalkCell(grid, sx, sz, 4, this.heightAt(sx, sz));
    if (s < 0) return false;
    // coarse radial scan: 24 candidate points at 7-11 m from the bot, scored by their distance from the threat
    let best = -1;
    let bestScore = -Infinity;
    for (let a = 0; a < 24; a++) {
      const ang = (a / 24) * Math.PI * 2;
      for (let r = 7; r <= 11; r += 4) {
        const px = sx + Math.cos(ang) * r;
        const pz = sz + Math.sin(ang) * r;
        const c = nearestWalkCell(grid, px, pz, 2, undefined);
        if (c < 0) continue;
        const cx = cellX(grid, c);
        const cz = cellZ(grid, c);
        if (Math.hypot(cx - px, cz - pz) > 1.6) continue;
        const sc = Math.hypot(cx - tx, cz - tz) - 0.4 * Math.hypot(cx - sx, cz - sz);
        if (sc > bestScore && lineWalk(grid, sx, sz, cx, cz, true, false) !== LINE_BLOCKED) {
          bestScore = sc;
          best = c;
        }
      }
    }
    if (best < 0) return false;
    setDir(out, cellX(grid, best) - sx, cellZ(grid, best) - sz);
    return true;
  }

  /** Cell lookup passthrough for tests. */
  cellAt(x: number, z: number): number {
    return cellOf(this.gridFor(), x, z);
  }
}

