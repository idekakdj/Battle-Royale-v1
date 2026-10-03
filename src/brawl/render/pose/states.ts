/**
 * Generic (non-attack) state poses, plan §6.7: jump squat, rise, fall, fast-fall, landing, crouch, dodges, hitstun, tumble,
 * knockdown, get-up, ledge hang / climb, respawn. They are written in canonical DOFs (so every animal gets a plausible
 * pose from its profile) plus a few ROOT-level channels the BrawlRig owns (squash/stretch, tilt about the hurtbox centre).
 * Idle and walk/run use the rig's own authored idle / gait through `BaseRig.brawlBase`.
 *
 * Every function is a pure function of the state's frame counters (+ velocity), never of wall-clock time.
 */

import type { BrawlFighterState } from '../../types';
import { DOF, newVec, type DofPartial, type DofVec } from './dof';

export type StateKey =
  | 'idle'
  | 'run'
  | 'jumpSquat'
  | 'rise'
  | 'fall'
  | 'fastFall'
  | 'landing'
  | 'crouch'
  | 'dodgeSpot'
  | 'dodgeRoll'
  | 'dodgeAir'
  | 'hitstun'
  | 'tumble'
  | 'knockdown'
  | 'getup'
  | 'ledgeHang'
  | 'ledgeClimb'
  | 'respawn';

export interface StatePose {
  /** Which of the rig's own base poses is written first (null = none). */
  base: 'idle' | 'run' | 'jump' | null;
  /** `run`: speed as a fraction of the top run speed; `jump`: vertical speed (m/s). */
  baseArg: number;
  /** DOF overlay (facing +1 frame). */
  dofs: DofVec;
  /** Vertical squash (+ = squash down & widen, − = stretch up), about the feet. */
  squash: number;
  /** Root tilt about the hurtbox centre: + = nose up (in the facing direction). */
  tilt: number;
  /** Extra forward-roll rotation (radians, in the facing direction: + = rolling forward). */
  roll: number;
  /** Root vertical offset (m). */
  lift: number;
}

export function newStatePose(): StatePose {
  return { base: null, baseArg: 0, dofs: newVec(), squash: 0, tilt: 0, roll: 0, lift: 0 };
}

export interface StateCtx {
  cur: BrawlFighterState;
  /** Continuous frames spent in the current action (actionFrame − (1 − alpha), ≥ 0). */
  t: number;
  /** Total frames of the action (0 = open-ended). */
  total: number;
  /** |vx| as a fraction of the animal's run speed, and the run speed itself. */
  runK: number;
  /** Facing as ±1. */
  facing: 1 | -1;
  hipDrop: number;
  hangTilt: number;
  /** Vertical impact speed remembered from the last airborne frame (landing squash). */
  impactVy: number;
  /** Launch direction relative to the facing: +1 = thrown forward (hit from behind), −1 = thrown back. */
  launchDir: number;
  /** Launch speed (m/s). */
  launchSpeed: number;
  /** Time-of-hit-independent flail phase (frames). */
  flail: number;
  /** DOF overlays from the profile (`profile.states[key]`). */
  extra: DofPartial | undefined;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number): number => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
const easeOut = (x: number): number => 1 - Math.pow(1 - clamp01(x), 2.2);

function set(v: DofVec, p: DofPartial, k = 1): void {
  for (const key in p) v[DOF[key as keyof typeof DOF]] += (p[key as keyof typeof p] as number) * k;
}

