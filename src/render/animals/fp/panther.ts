/**
 * Panther first-person profile (v1.3 WP-Q).
 * Joints: body, legs.0-3 (legs.0 = screen-right fore paw, legs.1 = left), neck, head, jaw, tail, tail2.
 * Head/neck/jaw hidden; fore paws pinned as a viewmodel (same scheme as the lion, slimmer/faster).
 */

import type { FpProfile } from './types';
import { pawPose } from './common';
import { type UltPawSet, pantherUltPaws } from './ultPaws';

/** v1.3: the Shadow Execution viewmodel — rake R / chop L / low sweep / lunge / spin / finisher per stage (see ultPaws.ts). */
const EXEC_PAWS: UltPawSet = {
  len: 0.78,
  right: 'legs.0',
  left: 'legs.1',
  rest: { x: 0.4, y: -0.6, z: 0.85, down: 0.12, out: 0.05 },
  wind: { x: 0.75, y: -0.2, z: 0.8, down: -0.25, out: 0.5, roll: 0.3 },
  hit: { x: -0.3, y: -0.1, z: 1.35, down: -0.35, out: -0.6 },
  lunge: { x: 0.26, y: -0.12, z: 1.45, down: -0.3, out: -0.1 },
  raised: { x: 0.5, y: 0.3, z: 0.7, down: -0.9, out: 0.2 },
  slam: { x: 0.25, y: -0.65, z: 1.25, down: 0.3, out: -0.05 },
  // Clear-view rule for the ULTIMATE only (the normal look is approved and unchanged): small paws that stay at the edges.
  scale: 0.5,
  band: true,
};

export const PANTHER_FP: FpProfile = {
  animal: 'panther',
  eye: { forward: 0.86, up: 1.2, side: 0 },
  hide: ['head', 'neck', 'jaw'],
  ultClip: { w: 0.5, h: 0.6 },
  ultViewLock: true,
  ultHide: ['body', 'legs.2', 'legs.3', 'tail', 'tail2'], // only the pinned fore paws remain during the ultimate
  nearPlane: 0.05,
  follow: 0.6,
  bob: 0.022,
  pose(c) {
    pawPose(c, {
      len: 0.78,
      right: 'legs.0',
      left: 'legs.1',
      first: 'left',
      rest: { x: 0.4, y: -0.6, z: 0.85, down: 0.12, out: 0.05 },
      runReach: 0.22,
      runLift: 0.18,
      swipeWind: { x: 0.75, y: -0.2, z: 0.8, down: -0.25, out: 0.5, roll: 0.3 },
      swipeHit: { x: -0.3, y: -0.1, z: 1.35, down: -0.35, out: -0.6 },
      lunge: { x: 0.26, y: -0.12, z: 1.45, down: -0.3, out: -0.1 },
      guard: { x: 0.2, y: 0.0, z: 1.05, down: -0.6, out: -0.2 },
    });
    if (c.action === 'ultimate') pantherUltPaws(c, EXEC_PAWS);
  },
};
