/**
 * Giraffe first-person profile (v1.3 WP-Q).
 * Joints: body, neck1, neck2, head, legs.0-3 (legs.0 = screen-right fore leg), tail. The head and upper neck
 * are hidden; the eye sits ~3.7 m up on the head and follows the neck's swing lightly. The forelegs are
 * pinned into view only for the Thunder Kick (special), so the hooves visibly lash out.
 */

import type { FpProfile } from './types';
import { pin, mixTip, mirrorTip, smooth01, ramp, impactPulse, type Tip } from './common';

const REST: Tip = { x: 0.35, y: -2.4, z: 1.2, down: 0.9, out: 0.05 };
const KICK: Tip = { x: 0.3, y: -1.1, z: 2.5, down: -0.4, out: -0.05 };

export const GIRAFFE_FP: FpProfile = {
  animal: 'giraffe',
  eye: { forward: 0.05, up: 3.7, side: 0 },
  hide: ['head', 'neck2'],
  ultClip: { w: 0.5, h: 0.6 },
  nearPlane: 0.08,
  attackKick: 1.8,
  follow: 0.35,
  bob: 0.02,
  pose(c) {
    if (c.action !== 'special') return;
    const rear = smooth01(ramp(c.u, 0, 0.34));
    const kick = impactPulse(c.u, 0.1);
    const k = Math.max(kick, rear * 0.15);
    pin(c, 'legs.0', 1.6, mixTip(REST, KICK, k));
    pin(c, 'legs.1', 1.6, mixTip(mirrorTip(REST), mirrorTip(KICK), k));
  },
};
