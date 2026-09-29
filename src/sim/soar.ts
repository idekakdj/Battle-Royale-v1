/**
 * Eagle soar rules that need the combat pipeline (v1.2, BLUEPRINT §7.8):
 * the altitude action-lock and the landing slam. The flight itself (glide →
 * climb → controlled descent) lives in MovementSystem; World calls these.
 */

import type { Fighter, Sim } from './Fighter';
import { MOVE } from '../config/balance';
import { altitudeOf } from './hitbox';
import { hitArea } from './abilities2';

/**
 * True while an eagle is flying above its `attackLockHeight`: attack, block,
 * special and ultimate intents are ignored (it can still steer the flight).
 */
export function flightLocked(f: Fighter): boolean {
  const soar = f.def.perks.soar;
  return soar !== undefined && altitudeOf(f) > soar.attackLockHeight;
}

/** Landing-slam base damage for a flight that peaked at `peak` metres. */
export function landingDamage(f: Fighter, peak: number): number {
  const soar = f.def.perks.soar;
  if (soar === undefined) return 0;
  return Math.min(soar.landDamageCap, soar.landDamageBase + soar.landDamagePerMetre * peak);
}

/**
 * Resolve a slam-eligible touchdown: circle AoE on ground-level enemies
 * (blockable ability hit, small radial knockback, no flinch), a short landing
 * recovery on the eagle, and one `landingImpact` event.
 */
export function landingSlam(sim: Sim, f: Fighter, peak: number): void {
  const soar = f.def.perks.soar;
  if (soar === undefined || !f.state.alive) return;
  const dmg = landingDamage(f, peak);
  hitArea(sim, f, {
    shape: 'circle',
    cx: f.state.pos.x,
    cz: f.state.pos.z,
    cy: f.state.pos.y,
    yaw: f.state.yaw,
    range: soar.landRadius,
    arcDeg: 360,
    heightTol: MOVE.heightOverlap,
    base: dmg,
    opts: { blockable: true, heavy: true, reaction: 'none', isBasic: false },
    pushDist: soar.landKnockback,
  });
  f.landRecoverT = Math.max(f.landRecoverT, soar.landRecovery);
  f.blocking = false;
  f.swinging = false;
  f.state.vel.x = 0;
  f.state.vel.z = 0;
  sim.emit({
    type: 'landingImpact',
    fighterId: f.id,
    pos: { x: f.state.pos.x, y: f.state.pos.y, z: f.state.pos.z },
    radius: soar.landRadius,
    damage: Math.round(dmg),
    height: Math.round(peak * 100) / 100,
  });
}
