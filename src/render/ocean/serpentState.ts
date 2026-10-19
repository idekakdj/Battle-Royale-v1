/**
 * Sea-serpent VISUAL STATE (WP-O3): a pure function of the snapshot's `serpent` block (and the arena), so the set piece can never
 * desync from the sim: rollback, a late join or an interpolated online snapshot all give the same picture for the same
 * (phase, t, angle). Events only trigger one-shot FX (shards, splash, hit flashes); everything persistent comes from here.
 *
 * Timeline (config/serpent.ts): WARN 1.1 s -> STRIKE 0.44 s -> HOLD 0.35 s -> RETREAT 0.8 s. The head's DRAWN radius is the sim's
 * head radius mapped so the drawn head is never behind the hitbox: `rv = headR * (1 + GLASS_LEAD / wall)`, i.e. at the wall (30 m) the
 * drawn head sits 3.9 m out - against the glass, which is at 32 m - and at the centre it is exactly 0.
 *
 * v1.10: the same pure mapping serves the HIGH serpent (`tier: 'high'`, driven only by `snapshot.serpentHigh`): its head sweeps FLAT at the
 * upper-tier height (`highLaneY`: the tallest ground + 2 m, i.e. skimming the tower tops), it rests against the glass where the glass
 * is at THAT height (`glassLead`), and everything else (phases, glass cracks, shockwave) follows the identical timeline.
 *
 * No three / DOM imports: node-safe.
 */

import type { SerpentPhase, SerpentState, SerpentTier } from '../../core/types';
import { SERPENT } from '../../config/serpent';
import { arenaGroundHeight, type ArenaDef, type ElevationPiece } from '../../config/arenas';
import { DOME_MARGIN, glassRadiusAt } from './domeShape';

/** How far (m) the drawn head leads the sim head at the wall: the head rests against the OUTSIDE of the glass. */
export const GLASS_LEAD = 3.9;
/** Head radius (m): the head is ~3.5 m wide (the strip half-width is 1.8). */
export const HEAD_RADIUS = 1.75;
/** The serpent's body length (m). */
export const BODY_LENGTH = 74;
/** Seconds the serpent keeps withdrawing after the sim ends the event (it swims off outside the glass). */
export const EXIT_S = 1.5;

export type VisualPhase = SerpentPhase | 'exit' | 'none';

const TOP_CACHE = new WeakMap<ArenaDef, number>();

/** Height (m) of the tallest ground of the arena's height field (the tower tops on the Ocean Dome; 0 without one). */
export function arenaTopHeight(arena: ArenaDef): number {
  const hit = TOP_CACHE.get(arena);
  if (hit !== undefined) return hit;
  let top = 0;
  for (const p of arena.heightfield ?? ([] as readonly ElevationPiece[])) {
    const h = p.kind === 'ramp' ? Math.max(p.h0, p.h1) : p.height;
    if (h > top) top = h;
  }
  TOP_CACHE.set(arena, top);
  return top;
}

/** The HIGH serpent's flight height (head centre): the tallest ground + 2 m (so the head skims the tower tops, over the plateau too). */
export function highLaneY(arena: ArenaDef): number {
  return arenaTopHeight(arena) + 2;
}

/** How far (m) the drawn head leads the sim head at the wall for `tier`: the head rests against the OUTSIDE of the glass at its own height. */
export function glassLead(arena: ArenaDef, tier: SerpentTier = 'low'): number {
  if (tier === 'low') return GLASS_LEAD;
  const rest = glassRadiusAt(arena.wallRadius, highLaneY(arena)) + HEAD_RADIUS + 0.3;
  return Math.max(0.8, rest - arena.wallRadius);
}

export interface SerpentVisual {
  /** Which serpent this picture is for. */
  tier: SerpentTier;
  active: boolean;
  phase: VisualPhase;
  angleDeg: number;
  /** Strike direction from the centre toward the edge point (unit, x/z). */
  dirX: number;
  dirZ: number;
  /** Seconds into the phase (smoothed by the render alpha), clamped to the phase length. */
  t: number;
  /** DRAWN head distance from the centre (m). */
  rv: number;
  /** Head height (m). */
  headY: number;
  /** Head pitch (rad, + = up) and jaw opening 0..1. */
  pitch: number;
  jaw: number;
  /** Coil factor 1 (coiled outside the dome) -> 0 (stretched straight along the strike line). */
  coil: number;
  /** 0..1 how far into the warning (strip pulse urgency); 0 outside the warning. */
  urgency: number;
  /** Strip visibility 0..1 and the sweep front (the drawn strip beyond `sweepR` has already been passed by the head). */
  stripAlpha: number;
  sweepR: number;
  /** Glass state: crack extent, hole size (both heal during the retreat), shudder, flash (all 0..1). */
  crack: number;
  hole: number;
  shudder: number;
  flash: number;
  /** Shockwave progress 0..1 (hold + the start of the retreat), -1 when not running. */
  shock: number;
  /** Body visibility 0..1 (fades while the serpent leaves). */
  alpha: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v: number): number => {
  const x = clamp01(v);
  return x * x * (3 - 2 * x);
};

