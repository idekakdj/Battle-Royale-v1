/**
 * Champions League bots — move knowledge derived from the move data (no simulation).
 *
 * A bot may know every animal's move data the way a veteran knows a character: frame data,
 * reach, damage, launch. `MoveInfo` precomputes, per (animal, move, air, chain), the hitboxes in
 * attacker-local space for every active frame (path + the attacker's own motion included) so the
 * planner can ask "would this connect on a target at (relX, relY) if I start it now?" cheaply.
 * Everything is cached at module level and shared by all bots.
 */

import type { AnimalId } from '../../core/types';
import type { CharacterStats, HitboxDef, MoveBody, MoveId } from '../types';
import { MOVE_IDS } from '../types';
import { getMoveBody, MOVESETS } from '../data';
import { bodyKillPercent } from '../data/analysis';

const DT = 1 / 60;
const GRAV = 38;

/** One hitbox at one move frame, in attacker-local space (x forward, y up from the feet). */
export interface FrameBox {
  circle: boolean;
  cx: number;
  cy: number;
  r: number;
  hw: number;
  hh: number;
  hb: HitboxDef;
  /** Sweetspot centre / radius at this frame (r = 0 when none). */
  sx: number;
  sy: number;
  sr: number;
}

export interface MoveInfo {
  animal: AnimalId;
  id: MoveId;
  air: boolean;
  chain: number;
  body: MoveBody;
  startup: number;
  active: number;
  recovery: number;
  total: number;
  /** First frame any hitbox is active, and one past the last. */
  first: number;
  last: number;
  /** Boxes per frame, index = frame − first. */
  frames: FrameBox[][];
  /** The attacker's own displacement (forward-relative m) at the end of each move frame, index 0..total. */
  dispX: Float32Array;
  dispY: Float32Array;
  /** Forward extent / backward extent (positive = behind) / top / bottom of everything it can hit (m from the feet). */
  maxReach: number;
  backReach: number;
  top: number;
  bottom: number;
  /** Hits both sides (a box centred behind the fighter). */
  twoSided: boolean;
  /** Damage one victim can take (no sweetspot / with). */
  damage: number;
  damageMax: number;
  /** Best hitbox (highest damage) — the launch used for kill estimates. */
  main: HitboxDef;
  hasSpike: boolean;
  /** Travels (lunge/charge): forward displacement of the attacker at the end of the motion. */
  travelX: number;
  travelY: number;
  armor: { from: number; to: number } | null;
  invuln: { from: number; to: number } | null;
  /** v1.6 burrow: the underground window (untouchable, hits bypass it) of a ground move, and whether its travel stops at the platform end. */
  burrow: { from: number; to: number } | null;
  stopsAtEdge: boolean;
  /** Light-neutral string links: the cancel windows of this body. */
  cancels: NonNullable<MoveBody['cancels']>;
  /** Frames after the last active frame (the punishable endlag). */
  endlag: number;
  /** Rough launch power of the main hitbox at 100 % on a 100-weight victim (m/s). */
  power100: number;
}

const cache = new Map<string, MoveInfo>();

function sweepDisp(body: MoveBody, air: boolean, gm: number): { x: Float32Array; y: Float32Array } {
  const total = body.startup + body.active + body.recovery;
  const dx = new Float32Array(total + 1);
  const dy = new Float32Array(total + 1);
  let x = 0;
  let y = 0;
  let vx = 0;
  let vy = 0;
  let grounded = !air;
  for (let mf = 0; mf < total; mf++) {
    let g = 1;
    let setX = false;
    if (body.motion) {
      for (const m of body.motion) {
        if (mf < m.from || mf >= m.to) continue;
        if (m.set) {
          if (m.vx !== undefined) {
            vx = m.vx;
            setX = true;
          }
          if (m.vy !== undefined) vy = m.vy;
        } else {
          if (m.vx !== undefined) {
            vx += m.vx;
            setX = true;
          }
          if (m.vy !== undefined) vy += m.vy;
        }
        if (m.gravity !== undefined) g = m.gravity;
      }
    }
    if (grounded) {
      if (!setX) vx *= 0.8;
      // surfacing from a burrow: the sim stops the fighter dead (no slide)
      if (!air && body.burrow && mf === body.burrow.to) vx = 0;
      if (vy > 0) grounded = false;
    } else if (!setX) {
      vx *= 0.99;
    }
    if (!grounded) vy -= GRAV * gm * g * DT;
    x += vx * DT;
    y += vy * DT;
    if (!air && !grounded && y <= 0 && vy <= 0) {
      y = 0;
      vy = 0;
      grounded = true;
    }
    dx[mf] = x;
    dy[mf] = y;
  }
  dx[total] = x;
  dy[total] = y;
  return { x: dx, y: dy };
}

