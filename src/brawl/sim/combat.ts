/**
 * Pure combat formulas (plan §2.2): damage, knockback, hitlag, hitstun, staling, DI.
 * No state; `BrawlWorld.resolveHit` composes these.
 */

import type { Facing, HitboxDef, MoveId } from '../types';
import { PHYS } from '../config';
import { clampNum } from './geometry';

/** −3 % per use of `id` among the attacker's last 6 connected moves, max −15 %. Returns the multiplier (0.85..1). */
export function staleMultiplier(queue: readonly MoveId[], id: MoveId): number {
  let n = 0;
  for (let i = 0; i < queue.length; i++) if (queue[i] === id) n++;
  const cut = n * PHYS.staleStep;
  return 1 - (cut > PHYS.staleMax ? PHYS.staleMax : cut);
}

export interface HitCalc {
  /** Final damage dealt (after sweetspot and staling). */
  dmg: number;
  /** Victim percent after the hit (clamped to the cap). */
  pctAfter: number;
  /** Knockback speed (m/s), capped. */
  kb: number;
  /** World launch angle in degrees (0 = +X, 90 = up), normalised to [0, 360). */
  angle: number;
  /** Launch velocity components (m/s). */
  vx: number;
  vy: number;
  hitlag: number;
  hitstun: number;
  tumble: boolean;
}

/**
 * Damage & knockback per plan §2.2:
 *   dmg      = hb.damage × sweet.damageMult? × staleMult
 *   pctAfter = victim.percent + dmg (≤ 999)
 *   kb       = (baseKb + kbGrowth × pctAfter / 100) × sweet.kbMult? × staleMult × (100 / weight), ≤ 62
 *   hitlag   = clamp(round(dmg × 0.4) + 4 + hb.hitlag, 4, 16)
 *   hitstun  = clamp(floor(kb × 0.6 × hb.hitstunScale), 6, 60)
 */
export function computeHit(
  hb: HitboxDef,
  sweet: boolean,
  stale: number,
  victimPercent: number,
  victimWeight: number,
  attackerFacing: Facing,
): HitCalc {
  const sw = sweet && hb.sweet ? hb.sweet : null;
  const dmg = hb.damage * (sw ? sw.damageMult : 1) * stale;
  const pctAfter = Math.min(PHYS.percentCap, victimPercent + dmg);
  const weight = victimWeight > 1 ? victimWeight : 1;
  let kb = (hb.baseKb + (hb.kbGrowth * pctAfter) / 100) * (sw ? sw.kbMult : 1) * stale * (100 / weight);
  if (!(kb > 0)) kb = 0;
  if (kb > PHYS.kbCap) kb = PHYS.kbCap;
  // angle: authored forward-relative, mirrored by the attacker's facing
  let deg = attackerFacing === 1 ? hb.angle : 180 - hb.angle;
  deg = ((deg % 360) + 360) % 360;
  const rad = (deg * Math.PI) / 180;
  const hitlag = clampNum(Math.round(dmg * PHYS.hitlagDmgFactor) + PHYS.hitlagBase + (hb.hitlag ?? 0), PHYS.hitlagMin, PHYS.hitlagMax);
  const scale = hb.hitstunScale ?? 1;
  const hitstun = clampNum(Math.floor(kb * PHYS.hitstunPerKb * scale), PHYS.hitstunMin, PHYS.hitstunMax);
  return {
    dmg,
    pctAfter,
    kb,
    angle: deg,
    vx: Math.cos(rad) * kb,
    vy: Math.sin(rad) * kb,
    hitlag,
    hitstun,
    tumble: kb > PHYS.tumbleKb,
  };
}

/**
 * Directional influence step: rotate the velocity (vx, vy) toward the held direction (dx, dy) by
 * up to `diStepDeg` per frame (scaled by the perpendicular component), keeping the TOTAL rotation
 * within ±`diMaxDeg` of the original launch (`used` = degrees already applied; returns the new total
 * and the rotated velocity). Holding along (or against) the launch rotates nothing.
 */
export function applyDI(vx: number, vy: number, dx: number, dy: number, used: number): { vx: number; vy: number; used: number } {
  const speed = Math.hypot(vx, vy);
  const len = Math.hypot(dx, dy);
  if (speed < 1e-6 || len < PHYS.diDeadzone) return { vx, vy, used };
  const ux = len > 1 ? dx / len : dx;
  const uy = len > 1 ? dy / len : dy;
  const cross = (vx * uy - vy * ux) / speed; // > 0: input is counter-clockwise of the velocity
  let next = used + PHYS.diStepDeg * cross;
  if (next > PHYS.diMaxDeg) next = PHYS.diMaxDeg;
  else if (next < -PHYS.diMaxDeg) next = -PHYS.diMaxDeg;
  const turn = ((next - used) * Math.PI) / 180;
  if (turn === 0) return { vx, vy, used: next };
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  return { vx: vx * c - vy * s, vy: vx * s + vy * c, used: next };
}
