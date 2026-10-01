/**
 * Panther — Shadow Execution, first-person directive (v1.3 Phase-3c).
 * Melt (windup/0.35 s) → five blink strikes (active/1-5, claws land 0.08 s after each blink) → finisher blink behind
 * the victim (6) → execute pulse (7) → reappearance (recovery/8). The eye never pops with a blink: the director
 * slides it from the old spot; here the view re-aims at the victim within ~0.06 s and flicks a vignette.
 */

import { type UltDirector, bump, sm } from '../ultCam';
import { eyeBack, lookAt } from './common';

export const pantherUlt: UltDirector = {
  view(c, v) {
    const s = c.stage;
    if (c.phase === 'windup') {
      // Melt into shadow: crouch, darken the edges, eyes on the victim.
      v.eyeY = -0.22 * sm(c.pt, 0, 0.3);
      v.vignette = 0.32 * sm(c.pt, 0, 0.3);
      v.follow = 0.4;
      lookAt(c, v, c.victim, { h: 0.9, w: 0.5, yawRate: 6, mouse: 0.5, lo: -0.5, hi: 0.3 });
      return;
    }
    if (c.phase === 'recovery') {
      // Reappearance: low stalking eye easing back to standing, slow sway, the shadow edge lifts.
      v.eyeY = -0.1 * (1 - sm(c.pt, 0, 0.9));
      v.roll = 0.015 * Math.sin(c.pt * 3) * (1 - sm(c.pt, 0, 1));
      v.vignette = 0.2 * (1 - sm(c.pt, 0, 0.5));
      v.follow = 0.4;
      v.smooth = 8;
      return;
    }
    // Strikes / finisher: stay locked on the victim, re-aim hard right after each blink.
    const fresh = c.bt < 0.12;
    v.vignette = 0.2;
    v.follow = 0.35;
    v.eyeY = -0.12;
    eyeBack(c, v, 1.5, 1.0); // the strike angles sit ~1.6 m from the victim's centre: keep the eye out of its body
    lookAt(c, v, c.victim, { h: 0.9, w: 0.9, yawRate: fresh ? 45 : 12, mouse: 0.2, lo: -0.7, hi: 0.35 });
    if (s >= 1 && s <= 5) {
      // Claws land 0.08 s after the blink: a small kick per distinct slash.
      if (c.once('k' + s, c.st >= 0.08)) {
        if (s === 1) c.fx.kick(-0.04, 0.03); // rake
        else if (s === 2) c.fx.kick(-0.09); // overhead chop
        else if (s === 3) c.fx.kick(-0.03, -0.05); // low sweep
        else if (s === 4) {
          c.fx.kick(-0.05);
          c.fx.fov(0.05); // lunge-bite
        } else c.fx.kick(-0.05, 0.2); // spinning double rake: a quick roll
      }
    } else if (s === 6) {
      // Finisher: the view rises and hangs, then slams down at the impact.
      const rise = sm(c.st, 0, 0.09) * (1 - sm(c.st, 0.13, 0.2));
      v.eyeY = -0.12 + 0.42 * rise;
      v.pitch = 0.22 * rise;
      v.smooth = 22;
      if (c.once('slam', c.st >= 0.14)) {
        c.fx.kick(-0.22);
        c.fx.shake(0.3);
      }
    } else if (s >= 7) {
      v.pitch = -0.08 * (1 - sm(c.st, 0, 0.4));
      v.vignette = 0.2 * bump(c.st, 0, 0.05, 0.4);
    }
  },
  stage(c, s) {
    if (s === 7) {
      // Execute pulse: a short full-screen white-violet flash.
      c.fx.flash(0.55);
      c.fx.kick(-0.12);
      c.fx.shake(0.3);
    } else if (s === 8) {
      c.fx.vignette(0.2);
    }
  },
  blink(c) {
    // A new angle: darken the edges for an instant (the director already slides the eye from the old spot).
    c.fx.vignette(0.55);
    c.fx.kick(0.02);
  },
};
