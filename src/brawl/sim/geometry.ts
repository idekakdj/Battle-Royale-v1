/**
 * Pure geometry helpers for the Champions League simulation: moving platforms as a pure function of
 * the frame, plus the overlap tests used by hit detection.
 */

import type { PlatformDef } from '../types';
import { PHYS } from '../config';

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
  };
}

/** Offset of a moving platform at `frame`: amplitude × sin(2π (t/period + phase)). Pure function of the frame. */
export function movingOffsetAt(def: PlatformDef, frame: number): number {
  const m = def.moving;
  if (!m) return 0;
  const period = m.periodS > 0 ? m.periodS : 1;
  return m.amplitude * Math.sin(2 * Math.PI * (frame / 60 / period + m.phase));
}

/** Write the platform's geometry at `frame` into `out` (position only; `dx/dy` are filled by the caller). */
export function platformAtFrame(def: PlatformDef, frame: number, out: PlatRT): void {
  const off = movingOffsetAt(def, frame);
  if (def.moving && def.moving.axis === 'y') {
    out.x0 = def.x0;
    out.x1 = def.x1;
    out.y = def.y + off;
  } else {
    out.x0 = def.x0 + off;
    out.x1 = def.x1 + off;
    out.y = def.y;
  }
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
