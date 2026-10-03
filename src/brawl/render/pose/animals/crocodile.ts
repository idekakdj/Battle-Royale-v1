/**
 * CROCODILE limb-role profile (rig: src/render/animals/Crocodile.ts) — WP-A2.
 *
 * Joints: body (pivot y 0.38), head (pivot z 0.78 on the body, no neck), jaw (child of head), legs.0..3 (FL −X, FR +X, HL −X, HR +X;
 * rest rz = ∓0.55: sprawled), tail1 / tail2 / tail3 (three flat segments, 0.68 / 0.6 / 0.6 m, rest straight back along −Z; `tail` is an
 * alias of `tail1`).
 * Conventions verified against the rig: body +rx pitches the nose DOWN, +ry brings the −X (near) side forward, +rz tilts the near side down;
 * head +rx dips the snout; jaw +rx opens; tail +rx LIFTS the tail, tail +ry swings the tip to −X (the near / camera side);
 * a leg's +rx swings the foot BACK (forward = −rx), outward spread of the −X leg = −rz.
 *
 * Anatomy specials: tail whips use all three tail segments (the whip really curls round the body to the front), the Death Roll
 * is a roll about the long axis (not a yaw spin) with the jaws wide open, bites keep the body low (a snap, not a pounce).
 */

import type { AnimalProfile, ArchSpec } from '../profile';
import { registerProfile } from '../profile';
import { ARCHETYPES } from '../archetypes';

/** lightS Tail Flick (two boxes: behind, then in front) and heavyD Tail Slam (arcs over the back, slams down in front). */
function crocTail(c: Parameters<typeof ARCHETYPES.tailWhip>[0]): ArchSpec {
  const over = c.anim.side === 'front'; // heavyD: over the back and down in front of the head
  if (over) {
    return {
      tip: 'tail',
      // Strike: the tail has arched over the back and comes down in front; the body drives forward and the nose dips.
      B: { tailPitch: 2.6, tail2Pitch: 0.9, bodyPitch: -0.25, bodyFwd: 0.4, bodyUp: 0, headPitch: -0.15 },
      free: [
        { d: 'tailPitch', lo: 1.2, hi: 3.0 },
        { d: 'tail2Pitch', lo: -0.4, hi: 1.7 },
        { d: 'bodyFwd', lo: 0, hi: 0.6 },
        { d: 'bodyPitch', lo: -0.45, hi: 0.1 },
      ],
      // Wind-up: the tail rears up and back over the body, the front end drops a little.
      A: () => ({ tailPitch: 1.5, tail2Pitch: 0.2, bodyPitch: 0.1, bodyFwd: -0.1, headPitch: 0.15, foreNearSwing: -0.2, foreFarSwing: -0.2 }),
      over: 0.1,
    };
  }
  return {
    tip: 'tail',
    // Peak (behind): the tail is flicked out behind the body; over the active window it whips round the NEAR flank to the front
    // (hand-timed `drift`: back box f9-10 → front box f11-12; the per-frame angular step stays ≈ 0.4 rad).
    B: { tailYaw: 0.2, tail2Yaw: 0.15, bodyYaw: -0.1, bodyFwd: 0 },
    free: [],
    noFit: true,
    drift: { tailYaw: 2.0, tail2Yaw: 1.6, bodyFwd: 0.75, bodyYaw: 0.3 },
    // Wind-up: the tail is cocked round the FAR flank and the shoulders twist the other way.
    A: () => ({ tailYaw: -1.0, tail2Yaw: -0.8, tailPitch: 0.15, bodyYaw: 0.28, headYaw: -0.15 }),
    over: 0.04,
    ftFrac: 0.35,
  };
}

/** heavyS Lunge Bite: stays LOW and flat — the body surges forward on the hind legs with the jaws wide open (no pitching up / down). */
function crocLunge(c: Parameters<typeof ARCHETYPES.lunge>[0]): ArchSpec {
  const sw = c.dir === 1 ? 1 : -1;
  return {
    tip: 'jaw',
    B: { jaw: 0.75, headPitch: 0.1, bodyFwd: 0.5 * sw, bodyPitch: -0.04, bodyUp: 0.02, foreNearSwing: 0.6 * sw, foreFarSwing: 0.5 * sw, hindNearSwing: -0.8, hindFarSwing: -0.7, tailYaw: 0.35, tail2Yaw: 0.3 },
    free: [
      { d: 'bodyFwd', lo: c.dir === 1 ? 0 : -0.9, hi: c.dir === 1 ? 0.9 : 0 },
      { d: 'bodyPitch', lo: -0.2, hi: 0.15 },
      { d: 'headPitch', lo: -0.3, hi: 0.4 },
    ],
    // Coil: flattened, the head cocked back with the jaws gaping, hind legs gathered, tail curled to the far side.
    A: () => ({ jaw: 1.0, headPitch: 0.3, bodyUp: -0.08, bodyFwd: -0.22 * sw, bodyPitch: 0.06, hindNearSwing: 0.55, hindFarSwing: 0.5, foreNearSwing: -0.3, foreFarSwing: -0.3, tailYaw: -0.7, tail2Yaw: -0.5 }),
    over: 0.08,
  };
}

