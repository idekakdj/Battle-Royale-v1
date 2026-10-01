/**
 * Mole — Sinkhole Vortex bot script (v1.3).
 *
 * The pit opens 1.3 s after the cast (dig + tremor crack) on the point the mole aimed at, so it pays
 * off against targets that stay put or cannot leave in time: staggered / rooted / mid-cast foes,
 * blockers, kiters that get cut off by a pit ahead of them, and clusters (several foes inside 4.5 m).
 */

import type { Situation } from '../scripts';
import type { UltScript } from './types';

// Zone centre snaps onto the aimed foe up to 10 m (+1 m slack); radius 4.5 covers a foe a little short of that.
const gate = (s: Situation): boolean => s.tdist >= 2.5 && s.tdist <= 12;

export const moleUltScript: UltScript = {
  gate,
  ranged: true,
  apex(s, out) {
    const helpless = s.targetHelpless || s.targetRooted || s.targetCommitted;
    // Kiters and blockers, helpless / committed targets, or a cluster around the target to catch in the pit.
    out.ult = gate(s) && (s.targetFleeing || helpless || s.targetBlocking || s.enemiesNearTarget8 >= 2);
  },
};
