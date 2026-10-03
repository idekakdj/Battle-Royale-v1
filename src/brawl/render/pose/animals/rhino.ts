/**
 * RHINO limb-role profile (rig: src/render/animals/Rhino.ts) — WP-A2.
 *
 * Joints: body (pivot y 1.02), head (pivot z 0.95, rest rx 0.3 = carried low, bears the front horn; no neck / jaw), legs.0..3
 * (FL −X, FR +X, HL −X, HR +X; pillars of 0.67 m), tail (rest rx 1.0).
 * Conventions verified against the rig (same as the lion): body +rx pitches the nose DOWN, head +rx dips the head (the horn tip
 * goes DOWN), a leg's +rx swings the foot BACK (forward = −rx), tail +rx lifts it. The `head` tip is the HORN tip.
 *
 * Anatomy specials: Horn Sweep swings the horn from the side across the front (head yaw + shoulder twist), the stomps / hoof scrape use the
 * forefoot (the data says forelimb), horn thrusts lower the head and drive the whole body, horn tosses dig the horn and heave it up.
 */

import type { AnimalProfile, ArchSpec } from '../profile';
import { registerProfile } from '../profile';
import { ARCHETYPES } from '../archetypes';

type Ctx = Parameters<typeof ARCHETYPES.headbutt>[0];

/** lightS Horn Sweep: the horn is cocked out to the far side and sweeps across the front (the box path runs back → front). */
function hornSweep(c: Ctx): ArchSpec {
  const s = ARCHETYPES.headbutt(c);
  return {
    ...s,
    tip: 'head',
    B: { headYaw: 0.85, neckYaw: 0.2, bodyYaw: 0.3, bodyFwd: 0.12, headPitch: -0.12, bodyPitch: -0.05, foreNearSwing: 0.4, hindNearSwing: -0.3 },
    free: [
      { d: 'headYaw', lo: -0.45, hi: 1.3 },
      { d: 'bodyFwd', lo: 0, hi: 0.7 },
      { d: 'bodyYaw', lo: -0.15, hi: 0.5 },
      { d: 'headPitch', lo: -0.6, hi: 0.5 },
    ],
    A: () => ({ headYaw: -0.8, neckYaw: -0.2, bodyYaw: -0.3, bodyFwd: -0.1, headPitch: 0.12, bodyUp: -0.04, hindNearSwing: 0.2 }),
    over: 0.12,
  };
}

/** Horn tosses: the horn digs down and heaves up (head + shoulders), the forefeet leave the ground. */
function hornToss(c: Ctx): ArchSpec {
  const s = ARCHETYPES.hornUp(c);
  const a0 = s.A;
  s.A = (b) => ({ ...a0(b), headPitch: -0.2, neckPitch: -0.15, bodyPitch: -0.28, bodyUp: -0.12 });
  return s;
}

export const rhinoProfile: AnimalProfile = {
  animal: 'rhino',
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
    foreNear: { j: 'legs.0', off: [0, -0.64, 0.14] },
    foreFar: { j: 'legs.1', off: [0, -0.64, 0.14] },
    hindNear: { j: 'legs.2', off: [0, -0.64, 0.14] },
    hindFar: { j: 'legs.3', off: [0, -0.64, 0.14] },
    head: { j: 'head', off: [0, 0.55, 0.8] },
    body: { j: 'body', off: [0, -0.05, 0.85] },
  },
  mirror: [
    ['legs.0', 'legs.1'],
    ['legs.2', 'legs.3'],
  ],
  hipDrop: 0.45,
  hipHeight: 0.85,
  hangTilt: 1.0,
  limits: {
    foreNearSwing: [-0.9, 2.3],
    foreFarSwing: [-0.9, 2.3],
    hindNearSwing: [-1.0, 1.2],
    hindFarSwing: [-1.0, 1.2],
    foreNearSpread: [-0.5, 0.7],
    foreFarSpread: [-0.5, 0.7],
    bodyPitch: [-0.9, 0.9],
    neckPitch: [-0.7, 0.8],
    headPitch: [-0.9, 1.0],
    tailPitch: [-0.8, 1.2],
  },
  overrides: { headbutt: (c) => (c.sweepDx > 0.5 ? hornSweep(c) : ARCHETYPES.headbutt(c)), hornUp: hornToss },
  note: 'hand-written (WP-A2)',
};

registerProfile(rhinoProfile);
