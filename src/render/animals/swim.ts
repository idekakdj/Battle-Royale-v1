/**
 * Swimming / attacking-while-swimming animation data + pure helpers (v1.8 Jungle pool, WP-J4, docs/JUNGLE-PLAN.md).
 *
 * The pool is SHALLOW: {@link WATER_DEPTH} ≈ 0.55 m, nobody is ever fully submerged. `FighterState.inWater` (sim, absent =
 * false) turns on the swim layer of `BaseRig` (Animator.ts): a smoothed blend (~0.15 s) that sinks the whole body into the
 * water, replaces the run / idle pose by a PADDLE pose and bends the authored basic-attack / block poses for the water.
 *
 * SCENE CONTRACT (for WP-J3 / the jungle scene): the rig root stays at the sim's ground height (y = fighter pos.y). The
 * pool surface sits at rig-local y = {@link poolLevel}.surfaceY (default 0 = flush with the ground rim, the bed 0.55 m below)
 * and the RIG sinks itself by up to {@link WATER_DEPTH} so a wader's feet reach the bed. A scene that instead RAISES the
 * water over a flat floor (surface at +0.55) calls `poolLevel.surfaceY = WATER_DEPTH` once and the sink scales to zero.
 *
 * No three / DOM imports: node-safe, shared by the rigs, the demo and the tests.
 */

import type { AnimalId } from '../../core/types';
import { JUNGLE_POOL_DEPTH } from '../../config/arenas';

/** Visible water depth of the jungle pool (m). */
export const WATER_DEPTH: number = JUNGLE_POOL_DEPTH;

/**
 * Where the water surface is relative to the rig root (see the scene contract above). `surfaceY` 0 → the rig sinks by its
 * full {@link SwimTune.sink}; `surfaceY` = {@link WATER_DEPTH} (water raised over a flat floor) → no sink at all.
 */
export const poolLevel = { surfaceY: 0 };

/** Fraction of the authored sink that applies for the current {@link poolLevel} (1 = the surface is at the rig root). */
export function poolSinkScale(): number {
  const k = 1 - poolLevel.surfaceY / WATER_DEPTH;
  return k < 0 ? 0 : k > 1 ? 1 : k;
}

/** Seconds of the land ↔ water blend (plan: ≈ 0.15 s), and the faster one used when a jump launches out of the water. */
export const SWIM_BLEND_S = 0.15;
export const SWIM_BLEND_AIR_S = 0.07;

/** Seconds between wake-ripple FX calls while swimming (plan: ≈ 0.12 s). */
export const WAKE_PERIOD_S = 0.12;

/** The binding impact instant of a basic swing (u = actionT / actionDur), = Animator's `IMPACT`. */
export const SWIM_IMPACT_U = 0.55;

/** Fraction of the water sink that the first-person eye drops (the view sits lower in the water). */
export const SWIM_EYE_FRACTION = 0.8;

/** Per-animal swim tuning (rig-local metres / radians). Read by `BaseRig.poseSwim` and the per-animal overrides. */
export interface SwimTune {
  /** Metres the whole body is lowered while swimming (≤ {@link WATER_DEPTH}); legs end near the pool bed. */
  sink: number;
  /** Sink (m) of a COLLAPSED body (knockdown / dead): it floats / lies at the water line and never goes below the pool bed. */
  settle: number;
  /** Rest height of the top of the back (m) — documentation + the test that the back stays above the water line. */
  back: number;
  /** Rest height of the head's top (m) — same purpose. */
  head: number;
  /** Paddle cycles per second when treading in place / at full water speed. */
  freqMin: number;
  freqMax: number;
  /** Leg paddle amplitude (rad) at full speed. */
  legAmp: number;
  /** Fraction of {@link legAmp} used while treading in place. */
  tread: number;
  /** Rearward bias of the paddling legs (rad; rx > 0 swings a leg BACK, rx < 0 forward). */
  tuck: number;
  /** Nose-up pitch (rad) at full water speed. */
  pitch: number;
  /** Idle-bob amplitude (m, period 1.6 s) — ≈ 3–4 cm scaled by size. */
  bob: number;
  /** Extra head lift (rad, + = the nose rises) so the face stays clear of the water. */
  headUp: number;
  /** Tail swish amplitude (rad). */
  tail: number;
  /** Splash size multiplier of attack impacts. */
  splash: number;
}

