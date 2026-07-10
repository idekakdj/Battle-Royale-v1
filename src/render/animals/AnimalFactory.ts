/**
 * AnimalFactory (BLUEPRINT §5.1): the one entry point the match renderer uses
 * to obtain a visual body for a fighter. `create` returns the binding
 * {@link AnimalRig} contract; `createRig` returns the concrete {@link BaseRig}
 * (adds `dispose()`) for owners that manage rig lifetimes (preview, demo).
 */

import type { AnimalId } from '../../core/types';
import type { AnimalRig, BaseRig } from './Animator';
import { LionRig } from './Lion';
import { GorillaRig } from './Gorilla';
import { CrocodileRig } from './Crocodile';
import { HippoRig } from './Hippo';
import { RhinoRig } from './Rhino';
import { EagleRig } from './Eagle';
import { PantherRig } from './Panther';
import { PythonRig } from './Python';
import { GiraffeRig } from './Giraffe';
import { MoleRig } from './Mole';

export type { AnimalRig } from './Animator';

export class AnimalFactory {
  /** Build a fresh articulated rig for `animal` (BLUEPRINT §5.1 contract). */
  static create(animal: AnimalId): AnimalRig {
    return AnimalFactory.createRig(animal);
  }

  /** Same as {@link create} but typed as the concrete rig (with `dispose`). */
  static createRig(animal: AnimalId): BaseRig {
    switch (animal) {
      case 'lion':
        return new LionRig();
      case 'gorilla':
        return new GorillaRig();
      case 'crocodile':
        return new CrocodileRig();
      case 'hippo':
        return new HippoRig();
      case 'rhino':
        return new RhinoRig();
      case 'eagle':
        return new EagleRig();
      case 'panther':
        return new PantherRig();
      case 'python':
        return new PythonRig();
      case 'giraffe':
        return new GiraffeRig();
      case 'mole':
        return new MoleRig();
    }
  }
}
