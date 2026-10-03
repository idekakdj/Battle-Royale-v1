/**
 * PYTHON limb-role profile (rig: src/render/animals/Python.ts) — WP-A3. Limbless: every move is a body arc.
 *
 * Joints: body (root, pivot at the feet), coil (the baked spiral, pivot (0, 0.16, −0.05)), neckJ.0..3 (a four-segment chain along +Y;
 * rest rx −0.55 / 0.2 / 0.38 / 0.42, 0.34 m each: it rises leaning back, then bends forward), head (rest rx 1.15, child of the last
 * segment), jaw, tailTip (a 0.6 m stub), tongue.
 * Verified against the rig with the FK probe:
 *  - `neckPitch` (+ = up) = neckJ.0 `−rx` (the whole chain pivots about its root, 0.71 m up);
 *  - `neckExt` straightens the chain's rest bends (neckJ.1..3 `−rx` × rest, 1.0 = straight);
 *  - `bodyCurl` (+ = curl FORWARD / down) adds the same bend to neckJ.1..3 (S-bends, hooks, the self-coil);
 *  - `headPitch` (+ = up) = head `−rx`. At rest the head points DOWN (it is bent 156° from the chain): `headPitch +2.7` continues
 *    the chain direction (a level head on a level neck), +2.4 is a gently lowered head. Everything is written in ABSOLUTE terms
 *    below and converted with `rel()` because the profile's neutral pose (`POSTURE`, a compact S-curve whose head sits ≈ 1.1 m
 *    up — inside the 1 m hurtbox, unlike the rig's 2 m tall cobra rest pose) is added to every key;
 *  - `bodyStretch` = coil scale (squeeze / spring), `bodyFwd` slides the whole snake, `bodyYaw` twists it (whip sweeps).
 */

import type { AnimalProfile, ArchFn, FreeVar } from '../profile';
import { registerProfile } from '../profile';
import { DOF, DOF_NAMES, type DofName, type DofPartial, type DofVec } from '../dof';

const TAU = Math.PI * 2;
/** headPitch that continues the chain direction (head level on a level neck). */
const HEAD_STRAIGHT = 2.7;

/** The compact S-curve resting posture (absolute DOF values; the neutral overlay of every move and every state). */
const POSTURE: DofPartial = { neckPitch: -0.65, bodyCurl: 0.35, headPitch: 2.35 };

/** Convert an absolute pose to a pose relative to POSTURE (unlisted posture DOFs are absolute 0). */
function rel(p: DofPartial): DofPartial {
  const o: DofPartial = { ...p };
  for (const k of Object.keys(POSTURE) as DofName[]) o[k] = (o[k] ?? 0) - (POSTURE[k] as number);
  return o;
}

/** Free variable with ABSOLUTE bounds. */
function fr(d: DofName, lo: number, hi: number, tie?: DofName[]): FreeVar {
  const off = POSTURE[d] ?? 0;
  return { d, lo: lo - off, hi: hi - off, tie };
}

function allOf(b: DofVec, over: DofPartial): DofPartial {
  const o: DofPartial = {};
  for (const n of DOF_NAMES) {
    const v = b[DOF[n]];
    if (v !== 0) o[n] = v;
  }
  return { ...o, ...over };
}

/** The strike pose of a long reach: chain straight and level, head level, the whole snake slid forward. */
function reach(fwd: number, np = -2.1): DofPartial {
  return { neckPitch: np, neckExt: 1, bodyCurl: 0, headPitch: HEAD_STRAIGHT, bodyFwd: fwd };
}

const REACH_FREE: FreeVar[] = [
  fr('neckPitch', -2.8, -1.2),
  { d: 'neckExt', lo: 0.4, hi: 1.0 },
  fr('headPitch', 2.0, 3.1),
  { d: 'bodyFwd', lo: 0, hi: 0.9 },
  { d: 'bodyUp', lo: -0.3, hi: 0.1 },
];

