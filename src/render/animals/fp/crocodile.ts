/**
 * Crocodile first-person profile (v1.3 WP-Q, clear-view pass).
 * Joints: body, head, jaw, legs.0-3, tail1-3. The WHOLE head is hidden — cranium, the long snout AND the separate lower jaw
 * bone — with no kept snout: the snout dominated the view (especially while jumping) and a cut through the head mesh left
 * fragmentary triangles. The stubby fore legs are small viewmodels at the lower corners (tucked away in the air), the body
 * never heaves up around the eye, the death roll (body roll) never reaches the camera, and a screen-space clear zone (`clip`)
 * guarantees nothing of the own rig is drawn in the centre of the screen.
 */

import type { FpProfile } from './types';
import { calmJoints, edgeTip, pawPose } from './common';

export const CROCODILE_FP: FpProfile = {
  animal: 'crocodile',
  eye: { forward: 0.86, up: 0.76, side: 0 },
  hide: ['head', 'jaw'],
  clip: { w: 0.5, h: 0.6 },
  nearPlane: 0.04,
  viewPitch: 1,
  attackKick: 1.3,
  follow: 0.4,
  bob: 0.012,
  eyeAction: { block: { up: -0.1 } },
  pose(c) {
    if (c.action === 'ultimate') {
      // The death roll spins the whole body (`body.rz`, three full revolutions) around the eye: the belly / back would sweep
      // through the camera and flash the view black every half turn. In first person the roll is dropped (the camera never
      // rolls with the body; the victim still orbits at the jaws, slaved by the sim).
      const st = c.state.ultStage ?? 0;
      if (st >= 5 && st <= 8) c.J('body').rz = 0;
    } else {
      calmJoints(c, ['body'], 0.2);
      pawPose(c, {
        len: 0.5,
        scale: 0.7,
        right: 'legs.0',
        left: 'legs.1',
        first: 'left',
        rest: edgeTip(0.86, -0.9, 0.9, 0.35, 0.15),
        air: edgeTip(0.98, -1.0, 0.9, 0.4, 0.15),
        runReach: 0.1,
        runLift: 0.05,
        swipeWind: edgeTip(1.0, -0.62, 0.9, 0.15, 0.3),
        swipeHit: edgeTip(0.15, -0.95, 1.1, 0.3, -0.3),
        lunge: edgeTip(0.62, -0.87, 1.1, 0.35, -0.05),
        guard: edgeTip(0.74, -0.86, 0.9, 0.4, -0.1),
      });
    }
  },
};
