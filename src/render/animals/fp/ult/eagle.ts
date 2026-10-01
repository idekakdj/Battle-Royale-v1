/**
 * Eagle — Death From Above, first-person directive (v1.3 Phase-3c).
 * Ascent (windup 0.8 s corkscrew) → hold (active/0, the reticle tracks the victim) → commit (stage 1, 0.5 s) →
 * stoop (stage 1 with vel.y < -5) → impact (stage 2) → recovery. The camera never banks with the body: a view-only
 * roll sways into the helix, the hold looks DOWN at the reticle, the stoop looks straight down the dive line
 * with a FOV kick and wind rush, and the impact snaps back to level with a short shake.
 */

import { type UltDirector, clampPitch, pitchTo, sm, yawToPoint } from '../ultCam';

export const eagleUlt: UltDirector = {
  view(c, v) {
    v.follow = 0.5;
    if (c.phase === 'windup') {
      // Corkscrew climb: look up along the helix, sway into the bank (view-only roll).
      v.pitch = 0.35 * sm(c.pt, 0, 0.5);
      v.roll = 0.07 * sm(c.pt, 0.1, 0.6);
      v.smooth = 9;
      return;
    }
    // Reticle / committed point / victim, in that order of authority.
    const tg = c.stage >= 1 ? (c.stagePos ?? c.victim) : (c.stagePos ?? c.victim ?? c.aim);
    if (c.stage >= 2) {
      // Impact: snap back to level (the director's followers do the ease), short shake, whiff look-around.
      v.pitch = -0.08 * (1 - sm(c.st, 0, 0.45)) + 0.035 * Math.sin(c.st * 4.5) * sm(c.st, 0.4, 0.8);
      v.smooth = 14;
      return;
    }
    if (tg === null) {
      v.pitch = -0.4 * sm(c.pt, 0, 0.5);
      return;
    }
    const stoop = c.stage >= 1 && c.vy < -5;
    const dive = sm(-c.vy, 5, 25);
    let lo = -0.96;
    let hi = -0.62;
    let w = 0.9 * sm(c.pt, 0, 0.5);
    let yawRate = 3.5;
    let mouse = 0.4;
    if (c.stage >= 1) {
      // Commit: settle on the fixed circle.
      lo = -1.15;
      hi = -0.7;
      w = 1;
      yawRate = 7;
      mouse = 0.25;
    }
    if (stoop) {
      // Stoop: straight down the dive line, FOV +10 %, wind rush.
      lo = -1.4;
      hi = -0.9;
      yawRate = 9;
      mouse = 0.1;
      v.fovPct = 0.1 * dive;
      v.shake = 0.012 * sm(-c.vy, 8, 25);
      v.follow = 0.2;
    } else {
      v.roll = 0.04 * (1 - sm(c.pt, 0.2, 1.2)) * (c.stage >= 1 ? 0 : 1);
    }
    v.lookW = w;
    v.lookPitch = clampPitch(pitchTo(c.eye, tg.x, tg.y, tg.z), lo, hi);
    if (Math.hypot(tg.x - c.eye.x, tg.z - c.eye.z) > 0.8) {
      v.yawTo = yawToPoint(c.eye, tg.x, tg.z);
      v.yawRate = yawRate;
    }
    v.mouseYaw = mouse;
    v.smooth = stoop ? 20 : 8;
  },
  stage(c, s) {
    if (s === 2) {
      c.fx.shake(0.5);
      c.fx.kick(-0.1);
    } else if (s === 1) {
      c.fx.kick(-0.03);
    }
  },
};
