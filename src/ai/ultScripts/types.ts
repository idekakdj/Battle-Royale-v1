/**
 * Per-animal bot ultimate decision script (v1.3). One file per animal in
 * `src/ai/ultScripts/<animal>.ts`, registered in `./index.ts` (`ULT_SCRIPTS`);
 * `ai/scripts.ts` (`decideUltimate`) dispatches to them by profile mode:
 *   - L1 (`enemyWithinRange`) and L2 (`targetInUltRange`): `gate`
 *   - L3 (`afterFinisherOrCluster`): `gate`, `cluster`, `ranged` + `rangedWindow`
 *   - L4 (`optimalWindows`): `apex` (plus the shared patience fallback on `gate`)
 * Lock ultimates (v1.3) must only be cast with a valid target: use
 * `selectLockTarget` / `previewUltTarget` from `sim/ultimates/targeting` in `gate`.
 */

import type { AbilityWish, Situation } from '../scripts';

export interface UltScript {
  /** Effective-range gate: is the current target inside this ultimate's reach right now? */
  gate(s: Situation): boolean;
  /** AoE ults that pay off on clusters (Veteran trigger). Absent = never. */
  cluster?(s: Situation): boolean;
  /**
   * Ult whose effective range sits beyond melee, so the Veteran "after a
   * finisher" trigger could never fire — it uses `rangedWindow` instead.
   */
  ranged?: boolean;
  /** Veteran window for ranged ults (default: helpless / rooted / fleeing / isolated / low-hp target). */
  rangedWindow?(s: Situation): boolean;
  /** Apex decision: set `out.ult` (the caller already handled the 3+-enemy bad trade). */
  apex(s: Situation, out: AbilityWish): void;
}