/** lightN — Fang Strike: coil back with the mouth open, shoot the head out on a straight neck, snap shut. */
const bite: ArchFn = () => ({
  tip: 'head',
  B: rel({ ...reach(0.5), jaw: 0.1 }),
  free: REACH_FREE,
  A: () => rel({ neckPitch: -0.15, bodyCurl: 0.85, headPitch: 2.1, bodyFwd: -0.15, bodyUp: -0.05, jaw: 0.9 }),
  pre: [{ before: 1, v: (b: DofVec) => allOf(b, { jaw: 0.9 }) }],
  over: 0.06,
  ftFrac: 0.25,
});

/** lightS / lightD — Tail Lash / Ground Sweep: the long body whips out flat (the stub tail cannot reach, so the front body lashes). */
const tailWhip: ArchFn = (c) => {
  const low = typeof c.anim.height === 'number' && c.anim.height < 0.3;
  return {
    tip: 'head',
    B: rel({ ...reach(0.7, low ? -2.4 : -2.2), bodyYaw: 0.15, bodyUp: low ? -0.1 : 0 }),
    free: REACH_FREE,
    // Wound back: the neck cocked high behind a compressed coil and twisted away; the lash unwinds it across the front.
    A: () => rel({ neckPitch: -0.2, bodyCurl: 0.6, headPitch: 2.2, bodyFwd: -0.12, bodyYaw: -0.65, bodyUp: -0.06, jaw: 0.4 }),
    drift: { bodyYaw: 0.5 },
    over: 0.08,
    ftFrac: 0.25,
  };
};

/** lightU — Rising Coil: the body scoops up in an arc, the head rising overhead along the hitbox path. */
const risingCoil: ArchFn = () => ({
  tip: 'head',
  B: rel({ neckPitch: -1.6, neckExt: 0.6, bodyCurl: 0.1, headPitch: 2.7, bodyFwd: 0.3, bodyUp: -0.08 }),
  free: [fr('neckPitch', -2.4, 0.2), { d: 'neckExt', lo: 0.2, hi: 1.0 }, fr('headPitch', 1.8, 3.1), { d: 'bodyFwd', lo: -0.1, hi: 0.6 }, { d: 'bodyUp', lo: -0.2, hi: 0.1 }],
  A: () => rel({ neckPitch: -1.7, bodyCurl: 0.95, headPitch: 1.9, bodyFwd: -0.08, bodyUp: -0.12, bodyStretch: -0.08 }),
  over: 0.08,
  ftFrac: 0.3,
});

/** heavyN — Constrict: the whole snake winds into a tight spiral (neck curled over the coil, coil squeezed), pulses, then bursts open. */
const constrict: ArchFn = (c) => {
  const act = Math.max(1, c.A - 1);
  const span = Math.max(1, c.A);
  const rate = Math.min(0.8, 3.4 / act);
  // The burst-open pose is the LAST strike pose (the builder holds it until the window ends, then recovers from it): it is the drift
  // target, and the mid keys cancel its linear progress until the final frames so the spiral stays tight and then bursts.
  const burst: DofPartial = { bodyCurl: -1.4, neckPitch: -1.2, neckExt: 0.9, headPitch: 0.8, bodyStretch: 0.26 };
  const at = (k: number, frac: number, extra: DofPartial): { at: number; v: DofPartial } => {
    const v: DofPartial = { ...extra };
    for (const n of Object.keys(burst) as DofName[]) v[n] = (v[n] ?? 0) + (burst[n] as number) * (frac - k / span);
    return { at: k, v };
  };
  return {
    tip: 'body',
    B: rel({ neckPitch: -0.35, bodyCurl: 1.15, headPitch: 1.5, bodyStretch: -0.12, bodyUp: -0.05 }),
    free: [],
    // Rear up first: the neck high, the coil swelling.
    A: () => rel({ neckPitch: 0.1, bodyCurl: 0.2, headPitch: 2.2, bodyStretch: 0.06, bodyUp: 0.02, jaw: 0.5, bodyYaw: -0.4 }),
    drift: { ...burst, bodyYaw: rate * act },
    mid: [at(1, 0, { bodyStretch: -0.08 }), at(2.3, 0, { bodyStretch: 0.03 }), at(3.4, 0.08, { bodyStretch: -0.1 }), at(Math.max(4.4, span - 1.2), 0.85, {})].filter((m) => m.at < span - 0.3),
    end: { bodyYaw: TAU },
    over: 0.04,
    ftFrac: 0.6,
    noFit: true,
  };
};