export function phaseLength(phase: SerpentPhase): number {
  switch (phase) {
    case 'warn':
      return SERPENT.warnS;
    case 'strike':
      return SERPENT.strikeS;
    case 'hold':
      return SERPENT.holdS;
    default:
      return SERPENT.retreatS;
  }
}

/** The sim's head radius for (phase, t) - the formula the snapshot's `headR` follows (we derive it so interpolated blocks stay consistent). */
export function simHeadR(phase: SerpentPhase, t: number, wallRadius: number): number {
  switch (phase) {
    case 'warn':
      return wallRadius;
    case 'strike':
      return wallRadius * (1 - clamp01(t / SERPENT.strikeS));
    case 'hold':
      return 0;
    default:
      return wallRadius * clamp01(t / SERPENT.retreatS);
  }
}

/** Ground height under the head's path, blurred along the line over a window so the head climbs a cliff smoothly. */
export function pathGround(arena: ArenaDef, dirX: number, dirZ: number, r: number, from: number, to: number): number {
  const n = 9;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const rr = Math.max(0, r + from + ((to - from) * i) / (n - 1));
    const x = dirX * rr;
    const z = dirZ * rr;
    // the capsule is ~3.5 m wide: take the highest of the axis and the two edges
    const g = Math.max(arenaGroundHeight(arena, x, z), arenaGroundHeight(arena, x - dirZ * 1.2, z + dirX * 1.2), arenaGroundHeight(arena, x + dirZ * 1.2, z - dirX * 1.2));
    sum += g;
  }
  return sum / n;
}

/**
 * Map the snapshot's serpent block to the visual state. `s` null/undefined -> inactive. `alpha` (0..1, default 1) is the render
 * interpolation between the last two 60 Hz sim ticks: the drawn time lags the snapshot by (1 - alpha) ticks, exactly like the
 * fighters' interpolated positions. `exitT` >= 0 drives the post-event withdrawal (`s` should then be the last block's data).
 */
export function serpentVisualState(
  arena: ArenaDef,
  s: Pick<SerpentState, 'phase' | 'angleDeg' | 't'> | null | undefined,
  alpha = 1,
  out: SerpentVisual = blank(),
  exitT = -1,
  tier: SerpentTier = 'low',
): SerpentVisual {
  const wall = arena.wallRadius;
  out.tier = tier;
  if (s === null || s === undefined) {
    if (exitT >= 0 && exitT < EXIT_S && out.angleDeg >= 0) return exitState(arena, out, exitT);
    return reset(out);
  }
  const high = tier === 'high';
  const laneY = highLaneY(arena);
  const len = phaseLength(s.phase);
  const t = Math.min(len, Math.max(0, s.t - (1 - alpha) / 60));
  const ang = (s.angleDeg * Math.PI) / 180;
  out.active = true;
  out.phase = s.phase;
  out.angleDeg = s.angleDeg;
  out.dirX = Math.cos(ang);
  out.dirZ = Math.sin(ang);
  out.t = t;
  out.alpha = 1;
  const simR = simHeadR(s.phase, t, wall);
  const lead = glassLead(arena, tier) / wall;
  const wind = s.phase === 'warn' ? Math.sin(Math.PI * clamp01((t - 0.35) / Math.max(0.01, SERPENT.warnS - 0.35))) : 0;
  out.rv = simR * (1 + lead) + wind * 3.4;
  out.urgency = s.phase === 'warn' ? clamp01(t / SERPENT.warnS) : 0;
  out.coil = s.phase === 'warn' ? 1 : s.phase === 'strike' ? 1 - smooth(t / 0.3) : 0;
  out.pitch = -0.1;
  out.jaw = 0.12;
  out.shock = -1;
  out.flash = 0;
  out.sweepR = wall + 2;
  let rear = 0;
  switch (s.phase) {
    case 'warn': {
      out.stripAlpha = 1;
      out.crack = 0;
      out.hole = 0;
      out.shudder = 0.25 + 0.75 * out.urgency;
      out.jaw = 0.15 + 0.35 * smooth((t - 0.6) / 0.5) + 0.05 * Math.sin(t * 22);
      out.pitch = -0.12 + 0.25 * wind;
      break;
    }
    case 'strike': {
      const k = clamp01(t / SERPENT.strikeS);
      out.stripAlpha = 1 - 0.3 * k;
      out.sweepR = simR;
      out.crack = smooth(t / 0.05);
      out.hole = smooth(t / 0.06);
      out.shudder = 1;
      out.flash = (1 - smooth(t / 0.18)) * 0.9;
      out.jaw = 0.4 + 0.6 * smooth(t / 0.12);
      out.pitch = -0.06;
      break;
    }
    case 'hold': {
      out.stripAlpha = 0.7 * (1 - smooth(t / SERPENT.holdS));
      out.sweepR = 0;
      out.crack = 1;
      out.hole = 1;
      out.shudder = 0.8 * (1 - t / SERPENT.holdS);
      out.jaw = 1;
      rear = smooth(t / 0.12);
      out.pitch = 0.62 * rear;
      out.shock = clamp01(t / (SERPENT.holdS + 0.15));
      out.flash = (1 - smooth(t / 0.12)) * 0.5;
      break;
    }
    default: {
      const k = clamp01(t / SERPENT.retreatS);
      out.stripAlpha = 0;
      // the glass re-forms: the hole closes first, then the cracks fade
      out.hole = 1 - smooth(k / 0.7);
      out.crack = 1 - smooth((k - 0.25) / 0.75);
      out.shudder = 0.5 * (1 - k);
      out.jaw = 1 - smooth(k / 0.5);
      rear = 1 - smooth(k / 0.3);
      out.pitch = 0.62 * rear;
      out.shock = t < 0.15 ? clamp01((SERPENT.holdS + t) / (SERPENT.holdS + 0.15)) : -1;
      out.flash = k > 0.75 ? Math.sin(Math.PI * ((k - 0.75) / 0.25)) * 0.35 : 0; // the seam closes with a flash
      break;
    }
  }
  // Head height: skims the ground (a 3.5 m head: bottom ~ground), over the terrain profile ahead of it; rears up at the hold.
  if (high) {
    // The HIGH serpent flies level at the tower-top height (no ground-hugging), bobbing a little while it coils, rearing at the hold.
    out.headY = laneY + (s.phase === 'warn' ? 0.35 * Math.sin(t * 6.5) : 1.6 * rear);
    return out;
  }
  const inward = s.phase === 'strike' || s.phase === 'warn';
  const rg = Math.min(out.rv, wall + 1);
  const g = pathGround(arena, out.dirX, out.dirZ, rg, inward ? -4 : -1, inward ? 1 : 4);
  const warnY = 3.2 + 0.35 * Math.sin(t * 6.5);
  out.headY = s.phase === 'warn' ? warnY : g + HEAD_RADIUS + 0.12 + 2.4 * rear;
  return out;
}

