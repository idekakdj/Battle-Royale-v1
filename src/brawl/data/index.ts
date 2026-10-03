/**
 * Champions League — data registry (plan §10 contract).
 *
 *   MOVESETS            Record<AnimalId, MovesetDef>
 *   getMoveset(animal)
 *   getMoveBody(animal, moveId, air, chain = 0)   → the effective MoveBody (air partial applied
 *                                                    over `ground`; chain > 0 picks chain[chain − 1])
 *   STAGES              Record<StageId, StageDef>
 *   getStage(id)
 *
 * Returned bodies are shared, cached objects: treat them as READ-ONLY.
 */

import type { AnimalId } from '../../core/types';
import type { MoveBody, MoveId, MovesetDef, StageDef, StageId } from '../types';
import { STAGE_DEFS } from './stages';
import { lion } from './animals/lion';
import { gorilla } from './animals/gorilla';
import { crocodile } from './animals/crocodile';
import { hippo } from './animals/hippo';
import { rhino } from './animals/rhino';
import { eagle } from './animals/eagle';
import { panther } from './animals/panther';
import { python } from './animals/python';
import { giraffe } from './animals/giraffe';
import { mole } from './animals/mole';

export const MOVESETS: Record<AnimalId, MovesetDef> = {
  lion,
  gorilla,
  crocodile,
  hippo,
  rhino,
  eagle,
  panther,
  python,
  giraffe,
  mole,
};

export const STAGES: Record<StageId, StageDef> = STAGE_DEFS;

export function getMoveset(animal: AnimalId): MovesetDef {
  return MOVESETS[animal];
}

export function getStage(id: StageId): StageDef {
  return STAGES[id];
}

const bodyCache = new Map<string, MoveBody>();

/**
 * Effective body of a move.
 *  - `chain > 0`: the follow-up body `chain[chain − 1]` (ground only; falls back to `ground` if the move has no such link).
 *  - `air`: `ground` with the move's `air` partial spread over it (identical to `ground` when `air` is null).
 */
export function getMoveBody(animal: AnimalId, moveId: MoveId, air: boolean, chain = 0): MoveBody {
  const key = `${animal}:${moveId}:${air ? 1 : 0}:${chain}`;
  const hit = bodyCache.get(key);
  if (hit) return hit;
  const data = MOVESETS[animal].moves[moveId];
  let out: MoveBody;
  if (chain > 0) {
    out = data.chain?.[chain - 1] ?? data.ground;
  } else if (air && data.air && !data.groundOnly) {
    out = { ...data.ground, ...data.air };
  } else {
    out = data.ground;
  }
  bodyCache.set(key, out);
  return out;
}

export * from './analysis';
export { movingOffset, platformAt } from './stages';
