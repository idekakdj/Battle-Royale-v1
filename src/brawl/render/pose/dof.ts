/**
 * Champions League pose layer — canonical degrees of freedom (DOFs).
 *
 * Every archetype / state pose is authored as a vector of these animal-independent DOFs. A per-animal
 * {@link AnimalProfile} (profile.ts) maps each DOF onto concrete rig joint channels (name, axis, sign, scale), so one
 * generator works for all ten rigs and only the profile knows the anatomy.
 *
 * Conventions (the "facing +1" frame — the camera sees the fighter's NEAR side; the mirror for facing −1 is automatic):
 *  - angles are radians, translations metres;
 *  - `*Pitch`: + = up (nose up / head up / tail up); `bodyYaw`/`neckYaw`/`headYaw`/`tailYaw`: + = the NEAR side moves
 *    forward / the head turns toward the near side… see each DOF below;
 *  - limb DOFs: `Swing` + = forward & up in the sagittal plane, `Spread` + = outward (away from the body), `Bend` + = flex
 *    (hand toward the shoulder);
 *  - `Near` = the limb on the camera side when facing +1 (the anatomical RIGHT limb = the rig's local −X side); `Far` = the
 *    other one. When the fighter faces −1 the whole pose is mirrored (limb pairs swapped, lateral rotations flipped).
 */

export const DOF_NAMES = [
  // body
  'bodyPitch', // + = nose up (rear up)
  'bodyYaw', // + = near side forward (twist about the vertical axis)
  'bodyRoll', // + = tilt toward the near side (near side down)
  'bodyFwd', // m, + = forward
  'bodyUp', // m, + = up (negative = crouch)
  'bodyStretch', // uniform scale delta (0 = rest)
  'rootSquash', // whole-rig squash about the feet (+ = squash down & widen, − = stretch); root-level, not a joint
  // neck / head
  'neckPitch', // + = up
  'neckYaw', // + = toward the near side
  'headPitch', // + = up
  'headYaw', // + = toward the near side
  'headRoll', // + = ear toward the near side
  'jaw', // + = open
  // tail
  'tailPitch', // + = up
  'tailYaw', // + = toward the near side
  'tail2Pitch',
  'tail2Yaw',
  // forelimbs (arms / front legs)
  'foreNearSwing',
  'foreNearSpread',
  'foreNearBend',
  'foreFarSwing',
  'foreFarSpread',
  'foreFarBend',
  // hind limbs
  'hindNearSwing',
  'hindNearSpread',
  'hindNearBend',
  'hindFarSwing',
  'hindFarSpread',
  'hindFarBend',
  // wings
  'wingNearFlap', // + = raised
  'wingNearFold', // + = swept forward / extended, − = folded back
  'wingFarFlap',
  'wingFarFold',
  // anatomy-specific extras (per-animal profiles map them; generic profiles leave them unmapped)
  'neckExt', // neck / body lengthening (giraffe neck, python reach)
  'bodyCurl', // serpentine curl / ball-up
] as const;

export type DofName = (typeof DOF_NAMES)[number];

export const DOF_N = DOF_NAMES.length;

/** DOF name → index. */
export const DOF: Readonly<Record<DofName, number>> = (() => {
  const o = {} as Record<DofName, number>;
  DOF_NAMES.forEach((n, i) => {
    o[n] = i;
  });
  return o;
})();

/** A pose in DOF space. */
export type DofVec = Float64Array;

export type DofPartial = Partial<Record<DofName, number>>;

export function newVec(): DofVec {
  return new Float64Array(DOF_N);
}

/** Build a vector from a sparse record. */
export function vecOf(p: DofPartial): DofVec {
  const v = newVec();
  for (const k in p) v[DOF[k as DofName]] = p[k as DofName] as number;
  return v;
}

export function copyVec(src: DofVec, dst: DofVec = newVec()): DofVec {
  dst.set(src);
  return dst;
}

/** dst = a + (b − a) × t. */
export function lerpVec(a: DofVec, b: DofVec, t: number, dst: DofVec): DofVec {
  for (let i = 0; i < DOF_N; i++) dst[i] = a[i] + (b[i] - a[i]) * t;
  return dst;
}

/** v += p (sparse). */
export function addPartial(v: DofVec, p: DofPartial, k = 1): DofVec {
  for (const key in p) v[DOF[key as DofName]] += (p[key as DofName] as number) * k;
  return v;
}

/** Swap the near/far limb DOFs of a vector (used to strike with the far limb) and flip lateral DOFs. */
const NEAR_FAR: readonly (readonly [DofName, DofName])[] = [
  ['foreNearSwing', 'foreFarSwing'],
  ['foreNearSpread', 'foreFarSpread'],
  ['foreNearBend', 'foreFarBend'],
  ['hindNearSwing', 'hindFarSwing'],
  ['hindNearSpread', 'hindFarSpread'],
  ['hindNearBend', 'hindFarBend'],
  ['wingNearFlap', 'wingFarFlap'],
  ['wingNearFold', 'wingFarFold'],
];
const LATERAL: readonly DofName[] = ['bodyYaw', 'bodyRoll', 'neckYaw', 'headYaw', 'headRoll', 'tailYaw', 'tail2Yaw'];

/** The same pose seen from the other side: near ↔ far limbs swapped, lateral DOFs negated. */
export function swapSides(v: DofVec, dst: DofVec = newVec()): DofVec {
  if (dst !== v) dst.set(v);
  for (const [a, b] of NEAR_FAR) {
    const ia = DOF[a];
    const ib = DOF[b];
    const t = v[ia];
    dst[ia] = v[ib];
    dst[ib] = t;
  }
  for (const n of LATERAL) dst[DOF[n]] = -v[DOF[n]];
  return dst;
}