function exitState(arena: ArenaDef, out: SerpentVisual, exitT: number): SerpentVisual {
  const wall = arena.wallRadius;
  const k = exitT / EXIT_S;
  const high = out.tier === 'high';
  out.active = true;
  out.phase = 'exit';
  out.t = exitT;
  out.rv = wall * (1 + glassLead(arena, out.tier) / wall) + exitT * exitT * 26 + exitT * 8;
  out.headY = high ? highLaneY(arena) + 2.5 * smooth(k) : 3.2 + 3.5 * smooth(k);
  out.pitch = 0.1;
  out.jaw = 0.1;
  out.coil = 0;
  out.urgency = 0;
  out.stripAlpha = 0;
  out.sweepR = 0;
  out.crack = 0;
  out.hole = 0;
  out.shudder = 0;
  out.flash = 0;
  out.shock = -1;
  out.alpha = 1 - smooth((k - 0.3) / 0.7);
  return out;
}

export function blank(tier: SerpentTier = 'low'): SerpentVisual {
  return {
    tier,
    active: false,
    phase: 'none',
    angleDeg: -1,
    dirX: 1,
    dirZ: 0,
    t: 0,
    rv: 0,
    headY: 0,
    pitch: 0,
    jaw: 0,
    coil: 0,
    urgency: 0,
    stripAlpha: 0,
    sweepR: 0,
    crack: 0,
    hole: 0,
    shudder: 0,
    flash: 0,
    shock: -1,
    alpha: 0,
  };
}

function reset(out: SerpentVisual): SerpentVisual {
  out.active = false;
  out.phase = 'none';
  out.stripAlpha = 0;
  out.crack = 0;
  out.hole = 0;
  out.shudder = 0;
  out.flash = 0;
  out.shock = -1;
  out.urgency = 0;
  out.alpha = 0;
  return out;
}

/** Radius (m) of the dome's glass at ground level - where the LOW head bursts through. */
export function glassRadius(arena: ArenaDef): number {
  return arena.wallRadius + DOME_MARGIN;
}

/** Radius (m) of the dome's glass at the height the serpent of `tier` breaks through it. */
export function breachRadius(arena: ArenaDef, tier: SerpentTier = 'low'): number {
  return tier === 'high' ? glassRadiusAt(arena.wallRadius, highLaneY(arena)) : glassRadius(arena);
}

/** Height (m) at which the serpent of `tier` breaks through the glass (low: just above the ground; high: its flight height). */
export function breachHeight(arena: ArenaDef, tier: SerpentTier = 'low'): number {
  return tier === 'high' ? highLaneY(arena) : 2.3;
}
