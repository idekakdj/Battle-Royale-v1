/**
 * EAGLE limb-role profile (rig: src/render/animals/Eagle.ts) — WP-A3.
 *
 * Joints: body (pivot (0,0.72,0): wings, head, legs, tail are its children), torso, head, tailFan (= `tail`, rest rx −0.25) with the
 * fan side pivots tailL/tailR, legs.0 (−X = NEAR) / legs.1 (0.38 m talons), wingLIn/wingRIn (shoulders at x ∓0.19), wingLOut/wingROut
 * (wrists, 0.5 m out) and five primaries per wing. The wing joints REST at full span (identity), the rig's idle folds them
 * explicitly (`wingPose(0)`: shoulder rz 1.05, wrist rz −2.05) — so this profile keeps a `neutral` overlay (folded wings) for
 * every attack, `neutralAir` (wings extended, legs trailing) for aerials, and drives flight / hang states itself (`stateBase`).
 * Verified against the rig with the FK probe (near wing = L = −X):
 *  - `wingNearFlap` (+ = raised) = wingLIn `−rz`; `wingNearFold` (+ = swept FORWARD) = wingLIn `+ry` (R wing: `+rz` / `−ry`);
 *  - `hindNearBend` / `hindFarBend` = the WRIST (+ = folded in / tip lifted) = wingLOut `−rz` (R: `+rz`) — a free DOF name reused
 *    because the eagle has no hind limbs (the talons are the `fore` role; hind DOFs are otherwise unmapped);
 *  - `neckExt` = primary-feather fan (1 = fully fanned), `tail2Yaw` = tail-fan opening, `tailPitch` + = tail up;
 *  - `foreNearSwing` + = talon forward; `bodyPitch` + = nose up; `headPitch` + = beak up.
 * Wing tips seen from the camera are foreshortened (the span points at the lens): the readable silhouettes are raised / lowered
 * flaps and forward / backward sweeps, which is what every move uses.
 */

import type { AnimalProfile, ArchCtx, ArchFn, ArchSpec, DofLink, FreeVar } from '../profile';
import { registerProfile } from '../profile';
import { AIR_TUCK, ARCHETYPES } from '../archetypes';
import type { DofName, DofPartial, DofVec } from '../dof';
import type { StateCtx } from '../states';

const TAU = Math.PI * 2;
const FAN = [0.1, 0.36, 0.62, 0.88, 1.14];
const fanL: DofLink[] = FAN.map((a, i) => ({ j: `primL.${i}`, ch: 'ry', k: a }));
const fanR: DofLink[] = FAN.map((a, i) => ({ j: `primR.${i}`, ch: 'ry', k: -a }));

// ── neutral poses (absolute DOF values) ─────────────────────────────────────────

/** Wings folded against the body (the rig's idle pose). */
const FOLDED: DofPartial = { wingNearFlap: -1.05, wingFarFlap: -1.05, hindNearBend: 2.05, hindFarBend: 2.05 };
/** Aerial neutral: wings out with a slight dihedral, fan open, talons trailing, tail fanned (AIR_TUCK is added on top by the builder). */
const AIR_NEUTRAL: DofPartial = {
  wingNearFlap: 0.28,
  wingFarFlap: 0.28,
  hindNearBend: 0.15,
  hindFarBend: 0.15,
  neckExt: 0.8,
  foreNearSwing: -0.7,
  foreFarSwing: -0.7 - (AIR_TUCK.foreFarSwing ?? 0),
  tail2Yaw: 0.7,
  tailPitch: -0.1 - (AIR_TUCK.tailPitch ?? 0),
};

/** Effective neutral of a form (what DOF value 0 means in a key). */
function baseOf(air: boolean): DofPartial {
  if (!air) return FOLDED;
  const o: DofPartial = { ...AIR_NEUTRAL };
  for (const k in AIR_TUCK) o[k as DofName] = (o[k as DofName] ?? 0) + (AIR_TUCK[k as DofName] ?? 0);
  return o;
}

/** Absolute pose → pose relative to the neutral of the form (the builder adds the neutral back). Unlisted DOFs stay at the neutral. */
function rel(air: boolean, p: DofPartial): DofPartial {
  const b = baseOf(air);
  const o: DofPartial = {};
  for (const k of Object.keys(p) as DofName[]) o[k] = (p[k] as number) - (b[k] ?? 0);
  return o;
}

