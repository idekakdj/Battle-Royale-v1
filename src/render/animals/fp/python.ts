/**
 * Python first-person profile (v1.3 WP-Q).
 * Joints: body, coil, neckJ.0-3 (neck chain, base to head), head, jaw, tongue, tailTip. The head, jaw, tongue
 * and the top two neck segments are hidden; the eye rides the head (the camera follows the strike forward and
 * back) and the coil / neck body stays visible below when looking down. Never inherits the head's tilt.
 */

import type { FpProfile } from './types';

export const PYTHON_FP: FpProfile = {
  animal: 'python',
  eye: { forward: 0.12, up: 1.62, side: 0 },
  hide: ['head', 'jaw', 'tongue', 'neckJ.2', 'neckJ.3'],
  nearPlane: 0.06,
  attackKick: 1.5,
  follow: 0.75,
  bob: 0.01,
  idleSway: 0.012,
  eyeAction: { knockdown: { up: -0.5 }, dead: { up: -0.6 } },
};
