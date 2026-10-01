/**
 * Shared helpers for first-person profiles (v1.3 WP-Q). Pure maths on top of
 * {@link FpLimb} placements: profiles describe WHERE a paw / claw / talon tip
 * should be in camera space; these helpers turn that into a limb pin.
 */

import type { FpLimb, FpPoseCtx } from './types';
import { attackCurve, impactPulse, ramp, smooth01, IMPACT } from '../Animator';

export { attackCurve, impactPulse, ramp, smooth01, IMPACT };

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Limb pin from a TIP target: the shaft (`len` metres, along the joint's local
 * −Y) ends at (tx, ty, tz) in eye space (x right, y up, z forward), pointing
 * `down` rad below the horizon and `out` rad to the right. The shoulder pivot
 * is derived so the tip lands where asked.
 */
export function tipLimb(len: number, tx: number, ty: number, tz: number, down: number, out: number, roll = 0, w = 1): FpLimb {
  const cd = Math.cos(down);
  return {
    x: tx - Math.sin(out) * cd * len,
    y: ty + Math.sin(down) * len,
    z: tz - Math.cos(out) * cd * len,
    down,
    out,
    roll,
    w,
  };
}

/** A tip target: position in eye space + shaft angles. */
export interface Tip {
  x: number;
  y: number;
  z: number;
  down: number;
  out?: number;
  roll?: number;
}

export function mixTip(a: Tip, b: Tip, t: number): Tip {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    z: lerp(a.z, b.z, t),
    down: lerp(a.down, b.down, t),
    out: lerp(a.out ?? 0, b.out ?? 0, t),
    roll: lerp(a.roll ?? 0, b.roll ?? 0, t),
  };
}

/** Mirror a tip for the screen-left limb (x, out, roll flip). */
export function mirrorTip(t: Tip): Tip {
  return { x: -t.x, y: t.y, z: t.z, down: t.down, out: -(t.out ?? 0), roll: -(t.roll ?? 0) };
}

export function pin(c: FpPoseCtx, joint: string, len: number, t: Tip, w = 1): void {
  c.limb(joint, tipLimb(len, t.x, t.y, t.z, t.down, t.out ?? 0, t.roll ?? 0, w));
}

/** Reference view the edge viewmodels are authored against: 85 degree horizontal FOV at 16:9 (the defaults). */
const REF_TAN_H = Math.tan((85 / 2) * (Math.PI / 180));
const REF_TAN_V = REF_TAN_H / (16 / 9);

/**
 * A tip target from SCREEN coordinates of the reference view: `nx` / `ny` are NDC (−1..1, +x right, +y up) of the tip at
 * `depth` metres ahead of the eye. Authoring aid for viewmodels that must hug the screen edges (the clear-view animals).
 */
export function edgeTip(nx: number, ny: number, depth: number, down: number, out = 0, roll = 0): Tip {
  return { x: nx * depth * REF_TAN_H, y: ny * depth * REF_TAN_V, z: depth, down, out, roll };
}

/**
 * Pull body joints toward their rest pose (`k` 0 = fully at rest, 1 = unchanged): lunges, rears and pitches would otherwise
 * swing the barrel / shoulders / hips up around the eye of a low-slung animal. Run after the shared pose.
 */
export function calmJoints(c: FpPoseCtx, names: readonly string[], k: number): void {
  for (const n of names) {
    const j = c.j(n);
    if (j === undefined) continue;
    j.rx *= k;
    j.ry *= k;
    j.rz *= k;
    j.px *= k;
    j.py *= k;
    j.pz *= k;
  }
}

/** Options for the shared two-forelimb (paws / arms / claws) viewmodel. */
export interface PawOpts {
  /** Limb shaft length (m). */
  len: number;
  /** Joint names: screen-right and screen-left forelimb. */
  right: string;
  left: string;
  /** Resting tip of the RIGHT limb (the left mirrors it). */
  rest: Tip;
  /** Run: forward reach per stride (m), lift (m) and extra down-angle swing (rad). */
  runReach: number;
  runLift: number;
  /** Windup / strike tips of the RIGHT limb's swipe (the left mirrors it). */
  swipeWind: Tip;
  swipeHit: Tip;
  /** Both-limb lunge tip (attack3 / special impact) for the RIGHT limb; left mirrors. */
  lunge: Tip;
  /** Guard tip for block (RIGHT limb; left mirrors). */
  guard: Tip;
  /** Optional attack3 windup tip (RIGHT limb; left mirrors), e.g. fists raised overhead for a slam. */
  wind3?: Tip;
  /** Which limb strikes on attack1 / attack2: 'right' | 'left'. */
  first: 'right' | 'left';
  /** Uniform scale of the pinned limbs (default 1): the clear-view animals use small, edge-hugging limbs. */
  scale?: number;
  /** Airborne (jump / fall) tip of the RIGHT limb (left mirrors): held still instead of striding. Default: the run stride. */
  air?: Tip;
}

