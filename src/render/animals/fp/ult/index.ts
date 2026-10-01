/**
 * Per-animal first-person ultimate directives (v1.3 Phase-3c), keyed by animal id.
 * See `../ultCam.ts` for the channel / impulse API and how a directive is written.
 */

import type { AnimalId } from '../../../../core/types';
import type { UltDirector } from '../ultCam';
import { lionUlt } from './lion';
import { pantherUlt } from './panther';
import { gorillaUlt } from './gorilla';
import { giraffeUlt } from './giraffe';
import { hippoUlt } from './hippo';
import { rhinoUlt } from './rhino';
import { eagleUlt } from './eagle';
import { moleUlt } from './mole';
import { crocodileUlt } from './crocodile';
import { pythonUlt } from './python';

const DIRECTORS: Record<AnimalId, UltDirector> = {
  lion: lionUlt,
  panther: pantherUlt,
  gorilla: gorillaUlt,
  giraffe: giraffeUlt,
  hippo: hippoUlt,
  rhino: rhinoUlt,
  eagle: eagleUlt,
  mole: moleUlt,
  crocodile: crocodileUlt,
  python: pythonUlt,
};

/** The FP ultimate directive for an animal. */
export function getUltDirector(animal: AnimalId): UltDirector | null {
  return DIRECTORS[animal] ?? null;
}
