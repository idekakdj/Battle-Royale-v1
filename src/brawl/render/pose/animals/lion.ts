/**
 * LION limb-role profile (rig: src/render/animals/Lion.ts).
 *
 * Joints: body, neck, head, jaw, mane (unused), legs.0..3 (FL −X, FR +X, HL −X, HR +X), tail, tail2.
 * Conventions verified against the rig: the paws hang −Y from a pivot at y = 0.92 (length 0.94); +rx on a leg swings the paw
 * BACK, so forward swing = −rx; body +rx pitches the nose DOWN; neck/head +rx dip the head; jaw +rx opens; tail +rx lifts it.
 */

import type { AnimalProfile } from '../profile';
import { registerProfile } from '../profile';

export const lionProfile: AnimalProfile = {
  animal: 'lion',
  links: {
    bodyPitch: [{ j: 'body', ch: 'rx', k: -1 }],
    bodyYaw: [{ j: 'body', ch: 'ry', k: 1 }],
    bodyRoll: [{ j: 'body', ch: 'rz', k: 1 }],
    bodyFwd: [{ j: 'body', ch: 'pz', k: 1 }],
    bodyUp: [{ j: 'body', ch: 'py', k: 1 }],
    bodyStretch: [{ j: 'body', ch: 's', k: 1 }],
    neckPitch: [{ j: 'neck', ch: 'rx', k: -1 }],
    neckYaw: [{ j: 'neck', ch: 'ry', k: -1 }],
    headPitch: [{ j: 'head', ch: 'rx', k: -1 }],
    headYaw: [{ j: 'head', ch: 'ry', k: -1 }],
    headRoll: [{ j: 'head', ch: 'rz', k: 1 }],
    jaw: [{ j: 'jaw', ch: 'rx', k: 1 }],
    tailPitch: [{ j: 'tail', ch: 'rx', k: 1 }],
    tailYaw: [{ j: 'tail', ch: 'rz', k: -1 }],
    tail2Pitch: [{ j: 'tail2', ch: 'rx', k: 1 }],
    tail2Yaw: [{ j: 'tail2', ch: 'rz', k: -1 }],
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
    foreNear: { j: 'legs.0', off: [0, -0.94, 0.04] },
    foreFar: { j: 'legs.1', off: [0, -0.94, 0.04] },
    hindNear: { j: 'legs.2', off: [0, -0.94, 0.01] },
    hindFar: { j: 'legs.3', off: [0, -0.94, 0.01] },
    head: { j: 'head', off: [0, -0.03, 0.45] },
    jaw: { j: 'jaw', off: [0, -0.015, 0.31] },
    tail: { j: 'tail2', off: [0, -0.43, 0] },
    body: { j: 'body', off: [0, 0.05, 0.7] },
  },
  mirror: [
    ['legs.0', 'legs.1'],
    ['legs.2', 'legs.3'],
  ],
  hipDrop: 0.55,
  hipHeight: 0.92,
  hangTilt: 1.15,
  limits: {
    foreNearSwing: [-1.0, 2.5],
    foreFarSwing: [-1.0, 2.5],
    foreNearSpread: [-0.7, 0.8],
    foreFarSpread: [-0.7, 0.8],
    hindNearSwing: [-1.2, 1.5],
    hindFarSwing: [-1.2, 1.5],
    bodyPitch: [-1.1, 1.0],
    neckPitch: [-0.7, 0.9],
    headPitch: [-0.8, 0.9],
    jaw: [0, 1.1],
    tailPitch: [-1.5, 1.2],
    tail2Pitch: [-1.2, 1.2],
  },
  // WP-P: a pounce, not a howl: the body sinks onto the haunches, the neck draws back but the chin stays tucked on the target.
  coil: {
    bite: { bodyFwd: -0.32, bodyUp: -0.2, bodyPitch: 0.06, neckPitch: 0.12, headPitch: -0.3, tailPitch: 0.4, hindNearSwing: 0.4, hindFarSwing: 0.35 },
  },
  note: 'hand-written (WP-A1), WP-P wind-up coil',
};

registerProfile(lionProfile);
