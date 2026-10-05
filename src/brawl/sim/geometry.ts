/**
 * Pure geometry helpers for the Champions League simulation: moving platforms as a pure function of
 * the frame, plus the overlap tests used by hit detection.
 */

import type { PathSpec, PlatformDef } from '../types';
import { PHYS } from '../config';
import { dcos, dsin } from './dmath';

/** One platform's state at one frame (mutable scratch object; the world keeps two arrays of these). */
export interface PlatRT {
  id: string;
  solid: boolean;
  x0: number;
  x1: number;
  /** Top-surface Y. */
  y: number;
  thickness: number;
  ledgeLeft: boolean;
  ledgeRight: boolean;
  /** Displacement since the previous frame (m) — riders are carried by this, never launched by it. */
  dx: number;
  dy: number;
  /** v1.6: exists / collides (false for a destroyed breakable and for a `finalOnly` platform before the final form). */
  active: boolean;
  /** v1.6: hits remaining / total for a breakable platform (`maxHp` 0 = not breakable). */
  hp: number;
  maxHp: number;
}

export function makePlatRT(def: PlatformDef): PlatRT {
  return {
    id: def.id,
    solid: def.kind === 'solid',
    x0: def.x0,
    x1: def.x1,
    y: def.y,
    thickness: def.thickness,
    ledgeLeft: !!def.ledgeLeft,
    ledgeRight: !!def.ledgeRight,
    dx: 0,
    dy: 0,
    active: def.finalOnly !== true,
    hp: def.breakable ? def.breakable.hits : 0,
    maxHp: def.breakable ? def.breakable.hits : 0,
  };
}

/** Offset of a moving platform at `frame`: amplitude × sin(2π (t/period + phase)). Pure function of the frame. */
export function movingOffsetAt(def: PlatformDef, frame: number): number {
  const m = def.moving;
  if (!m) return 0;
  const period = m.periodS > 0 ? m.periodS : 1;
  return m.amplitude * dsin(2 * Math.PI * (frame / 60 / period + m.phase));
}

/**
 * v1.6: cycle position ∈ [0, 1) of a looping `PathSpec` at `frame`: `((frame / 60) / periodS + phase) mod 1`
 * (floor-based modulo so negative phases and long matches stay exact).
 */
export function pathCycle(path: PathSpec, frame: number): number {
  const period = path.periodS > 0 ? path.periodS : 1;
  const u = frame / 60 / period + path.phase;
  return u - Math.floor(u);
}

/**
 * v1.6: the offset a `PathSpec` adds to its platform's defined position at `frame`: linear key interpolation of the cycle position with
 * COSINE easing per segment (`e = (1 − cos πu) / 2`, so every key is a rest point), looping from the last key back to the first. Pure function
 * of the frame, built only from + − × ÷ / floor and `dcos` (bit-identical on every machine). Shared by the sim, the view and the bots
 * (`data/stages.ts` `platformAt`). `keys[0].t` is expected to be 0 and `t` strictly increasing in [0, 1).
 */
export function pathOffsetAt(path: PathSpec, frame: number, out: { x: number; y: number }): void {
  const keys = path.keys;
  const n = keys.length;
  if (n === 0) {
    out.x = 0;
    out.y = 0;
    return;
  }
  if (n === 1) {
    out.x = keys[0].x;
    out.y = keys[0].y;
    return;
  }
  let c = pathCycle(path, frame);
  if (c < keys[0].t) c += 1;
  let i = n - 1;
  for (let k = 1; k < n; k++) {
    if (c < keys[k].t) {
      i = k - 1;
      break;
    }
  }
  const a = keys[i];
  const b = i + 1 < n ? keys[i + 1] : keys[0];
  const t1 = i + 1 < n ? b.t : keys[0].t + 1;
  const span = t1 - a.t;
  const u = span > 0 ? (c - a.t) / span : 0;
  const e = 0.5 - 0.5 * dcos(Math.PI * u);
  out.x = a.x + (b.x - a.x) * e;
  out.y = a.y + (b.y - a.y) * e;
}

const PATH_SCRATCH = { x: 0, y: 0 };

/**
 * Write the platform's geometry at `frame` into `out` (position only; `dx/dy` are filled by the caller). A `moving` offset and a `path`
 * offset add up (v1.6).
 */
export function platformAtFrame(def: PlatformDef, frame: number, out: PlatRT): void {
  let ox = 0;
  let oy = 0;
  if (def.moving) {
    const off = movingOffsetAt(def, frame);
    if (def.moving.axis === 'y') oy = off;
    else ox = off;
  }
  if (def.path) {
    pathOffsetAt(def.path, frame, PATH_SCRATCH);
    ox += PATH_SCRATCH.x;
    oy += PATH_SCRATCH.y;
  }
  out.x0 = def.x0 + ox;
  out.x1 = def.x1 + ox;
  out.y = def.y + oy;
}

/** Circle (cx, cy, r) vs axis-aligned rect [rx0, rx1] × [ry0, ry1]. */
export function circleRect(cx: number, cy: number, r: number, rx0: number, ry0: number, rx1: number, ry1: number): boolean {
  const nx = cx < rx0 ? rx0 : cx > rx1 ? rx1 : cx;
  const ny = cy < ry0 ? ry0 : cy > ry1 ? ry1 : cy;
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy <= r * r;
}

/** Centred rect (cx, cy, w, h) vs axis-aligned rect [rx0, rx1] × [ry0, ry1]. */
export function rectRect(cx: number, cy: number, w: number, h: number, rx0: number, ry0: number, rx1: number, ry1: number): boolean {
  const hw = w * 0.5;
  const hh = h * 0.5;
  return cx + hw >= rx0 && cx - hw <= rx1 && cy + hh >= ry0 && cy - hh <= ry1;
}

/** Foot half-width used for ground support. */
export function footHalf(width: number): number {
  const hw = width * 0.5;
  return hw < PHYS.footHalfMax ? hw : PHYS.footHalfMax;
}

/** True if a body of `width` centred on `x` is supported by a platform spanning [x0, x1]. */
export function supportedBy(x: number, width: number, x0: number, x1: number): boolean {
  const fw = footHalf(width);
  const tol = fw * PHYS.supportTolFrac;
  return x + tol > x0 && x - tol < x1;
}

export function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
