/**
 * Rhino first-person profile (v1.3 WP-Q).
 * Joints: body, head, legs.0-3, tail. The skull is hidden; the horns and snout tip (head triangles ahead of
 * z = 1.42) stay in view at the top/bottom of the frame, so the horn hooks, fling and charge read.
 */

import type { FpProfile } from './types';

export const RHINO_FP: FpProfile = {
  animal: 'rhino',
  eye: { forward: 1.02, up: 1.44, side: 0 },
  hide: ['head'],
  keepFront: { head: 1.42 },
  nearPlane: 0.06,
  attackKick: 1.4,
  follow: 0.45,
  bob: 0.024,
};
