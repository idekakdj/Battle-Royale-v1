/**
 * Lion — Royal Hunt bot script (v1.3 Phase 2). A single-target lock-on pounce + maul (12 m):
 * bots only cast with a valid lock (the brain vetoes fizzles via `ultTargetValid`), never on a
 * fleeing target (the pounce's landing point homes at only ~3 m/s, so a sprinter outruns it),
 * and Apex saves the charge for soft targets (staggered / guard-broken / low HP) or clean duels.
 * The pounce is guard-piercing and the maul is uninterruptible, so a blocking target is a fine mark.
 */

import type { Situation } from '../scripts';
import type { UltScript } from './types';

/** Lock range is 12 m to the victim's body; the pounce's homing is weak, so bots start it from closer in. */
const REACH = 9;

/**
 * The hunt commits the lion for ~3.5 s (CC-immune, but not damage-immune): not worth starting with a crowd
 * around (anyone within 8 m besides the target).
 */
const gate = (s: Situation): boolean => s.hasTarget && s.tdist <= REACH && !s.targetFleeing && s.enemiesNearSelf8 <= 1;

export const lionUltScript: UltScript = {
  gate,
  // Effective range is beyond melee, so the Veteran "after a finisher" trigger would rarely fire:
  // use a window of soft / committed / lonely targets instead.
  ranged: true,
  rangedWindow: (s) => s.targetHelpless || s.targetRooted || s.targetCommitted || s.targetIsolated || s.tHpFrac <= 0.55,
  apex(s, out) {
    if (!gate(s)) return;
    const soft = s.targetHelpless || s.targetRooted || s.targetCommitted || s.tGuardFrac <= 0.3 || s.tHpFrac <= 0.6;
    const duel = s.targetIsolated && s.enemiesNearSelf8 <= 1 && s.hpFrac > 0.4;
    out.ult = soft || duel;
  },
};
