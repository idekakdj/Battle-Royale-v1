/**
 * Crocodile — Death Roll bot script (v1.3 lock-on rework).
 * A 7 m burst lunge that can be side-stepped before it fires, so bots pick their moment:
 * inside the lock reach, never at a target that is running away (the lunge would whiff),
 * and (Apex) on foes that cannot dodge or that a hold finishes off. The framework already
 * vetoes casts with no valid lock (`Situation.ultTargetValid`).
 */

import type { Situation } from '../scripts';
import type { UltScript } from './types';

// Lock range 7 m (bodies count), lunge overshoot 1 m: stay a little inside it.
const gate = (s: Situation): boolean => s.tdist <= 6.4;

export const crocodileUltScript: UltScript = {
  gate,
  apex(s, out) {
    if (!gate(s) || s.targetFleeing) return;
    const helpless = s.targetHelpless || s.targetRooted;
    // Holds ignore block (a turtling target is a Death Roll target); helpless / low / cornered foes cannot dodge the lunge.
    out.ult = helpless || s.tHpFrac <= 0.45 || s.targetBlocking || (s.targetIsolated && s.tdist <= 4.5 && s.tHpFrac <= 0.7);
  },
};
