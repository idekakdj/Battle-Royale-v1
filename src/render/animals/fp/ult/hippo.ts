/**
 * Hippo — Riverlord's Flood, first-person directive (v1.3 Phase-3c).
 * Windup 0.9 s (rear-up + bellow), active 0.79 s (slam 0-0.13, then the forward surge), recovery 0.7 s (exhale).
 * The sim locks the body to the cast aim for the windup + surge, so the view's yaw follows it (a soft lock:
 * the mouse keeps ~12 %); pitch rears up, then the slam kicks down, the eye surges forward, and the exhale bobs.
 */

import { type UltDirector, bump, sm } from '../ultCam';
import { followSimYaw } from './common';

export const hippoUlt: UltDirector = {
  view(c, v) {
    v.follow = 0.6;
    if (c.phase === 'windup') {
      followSimYaw(c, v, 10, 0.12);
      // Rear-up: the view tips up ~17 degrees over 0.4 s, then leans back a little; the eye rises with it.
      v.pitch = 0.3 * sm(c.pt, 0, 0.4) - 0.08 * sm(c.pt, 0.4, 0.9);
      v.eyeY = 0.2 * sm(c.pt, 0, 0.4);
      // Bellow (0.18-0.72 s): a slight FOV widening and a faint shudder.
      v.fovPct = 0.03 * sm(c.pt, 0.18, 0.5);
      v.shake = 0.006 * sm(c.pt, 0.18, 0.45);
      v.smooth = 10;
      return;
    }
    if (c.phase === 'active') {
      followSimYaw(c, v, 10, 0.12);
      // Slam kick is an impulse (stage); the surge pushes the eye ~0.4 m forward then settles, FOV relaxes.
      v.eyeF = 0.4 * bump(c.pt, 0.04, 0.3, 0.8);
      v.eyeY = 0.2 * (1 - sm(c.pt, 0, 0.12)) - 0.05 * sm(c.pt, 0.1, 0.3);
      v.pitch = -0.05 * (1 - sm(c.pt, 0.1, 0.6));
      v.fovPct = 0.04 * (1 - sm(c.pt, 0, 0.5));
      v.smooth = 14;
      return;
    }
    // Exhale: decaying breaths, the view sags and slowly recovers.
    const decay = Math.exp(-c.pt * 3);
    v.pitch = -0.035 * Math.sin(c.pt * 6.9) * decay - 0.05 * (1 - sm(c.pt, 0, 0.7));
    v.eyeY = -0.12 * (1 - sm(c.pt, 0, 0.7));
    v.smooth = 8;
  },
  stage(c, s) {
    if (c.phase === 'active' && s === 1) {
      // The forefeet hammer down.
      c.fx.kick(-0.14);
      c.fx.shake(0.4);
    }
  },
};
