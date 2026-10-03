/**
 * GORILLA limb-role profile (rig: src/render/animals/Gorilla.ts).
 *
 * Joints: body, head (no neck / jaw / tail joints), armL/armR (shoulder, x ∓0.52) with foreL/foreR (elbow), legL/legR (hips).
 * armL / foreL / legL sit on the local −X side = the NEAR side when facing +1. The fists hang to the ground (arm 0.5 + forearm 0.74);
 * −rx on the shoulder/elbow swings the arm forward / flexes the elbow, body +rx pitches the nose down. There is no neck joint, so
 * `neckPitch` is folded into the head, and there is no jaw (the muzzle is the bite tip). The chest-drum `roar` is overridden.
 */

import type { AnimalProfile, ArchSpec } from '../profile';
import { registerProfile } from '../profile';

function chestDrum(): ArchSpec {
  return {
    tip: 'foreNear',
    B: {
      foreNearSwing: 1.05,
      foreFarSwing: 1.05,
      foreNearBend: 1.55,
      foreFarBend: 1.55,
      foreNearSpread: -0.25,
      foreFarSpread: -0.25,
      bodyPitch: 0.3,
      bodyUp: 0.06,
      headPitch: 0.55,
    },
    free: [],
    A: () => ({
      foreNearSwing: 1.5,
      foreFarSwing: 1.5,
      foreNearBend: 0.4,
      foreFarBend: 0.4,
      foreNearSpread: 0.9,
      foreFarSpread: 0.9,
      bodyPitch: 0.25,
      bodyUp: 0.04,
      headPitch: 0.4,
    }),
    over: 0.12,
    noFit: true, // fists on the chest: the burst hitbox covers the whole body, so the pose is not pulled toward it
  };
}

export const gorillaProfile: AnimalProfile = {
  animal: 'gorilla',
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
    foreNearSwing: [{ j: 'armL', ch: 'rx', k: -1 }],
    foreNearSpread: [{ j: 'armL', ch: 'rz', k: -1 }],
    foreNearBend: [{ j: 'foreL', ch: 'rx', k: -1 }],
    foreFarSwing: [{ j: 'armR', ch: 'rx', k: -1 }],
    foreFarSpread: [{ j: 'armR', ch: 'rz', k: 1 }],
    foreFarBend: [{ j: 'foreR', ch: 'rx', k: -1 }],
    hindNearSwing: [{ j: 'legL', ch: 'rx', k: -1 }],
    hindNearSpread: [{ j: 'legL', ch: 'rz', k: -1 }],
    hindFarSwing: [{ j: 'legR', ch: 'rx', k: -1 }],
    hindFarSpread: [{ j: 'legR', ch: 'rz', k: 1 }],
  },
  tips: {
    foreNear: { j: 'foreL', off: [0, -0.74, 0.04] },
    foreFar: { j: 'foreR', off: [0, -0.74, 0.04] },
    hindNear: { j: 'legL', off: [0, -0.42, 0.08] },
    hindFar: { j: 'legR', off: [0, -0.42, 0.08] },
    head: { j: 'head', off: [0, -0.03, 0.33] },
    body: { j: 'body', off: [0, 0.25, 0.4] },
  },
  mirror: [
    ['armL', 'armR'],
    ['foreL', 'foreR'],
    ['legL', 'legR'],
  ],
  hipDrop: 0.42,
  hipHeight: 0.78,
  hangTilt: 0.9,
  limits: {
    foreNearSwing: [-1.4, 3.0],
    foreFarSwing: [-1.4, 3.0],
    foreNearBend: [-0.1, 2.2],
    foreFarBend: [-0.1, 2.2],
    foreNearSpread: [-0.7, 1.4],
    foreFarSpread: [-0.7, 1.4],
    hindNearSwing: [-1.0, 1.2],
    hindFarSwing: [-1.0, 1.2],
    bodyPitch: [-1.0, 0.8],
    neckPitch: [-0.7, 0.8],
    headPitch: [-0.7, 0.8],
  },
  overrides: { roar: () => chestDrum() },
  note: 'hand-written (WP-A1)',
};

registerProfile(gorillaProfile);
