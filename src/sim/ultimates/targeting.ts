/**
 * Ultimate targeting (v1.3 plan §2) — ONE pure implementation shared by the sim
 * (authoritative resolution at cast), the bot AI (validity / target choice) and
 * the HUD (ready-state preview). Everything here works on plain
 * {@link FighterState} (what a snapshot carries), so the renderer can preview
 * without touching the sim; the sim just feeds it its fighters' states and a
 * precise "untargetable" predicate.
 *
 * Kinds (see {@link UltTargeting}):
 *  - lock:   alive, targetable, ground-reachable (unless `hitsAir`) foe whose body
 *            lies within `range` and inside a `coneDeg` cone (default 70°) around the
 *            aim yaw. Best = smallest angle to the aim, then nearest, then lowest id.
 *  - line:   straight path along the aim yaw (`range` long, `width` wide, clipped at
 *            the arena wall). With `coneDeg` (or `requireTarget`) it is lock-assisted:
 *            the path ends on the best lock candidate.
 *  - ground: point along the aim yaw at most `range` away; snaps onto the nearest foe
 *            lying on the aim line (identical maths to `aimPointDist`); zone `radius`.
 *  - self:   nothing to aim.
 *
 * FIZZLE rule (enforced by `startUlt`): when `targeting.requireTarget` is set and
 * the preview is not `valid`, the cast does not start, charge is NOT spent, and an
 * `ultimateFizzle` event is emitted.
 */

import type { UltTargeting } from '../../config/animals';
import { ANIMALS } from '../../config/animals';
import type { FighterState, UltTargetKind, Vec3 } from '../../core/types';
import type { Fighter, Sim } from '../Fighter';
import { angleDelta, dirToYaw } from '../../core/math';
import { MOVE } from '../../config/balance';
import type { ArenaDef } from '../../config/arenas';
import { COLOSSEUM_ARENA } from '../../config/arenas';
import { groundHeightAt } from '../MovementSystem';
import { sectorCircleOverlap } from '../hitbox';
import { AIM_SNAP_LATERAL, AIM_SNAP_SLACK, AIM_SNAP_MIN } from '../simTuning';

export type { UltTargeting };

/** Default lock cone (full angle, degrees) when a lock spec omits `coneDeg`. */
export const DEFAULT_LOCK_CONE_DEG = 70;

/** Angles closer than this (rad) count as a tie (then nearest, then lowest id wins). */
const ANGLE_EPS = 1e-4;
const DIST_EPS = 1e-6;
/** Keep resolved ground points / line ends this far inside the wall (m). */
const ARENA_MARGIN = 0.5;

/** What a target resolution reports (mirrors the `ultimateTarget` event payload). */
export interface UltPreview {
  kind: UltTargetKind;
  /** false = the cast would fizzle when the spec has `requireTarget` (lock: no candidate). */
  valid: boolean;
  /** Locked / snapped foe id, -1 when none. */
  targetId: number;
  /** Path start (the caster). */
  from: Vec3;
  /** Path end: victim position (lock), line end, ground zone centre, or the caster (self). */
  to: Vec3;
  range: number;
  /** line: path width; ground/self: zone diameter (radius × 2); lock: 0. */
  width: number;
}

export interface TargetingOpts {
  /** Aim direction (default: the attacker's facing). The sim passes `intent.aimYaw`. */
  aimYaw?: number;
  /**
   * Precise untargetable test (the sim passes `Fighter.untargetable`). Default
   * derives it from the state via {@link isStateUntargetable}.
   */
  isUntargetable?: (st: FighterState) => boolean;
  /** v1.8: the arena being played (wall radius / ground height). Default: the colosseum. The sim passes `sim.arena`. */
  arena?: ArenaDef;
}

// ── State helpers ────────────────────────────────────────────────────────────