/** heavyS — Venom Lunge: the front body coils back slowly, then lunges forward with the fangs bared. */
const venomLunge: ArchFn = () => ({
  tip: 'head',
  B: rel({ ...reach(0.8), jaw: 0.75 }),
  free: REACH_FREE,
  A: () => rel({ neckPitch: -0.05, bodyCurl: 1.0, headPitch: 2.0, bodyFwd: -0.3, bodyUp: -0.12, bodyStretch: -0.1, jaw: 0.3 }),
  pre: [{ before: 5, v: (b: DofVec) => allOf(b, { neckPitch: -0.45, bodyCurl: 0.7, headPitch: 2.2, bodyFwd: -0.2, jaw: 0.7 }) }],
  drift: { jaw: -0.55 },
  over: 0.05,
  ftFrac: 0.3,
});

/** heavyD — Coil Drop: rear up tall, then slam down: ground = the neck and head crash forward onto the target, air = a tight falling ball. */
const coilDrop: ArchFn = (c) => {
  if (c.air) {
    return {
      tip: 'body',
      B: rel({ neckPitch: -0.2, bodyCurl: 1.2, headPitch: 1.6, bodyStretch: -0.14, bodyPitch: -0.2 }),
      free: [],
      A: () => rel({ neckPitch: 0.15, bodyCurl: 0.0, headPitch: 2.3, bodyStretch: 0.05, bodyPitch: 0.15 }),
      over: 0.06,
      noFit: true,
    };
  }
  return {
    tip: 'head',
    B: rel({ neckPitch: -2.35, neckExt: 1, bodyCurl: 0, headPitch: 2.9, bodyFwd: 0.5, bodyUp: -0.12 }),
    free: [fr('neckPitch', -2.8, -1.8), { d: 'neckExt', lo: 0.5, hi: 1.0 }, fr('headPitch', 2.2, 3.2), { d: 'bodyFwd', lo: 0.1, hi: 0.8 }, { d: 'bodyUp', lo: -0.3, hi: 0 }],
    A: () => rel({ neckPitch: -0.3, neckExt: 1, bodyCurl: -0.1, headPitch: 2.4, bodyUp: 0.06, bodyStretch: 0.05, bodyFwd: -0.15 }),
    over: 0.1,
    ftFrac: 0.3,
  };
};

/** heavyU — Spring Coil: compress into a tight coil, then spring up and forward, the whole body stretching out. */
const springCoil: ArchFn = () => ({
  tip: 'head',
  B: rel({ neckPitch: -1.1, neckExt: 1, bodyCurl: 0, headPitch: 2.7, bodyFwd: 0.2, bodyStretch: 0.14 }),
  free: [fr('neckPitch', -2.2, 0.2), { d: 'neckExt', lo: 0.3, hi: 1.0 }, fr('headPitch', 2.0, 3.1), { d: 'bodyFwd', lo: 0, hi: 0.5 }],
  A: () => rel({ neckPitch: -1.0, bodyCurl: 1.2, headPitch: 1.7, bodyStretch: -0.16, bodyUp: -0.15, bodyFwd: -0.1 }),
  over: 0.06,
  ftFrac: 0.3,
});

// ── states: the compact posture is added to EVERY state (the rig's own poses assume the 2 m tall cobra), plus per-state motion ──────

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number): number => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
const easeOut = (x: number): number => 1 - Math.pow(1 - clamp01(x), 2.2);

/** The posture plus a delta. */
function pose(d: DofPartial = {}): DofPartial {
  const o: DofPartial = { ...POSTURE };
  for (const k of Object.keys(d) as DofName[]) o[k] = (o[k] ?? 0) + (d[k] as number);
  return o;
}