function pathAt(hb: HitboxDef, mf: number, out: { x: number; y: number }): void {
  out.x = 0;
  out.y = 0;
  const path = hb.path;
  if (!path || path.length === 0) return;
  if (mf <= path[0].frame) {
    out.x = path[0].x;
    out.y = path[0].y;
    return;
  }
  for (let i = 1; i < path.length; i++) {
    const b = path[i];
    if (mf <= b.frame) {
      const a = path[i - 1];
      const span = b.frame - a.frame;
      const t = span > 0 ? (mf - a.frame) / span : 1;
      out.x = a.x + (b.x - a.x) * t;
      out.y = a.y + (b.y - a.y) * t;
      return;
    }
  }
  const last = path[path.length - 1];
  out.x = last.x;
  out.y = last.y;
}

function build(animal: AnimalId, id: MoveId, air: boolean, chain: number): MoveInfo {
  const body = getMoveBody(animal, id, air, chain);
  const stats = MOVESETS[animal].stats;
  const total = body.startup + body.active + body.recovery;
  const disp = sweepDisp(body, air, stats.gravityMult);
  let first = Infinity;
  let last = 0;
  for (const h of body.hitboxes) {
    first = Math.min(first, h.from);
    last = Math.max(last, h.to);
  }
  if (!Number.isFinite(first)) {
    first = body.startup;
    last = body.startup + body.active;
  }
  const frames: FrameBox[][] = [];
  const off = { x: 0, y: 0 };
  let maxReach = 0;
  let backReach = 0;
  let top = 0;
  let bottom = 0;
  let twoSided = false;
  let main = body.hitboxes[0];
  let bestDmg = -1;
  let hasSpike = false;
  for (const h of body.hitboxes) {
    if (h.damage > bestDmg) {
      bestDmg = h.damage;
      main = h;
    }
    if (h.effect === 'spike') hasSpike = true;
    if (h.x < -0.2) twoSided = true;
  }
  for (let mf = first; mf < last; mf++) {
    const row: FrameBox[] = [];
    for (const h of body.hitboxes) {
      if (mf < h.from || mf >= h.to) continue;
      pathAt(h, mf, off);
      const dxm = disp.x[Math.min(mf, total)];
      const dym = disp.y[Math.min(mf, total)];
      const circle = h.shape === 'circle';
      const cx = h.x + off.x + dxm;
      const cy = h.y + off.y + dym;
      const hw = circle ? h.r : h.w * 0.5;
      const hh = circle ? h.r : h.h * 0.5;
      row.push({
        circle,
        cx,
        cy,
        r: h.r,
        hw,
        hh,
        hb: h,
        sx: h.sweet ? h.sweet.x + off.x + dxm : 0,
        sy: h.sweet ? h.sweet.y + off.y + dym : 0,
        sr: h.sweet ? h.sweet.r : 0,
      });
      maxReach = Math.max(maxReach, cx + hw);
      backReach = Math.max(backReach, -(cx - hw));
      top = Math.max(top, cy + hh);
      bottom = Math.min(bottom, cy - hh);
    }
    frames.push(row);
  }
  let damage = 0;
  let damageMax = 0;
  const groups = new Map<number, { b: number; m: number }>();
  body.hitboxes.forEach((h, i) => {
    const g = h.group ?? 1000 + i;
    const n = h.multiHitInterval && h.multiHitInterval > 0 ? Math.floor((h.to - h.from - 1) / h.multiHitInterval) + 1 : 1;
    const b = h.damage * n;
    const m = b * (h.sweet ? h.sweet.damageMult : 1);
    const cur = groups.get(g);
    if (!cur) groups.set(g, { b, m });
    else {
      cur.b = Math.max(cur.b, b);
      cur.m = Math.max(cur.m, m);
    }
  });
  for (const v of groups.values()) {
    damage += v.b;
    damageMax += v.m;
  }
  return {
    animal,
    id,
    air,
    chain,
    body,
    startup: body.startup,
    active: body.active,
    recovery: body.recovery,
    total,
    first,
    last,
    frames,
    dispX: disp.x,
    dispY: disp.y,
    maxReach,
    backReach,
    top,
    bottom,
    twoSided: twoSided || backReach > 0.8 * maxReach,
    damage,
    damageMax,
    main,
    hasSpike,
    travelX: disp.x[total],
    travelY: disp.y[total],
    armor: body.armor ? { from: body.armor.from, to: body.armor.to } : null,
    invuln: body.invuln ? { from: body.invuln.from, to: body.invuln.to } : null,
    burrow: body.burrow && !air ? { from: body.burrow.from, to: body.burrow.to } : null,
    stopsAtEdge: !air && (body.motion ?? []).some((m) => m.stopAtEdge === true),
    cancels: body.cancels ?? [],
    endlag: Math.max(0, total - last),
    power100: main.baseKb + main.kbGrowth,
  };
}

