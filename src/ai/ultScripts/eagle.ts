/**
 * Eagle — Death From Above bot script (v1.3 locked-on stoop).
 *
 * The stoop commits ~2.7 s after the cast and only lands on a body still inside the committed circle
 * 1.4 s later, so it punishes targets that cannot (or will not) walk out of it: helpless / rooted /
 * mid-cast / blocking-and-isolated / nearly-dead foes. Kiters are the worst target (they simply keep
 * running). The lock itself (16 m, 90° cone) is validated by the brain (`ultTargetValid`), so the gate
 * only decides whether the situation is worth the cast.
 */

import type { Situation } from '../scripts';
import type { UltScript } from './types';

// Lock range is 16 m; stay a little inside it (the victim keeps moving while the noisy aim settles).
const gate = (s: Situation): boolean => s.tdist >= 3.5 && s.tdist <= 14.5;

export const eagleUltScript: UltScript = {
  gate,
  // Effective range sits beyond melee: the Veteran "after finisher" trigger can never fire.
  ranged: true,
  rangedWindow(s) {
    if (s.targetFleeing) return false; // a runner walks out of the circle
    return s.targetHelpless || s.targetRooted || s.targetCommitted || s.targetIsolated || s.tHpFrac <= 0.45;
  },
  apex(s, out) {
    const helpless = s.targetHelpless || s.targetRooted || s.targetCommitted;
    // Isolated (nobody to steal the attention) and either hurt or standing behind their guard; never at a runner.
    const sitting = s.targetBlocking && s.targetIsolated;
    out.ult = gate(s) && !s.targetFleeing && (helpless || sitting || (s.targetIsolated && s.tHpFrac <= 0.6));
  },
};