/** Free variable with absolute bounds. */
function fr(air: boolean, d: DofName, lo: number, hi: number, tie?: DofName[]): FreeVar {
  const off = baseOf(air)[d] ?? 0;
  return { d, lo: lo - off, hi: hi - off, tie };
}

/** Wings open by `k` (0 folded … 1 spread): the absolute DOFs, with the extended wing level at `flap` and straight at `wrist`. */
function spread(k: number, flap = 0.1, wrist = 0, fan = 0.8): DofPartial {
  const f = -1.05 * (1 - k) + flap * k;
  const w = 2.05 * (1 - k) + wrist * k;
  return { wingNearFlap: f, wingFarFlap: f, hindNearBend: w, hindFarBend: w, neckExt: fan * k };
}

/** Wing flare added to a talon strike (wings thrown out for balance; raised wider in the wind-up). */
const FLARE_B: DofPartial = { wingNearFlap: -0.25, wingFarFlap: -0.25, hindNearBend: 0.9, hindFarBend: 0.9, wingNearFold: -0.3, wingFarFold: -0.3, neckExt: 0.7, tail2Yaw: 0.8 };
const FLARE_A: DofPartial = { wingNearFlap: 0.5, wingFarFlap: 0.5, hindNearBend: 0.4, hindFarBend: 0.4, wingNearFold: -0.5, wingFarFold: -0.5, neckExt: 0.9, tail2Yaw: 1 };

function withFlare(c: ArchCtx, s: ArchSpec, both = false): ArchSpec {
  const air = c.air;
  const B: DofPartial = { ...s.B, ...rel(air, FLARE_B) };
  const a0 = s.A;
  let free = s.free;
  if (both) {
    B.foreFarSwing = B.foreNearSwing;
    B.foreFarSpread = B.foreNearSpread;
    free = free.map((f) => (f.d === 'foreNearSwing' ? { ...f, tie: ['foreFarSwing'] as DofName[] } : f));
  }
  return {
    ...s,
    B,
    free,
    A: (b: DofVec) => {
      const a: DofPartial = { ...a0(b), ...rel(air, FLARE_A) };
      if (both) {
        a.foreFarSwing = a.foreNearSwing;
        a.foreFarSpread = a.foreNearSpread;
      }
      return a;
    },
  };
}

const swipe: ArchFn = (c) => withFlare(c, ARCHETYPES.swipe(c));
const backhand: ArchFn = (c) => withFlare(c, ARCHETYPES.backhand(c));
const rake: ArchFn = (c) => withFlare(c, ARCHETYPES.rake(c), true);

/** lightS (one wing slaps across the front) and heavyN (Gale Burst: both wings thrash down in one huge flap). */
const wingBuffet: ArchFn = (c) => {
  const air = c.air;
  if (c.anim.side === 'both') {
    return {
      tip: 'wingNear',
      // The flap: wings swept down and forward, wrists straight, the body lurching forward; the wind-up has them raised overhead.
      B: rel(air, { wingNearFlap: -0.6, wingFarFlap: -0.6, hindNearBend: 0.0, hindFarBend: 0.0, wingNearFold: 0.7, wingFarFold: 0.7, neckExt: 1, tail2Yaw: 1, bodyPitch: -0.15, bodyFwd: 0.15, tailPitch: 0.2 }),
      free: [],
      A: () => rel(air, { wingNearFlap: 1.25, wingFarFlap: 1.25, hindNearBend: 0.2, hindFarBend: 0.2, wingNearFold: -0.5, wingFarFold: -0.5, neckExt: 1, tail2Yaw: 1, bodyPitch: 0.4, bodyUp: 0.08, headPitch: 0.3, tailPitch: -0.3 }),
      over: 0.1,
      ftFrac: 0.3,
      noFit: true,
    };
  }
  return {
    tip: 'wingNear',
    swap: c.side === 'Far',
    B: rel(air, { ...FOLDED, wingNearFlap: 0.1, hindNearBend: 0.0, wingNearFold: 1.1, neckExt: 0.9, bodyFwd: 0.25, bodyYaw: 0.25, tail2Yaw: 0.5 }),
    free: [fr(air, 'wingNearFold', 0.4, 1.5), fr(air, 'wingNearFlap', -0.5, 0.5), { d: 'bodyFwd', lo: 0, hi: 0.5 }],
    A: () => rel(air, { ...FOLDED, wingNearFlap: 0.8, hindNearBend: 0.3, wingNearFold: -0.7, neckExt: 1, bodyYaw: -0.25, bodyPitch: 0.1, tail2Yaw: 0.6 }),
    over: 0.1,
    ftFrac: 0.3,
  };
};

