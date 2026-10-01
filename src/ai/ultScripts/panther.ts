/**
 * Panther — Shadow Execution bot script (v1.3 Phase 2). A single-target lock-on combo (11 m): five
 * shadow-step strikes (42 each = 210) then a finisher (90 + 100 execute when the victim is below 35% HP).
 * After the five strikes a victim who started at <= ~56% HP is under the execute line, so Apex waits for
 * wounded, helpless or isolated targets and never starts it on a healthy crowd fighter. Bots only cast
 * with a valid lock (the brain vetoes fizzles via `ultTargetValid`).
 */

import type { Situation } from '../scripts';
import type { UltScript } from './types';

/** Lock range is 11 m to the victim's body; keep slack for the bot's aim noise. */
const REACH = 10;
/** Victim HP fraction at/under which 5 × 42 leaves them under the 35% execute line. */
const EXECUTE_START = 0.56;

const gate = (s: Situation): boolean => s.hasTarget && s.tdist <= REACH;

export const pantherUltScript: UltScript = {
  gate,
  ranged: true,
  rangedWindow: (s) => s.tHpFrac <= 0.65 || s.targetHelpless || s.targetIsolated,
  apex(s, out) {
    if (!gate(s) || s.hpFrac <= 0.2) return;
    const execute = s.tHpFrac <= EXECUTE_START;
    const soft = s.targetHelpless || s.targetRooted || (s.targetFleeing && s.tHpFrac <= 0.75);
    const duel = s.targetIsolated && s.tHpFrac <= 0.8;
    out.ult = execute || soft || duel;
  },
};
