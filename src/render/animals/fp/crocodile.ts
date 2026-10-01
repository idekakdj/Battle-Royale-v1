/**
 * Crocodile first-person profile (v1.3 WP-Q).
 * Joints: body, head, jaw, legs.0-3, tail1-3. The cranium behind the eyes is hidden; the long SNOUT (head
 * triangles ahead of z = 1.02) and the lower JAW stay in view at the bottom of the screen. Bites open the
 * jaws into the view and snap them shut; the death roll (body roll) never reaches the camera.
 */

import type { FpProfile } from './types';
import { ramp, IMPACT } from './common';

/**
 * Jaw gape (0..1) during the Death Roll, keyed off the phase / stage (the phase-local `u` restarts per phase and the
 * active phase spans lunge..toss): hiss (windup) opens, the lunge gapes wide, the clamp and the whole roll keep the
 * jaws SHUT on the victim, the toss flings them open, the whiff snaps at air.
 */
function rollOpen(phase: 'windup' | 'active' | 'recovery' | undefined, stage: number, u: number): number {
  if (phase === 'windup') return 0.75 * ramp(u, 0.05, 0.6);
  if (phase === 'recovery') return stage === 9 ? 0.4 * (1 - ramp(u, 0, 0.6)) : 0;
  if (stage <= 2) return 1; // lunge
  if (stage === 8) return 0.8;
  return 0; // clamp .. roll: jaws shut on the victim
}

export const CROCODILE_FP: FpProfile = {
  animal: 'crocodile',
  eye: { forward: 0.86, up: 0.76, side: 0 },
  hide: ['head'],
  keepFront: { head: 1.02 },
  nearPlane: 0.04,
  attackKick: 1.3,
  follow: 0.4,
  bob: 0.012,
  eyeAction: { block: { up: -0.1 } },
  pose(c) {
    const a = c.action;
    const u = c.u;
    // Bites (attack1/3, ultimate lunge, special dash): lift the lower jaw into view while it opens,
    // and raise the snout so the gape reads from above.
    let open = 0;
    if (a === 'ultimate') {
      open = rollOpen(c.state.ultPhase, c.state.ultStage ?? 0, u);
      // The death roll spins the whole body (`body.rz`, three full revolutions) around the eye: the belly / back would sweep
      // through the camera and flash the view black every half turn. In first person the roll is dropped (the camera never
      // rolls with the body; the victim still orbits at the jaws, slaved by the sim).
      const st = c.state.ultStage ?? 0;
      if (st >= 5 && st <= 8) {
        c.J('body').rz = 0;
        // ... and the head thrash (heave / whip) would swing the kept snout across the whole view: hold it level and low.
        const h = c.J('head');
        h.rx = 0.05;
        h.ry = 0;
        h.rz = 0;
      }
    }
    else if (a === 'attack1' || a === 'attack3') open = ramp(u, 0.05, 0.34) * (1 - ramp(u, 0.42, IMPACT));
    else if (a === 'special') open = 0.6;
    else if (a === 'attack2') open = 0.5 * ramp(u, 0.05, 0.34) * (1 - ramp(u, 0.42, IMPACT));
    if (open > 0) {
      c.J('head').rx += -0.14 * open;
      c.J('jaw').py += 0.25 * open;
      c.J('jaw').pz += 0.05 * open;
    }
  },
};