/** lightU — Beak Flick: the head snaps up in a short peck (chest lifting). */
const uppercut: ArchFn = (c) => {
  const air = c.air;
  return {
    tip: 'head',
    B: rel(air, { headPitch: 0.9, bodyPitch: 0.3, bodyFwd: 0.12, bodyUp: 0.05, tailPitch: -0.2 }),
    free: [{ d: 'headPitch', lo: 0, hi: 1.4 }, { d: 'bodyPitch', lo: -0.2, hi: 0.8 }, { d: 'bodyFwd', lo: 0, hi: 0.4 }, { d: 'bodyUp', lo: -0.1, hi: 0.3 }],
    A: () => rel(air, { headPitch: -0.7, bodyPitch: -0.2, bodyFwd: -0.05, bodyUp: -0.03, tailPitch: 0.15 }),
    over: 0.08,
  };
};

/** dive: Piercing Dive (beak first, wings swept back), Stoop (talon stamp on the ground, a talons-first meteor in the air). */
const dive: ArchFn = (c) => {
  const air = c.air;
  const tuck: DofPartial = { ...FOLDED, wingNearFold: -0.3, wingFarFold: -0.3, neckExt: 0.1, tail2Yaw: 0, foreNearSwing: -0.9, foreFarSwing: -0.9 };
  if (c.role === 'head') {
    return {
      tip: 'head',
      B: rel(air, { ...tuck, bodyPitch: -0.95, headPitch: 0.5, bodyFwd: 0.3, bodyUp: 0, tailPitch: 0.3 }),
      free: [{ d: 'bodyPitch', lo: -1.5, hi: -0.3 }, { d: 'headPitch', lo: -0.2, hi: 1.2 }, { d: 'bodyFwd', lo: 0, hi: 0.7 }, { d: 'bodyUp', lo: -0.3, hi: 0.2 }],
      // Rear up with the wings thrown high, then fold and drop.
      A: () => rel(air, { ...spread(0.9, 0.9, 0.2), bodyPitch: 0.35, headPitch: 0.4, bodyUp: 0.1, bodyFwd: -0.12, foreNearSwing: 0.3, foreFarSwing: 0.3, tail2Yaw: 1 }),
      pre: [{ before: 3, v: () => rel(air, { ...tuck, wingNearFlap: -0.2, wingFarFlap: -0.2, bodyPitch: -0.2, headPitch: 0.3, bodyFwd: -0.05 }) }],
      over: 0.05,
      ftFrac: 0.3,
    };
  }
  if (air) {
    // Meteor: nose straight down, wings tucked, both talons thrust along the dive line.
    return {
      tip: 'foreNear',
      B: rel(air, { ...tuck, bodyPitch: -1.35, headPitch: 0.3, foreNearSwing: 1.3, foreFarSwing: 1.3, tailPitch: 0.3 }),
      free: [{ d: 'bodyPitch', lo: -1.5, hi: -0.6 }, { d: 'foreNearSwing', lo: 0.4, hi: 1.9, tie: ['foreFarSwing'] }, { d: 'bodyFwd', lo: -0.1, hi: 0.4 }],
      A: () => rel(air, { ...spread(0.8, 0.9, 0.2), bodyPitch: 0.3, headPitch: 0.3, foreNearSwing: -0.5, foreFarSwing: -0.5, tail2Yaw: 1 }),
      over: 0.05,
    };
  }
  // Ground stoop: hop up with the wings flared, stamp both talons down and forward.
  return {
    tip: 'foreNear',
    B: rel(air, { ...spread(0.55, -0.1, 0.6), wingNearFold: -0.2, wingFarFold: -0.2, bodyPitch: -0.15, bodyFwd: 0.3, bodyUp: 0, foreNearSwing: 0.9, foreFarSwing: 0.9, headPitch: 0.1, tail2Yaw: 0.8, tailPitch: 0.3 }),
    free: [{ d: 'foreNearSwing', lo: 0.2, hi: 1.7, tie: ['foreFarSwing'] }, { d: 'bodyFwd', lo: 0, hi: 0.5 }, { d: 'bodyPitch', lo: -0.5, hi: 0.2 }, { d: 'bodyUp', lo: -0.1, hi: 0.3 }],
    A: () => rel(air, { ...spread(0.9, 0.9, 0.3), bodyPitch: 0.25, bodyUp: 0.14, foreNearSwing: -0.7, foreFarSwing: -0.7, headPitch: 0.2, tail2Yaw: 1, tailPitch: -0.2 }),
    over: 0.08,
  };
};

