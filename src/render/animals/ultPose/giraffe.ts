/**
 * Giraffe — Timber Fall pose timeline (v1.3 Phase 2). A pure function of the fighter state the sim publishes
 * (`actionT`, `actionDur`): no internal clocks, so the pose is stable however the root moves, and every segment
 * is cubic-eased.
 *
 * The sim's timeline is FIXED up to the impact (config/ultimates/giraffe.ts `GIRAFFE_TIMBER`: windup 1.1 s
 * = 0.6 s tracking + 0.5 s committed, then the 0.14 s slam); the recovery length depends on whether the slam hit,
 * so the sim restarts `actionDur` at the impact (`actionDur = actionT + recovery`) and the recovery keys below are
 * stretched over `actionDur - impactT`:
 *   0.00–0.60  the neck is whipped back and up, head high, hooves planted (forelegs braced, weight on the haunches)
 *   0.60–1.06  the held tension beat: a trembling wind-up of the whole neck (the circle is committed)
 *   1.06–1.10  the final coil, a hair further back
 *   1.10–1.24  THE SLAM: the neck arcs over and down like a felled tree (neck, then neck tip, then head whipping),
 *              the forelegs buckle and the body drops onto them
 *   1.24+      follow-through: a head bounce off the ground, a dazed low hold (a whiff searches side to side), then the
 *              neck rises and the body straightens back to the idle stance
 * `sampleGiraffeUlt` writes the joint channels into a Float64Array (indices `TC`).
 */

import { GIRAFFE_TIMBER as K } from '../../../config/ultimates/giraffe';
import { buildTrack, sampleTrack, type KeyDef, type Track } from './gorilla';

export const GIRAFFE_CH = [
  'bodyPy', 'bodyPz', 'bodyRx', 'bodyRy', 'bodyRz',
  'n1Rx', 'n1Rz', 'n2Rx', 'n2Rz', 'headRx', 'headRz',
  'lFRx', 'lBRx', 'legRz',
  'tailRx',
] as const;
export type GiraffeChannel = (typeof GIRAFFE_CH)[number];

/** Channel indices. */
export const TC = Object.fromEntries(GIRAFFE_CH.map((n, i) => [n, i])) as Record<GiraffeChannel, number>;

/** Seconds since the cast at which the neck lands. */
export const GIRAFFE_IMPACT_T = K.windupS + K.slamS;

type KD = KeyDef<GiraffeChannel>;

function pose(
  n1: number, n2: number, head: number,
  body: { py: number; rx: number; pz?: number }, front: number, back: number,
  extra: Partial<Record<GiraffeChannel, number>> = {},
): Partial<Record<GiraffeChannel, number>> {
  return {
    bodyPy: body.py, bodyPz: body.pz ?? 0, bodyRx: body.rx, bodyRy: 0, bodyRz: 0,
    n1Rx: n1, n1Rz: 0, n2Rx: n2, n2Rz: 0, headRx: head, headRz: 0,
    lFRx: front, lBRx: back, legRz: 0,
    tailRx: 0,
    ...extra,
  };
}

/** Pre-impact keys (absolute seconds since the cast). */
const PRE: readonly KD[] = [
  { t: 0.0, set: pose(0, 0, 0, { py: 0, rx: 0 }, 0, 0) },
  // The neck starts to swing back, weight shifting onto the haunches.
  { t: 0.18, e: 'out', set: pose(-0.25, -0.12, -0.1, { py: -0.02, rx: -0.07 }, -0.14, 0.1) },
  // Whipped far back, head high, forelegs planted wide.
  { t: 0.5, e: 'io', set: pose(-0.55, -0.28, -0.2, { py: -0.05, rx: -0.18 }, -0.3, 0.16, { legRz: 0.06, tailRx: -0.3 }) },
  // COMMIT: the circle freezes; the pull goes on.
  { t: 0.6, e: 'io', set: pose(-0.65, -0.32, -0.28, { py: -0.06, rx: -0.22 }, -0.32, 0.18, { legRz: 0.08, tailRx: -0.4 }) },
  // The held tension beat (a slow creep further back; the tremble is an overlay).
  { t: 1.06, e: 'lin', set: pose(-0.72, -0.36, -0.32, { py: -0.08, rx: -0.25 }, -0.36, 0.2, { legRz: 0.1, tailRx: -0.55 }) },
  // The final coil.
  { t: 1.1, e: 'out', set: pose(-0.84, -0.42, -0.36, { py: -0.08, rx: -0.3 }, -0.38, 0.22, { legRz: 0.1, tailRx: -0.6 }) },
  // THE SLAM: over and down, forelegs buckle, the body drops onto them.
  { t: GIRAFFE_IMPACT_T, e: 'in', set: pose(1.22, 0.6, 0.7, { py: -0.3, rx: 0.28, pz: 0.05 }, -0.85, 0.38, { legRz: 0.12, tailRx: 0.4 }) },
];

