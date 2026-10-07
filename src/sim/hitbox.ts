/**
 * Geometry queries for melee arcs, cones, circles and facing tests (BLUEPRINT
 * §7.1 backstab/block arcs, §7.3 melee arc). Pure functions over {@link Fighter}
 * positions/yaw — no allocation, no state. Yaw convention matches core/math:
 * yaw 0 looks toward +Z, increasing toward +X (see {@link dirToYaw}).
 */

import type { Fighter } from './Fighter';
import { DEG2RAD, angleDelta, dirToYaw } from '../core/math';
import { MOVE } from '../config/balance';
import { groundHeightAt } from './MovementSystem';

/** Metres above the ground (dais-aware) under the fighter. */
export function altitudeOf(f: Fighter): number {
  return f.state.pos.y - groundHeightAt(f.state.pos.x, f.state.pos.z, f.arena);
}

/**
 * v1.2: ground-level area attacks only reach fighters at or below
 * {@link MOVE.groundHitMaxAltitude} (a soaring eagle is out of reach).
 */
export function withinGroundReach(f: Fighter): boolean {
  return altitudeOf(f) <= MOVE.groundHitMaxAltitude;
}

/** Targetable AND low enough for a ground-level area attack / charge contact. */
export function isGroundTargetable(f: Fighter): boolean {
  return f.state.alive && !f.untargetable && withinGroundReach(f);
}

/** Horizontal (XZ) distance between two points. */
export function horizDist(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * A fighter can be targeted by hits iff it is alive and not in an untargetable
 * phase (mole burrowed, eagle Death-From-Above soar). BLUEPRINT §7.3/§7.8.
 */
export function isTargetable(f: Fighter): boolean {
  return f.state.alive && !f.untargetable;
}

/** True if the attacker at (ax,az) lies within `target`'s frontal `arcDeg` cone. */
export function inFrontArc(target: Fighter, ax: number, az: number, arcDeg: number): boolean {
  const dirYaw = dirToYaw(ax - target.state.pos.x, az - target.state.pos.z);
  return Math.abs(angleDelta(target.state.yaw, dirYaw)) <= (arcDeg * DEG2RAD) / 2;
}

/** True if the attacker at (ax,az) lies within `target`'s rear `arcDeg` cone (backstab). */
export function isBehind(target: Fighter, ax: number, az: number, arcDeg: number): boolean {
  const dirYaw = dirToYaw(ax - target.state.pos.x, az - target.state.pos.z);
  const rear = target.state.yaw + Math.PI;
  return Math.abs(angleDelta(rear, dirYaw)) <= (arcDeg * DEG2RAD) / 2;
}

/**
 * v1.2 sector–circle overlap ("what you see is what you hit"): does a body
 * circle of radius `r` centred at (tx,tz) overlap the sector at (ax,az) facing
 * `yaw` with radius `range` and full angle `arcDeg`? Reach is padded by the
 * body radius and the angular edge by `asin(min(1, r / dist))`, so any body
 * that visibly pokes into the drawn sector is hit; a body overlapping the
 * sector's apex (dist ≤ r) always counts.
 */
export function sectorCircleOverlap(
  ax: number,
  az: number,
  yaw: number,
  range: number,
  arcDeg: number,
  tx: number,
  tz: number,
  r: number,
): boolean {
  const dx = tx - ax;
  const dz = tz - az;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist - r > range) return false;
  if (dist <= r || arcDeg >= 360) return true;
  const pad = Math.asin(Math.min(1, r / dist));
  return Math.abs(angleDelta(yaw, dirToYaw(dx, dz))) <= (arcDeg * DEG2RAD) / 2 + pad;
}

/**
 * Melee arc hit test (BLUEPRINT §7.3, v1.2): the attacker's sector (range,
 * arc) overlaps the target's body circle (see {@link sectorCircleOverlap}),
 * |Δy| ≤ heightTol, target targetable. `range` is measured from the
 * attacker's centre to the nearest point of the target's body.
 */
export function meleeArcHit(att: Fighter, tgt: Fighter, range: number, arcDeg: number, heightTol: number): boolean {
  if (!isTargetable(tgt)) return false;
  if (Math.abs(tgt.state.pos.y - att.state.pos.y) > heightTol) return false;
  return sectorCircleOverlap(
    att.state.pos.x,
    att.state.pos.z,
    att.state.yaw,
    range,
    arcDeg,
    tgt.state.pos.x,
    tgt.state.pos.z,
    tgt.def.radius,
  );
}

/**
 * Cone hit test from an explicit origin/yaw (ability cones). Same sector–circle
 * overlap as the basic melee test: reach AND angular edge are padded by the
 * target's body radius so the drawn cone and the hits agree.
 */
export function coneHit(
  cx: number,
  cz: number,
  cy: number,
  yaw: number,
  range: number,
  arcDeg: number,
  tgt: Fighter,
  heightTol: number,
): boolean {
  if (!isTargetable(tgt)) return false;
  if (Math.abs(tgt.state.pos.y - cy) > heightTol) return false;
  return sectorCircleOverlap(cx, cz, yaw, range, arcDeg, tgt.state.pos.x, tgt.state.pos.z, tgt.def.radius);
}

/** Circle/radius hit test (ability AoEs & splash). Pads by target radius. */
export function circleHit(cx: number, cz: number, cy: number, radius: number, tgt: Fighter, heightTol: number): boolean {
  if (!isTargetable(tgt)) return false;
  const dx = tgt.state.pos.x - cx;
  const dz = tgt.state.pos.z - cz;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist > radius + tgt.def.radius) return false;
  return Math.abs(tgt.state.pos.y - cy) <= heightTol;
}
