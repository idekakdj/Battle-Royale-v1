/**
 * The per-animal ultimate interface (v1.3). One implementation per animal lives in
 * `src/sim/ultimates/<animal>.ts` and is registered in `./index.ts` (`ULTIMATES`).
 * `startUlt`/`updateUlt` (index.ts) own the shared Windup → Active → Recovery
 * lifecycle and dispatch to these hooks; an implementation only supplies what is
 * unique to its animal.
 *
 * Lifecycle (driven by `updateUlt`, once per tick while `fighter.ability` is this ult):
 *   start()            once, at cast: charge already spent, runtime allocated, yaw snapped
 *                      to the aim, `rt.lockId` set when targeting locked a victim.
 *                      MUST call `emitCastEvents` (telegraph + `ultimate` event) and
 *                      `emitUltimateTarget`.
 *   Windup             windupTick() each tick, until `rt.t >= windupDuration(rt)`
 *                      (default `spec.windup`)
 *   activate()         once, when the windup completes. Either finish (`endAbility`), go
 *                      straight to recovery (`toRecovery`), or stay Active.
 *   Active             activeTick() each tick; when absent the ult drops to recovery.
 *                      Call `toRecovery(rt)` (or `endAbility`) when done.
 *   Recovery           until `recoveryDuration(rt)` (default: `didHit ? LAND_RECOVER :
 *                      spec.recovery ?? LAND_RECOVER`), then `endAbility`.
 *   abort()            optional; called if the caster dies mid-ultimate (World.kill), before
 *                      the runtime is dropped: release grabs/holds, clear flags.
 *
 * Rules for implementations (plan §3): all damage through `dealDamage`; respect
 * `isGroundTargetable`/`withinGroundReach`; set `f.ccImmuneChannel` while
 * uninterruptible and clear it on exit; use `blink()` for teleports and
 * `emitUltimateStage()` for each discrete beat; never leave `untargetable`,
 * `incomingDamageReduction`, grabs or `movementOwned` dirty (endAbility resets the
 * caster-side flags).
 */

import type { Fighter, Sim, AbilityRuntime } from '../Fighter';
import type { UltPreview } from './targeting';

export interface UltimateImpl {
  /** Cast start. `target` is the resolved targeting (self-kind preview when the spec has none). */
  start(sim: Sim, f: Fighter, rt: AbilityRuntime, target: UltPreview): void;
  /** Runs every Windup tick BEFORE `rt.t` advances. */
  windupTick?(sim: Sim, f: Fighter, rt: AbilityRuntime, dt: number): void;
  /** Seconds of windup (default `rt.spec.windup`). */
  windupDuration?(rt: AbilityRuntime): number;
  /** Windup finished; the runtime is now Active with `rt.t = 0`. */
  activate(sim: Sim, f: Fighter, rt: AbilityRuntime): void;
  /** Every Active tick. Absent → straight to recovery. */
  activeTick?(sim: Sim, f: Fighter, rt: AbilityRuntime, dt: number): void;
  /** Seconds of recovery (default `didHit ? LAND_RECOVER : spec.recovery ?? LAND_RECOVER`). */
  recoveryDuration?(rt: AbilityRuntime): number;
  /** Caster died mid-ultimate. */
  abort?(sim: Sim, f: Fighter, rt: AbilityRuntime): void;
}