/** heavyU — Soaring Updraft: three powerful wing beats while the body climbs (nose up, talons trailing, tail fanned). */
const soaring: ArchFn = (c) => {
  const air = c.air;
  const act = c.A;
  const beats = act >= 12 ? 3 : 1;
  const period = act / beats;
  const mid: { at: number; v: DofPartial }[] = [];
  // Wing delta relative to the downstroke pose at the first active frame: up-stroke (+) at the half period, back down at the full one.
  for (let i = 0; i < beats; i++) {
    const up = i * period + period * 0.5;
    if (up < act - 1) mid.push({ at: up, v: { wingNearFlap: 1.45, wingFarFlap: 1.45, hindNearBend: -0.8, hindFarBend: -0.8, wingNearFold: -0.3, wingFarFold: -0.3, bodyPitch: -0.06, bodyUp: 0.05 } });
    const down = (i + 1) * period;
    if (down < act - 1) mid.push({ at: down, v: { wingNearFlap: 0, wingFarFlap: 0 } });
  }
  return {
    tip: 'wingNear',
    // Downstroke at the first active frame: wings level, swept down and a little forward.
    B: rel(air, { wingNearFlap: -0.35, wingFarFlap: -0.35, hindNearBend: 0.0, hindFarBend: 0.0, wingNearFold: 0.3, wingFarFold: 0.3, neckExt: 1, tail2Yaw: 1, bodyPitch: 0.3, bodyFwd: 0.12, foreNearSwing: -0.6, foreFarSwing: -0.6, headPitch: 0.1, tailPitch: -0.2 }),
    free: [],
    A: () => rel(air, { wingNearFlap: 1.35, wingFarFlap: 1.35, hindNearBend: 0.3, hindFarBend: 0.3, wingNearFold: -0.4, wingFarFold: -0.4, neckExt: 1, tail2Yaw: 1, bodyPitch: -0.1, bodyUp: -0.12, foreNearSwing: 0.3, foreFarSwing: 0.3, headPitch: -0.1 }),
    mid,
    over: 0.05,
    ftFrac: 0.3,
    noFit: true,
  };
};

// ── states ──────────────────────────────────────────────────────────────────────

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number): number => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};

/** Flight pose of a rising eagle: a wing-beat cycle that starts raised (the jump is the downstroke) and settles to a slower beat. */
function rise(c: StateCtx): DofPartial {
  const t = c.t;
  const amp = 0.9 * Math.exp(-t / 40) + 0.22;
  const ph = (t / 21) * TAU;
  const cs = Math.cos(ph);
  const sn = Math.sin(ph);
  const flap = 0.15 + amp * cs;
  return {
    wingNearFlap: flap,
    wingFarFlap: flap,
    hindNearBend: 0.25 + 0.55 * amp * sn,
    hindFarBend: 0.25 + 0.55 * amp * sn,
    wingNearFold: 0.15 + 0.3 * amp * sn,
    wingFarFold: 0.15 + 0.3 * amp * sn,
    neckExt: 0.75 + 0.25 * cs,
    tail2Yaw: 0.8,
    tailPitch: -0.1,
    bodyPitch: 0.12,
    headPitch: 0.1,
    foreNearSwing: -0.35,
    foreFarSwing: -0.3,
  };
}

/** Falling: wings up in a braking V, fanned; the glide (fall speed pinned at the glide speed) levels them out. */
function fall(c: StateCtx): DofPartial {
  const vy = c.cur.vel.y;
  const gl = Math.exp(-(((vy + 6.5) / 0.5) ** 2));
  const fl = 0.04 * Math.sin(c.t * 0.16);
  return {
    wingNearFlap: 0.62 - 0.5 * gl + fl,
    wingFarFlap: 0.62 - 0.5 * gl + fl,
    hindNearBend: 0.35 - 0.2 * gl,
    hindFarBend: 0.35 - 0.2 * gl,
    wingNearFold: 0.1 + 0.1 * gl,
    wingFarFold: 0.1 + 0.1 * gl,
    neckExt: 0.9,
    tail2Yaw: 0.7 + 0.2 * gl,
    tailPitch: 0.1 - 0.25 * gl,
    bodyPitch: -0.05 - 0.28 * gl,
    headPitch: 0.1 * gl,
    foreNearSwing: 0.3 - 1.0 * gl,
    foreFarSwing: 0.25 - 1.0 * gl,
  };
}

