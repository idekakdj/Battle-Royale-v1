/**
 * Gorilla — Boulder Hurl, first-person directive (v1.3 Phase-3c).
 * Windup 1.0 s: chest beats at 0.13 / 0.31, squat + rip at 0.44-0.66 (tear at 0.60), hoist to 0.86, cock-back to
 * 0.93, throw to 1.0. Active (stage 1) = released; the recovery follows through.
 */

import { type UltDirector, lerp, ramp, sm } from '../ultCam';
import { lookAt } from './common';

export const gorillaUlt: UltDirector = {
  view(c, v) {
    v.follow = 0.6;
    if (c.phase === 'windup') {
      const t = c.pt;
      // Tiny pitch-down thumps on the two chest beats.
      if (c.once('b1', t >= 0.13)) c.fx.kick(-0.026);
      if (c.once('b2', t >= 0.31)) c.fx.kick(-0.034);
      // Rip: pitch down ~25 degrees into the squat (eye drops ~0.35 m); the slab tears loose at 0.60.
      const squat = sm(t, 0.44, 0.62) * (1 - sm(t, 0.66, 0.86));
      const up = 0.12 * sm(t, 0.66, 0.86) + 0.05 * sm(t, 0.86, 0.93);
      v.pitch = (-0.43 * squat + up) * (1 - sm(t, 0.93, 1.0)) - 0.04 * sm(t, 0.93, 1.0);
      v.eyeY = -0.35 * squat;
      v.smooth = 14;
      v.shake = 0.018 * ramp(t, 0.6, 0.62) * (1 - ramp(t, 0.64, 0.7));
      // The sim turns the body toward the locked foe: stay with it softly.
      if (c.state.ultTargetId !== undefined && c.state.ultTargetId >= 0) {
        lookAt(c, v, c.victim, { w: 0, yawRate: 2.5, mouse: 0.75 });
      }
      return;
    }
    // Released (the sim has no separate active phase: the boulder leaves at the end of the windup and the recovery
    // follows): a forward kick, then the view follows the boulder's arc for ~0.3 s while the torso folds over the
    // throw and settles with heavy breaths.
    const t = c.st;
    const k = 1 - sm(t, 0.15, 0.45);
    v.fovPct = 0.03 * (1 - sm(t, 0, 0.4));
    v.pitch = -0.06 * (1 - sm(t, 0, 0.5)) + 0.015 * Math.sin(t * 6) * (1 - sm(t, 0, 0.6));
    v.eyeY = lerp(-0.08, 0, sm(t, 0, 0.5));
    v.smooth = 9;
    if (c.stagePos !== null && c.stage >= 1) lookAt(c, v, c.stagePos, { w: 0.4 * k, lo: -0.25, hi: 0.3 });
  },
  stage(c, s) {
    if (s === 1) {
      c.fx.kick(-0.05);
      c.fx.fov(0.04);
      c.fx.shake(0.08);
    }
  },
};
