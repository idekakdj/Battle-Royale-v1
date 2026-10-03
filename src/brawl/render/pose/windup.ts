/**
 * WP-P — generic, weight-scaled WIND-UP layer (anticipation readability).
 *
 * The archetype generators author a small anticipation pose `A` (limb cocked, head raised …). On moves with a long startup
 * that is not enough to read the attack coming. This layer strengthens `A` in two ways, both derived ONLY from the move
 * data (startup, damage, armor, motion), so it adapts automatically when the balance numbers change:
 *
 *  1. a body-level COIL (weight shifts onto the rear legs, the body crouches / rears back, the shoulders twist away from
 *     the target, the neck draws back, the tail counter-balances) taken from {@link COIL}, a per-archetype table of the
 *     pose at full strength; each DOF is pushed in the table's direction up to `amp × table value`
 *     (never reduced, so hand-tuned animal overrides that already coil harder stay as they are);
 *  2. a minimum ARC for the striking family's DOFs (fore / hind swing, neck / head, tail, wing flap): the distance between
 *     the anticipation and the strike pose is at least `amp × ARC[dof]`, extended away from the strike, inside the
 *     profile's anatomical limits.
 *
 * `amp` = budget × (0.4 + 0.6 × weight): `budget` fades the layer out for very short startups (a 4-frame jab keeps its
 * minimum 2-frame cue), `weight` is 0 for a light poke and 1 for a heavy KO move. The smoothness repair loop in build.ts
 * still scales the whole anticipation down if the per-frame angular budget would be exceeded.
 */

import type { ArchetypeId, MoveBody } from '../../types';
import { famOfRole, type Family } from './archetypes';
import { DOF, type DofName, type DofPartial, type DofVec } from './dof';
import { getMoveset } from '../../data';
import type { AnimalProfile, ArchCtx, ArchSpec, TipRole } from './profile';

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** QA switch (demo `__brawlMoves.windup(false)`): `off` restores the pre-WP-P timeline exactly (weight 0, no wind-up layer). */
export const windupDebug = { off: false };

/** 0 = light poke, 1 = heavy KO move. Derived from the startup, the strongest hit's damage and armor. */
export function moveWeight(body: MoveBody, strikeF: number): number {
  if (windupDebug.off) return 0;
  let dmg = 0;
  for (const h of body.hitboxes) dmg = Math.max(dmg, h.damage);
  const wS = clamp01((strikeF - 6) / 12);
  const wD = clamp01((dmg - 5) / 9);
  const wA = body.armor !== undefined ? 0.1 : 0;
  return clamp01(0.6 * wS + 0.4 * wD + wA);
}

/** Strength of the wind-up layer for a move with the given weight and first active frame (0 for very short moves). */
export function windupAmp(weight: number, strikeF: number): number {
  if (windupDebug.off) return 0;
  const budget = clamp01((strikeF - 3) / 8);
  return budget * (0.4 + 0.6 * weight);
}

/** Forward travel (m) and upward travel (m) the move's `motion` windows produce: bigger lunges / leaps coil harder. */
export function motionTravel(body: MoveBody): { fwd: number; up: number } {
  let fwd = 0;
  let up = 0;
  for (const m of body.motion ?? []) {
    const t = Math.max(0, m.to - m.from) / 60;
    if (m.vx !== undefined && m.vx > 0) fwd += m.vx * t;
    if (m.vy !== undefined && m.vy > 0) up += m.vy * t;
  }
  return { fwd, up };
}

/**
 * The wind-up pose at full strength per archetype (facing +1, striker = near limb, target in front). Values are the
 * COIL on top of rest: negative `bodyFwd` = drawn back, negative `bodyUp` = crouch (a root squash on the ground),
 * positive `bodyPitch` = chest / nose up, negative `bodyYaw` = near side drawn back (shoulder twist).
 */