/** Fast fall: the stoop — wings pinned back, body nose-down, talons trailing. */
function fastFall(_c: StateCtx): DofPartial {
  return {
    ...FOLDED,
    wingNearFlap: -0.8,
    wingFarFlap: -0.8,
    wingNearFold: -0.35,
    wingFarFold: -0.35,
    bodyPitch: -0.85,
    headPitch: 0.35,
    foreNearSwing: -1.0,
    foreFarSwing: -1.0,
    tailPitch: 0.3,
  };
}

/** Wings blended between folded (0) and spread (1) for the base-less states (hit, tumble, dodge, down, hang). */
function wingsAt(k: number, flap = 0.05, wrist = 0.1): DofPartial {
  const s = spread(k, flap, wrist, 0.7);
  return s;
}

function dodgeSpot(c: StateCtx): DofPartial {
  void c;
  return wingsAt(0.0);
}

function dodgeRoll(): DofPartial {
  return wingsAt(0.0);
}

function dodgeAir(c: StateCtx): DofPartial {
  const total = c.total > 0 ? c.total : 24;
  const k = Math.sin(Math.PI * clamp01(c.t / total));
  return wingsAt(0.55 * k, -0.2, 0.6);
}

function hitstun(c: StateCtx): DofPartial {
  const tot = Math.max(8, c.cur.hitstunTotal || c.total || 16);
  const e = Math.exp(-3.2 * clamp01(c.t / tot));
  return { ...wingsAt(0.85 * e, 0.45, 0.2), tail2Yaw: e };
}

function tumble(c: StateCtx): DofPartial {
  const ph = c.flail * 0.55;
  const f = 0.15 + 0.55 * Math.sin(ph);
  const s = spread(0.85, f, 0.2, 0.8);
  return { ...s, wingFarFlap: 0.15 + 0.55 * Math.sin(ph + 1.6), tail2Yaw: 0.9 };
}

function downed(c: StateCtx): DofPartial {
  const e = 1 - Math.pow(1 - clamp01(c.t / 6), 2.2);
  return { ...wingsAt(0.7 * e, -0.15, 0.7), wingNearFlap: -1.05 * (1 - 0.7 * e) + -0.15 * 0.7 * e };
}

function getup(c: StateCtx): DofPartial {
  const u = c.total > 0 ? clamp01(c.t / c.total) : 0;
  const e = 1 - smooth(Math.min(1, u * 1.1));
  return wingsAt(0.7 * e, -0.15, 0.7);
}

/** Hanging by the talons: the legs hold the ledge (generic ledge pose: legs up), the wings droop and sway. */
function ledgeHang(c: StateCtx): DofPartial {
  const e = 1 - Math.pow(1 - clamp01(c.t / 8), 2.2);
  const sw = Math.sin(c.t * 0.11);
  return {
    ...wingsAt(0.35 * e, -0.5 + 0.08 * sw, 1.1),
    hindNearBend: 2.05 * (1 - 0.35 * e) + 0.35 * e * 1.1,
    hindFarBend: 2.05 * (1 - 0.35 * e) + 0.35 * e * 1.1,
    tail2Yaw: 0.4,
    tailPitch: -0.3 * e,
  };
}

function ledgeClimb(c: StateCtx): DofPartial {
  const u = c.total > 0 ? clamp01(c.t / c.total) : 0;
  const k = Math.sin(Math.PI * clamp01(u * 1.05));
  return wingsAt(0.7 * k, 0.45, 0.2);
}

function jumpSquat(c: StateCtx): DofPartial {
  const u = c.total > 0 ? clamp01(c.t / c.total) : 0;
  const e = 1 - Math.pow(1 - u, 2.2);
  // Wings draw up and back for the take-off beat (relative to the idle fold the base pose writes).
  return { wingNearFlap: 1.1 * e, wingFarFlap: 1.1 * e, hindNearBend: -1.0 * e, hindFarBend: -1.0 * e, wingNearFold: -0.3 * e, wingFarFold: -0.3 * e, tail2Yaw: 0.6 * e };
}

