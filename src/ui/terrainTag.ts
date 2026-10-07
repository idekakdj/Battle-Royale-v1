/**
 * HUD terrain tag (v1.8 jungle): the small "Swimming · 62 % speed" / "Mossy ground · 65 % speed" chip above the local player's
 * vitals. Pure model (no DOM): the controller feeds the local fighter's snapshot flags (`inWater` / `onMoss`, computed once per
 * tick by the sim's TerrainSystem) and shows the returned text, or hides the chip when it is `null`.
 *
 * The percentage is the fraction of ORDINARY run speed the terrain leaves the fighter with: the animal's own water multiplier
 * (`waterSpeedMultiplier`, per-animal `swim` attribute) in the pool, `MOSS_SPEED_MULT` (1 − 35 %) on moss. The colosseum never
 * shows a tag (it has no terrain), whatever the flags say.
 */

import type { AnimalId, ArenaId, FighterState } from '../core/types';
import { MOSS_SPEED_MULT, waterSpeedMultiplier } from '../config/terrain';

/** `62` for a 0.62 multiplier (rounded, clamped to 0..100). */
export function speedPercent(mult: number): number {
  const p = Math.round(mult * 100);
  return p < 0 ? 0 : p > 100 ? 100 : p;
}

/** "Swimming · NN % speed" for `animal` wading in the pool. */
export function swimTagText(animal: AnimalId): string {
  return `Swimming · ${speedPercent(waterSpeedMultiplier(animal))} % speed`;
}

/** "Mossy ground · NN % speed". */
export function mossTagText(): string {
  return `Mossy ground · ${speedPercent(MOSS_SPEED_MULT)} % speed`;
}

/**
 * The tag text for the local player's current state, or `null` (hidden): not on a terrain arena, dead, or standing on plain
 * ground. Water wins over moss (the zones never overlap, but a fighter lingering off a patch can step straight into the pool).
 */
export function terrainTagText(
  fighter: Pick<FighterState, 'animal' | 'alive' | 'inWater' | 'onMoss'> | undefined,
  arena: ArenaId | undefined,
): string | null {
  if (fighter === undefined || !fighter.alive) return null;
  if (arena === undefined || arena === 'colosseum') return null;
  if (fighter.inWater === true) return swimTagText(fighter.animal);
  if (fighter.onMoss === true) return mossTagText();
  return null;
}
