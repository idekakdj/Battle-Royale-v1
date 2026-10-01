/**
 * Crocodile — Death Roll, first-person directive (v1.3 Phase-3c).
 * Windup 0.55 s (crouch + hiss, stage 0; commit = stage 1) → lunge (2) → clamp (3) → drag (4) → roll (5-7, one beat
 * per revolution) → toss (8) / whiff (9) → recovery. The roll is rig-local `body.rz` only: the camera NEVER inherits it
 * (head follow is 0 for the whole cast), stays level, keeps the snout + jaws at the bottom of the view and lets the
 * victim (~2 m ahead, orbiting 0.55 m) sit in the centre.
 */

import { type UltDirector, bump, sm } from '../ultCam';
import { eyeBack, lookAt, followSimYaw } from './common';

/** The snout lives at the bottom of the frame: never look further UP than this. */
const MAX_UP = 0.04;

export const crocodileUlt: UltDirector = {
  view(c, v) {
    v.follow = 0; // no head heave / shudder / roll reaches the eye
    const s = c.stage;
    if (c.phase === 'windup') {
      v.eyeY = -0.12 * sm(c.pt, 0, 0.3);
      v.shake = 0.004 + (s >= 1 ? 0.008 : 0); // hiss tremor, commit shudder
      lookAt(c, v, c.victim, { h: 0.5, w: 0.5, yawRate: 6, mouse: 0.5, lo: -0.4, hi: MAX_UP });
      return;
    }
    if (c.phase === 'recovery' && s !== 9) {
      v.eyeY = -0.05 * (1 - sm(c.pt, 0, 0.4));
      v.pitch = -0.03 * Math.sin(c.pt * 7) * (1 - sm(c.pt, 0, 0.5)); // exhale heave
      return;
    }
    if (s === 9 || c.phase === 'recovery') {
      // Whiff: braced slide + head shake.
      v.roll = 0.03 * Math.sin(c.st * 9) * (1 - sm(c.st, 0, 0.8));
      v.eyeY = -0.06;
      return;
    }
    // The back heaves up through the clamp / drag / roll: keep the eye ABOVE it (an eye inside the own body shows the black outline hull).
    v.eyeY = s >= 3 && s <= 8 ? 0.14 : 0;
    if (s >= 3 && s <= 8) eyeBack(c, v, 1.4, 0.4); // the held victim sits ~2 m ahead at the jaws
    if (s === 2) {
      followSimYaw(c, v, 10, 0.2); // along the frozen lunge line
      v.fovPct = 0.04;
    } else if (s === 3) {
      v.shake = 0.01 * (1 - sm(c.st, 0, 0.3));
      lookAt(c, v, c.victim, { h: 0.4, w: 0.6, yawRate: 8, mouse: 0.3, lo: -0.4, hi: MAX_UP });
    } else if (s === 4) {
      v.pitch = 0.04 * bump(c.st, 0, 0.1, 0.42); // head hauled up while backing off
      lookAt(c, v, c.victim, { h: 0.4, w: 0.5, yawRate: 5, mouse: 0.4, lo: -0.4, hi: MAX_UP });
    } else if (s >= 5 && s <= 7) {
      v.shake = 0.005;
      lookAt(c, v, c.victim, { h: 0.4, w: 0.4, lo: -0.4, hi: MAX_UP });
      followSimYaw(c, v, 3, 0.5); // keep along the lunge line; do not chase the orbiting victim
    } else if (s === 8) {
      v.pitch = 0.05 * (1 - sm(c.st, 0, 0.4));
    }
  },
  stage(c, s) {
    if (c.phase === 'windup') return;
    if (s === 2) {
      c.fx.fov(0.07);
      c.fx.kick(-0.03);
    } else if (s === 3) {
      c.fx.kick(-0.07);
      c.fx.shake(0.35);
    } else if (s >= 5 && s <= 7) {
      c.fx.kick(-0.04);
      c.fx.shake(0.1);
    } else if (s === 8) {
      c.fx.shake(0.35);
      c.fx.kick(0.1);
      c.fx.fov(0.03);
    }
  },
};
