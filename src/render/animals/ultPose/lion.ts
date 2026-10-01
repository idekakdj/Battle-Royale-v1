/**
 * Lion — Royal Hunt pose timeline (v1.3 Phase 2). Pure functions of the fighter state the sim publishes
 * (`actionT`, `ultPhase`, `ultStage`): no internal clocks, so the pose is stable however the root moves.
 *
 * The sim's ultimate timeline is FIXED (see config/ultimates/lion.ts `LION_HUNT`), so the pose is a
 * keyframed function of `actionT` with cubic easing per segment:
 *   0.00–0.55  eye-lock coil: crouch, weight back, tail lash, head locked up on the prey
 *   0.55–1.05  bounding pounce: explosive extension, long arc with reaching forepaws, dive to the pin
 *   1.05–1.25  touchdown crunch → pinned: claws down, weight on the victim
 *   1.25–2.45  four strikes 0.3 s apart: R claw · L claw · bite + head snap · double-claw slam
 *   2.49–3.04  rearing roar (mane flared, jaw wide, trembling)
 *   3.04–3.49  settle
 * A whiffed pounce (phase 'recovery' while the stage is still ≤ 2) skids out of the landing instead.
 * `sampleKeys` / `buildTrack` are shared with the panther module.
 */

import { LION_HUNT as H, LION_T_END, LION_T_LAND, LION_T_ROAR } from '../../../config/ultimates/lion';

// ── Generic keyframe machinery (shared with ultPose/panther.ts) ──────────────

export type Ease = 'lin' | 'in' | 'out' | 'io';

export function applyEase(e: Ease, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  switch (e) {
    case 'in':
      return x * x * x;
    case 'out': {
      const u = 1 - x;
      return 1 - u * u * u;
    }
    case 'io':
      return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    default:
      return x;
  }
}

