/**
 * Gorilla — Boulder Hurl bot script (v1.3 thrown projectile).
 *
 * The boulder lands where the foe WAS (with a little lead) about a second after the cast starts, so it punishes
 * targets that cannot or will not sidestep it: helpless / rooted / mid-cast foes, crowds (60 splash on the
 * neighbours), turtling guards (it breaks them) and — the gorilla's only ranged tool — runners and kiters who
 * keep a straight heading. Point-blank the gorilla is better off hitting with its hands, so Apex starts a few
 * metres out (the flat L1/L2 gate from 2.5 m); everyone stops short of the 18 m reach (the foe keeps moving
 * while the noisy aim settles).
 * The lock-assist is optional, so the brain never has to check a target for validity.
 */

import type { Situation } from '../scripts';
import type { UltScript } from './types';

const gate = (s: Situation): boolean => s.tdist >= 2.5 && s.tdist <= 16.5;
/** Apex only throws when the foe is a few metres out (at arm's length the gorilla's hands are the better tool). */
const apexGate = (s: Situation): boolean => gate(s) && s.tdist >= 3.5;

export const gorillaUltScript: UltScript = {
  gate,
  // Effective range sits beyond melee: the Veteran "after finisher" trigger can never fire.
  ranged: true,
  cluster: (s) => gate(s) && s.enemiesNearTarget8 >= 2,
  rangedWindow(s) {
    return s.targetFleeing || s.targetHelpless || s.targetRooted || s.targetCommitted || s.enemiesNearTarget8 >= 2 || (s.targetBlocking && s.tGuardFrac < 0.5);
  },
  apex(s, out) {
    const soft = s.targetHelpless || s.targetRooted || s.targetCommitted;
    const crowd = s.enemiesNearTarget8 >= 2;
    const cracking = s.targetBlocking && s.tGuardFrac < 0.5;
    out.ult = apexGate(s) && (soft || crowd || cracking || s.targetFleeing);
  },
};