export const eagleProfile: AnimalProfile = {
  animal: 'eagle',
  links: {
    bodyPitch: [{ j: 'body', ch: 'rx', k: -1 }],
    bodyYaw: [{ j: 'body', ch: 'ry', k: 1 }],
    bodyRoll: [{ j: 'body', ch: 'rz', k: 1 }],
    bodyFwd: [{ j: 'body', ch: 'pz', k: 1 }],
    bodyUp: [{ j: 'body', ch: 'py', k: 1 }],
    bodyStretch: [{ j: 'body', ch: 's', k: 1 }],
    neckPitch: [{ j: 'head', ch: 'rx', k: -0.5 }],
    neckYaw: [{ j: 'head', ch: 'ry', k: -0.5 }],
    headPitch: [{ j: 'head', ch: 'rx', k: -1 }],
    headYaw: [{ j: 'head', ch: 'ry', k: -1 }],
    headRoll: [{ j: 'head', ch: 'rz', k: 1 }],
    tailPitch: [{ j: 'tailFan', ch: 'rx', k: 1 }],
    tailYaw: [{ j: 'tailFan', ch: 'ry', k: -1 }],
    tail2Yaw: [
      { j: 'tailL', ch: 'ry', k: 0.34 },
      { j: 'tailR', ch: 'ry', k: -0.34 },
    ],
    foreNearSwing: [{ j: 'legs.0', ch: 'rx', k: -1 }],
    foreNearSpread: [{ j: 'legs.0', ch: 'rz', k: -1 }],
    foreFarSwing: [{ j: 'legs.1', ch: 'rx', k: -1 }],
    foreFarSpread: [{ j: 'legs.1', ch: 'rz', k: 1 }],
    wingNearFlap: [{ j: 'wingLIn', ch: 'rz', k: -1 }],
    wingFarFlap: [{ j: 'wingRIn', ch: 'rz', k: 1 }],
    wingNearFold: [{ j: 'wingLIn', ch: 'ry', k: 1 }],
    wingFarFold: [{ j: 'wingRIn', ch: 'ry', k: -1 }],
    hindNearBend: [{ j: 'wingLOut', ch: 'rz', k: -1 }],
    hindFarBend: [{ j: 'wingROut', ch: 'rz', k: 1 }],
    neckExt: [...fanL, ...fanR],
  },
  tips: {
    foreNear: { j: 'legs.0', off: [0, -0.38, 0.12] },
    foreFar: { j: 'legs.1', off: [0, -0.38, 0.12] },
    head: { j: 'head', off: [0, 0, 0.34] },
    tail: { j: 'tailFan', off: [0, 0, -0.45] },
    wingNear: { j: 'wingLOut', off: [-0.4, 0, -0.05] },
    wingFar: { j: 'wingROut', off: [0.4, 0, -0.05] },
    body: { j: 'body', off: [0, -0.05, 0.4] },
  },
  mirror: [
    ['legs.0', 'legs.1'],
    ['wingLIn', 'wingRIn'],
    ['wingLOut', 'wingROut'],
    ['tailL', 'tailR'],
    ...[0, 1, 2, 3, 4].map((i) => [`primL.${i}`, `primR.${i}`] as const),
  ],
  hipDrop: 0.3,
  hipHeight: 0.46,
  hangTilt: 0.5,
  neutral: FOLDED,
  neutralAir: AIR_NEUTRAL,
  limits: {
    foreNearSwing: [-1.4, 2.4],
    foreFarSwing: [-1.4, 2.4],
    bodyPitch: [-1.5, 1.0],
    headPitch: [-0.9, 1.4],
    wingNearFlap: [-2.4, 2.4],
    wingFarFlap: [-2.4, 2.4],
    wingNearFold: [-1.5, 1.6],
    wingFarFold: [-1.5, 1.6],
  },
  overrides: { swipe, backhand, rake, wingBuffet, uppercut, dive, leapUp: soaring },
  states: {
    jumpSquat,
    rise,
    fall,
    fastFall,
    dodgeSpot,
    dodgeRoll,
    dodgeAir,
    hitstun,
    tumble,
    knockdown: downed,
    getup,
    ledgeHang,
    ledgeClimb,
  },
  stateBase: { rise: null, fall: null, fastFall: null },
  note: 'hand-written (WP-A3)',
};

registerProfile(eagleProfile);