/** Death Roll: roll about the long axis with the jaws wide open and the tail lashing. */
function crocRoll(c: Parameters<typeof ARCHETYPES.spinAttack>[0]): ArchSpec {
  const base = ARCHETYPES.spinAttack(c);
  // The data asks for 2 turns, but a joint may turn at most 0.9 rad/frame while striking and 0.5 afterwards (and the follow-through is
  // ≤ 7 frames): one clean full roll fits (B already rolling, ≈ 0.84 rad/frame over the window), the tail lash adds the rest of the look.
  const act = Math.max(1, c.A - 1);
  const total = Math.PI * 2;
  const inAct = Math.min(total * 0.7, 0.84 * act);
  return {
    ...base,
    tip: 'head',
    B: { jaw: 0.95, headPitch: -0.1, bodyUp: 0, bodyFwd: 0.1, tailYaw: 0.7, tail2Yaw: 0.5, tailPitch: 0.1, bodyRoll: 1.1 },
    free: [{ d: 'bodyFwd', lo: 0, hi: 0.4 }],
    // Coil: crouched, head cocked back with the jaws gaping, tail curled the other way.
    A: () => ({ jaw: 0.7, headPitch: 0.25, bodyPitch: 0.05, bodyUp: -0.05, tailYaw: -0.9, tail2Yaw: -0.7, bodyFwd: -0.1, bodyRoll: -0.25 }),
    drift: { bodyRoll: inAct, tailYaw: -1.2, tail2Yaw: -0.8 },
    end: { bodyRoll: total, jaw: 0, tailYaw: 0, tail2Yaw: 0 },
    over: 0,
    ftFrac: 0.5,
  };
}

export const crocodileProfile: AnimalProfile = {
  animal: 'crocodile',
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
    tailPitch: [{ j: 'tail1', ch: 'rx', k: 1 }],
    tailYaw: [{ j: 'tail1', ch: 'ry', k: 1 }],
    tail2Pitch: [
      { j: 'tail2', ch: 'rx', k: 1 },
      { j: 'tail3', ch: 'rx', k: 0.9 },
    ],
    tail2Yaw: [
      { j: 'tail2', ch: 'ry', k: 1 },
      { j: 'tail3', ch: 'ry', k: 0.5 },
    ],
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
    foreNear: { j: 'legs.0', off: [0, -0.34, 0.12] },
    foreFar: { j: 'legs.1', off: [0, -0.34, 0.12] },
    hindNear: { j: 'legs.2', off: [0, -0.34, 0.12] },
    hindFar: { j: 'legs.3', off: [0, -0.34, 0.12] },
    head: { j: 'head', off: [0, 0.05, 0.94] },
    jaw: { j: 'jaw', off: [0, -0.04, 0.84] },
    tail: { j: 'tail3', off: [0, 0, -0.57] },
    body: { j: 'body', off: [0, 0.02, 0.7] },
  },
  mirror: [
    ['legs.0', 'legs.1'],
    ['legs.2', 'legs.3'],
  ],
  hipDrop: 0.1,
  hipHeight: 0.35,
  hangTilt: 1.2,
  limits: {
    foreNearSwing: [-0.9, 1.6],
    foreFarSwing: [-0.9, 1.6],
    hindNearSwing: [-1.0, 1.3],
    hindFarSwing: [-1.0, 1.3],
    foreNearSpread: [-0.6, 0.8],
    foreFarSpread: [-0.6, 0.8],
    bodyPitch: [-0.8, 0.8],
    neckPitch: [-0.5, 0.7],
    headPitch: [-0.7, 0.8],
    jaw: [0, 1.3],
    tailPitch: [-1.2, 3.0],
    tail2Pitch: [-1.0, 1.8],
    tailYaw: [-1.6, 2.7],
    tail2Yaw: [-1.4, 2.5],
  },
  overrides: { tailWhip: crocTail, spinAttack: crocRoll, lunge: crocLunge },
  note: 'hand-written (WP-A2)',
};

registerProfile(crocodileProfile);
