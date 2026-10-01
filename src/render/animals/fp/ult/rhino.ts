/**
 * Rhino — Seismic Stampede, first-person directive (v1.3 Phase-3c).
 * Windup 0.8 s (paw: head lowers) → charge (stage 1, up to 3 s) → gore (2, 0.3 s hoist) → crush (3) / skid (4) →
 * recovery. Homing makes the heading sim-driven (<= 110 deg/s): the view yaw is pulled toward the rhino's yaw while a
 * lock is held; the view rolls into turns and the FOV widens with speed.
 */

import { type UltDirector, clampPitch, sm } from '../ultCam';
import { followSimYaw } from './common';

const TOP_SPEED = 12;

export const rhinoUlt: UltDirector = {
  view(c, v) {
    const locked = c.state.ultTargetId !== undefined && c.state.ultTargetId >= 0;
    v.follow = 0.5;
    if (c.phase === 'windup') {
      // Paw: the head lowers, so the view pitches down ~17 degrees with a ~1.6 Hz scrape bob.
      v.pitch = -0.3 * sm(c.pt, 0, 0.35) + 0.012 * Math.sin(c.pt * 10.05) * sm(c.pt, 0.2, 0.4);
      v.eyeY = -0.05 * sm(c.pt, 0, 0.35);
      v.smooth = 10;
      if (locked) followSimYaw(c, v, 7, 0.4); // the rhino auto-sights the lock (<= 150 deg/s)
      return;
    }
    if (c.phase === 'active' && c.stage <= 2) {
      const sp = Math.min(1, c.speed / TOP_SPEED);
      c.mem.ph = (c.mem.ph ?? 0) + c.dt * 6.283185307 * (3.2 + 1.8 * sp); // stride cadence 3.2 -> 5 Hz
      const ph = c.mem.ph;
      v.fovPct = 0.09 * sm(sp, 0.1, 0.95);
      v.pitch = -0.1 * sm(c.pt, 0, 0.35) + 0.018 * Math.sin(ph) * sp;
      v.eyeY = 0.035 * Math.sin(ph + 0.6) * sp;
      // Lean into turns (same sign as the body roll: turning left banks the left side down).
      v.roll = clampPitch(c.yawRate * 0.055, -0.07, 0.07) * sp;
      v.smooth = 12;
      if (c.stage === 2) {
        // Gore: the horn flicks up and stays raised while the victim rides it.
        v.pitch += 0.22 * sm(c.st, 0, 0.2);
      }
      if (locked && c.stage === 1) followSimYaw(c, v, 8, 0.35); // homing: the sim owns the heading
      return;
    }
    // Crush / skid / recovery shake-off.
    const t = c.stage === 3 ? c.st : c.pt;
    v.fovPct = 0;
    v.pitch = c.stage === 3 ? -0.08 * (1 - sm(t, 0, 0.5)) : 0.04 * (1 - sm(c.st, 0, 0.5));
    v.roll = 0.02 * Math.sin(c.pt * 14) * Math.exp(-c.pt * 5);
    v.smooth = 8;
  },
  stage(c, s) {
    if (c.phase === 'windup') return;
    if (s === 2) {
      c.fx.kick(0.2);
      c.fx.shake(0.22);
    } else if (s === 3) {
      c.fx.kick(-0.16);
      c.fx.shake(0.55);
    } else if (s === 4) {
      c.fx.shake(0.12);
    }
  },
};