const PRE_TRACK: Track = buildTrack(GIRAFFE_CH, PRE);

/** Post-impact keys: normalised recovery time u ∈ [0, 1] (head bounce, dazed low hold, rise). */
const POST: readonly KD[] = [
  { t: 0.0, set: pose(1.22, 0.6, 0.7, { py: -0.3, rx: 0.28, pz: 0.05 }, -0.85, 0.38, { legRz: 0.12, tailRx: 0.4 }) },
  // The head bounces back off the ground.
  { t: 0.12, e: 'out', set: pose(0.82, 0.38, 0.32, { py: -0.2, rx: 0.17 }, -0.65, 0.3, { legRz: 0.1, tailRx: 0.2 }) },
  // …and settles dazed and low.
  { t: 0.27, e: 'io', set: pose(1.0, 0.5, 0.56, { py: -0.22, rx: 0.22 }, -0.6, 0.3, { legRz: 0.09, tailRx: 0.1 }) },
  { t: 0.56, e: 'io', set: pose(0.92, 0.46, 0.5, { py: -0.2, rx: 0.2 }, -0.55, 0.26, { legRz: 0.07 }) },
  // Rising.
  { t: 0.86, e: 'io', set: pose(0.2, 0.1, 0.1, { py: -0.04, rx: 0.05 }, -0.1, 0.06) },
  { t: 1.0, e: 'io', set: pose(0, 0, 0, { py: 0, rx: 0 }, 0, 0) },
];

const POST_TRACK: Track = buildTrack(GIRAFFE_CH, POST);

function window(t: number, a: number, b: number, edge: number): number {
  if (t <= a || t >= b) return 0;
  const k = Math.min(1, (t - a) / edge, (b - t) / edge);
  return k * k * (3 - 2 * k);
}

/**
 * Sample the ultimate at `t` seconds since the cast (`dur` = the current `actionDur`) into `out`
 * (length ≥ GIRAFFE_CH.length).
 */
export function sampleGiraffeUlt(t: number, dur: number, out: Float64Array): void {
  if (t < GIRAFFE_IMPACT_T) {
    sampleTrack(PRE_TRACK, t, out);
    // The held tension: the whole neck trembles, growing toward the slam.
    const w = window(t, 0.6, 1.1, 0.12);
    if (w > 0) {
      const g = (t - 0.6) / 0.5;
      out[TC.n1Rx] += Math.sin(t * 43) * 0.014 * (0.4 + g) * w;
      out[TC.n2Rx] += Math.sin(t * 37 + 1.1) * 0.02 * (0.4 + g) * w;
      out[TC.headRx] += Math.sin(t * 51 + 0.4) * 0.03 * (0.4 + g) * w;
      out[TC.n1Rz] += Math.sin(t * 29) * 0.012 * w;
    }
    return;
  }
  const recDur = Math.max(0.45, dur - GIRAFFE_IMPACT_T);
  const tau = t - GIRAFFE_IMPACT_T;
  const u = tau / recDur;
  sampleTrack(POST_TRACK, u, out);
  // Impact shudder: the whole tower quivers for a moment.
  const shudder = Math.exp(-tau / 0.09);
  out[TC.bodyRz] += Math.sin(tau * 60) * 0.03 * shudder;
  out[TC.n1Rz] += Math.sin(tau * 52 + 0.5) * 0.06 * shudder;
  // A whiff (the long recovery) searches left and right with the head while it lies low.
  if (recDur > 0.8) {
    const k = window(u, 0.22, 0.8, 0.14);
    out[TC.n2Rz] += Math.sin(tau * 7.5) * 0.22 * k;
    out[TC.headRz] += Math.sin(tau * 7.5 + 0.6) * 0.18 * k;
  }
}
