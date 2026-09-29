/**
 * Player-only aim helpers (WP-M, UPGRADE-PLAN §6.3). Pure, allocation-free
 * math shared by the MatchController and unit-tested in
 * `tests/match/aimAssist.test.ts`. Nothing here touches the sim contract:
 * the controller only rewrites `FighterIntent.aimYaw` before `setIntent`.
 *
 * Yaw convention (matches the sim, CameraRig and InputManager): a world yaw
 * `y` faces the XZ direction `(sin y, cos y)`; `yawTo` returns that yaw.
 */

import { wrapAngle } from '../core/math';

const DEG = Math.PI / 180;

/** One potential target, in a caller-owned (reused) array. */
export interface AimTarget {
  id: number;
  x: number;
  z: number;
  /** False for dead / hidden (stealth, burrowed) / non-enemy slots. */
  valid: boolean;
}

/** Soft aim-assist tuning (§6.3: ~1.4× reach, ~40° cone, ≤ 25° nudge). */
export interface AimAssistConfig {
  /** Assist reach as a multiple of the ability's range. */
  rangeMult: number;
  /** Half-angle of the acceptance cone around `aimYaw` (radians). */
  coneHalfAngle: number;
  /** Maximum yaw correction applied (radians). */
  maxNudge: number;
}

export const AIM_ASSIST: Readonly<AimAssistConfig> = {
  rangeMult: 1.4,
  coneHalfAngle: 40 * DEG,
  maxNudge: 25 * DEG,
};

/** Lock-on tuning (§6.3). */
export const LOCK_ON = {
  /** Max distance to acquire / keep a lock (m). */
  maxDist: 20,
  /** Preferred acquisition half-cone around the camera yaw (radians). */
  frontHalfAngle: 75 * DEG,
  /** Weight of distance (per maxDist) vs. angle (radians) in acquisition scoring. */
  distWeight: 0.6,
} as const;

/** World yaw from (px,pz) toward (tx,tz). */
export function yawTo(px: number, pz: number, tx: number, tz: number): number {
  return Math.atan2(tx - px, tz - pz);
}

/**
 * Soft aim assist: if a valid target lies within `range × rangeMult` and within
 * `coneHalfAngle` of `aimYaw`, return `aimYaw` rotated toward the best one by at
 * most `maxNudge`; otherwise return `aimYaw` unchanged (wrapped). The best
 * target minimizes normalized angle + half-weighted normalized distance.
 */
export function assistAimYaw(
  aimYaw: number,
  px: number,
  pz: number,
  targets: readonly AimTarget[],
  count: number,
  range: number,
  cfg: Readonly<AimAssistConfig> = AIM_ASSIST,
): number {
  const maxDist = range * cfg.rangeMult;
  if (!(maxDist > 0)) return wrapAngle(aimYaw);
  const maxDistSq = maxDist * maxDist;
  let bestDiff = 0;
  let bestScore = Infinity;
  const n = Math.min(count, targets.length);
  for (let i = 0; i < n; i++) {
    const t = targets[i];
    if (!t.valid) continue;
    const dx = t.x - px;
    const dz = t.z - pz;
    const dSq = dx * dx + dz * dz;
    if (dSq > maxDistSq || dSq < 1e-6) continue;
    const diff = wrapAngle(Math.atan2(dx, dz) - aimYaw);
    const ad = Math.abs(diff);
    if (ad > cfg.coneHalfAngle) continue;
    const score = ad / cfg.coneHalfAngle + (0.5 * Math.sqrt(dSq)) / maxDist;
    if (score < bestScore) {
      bestScore = score;
      bestDiff = diff;
    }
  }
  if (bestScore === Infinity) return wrapAngle(aimYaw);
  const nudge = bestDiff > cfg.maxNudge ? cfg.maxNudge : bestDiff < -cfg.maxNudge ? -cfg.maxNudge : bestDiff;
  return wrapAngle(aimYaw + nudge);
}

/**
 * Initial lock-on pick: the valid target within `maxDist` that best combines
 * "close to the camera's forward" and "near"; targets inside the front cone
 * always win over ones behind. Returns the target id, or -1 if none in range.
 */
export function pickLockTarget(
  camYaw: number,
  px: number,
  pz: number,
  targets: readonly AimTarget[],
  count: number,
  maxDist: number = LOCK_ON.maxDist,
): number {
  const maxDistSq = maxDist * maxDist;
  let bestId = -1;
  let bestScore = Infinity;
  const n = Math.min(count, targets.length);
  for (let i = 0; i < n; i++) {
    const t = targets[i];
    if (!t.valid) continue;
    const dx = t.x - px;
    const dz = t.z - pz;
    const dSq = dx * dx + dz * dz;
    if (dSq > maxDistSq) continue;
    const ad = dSq < 1e-6 ? 0 : Math.abs(wrapAngle(Math.atan2(dx, dz) - camYaw));
    let score = ad + (LOCK_ON.distWeight * Math.sqrt(dSq)) / maxDist;
    if (ad > LOCK_ON.frontHalfAngle) score += 10; // behind: only as a fallback
    if (score < bestScore) {
      bestScore = score;
      bestId = t.id;
    }
  }
  return bestId;
}

/**
 * Tab-cycle: the next valid target by increasing distance after `currentId`
 * (ties broken by id), wrapping to the nearest. Returns `currentId` when it is
 * the only candidate, or -1 when nothing is within `maxDist`.
 */
export function cycleLockTarget(
  currentId: number,
  px: number,
  pz: number,
  targets: readonly AimTarget[],
  count: number,
  maxDist: number = LOCK_ON.maxDist,
): number {
  const maxDistSq = maxDist * maxDist;
  const n = Math.min(count, targets.length);
  // Distance of the current lock (Infinity-safe when it isn't a candidate).
  let curD = -1;
  for (let i = 0; i < n; i++) {
    const t = targets[i];
    if (t.id !== currentId || !t.valid) continue;
    const dx = t.x - px;
    const dz = t.z - pz;
    curD = dx * dx + dz * dz;
  }
  let nextId = -1;
  let nextD = Infinity;
  let firstId = -1;
  let firstD = Infinity;
  for (let i = 0; i < n; i++) {
    const t = targets[i];
    if (!t.valid) continue;
    const dx = t.x - px;
    const dz = t.z - pz;
    const d = dx * dx + dz * dz;
    if (d > maxDistSq) continue;
    // Nearest overall (wrap target).
    if (d < firstD || (d === firstD && t.id < firstId)) {
      firstD = d;
      firstId = t.id;
    }
    if (t.id === currentId || curD < 0) continue;
    // Strictly "after" the current one in (distance, id) order.
    const after = d > curD || (d === curD && t.id > currentId);
    if (after && (d < nextD || (d === nextD && t.id < nextId))) {
      nextD = d;
      nextId = t.id;
    }
  }
  return nextId !== -1 ? nextId : firstId;
}