/** The ten tunings. See each rig's `poseSwim` for how they are used. */
export const SWIM_TUNE: Record<AnimalId, SwimTune> = {
  lion: { sink: 0.52, settle: 0.34, back: 1.34, head: 1.54, freqMin: 0.7, freqMax: 1.9, legAmp: 0.75, tread: 0.42, tuck: 0.12, pitch: 0.11, bob: 0.036, headUp: 0.2, tail: 0.35, splash: 1.0 },
  gorilla: { sink: 0.47, settle: 0.12, back: 1.42, head: 1.73, freqMin: 0.6, freqMax: 1.3, legAmp: 0.7, tread: 0.4, tuck: 0.1, pitch: 0.0, bob: 0.034, headUp: 0.12, tail: 0, splash: 1.1 },
  crocodile: { sink: 0.4, settle: 0.06, back: 0.6, head: 0.65, freqMin: 0.8, freqMax: 1.7, legAmp: 0.18, tread: 0.4, tuck: 1.25, pitch: 0.04, bob: 0.02, headUp: 0.05, tail: 0.5, splash: 1.1 },
  hippo: { sink: 0.5, settle: 0.26, back: 1.58, head: 1.48, freqMin: 0.5, freqMax: 1.2, legAmp: 0.5, tread: 0.4, tuck: 0.1, pitch: 0.05, bob: 0.05, headUp: 0.1, tail: 0.6, splash: 1.5 },
  rhino: { sink: 0.5, settle: 0.26, back: 1.53, head: 1.6, freqMin: 0.5, freqMax: 1.1, legAmp: 0.55, tread: 0.4, tuck: 0.1, pitch: 0.03, bob: 0.044, headUp: -0.1, tail: 0.3, splash: 1.3 },
  eagle: { sink: 0.4, settle: 0, back: 1.04, head: 1.29, freqMin: 0.8, freqMax: 2.0, legAmp: 0.7, tread: 0.5, tuck: 0.2, pitch: 0.18, bob: 0.03, headUp: 0.1, tail: 0.25, splash: 0.7 },
  panther: { sink: 0.5, settle: 0.38, back: 1.09, head: 1.34, freqMin: 0.8, freqMax: 2.1, legAmp: 0.8, tread: 0.42, tuck: 0.12, pitch: 0.1, bob: 0.034, headUp: 0.18, tail: 0.35, splash: 0.95 },
  python: { sink: 0.42, settle: 0.38, back: 0.76, head: 2.2, freqMin: 0.5, freqMax: 1.4, legAmp: 0, tread: 0.4, tuck: 0, pitch: 0.0, bob: 0.03, headUp: 0, tail: 0.6, splash: 0.9 },
  giraffe: { sink: 0.52, settle: 0.32, back: 2.12, head: 4.07, freqMin: 0.5, freqMax: 1.0, legAmp: 0.62, tread: 0.4, tuck: 0.15, pitch: 0.0, bob: 0.045, headUp: 0.1, tail: 0.4, splash: 1.3 },
  mole: { sink: 0.44, settle: 0.15, back: 0.65, head: 0.61, freqMin: 1.4, freqMax: 3.2, legAmp: 0.85, tread: 0.5, tuck: 0.1, pitch: 0.2, bob: 0.02, headUp: 0.3, tail: 0.5, splash: 0.55 },
};

/**
 * Time-warp of the basic-attack progress while wading: the windup is a little longer (water drag) and accelerates harder into
 * the strike, the follow-through is a little slower. The impact instant stays EXACTLY at u = 0.55 (and 0 / 1 are fixed, the
 * map is strictly increasing), so the visual strike still lands when the sim's hit does.
 */
export function attackWarp(u: number): number {
  if (!(u > 0) || u >= 1) return u < 0 || u !== u ? 0 : u;
  if (u < SWIM_IMPACT_U) return u - 0.07 * Math.sin((Math.PI * u) / SWIM_IMPACT_U);
  return u - 0.05 * Math.sin((Math.PI * (u - SWIM_IMPACT_U)) / (1 - SWIM_IMPACT_U));
}

/** Post-impact bump 0..1..0 over u ∈ [IMPACT, 1] (peaks ≈ 0.78): the recoil of the follow-through. */
export function followBump(u: number): number {
  if (u <= SWIM_IMPACT_U || u >= 1) return 0;
  return Math.sin((Math.PI * (u - SWIM_IMPACT_U)) / (1 - SWIM_IMPACT_U));
}

/** Splash radius (m) and strength (0..1) of the impact of basic attack `n` (1..3) for an animal of body radius `r`. */
export function swimSplash(n: 1 | 2 | 3, r: number, tuneScale: number): { radius: number; strength: number; forward: number } {
  const size = 0.7 + 0.5 * Math.min(1.6, r);
  const radius = (0.7 + 0.2 * (n - 1) + (n === 3 ? 0.3 : 0)) * size * tuneScale;
  const strength = Math.min(1, (0.34 + 0.12 * (n - 1) + (n === 3 ? 0.14 : 0)) * (0.75 + 0.35 * Math.min(1.6, r)));
  return { radius, strength, forward: r + 0.45 + (n === 3 ? 0.3 : 0) };
}

/** Idle-bob angular rate (rad/s): period 1.6 s. */
export const SWIM_BOB_W = (Math.PI * 2) / 1.6;