/** Cached move info (chain > 0 = the follow-up bodies of a light-neutral string). */
export function moveInfo(animal: AnimalId, id: MoveId, air: boolean, chain = 0): MoveInfo {
  const key = `${animal}:${id}:${air ? 1 : 0}:${chain}`;
  let m = cache.get(key);
  if (!m) {
    m = build(animal, id, air, chain);
    cache.set(key, m);
  }
  return m;
}

// ── hit probing ──────────────────────────────────────────────────────────────

export interface Probe {
  /** Move frame of the first overlap (−1 = never). */
  frame: number;
  box: FrameBox | null;
  sweet: boolean;
}

const scratch: Probe = { frame: -1, box: null, sweet: false };

function circleRect(cx: number, cy: number, r: number, x0: number, y0: number, x1: number, y1: number): boolean {
  const nx = cx < x0 ? x0 : cx > x1 ? x1 : cx;
  const ny = cy < y0 ? y0 : cy > y1 ? y1 : cy;
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy <= r * r;
}

/**
 * Would `info` hit a target whose hurtbox is `tw × th`, its feet at (relX, relY) relative to the attacker's feet
 * (relX is positive in FRONT of the attacker), if the move starts now? The target drifts with (vx, vy) (forward-relative
 * m/s) and `ay` (m/s², vertical) over the frames. Returns the scratch probe (valid until the next call).
 * `fromFrame` skips earlier frames (e.g. when the move is already running). `room` = how far forward the attacker can still travel
 * before the end of the platform it stands on: moves with `stopAtEdge` (the mole's burrow) are clipped to it, the way the sim clamps them.
 */
export function probeHit(info: MoveInfo, relX: number, relY: number, tw: number, th: number, vx = 0, vy = 0, ay = 0, fromFrame = 0, room = Infinity): Probe {
  scratch.frame = -1;
  scratch.box = null;
  scratch.sweet = false;
  const hw = tw * 0.5;
  for (let mf = Math.max(info.first, fromFrame); mf < info.last; mf++) {
    const row = info.frames[mf - info.first];
    if (row.length === 0) continue;
    const t = mf * DT;
    const tx = relX + vx * t;
    const ty = relY + vy * t + 0.5 * ay * t * t;
    const x0 = tx - hw;
    const x1 = tx + hw;
    const y0 = ty;
    const y1 = ty + th;
    let bestDmg = -1;
    let best: FrameBox | null = null;
    // travel the platform edge takes away from this frame's boxes
    const over = info.stopsAtEdge ? info.dispX[Math.min(mf, info.total)] - room : 0;
    const clip = over > 0 ? over : 0;
    for (const b of row) {
      const bcx = b.cx - clip;
      const hit = b.circle
        ? circleRect(bcx, b.cy, b.r, x0, y0, x1, y1)
        : bcx + b.hw >= x0 && bcx - b.hw <= x1 && b.cy + b.hh >= y0 && b.cy - b.hh <= y1;
      if (hit && b.hb.damage > bestDmg) {
        bestDmg = b.hb.damage;
        best = b;
      }
    }
    if (best) {
      scratch.frame = mf;
      scratch.box = best;
      if (best.sr > 0) {
        const dx = tx - (best.sx - clip);
        const dy = ty + th * 0.5 - best.sy;
        scratch.sweet = dx * dx + dy * dy <= best.sr * best.sr;
      }
      return scratch;
    }
  }
  return scratch;
}

