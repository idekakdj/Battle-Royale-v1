/**
 * Lion — Royal Hunt, first-person directive (v1.3 Phase-3c).
 * Timeline: coil (windup/0) → pounce (active/1) → touchdown (2) → four maul strikes (3-6, claws land 0.09 s after
 * each beat) → roar (7) → settle (recovery/7). Whiff: recovery/2.
 */

import { type UltDirector, type UltView, type UltCtx, bump, sm } from '../ultCam';
import { eyeBack, lookAt } from './common';

const CHEST = 0.9;
// A pinned victim's rig root sits ~0.6 m up (the knockdown pose lies over it): aim at the root, not above it.
const PINNED = -0.05;
const ROAR_PITCH = 0.78; // ~45 degrees

function pin(c: UltCtx, v: UltView, h: number, w: number): void {
  // The lion lands ON the victim: the eye rises over the shoulders (clear of both bodies) and looks down at the pin.
  v.eyeY = 0.25;
  eyeBack(c, v, 0.9, 0.5);
  lookAt(c, v, c.victim, { h, w, yawRate: 7, mouse: 0.3, lo: -0.7, hi: 0.35 });
}

export const lionUlt: UltDirector = {
  view(c, v) {
    const s = c.stage;
    if (c.phase === 'windup') {
      // Coil: sink with the crouch, soft lock onto the victim.
      v.eyeY = -0.3 * sm(c.pt, 0, 0.35);
      v.follow = 0.5;
      lookAt(c, v, c.victim, { h: CHEST, w: 0.55, yawRate: 5, mouse: 0.6, lo: -0.5, hi: 0.3 });
      return;
    }
    if (c.phase === 'recovery') {
      if (s >= 7) {
        // Settle (0.45 s): the roar's tilt-up eases back to level.
        v.pitch = ROAR_PITCH * (1 - sm(c.pt, 0, 0.45));
        v.eyeY = 0;
        v.smooth = 10;
        v.follow = 0.5;
      } else {
        // Whiffed pounce: a stumble forward, then a wary look-around.
        v.pitch = -0.05 * bump(c.pt, 0, 0.12, 0.5);
        v.roll = 0.03 * Math.sin(c.pt * 5) * (1 - sm(c.pt, 0, 0.9));
        v.eyeY = -0.12 * (1 - sm(c.pt, 0, 0.7));
        v.follow = 0.4;
      }
      return;
    }
    // Active.
    if (s <= 1) {
      // Leap: nose up at take-off, then ride the arc looking at the landing point (the victim).
      v.eyeY = -0.3 * (1 - sm(c.st, 0, 0.2));
      v.pitch = 0.2 * (1 - sm(c.st, 0, 0.3));
      v.fovPct = 0.045 * sm(c.st, 0, 0.1);
      v.follow = 0.3;
      v.smooth = 12;
      lookAt(c, v, c.victim, { h: 0.8, w: 0.9 * sm(c.st, 0.1, 0.45), yawRate: 10, mouse: 0.2, lo: -0.9, hi: 0.3 });
    } else if (s === 2) {
      v.follow = 0.4;
      pin(c, v, PINNED, 0.85);
    } else if (s <= 6) {
      // Pinned maul: over the victim's pin; per-strike paw kicks 0.09 s after each beat.
      v.follow = 0.4;
      pin(c, v, PINNED, 0.85);
      if (c.once('k' + s, c.st >= 0.09)) {
        if (s === 3) c.fx.kick(-0.05, 0.04);
        else if (s === 4) c.fx.kick(-0.05, -0.04);
        else if (s === 5) c.fx.kick(-0.13);
        else {
          c.fx.kick(-0.11);
          c.fx.shake(0.14);
        }
      }
    } else {
      // Roar: rear up and tilt the view ~45 degrees, shake while it rolls out.
      v.pitch = ROAR_PITCH * sm(c.st, 0, 0.3);
      v.eyeY = 0;
      v.smooth = 10;
      v.follow = 0.5;
      v.fovPct = 0.03 * sm(c.st, 0, 0.3);
      v.shake = 0.006 * (1 - sm(c.st, 0.5, 0.8));
      lookAt(c, v, c.victim, { w: 0, yawRate: 4, mouse: 0.5 });
    }
  },
  stage(c, s) {
    if (c.phase === 'windup') return;
    if (s === 1) {
      c.fx.fov(0.07);
      c.fx.shake(0.08);
    } else if (s === 2) {
      c.fx.kick(-0.1);
      c.fx.shake(0.22);
    } else if (s === 7) {
      c.fx.kick(0.04);
      c.fx.shake(0.14);
    }
  },
};
