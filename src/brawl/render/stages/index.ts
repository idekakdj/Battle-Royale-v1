/** Stage visual factory: one procedural builder per `StageId`, built from the `StageDef` geometry. */

import type { StageDef } from '../../types';
import type { QualityTier } from '../../../render/quality';
import { buildBrokenColosseum } from './brokenColosseum';
import { buildSkyAqueduct } from './skyAqueduct';
import type { StageVisual } from './common';

export type { StageVisual, StageSetup } from './common';

export function buildStageVisual(def: StageDef, tier: QualityTier): StageVisual {
  switch (def.id) {
    case 'skyAqueduct':
      return buildSkyAqueduct(def, tier);
    case 'brokenColosseum':
    default:
      return buildBrokenColosseum(def, tier);
  }
}
