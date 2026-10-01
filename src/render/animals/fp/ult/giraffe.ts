/**
 * Giraffe — Timber Fall, first-person directive (v1.3 Phase-3c).
 * Windup 1.1 s: whip-back / track (stage 0, 0-0.6) then commit (stage 1, 0.6-1.1). Active: the 0.14 s neck
 * downswing (still stage 1), then the impact (stage 2) and the recovery. The head and neck are hidden in first
 * person: the view pitches up with the whip-back, settles on the circle, slams ~35 degrees down over 0.14 s,
 * bounces and slowly returns to level.
 */

import { type UltDirector, lerp, sm } from '../ultCam';
import { lookAt, followSimYaw } from './common';

const SLAM_DUR = 0.14;

export const giraffeUlt: UltDirector = {
  view(c, v) {
    v.follow = 0.7;
    const target = c.stagePos ?? c.victim;
    if (c.stage >= 2) {
      // Impact + recovery: the bounce settles and the view returns slowly to level.
      const k = 1 - sm(c.st, 0.1, 0.85);
      v.pitch = -0.3 * (1 - sm(c.st, 0, 0.85));
      v.smooth = 5;
      lookAt(c, v, target, { w: 0.7 * k, lo: -1.0, hi: -0.3 });
      v.eyeY = -0.1 * (1 - sm(c.st, 0, 0.6));
      return;
    }
    if (c.phase === 'active') {
      // The slam: a fast pitch-down ending on the crater.
      const s = Math.min(1, c.pt / SLAM_DUR);
      const e = s * s;
      v.pitch = lerp(0.35, -0.5, e);
      v.smooth = 38;
      v.fovPct = 0.06 * e;
      v.eyeY = -0.12 * e;
      lookAt(c, v, target, { w: lerp(0.5, 1, e), lo: -1.0, hi: -0.5 });
      return;
    }
    // Windup: whip the neck back (pitch up), tremble through the tension hold, settle on the circle at the commit.
    v.pitch = 0.3 * sm(c.pt, 0, 0.55) + 0.06 * sm(c.pt, 0.6, 1.06);
    v.roll = 0.009 * (Math.sin(c.pt * 43) + 0.7 * Math.sin(c.pt * 37)) * sm(c.pt, 0.6, 1.0);
    v.smooth = 10;
    if (c.stage >= 1) lookAt(c, v, target, { w: 0.5 * sm(c.pt, 0.6, 1.0), lo: -1.0, hi: -0.3 });
    // The sim turns the body toward the circle at 6 rad/s while it creeps in.
    followSimYaw(c, v, 3, 0.6);
  },
  stage(c, s) {
    if (s === 2) {
      c.fx.shake(0.5);
      c.fx.kick(0.1);
      c.fx.fov(0.05);
    }
  },
};