export function smooth(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

export function rampT(t: number, a: number, b: number): number {
  const x = (t - a) / (b - a);
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** One authored key: `set` overrides channels on top of the previous key's pose; `e` eases INTO this key. */
export interface KeyDef<C extends string> {
  t: number;
  e?: Ease;
  set: Partial<Record<C, number>>;
}

export interface Track {
  times: number[];
  eases: Ease[];
  poses: Float64Array[];
}

export function buildTrack<C extends string>(names: readonly C[], neutral: Partial<Record<C, number>>, defs: readonly KeyDef<C>[]): Track {
  const n = names.length;
  const track: Track = { times: [], eases: [], poses: [] };
  let prev = new Float64Array(n);
  for (let i = 0; i < n; i++) prev[i] = neutral[names[i]] ?? 0;
  for (const d of defs) {
    const p = Float64Array.from(prev);
    for (let i = 0; i < n; i++) {
      const v = d.set[names[i]];
      if (v !== undefined) p[i] = v;
    }
    track.times.push(d.t);
    track.eases.push(d.e ?? 'io');
    track.poses.push(p);
    prev = p;
  }
  return track;
}

/** Sample a track at `t` into `out` (clamped to the first/last key). */
export function sampleKeys(track: Track, t: number, out: Float64Array): void {
  const { times, eases, poses } = track;
  const last = times.length - 1;
  if (t <= times[0]) {
    out.set(poses[0]);
    return;
  }
  if (t >= times[last]) {
    out.set(poses[last]);
    return;
  }
  let k = 0;
  while (k < last - 1 && t >= times[k + 1]) k++;
  const a = poses[k];
  const b = poses[k + 1];
  const u = applyEase(eases[k + 1], (t - times[k]) / (times[k + 1] - times[k]));
  for (let i = 0; i < out.length; i++) out[i] = a[i] + (b[i] - a[i]) * u;
}

// ── Lion channels ────────────────────────────────────────────────────────────

export const LION_CH_NAMES = [
  'bodyPy', 'bodyPz', 'bodyRx', 'bodyRy', 'bodyRz',
  'l0Rx', 'l0Rz', 'l1Rx', 'l1Rz', 'l2Rx', 'l2Rz', 'l3Rx', 'l3Rz',
  'neckRx', 'neckRy', 'headRx', 'headRy', 'headRz', 'jawRx', 'maneS',
  'tailRx', 'tailRy', 'tail2Rx', 'tail2Ry',
] as const;
export type LionCh = (typeof LION_CH_NAMES)[number];
/** Channel index by name. */
export const LC = Object.fromEntries(LION_CH_NAMES.map((n, i) => [n, i])) as Record<LionCh, number>;

const NEUTRAL: Partial<Record<LionCh, number>> = { maneS: 1 };

// Strike timing (seconds from cast).
const S = [0, 1, 2, 3].map((k) => LION_T_LAND + H.firstStrike + k * H.strikeGap); // strike starts
const I = S.map((s) => s + H.impactDelay); // claws land
const F = S.map((s) => s + 0.2); // follow-through peak

const KEYS: KeyDef<LionCh>[] = [
  { t: 0, set: {} },
  // — eye-lock coil —
  { t: 0.3, e: 'out', set: { bodyPy: -0.3, bodyPz: -0.05, bodyRx: 0.16, l0Rx: 0.45, l1Rx: 0.45, l2Rx: -0.55, l3Rx: -0.55, neckRx: 0.22, headRx: -0.32, jawRx: 0.04, maneS: 1.06, tailRx: 0.15 } },
  { t: H.windup, e: 'in', set: { bodyPy: -0.38, bodyPz: -0.12, bodyRx: 0.24, l0Rx: 0.6, l1Rx: 0.6, l2Rx: -0.85, l3Rx: -0.85, neckRx: 0.26, headRx: -0.4, jawRx: 0.14, maneS: 1.1, tailRx: 0.25 } },
  // — pounce: explosive extension → long reach → dive —
  { t: H.windup + 0.08, e: 'out', set: { bodyPy: 0.12, bodyPz: 0.25, bodyRx: -0.3, l0Rx: -1.3, l1Rx: -1.3, l2Rx: 1.05, l3Rx: 1.05, neckRx: -0.15, headRx: -0.3, jawRx: 0.55, maneS: 1.14, tailRx: 0.35 } },
  { t: H.windup + 0.25, e: 'io', set: { bodyPy: 0.16, bodyPz: 0.3, bodyRx: -0.1, l0Rx: -1.45, l0Rz: -0.22, l1Rx: -1.45, l1Rz: 0.22, l2Rx: 0.85, l2Rz: -0.1, l3Rx: 0.85, l3Rz: 0.1, jawRx: 0.6 } },
  { t: LION_T_LAND - 0.05, e: 'in', set: { bodyPy: 0.06, bodyRx: 0.3, l0Rx: -1.1, l0Rz: -0.3, l1Rx: -1.1, l1Rz: 0.3, l2Rx: 0.35, l3Rx: 0.35, neckRx: 0.25, headRx: 0.1, jawRx: 0.75, maneS: 1.15, tailRx: 0.45 } },
  // — touchdown crunch, then pinned —
  { t: LION_T_LAND, e: 'in', set: { bodyPy: -0.2, bodyPz: 0.22, bodyRx: 0.3, l0Rx: -0.85, l0Rz: -0.25, l1Rx: -0.85, l1Rz: 0.25, l2Rx: 0.2, l3Rx: 0.2, neckRx: 0.42, headRx: 0.22, jawRx: 0.8, tailRx: 0.2 } },
  { t: S[0] - 0.05, e: 'out', set: { bodyPy: -0.26, bodyPz: 0.18, bodyRx: 0.36, l0Rx: -0.72, l0Rz: -0.2, l1Rx: -0.72, l1Rz: 0.2, l2Rx: 0.35, l3Rx: 0.35, neckRx: 0.3, headRx: 0.25, jawRx: 0.3, maneS: 1.1 } },
  // — strike 1: right (x+) claw rake —
  { t: S[0], e: 'io', set: { l1Rx: -1.9, l1Rz: 0.25, bodyRy: -0.15, bodyRz: 0.05, neckRy: 0.2, headRy: 0.15, jawRx: 0.5, bodyPy: -0.22, bodyRx: 0.25 } },
  { t: I[0], e: 'in', set: { l1Rx: -0.72, l1Rz: -0.4, bodyRy: 0.3, bodyRz: -0.06, neckRy: -0.25, headRy: -0.3, jawRx: 0.25, bodyPy: -0.3, bodyPz: 0.26, bodyRx: 0.4 } },
  { t: F[0], e: 'out', set: { l1Rx: -0.6, l1Rz: -0.5, bodyRy: 0.36, headRy: -0.34, bodyPz: 0.3 } },
  // — strike 2: left (x−) claw rake —
  { t: S[1], e: 'io', set: { l0Rx: -1.9, l0Rz: -0.25, l1Rx: -0.75, l1Rz: 0.1, bodyRy: 0.15, bodyRz: -0.05, neckRy: -0.2, headRy: -0.15, jawRx: 0.5, bodyPy: -0.22, bodyRx: 0.25, bodyPz: 0.2 } },
  { t: I[1], e: 'in', set: { l0Rx: -0.72, l0Rz: 0.4, bodyRy: -0.3, bodyRz: 0.06, neckRy: 0.25, headRy: 0.3, jawRx: 0.25, bodyPy: -0.3, bodyPz: 0.26, bodyRx: 0.4 } },
  { t: F[1], e: 'out', set: { l0Rx: -0.6, l0Rz: 0.5, bodyRy: -0.36, headRy: 0.34, bodyPz: 0.3 } },
  // — strike 3: bite + head snap —
  { t: S[2], e: 'io', set: { l0Rx: -0.72, l0Rz: -0.2, l1Rx: -0.72, l1Rz: 0.2, bodyRy: 0, bodyRz: 0, neckRx: -0.12, neckRy: 0, headRx: -0.3, headRy: 0, jawRx: 0.95, bodyPy: -0.22, bodyPz: 0.22, bodyRx: 0.25, maneS: 1.15 } },
  { t: I[2], e: 'in', set: { neckRx: 0.68, headRx: 0.42, jawRx: 0, bodyPz: 0.38, bodyPy: -0.32, bodyRx: 0.42 } },
  { t: F[2], e: 'out', set: { neckRx: 0.45, headRx: 0.3, jawRx: 0.15, bodyPz: 0.3 } },
  // — strike 4: rears, double-claw slam + bite —
  { t: S[3], e: 'io', set: { l0Rx: -1.95, l0Rz: -0.3, l1Rx: -1.95, l1Rz: 0.3, bodyRx: -0.22, bodyPy: -0.05, bodyPz: 0.1, neckRx: -0.2, headRx: -0.35, jawRx: 0.9, maneS: 1.2, tailRx: 0.45 } },
  { t: I[3], e: 'in', set: { l0Rx: -0.66, l0Rz: 0.15, l1Rx: -0.66, l1Rz: -0.15, bodyRx: 0.5, bodyPy: -0.4, bodyPz: 0.45, neckRx: 0.7, headRx: 0.45, jawRx: 0, maneS: 1.1 } },
  { t: F[3], e: 'out', set: { bodyPz: 0.36, bodyPy: -0.34, bodyRx: 0.42, jawRx: 0.1, neckRx: 0.5 } },
  // — roar: inhale, rear up, hold, settle —
  { t: LION_T_ROAR - 0.03, e: 'io', set: { l0Rx: -0.72, l0Rz: -0.2, l1Rx: -0.72, l1Rz: 0.2, bodyPy: -0.3, bodyPz: 0.2, bodyRx: 0.3, neckRx: 0.3, headRx: 0.2, jawRx: 0.1, maneS: 1.05, tailRx: 0.2 } },
  { t: LION_T_ROAR + 0.28, e: 'out', set: { bodyPy: 0.14, bodyPz: 0, bodyRx: -0.85, l0Rx: -1.35, l0Rz: -0.15, l1Rx: -1.15, l1Rz: 0.15, l2Rx: 0.55, l3Rx: 0.55, neckRx: -0.2, headRx: -0.45, jawRx: 0.85, maneS: 1.3, tailRx: -0.4 } },
  { t: LION_T_ROAR + H.roarHold, e: 'lin', set: {} },
  { t: LION_T_END, e: 'io', set: { bodyPy: 0, bodyPz: 0, bodyRx: 0, bodyRy: 0, bodyRz: 0, l0Rx: 0, l0Rz: 0, l1Rx: 0, l1Rz: 0, l2Rx: 0, l2Rz: 0, l3Rx: 0, l3Rz: 0, neckRx: 0, neckRy: 0, headRx: 0, headRy: 0, headRz: 0, jawRx: 0.04, maneS: 1, tailRx: 0, tailRy: 0, tail2Rx: 0, tail2Ry: 0 } },
];

/** A missed pounce: skid out of the landing into a wary, head-sweeping stance. */
const WHIFF_KEYS: KeyDef<LionCh>[] = [
  { t: LION_T_LAND, set: {} },
  { t: LION_T_LAND + 0.25, e: 'out', set: { bodyPy: -0.16, bodyPz: 0.05, bodyRx: 0.2, l0Rx: -0.35, l0Rz: -0.1, l1Rx: -0.35, l1Rz: 0.1, l2Rx: 0.15, l3Rx: 0.15, neckRx: 0.2, headRx: 0.05, jawRx: 0.15, maneS: 1.05 } },
  { t: LION_T_LAND + 0.9, e: 'io', set: { bodyPy: 0, bodyPz: 0, bodyRx: 0, l0Rx: 0, l0Rz: 0, l1Rx: 0, l1Rz: 0, l2Rx: 0, l3Rx: 0, neckRx: 0, headRx: 0, jawRx: 0.04, maneS: 1 } },
];

const MAIN = buildTrack(LION_CH_NAMES, NEUTRAL, KEYS);
// The whiff track starts exactly on the main track's touchdown key (continuous), so its first key is the main pose there.
const WHIFF_BASE = new Float64Array(LION_CH_NAMES.length);
const WHIFF = buildTrack(LION_CH_NAMES, NEUTRAL, WHIFF_KEYS);
sampleKeys(MAIN, LION_T_LAND, WHIFF_BASE);
WHIFF.poses[0].set(WHIFF_BASE);


/**
 * Write the lion's ultimate pose into `out` (length = LION_CH_NAMES.length).
 * `phase`/`stage` are the snapshot's `ultPhase`/`ultStage` (both may be undefined, e.g. the animals demo).
 */
export function sampleLionUlt(t: number, phase: 'windup' | 'active' | 'recovery' | undefined, stage: number | undefined, out: Float64Array): void {
  const whiff = phase === 'recovery' && stage !== undefined && stage <= H.stage.pin;
  if (whiff) {
    sampleKeys(WHIFF, t, out);
    out[LC.headRy] += Math.sin((t - LION_T_LAND) * 7) * 0.4 * smooth(rampT(t, LION_T_LAND + 0.1, LION_T_LAND + 0.35)) * (1 - smooth(rampT(t, LION_T_LAND + 0.6, LION_T_LAND + 0.9)));
    out[LC.tailRy] += Math.sin(t * 9) * 0.3;
    return;
  }
  sampleKeys(MAIN, t, out);
  // — secondary motion (all envelope-gated so nothing pops at the boundaries) —
  const coil = smooth(rampT(t, 0.08, 0.3)) * (1 - smooth(rampT(t, H.windup, H.windup + 0.12)));
  out[LC.tailRy] += Math.sin(t * 15) * 0.55 * coil; // tail lash while the eyes lock on
  out[LC.tail2Ry] += Math.sin(t * 15 - 1) * 0.75 * coil;
  out[LC.bodyRz] += Math.sin(t * 42) * 0.02 * coil; // coiled shimmy
  out[LC.l2Rx] += Math.sin(t * 30) * 0.06 * coil; // hind paws tread
  out[LC.l3Rx] += Math.sin(t * 30 + Math.PI) * 0.06 * coil;
  const air = smooth(rampT(t, H.windup + 0.04, H.windup + 0.12)) * (1 - smooth(rampT(t, LION_T_LAND - 0.04, LION_T_LAND)));
  out[LC.tailRy] += Math.sin(t * 9) * 0.14 * air;
  out[LC.maneS] += Math.sin(t * 34) * 0.03 * air;
  const maul = smooth(rampT(t, LION_T_LAND, LION_T_LAND + 0.15)) * (1 - smooth(rampT(t, LION_T_ROAR - 0.1, LION_T_ROAR + 0.1)));
  out[LC.tailRy] += Math.sin(t * 11) * 0.35 * maul;
  out[LC.tail2Ry] += Math.sin(t * 11 - 0.9) * 0.45 * maul;
  out[LC.bodyPy] += Math.sin(t * 9) * 0.006 * maul;
  // Bite head-shake right after the jaws snap shut (strike 3).
  const dt3 = t - I[2];
  out[LC.headRy] += Math.sin(dt3 * 60) * 0.4 * smooth(rampT(dt3, 0, 0.02)) * (1 - smooth(rampT(dt3, 0.06, 0.16)));
  out[LC.neckRy] += Math.sin(dt3 * 60 + 0.5) * 0.12 * smooth(rampT(dt3, 0, 0.02)) * (1 - smooth(rampT(dt3, 0.06, 0.16)));
  // Final slam + bite (strike 4) whips the head as well.
  const dt4 = t - I[3];
  out[LC.headRy] += Math.sin(dt4 * 55) * 0.3 * smooth(rampT(dt4, 0, 0.02)) * (1 - smooth(rampT(dt4, 0.05, 0.14)));
  const roar = smooth(rampT(t, LION_T_ROAR + 0.2, LION_T_ROAR + 0.3)) * (1 - smooth(rampT(t, LION_T_ROAR + H.roarHold, LION_T_ROAR + H.roarHold + 0.2)));
  out[LC.jawRx] += Math.sin(t * 34) * 0.08 * roar;
  out[LC.bodyRz] += Math.sin(t * 28) * 0.012 * roar;
  out[LC.maneS] += Math.sin(t * 22) * 0.025 * roar;
}
