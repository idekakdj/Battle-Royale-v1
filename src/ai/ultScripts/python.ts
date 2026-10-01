/**
 * Python — Coil Snare bot script (v1.3 lock-on rework).
 * A 9 m tether (a fast moving line, not a lunge): it reels in a runner as well as a
 * stationary foe, but a foe strafing across the line escapes it. Veteran uses it on
 * helpless / fleeing / isolated / low-HP targets (`ranged`), Apex adds committed
 * specials and blockers. The framework already vetoes casts with no valid lock
 * (`Situation.ultTargetValid`).
 */

import type { Situation } from '../scripts';
import type { UltScript } from './types';

// Lock range 9 m (bodies count); tether length adds 1.2 m of slack: stay a little inside it.
const gate = (s: Situation): boolean => s.tdist <= 8.4;

export const pythonUltScript: UltScript = {
  gate,
  ranged: true,
  apex(s, out) {
    if (!gate(s)) return;
    const helpless = s.targetHelpless || s.targetRooted;
    // Fleeing targets fly straight down the tether line; committed specials and blockers cannot side-step it.
    out.ult = helpless || s.targetFleeing || s.targetCommitted || s.tHpFrac <= 0.4 || s.targetBlocking;
  },
};
