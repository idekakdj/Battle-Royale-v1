/**
 * Ultimate registry + shared lifecycle (v1.3; replaces the per-animal switches that
 * used to live in abilities2.ts).
 *
 * TO ADD / REWORK AN ANIMAL'S ULTIMATE
 *   1. Edit `src/sim/ultimates/<animal>.ts` — export a `<animal>Ultimate: UltimateImpl`
 *      (see ./types.ts for the hook lifecycle).
 *   2. It is already registered below in {@link ULTIMATES}; nothing else to wire.
 *   3. Numbers + `targeting` live in `src/config/ultimates/<animal>.ts`.
 *   4. Bot logic lives in `src/ai/ultScripts/<animal>.ts`.
 *
 * `startUlt` resolves the spec's `targeting` (targeting.ts) BEFORE any state changes:
 * with `requireTarget` and no valid target it emits `ultimateFizzle` and returns
 * false (charge untouched, no cooldown, no runtime).
 */

import type { AnimalId } from '../../core/types';
import type { Fighter, Sim } from '../Fighter';
import { AbilityPhase } from '../Fighter';
import { LAND_RECOVER } from '../simTuning';
import { beginAbility, endAbility, toRecovery } from './common';
import { resolveUltTarget } from './targeting';
import type { UltimateImpl } from './types';
import { lionUltimate } from './lion';
import { gorillaUltimate } from './gorilla';
import { crocodileUltimate } from './crocodile';
import { hippoUltimate } from './hippo';
import { rhinoUltimate } from './rhino';
import { eagleUltimate } from './eagle';
import { pantherUltimate } from './panther';
import { pythonUltimate } from './python';
import { giraffeUltimate } from './giraffe';
import { moleUltimate } from './mole';

export type { UltimateImpl } from './types';

/** One implementation per animal. */
export const ULTIMATES: Record<AnimalId, UltimateImpl> = {
  lion: lionUltimate,
  gorilla: gorillaUltimate,
  crocodile: crocodileUltimate,
  hippo: hippoUltimate,
  rhino: rhinoUltimate,
  eagle: eagleUltimate,
  panther: pantherUltimate,
  python: pythonUltimate,
  giraffe: giraffeUltimate,
  mole: moleUltimate,
};

/**
 * Begin an ultimate (charge already validated by World). Returns false when the
 * cast fizzled (targeting `requireTarget` with no valid target): nothing was
 * spent or started and `ultimateFizzle` was emitted.
 */
export function startUlt(sim: Sim, f: Fighter): boolean {
  const spec = f.def.ultimate;
  const target = resolveUltTarget(sim, f, spec);
  if (spec.targeting !== undefined && spec.targeting.requireTarget === true && !target.valid) {
    sim.emit({ type: 'ultimateFizzle', fighterId: f.id, reason: 'noTarget' });
    return false;
  }
  const rt = beginAbility(f, 'ultimate', spec);
  f.state.ultCharge = 0;
  f.state.ultsUsed += 1;
  if (spec.targeting !== undefined && spec.targeting.kind === 'lock' && target.targetId >= 0) rt.lockId = target.targetId;
  ULTIMATES[f.def.id].start(sim, f, rt, target);
  return true;
}

/** Advance an active ultimate one tick (Windup → Active → Recovery). */
export function updateUlt(sim: Sim, f: Fighter, dt: number): void {
  const rt = f.ability;
  if (rt === null) return;
  const impl = ULTIMATES[f.def.id];
  f.movementOwned = true;
  f.state.actionT += dt;

  if (rt.phase === AbilityPhase.Windup) {
    if (impl.windupTick !== undefined) impl.windupTick(sim, f, rt, dt);
    rt.t += dt;
    const w = impl.windupDuration !== undefined ? impl.windupDuration(rt) : rt.spec.windup;
    if (rt.t >= w) {
      rt.phase = AbilityPhase.Active;
      rt.t = 0;
      impl.activate(sim, f, rt);
    }
    return;
  }

  if (rt.phase === AbilityPhase.Active) {
    if (impl.activeTick !== undefined) impl.activeTick(sim, f, rt, dt);
    else toRecovery(rt); // fail safe: nothing left to do
    return;
  }

  // Recovery.
  rt.t += dt;
  const rec = impl.recoveryDuration !== undefined ? impl.recoveryDuration(rt) : rt.didHit ? LAND_RECOVER : rt.spec.recovery ?? LAND_RECOVER;
  if (rt.t >= rec) endAbility(sim, f);
}

/**
 * The caster died mid-ultimate (called by World.kill before the runtime is
 * dropped). Lets the animal's module release holds it owns.
 */
export function abortUlt(sim: Sim, f: Fighter): void {
  const rt = f.ability;
  if (rt === null || rt.kind !== 'ultimate') return;
  const impl = ULTIMATES[f.def.id];
  if (impl.abort !== undefined) impl.abort(sim, f, rt);
}
