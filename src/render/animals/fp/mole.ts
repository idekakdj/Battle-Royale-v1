/**
 * Mole first-person profile (v1.3 WP-Q).
 * Joints: body, head, snout, armL / armR (armL = screen-right), legs.0-3, tail. The head skull is hidden
 * but the SNOUT (pink star nose) stays in view at the bottom centre, twitching; the big digging claws are
 * pinned as a viewmodel (swipes, scoop-and-fling, crossed shield). While burrowed the eye drops to ground level.
 */

import type { FpProfile } from './types';
import { pawPose } from './common';

export const MOLE_FP: FpProfile = {
  animal: 'mole',
  eye: { forward: 0.42, up: 0.72, side: 0 },
  hide: ['head'],
  nearPlane: 0.035,
  follow: 1,
  bob: 0.012,
  eyeAction: { burrowed: { up: -0.42 } },
  pose(c) {
    pawPose(c, {
      len: 0.45,
      right: 'armL',
      left: 'armR',
      first: 'left',
      rest: { x: 0.3, y: -0.4, z: 0.44, down: 0.15, out: 0.1 },
      runReach: 0.16,
      runLift: 0.14,
      swipeWind: { x: 0.5, y: -0.22, z: 0.44, down: -0.25, out: 0.5, roll: 0.3 },
      swipeHit: { x: -0.2, y: -0.2, z: 0.89, down: -0.35, out: -0.6 },
      lunge: { x: 0.2, y: -0.3, z: 0.94, down: -0.1, out: -0.1 },
      guard: { x: -0.05, y: -0.16, z: 0.69, down: -0.3, out: 0.3 },
    });
    // The star nose stays at the bottom of the view, but it would fill the screen while the head rears or
    // pitches into the dig (scoop, eruption, sinkhole), so it tucks away then.
    const a = c.action;
    if (a === 'attack3' || a === 'special' || a === 'ultimate') c.J('snout').s = 0.02;
  },
};
