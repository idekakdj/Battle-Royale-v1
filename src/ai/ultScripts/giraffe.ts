/**
 * Giraffe — Timber Fall bot script (v1.3 neck-hammer slam).
 *
 * The slam lands on a circle that commits 0.6 s after the cast and only hits a body still inside it 0.64 s
 * later, so it punishes targets that cannot (or will not) step out: helpless / rooted / mid-cast foes,
 * cracked guards, turtlers with nobody to help them and nearly-dead isolated foes. Runners and healthy
 * crowds are the worst targets (the giraffe is rooted in its cast, cannot be protected from a third party
 * for 1.2 s). The lock itself (7.5 m, 70°) is validated by the brain (`ultTargetValid`), so the gate only
 * decides whether the situation is worth the cast. The giraffe creeps in while rearing, so the gate can start
 * well outside its neck's melee reach.
 */

import type { Situation } from '../scripts';
import type { UltScript } from './types';

// Lock range is 7.5 m (body); stay inside it (the victim keeps moving while the noisy aim settles).
const gate = (s: Situation): boolean => s.tdist >= 2 && s.tdist <= 6.8;

export const giraffeUltScript: UltScript = {
  gate,
  ranged: true,
  rangedWindow(s) {
    if (s.targetFleeing) return false; // a runner walks out of the circle
    return s.targetHelpless || s.targetRooted || s.targetCommitted || s.tGuardFrac < 0.3 || (s.targetIsolated && s.tHpFrac <= 0.6);
  },
  apex(s, out) {
    if (!gate(s) || s.targetFleeing) return;
    const soft = s.targetHelpless || s.targetRooted || s.targetCommitted;
    const guardBroken = s.tGuardFrac < 0.3;
    const sitting = s.targetBlocking && s.targetIsolated;
    out.ult = soft || guardBroken || sitting || (s.targetIsolated && s.tHpFrac <= 0.6);
  },
};