// ── per-animal summary ───────────────────────────────────────────────────────

export interface AnimalInfo {
  animal: AnimalId;
  stats: CharacterStats;
  /** Longest forward reach of any ground move / of the light moves (the fast pokes). */
  reachAll: number;
  reachLight: number;
  /** Fastest startup among the light moves and the heavy moves. */
  fastestLight: number;
  fastestHeavy: number;
  /** Heavy-Up recovery: peak height gained, forward travel and total frames of the air form. */
  recPeak: number;
  recDx: number;
  recFrames: number;
}

const animalCache = new Map<AnimalId, AnimalInfo>();

export function animalInfo(animal: AnimalId): AnimalInfo {
  let a = animalCache.get(animal);
  if (a) return a;
  const set = MOVESETS[animal];
  let reachAll = 0;
  let reachLight = 0;
  let fastestLight = 99;
  let fastestHeavy = 99;
  for (const id of MOVE_IDS) {
    if (id === 'heavyU') continue;
    const m = moveInfo(animal, id, false);
    reachAll = Math.max(reachAll, m.maxReach);
    if (id.startsWith('light')) {
      reachLight = Math.max(reachLight, m.maxReach);
      fastestLight = Math.min(fastestLight, m.first);
    } else fastestHeavy = Math.min(fastestHeavy, m.first);
  }
  const rec = moveInfo(animal, 'heavyU', true);
  // peak/dx of the recovery from the displacement sweep (rest start, no steering)
  const t = rec.total;
  const disp = sweepDisp(rec.body, true, set.stats.gravityMult);
  let peak = 0;
  for (let i = 0; i <= t; i++) peak = Math.max(peak, disp.y[i]);
  a = { animal, stats: set.stats, reachAll, reachLight, fastestLight, fastestHeavy, recPeak: peak, recDx: disp.x[t], recFrames: t };
  animalCache.set(animal, a);
  return a;
}

/** Data-level kill percent of a move on a victim of `weight` (Infinity = never kills on its own). */
export function killPctOf(info: MoveInfo, weight: number): number {
  return bodyKillPercent(info.body, weight);
}

// ── platform probing (v1.6 breakables) ───────────────────────────────────────

/**
 * Would a DAMAGING hitbox of `info` overlap the axis-aligned rect `[rx0, rx1] × [ry0, ry1]` (attacker-local coordinates: x forward,
 * y up from the feet) at some active frame, if the move starts now? This is the sim's breakable-platform count test (the caller passes
 * the platform rect already expanded by `PHYS.platHitPad`). Returns the first move frame of the overlap, or −1.
 */
export function probeRect(info: MoveInfo, rx0: number, rx1: number, ry0: number, ry1: number, fromFrame = 0): number {
  for (let mf = Math.max(info.first, fromFrame); mf < info.last; mf++) {
    const row = info.frames[mf - info.first];
    for (const b of row) {
      if (!(b.hb.damage > 0)) continue;
      const hit = b.circle
        ? circleRect(b.cx, b.cy, b.r, rx0, ry0, rx1, ry1)
        : b.cx + b.hw >= rx0 && b.cx - b.hw <= rx1 && b.cy + b.hh >= ry0 && b.cy - b.hh <= ry1;
      if (hit) return mf;
    }
  }
  return -1;
}
