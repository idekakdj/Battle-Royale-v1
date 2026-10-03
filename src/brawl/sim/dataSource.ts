/**
 * Where the simulation reads move / stage data from. `BrawlWorld` defaults to the real registry
 * (`src/brawl/data/index.ts`); tests inject small fixtures through the optional third constructor
 * argument so the simulation never depends on the shipped balance data.
 */

import type { AnimalId } from '../../core/types';
import type { MoveBody, MoveId, MovesetDef, StageDef, StageId } from '../types';
import { getMoveBody, getMoveset, getStage } from '../data/index';

export interface BrawlDataSource {
  getMoveset(animal: AnimalId): MovesetDef;
  /** Effective body: air partial applied; `chain > 0` = `chain[chain − 1]`. */
  getMoveBody(animal: AnimalId, moveId: MoveId, air: boolean, chain?: number): MoveBody;
  getStage(id: StageId): StageDef;
}

/** The shipped data registry. */
export const DEFAULT_DATA_SOURCE: BrawlDataSource = { getMoveset, getMoveBody, getStage };
