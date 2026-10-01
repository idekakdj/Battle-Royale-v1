/**
 * Mole — Sinkhole Vortex, first-person directive (v1.3 Phase-3c).
 * Windup 1.3 s: dig-in 0-0.4 (eye sinks ~0.3 m, dirt at the edges) then the tunnel 0.4-1.3 (body hidden, a low
 * ground-skimming view with a rumble). Active (stage 1) 2.0 s vortex: surface at the pit rim, rise to full height and
 * look at the pit centre; swirl sway. Stage 2 = collapse (hard down-kick) then the shake-off recovery.
 */

import { type UltDirector, sm } from '../ultCam';
import { lookAt } from './common';

export const moleUlt: UltDirector = {
  view(c, v) {
    if (c.phase === 'windup') {
      const dig = Math.min(1, c.pt / 0.4);
      const tunnel = sm(c.pt, 0.4, 0.7);
      // The dig-in sink itself reaches the eye through the head follow (~0.3 m); only a little extra drop here, then the
      // tunnel's ground-skimming eye (~0.3 m above the ground) once the follow is cut.
      v.eyeY = -0.1 * sm(c.pt, 0, 0.4) - 0.32 * tunnel;
      v.pitch = -0.2 * sm(c.pt, 0, 0.3) * (1 - sm(c.pt, 0.4, 0.6)) - 0.05 * tunnel;
      v.vignette = 0.35 * sm(c.pt, 0.1, 0.4);
      v.follow = 1 - sm(c.pt, 0.3, 0.45); // body hidden underground: the eye sits rigidly low
      v.roll = 0.03 * Math.sin(c.pt * 22) * (1 - sm(dig, 0.7, 1)); // alternating scoops
      v.shake = 0.01 * tunnel; // tunnel rumble
      v.smooth = 10;
      // The tunnel runs along the crack to the pit: drift toward the pit centre.
      if (c.pt > 0.35 && c.aim !== null) lookAt(c, v, c.aim, { w: 0, yawRate: 2.2, mouse: 0.7 });
      return;
    }
    if (c.phase === 'active' && c.stage <= 1) {
      // Surface at the rim: burst up to full height, look at the pit centre so the swirl fills the lower view.
      v.eyeY = -0.42 * (1 - sm(c.st, 0, 0.35));
      v.vignette = 0.35 * (1 - sm(c.st, 0, 0.5));
      v.follow = 0.6;
      v.smooth = 9;
      const p = c.stagePos ?? c.aim;
      if (p !== null) {
        const dx = p.x - c.eye.x;
        const dz = p.z - c.eye.z;
        const d = Math.hypot(dx, dz);
        const k = d > 3 ? 3 / d : 1; // a ground point ~3 m ahead on the way to the centre
        const gx = c.eye.x + dx * k;
        const gz = c.eye.z + dz * k;
        lookAt(c, v, { x: gx, y: 0, z: gz }, { w: 0.75 * sm(c.st, 0.15, 0.5), yawRate: 5, mouse: 0.4, lo: -0.8, hi: 0.2 });
        // yawTo must aim at the centre itself, not the nearer ground point.
        if (d > 0.8) v.yawTo = Math.atan2(dx, dz);
      }
      // Vortex sway (view-only roll, ~0.6 Hz).
      v.roll = 0.045 * Math.sin(c.t * 3.8) * sm(c.st, 0.3, 0.7);
      return;
    }
    // Collapse + shake-off.
    v.pitch = -0.1 * (1 - sm(c.st, 0, 0.5));
    v.roll = 0.04 * Math.sin(c.st * 20) * Math.exp(-c.st * 5);
    v.follow = 0.7;
    v.smooth = 9;
  },
  stage(c, s) {
    if (c.phase === 'windup') return;
    if (s === 1) {
      c.fx.kick(0.1);
      c.fx.shake(0.3);
      c.fx.vignette(0.4);
    } else if (s === 2) {
      c.fx.kick(-0.22);
      c.fx.shake(0.6);
    }
  },
};
