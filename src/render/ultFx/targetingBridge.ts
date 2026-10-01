/**
 * Targeting bridge (v1.3 WP-T): the ONE place the render/HUD layer imports the
 * sim's pure targeting helper from (`src/sim/ultimates/targeting.ts`, WP-R0).
 *
 *   previewUltTarget(spec, attackerState, fighterStates, { aimYaw })
 *     → { kind, valid, targetId, from, to, range, width }
 *
 * `UltTargeting` is the config type (`AbilitySpec.targeting`).
 */

import type { AbilitySpec, UltTargeting } from '../../config/animals';

export { previewUltTarget } from '../../sim/ultimates/targeting';
export type { UltPreview as UltPreviewResult } from '../../sim/ultimates/targeting';
export type { UltTargeting };

/** The ultimate's targeting block, or `null` when it has none / is 'self' (no preview). */
export function ultTargetingOf(spec: AbilitySpec): UltTargeting | null {
  const t = spec.targeting;
  return t === undefined || t.kind === 'self' ? null : t;
}