/** Fill `out` for the state `key`. */
export function poseState(key: StateKey, c: StateCtx, out: StatePose): void {
  out.base = null;
  out.baseArg = 0;
  out.dofs.fill(0);
  out.squash = 0;
  out.tilt = 0;
  out.roll = 0;
  out.lift = 0;
  const v = out.dofs;
  const u = c.total > 0 ? clamp01(c.t / c.total) : 0;
  switch (key) {
    case 'idle':
      out.base = 'idle';
      break;
    case 'run':
      out.base = 'run';
      out.baseArg = Math.max(0.12, Math.min(1.15, c.runK));
      set(v, { bodyPitch: -0.05 * Math.min(1, c.runK) });
      break;
    case 'jumpSquat': {
      const e = easeOut(u);
      out.base = 'idle';
      out.squash = 0.15 * e;
      set(v, { bodyPitch: -0.06, foreNearSwing: 0.35, foreFarSwing: 0.35, hindNearSwing: -0.25, hindFarSwing: -0.25, headPitch: -0.12, tailPitch: 0.15 }, e);
      break;
    }
    case 'rise': {
      out.base = 'jump';
      out.baseArg = c.cur.vel.y;
      const k = clamp01(c.cur.vel.y / 14);
      out.squash = -0.06 * k;
      set(v, { bodyPitch: 0.1, headPitch: 0.1, foreNearSwing: 0.2, foreFarSwing: 0.15, tailPitch: -0.15 });
      break;
    }
    case 'fall': {
      out.base = 'jump';
      out.baseArg = c.cur.vel.y;
      set(v, { bodyPitch: -0.05, foreNearSwing: 0.55, foreFarSwing: 0.45, hindNearSwing: -0.1, hindFarSwing: -0.2, headPitch: 0.05, tailPitch: 0.25 });
      out.squash = -0.02;
      break;
    }
    case 'fastFall': {
      out.base = 'jump';
      out.baseArg = c.cur.vel.y;
      set(v, { bodyPitch: -0.38, foreNearSwing: -0.5, foreFarSwing: -0.55, hindNearSwing: -0.7, hindFarSwing: -0.65, headPitch: -0.2, neckPitch: -0.15, tailPitch: 0.5 });
      out.squash = -0.1;
      break;
    }
    case 'landing': {
      const amp = 0.14 + 0.1 * clamp01(Math.abs(c.impactVy) / 22);
      const k = c.total > 0 ? Math.sin(Math.PI * Math.pow(u, 0.6)) : 0.6;
      out.base = 'idle';
      out.squash = amp * k;
      set(v, { bodyPitch: -0.06, foreNearSwing: 0.2, foreFarSwing: 0.2, hindNearSwing: 0.15, hindFarSwing: 0.15, headPitch: -0.1 }, k);
      break;
    }
    case 'crouch': {
      const e = easeOut(Math.min(1, c.t / 4));
      out.base = 'idle';
      out.squash = 0.18 * e;
      set(v, { headPitch: -0.2, neckPitch: -0.1, foreNearSwing: 0.15, foreFarSwing: 0.15, bodyPitch: -0.04, tailPitch: 0.1 }, e);
      break;
    }
    case 'dodgeSpot': {
      // Duck and lean away; the view flickers the body while invulnerable.
      const e = smooth(Math.min(1, c.t / 4)) * (1 - smooth((u - 0.7) / 0.3));
      out.squash = 0.2 * e;
      set(v, { bodyPitch: 0.12, headPitch: -0.2, foreNearSwing: 0.5, foreFarSwing: 0.5, hindNearSwing: -0.3, hindFarSwing: -0.3, bodyRoll: 0.12, tailPitch: 0.3 }, e);
      break;
    }
    case 'dodgeRoll': {
      // Forward roll: tuck and rotate about the hurtbox centre.
      const e = smooth(u);
      const tuck = Math.sin(Math.PI * clamp01(u * 1.05));
      out.roll = 2 * Math.PI * e;
      out.squash = 0.12 * tuck;
      set(v, { bodyPitch: -0.5, headPitch: -0.5, neckPitch: -0.3, foreNearSwing: 1.0, foreFarSwing: 1.0, hindNearSwing: 1.0, hindFarSwing: 1.0, tailPitch: 0.7, bodyCurl: 0.5 }, tuck);
      break;
    }
    case 'dodgeAir': {
      // Spin about the vertical axis with the limbs drawn in.
      const e = smooth(u);
      const tuck = Math.sin(Math.PI * clamp01(u));
      v[DOF.bodyYaw] += 2 * Math.PI * e;
      out.squash = 0.06 * tuck;
      set(v, { bodyPitch: -0.2, foreNearSwing: 0.7, foreFarSwing: 0.7, hindNearSwing: 0.5, hindFarSwing: 0.5, headPitch: -0.2 }, tuck);
      break;
    }
    case 'hitstun': {
      // Flinch away from the hit: arch back when struck from the front, fold forward when struck from behind.
      const tot = Math.max(8, c.cur.hitstunTotal || c.total || 16);
      const e = Math.exp(-3.2 * clamp01(c.t / tot));
      const s = c.launchDir > 0 ? -1 : 1; // thrown forward → hit from behind → lean forward
      out.base = null;
      set(v, { bodyPitch: 0.34 * s, headPitch: 0.45 * s, neckPitch: 0.2 * s, jaw: 0.35, foreNearSwing: 0.9, foreFarSwing: 0.7, hindNearSwing: -0.45, hindFarSwing: -0.3, tailPitch: 0.5, bodyUp: 0.03 }, e);
      out.squash = -0.05 * e;
      out.tilt = 0.14 * s * e;
      break;
    }
    case 'tumble': {
      // The rotation about the centre is the BrawlRig's integrator; the limbs flail.
      const ph = c.flail * 0.55;
      set(v, {
        foreNearSwing: 0.9 + 0.7 * Math.sin(ph),
        foreFarSwing: 0.9 + 0.7 * Math.sin(ph + 2.1),
        hindNearSwing: -0.2 + 0.7 * Math.sin(ph + 1.0),
        hindFarSwing: -0.2 + 0.7 * Math.sin(ph + 3.2),
        foreNearSpread: 0.3,
        foreFarSpread: 0.3,
        headPitch: 0.3 * Math.sin(ph + 0.6),
        jaw: 0.3,
        tailPitch: 0.4 * Math.sin(ph + 1.7),
        bodyPitch: 0.1,
      });
      break;
    }
    case 'knockdown': {
      // Collapse onto the side (the BR knockdown, but with the hip drop from the profile), limp limbs.
      const e = easeOut(Math.min(1, c.t / 6));
      set(v, { bodyRoll: 1.38, bodyUp: -c.hipDrop, foreNearSwing: 0.35, foreFarSwing: 0.5, hindNearSwing: 0.4, hindFarSwing: 0.25, headPitch: -0.2, neckPitch: -0.1, headRoll: 0.25, tailPitch: -0.3 }, e);
      break;
    }
    case 'getup': {
      // Reverse of the collapse with a small hop at the end.
      const e = 1 - smooth(Math.min(1, u * 1.1));
      set(v, { bodyRoll: 1.38, bodyUp: -c.hipDrop, foreNearSwing: 0.35, foreFarSwing: 0.5, hindNearSwing: 0.4, hindFarSwing: 0.25, headPitch: -0.2, neckPitch: -0.1, headRoll: 0.25, tailPitch: -0.3 }, e);
      out.squash = 0.1 * Math.sin(Math.PI * clamp01((u - 0.55) / 0.45));
      break;
    }
    case 'ledgeHang': {
      // Hang by the forelimbs; the whole body is tilted about the hurtbox centre (nose up) and dangles.
      const e = easeOut(Math.min(1, c.t / 8));
      const sway = Math.sin(c.t * 0.09) * 0.04;
      out.tilt = c.hangTilt * e + sway;
      set(v, { foreNearSwing: 2.7, foreFarSwing: 2.5, foreNearBend: 0.2, foreFarBend: 0.2, foreNearSpread: 0.15, foreFarSpread: 0.15, hindNearSwing: 0.45, hindFarSwing: 0.2, headPitch: 0.35, bodyPitch: 0.2, tailPitch: -0.4 }, e);
      break;
    }
    case 'ledgeClimb': {
      // Pull up and over: the tilt unwinds while the forelimbs push down, then settle.
      const e = 1 - smooth(Math.min(1, u * 1.15));
      const push = Math.sin(Math.PI * clamp01(u * 1.1));
      out.tilt = c.hangTilt * e;
      set(v, { foreNearSwing: 2.7, foreFarSwing: 2.5, foreNearBend: 0.2, foreFarBend: 0.2, hindNearSwing: 0.45, hindFarSwing: 0.2, headPitch: 0.35, bodyPitch: 0.2 }, e);
      set(v, { foreNearSwing: -0.6, foreFarSwing: -0.6, bodyPitch: -0.2, headPitch: -0.15 }, push);
      out.squash = 0.08 * push;
      break;
    }
    case 'respawn':
      out.base = 'idle';
      out.squash = 0.04 * Math.sin(c.t * 0.12);
      break;
  }
  if (c.extra !== undefined) set(v, c.extra);
}
