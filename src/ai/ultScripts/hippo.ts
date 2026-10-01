/**
 * Hippo — Riverlord's Flood bot script (v1.3).
 *
 * The flood is an 11 m x 3.4 m line along the aim that lands 0.9 s after the cast (the path is marked, so a free,
 * mobile foe just walks out of it) and then leaves a slowing mud pool. It pays off against foes that cannot or
 * will not leave the path: helpless / rooted / mid-cast foes, blockers (they stand their ground), and targets with
 * another fighter close by (the wave rakes everyone along the line, and the shove + mud split groups apart).
 */

import type { Situation } from '../scripts';
import type { UltScript } from './types';

// The path is 11 m long from the hippo's centre; the target's body reaches a little past that.
const gate = (s: Situation): boolean => s.tdist <= 10;

export const hippoUltScript: UltScript = {
  gate,
  cluster: (s) => gate(s) && (s.enemiesNearSelf8 >= 2 || s.enemiesNearTarget8 >= 1),
  apex(s, out) {
    const stuck = s.targetHelpless || s.targetRooted || s.targetCommitted || s.targetBlocking;
    out.ult = gate(s) && (stuck || s.enemiesNearTarget8 >= 1);
  },
};
