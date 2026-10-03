/**
 * HIPPO limb-role profile (rig: src/render/animals/Hippo.ts) — WP-A2.
 *
 * Joints: body (pivot y 0.98), head (pivot z 0.95 on the body, no neck), jaw (child of head, hinge at the back of the maw),
 * legs.0..3 (FL −X, FR +X, HL −X, HR +X; pillars of 0.62 m hanging from y 0.62), tail (paddle, rest rx 0.9).
 * Conventions verified against the rig (same as the lion): body +rx pitches the nose DOWN, head +rx dips the head, jaw +rx opens, a leg's
 * +rx swings the foot BACK (forward = −rx), tail +rx lifts the tail, the rest-tilted tail swings sideways about its local z.
 *
 * Anatomy specials: Mighty Yawn / Charging Gape use a GIGANTIC gape (jaw to ≈ 1.4 rad, head tipped back), the belly flop rears up on
 * the hind legs first (forefeet tucked, hind legs counter-rotated so they stay planted) and drops belly-first, the belly bump leans the
 * shoulder / chest in rather than butting with the head.
 */

import type { AnimalProfile, ArchSpec } from '../profile';
import { registerProfile } from '../profile';
import { ARCHETYPES } from '../archetypes';

type Ctx = Parameters<typeof ARCHETYPES.bite>[0];

/** heavyN Mighty Yawn: the head rears back, the maw opens to a gigantic gape and stays open until just before it snaps shut. */
function yawn(c: Ctx): ArchSpec {
  const s = ARCHETYPES.bite(c);
  const a0 = s.A;
  s.A = (b) => ({
    ...a0(b),
    jaw: 1.35,
    headPitch: 0.5,
    neckPitch: 0.22,
    bodyPitch: 0.2,
    bodyUp: 0.03,
    bodyFwd: -0.12,
    foreNearSwing: -0.12,
    foreFarSwing: -0.12,
  });
  const p0 = s.pre?.[0];
  if (p0 !== undefined) s.pre = [{ before: 3, v: (b) => ({ ...p0.v(b), jaw: 1.3, headPitch: 0.3 }) }];
  s.over = 0.04;
  return s;
}

/** heavyS Charging Gape: the maw is wide open through the charge and clamps on the hit. */
function gape(c: Ctx): ArchSpec {
  const s = ARCHETYPES.lunge(c);
  const a0 = s.A;
  s.A = (b) => ({ ...a0(b), jaw: 1.2, headPitch: 0.15 });
  s.B = { ...s.B, jaw: 0.6 };
  return s;
}

/** lightS Belly Bump: the chest / shoulder leans in, the head swings the other way as a counter-weight. */
function bellyBump(): ArchSpec {
  return {
    tip: 'body',
    B: { bodyFwd: 0.4, bodyYaw: 0.3, bodyPitch: -0.06, bodyUp: -0.03, headYaw: -0.35, neckYaw: -0.2, foreNearSwing: 0.5, hindNearSwing: -0.4, hindFarSwing: -0.3 },
    free: [
      { d: 'bodyFwd', lo: 0, hi: 0.7 },
      { d: 'bodyYaw', lo: -0.1, hi: 0.6 },
      { d: 'bodyPitch', lo: -0.2, hi: 0.2 },
    ],
    A: () => ({ bodyFwd: -0.12, bodyYaw: -0.3, bodyUp: -0.04, headYaw: 0.3, foreNearSwing: -0.15, hindNearSwing: 0.2, tailPitch: 0.2 }),
    over: 0.1,
  };
}

/** heavyD Belly Flop: rears up on the hind legs (forefeet tucked), drops belly-first. */
function bellyFlop(c: Ctx): ArchSpec {
  const s = ARCHETYPES.bellyFlop(c);
  s.A = () => ({
    bodyPitch: 0.6,
    bodyUp: 0.14,
    bodyFwd: -0.1,
    hindNearSwing: -0.6,
    hindFarSwing: -0.6,
    foreNearSwing: 1.0,
    foreFarSwing: 1.0,
    foreNearSpread: 0.15,
    foreFarSpread: 0.15,
    headPitch: 0.3,
    neckPitch: 0.15,
    jaw: 0.4,
    tailPitch: 0.3,
  });
  s.over = 0.06;
  return s;
}

