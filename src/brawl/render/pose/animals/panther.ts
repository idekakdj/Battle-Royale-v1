/**
 * PANTHER limb-role profile (rig: src/render/animals/Panther.ts) — WP-A2.
 *
 * Joints: body (pivot y 0.78), neck (pivot at the chest), head (child of neck), jaw, legs.0..3 (FL −X, FR +X, HL −X, HR +X; lean 0.78 m
 * limbs hanging from y 0.78), tail (rest rx 1.1) + tail2 (rest rx 0.55).
 * Conventions verified against the rig (same as the lion): body +rx pitches the nose DOWN, neck / head +rx dip the head, jaw +rx opens, a leg's
 * +rx swings the paw BACK (forward = −rx), tail +rx lifts it, the rest-tilted tail swings sideways about its local z.
 *
 * Anatomy specials: Shadow Slash is a single-claw low lunge (the far paw stays tucked), Shadow Dash is a full-stretch phantom leap (forepaws
 * reaching, hind legs trailing, tail streaming) instead of the generic alternating gallop.
 */

import type { AnimalProfile, ArchSpec } from '../profile';
import { registerProfile } from '../profile';
import { ARCHETYPES } from '../archetypes';

type Ctx = Parameters<typeof ARCHETYPES.lunge>[0];

/** lightS Shadow Slash: a low lunge with ONE slashing claw. */
function shadowSlash(c: Ctx): ArchSpec {
  const s = ARCHETYPES.lunge(c);
  const sw = c.dir === 1 ? 1 : -1;
  s.B = { ...s.B, foreFarSwing: 0.25 * sw, foreFarBend: 0.8, foreNearSwing: 1.5 * sw, hindNearSwing: -1.0, hindFarSwing: -0.8 };
  s.free = s.free.map((f) => (f.d === 'foreNearSwing' ? { ...f, tie: undefined } : f.d === 'foreNearBend' ? { ...f, tie: undefined } : f));
  const a0 = s.A;
  s.A = (b) => ({ ...a0(b), foreFarSwing: -0.25, foreFarBend: 0.8 });
  return s;
}

/** heavyS Shadow Dash: stretched-out phantom leap — forepaws reach forward, hind legs trail, tail streams, head low and level. */
function shadowDash(c: Ctx): ArchSpec {
  const sw = c.dir === 1 ? 1 : -1;
  return {
    tip: 'foreNear',
    B: {
      foreNearSwing: 1.3 * sw,
      foreFarSwing: 1.2 * sw,
      foreNearBend: 0.1,
      foreFarBend: 0.1,
      hindNearSwing: -1.15,
      hindFarSwing: -1.1,
      bodyFwd: 0.3 * sw,
      bodyUp: -0.08,
      bodyPitch: 0.04,
      neckPitch: 0.2,
      headPitch: -0.22,
      tailPitch: 0.55,
      tail2Pitch: 0.3,
    },
    free: [
      { d: 'foreNearSwing', lo: 0.4, hi: 2.2, tie: ['foreFarSwing'] },
      { d: 'bodyFwd', lo: 0, hi: 0.6 },
      { d: 'bodyUp', lo: -0.3, hi: 0.1 },
      { d: 'bodyPitch', lo: -0.3, hi: 0.4 },
    ],
    A: () => ({
      foreNearSwing: -0.35,
      foreFarSwing: -0.35,
      foreNearBend: 0.8,
      foreFarBend: 0.8,
      hindNearSwing: 0.5,
      hindFarSwing: 0.5,
      bodyUp: -0.22,
      bodyFwd: -0.18,
      bodyPitch: 0.06,
      headPitch: -0.2,
      neckPitch: 0.1,
      tailPitch: 0.1,
    }),
    over: 0.06,
  };
}

export const pantherProfile: AnimalProfile = {
  animal: 'panther',
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
    foreNear: { j: 'legs.0', off: [0, -0.76, 0.12] },
    foreFar: { j: 'legs.1', off: [0, -0.76, 0.12] },
    hindNear: { j: 'legs.2', off: [0, -0.76, 0.1] },
    hindFar: { j: 'legs.3', off: [0, -0.76, 0.1] },
    head: { j: 'head', off: [0, -0.02, 0.29] },
    jaw: { j: 'jaw', off: [0, -0.01, 0.21] },
    tail: { j: 'tail2', off: [0, -0.5, 0] },
    body: { j: 'body', off: [0, 0.03, 0.72] },
  },
  mirror: [
    ['legs.0', 'legs.1'],
    ['legs.2', 'legs.3'],
  ],
  hipDrop: 0.48,
  hipHeight: 0.78,
  hangTilt: 1.15,
  limits: {
    foreNearSwing: [-1.3, 2.7],
    foreFarSwing: [-1.3, 2.7],
    hindNearSwing: [-1.4, 1.6],
    hindFarSwing: [-1.4, 1.6],
    foreNearSpread: [-0.8, 1.1],
    foreFarSpread: [-0.8, 1.1],
    bodyPitch: [-1.1, 1.0],
    neckPitch: [-0.8, 0.9],
    headPitch: [-0.8, 0.9],
    jaw: [0, 1.1],
    tailPitch: [-1.0, 1.4],
    tail2Pitch: [-1.0, 1.2],
  },
  overrides: { lunge: shadowSlash, charge: shadowDash },
  note: 'hand-written (WP-A2)',
};

registerProfile(pantherProfile);
