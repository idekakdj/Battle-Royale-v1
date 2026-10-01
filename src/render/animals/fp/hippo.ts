/**
 * Hippo first-person profile (v1.3 WP-Q, clear-view pass).
 * Joints: body, head, jaw, legs.0-3, tail. The WHOLE head is hidden — skull AND the separate jaw bone (jaw, tusks, tongue) —
 * with no kept muzzle: a cut through a head mesh leaves fragmentary geometry right in front of the lens. The two fore feet are
 * small viewmodels hugging the lower corners / bottom edge (stride on run, low sweeps for the chomps, guard for block), the
 * barrel never swings up around the eye, and a screen-space clear zone (`clip`) guarantees nothing of the own rig is ever
 * drawn in the centre of the screen.
 */

import type { FpProfile } from './types';
import { calmJoints, edgeTip, pawPose } from './common';

export const HIPPO_FP: FpProfile = {
  animal: 'hippo',
  eye: { forward: 1.08, up: 1.56, side: 0 },
  hide: ['head', 'jaw'],
  clip: { w: 0.5, h: 0.6 },
  nearPlane: 0.06,
  viewPitch: 1,
  attackKick: 1.3,
  follow: 0.45,
  bob: 0.02,
  pose(c) {
    const a = c.action;
    if (a === 'ultimate') {
      // The flood's rear-up pitches the whole body back (~31 degrees, 0.24 m up) and the coil / slam pitch it further: the
      // barrel would swing up around the eye. In first person the body pitch is scaled down (the camera itself never rotates
      // with the body; the rear-up is carried by the director's pitch + eye lift).
      const b = c.J('body');
      b.rx *= 0.3;
      b.py *= 0.3;
      b.pz *= 0.5;
    } else {
      // Chomps / lunges / hits / jumps heave the whole body: keep the barrel and shoulders where the eye left them.
      calmJoints(c, ['body'], 0.2);
      pawPose(c, {
        len: 0.7,
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
