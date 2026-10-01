/**
 * Python — Coil Snare, first-person directive (v1.3 Phase-3c).
 * Windup 0.6 s (rear + hiss, stage 0; commit = stage 1) → lash (2) → snare/yank (3) → bind pulses (4-7) → crush (8) /
 * whiff (9). All rig motion is neck/coil-local (no roll or spin): the head follow is small during the cast, the tether
 * flies straight out of the eyes along the aim, and the wrap rings tighten ~1.6 m ahead (a forward-down look).
 */

import { type UltDirector, bump, sm } from '../ultCam';
import { eyeBack, lookAt } from './common';

export const pythonUlt: UltDirector = {
  view(c, v) {
    v.follow = 0.35;
    const s = c.stage;
    if (c.phase === 'windup') {
      // Rear: the neck lifts ~1 m — the eye rises a little, looking down the tether line at the victim.
      v.eyeY = 0.1 * sm(c.pt, 0, 0.35);
      v.shake = 0.004;
      lookAt(c, v, c.victim, { h: 0.9, w: 0.6, yawRate: 5, mouse: 0.5, lo: -0.5, hi: 0.25 });
      if (s >= 1) v.pitch = 0.03 * sm(c.st, 0, 0.1); // winds back at the commit
      return;
    }
    if (c.phase === 'recovery' && s !== 9) {
      v.eyeY = 0.04 * (1 - sm(c.pt, 0, 0.4));
      v.pitch = -0.02 * Math.sin(c.pt * 6) * (1 - sm(c.pt, 0, 0.45));
      return;
    }
    if (s === 9 || c.phase === 'recovery') {
      v.eyeF = -0.2 * bump(c.st, 0, 0.1, 0.5); // the tether snaps back
      return;
    }
    if (s === 2) {
      // Lash: the neck spears forward — the eye leans into it.
      v.eyeF = 0.2 * bump(c.st, 0, 0.1, 0.35);
      v.fovPct = 0.04 * (1 - sm(c.st, 0, 0.3));
      v.mouseYaw = 0.2;
      lookAt(c, v, c.victim, { h: 0.9, w: 0.5, lo: -0.5, hi: 0.25 });
    } else if (s === 3) {
      // Yank: recoil as the victim is hauled in.
      v.eyeF = -0.25 * bump(c.st, 0, 0.15, 0.5);
      lookAt(c, v, c.victim, { h: 0.6, w: 0.7, yawRate: 6, mouse: 0.4, lo: -0.6, hi: 0.2 });
    } else {
      // Bind: forward-down look at the victim; the squeeze tightens one notch per beat.
      const n = Math.max(0, s - 3);
      eyeBack(c, v, 1.4, 0.6);
      v.eyeY = -0.04 * sm(c.st, 0, 0.3);
      v.vignette = 0.05 * n;
      v.shake = 0.002 * n;
      lookAt(c, v, c.victim, { h: 0.9, w: 0.8, yawRate: 4, mouse: 0.5, lo: -0.55, hi: 0.1 });
    }
  },
  stage(c, s) {
    if (c.phase === 'windup') return;
    if (s === 2) {
      c.fx.fov(0.05);
      c.fx.kick(-0.03);
    } else if (s === 3) {
      c.fx.kick(-0.07);
      c.fx.shake(0.3);
    } else if (s >= 4 && s <= 7) {
      c.fx.kick(-0.03, s % 2 === 0 ? 0.02 : -0.02);
      c.fx.shake(0.1);
    } else if (s === 8) {
      c.fx.kick(-0.1);
      c.fx.shake(0.45);
      c.fx.vignette(0.3);
    }
  },
};
