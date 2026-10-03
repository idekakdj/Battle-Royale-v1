/**
 * GIRAFFE limb-role profile (rig: src/render/animals/Giraffe.ts) — WP-A3.
 *
 * Joints: body (pivot y 1.62), neck1 (pivot (0, 2.02, 0.52), rest rx −0.42: raked BACK), neck2 (0.95 above neck1, rest rx +0.12),
 * head (0.95 above neck2, rest rx +0.85: nose down), tail, legs.0 (FL, −X = NEAR) / .1 (FR) / .2 (HL) / .3 (HR), 1.6 m long.
 * Verified against the rig with the FK probe (head tip at rest = (fwd 0.19, up 3.56)):
 *  - `neckPitch` (+ = up) = neck1 `−rx`; `neckExt` (+ = neck2 bent UP/back, +0.12 straightens the rest curve) = neck2 `−rx`;
 *    `headPitch` (+ = up) = head `−rx` (+0.85 levels the head with the neck);
 *  - the NECK SPIN: `bodyCurl` = neck1 `rz` (+π/2 lays the neck horizontally toward the near side), then `neckYaw` (neck1 `−ry`)
 *    sweeps it round the vertical axis (a DECREASING yaw goes forward → far side → behind → near side), `neckPitch −0.42` levels the
 *    disc (cancels the neck's rest rake), `neckExt +0.12` / `headPitch +0.85` keep the neck straight (in that layout both bend it
 *    sideways). Spin radius ≈ 1.93 m about (fwd 0.52, up 2.02);
 *  - `bodyPitch` / `bodyFwd` counter-rotate the four legs (planted hooves while the body leans — the legs are 1.6 m long);
 *  - `bodyStretch` = NECK stretch (neck1 scale, the head counter-scaled so it does not grow).
 */

import type { AnimalProfile, ArchCtx, ArchFn, ArchSpec } from '../profile';
import { registerProfile } from '../profile';
import { ARCHETYPES } from '../archetypes';
import type { DofPartial } from '../dof';

const TAU = Math.PI * 2;

/** lightN / heavyU — tether: the neck stretched out as a long poke (front) or shot straight up (up). */
const tether: ArchFn = (c) => {
  if (c.anim.side === 'up') return neckRise(c, true);
  return {
    tip: 'head',
    B: { neckPitch: -2.1, neckExt: 0.12, headPitch: 0.5, bodyFwd: 0.3, bodyPitch: -0.15 },
    free: [
      { d: 'neckPitch', lo: -2.6, hi: -1.3 },
      { d: 'neckExt', lo: -0.3, hi: 0.35 },
      { d: 'headPitch', lo: 0, hi: 1.0 },
      { d: 'bodyFwd', lo: 0, hi: 0.5 },
      { d: 'bodyPitch', lo: -0.4, hi: 0.1 },
    ],
    // Recoil: the neck pulled up and back, head tucked, body drawn in.
    A: () => ({ neckPitch: 0.35, neckExt: 0.3, headPitch: 0.1, bodyFwd: -0.12, bodyPitch: 0.1, tailPitch: 0.3 }),
    over: 0.05,
  };
};

/** Neck Lift (lightU) and Neck Stretch (heavyU): the head dips forward, then whips / shoots straight up along the hitbox path. */
function neckRise(_c: ArchCtx, stretch: boolean): ArchSpec {
  return {
    tip: 'head',
    B: { neckPitch: -1.3, neckExt: -0.25, headPitch: 0.35, bodyFwd: 0.2, bodyPitch: -0.1 },
    free: [
      { d: 'neckPitch', lo: -2.2, hi: 0.6 },
      { d: 'neckExt', lo: -0.9, hi: 0.4 },
      { d: 'headPitch', lo: -0.3, hi: 1.0 },
      { d: 'bodyFwd', lo: -0.1, hi: 0.45 },
      { d: 'bodyPitch', lo: -0.4, hi: 0.2 },
      ...(stretch ? [{ d: 'bodyStretch' as const, lo: 0, hi: 0.2 }] : []),
    ],
    // Wind-up: the neck laid far back over the shoulders, the head cocked.
    A: () => ({ neckPitch: 0.6, neckExt: 0.3, headPitch: -0.2, bodyPitch: 0.08, bodyFwd: -0.1, tailPitch: 0.3 }),
    over: 0.08,
    ftFrac: 0.3,
  };
}

