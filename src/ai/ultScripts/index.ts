/**
 * Bot ultimate script registry (v1.3). To rework an animal's bot behaviour edit
 * `src/ai/ultScripts/<animal>.ts` (an {@link UltScript}); it is already registered here.
 */

import type { AnimalId } from '../../core/types';
import type { UltScript } from './types';
import { lionUltScript } from './lion';
import { gorillaUltScript } from './gorilla';
import { crocodileUltScript } from './crocodile';
import { hippoUltScript } from './hippo';
import { rhinoUltScript } from './rhino';
import { eagleUltScript } from './eagle';
import { pantherUltScript } from './panther';
import { pythonUltScript } from './python';
import { giraffeUltScript } from './giraffe';
import { moleUltScript } from './mole';

export type { UltScript } from './types';

export const ULT_SCRIPTS: Record<AnimalId, UltScript> = {
  lion: lionUltScript,
  gorilla: gorillaUltScript,
  crocodile: crocodileUltScript,
  hippo: hippoUltScript,
  rhino: rhinoUltScript,
  eagle: eagleUltScript,
  panther: pantherUltScript,
  python: pythonUltScript,
  giraffe: giraffeUltScript,
  mole: moleUltScript,
};