export const hippoProfile: AnimalProfile = {
  animal: 'hippo',
  links: {
    bodyPitch: [{ j: 'body', ch: 'rx', k: -1 }],
    bodyYaw: [{ j: 'body', ch: 'ry', k: 1 }],
    bodyRoll: [{ j: 'body', ch: 'rz', k: 1 }],
    bodyFwd: [{ j: 'body', ch: 'pz', k: 1 }],
    bodyUp: [{ j: 'body', ch: 'py', k: 1 }],
    bodyStretch: [{ j: 'body', ch: 's', k: 1 }],
    neckPitch: [{ j: 'head', ch: 'rx', k: -0.6 }],
    neckYaw: [{ j: 'head', ch: 'ry', k: -0.5 }],
    headPitch: [{ j: 'head', ch: 'rx', k: -1 }],
    headYaw: [{ j: 'head', ch: 'ry', k: -1 }],
    headRoll: [{ j: 'head', ch: 'rz', k: 1 }],
    jaw: [{ j: 'jaw', ch: 'rx', k: 1 }],
    tailPitch: [{ j: 'tail', ch: 'rx', k: 1 }],
    tailYaw: [{ j: 'tail', ch: 'rz', k: -1 }],
    foreNearSwing: [{ j: 'legs.0', ch: 'rx', k: -1 }],
    foreNearSpread: [{ j: 'legs.0', ch: 'rz', k: -1 }],
    foreFarSwing: [{ j: 'legs.1', ch: 'rx', k: -1 }],
    foreFarSpread: [{ j: 'legs.1', ch: 'rz', k: 1 }],
    hindNearSwing: [{ j: 'legs.2', ch: 'rx', k: -1 }],
    hindNearSpread: [{ j: 'legs.2', ch: 'rz', k: -1 }],
    hindFarSwing: [{ j: 'legs.3', ch: 'rx', k: -1 }],
    hindFarSpread: [{ j: 'legs.3', ch: 'rz', k: 1 }],
  },
  tips: {
    foreNear: { j: 'legs.0', off: [0, -0.6, 0.14] },
    foreFar: { j: 'legs.1', off: [0, -0.6, 0.14] },
    hindNear: { j: 'legs.2', off: [0, -0.6, 0.14] },
    hindFar: { j: 'legs.3', off: [0, -0.6, 0.14] },
    head: { j: 'head', off: [0, 0.02, 0.78] },
    jaw: { j: 'jaw', off: [0, -0.1, 0.74] },
    tail: { j: 'tail', off: [0, -0.28, 0] },
    body: { j: 'body', off: [0, -0.2, 0.8] },
  },
  mirror: [
    ['legs.0', 'legs.1'],
    ['legs.2', 'legs.3'],
  ],
  hipDrop: 0.38,
  hipHeight: 0.8,
  hangTilt: 1.0,
  limits: {
    foreNearSwing: [-0.9, 2.3],
    foreFarSwing: [-0.9, 2.3],
    hindNearSwing: [-1.0, 1.2],
    hindFarSwing: [-1.0, 1.2],
    foreNearSpread: [-0.5, 0.7],
    foreFarSpread: [-0.5, 0.7],
    bodyPitch: [-0.9, 0.9],
    neckPitch: [-0.6, 0.6],
    headPitch: [-0.7, 0.9],
    jaw: [0, 1.6],
    tailPitch: [-0.8, 1.2],
  },
  overrides: { bite: yawn, lunge: gape, charge: () => bellyBump(), bellyFlop },
  note: 'hand-written (WP-A2)',
};

registerProfile(hippoProfile);