/** neckSwing: lift (up), full-circle neck spin (both), skull hammer (front). */
const neckSwing: ArchFn = (c) => {
  if (c.anim.side === 'up') return neckRise(c, false);
  if (c.anim.side === 'both') {
    const act = Math.max(1, c.A - 1);
    const rate = Math.min(0.78, 4.0 / act);
    return {
      tip: 'head',
      // The neck laid out level (see the header) at the front of the circle; the decreasing yaw sweeps it round.
      // (The head's SCREEN x is fwd × 0.93 + lateral × 0.38: the sweep starts a little toward the far side so that the second box,
      //  which opens on active frame 3, finds the head already behind the body in screen space.)
      B: { bodyCurl: 1.57, neckPitch: -0.42, neckExt: 0.12, headPitch: 0.85, neckYaw: -1.45 },
      free: [],
      A: () => ({ bodyCurl: 1.0, neckPitch: -0.2, neckExt: 0.2, headPitch: 0.5, neckYaw: -0.4, bodyPitch: 0.05 }),
      drift: { neckYaw: -rate * act },
      end: { neckYaw: -TAU },
      over: 0,
      ftFrac: 0.6,
      noFit: true,
    };
  }
  // Skull hammer.
  return {
    tip: 'head',
    B: { neckPitch: -2.4, neckExt: 0.12, headPitch: 0.4, bodyFwd: 0.5, bodyPitch: -0.3 },
    free: [
      { d: 'neckPitch', lo: -2.6, hi: -1.6 },
      { d: 'neckExt', lo: -0.2, hi: 0.4 },
      { d: 'headPitch', lo: -0.2, hi: 1.0 },
      { d: 'bodyFwd', lo: 0.1, hi: 0.6 },
      { d: 'bodyPitch', lo: -0.5, hi: 0.1 },
    ],
    // Rear overhead: the neck thrown back and up behind the shoulders, the chest lifted.
    A: () => ({ neckPitch: 0.55, neckExt: 0.25, headPitch: 0.35, bodyPitch: 0.18, bodyFwd: -0.15, tailPitch: 0.4 }),
    pre: [{ before: 4, v: () => ({ neckPitch: 0.2, neckExt: 0.25, headPitch: 0.5, bodyPitch: 0.1, bodyFwd: -0.05 }) }],
    over: 0.06,
    ftFrac: 0.3,
  };
};

/** kick: Long Kick (a lashing forward kick) and the Axe Kick (leg raised high, hoof chopped down). */
const kick: ArchFn = (c) => {
  const s = ARCHETYPES.kick(c);
  if (c.anim.side === 'down' || (typeof c.anim.arc === 'number' && c.anim.arc >= 100)) {
    // Axe kick: the whole leg overhead, then chopped down through the target.
    const B: DofPartial = { ...s.B, foreNearSwing: c.air ? 0.35 : 1.0, bodyPitch: 0.0 };
    return {
      ...s,
      B,
      free: s.free.map((f) => (f.d === 'foreNearSwing' ? { ...f, lo: -0.3, hi: 2.0 } : f)),
      A: () => ({ foreNearSwing: 2.7, foreNearSpread: 0.1, bodyPitch: 0.12, bodyFwd: -0.05, headPitch: 0.1, neckPitch: 0.15, tailPitch: 0.3 }),
    };
  }
  return s;
};

