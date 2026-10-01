/**
 * Hippo first-person profile (v1.3 WP-Q).
 * Joints: body, head, jaw, legs.0-3, tail. The skull is hidden; the broad muzzle (head triangles ahead of
 * z = 1.5) and lower jaw + tusks stay at the bottom of the view. Chomps gape the jaws into view.
 */

import type { FpProfile } from './types';
import { ramp, IMPACT } from './common';

/**
 * Jaw gape (0..1) during the Riverlord's Flood. The ultimate's `actionT` RESTARTS in each phase (windup 0.9 s ->
 * surge 0.79 s -> recovery 0.7 s), so the gape is keyed off `state.ultPhase` and the phase-local progress `u`:
 * windup opens to 0.7 by ~0.7 s and stays open, the surge keeps it open then relaxes, the exhale closes it.
 */
function floodOpen(phase: 'windup' | 'active' | 'recovery' | undefined, u: number): number {
  if (phase === 'windup') return 0.7 * ramp(u, 0.05, 0.78);
  if (phase === 'recovery') return 0.45 * (1 - ramp(u, 0, 0.75));
  return 0.7 - 0.25 * ramp(u, 0.2, 1); // active (surge)
}

export const HIPPO_FP: FpProfile = {
  animal: 'hippo',
  eye: { forward: 1.08, up: 1.56, side: 0 },
  hide: ['head'],
  keepFront: { head: 1.5 },
  nearPlane: 0.06,
  attackKick: 1.3,
  follow: 0.45,
  bob: 0.02,
  pose(c) {
    const a = c.action;
    const u = c.u;
    let open = 0;
    if (a === 'ultimate') open = floodOpen(c.state.ultPhase, u);
    else if (a === 'attack3') open = ramp(u, 0.05, 0.4) * (1 - ramp(u, 0.44, IMPACT));
    else if (a === 'attack1' || a === 'attack2') open = 0.45;
    else if (a === 'special') open = 0.7;
    if (a === 'ultimate') {
      // The flood's rear-up pitches the whole body back (~31 degrees, 0.24 m up) and the coil / slam pitch it further: the
      // barrel would swing up around the eye (the view fills with the black outline hull) and the kept muzzle would sweep
      // across the view. In first person the body pitch is scaled down and the head counter-rotated so the muzzle stays level
      // and low (the camera itself never rotates with the body; the rear-up is carried by the director's pitch + eye lift).
      const b = c.J('body');
      b.rx *= 0.3;
      b.py *= 0.3;
      b.pz *= 0.5;
      const h = c.J('head');
      h.rx = -b.rx + 0.12 - 0.1 * open;
      c.J('jaw').py += 0.2 * open;
    } else if (open > 0) {
      c.J('head').rx += -0.3 * open;
      c.J('jaw').py += 0.2 * open;
    }
  },
};