const states: AnimalProfile['states'] = {
  idle: () => pose(),
  respawn: () => pose(),
  // Slither: a vertical wave runs down the neck with the distance travelled (the rig's own wave is sideways = into the camera).
  run: (c) => {
    const ph = c.cur.pos.x * 5.2;
    const k = Math.min(1, c.runK * 1.3);
    return pose({ neckPitch: -0.2 * k + 0.07 * k * Math.sin(ph + 0.8), bodyCurl: 0.12 * k * Math.sin(ph), headPitch: -0.1 * k + 0.12 * k * Math.sin(ph + 1.7), bodyStretch: 0.02 * k * Math.sin(ph * 2) });
  },
  jumpSquat: (c) => {
    const u = c.total > 0 ? clamp01(c.t / c.total) : 0;
    const e = easeOut(u);
    return pose({ bodyStretch: -0.09 * e, bodyCurl: 0.35 * e, neckPitch: 0.2 * e, headPitch: -0.1 * e });
  },
  rise: () => pose({ neckPitch: 0.2, bodyCurl: -0.3, headPitch: 0.3, bodyStretch: 0.07, bodyPitch: 0.1 }),
  fall: (c) => {
    const w = Math.sin(c.t * 0.1) * 0.05;
    return pose({ neckPitch: 0.25 + w, bodyCurl: -0.25, headPitch: 0.15, bodyStretch: 0.04 });
  },
  fastFall: () => pose({ neckPitch: 0.75, bodyCurl: -0.5, headPitch: 0.4, bodyPitch: -0.3, bodyStretch: 0.06 }),
  landing: () => pose({ bodyCurl: 0.2 }),
  crouch: (c) => {
    const e = easeOut(Math.min(1, c.t / 4));
    return pose({ bodyCurl: 0.55 * e, neckPitch: 0.3 * e, headPitch: -0.2 * e });
  },
  dodgeSpot: (c) => {
    const e = smooth(Math.min(1, c.t / 4)) * (1 - smooth(((c.total > 0 ? c.t / c.total : 0) - 0.7) / 0.3));
    return pose({ bodyCurl: 0.7 * e, neckPitch: 0.35 * e, headPitch: -0.3 * e });
  },
  dodgeRoll: (c) => {
    const u = c.total > 0 ? clamp01(c.t / c.total) : 0;
    const tuck = Math.sin(Math.PI * clamp01(u * 1.05));
    // The whole snake rolls like a hoop: the neck is curled into the ring.
    return pose({ bodyCurl: 0.8 * tuck, neckPitch: -0.5 * tuck, headPitch: -0.5 * tuck, bodyStretch: -0.1 * tuck });
  },
  dodgeAir: (c) => {
    const u = c.total > 0 ? clamp01(c.t / c.total) : 0;
    const tuck = Math.sin(Math.PI * clamp01(u));
    return pose({ bodyCurl: 0.9 * tuck, neckPitch: -0.2 * tuck, headPitch: -0.4 * tuck });
  },
  hitstun: (c) => {
    const tot = Math.max(8, c.cur.hitstunTotal || c.total || 16);
    const e = Math.exp(-3.2 * clamp01(c.t / tot));
    const s = c.launchDir > 0 ? -1 : 1; // + = struck from the front: the head snaps back
    return pose({ neckPitch: 0.65 * s * e, bodyCurl: -0.35 * s * e, headPitch: 0.5 * s * e, jaw: 0.5 * e, bodyStretch: 0.05 * e });
  },
  tumble: (c) => {
    const ph = c.flail * 0.55;
    return pose({ bodyCurl: 0.7 * Math.sin(ph), neckPitch: 0.5 * Math.sin(ph + 1.3), headPitch: 0.5 * Math.sin(ph + 2.1), jaw: 0.4, bodyStretch: 0.05 });
  },
  // Knocked down the snake does not tip over (the generic collapse rolls the body 1.38 rad): the neck slumps flat instead.
  knockdown: (c) => {
    const e = easeOut(Math.min(1, c.t / 6));
    return pose({ bodyRoll: -1.38 * e, bodyUp: c.hipDrop * e, neckPitch: -1.55 * e, bodyCurl: -0.35 * e, headPitch: -0.2 * e, bodyStretch: 0.08 * e });
  },
  getup: (c) => {
    const u = c.total > 0 ? clamp01(c.t / c.total) : 0;
    const e = 1 - smooth(Math.min(1, u * 1.1));
    return pose({ bodyRoll: -1.38 * e, bodyUp: c.hipDrop * e, neckPitch: -1.55 * e, bodyCurl: -0.35 * e, headPitch: -0.2 * e, bodyStretch: 0.08 * e });
  },
  // Hanging by the head: the sim puts the TOP of the 1 m hurtbox at the ledge, so the head (≈ 1.1 m up in the posture) reaches out
  // over the edge and the coil dangles below; the neck stretches a little and the head looks forward.
  ledgeHang: (c) => {
    const e = easeOut(Math.min(1, c.t / 8));
    const sw = Math.sin(c.t * 0.09) * 0.05;
    return pose({ neckPitch: -0.35 * e, bodyCurl: -0.25 * e + sw, headPitch: 0.35 * e, neckExt: 0.5 * e, bodyStretch: 0.08 * e });
  },
  ledgeClimb: (c) => {
    const u = c.total > 0 ? clamp01(c.t / c.total) : 0;
    const e = 1 - smooth(Math.min(1, u * 1.15));
    const push = Math.sin(Math.PI * clamp01(u * 1.1));
    return pose({ neckPitch: -0.35 * e - 0.5 * push, bodyCurl: -0.25 * e + 0.3 * push, headPitch: 0.35 * e, neckExt: 0.5 * e, bodyStretch: 0.08 * e });
  },
};

