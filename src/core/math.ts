/**
 * Deterministic math helpers (BLUEPRINT §5 / §7.8).
 *
 * The sim and AI MUST route all randomness through {@link mulberry32} — never
 * `Math.random()` — so identical seeds reproduce identical matches. Vec3 helpers
 * are plain-object based and offer mutating / scratch-friendly variants so hot
 * loops allocate nothing (BLUEPRINT §15).
 */

import type { Vec3 } from './types';

export const TAU = Math.PI * 2;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

/** A seeded pseudo-random generator: returns a float in [0, 1) each call. */
export type Rng = () => number;

/**
 * mulberry32 — small, fast, deterministic 32-bit PRNG. Same seed ⇒ same stream.
 * This is the ONLY sanctioned source of randomness inside `sim/` and `ai/`.
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function (): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Clamp `v` into the inclusive range [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Clamp into [0, 1]. */
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Linear interpolation from `a` to `b` by `t` (unclamped). */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Map `v` from [inMin, inMax] onto [outMin, outMax] (unclamped). */
export function remap(v: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  return outMin + ((v - inMin) * (outMax - outMin)) / (inMax - inMin);
}

/** Degrees → radians. */
export function degToRad(deg: number): number {
  return deg * DEG2RAD;
}

/** Radians → degrees. */
export function radToDeg(rad: number): number {
  return rad * RAD2DEG;
}

/** Wrap an angle (radians) into (−π, π]. */
export function wrapAngle(a: number): number {
  a = a % TAU;
  if (a <= -Math.PI) a += TAU;
  else if (a > Math.PI) a -= TAU;
  return a;
}

/** Signed smallest difference `to − from` wrapped into (−π, π]. */
export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

/**
 * Rotate `current` toward `target` by at most `maxStep` radians (shortest way).
 * Used for capped turn rates while attacking (BLUEPRINT §7.2, 240°/s).
 */
export function rotateToward(current: number, target: number, maxStep: number): number {
  const d = angleDelta(current, target);
  if (d > maxStep) return wrapAngle(current + maxStep);
  if (d < -maxStep) return wrapAngle(current - maxStep);
  return wrapAngle(target);
}

/**
 * Gaussian (normal) sample with mean 0 and std-dev `sigma`, using Box–Muller on
 * the supplied deterministic `rng`. Used for bot aim error (BLUEPRINT §10).
 */
export function gaussian(rng: Rng, sigma: number): number {
  // Avoid log(0) by nudging u1 off zero.
  let u1 = rng();
  if (u1 < 1e-12) u1 = 1e-12;
  const u2 = rng();
  const mag = Math.sqrt(-2.0 * Math.log(u1));
  return mag * Math.cos(TAU * u2) * sigma;
}

// ── Vec3 helpers ─────────────────────────────────────────────────────────────
// Plain-object based. Functions that write take an `out` target so callers can
// reuse scratch vectors and allocate nothing in hot paths.

/** Construct a new Vec3 (allocates — prefer scratch reuse in loops). */
export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

/** Copy `src` into `out`; returns `out`. */
export function v3copy(out: Vec3, src: Vec3): Vec3 {
  out.x = src.x;
  out.y = src.y;
  out.z = src.z;
  return out;
}

/** Set `out` component-wise; returns `out`. */
export function v3set(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

/** out = a + b. */
export function v3add(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  out.z = a.z + b.z;
  return out;
}

/** out = a − b. */
export function v3sub(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  out.z = a.z - b.z;
  return out;
}

/** out = a * s. */
export function v3scale(out: Vec3, a: Vec3, s: number): Vec3 {
  out.x = a.x * s;
  out.y = a.y * s;
  out.z = a.z * s;
  return out;
}

/** out = a + b * s (scaled add / multiply-accumulate). */
export function v3addScaled(out: Vec3, a: Vec3, b: Vec3, s: number): Vec3 {
  out.x = a.x + b.x * s;
  out.y = a.y + b.y * s;
  out.z = a.z + b.z * s;
  return out;
}

/** Dot product of `a` and `b`. */
export function v3dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Euclidean length of `a`. */
export function v3len(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

/** Squared length of `a` (cheap; avoids the sqrt for comparisons). */
export function v3lenSq(a: Vec3): number {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}

/** Distance between `a` and `b`. */
export function v3dist(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Squared distance between `a` and `b`. */
export function v3distSq(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

/** Horizontal (XZ-plane) distance, ignoring y. */
export function v3distXZ(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Squared horizontal (XZ-plane) distance, ignoring y. */
export function v3distSqXZ(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

/** Normalize `a` into `out`; zero-length vectors become (0,0,0). Returns `out`. */
export function v3normalize(out: Vec3, a: Vec3): Vec3 {
  const len = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  if (len > 1e-9) {
    const inv = 1 / len;
    out.x = a.x * inv;
    out.y = a.y * inv;
    out.z = a.z * inv;
  } else {
    out.x = 0;
    out.y = 0;
    out.z = 0;
  }
  return out;
}

/** Component-wise lerp: out = a + (b − a) * t. Returns `out`. */
export function v3lerp(out: Vec3, a: Vec3, b: Vec3, t: number): Vec3 {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}

/**
 * World yaw (radians) of a facing direction on the XZ plane, matching the
 * convention used for {@link Vec3} facing: yaw 0 looks toward +Z, increasing
 * toward +X. `yawToDir` is its inverse.
 */
export function dirToYaw(dx: number, dz: number): number {
  return Math.atan2(dx, dz);
}

/** Unit direction on the XZ plane for a world `yaw`; writes into `out`. */
export function yawToDir(out: Vec3, yaw: number): Vec3 {
  out.x = Math.sin(yaw);
  out.y = 0;
  out.z = Math.cos(yaw);
  return out;
}
