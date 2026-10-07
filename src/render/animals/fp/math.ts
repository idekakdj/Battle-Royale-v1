/**
 * Pure first-person camera maths (v1.3 WP-Q). No three.js, no DOM — unit-tested
 * in tests/render/fp.test.ts. The CameraRig / BaseRig call these each frame.
 */

import { getRenderArena } from '../../arenaContext';
import type { FpEye } from './types';

const DEG = Math.PI / 180;

/** Look-pitch limit (± rad) in first person. */
export const FP_PITCH_LIMIT = 80 * DEG;
/** Default horizontal FOV (deg) and the settings-slider bounds. */
export const FP_FOV_DEFAULT = 85;
export const FP_FOV_MIN = 60;
export const FP_FOV_MAX = 110;
/** Seconds for a full third↔first-person camera transition. */
export const FP_SWITCH_SECONDS = 0.42;

export function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Clamp a FP look-pitch (+ = up) to ±80°. */
export function clampFpPitch(p: number): number {
  return clampNum(p, -FP_PITCH_LIMIT, FP_PITCH_LIMIT);
}

/** Clamp the FP FOV setting to the slider range (NaN → default). */
export function clampFpFov(deg: number): number {
  if (!Number.isFinite(deg)) return FP_FOV_DEFAULT;
  return clampNum(deg, FP_FOV_MIN, FP_FOV_MAX);
}

/**
 * The FP FOV is a HORIZONTAL angle (game convention); three.js wants the
 * vertical one. Result clamped to a sane 20°–110° so odd aspect ratios (tall
 * windows) never produce a fisheye or a slit.
 */
export function fpVerticalFov(horizontalDeg: number, aspect: number): number {
  const a = aspect > 0.2 ? aspect : 0.2;
  const v = 2 * Math.atan(Math.tan((horizontalDeg * DEG) / 2) / a) / DEG;
  return clampNum(v, 20, 110);
}

/** Move `blend` toward `on` (1) / off (0) at 1/`dur` per second. */
export function stepBlend(blend: number, on: boolean, dt: number, dur = FP_SWITCH_SECONDS): number {
  const step = dt / dur;
  return on ? Math.min(1, blend + step) : Math.max(0, blend - step);
}

/** Hermite ease used for the mode transition. */
export function smoothStep01(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/**
 * Rig-local eye offset → world-space offset from the rig root, for a rig whose
 * root has `rotation.y = yaw` (forward = (sin yaw, cos yaw)). Writes into `out`.
 */
export function eyeWorldOffset(
  yaw: number,
  lx: number, ly: number, lz: number,
  out: { x: number; y: number; z: number },
): void {
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  out.x = lx * c + lz * s;
  out.y = ly;
  out.z = -lx * s + lz * c;
}

/** `eyeWorldOffset` for an {@link FpEye}. */
export function eyeOffsetFromProfile(
  yaw: number,
  eye: FpEye,
  out: { x: number; y: number; z: number },
): void {
  eyeWorldOffset(yaw, eye.side, eye.up, eye.forward, out);
}

/**
 * Camera forward direction for a yaw and a look-pitch (+ = up): matches the
 * movement basis (forward = (sin yaw, cos yaw)). Writes into `out`.
 */
export function lookDirection(yaw: number, lookUp: number, out: { x: number; y: number; z: number }): void {
  const cp = Math.cos(lookUp);
  out.x = Math.sin(yaw) * cp;
  out.y = Math.sin(lookUp);
  out.z = Math.cos(yaw) * cp;
}

/** Limit a vector's length (used to bound how far the eye chases the head). */
export function clampLength3(v: { x: number; y: number; z: number }, max: number): void {
  const l2 = v.x * v.x + v.y * v.y + v.z * v.z;
  if (l2 > max * max && l2 > 1e-12) {
    const k = max / Math.sqrt(l2);
    v.x *= k;
    v.y *= k;
    v.z *= k;
  }
}

/**
 * Keep the eye out of the arena wall and pillars: pull the horizontal offset
 * back toward the root until the eye is clear. `rootX/rootZ` = the fighter's
 * position, `off` = the eye's horizontal offset from it (mutated). Fighters are
 * already kept out of these by the sim, but the eye sits up to ~1 m in front
 * of the body centre.
 */
export function clampEyeToArena(rootX: number, rootZ: number, off: { x: number; z: number }, pad = 0.22): void {
  // v1.8: the wall and the round blockers (pillars / tree trunks) come from the current arena (colosseum = the same numbers).
  const arena = getRenderArena();
  const wallR = arena.wallRadius;
  const circles = arena.circles;
  for (let iter = 0; iter < 6; iter++) {
    const ex = rootX + off.x;
    const ez = rootZ + off.z;
    let bad = false;
    const r = Math.hypot(ex, ez);
    if (r > wallR - pad) bad = true;
    if (!bad) {
      for (let i = 0; i < circles.length; i++) {
        const p = circles[i];
        const dx = ex - p.x;
        const dz = ez - p.z;
        const rr = p.radius + pad;
        if (dx * dx + dz * dz < rr * rr) {
          bad = true;
          break;
        }
      }
    }
    if (!bad) return;
    off.x *= 0.6;
    off.z *= 0.6;
  }
  off.x = 0;
  off.z = 0;
}

/** Vertical run bob (m) for a gait phase (two bobs per stride), scaled by run intensity `k`. */
export function runBob(gaitPhase: number, amount: number, k: number): number {
  return Math.sin(gaitPhase * 2 + 0.6) * amount * k;
}

/** Lateral sway (m) for a gait phase. */
export function runSway(gaitPhase: number, amount: number, k: number): number {
  return Math.sin(gaitPhase) * amount * 0.6 * k;
}

/**
 * Critically-damped-ish spring for the hit "view kick" (pitch/roll offsets in
 * radians). Deterministic, allocation-free.
 */
export class ViewKick {
  pitch = 0;
  roll = 0;
  private vp = 0;
  private vr = 0;

  /** Impulse: `pitch` rad up-kick, `roll` rad tilt. */
  kick(pitch: number, roll: number): void {
    this.vp += pitch * 26;
    this.vr += roll * 26;
    // Clamp so stacked hits can never tumble the view.
    this.vp = clampNum(this.vp, -2.2, 2.2);
    this.vr = clampNum(this.vr, -2.2, 2.2);
  }

  update(dt: number): void {
    const d = dt > 0.05 ? 0.05 : dt;
    const k = 190; // stiffness
    const c = 24; // damping (≈ critical for k=190)
    this.vp += (-k * this.pitch - c * this.vp) * d;
    this.vr += (-k * this.roll - c * this.vr) * d;
    this.pitch += this.vp * d;
    this.roll += this.vr * d;
    this.pitch = clampNum(this.pitch, -0.14, 0.14);
    this.roll = clampNum(this.roll, -0.14, 0.14);
    if (Math.abs(this.pitch) < 1e-5 && Math.abs(this.vp) < 1e-4) {
      this.pitch = 0;
      this.vp = 0;
    }
    if (Math.abs(this.roll) < 1e-5 && Math.abs(this.vr) < 1e-4) {
      this.roll = 0;
      this.vr = 0;
    }
  }
}

/** Shortest signed angle difference a→b in (−π, π]. */
export function angleDiff(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

/** Ease `cur` toward `target` (angles) with rate `k` (1/s); returns the new angle. */
export function easeAngle(cur: number, target: number, k: number, dt: number): number {
  return cur + angleDiff(cur, target) * (1 - Math.exp(-k * dt));
}
