/**
 * Panther — Shadow Execution pose timeline (v1.3 Phase 2). Pure functions of the state the sim publishes
 * (`actionT`, `ultPhase`, `ultStage`); the body teleports with each `blink` (the renderer snaps the root, this
 * module just keeps the pose continuous across it). Timeline (config/ultimates/panther.ts `PANTHER_EXEC`):
 *   0.00–0.35  melt into shadow: flatten into a coiled crouch (the opacity fade is the shared stealth buff)
 *   beat k = 0.35 + 0.22 k, claws land 0.08 s in — five DISTINCT slashes:
 *      1 rake · 2 overhead chop · 3 low sweep · 4 lunge-bite · 5 spinning double rake
 *   finisher 1.45: rears, hangs one breath, then a two-paw slam + snap at 1.61, follow-through to 1.85
 *   1.85–2.85  stalking recovery: low prowl that eases back to a stand
 * Every beat ends in (or ahead of) the next beat's pre-pose, so a blink never snaps the pose; the broken-sequence
 * case (victim gone, phase 'recovery' while the stage is still < 6) blends into the stalk over 0.15 s.
 */

import { PANTHER_EXEC as E, PANTHER_T_RECOVERY, pantherBlinkTime } from '../../../config/ultimates/panther';
import { buildTrack, rampT, sampleKeys, smooth, type KeyDef } from './lion';

export const PANTHER_CH_NAMES = [
  'bodyPy', 'bodyPz', 'bodyRx', 'bodyRy', 'bodyRz',
  'l0Rx', 'l0Rz', 'l1Rx', 'l1Rz', 'l2Rx', 'l2Rz', 'l3Rx', 'l3Rz',
  'neckRx', 'neckRy', 'headRx', 'headRy', 'headRz', 'jawRx',
  'tailRx', 'tailRy', 'tail2Rx', 'tail2Ry',
] as const;
export type PantherCh = (typeof PANTHER_CH_NAMES)[number];
export const PC = Object.fromEntries(PANTHER_CH_NAMES.map((n, i) => [n, i])) as Record<PantherCh, number>;

const B = [0, 1, 2, 3, 4, 5].map((k) => pantherBlinkTime(k)); // beat starts (5 = the finisher)
const IMP = 0.08; // claws land this long after a strike blink
const FIN_IMP = E.finisherImpactDelay;

