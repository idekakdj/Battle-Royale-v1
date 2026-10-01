/**
 * Gorilla — Boulder Hurl pose timeline (v1.3 Phase 2). A pure function of the fighter state the sim publishes
 * (`actionT`): no internal clocks, so the pose is stable however the root moves, and every segment is cubic-eased.
 *
 * The sim's timeline is FIXED (config/ultimates/gorilla.ts `GORILLA_HURL`: windup 1.0 s → release → recovery 0.6 s):
 *   0.00–0.44  rear up on the hind legs and drum the chest: two beats (0.13, 0.31), each with a recoil snap,
 *              the fists thrown wide between them, head tossed back
 *   0.44–0.66  drop into a squat, fists to the ground, the slab tears loose at 0.60 (body shudders)
 *   0.66–0.86  heave: stand, the slab rises up the chest to overhead
 *   0.86–0.93  overhead hold, then cock back behind the head (the eased anticipation of the throw)
 *   0.93–1.00  the THROW: body lunges, arms whip forward-up, opposite leg strides — the boulder leaves at 1.00
 *   1.00–1.28  follow-through: the whole torso folds over the throw, arms sweep down
 *   1.28–1.60  settle with a couple of heavy breaths back to the idle stance
 * `sampleGorillaUlt` writes the joint channels into a Float64Array (indices `GC`); the slab's visibility / scale
 * windows are exported for the rig.
 */

import { GORILLA_HURL as K } from '../../../config/ultimates/gorilla';

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