export const COIL: Partial<Record<ArchetypeId, DofPartial>> = {
  bite: { bodyFwd: -0.3, bodyUp: -0.16, bodyPitch: 0.1, neckPitch: 0.35, headPitch: -0.12, tailPitch: 0.35, hindNearSwing: 0.35, hindFarSwing: 0.3 },
  lunge: { bodyFwd: -0.34, bodyUp: -0.18, bodyPitch: 0.1, neckPitch: 0.3, headPitch: -0.1, tailPitch: 0.4, hindNearSwing: 0.45, hindFarSwing: 0.4 },
  charge: { bodyFwd: -0.28, bodyUp: -0.16, bodyPitch: 0.12, tailPitch: 0.3, hindNearSwing: 0.4, hindFarSwing: 0.4, foreNearSwing: -0.45, foreFarSwing: -0.45 },
  headbutt: { bodyFwd: -0.26, bodyUp: -0.12, bodyPitch: 0.12, neckPitch: 0.3, headPitch: 0.1, tailPitch: 0.3 },
  tether: { bodyFwd: -0.3, bodyUp: -0.1, bodyPitch: 0.1, neckPitch: 0.5, headPitch: 0.2 },
  neckSwing: { bodyFwd: -0.12, bodyYaw: -0.2, bodyPitch: 0.08, tailPitch: 0.3 },
  jab: { bodyFwd: -0.14, bodyUp: -0.07, bodyYaw: -0.25, bodyPitch: 0.03, tailPitch: 0.2 },
  swipe: { bodyFwd: -0.14, bodyUp: -0.1, bodyYaw: -0.38, bodyPitch: 0.05, tailPitch: 0.25 },
  backhand: { bodyFwd: -0.12, bodyUp: -0.1, bodyYaw: -0.42, tailPitch: 0.25 },
  rake: { bodyFwd: -0.1, bodyPitch: 0.3, bodyUp: 0.04, headPitch: 0.2 },
  uppercut: { bodyFwd: -0.1, bodyUp: -0.2, bodyPitch: -0.16, headPitch: -0.25, bodyYaw: -0.2, tailPitch: -0.2 },
  hornUp: { bodyFwd: -0.1, bodyUp: -0.2, bodyPitch: -0.2, neckPitch: -0.45, headPitch: -0.6 },
  leapUp: { bodyFwd: -0.1, bodyUp: -0.22, bodyPitch: -0.14, hindNearSwing: 0.7, hindFarSwing: 0.65, tailPitch: -0.2 },
  kick: { bodyFwd: -0.08, bodyUp: -0.08, bodyPitch: 0.14, bodyYaw: -0.1 },
  stomp: { bodyPitch: 0.22, bodyUp: 0.03, tailPitch: -0.2 },
  slam: { bodyPitch: 0.5, bodyUp: 0.1, headPitch: 0.2, tailPitch: -0.3 },
  spinAttack: { bodyFwd: -0.05, bodyUp: -0.2, bodyYaw: -0.6, tailPitch: 0.2 },
  roar: { bodyFwd: -0.08, bodyUp: -0.2, bodyPitch: -0.22, neckPitch: -0.25, headPitch: -0.35, tailPitch: -0.25, foreNearSwing: -0.4, foreFarSwing: -0.4 },
  bellyFlop: { bodyUp: 0.2, bodyPitch: 0.25 },
  burrow: { bodyPitch: 0.3, bodyUp: 0.05 },
  dive: { bodyPitch: 0.5, bodyUp: 0.05 },
};

/** Minimum anticipation → strike distance (rad) of the striking family's DOFs at full strength. */
const ARC: Partial<Record<DofName, number>> = {
  foreNearSwing: 2.3,
  foreFarSwing: 2.3,
  hindNearSwing: 2.2,
  hindFarSwing: 2.2,
  neckPitch: 0.7,
  headPitch: 0.5,
  tailPitch: 1.3,
  tail2Pitch: 1.0,
  wingNearFlap: 1.9,
  wingFarFlap: 1.9,
};

const FAM_ARC: Record<Family, readonly DofName[]> = {
  fore: ['foreNearSwing', 'foreFarSwing'],
  hind: ['hindNearSwing', 'hindFarSwing'],
  head: ['neckPitch', 'headPitch'],
  jaw: ['neckPitch', 'headPitch'],
  tail: ['tailPitch', 'tail2Pitch'],
  wing: ['wingNearFlap', 'wingFarFlap'],
  body: [],
};

