/**
 * Helpers shared by the per-animal first-person ultimate directives (v1.3 Phase-3c).
 */

import { clampNum } from '../math';
import { type UltCtx, type UltView, type V3, pitchTo, yawToPoint } from '../ultCam';

export interface LookOpts {
  /** Height added to the point (m) — chest of a standing victim ≈ 0.9, a pinned one ≈ 0.25. */
  h?: number;
  /** Look-at weight 0..1 (1 = the pitch is exactly toward the point). */
  w: number;
  /** Persistent yaw ease toward the point (1/s); omit to leave the yaw to the mouse. */
  yawRate?: number;
  /** Mouse yaw scale while looking (omit = leave). */
  mouse?: number;
  /** Clamp of the look pitch (rad). */
  lo?: number;
  hi?: number;
}

/** Look at a world point: sets lookW / lookPitch (+ yawTo / yawRate / mouseYaw when asked). False when `p` is null. */
export function lookAt(c: UltCtx, v: UltView, p: V3 | null, o: LookOpts): boolean {
  if (p === null) return false;
  const horiz = Math.hypot(p.x - c.eye.x, p.z - c.eye.z);
  v.lookW = o.w;
  v.lookPitch = clampNum(pitchTo(c.eye, p.x, p.y + (o.h ?? 0), p.z), o.lo ?? -1.3, o.hi ?? 1.0);
  if (o.yawRate !== undefined && o.yawRate > 0 && horiz > 0.6) {
    v.yawTo = yawToPoint(c.eye, p.x, p.z);
    v.yawRate = o.yawRate;
  }
  if (o.mouse !== undefined) v.mouseYaw = o.mouse;
  return true;
}

/**
 * Pull the eye BACK (negative `eyeF`) so it stays at least `minDist` m (horizontally) from the victim's centre — a pinned /
 * held / adjacent victim is big, and an eye inside its body would render black. `maxBack` bounds the pull-back (m).
 */
export function eyeBack(c: UltCtx, v: UltView, minDist: number, maxBack = 1.6): void {
  const p = c.victim;
  if (p === null) return;
  const d0 = Math.hypot(p.x - c.eye0.x, p.z - c.eye0.z);
  const need = minDist - d0;
  if (need > 0) v.eyeF = Math.min(v.eyeF, -Math.min(need, maxBack));
}

/** Ease the view yaw toward the SIM's own yaw (the body is turned by the sim: hippo lock, rhino homing, giraffe creep …). */
export function followSimYaw(c: UltCtx, v: UltView, rate: number, mouse: number): void {
  v.yawTo = c.state.yaw;
  v.yawRate = rate;
  v.mouseYaw = mouse;
}