/** Metres above the (dais-aware) ground under a state's position. */
export function stateAltitude(st: FighterState, arena: ArenaDef = COLOSSEUM_ARENA): number {
  return st.pos.y - groundHeightAt(st.pos.x, st.pos.z, arena);
}

/** Body radius (m) of a state's animal. */
export function stateRadius(st: FighterState): number {
  return ANIMALS[st.animal].radius;
}

/**
 * Best-effort "cannot be targeted" derived from a plain state: burrowed moles and
 * an eagle in its Death-From-Above soar. (The sim overrides with the real flag.)
 */
export function isStateUntargetable(st: FighterState): boolean {
  if (st.action === 'burrowed' || st.burrowT > 0) return true;
  return st.animal === 'eagle' && st.action === 'ultimate' && st.ultPhase === 'windup';
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

/**
 * Length along the ray (x,z)+t·(dx,dz) (unit dir) before it leaves the arena
 * (radius WALL_RADIUS − margin), capped at `len`. 0 when already outside.
 */
export function clipRayToArena(
  x: number,
  z: number,
  dx: number,
  dz: number,
  len: number,
  margin = ARENA_MARGIN,
  wallRadius: number = COLOSSEUM_ARENA.wallRadius,
): number {
  const R = wallRadius - margin;
  const b = x * dx + z * dz;
  const c = x * x + z * z - R * R;
  if (c > 0) return 0;
  const t = -b + Math.sqrt(b * b - c);
  return Math.max(0, Math.min(len, t));
}

/** End point of a `range`-long aim line from the attacker, clipped at the arena wall. */
export function lineEndPoint(attacker: FighterState, aimYaw: number, range: number, arena: ArenaDef = COLOSSEUM_ARENA): Vec3 {
  const dx = Math.sin(aimYaw);
  const dz = Math.cos(aimYaw);
  const len = clipRayToArena(attacker.pos.x, attacker.pos.z, dx, dz, range, ARENA_MARGIN, arena.wallRadius);
  const x = attacker.pos.x + dx * len;
  const z = attacker.pos.z + dz * len;
  return { x, y: groundHeightAt(x, z, arena), z };
}

/** Distance from point (px,pz) to the segment (ax,az)-(bx,bz) in the XZ plane. */
export function distToSegment2D(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax;
  const abz = bz - az;
  const len2 = abx * abx + abz * abz;
  let t = len2 > 1e-12 ? ((px - ax) * abx + (pz - az) * abz) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + abx * t;
  const cz = az + abz * t;
  const dx = px - cx;
  const dz = pz - cz;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Does a body circle (centre (tx,tz), radius r) overlap the straight path
 * from→to of full width `width`? (Ribbon test for line ultimates.)
 */
export function bodyInLine(from: Vec3, to: Vec3, width: number, tx: number, tz: number, r: number): boolean {
  return distToSegment2D(tx, tz, from.x, from.z, to.x, to.z) <= width * 0.5 + r;
}

// ── Lock selection ───────────────────────────────────────────────────────────

/**
 * Pick the lock target for `tg` (kind irrelevant — used by lock ults and by the
 * lock-assist of line ults). Returns the fighter id, or -1 when no candidate
 * qualifies. Candidates: alive, not the attacker, targetable, ground-reachable
 * unless `tg.hitsAir`, body within `tg.range` and inside the `coneDeg` cone
 * (default {@link DEFAULT_LOCK_CONE_DEG}) around the aim yaw (sector–circle
 * overlap, so bodies that visibly poke into the cone count). Best = smallest
 * angle between the aim and the direction to the target, then nearest, then
 * lowest id.
 */
export function selectLockTarget(
  attacker: FighterState,
  fighters: readonly FighterState[],
  tg: UltTargeting,
  opts: TargetingOpts = {},
): number {
  const aim = opts.aimYaw ?? attacker.yaw;
  const cone = tg.coneDeg ?? DEFAULT_LOCK_CONE_DEG;
  const untargetable = opts.isUntargetable ?? isStateUntargetable;
  const ax = attacker.pos.x;
  const az = attacker.pos.z;
  let bestId = -1;
  let bestAng = Infinity;
  let bestDist = Infinity;
  for (let i = 0; i < fighters.length; i++) {
    const t = fighters[i];
    if (t.id === attacker.id || !t.alive) continue;
    if (untargetable(t)) continue;
    if (tg.hitsAir !== true && stateAltitude(t, opts.arena) > MOVE.groundHitMaxAltitude) continue;
    const dx = t.pos.x - ax;
    const dz = t.pos.z - az;
    if (!sectorCircleOverlap(ax, az, aim, tg.range, cone, t.pos.x, t.pos.z, stateRadius(t))) continue;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const ang = dist < 1e-6 ? 0 : Math.abs(angleDelta(aim, dirToYaw(dx, dz)));
    let better = false;
    if (bestId < 0) better = true;
    else if (ang < bestAng - ANGLE_EPS) better = true;
    else if (ang <= bestAng + ANGLE_EPS) {
      if (dist < bestDist - DIST_EPS) better = true;
      else if (Math.abs(dist - bestDist) <= DIST_EPS && t.id < bestId) better = true;
    }
    if (better) {
      bestId = t.id;
      bestAng = ang;
      bestDist = dist;
    }
  }
  return bestId;
}

// ── Ground point ─────────────────────────────────────────────────────────────

export interface GroundPoint {
  /** Distance along the aim yaw (identical to `aimPointDist`). */
  dist: number;
  /** Zone centre (clipped inside the arena wall). */
  x: number;
  z: number;
  /** Foe the point snapped onto, -1 when it sits at max range. */
  snappedId: number;
}

/**
 * The v1.1 aimed-point rule on plain states (same maths as `aimPointDist`): the
 * point lands on the nearest targetable foe lying on the aim line (within
 * AIM_SNAP_LATERAL m + its radius of the ray, at most `range` + AIM_SNAP_SLACK
 * away), else at max range. Never snaps onto a soaring eagle unless `hitsAir`.
 */
export function resolveGroundPoint(
  attacker: FighterState,
  fighters: readonly FighterState[],
  tg: UltTargeting,
  opts: TargetingOpts = {},
): GroundPoint {
  const aim = opts.aimYaw ?? attacker.yaw;
  const untargetable = opts.isUntargetable ?? isStateUntargetable;
  const dx = Math.sin(aim);
  const dz = Math.cos(aim);
  const maxRange = tg.range;
  let best = maxRange;
  let found = false;
  let snappedId = -1;
  for (let i = 0; i < fighters.length; i++) {
    const t = fighters[i];
    if (t.id === attacker.id || !t.alive || untargetable(t)) continue;
    if (tg.hitsAir !== true && stateAltitude(t, opts.arena) > MOVE.groundHitMaxAltitude) continue;
    const rx = t.pos.x - attacker.pos.x;
    const rz = t.pos.z - attacker.pos.z;
    const along = rx * dx + rz * dz;
    if (along <= 0 || along > maxRange + AIM_SNAP_SLACK) continue;
    const lateral = Math.abs(rx * dz - rz * dx);
    if (lateral > AIM_SNAP_LATERAL + stateRadius(t)) continue;
    if (!found || along < best) {
      best = along;
      found = true;
      snappedId = t.id;
    }
  }
  const dist = found ? Math.min(maxRange, Math.max(AIM_SNAP_MIN, best)) : maxRange;
  const len = clipRayToArena(attacker.pos.x, attacker.pos.z, dx, dz, dist, ARENA_MARGIN, (opts.arena ?? COLOSSEUM_ARENA).wallRadius);
  return { dist, x: attacker.pos.x + dx * len, z: attacker.pos.z + dz * len, snappedId };
}

// ── Preview / resolution ─────────────────────────────────────────────────────

function copy(p: Vec3): Vec3 {
  return { x: p.x, y: p.y, z: p.z };
}

/**
 * Resolve what an ultimate with `spec.targeting` would target right now. Works on
 * plain states; usable from the renderer/HUD (pass the locked/aimed direction as
 * `opts.aimYaw`) and, with `opts.isUntargetable`, by the sim itself. A spec without
 * a `targeting` block resolves as `self`.
 */
export function previewUltTarget(
  spec: { targeting?: UltTargeting },
  attacker: FighterState,
  fighters: readonly FighterState[],
  opts: TargetingOpts = {},
): UltPreview {
  const tg = spec.targeting;
  const from = copy(attacker.pos);
  if (tg === undefined || tg.kind === 'self') {
    return { kind: 'self', valid: true, targetId: -1, from, to: copy(from), range: tg?.range ?? 0, width: (tg?.radius ?? 0) * 2 };
  }
  const aim = opts.aimYaw ?? attacker.yaw;

  if (tg.kind === 'lock') {
    const id = selectLockTarget(attacker, fighters, tg, opts);
    if (id >= 0) {
      const t = fighters[indexOfId(fighters, id)];
      return { kind: 'lock', valid: true, targetId: id, from, to: copy(t.pos), range: tg.range, width: 0 };
    }
    return { kind: 'lock', valid: false, targetId: -1, from, to: lineEndPoint(attacker, aim, tg.range, opts.arena), range: tg.range, width: 0 };
  }

  if (tg.kind === 'line') {
    const assist = tg.coneDeg !== undefined || tg.requireTarget === true;
    const id = assist ? selectLockTarget(attacker, fighters, tg, opts) : -1;
    const width = tg.width ?? 0;
    if (id >= 0) {
      const t = fighters[indexOfId(fighters, id)];
      return { kind: 'line', valid: true, targetId: id, from, to: copy(t.pos), range: tg.range, width };
    }
    return {
      kind: 'line',
      valid: tg.requireTarget !== true,
      targetId: -1,
      from,
      to: lineEndPoint(attacker, aim, tg.range, opts.arena),
      range: tg.range,
      width,
    };
  }

  // ground
  const gp = resolveGroundPoint(attacker, fighters, tg, opts);
  return {
    kind: 'ground',
    valid: tg.requireTarget !== true || gp.snappedId >= 0,
    targetId: gp.snappedId,
    from,
    to: { x: gp.x, y: groundHeightAt(gp.x, gp.z, opts.arena ?? COLOSSEUM_ARENA), z: gp.z },
    range: tg.range,
    width: (tg.radius ?? 0) * 2,
  };
}

function indexOfId(fighters: readonly FighterState[], id: number): number {
  const guess = fighters[id];
  if (guess !== undefined && guess.id === id) return id;
  for (let i = 0; i < fighters.length; i++) if (fighters[i].id === id) return i;
  return 0;
}

// ── Sim-side resolution ──────────────────────────────────────────────────────

const SCRATCH_STATES: FighterState[] = [];

/**
 * Authoritative cast-time resolution: {@link previewUltTarget} over the sim's
 * fighters, aimed along the caster's `intent.aimYaw`, using the real
 * `Fighter.untargetable` flag. Allocation-light (reuses one scratch array).
 */
export function resolveUltTarget(sim: Sim, f: Fighter, spec: { targeting?: UltTargeting }): UltPreview {
  const n = sim.fighters.length;
  SCRATCH_STATES.length = n;
  for (let i = 0; i < n; i++) SCRATCH_STATES[i] = sim.fighters[i].state;
  return previewUltTarget(spec, f.state, SCRATCH_STATES, {
    aimYaw: f.intent.aimYaw,
    arena: sim.arena,
    isUntargetable: (st) => {
      const t = sim.fighters[st.id];
      return t !== undefined ? t.untargetable : isStateUntargetable(st);
    },
  });
}
