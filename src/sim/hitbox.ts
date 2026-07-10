/**
 * Geometry queries for melee arcs, cones, circles and facing tests (BLUEPRINT
 * §7.1 backstab/block arcs, §7.3 melee arc). Pure functions over {@link Fighter}
 * positions/yaw — no allocation, no state. Yaw convention matches core/math:
 * yaw 0 looks toward +Z, increasing toward +X (see {@link dirToYaw}).
 */

import type { Fighter } from './Fighter';
import { DEG2RAD, angleDelta, dirToYaw } from '../core/math';

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
 * Melee arc hit test (BLUEPRINT §7.3): centre distance ≤ range, |angle from
 * attacker yaw| ≤ arc/2, |Δy| ≤ heightTol, target targetable. Distances are
 * centre-to-centre exactly as the spec states (no radius padding).
 */
export function meleeArcHit(att: Fighter, tgt: Fighter, range: number, arcDeg: number, heightTol: number): boolean {
  if (!isTargetable(tgt)) return false;
  const dx = tgt.state.pos.x - att.state.pos.x;
  const dz = tgt.state.pos.z - att.state.pos.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist > range) return false;
  const dirYaw = dirToYaw(dx, dz);
  if (Math.abs(angleDelta(att.state.yaw, dirYaw)) > (arcDeg * DEG2RAD) / 2) return false;
  if (Math.abs(tgt.state.pos.y - att.state.pos.y) > heightTol) return false;
  return true;
}

/**
 * Cone hit test from an explicit origin/yaw (ability cones). Unlike the basic
 * melee test, ability AoEs pad the reach by the target's body radius so large
 * fighters can't slip a cone edge (minor DEVIATION, documented in report).
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
  const dx = tgt.state.pos.x - cx;
  const dz = tgt.state.pos.z - cz;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist > range + tgt.def.radius) return false;
  if (Math.abs(tgt.state.pos.y - cy) > heightTol) return false;
  if (arcDeg >= 360) return true;
  const dirYaw = dirToYaw(dx, dz);
  return Math.abs(angleDelta(yaw, dirYaw)) <= (arcDeg * DEG2RAD) / 2;
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