const STRIKES: KeyDef<PantherCh>[] = [
  // 1 · rake — right (x+) paw, raised outside then raked across
  { t: B[0], e: 'io', set: { l1Rx: -1.9, l1Rz: 0.4, l0Rx: 0.4, bodyRy: -0.25, neckRy: 0.2, headRy: 0.15, bodyPy: -0.3, bodyRx: 0.15, bodyPz: 0, jawRx: 0.1, l2Rx: -0.5, l3Rx: -0.5 } },
  { t: B[0] + IMP, e: 'in', set: { l1Rx: -1.1, l1Rz: -0.45, bodyRy: 0.35, neckRy: -0.2, headRy: -0.25, bodyPz: 0.25, jawRx: 0.35 } },
  { t: B[0] + 0.15, e: 'out', set: { l1Rx: -0.7, l1Rz: -0.6, bodyRy: 0.45, bodyPz: 0.3 } },
  // 2 · overhead chop — left (x−) paw from high above
  { t: B[1], e: 'io', set: { l0Rx: -2.4, l0Rz: -0.15, l1Rx: 0.2, l1Rz: 0, bodyRy: 0, neckRy: 0, headRy: 0, bodyRx: -0.28, bodyPy: -0.05, bodyPz: 0, neckRx: -0.15, headRx: -0.3, jawRx: 0.2 } },
  { t: B[1] + IMP, e: 'in', set: { l0Rx: -0.65, bodyRx: 0.4, bodyPy: -0.38, bodyPz: 0.3, neckRx: 0.5, headRx: 0.3, jawRx: 0.5 } },
  { t: B[1] + 0.15, e: 'out', set: { l0Rx: -0.5, bodyRx: 0.32, bodyPz: 0.28 } },
  // 3 · low sweep — right paw skimming the ground, whole body whipping round
  { t: B[2], e: 'io', set: { bodyPy: -0.42, bodyRx: 0.25, bodyRy: -0.45, l0Rx: 0.3, l0Rz: 0, l1Rx: -0.85, l1Rz: 0.9, tailRy: -0.6, neckRx: 0.3, headRx: -0.1, jawRx: 0.1, bodyPz: 0 } },
  { t: B[2] + IMP, e: 'in', set: { bodyRy: 0.5, l1Rx: -0.95, l1Rz: -0.5, bodyPz: 0.22, tailRy: 0.7, headRy: -0.2 } },
  { t: B[2] + 0.15, e: 'out', set: { bodyRy: 0.6, l1Rz: -0.7, headRy: -0.25 } },
  // 4 · lunge-bite — springs off the hind legs, both forepaws reaching, jaws snap
  { t: B[3], e: 'io', set: { bodyPz: -0.1, bodyPy: -0.36, bodyRx: 0.3, bodyRy: 0, tailRy: 0, headRy: 0, l0Rx: 0.3, l0Rz: 0, l1Rx: 0.3, l1Rz: 0, l2Rx: -0.6, l3Rx: -0.6, neckRx: 0.05, headRx: -0.1, jawRx: 0.85 } },
  { t: B[3] + IMP, e: 'in', set: { bodyPz: 0.5, bodyPy: -0.2, bodyRx: 0.2, l0Rx: -1.25, l1Rx: -1.25, l2Rx: 0.9, l3Rx: 0.9, neckRx: 0.45, headRx: 0.3, jawRx: 0 } },
  { t: B[3] + 0.15, e: 'out', set: { bodyPz: 0.4, l0Rx: -0.9, l1Rx: -0.9, jawRx: 0.1 } },
  // 5 · spinning double rake — a full twist of the torso, both paws out then across
  { t: B[4], e: 'io', set: { bodyRy: 0.7, bodyPz: 0, bodyPy: -0.25, bodyRx: 0.2, l0Rx: -1.7, l0Rz: -0.4, l1Rx: -1.2, l1Rz: 0.4, l2Rx: 0.1, l3Rx: 0.1, neckRx: 0.1, jawRx: 0.15, tailRy: 0.5 } },
  { t: B[4] + IMP, e: 'in', set: { bodyRy: -0.7, l0Rx: -1.3, l0Rz: 0.5, l1Rx: -1.3, l1Rz: -0.3, headRy: 0.3, bodyPz: 0.2, tailRy: -0.6 } },
  { t: B[4] + 0.15, e: 'out', set: { bodyRy: -0.85, l0Rz: 0.6, headRy: 0.35 } },
  // finisher — rears, hangs, two-paw slam + snap, long follow-through
  { t: B[5], e: 'io', set: { bodyRx: -0.55, bodyPy: 0.12, bodyPz: -0.1, bodyRy: 0, headRy: 0, tailRy: 0, l0Rx: -2.3, l0Rz: -0.25, l1Rx: -2.3, l1Rz: 0.25, l2Rx: 0.6, l3Rx: 0.6, neckRx: -0.3, headRx: -0.35, jawRx: 0.8, tailRx: -0.3 } },
  { t: B[5] + 0.1, e: 'out', set: { bodyRx: -0.7, bodyPy: 0.16, l0Rx: -2.45, l1Rx: -2.45, jawRx: 0.95 } },
  { t: B[5] + FIN_IMP, e: 'in', set: { l0Rx: -0.6, l0Rz: 0.1, l1Rx: -0.6, l1Rz: -0.1, bodyRx: 0.45, bodyPy: -0.38, bodyPz: 0.4, neckRx: 0.55, headRx: 0.4, jawRx: 0, tailRx: 0.6 } },
  { t: B[5] + 0.27, e: 'out', set: { bodyPy: -0.3, bodyPz: 0.32, bodyRx: 0.36, jawRx: 0.2, l0Rx: -0.5, l1Rx: -0.5 } },
  { t: PANTHER_T_RECOVERY, e: 'io', set: { bodyPy: -0.26, bodyPz: 0.1, bodyRx: 0.2, l0Rx: -0.4, l0Rz: 0, l1Rx: -0.4, l1Rz: 0, l2Rx: 0.25, l3Rx: 0.25, neckRx: 0.3, headRx: -0.1, jawRx: 0.05, tailRx: 0.35 } },
];

const MAIN_KEYS: KeyDef<PantherCh>[] = [
  { t: 0, set: {} },
  // melt into shadow: flatten and coil
  { t: 0.18, e: 'out', set: { bodyPy: -0.22, bodyRx: 0.1, l0Rx: 0.4, l1Rx: 0.4, l2Rx: -0.5, l3Rx: -0.5, neckRx: 0.3, headRx: -0.25, tailRx: 0.3 } },
  { t: E.windup - 0.07, e: 'io', set: { bodyPy: -0.34, bodyRx: 0.18, l0Rx: 0.55, l1Rx: 0.55, l2Rx: -0.75, l3Rx: -0.75, neckRx: 0.34, headRx: -0.3, tailRx: 0.35 } },
  ...STRIKES,
];