const DEFAULT_LIM: Partial<Record<DofName, readonly [number, number]>> = {
  foreNearSwing: [-1.4, 2.8],
  foreFarSwing: [-1.4, 2.8],
  hindNearSwing: [-1.4, 2.6],
  hindFarSwing: [-1.4, 2.6],
  neckPitch: [-1.1, 1.1],
  headPitch: [-0.8, 0.9],
  tailPitch: [-1.6, 1.9],
  tail2Pitch: [-1.2, 1.4],
  wingNearFlap: [-1.6, 1.8],
  wingFarFlap: [-1.6, 1.8],
};

/** Coil DOFs that the striking family itself drives and must be left to the archetype (a tail whip does not counter-swing its own tail). */
const OWN: Record<Family, readonly DofName[]> = {
  fore: [],
  hind: [],
  head: [],
  jaw: [],
  tail: ['tailPitch', 'tail2Pitch'],
  wing: [],
  body: [],
};

/** Translations (m) of the coil scale with the animal's size: a 3.5 m crocodile must move further than a 1.1 m lion to read. */
const TRANSLATE: readonly DofName[] = ['bodyFwd', 'bodyUp'];
function sizeScale(prof: AnimalProfile): number {
  const w = getMoveset(prof.animal).stats.width;
  return Math.min(1.6, Math.max(0.85, Math.pow(w / 1.1, 0.7)));
}

export interface WindupInfo {
  weight: number;
  amp: number;
}

/**
 * Strengthen the anticipation vector `A` (in place, near-striker frame) of one move.
 * @param B the solved strike pose (first active frame)
 */
export function applyWindup(A: DofVec, B: DofVec, ctx: ArchCtx, spec: ArchSpec, prof: AnimalProfile, role: TipRole, info: WindupInfo): void {
  const cfg = spec.windup;
  if (cfg === false) return;
  const gain = (cfg?.gain ?? 1) * (prof.windupGain ?? 1);
  const amp = info.amp * gain;
  if (amp < 0.02) return;
  const fam = famOfRole(role);
  const coil = cfg?.coil ?? prof.coil?.[ctx.body.archetype] ?? COIL[ctx.body.archetype];
  const authoritative = cfg?.coil !== undefined || prof.coil?.[ctx.body.archetype] !== undefined;
  const mt = motionTravel(ctx.body);
  const kMove = 1 + 0.35 * clamp01(mt.fwd / 2.5) + 0.3 * clamp01(mt.up / 3);
  const kSize = sizeScale(prof);
  const back = ctx.dir === 1;
  if (coil !== undefined) {
    const own = OWN[fam];
    for (const key in coil) {
      const d = key as DofName;
      if (own.includes(d)) continue;
      if (!back && (d === 'neckPitch' || d === 'headPitch' || d === 'hindNearSwing' || d === 'hindFarSwing')) continue;
      let t = (coil[d] as number) * amp * kMove * (back ? 1 : 0.5) * (TRANSLATE.includes(d) ? kSize : 1);
      if (!back && d === 'bodyFwd') t = -t;
      if (ctx.air && d === 'bodyUp' && t < 0) t *= 0.6;
      const i = DOF[d];
      // The generic table never fights an authored anticipation that already goes the OTHER way (the gorilla's wide-armed chest drum);
      // a per-animal / per-move table is authoritative and may flip it (the lion's tucked chin).
      if (!authoritative && Math.abs(A[i]) >= 0.15 && A[i] * t < 0) continue;
      if (t > 0) {
        if (A[i] < t) A[i] = t;
      } else if (t < 0) {
        if (A[i] > t) A[i] = t;
      }
    }
  }
  if (cfg?.noArcs === true) return;
  // Minimum arc of the striking family's DOFs (only the ones this move actually moves).
  for (const d of FAM_ARC[fam]) {
    const arc = ARC[d];
    if (arc === undefined) continue;
    const i = DOF[d];
    const dist = A[i] - B[i];
    if (Math.abs(dist) < 0.3) continue;
    const want = amp * arc;
    if (Math.abs(dist) >= want) continue;
    const s = dist > 0 ? 1 : -1;
    const lim = prof.limits?.[d] ?? DEFAULT_LIM[d];
    let v = B[i] + s * want;
    if (lim !== undefined) v = Math.min(lim[1], Math.max(lim[0], v));
    // Never pull the anticipation back toward the strike pose.
    if (s > 0 ? v > A[i] : v < A[i]) A[i] = v;
  }
}