export const giraffeProfile: AnimalProfile = {
  animal: 'giraffe',
  links: {
    bodyPitch: [
      { j: 'body', ch: 'rx', k: -1 },
      { j: 'legs.0', ch: 'rx', k: 1 },
      { j: 'legs.1', ch: 'rx', k: 1 },
      { j: 'legs.2', ch: 'rx', k: 1 },
      { j: 'legs.3', ch: 'rx', k: 1 },
    ],
    bodyYaw: [{ j: 'body', ch: 'ry', k: 1 }],
    bodyRoll: [{ j: 'body', ch: 'rz', k: 1 }],
    bodyFwd: [
      { j: 'body', ch: 'pz', k: 1 },
      { j: 'legs.0', ch: 'rx', k: 0.62 },
      { j: 'legs.1', ch: 'rx', k: 0.62 },
      { j: 'legs.2', ch: 'rx', k: 0.62 },
      { j: 'legs.3', ch: 'rx', k: 0.62 },
    ],
    bodyUp: [{ j: 'body', ch: 'py', k: 1 }],
    bodyStretch: [
      { j: 'neck1', ch: 's', k: 1 },
      { j: 'head', ch: 's', k: -0.8 },
    ],
    neckPitch: [{ j: 'neck1', ch: 'rx', k: -1 }],
    neckExt: [{ j: 'neck2', ch: 'rx', k: -1 }],
    neckYaw: [{ j: 'neck1', ch: 'ry', k: -1 }],
    bodyCurl: [{ j: 'neck1', ch: 'rz', k: 1 }],
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
    foreNear: { j: 'legs.0', off: [0, -1.58, 0.06] },
    foreFar: { j: 'legs.1', off: [0, -1.58, 0.06] },
    hindNear: { j: 'legs.2', off: [0, -1.58, 0.0] },
    hindFar: { j: 'legs.3', off: [0, -1.58, 0.0] },
    head: { j: 'head', off: [0, -0.02, 0.41] },
    tail: { j: 'tail', off: [0, -0.8, 0] },
    body: { j: 'body', off: [0, -0.1, 0.72] },
  },
  mirror: [
    ['legs.0', 'legs.1'],
    ['legs.2', 'legs.3'],
  ],
  hipDrop: 1.1,
  hipHeight: 1.6,
  hangTilt: 0.2,
  limits: {
    foreNearSwing: [-1.0, 3.0],
    foreFarSwing: [-1.0, 3.0],
    hindNearSwing: [-1.0, 1.4],
    hindFarSwing: [-1.0, 1.4],
    bodyPitch: [-0.7, 0.6],
    neckPitch: [-2.6, 1.7],
    neckExt: [-1.2, 1.2],
    headPitch: [-1.2, 1.2],
    bodyStretch: [0, 0.22],
  },
  overrides: { tether, neckSwing, kick },
  // The sim hangs the fighter with the TOP of its hurtbox (95 % of 2.6 m) at the ledge: the generic 2.7 rad foreleg reach would put
  // the hooves half a metre above the ledge; 2.15 rad hooks them on the edge.
  states: {
    ledgeHang: (c) => {
      const e = 1 - Math.pow(1 - Math.min(1, c.t / 8), 2.2);
      // The neck leans forward so the head looks at the ledge (a raked-back neck on a nose-up body would trail behind it).
      return { foreNearSwing: -0.55 * e, foreFarSwing: -0.4 * e, neckPitch: -1.0 * e, headPitch: -0.2 * e };
    },
    ledgeClimb: (c) => {
      const u = c.total > 0 ? Math.min(1, c.t / c.total) : 0;
      const x = Math.min(1, u * 1.15);
      const e = 1 - x * x * (3 - 2 * x);
      return { foreNearSwing: -0.55 * e, foreFarSwing: -0.4 * e, neckPitch: -1.0 * e };
    },
  },
  note: 'hand-written (WP-A3)',
};

registerProfile(giraffeProfile);
