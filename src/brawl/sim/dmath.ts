/**
 * Deterministic math for the Champions League simulation (online rollback netcode, v1.5).
 *
 * `Math.sin/cos/tan/atan/atan2/pow/exp/log/hypot/…` are implementation-defined: two engines (or two versions of the
 * same engine) may return results that differ in the last bit, and a single differing bit is enough to desync a
 * rollback match. Everything here is built ONLY from `+ − × ÷`, comparisons, `Math.sqrt/abs/round/floor` and `& |`,
 * all of which IEEE-754 / ECMAScript define exactly, so the results are bit-identical on every machine.
 *
 * Accuracy: |error| < 1e-15 (sin/cos, absolute) and < 1e-15 relative (atan/atan2) against the platform `Math.*`
 * for the ranges the simulation uses, far below the 1e-9 budget that keeps gameplay and balance unchanged
 * (see tests/brawl/determinism.math.test.ts). Non-finite inputs return NaN (sin/cos/tan) or follow the obvious limit.
 */

const TWO_OVER_PI = 0.6366197723675814;
const PI = 3.141592653589793;
const HALF_PI = 1.5707963267948966;
const QUARTER_PI = 0.7853981633974483;
const TAN_PI_8 = 0.41421356237309503;
const TWO_PI = 6.283185307179586;

// π/2 split in three pieces (Cody–Waite / fdlibm): n × PIO2_1 is exact for |n| < 2^20.
const PIO2_1 = 1.5707963267341256;
const PIO2_1T = 6.077100506506192e-11;

// fdlibm minimax coefficients of sin(r) / cos(r) on [−π/4, π/4].
const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.5896909952115501022e-10;

const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.0875723212981748279e-9;
const C6 = -1.13596475577881948265e-11;

function kernelSin(r: number): number {
  const z = r * r;
  return r + r * z * (S1 + z * (S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))));
}

function kernelCos(r: number): number {
  const z = r * r;
  return 1 - 0.5 * z + z * z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
}

/** Scratch result of {@link reduce}: remainder in [−π/4, π/4] and quadrant 0..3. */
let redR = 0;
let redQ = 0;

function reduce(x: number): void {
  if (x >= -QUARTER_PI && x <= QUARTER_PI) {
    redR = x;
    redQ = 0;
    return;
  }
  let v = x;
  if (v > 1e6 || v < -1e6) {
    // Out of the exact Cody–Waite range: fold by whole turns first (precision degrades, determinism does not).
    v = v - TWO_PI * Math.floor(v / TWO_PI);
  }
  const n = Math.round(v * TWO_OVER_PI);
  redR = v - n * PIO2_1 - n * PIO2_1T;
  redQ = n & 3;
}

/** sin(x), deterministic. */
export function dsin(x: number): number {
  if (x !== x || x === Infinity || x === -Infinity) return NaN;
  reduce(x);
  const r = redR;
  switch (redQ) {
    case 0:
      return kernelSin(r);
    case 1:
      return kernelCos(r);
    case 2:
      return -kernelSin(r);
    default:
      return -kernelCos(r);
  }
}

/** cos(x), deterministic. */
export function dcos(x: number): number {
  if (x !== x || x === Infinity || x === -Infinity) return NaN;
  reduce(x);
  const r = redR;
  switch (redQ) {
    case 0:
      return kernelCos(r);
    case 1:
      return -kernelSin(r);
    case 2:
      return -kernelCos(r);
    default:
      return kernelSin(r);
  }
}

/** tan(x) = sin/cos (deterministic division). */
export function dtan(x: number): number {
  return dsin(x) / dcos(x);
}

// atan(t) = t·Σ (−1)^k (t²)^k / (2k+1); with |t| ≤ tan(π/8) 21 terms reach 1e-17.
const ATAN_TERMS = 21;
const ATAN_C: number[] = [];
for (let k = 0; k < ATAN_TERMS; k++) ATAN_C.push((k % 2 === 0 ? 1 : -1) / (2 * k + 1));

function atanSeries(t: number): number {
  const z = t * t;
  let acc = ATAN_C[ATAN_TERMS - 1];
  for (let k = ATAN_TERMS - 2; k >= 0; k--) acc = ATAN_C[k] + z * acc;
  return t * acc;
}

function atanUnit(a: number): number {
  // a ∈ [0, 1]
  if (a > TAN_PI_8) return QUARTER_PI + atanSeries((a - 1) / (a + 1));
  return atanSeries(a);
}

/** atan(x), deterministic. */
export function datan(x: number): number {
  if (x !== x) return NaN;
  const a = x < 0 ? -x : x;
  let r: number;
  if (a === Infinity) r = HALF_PI;
  else if (a > 1) r = HALF_PI - atanUnit(1 / a);
  else r = atanUnit(a);
  return x < 0 ? -r : r;
}

/** atan2(y, x), deterministic (quadrant handling as `Math.atan2`, signed zeros ignored). */
export function datan2(y: number, x: number): number {
  if (x !== x || y !== y) return NaN;
  if (x > 0) return datan(y / x);
  if (x < 0) return y >= 0 ? datan(y / x) + PI : datan(y / x) - PI;
  // x === 0
  if (y > 0) return HALF_PI;
  if (y < 0) return -HALF_PI;
  return 0;
}

/** √(x² + y²), deterministic (no overflow protection: simulation values are tiny). */
export function dhypot(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}