/** The stalk: relative time τ from the moment the panther reappears (τ = 0 is the recovery pose). */
const STALK_KEYS: KeyDef<PantherCh>[] = [
  { t: 0, set: { bodyPy: -0.26, bodyPz: 0.1, bodyRx: 0.2, l0Rx: -0.4, l1Rx: -0.4, l2Rx: 0.25, l3Rx: 0.25, neckRx: 0.3, headRx: -0.1, jawRx: 0.05, tailRx: 0.35 } },
  { t: 0.3, e: 'out', set: { bodyPy: -0.22, bodyPz: 0, bodyRx: 0.12, l0Rx: -0.1, l0Rz: 0, l1Rx: 0.15, l1Rz: 0, l2Rx: 0.2, l3Rx: -0.1, neckRx: 0.25, headRx: -0.15, jawRx: 0, tailRx: 0.3 } },
  { t: E.recovery, e: 'io', set: { bodyPy: -0.03, bodyPz: 0, bodyRx: 0, bodyRy: 0, l0Rx: 0, l1Rx: 0, l2Rx: 0, l3Rx: 0, neckRx: 0, headRx: 0, tailRx: 0 } },
];

const MAIN = buildTrack(PANTHER_CH_NAMES, {}, MAIN_KEYS);
const STALK = buildTrack(PANTHER_CH_NAMES, {}, STALK_KEYS);
const _a = new Float64Array(PANTHER_CH_NAMES.length);
const _b = new Float64Array(PANTHER_CH_NAMES.length);

/**
 * Write the panther's ultimate pose into `out` (length = PANTHER_CH_NAMES.length). `phase`/`stage` are the
 * snapshot's `ultPhase`/`ultStage` (either may be undefined, e.g. the animals demo).
 */
export function samplePantherUlt(t: number, phase: 'windup' | 'active' | 'recovery' | undefined, stage: number | undefined, out: Float64Array): void {
  // When does the stalk begin? Normally at the finisher's end; a broken sequence starts it at the beat it broke on.
  const broken = phase === 'recovery' && stage !== undefined && stage < E.stage.finisher;
  const r0 = broken ? B[Math.min(stage as number, 5)] : PANTHER_T_RECOVERY;
  if (t >= r0 && (phase === 'recovery' || phase === undefined)) {
    sampleKeys(MAIN, r0, _a);
    sampleKeys(STALK, t - r0, _b);
    const k = smooth((t - r0) / 0.15);
    for (let i = 0; i < out.length; i++) out[i] = _a[i] + (_b[i] - _a[i]) * k;
    // Prowl overlay: slow head sweep, restless tail, breathing.
    const pr = smooth(rampT(t - r0, 0.15, 0.4)) * (1 - smooth(rampT(t - r0, E.recovery - 0.25, E.recovery)));
    out[PC.headRy] += Math.sin(t * 2.2) * 0.3 * pr;
    out[PC.tailRy] += Math.sin(t * 2.6) * 0.35 * pr;
    out[PC.tail2Ry] += Math.sin(t * 2.6 - 1) * 0.5 * pr;
    out[PC.bodyPy] += Math.sin(t * 5) * 0.008 * pr;
    return;
  }
  sampleKeys(MAIN, t, out);
  // Shadow shiver while the darkness gathers.
  const melt = smooth(rampT(t, 0.04, 0.2)) * (1 - smooth(rampT(t, E.windup, E.windup + 0.06)));
  out[PC.bodyRz] += Math.sin(t * 48) * 0.022 * melt;
  out[PC.tailRy] += Math.sin(t * 14) * 0.45 * melt;
  out[PC.tail2Ry] += Math.sin(t * 14 - 1) * 0.6 * melt;
  // The tail whips with every strike (counter-balance), keyed to the strike cadence.
  const strikes = smooth(rampT(t, B[0], B[0] + 0.05)) * (1 - smooth(rampT(t, B[5], B[5] + 0.05)));
  out[PC.tail2Ry] += Math.sin((t - B[0]) / E.strikeGap * Math.PI * 2) * 0.5 * strikes;
}