/**
 * Shared forelimb viewmodel for the paw / arm animals: idle rest at the lower
 * corners, run stride, alternating swipes (attack1/2), a two-limb lunge
 * (attack3 / special / grab), and a raised guard (block). Anything else
 * (hit, knockdown, dead, ultimate …) leaves the limbs on the body.
 */
export function pawPose(c: FpPoseCtx, o: PawOpts): void {
  const s = attackCurve(c.u);
  const act = c.action;
  const t = c.t;
  const right: Tip = { ...o.rest };
  const left: Tip = mirrorTip(o.rest);
  let wR = 1;
  let wL = 1;
  let rightTip = right;
  let leftTip = left;

  if (act === 'idle' || (act === 'run' && c.run < 0.05)) {
    const b = Math.sin(t * 1.7) * 0.012;
    rightTip = { ...right, y: right.y + b };
    leftTip = { ...left, y: left.y + b };
  } else if (act === 'jump' && o.air !== undefined) {
    rightTip = { ...o.air };
    leftTip = mirrorTip(o.air);
  } else if (act === 'run' || act === 'jump') {
    const k = act === 'run' ? c.run : 0.5;
    const pR = c.gait;
    const pL = c.gait + Math.PI;
    const strideR = Math.sin(pR);
    const strideL = Math.sin(pL);
    rightTip = {
      ...right,
      z: right.z + strideR * o.runReach * k,
      y: right.y + Math.max(0, strideR) * o.runLift * k,
      down: right.down - strideR * 0.25 * k,
    };
    leftTip = {
      ...left,
      z: left.z + strideL * o.runReach * k,
      y: left.y + Math.max(0, strideL) * o.runLift * k,
      down: left.down - strideL * 0.25 * k,
    };
  } else if (act === 'attack1' || act === 'attack2') {
    const strikeRight = (act === 'attack1') === (o.first === 'right');
    const wind = strikeRight ? o.swipeWind : mirrorTip(o.swipeWind);
    const hit = strikeRight ? o.swipeHit : mirrorTip(o.swipeHit);
    const rest = strikeRight ? right : left;
    const tip = s < 0 ? mixTip(rest, wind, -s / 0.45) : mixTip(rest, hit, s);
    if (strikeRight) rightTip = tip;
    else leftTip = tip;
  } else if (act === 'attack3' || act === 'grab') {
    const k = act === 'grab' ? 1 : Math.max(0, s);
    const wind = s < 0 ? -s / 0.45 : 0;
    // A slam-style windup (e.g. fists overhead) holds through the wind-up and blends into the strike.
    const w3 = o.wind3 !== undefined && act === 'attack3' ? smooth01(ramp(c.u, 0, 0.36)) : 0;
    const back = o.wind3 ?? { ...right, z: right.z - 0.25, y: right.y - 0.15 };
    const backL = o.wind3 !== undefined ? mirrorTip(o.wind3) : { ...left, z: left.z - 0.25, y: left.y - 0.15 };
    const pre = o.wind3 !== undefined ? w3 * (1 - k) : wind;
    rightTip = mixTip(mixTip(right, back, pre), o.lunge, k);
    leftTip = mixTip(mixTip(left, backL, pre), mirrorTip(o.lunge), k);
  } else if (act === 'special') {
    const air = smooth01(ramp(c.u, 0.26, 0.44)) * (1 - smooth01(ramp(c.u, IMPACT, 0.72)));
    const land = impactPulse(c.u, 0.08);
    const k = Math.max(air, land);
    rightTip = mixTip(right, o.lunge, k);
    leftTip = mixTip(left, mirrorTip(o.lunge), k);
  } else if (act === 'block') {
    rightTip = { ...o.guard, y: o.guard.y + Math.sin(t * 2) * 0.01 };
    leftTip = mirrorTip(rightTip);
  } else if (act === 'hit' || act === 'stagger') {
    const k = 1 - smooth01(c.u);
    rightTip = { ...right, z: right.z - 0.12 * k, y: right.y - 0.1 * k };
    leftTip = { ...left, z: left.z - 0.12 * k, y: left.y - 0.1 * k };
  } else {
    wR = 0;
    wL = 0; // ultimate / knockdown / dead / grabbed …: paws stay on the body
  }
  const sc = o.scale ?? 1;
  if (sc !== 1) {
    c.J(o.right).s = sc;
    c.J(o.left).s = sc;
  }
  if (wR > 0) pin(c, o.right, o.len * sc, rightTip, wR);
  if (wL > 0) pin(c, o.left, o.len * sc, leftTip, wL);
}
