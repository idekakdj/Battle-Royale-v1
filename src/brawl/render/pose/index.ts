/**
 * Champions League pose layer (plan §6 / §10). Entry point for the view:
 *
 *   const rig = createBrawlRig('lion');
 *   scene.add(rig.root);
 *   rig.update(cur, prev, alpha, dtRender);   // every render frame
 *   rig.tipWorld('strike');                   // VFX anchor of the current striking limb
 */

import type { AnimalId } from '../../../core/types';
import { BrawlRig } from './BrawlRig';
import { getBuilt } from './build';
import { getMoveBody } from '../../data';
import { MOVE_IDS } from '../../types';

export { BrawlRig, FACE_YAW } from './BrawlRig';
export type { BuiltMove, FitSample } from './build';
export { getBuilt, STEP_NORMAL, STEP_STRIKE } from './build';
export type { AnimalProfile, TipRole } from './profile';
export { registerProfile, getRegisteredProfile } from './profile';
export { getSolver } from './solver';

/**
 * Pre-build (and cache) every move pose of `animal` — forward-kinematics fits for ~20 bodies, ≈ 50–150 ms. `createBrawlRig`
 * does this once per animal so no move ever hitches in a match.
 */
export function warmMoves(animal: AnimalId): void {
  for (const id of MOVE_IDS) {
    getBuilt(animal, getMoveBody(animal, id, false, 0), false, 0);
    getBuilt(animal, getMoveBody(animal, id, true, 0), true, 0);
    for (let c = 1; c <= 2; c++) {
      const b = getMoveBody(animal, id, false, c);
      if (id === 'lightN') getBuilt(animal, b, false, c);
    }
  }
}

/** Contract of plan §10: a rig that performs states and moves from `BrawlFighterState` snapshots. */
export function createBrawlRig(animal: AnimalId): BrawlRig {
  warmMoves(animal);
  return new BrawlRig(animal);
}
