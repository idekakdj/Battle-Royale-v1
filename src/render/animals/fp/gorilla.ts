/**
 * Gorilla first-person profile (v1.3 WP-Q).
 * Joints: body, head, armL / armR (armL = the animal's right = screen-right), foreL / foreR (elbows),
 * legL / legR, legs.0-3 (= armL, armR, legL, legR). Head hidden; the arms are pinned as a viewmodel:
 * knuckle stride on run, wide hooks (attack1/2), overhead double-fist slam (attack3 / leap), crossed guard.
 */

import type { FpProfile } from './types';
import { pawPose } from './common';

export const GORILLA_FP: FpProfile = {
  animal: 'gorilla',
  eye: { forward: 0.5, up: 1.48, side: 0 },
  hide: ['head'],
  nearPlane: 0.06,
  follow: 0.55,
  bob: 0.03,
  pose(c) {
    pawPose(c, {
      len: 1.2,
      right: 'armL',
      left: 'armR',
      first: 'left',
      rest: { x: 0.52, y: -0.72, z: 0.8, down: 0.1, out: 0.08 },
      runReach: 0.3,
      runLift: 0.22,
      swipeWind: { x: 0.95, y: -0.15, z: 0.55, down: -0.4, out: 0.6, roll: 0.3 },
      swipeHit: { x: -0.35, y: -0.3, z: 1.3, down: -0.2, out: -0.6 },
      lunge: { x: 0.3, y: -0.8, z: 1.35, down: 0.5, out: -0.05 },
      wind3: { x: 0.6, y: 0.3, z: 0.6, down: -1.0, out: 0.1 },
      guard: { x: -0.05, y: -0.1, z: 1.0, down: -0.15, out: 0.35 },
    });
    // Elbows stay slightly bent.
    c.J('foreL').rx = -0.1;
    c.J('foreR').rx = -0.1;
  },
};
