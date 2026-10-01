/**
 * Rhino — Seismic Stampede bot script (v1.3).
 *
 * The charge locks the best foe inside 16 m / 50 degrees of the aim and homes on it (12 m/s, outrunning everything
 * on the sand), gores it and carries it to the next wall / pillar for the crush. So the cast is worth it whenever a
 * foe is inside the lock range; Apex saves it for the moments the gore cannot be avoided or the crush is certain:
 * a target with a wall / pillar behind it (`wallBehindTarget`), a helpless / rooted / mid-cast / blocking foe, or a
 * cornered isolated one. (Bots aim at the target, so the lock cone is always satisfied.)
 */

import type { Situation } from '../scripts';
import type { UltScript } from './types';

// Lock range 16 m to the victim's body, minus a body radius; nothing to gain from a point-blank cast.
const gate = (s: Situation): boolean => s.tdist >= 2.5 && s.tdist <= 15;

export const rhinoUltScript: UltScript = {
  gate,
  // Everything else in the path is swept (60 + knockdown): groups pay off.
  cluster: (s) => gate(s) && s.enemiesNearSelf8 >= 2,
  apex(s, out) {
    const helpless = s.targetHelpless || s.targetRooted || s.targetCommitted;
    out.ult = gate(s) && (s.wallBehindTarget || helpless || (s.targetBlocking && s.tdist >= 5));
  },
};
