/**
 * First-person profile registry (v1.3 WP-Q). One profile per animal in
 * `fp/<animal>.ts`; see `fp/types.ts` for the format. To adjust an animal,
 * edit only its own file here — the shared third-person poses stay untouched.
 *
 * QA handle: `window.__gkFp.joints('lion')` prints every joint name with its
 * triangle count / rest bounding box / pivot (authoring aid for `hide`, `eye`);
 * `window.__gkFp.sheet(cells, cols)` paints a contact sheet of FP views in the
 * demo match (`?demo=match`, see fp/qa.ts).
 */

import type { AnimalId } from '../../../core/types';
import type { FpProfile } from './types';
import { LION_FP } from './lion';
import { PANTHER_FP } from './panther';
import { GORILLA_FP } from './gorilla';
import { MOLE_FP } from './mole';
import { CROCODILE_FP } from './crocodile';
import { HIPPO_FP } from './hippo';
import { RHINO_FP } from './rhino';
import { PYTHON_FP } from './python';
import { GIRAFFE_FP } from './giraffe';
import { EAGLE_FP } from './eagle';
import { installFpQa } from './qa';

export type { FpProfile, FpEye, FpPoseCtx, FpEyeSample, FpLimb } from './types';

const PROFILES: Record<AnimalId, FpProfile> = {
  lion: LION_FP,
  gorilla: GORILLA_FP,
  crocodile: CROCODILE_FP,
  hippo: HIPPO_FP,
  rhino: RHINO_FP,
  eagle: EAGLE_FP,
  panther: PANTHER_FP,
  python: PYTHON_FP,
  giraffe: GIRAFFE_FP,
  mole: MOLE_FP,
};

if (typeof window !== 'undefined' && import.meta.env.DEV) installFpQa(); // QA handle, dev builds only

/** The first-person profile for an animal. */
export function getFpProfile(animal: AnimalId): FpProfile {
  return PROFILES[animal];
}
