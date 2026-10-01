/**
 * Lion first-person profile (v1.3 WP-Q).
 * Joints: body, legs.0-3 (legs.0 = animal's right / screen-right fore paw,
 * legs.1 = left), neck, head, jaw, mane, tail, tail2. Head, neck, mane and
 * jaw are hidden; the fore paws are pinned to the camera as a viewmodel
 * (rest at the lower corners, stride on run, cross-view swipes, two-paw
 * lunge for the bite / pounce, raised guard for block).
 */

import type { FpProfile } from './types';
import { pawPose } from './common';
import { type UltPawSet, lionUltPaws } from './ultPaws';

/** v1.3: the Royal Hunt viewmodel — paws alternate in view per maul strike (stage-keyed, see ultPaws.ts). */
const HUNT_PAWS: UltPawSet = {
  len: 0.92,
  right: 'legs.0',
  left: 'legs.1',
  rest: { x: 0.42, y: -0.58, z: 0.9, down: 0.12, out: 0.05 },
  wind: { x: 0.8, y: -0.2, z: 0.85, down: -0.25, out: 0.5, roll: 0.3 },
  hit: { x: -0.35, y: -0.1, z: 1.45, down: -0.35, out: -0.6 },
  lunge: { x: 0.28, y: -0.12, z: 1.55, down: -0.3, out: -0.1 },
  raised: { x: 0.5, y: 0.25, z: 0.75, down: -0.9, out: 0.2 },
  slam: { x: 0.25, y: -0.6, z: 1.3, down: 0.3, out: -0.05 },
  // Clear-view rule for the ULTIMATE only (the normal look is approved and unchanged): small paws that stay at the edges.
  scale: 0.5,
  band: true,
};

export const LION_FP: FpProfile = {
  animal: 'lion',
  eye: { forward: 1.0, up: 1.36, side: 0 },
  hide: ['head', 'neck', 'mane', 'jaw'],
  ultClip: { w: 0.5, h: 0.6 },
  ultViewLock: true,
  ultHide: ['body', 'legs.2', 'legs.3', 'tail', 'tail2'], // only the pinned fore paws remain during the ultimate
  nearPlane: 0.06,
  follow: 0.6,
  bob: 0.026,
  pose(c) {
    pawPose(c, {
      len: 0.92,
      right: 'legs.0',
      left: 'legs.1',
      first: 'left',
      rest: { x: 0.42, y: -0.58, z: 0.9, down: 0.12, out: 0.05 },
      runReach: 0.22,
      runLift: 0.18,
      swipeWind: { x: 0.8, y: -0.2, z: 0.85, down: -0.25, out: 0.5, roll: 0.3 },
      swipeHit: { x: -0.35, y: -0.1, z: 1.45, down: -0.35, out: -0.6 },
      lunge: { x: 0.28, y: -0.12, z: 1.55, down: -0.3, out: -0.1 },
      guard: { x: 0.2, y: 0.0, z: 1.1, down: -0.6, out: -0.2 },
    });
    if (c.action === 'ultimate') lionUltPaws(c, HUNT_PAWS);
  },
};