export const pythonProfile: AnimalProfile = {
  animal: 'python',
  links: {
    bodyPitch: [{ j: 'body', ch: 'rx', k: -1 }],
    bodyYaw: [{ j: 'body', ch: 'ry', k: 1 }],
    bodyRoll: [{ j: 'body', ch: 'rz', k: 1 }],
    bodyFwd: [{ j: 'body', ch: 'pz', k: 1 }],
    bodyUp: [{ j: 'body', ch: 'py', k: 1 }],
    bodyStretch: [{ j: 'coil', ch: 's', k: 1 }],
    neckPitch: [{ j: 'neckJ.0', ch: 'rx', k: -1 }],
    neckYaw: [{ j: 'neckJ.0', ch: 'ry', k: -1 }],
    neckExt: [
      { j: 'neckJ.1', ch: 'rx', k: -0.2 },
      { j: 'neckJ.2', ch: 'rx', k: -0.38 },
      { j: 'neckJ.3', ch: 'rx', k: -0.42 },
    ],
    bodyCurl: [
      { j: 'neckJ.1', ch: 'rx', k: 1 },
      { j: 'neckJ.2', ch: 'rx', k: 1 },
      { j: 'neckJ.3', ch: 'rx', k: 1 },
    ],
    headPitch: [{ j: 'head', ch: 'rx', k: -1 }],
    headYaw: [{ j: 'head', ch: 'ry', k: -1 }],
    headRoll: [{ j: 'head', ch: 'rz', k: 1 }],
    jaw: [{ j: 'jaw', ch: 'rx', k: 1 }],
    tailYaw: [{ j: 'tailTip', ch: 'ry', k: -1 }],
  },
  tips: {
    head: { j: 'head', off: [0, 0.0, 0.3] },
    jaw: { j: 'jaw', off: [0, -0.02, 0.25] },
    tail: { j: 'tailTip', off: [0, 0, 0.6] },
    body: { j: 'coil', off: [0, 0.2, 0.55] },
  },
  mirror: [],
  hipDrop: 0.1,
  hipHeight: 0.8,
  hangTilt: 0,
  neutral: POSTURE,
  limits: {
    bodyPitch: [-1.5, 1.5],
    neckPitch: [-2.2, 1.7],
    bodyCurl: [-1.2, 1.1],
    headPitch: [-2.4, 0.9],
    jaw: [0, 1.1],
  },
  overrides: { bite, tailWhip, uppercut: risingCoil, spinAttack: constrict, lunge: venomLunge, bellyFlop: coilDrop, leapUp: springCoil },
  states,
  note: 'hand-written (WP-A3)',
};

registerProfile(pythonProfile);