export function buildTrack<C extends string>(names: readonly C[], defs: readonly KeyDef<C>[]): Track {
  const n = names.length;
  const track: Track = { times: [], eases: [], poses: [] };
  let prev = new Float64Array(n);
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

/** Sample a track at time `t` (clamped) into `out`. */
export function sampleTrack(track: Track, t: number, out: Float64Array): void {
  const n = track.times.length;
  if (t <= track.times[0]) {
    out.set(track.poses[0]);
    return;
  }
  if (t >= track.times[n - 1]) {
    out.set(track.poses[n - 1]);
    return;
  }
  let i = 1;
  while (i < n - 1 && t > track.times[i]) i++;
  const t0 = track.times[i - 1];
  const t1 = track.times[i];
  const k = applyEase(track.eases[i], (t - t0) / (t1 - t0));
  const a = track.poses[i - 1];
  const b = track.poses[i];
  for (let c = 0; c < out.length; c++) out[c] = a[c] + (b[c] - a[c]) * k;
}

export const GORILLA_CH = [
  'bodyPy', 'bodyPz', 'bodyRx', 'bodyRy', 'bodyRz',
  'headRx', 'headRy',
  'aLRx', 'aLRy', 'aLRz', 'aRRx', 'aRRy', 'aRRz',
  'fLRx', 'fRRx',
  'lLRx', 'lRRx',
] as const;
export type GorillaChannel = (typeof GORILLA_CH)[number];

/** Channel indices. */
export const GC = Object.fromEntries(GORILLA_CH.map((n, i) => [n, i])) as Record<GorillaChannel, number>;

/** Slab visibility / scale-up window (seconds since the cast) and the end of the hold (the release). */
export const SLAB_SHOW_AT = K.ripAt - 0.08;
export const SLAB_FULL_AT = K.ripAt + 0.06;
export const SLAB_GONE_AT = K.windupS;

/** Total length of the pose timeline (windup + recovery). */
export const GORILLA_ULT_END = K.windupS + K.recoveryS;

type KD = KeyDef<GorillaChannel>;

/** Symmetric arm / leg key helper. */
function sym(
  arm: number, armRy: number, fore: number,
  body: { py: number; rx: number; pz?: number }, head: number,
  leg: number | [number, number],
): Partial<Record<GorillaChannel, number>> {
  const lL = Array.isArray(leg) ? leg[0] : leg;
  const lR = Array.isArray(leg) ? leg[1] : leg;
  return {
    bodyPy: body.py, bodyPz: body.pz ?? 0, bodyRx: body.rx, bodyRy: 0, bodyRz: 0,
    headRx: head, headRy: 0,
    aLRx: arm, aRRx: arm, aLRy: armRy, aRRy: -armRy, aLRz: 0, aRRz: 0,
    fLRx: fore, fRRx: fore,
    lLRx: lL, lRRx: lR,
  };
}

const KEYS: readonly KD[] = [
  { t: 0.0, set: sym(0, 0, 0, { py: 0, rx: 0 }, 0, 0) },
  // Rear up, fists flung high and wide.
  { t: 0.07, e: 'out', set: sym(-1.9, -0.45, -0.7, { py: 0.05, rx: -0.3 }, -0.2, 0.1) },
  // BEAT 1: fists slam the chest.
  { t: 0.13, e: 'in', set: sym(-1.15, 0.5, -1.55, { py: 0.08, rx: -0.5 }, -0.32, 0.2) },
  { t: 0.22, e: 'out', set: sym(-2.0, -0.4, -0.75, { py: 0.1, rx: -0.58 }, -0.42, 0.22) },
  // BEAT 2: heavier, head thrown back in a roar.
  { t: 0.31, e: 'in', set: sym(-1.1, 0.55, -1.6, { py: 0.14, rx: -0.66 }, -0.58, 0.3) },
  { t: 0.4, e: 'out', set: sym(-1.35, 0.3, -1.3, { py: 0.1, rx: -0.55 }, -0.45, 0.3) },
  // Drop into the squat, fists on the ground in front.
  { t: 0.56, e: 'io', set: sym(-0.3, 0, -0.45, { py: -0.44, rx: 0.55, pz: 0.1 }, -0.6, -0.85) },
  // RIP: heave down and back against the ground, then the slab comes loose.
  { t: 0.66, e: 'in', set: sym(-0.18, 0, -0.4, { py: -0.52, rx: 0.62, pz: 0.1 }, -0.65, -0.95) },
  // Lift: stand up with the slab.
  { t: 0.76, e: 'out', set: sym(-1.7, 0, -0.9, { py: -0.1, rx: 0.1 }, -0.25, -0.35) },
  // Overhead.
  { t: 0.86, e: 'io', set: sym(-2.75, 0, -0.35, { py: 0.06, rx: -0.4, pz: -0.04 }, -0.15, 0.15) },
  // Cock back behind the head.
  { t: 0.93, e: 'out', set: sym(-3.2, 0, -1.15, { py: 0.02, rx: -0.62 }, 0, 0.35) },
  // THE THROW: lunge, arms whip forward-up, opposite leg strides. Release at 1.00.
  { t: 1.0, e: 'in', set: sym(-1.75, 0, -0.2, { py: -0.1, rx: 0.25 }, 0.15, [-0.5, 0.45]) },
  // Follow-through: fold over the throw.
  { t: 1.12, e: 'out', set: sym(-0.25, 0, -0.3, { py: -0.22, rx: 0.62 }, 0.3, [-0.5, 0.45]) },
  { t: 1.28, e: 'io', set: sym(0.4, 0, -0.2, { py: -0.14, rx: 0.45 }, 0.2, [-0.25, 0.22]) },
  // Heavy breaths back to the idle stance.
  { t: 1.45, e: 'io', set: sym(0.12, 0, -0.05, { py: -0.03, rx: 0.16 }, 0.05, 0.05) },
  { t: 1.6, e: 'io', set: sym(0, 0, 0, { py: 0, rx: 0 }, 0, 0) },
];

const TRACK = buildTrack(GORILLA_CH, KEYS);

/** Decaying snap after an impulse at `tb` (0 before it). */
function snap(t: number, tb: number, tau: number): number {
  return t < tb ? 0 : Math.exp(-(t - tb) / tau);
}

/** Bump window (0 outside [a, b], 1 through the middle, cubic edges). */
function window(t: number, a: number, b: number, edge: number): number {
  if (t <= a || t >= b) return 0;
  const up = Math.min(1, (t - a) / edge);
  const down = Math.min(1, (b - t) / edge);
  const k = Math.min(up, down);
  return k * k * (3 - 2 * k);
}

/**
 * Sample the whole ultimate at `t` seconds since the cast into `out` (length ≥ GORILLA_CH.length).
 */
export function sampleGorillaUlt(t: number, out: Float64Array): void {
  sampleTrack(TRACK, t, out);
  // Chest beats: the torso jolts back, the head snaps, the fists recoil.
  let p = 0;
  for (let i = 0; i < K.beatAt.length; i++) p += snap(t, K.beatAt[i], 0.05);
  if (p > 0) {
    out[GC.bodyRx] -= 0.09 * p;
    out[GC.bodyPy] -= 0.035 * p;
    out[GC.headRx] += 0.14 * p;
    out[GC.aLRx] += 0.18 * p;
    out[GC.aRRx] += 0.18 * p;
  }
  // The rip: the whole ape shudders against the ground while the slab tears free.
  const shake = window(t, K.ripAt - 0.1, K.ripAt + 0.1, 0.06);
  if (shake > 0) {
    const s = Math.sin(t * 64);
    out[GC.bodyRz] += 0.04 * s * shake;
    out[GC.aLRy] += 0.06 * s * shake;
    out[GC.aRRy] -= 0.06 * s * shake;
    out[GC.bodyPy] += 0.03 * Math.cos(t * 58) * shake;
  }
  // Straining under the load while it is hoisted overhead.
  const strain = window(t, 0.74, K.windupS - 0.02, 0.08);
  if (strain > 0) out[GC.bodyRz] += 0.025 * Math.sin(t * 41) * strain;
  // Heavy breaths during the settle.
  const breath = window(t, 1.3, GORILLA_ULT_END, 0.12);
  if (breath > 0) {
    out[GC.bodyPy] += 0.014 * Math.sin((t - 1.3) * 13) * breath;
    out[GC.headRx] += 0.03 * Math.sin((t - 1.3) * 13 + 0.6) * breath;
  }
}
