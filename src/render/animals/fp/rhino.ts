/**
 * Rhino first-person profile (v1.3 WP-Q, clear-view pass).
 * Joints: body, head, legs.0-3, tail. The WHOLE head — skull, ears AND the horn — is hidden (the horn dead-centre was the worst
 * offender; a kept snout/horn cut through the head mesh also left fragmentary triangles). The fore feet are small viewmodels
 * hugging the lower corners (stride on run, low sweeps for the hooks, guard for block), the barrel never heaves up around the
 * eye, and a screen-space clear zone (`clip`) guarantees nothing of the own rig is drawn in the centre of the screen.
 */

import type { FpProfile } from './types';
import { calmJoints, edgeTip, pawPose } from './common';

export const RHINO_FP: FpProfile = {
  animal: 'rhino',
  eye: { forward: 1.02, up: 1.44, side: 0 },
  hide: ['head'],
  clip: { w: 0.5, h: 0.6 },
  nearPlane: 0.06,
  viewPitch: 1,
  attackKick: 1.4,
  follow: 0.45,
  bob: 0.024,
  pose(c) {
    const a = c.action;
    if (a === 'ultimate') {
      const b = c.J('body');
      b.rx *= 0.3;
      b.py *= 0.3;
      b.pz *= 0.5;
    } else {
      calmJoints(c, ['body'], 0.2);
      pawPose(c, {
        len: 0.72,
        scale: 0.55,
        right: 'legs.0',
        left: 'legs.1',
        first: 'left',
        rest: edgeTip(0.84, -0.92, 1.0, 0.35, 0.12),
        air: edgeTip(1.0, -1.14, 1.0, 0.4, 0.15),
        runReach: 0.14,
        runLift: 0.06,
        swipeWind: edgeTip(1.0, -0.62, 0.95, 0.15, 0.3),
        swipeHit: edgeTip(0.15, -0.95, 1.15, 0.3, -0.3),
        lunge: edgeTip(0.62, -0.87, 1.2, 0.35, -0.05),
        guard: edgeTip(0.74, -0.86, 0.95, 0.4, -0.1),
      });
    }
  },
};
