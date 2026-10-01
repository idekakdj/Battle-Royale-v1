/**
 * First-person fore-paw viewmodel for the lion / panther ULTIMATES (v1.3 Phase-3c). The shared `pawPose` leaves the paws
 * on the body for `action === 'ultimate'`; the maul sequences instead alternate the paws in view per strike, keyed
 * off the snapshot's `ultPhase` / `ultStage` and the stage clock `ultClock.st` (seconds since the beat) — NOT the
 * phase-local `u`, which restarts per phase and does not know about individual strikes.
 */

import type { FpPoseCtx } from './types';
import { type Tip, mirrorTip, mixTip, pin } from './common';
import { bump, sm, ultClock } from './ultCam';

export interface UltPawSet {
  len: number;
  /** Joint names of the screen-right and screen-left fore paws. */
  right: string;
  left: string;
  /** Tips of the RIGHT paw; the left mirrors them. */
  rest: Tip;
  wind: Tip;
  hit: Tip;
  lunge: Tip;
  raised: Tip;
  slam: Tip;
}

/** rest → wind → hit → rest, with the contact at ~0.1 s after the beat (claws land 0.08-0.09 s after it). */
export function strikeTip(o: UltPawSet, st: number, wind: Tip = o.wind, hit: Tip = o.hit): Tip {
  const a = sm(st, 0, 0.08);
  const b = sm(st, 0.07, 0.115);
  const r = sm(st, 0.15, 0.32);
  return mixTip(mixTip(mixTip(o.rest, wind, a), hit, b), o.rest, r);
}

/** rest → raised (overhead) → slam → rest. */
export function slamTip(o: UltPawSet, st: number): Tip {
  const up = sm(st, 0, 0.09);
  const down = sm(st, 0.09, 0.14);
  const r = sm(st, 0.2, 0.4);
  return mixTip(mixTip(mixTip(o.rest, o.raised, up), o.slam, down), o.rest, r);
}

/** rest → lunge → rest pulse (bite / touchdown). */
export function lungeTip(o: UltPawSet, st: number, up = 0.0, peak = 0.09, down = 0.32): Tip {
  return mixTip(o.rest, o.lunge, bump(st, up, peak, down));
}

/** Pin both paws; the left mirrors `l` (pass the mirrored-or-not tips explicitly). */
export function pinPaws(c: FpPoseCtx, o: UltPawSet, r: Tip, l: Tip): void {
  pin(c, o.right, o.len, r);
  pin(c, o.left, o.len, l);
}

export function ultStageClock(): number {
  return ultClock.casting ? ultClock.st : 0;
}

/** Lion: coil / leap tuck / touchdown / R-L claw rakes / bite / double slam / roar. */
export function lionUltPaws(c: FpPoseCtx, o: UltPawSet): void {
  const s = c.state.ultStage ?? 0;
  const ph = c.state.ultPhase ?? 'active';
  const st = ultStageClock();
  const rest = o.rest;
  let r: Tip = rest;
  let l: Tip = mirrorTip(rest);
  if (ph === 'windup') {
    // Coil: forepaws tucked low.
    r = { ...rest, y: rest.y - 0.06, down: rest.down + 0.15 };
    l = mirrorTip(r);
  } else if (ph === 'recovery' && s !== 7) {
    // Whiffed pounce: paws trail.
    r = { ...rest, z: rest.z - 0.1 };
    l = mirrorTip(r);
  } else if (s <= 1) {
    // Leap: tuck the paws into the lower corners.
    r = { ...rest, y: rest.y - 0.1, down: rest.down + 0.3 };
    l = mirrorTip(r);
  } else if (s === 2) {
    r = lungeTip(o, st, 0, 0.06, 0.4);
    l = mirrorTip(r);
  } else if (s === 3) {
    r = strikeTip(o, st);
  } else if (s === 4) {
    l = mirrorTip(strikeTip(o, st));
  } else if (s === 5) {
    r = lungeTip(o, st, 0, 0.1, 0.34);
    l = mirrorTip(r);
  } else if (s === 6) {
    r = slamTip(o, st);
    l = mirrorTip(r);
  } else {
    // Roar: the forepaws lift as the lion rears.
    const k = ph === 'recovery' ? 1 - sm(ultClock.pt, 0, 0.45) : sm(st, 0, 0.3);
    r = mixTip(rest, { ...rest, y: rest.y + 0.3, z: rest.z - 0.15, out: 0.35 }, k);
    l = mirrorTip(r);
  }
  pinPaws(c, o, r, l);
}

/** Panther: rake R / overhead chop L / low sweep / lunge-bite / spin double-rake / finisher slam. */
export function pantherUltPaws(c: FpPoseCtx, o: UltPawSet): void {
  const s = c.state.ultStage ?? 0;
  const ph = c.state.ultPhase ?? 'active';
  const st = ultStageClock();
  const rest = o.rest;
  let r: Tip = rest;
  let l: Tip = mirrorTip(rest);
  if (ph === 'windup' || ph === 'recovery') {
    r = { ...rest, y: rest.y - 0.05, down: rest.down + 0.1 };
    l = mirrorTip(r);
  } else if (s === 1) {
    r = strikeTip(o, st);
  } else if (s === 2) {
    l = mirrorTip(slamTip(o, st)); // overhead chop from above
  } else if (s === 3) {
    // Low sweep: the paw skims the ground across the bottom of the view.
    const wind: Tip = { x: 0.95, y: rest.y - 0.25, z: 0.8, down: 0.25, out: 0.7, roll: 0.2 };
    const hit: Tip = { x: -0.55, y: rest.y - 0.2, z: 1.25, down: 0.15, out: -0.7 };
    r = strikeTip(o, st, wind, hit);
  } else if (s === 4) {
    r = lungeTip(o, st, 0, 0.09, 0.32);
    l = mirrorTip(r);
  } else if (s === 5) {
    r = strikeTip(o, st);
    l = mirrorTip(strikeTip(o, Math.max(0, st - 0.04)));
  } else {
    r = slamTip(o, st);
    l = mirrorTip(r);
  }
  pinPaws(c, o, r, l);
}
