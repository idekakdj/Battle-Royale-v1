/**
 * Status effects & buffs (BLUEPRINT §7.7). Owns the runtime buff vocabulary
 * ({@link BuffState}) and translates ability {@link EffectSpec}s into buffs and
 * hard CC (fear/root/stun/stagger/knockback/knockup/knockdown/disarm/blind).
 *
 * Rule: same buff kind refreshes (no stack); different kinds stack. Hard CC is
 * respected unless the target is CC-immune (gorilla Rampage, rhino Stampede).
 */

import type { BuffState } from '../core/types';
import type { EffectSpec } from '../config/animals';
import type { Fighter } from './Fighter';
import type { Sim } from './Fighter';
import { dirToYaw } from '../core/math';
import { KNOCKUP_VELOCITY, KNOCKDOWN_RISE } from './simTuning';

type BuffKind = BuffState['kind'];

/** Find an active buff of `kind`, or undefined. */
export function getBuff(f: Fighter, kind: BuffKind): BuffState | undefined {
  const b = f.state.buffs;
  for (let i = 0; i < b.length; i++) if (b[i].kind === kind) return b[i];
  return undefined;
}

export function hasBuff(f: Fighter, kind: BuffKind): boolean {
  return getBuff(f, kind) !== undefined;
}

/** Add or refresh a buff (same kind refreshes: reset timer, take new mag/dur). */
export function addBuff(f: Fighter, kind: BuffKind, mag: number, dur: number): void {
  const existing = getBuff(f, kind);
  if (existing !== undefined) {
    existing.mag = mag;
    existing.dur = dur;
    existing.t = 0;
    return;
  }
  f.state.buffs.push({ kind, mag, dur, t: 0 });
}

export function removeBuff(f: Fighter, kind: BuffKind): void {
  const b = f.state.buffs;
  for (let i = b.length - 1; i >= 0; i--) if (b[i].kind === kind) b.splice(i, 1);
}

/** Product of movement multipliers from speed buffs and slow (§7.7). */
export function speedMult(f: Fighter): number {
  let m = 1;
  const speed = getBuff(f, 'speed');
  if (speed !== undefined) m *= 1 + speed.mag;
  const slow = getBuff(f, 'slow');
  if (slow !== undefined) m *= 1 - slow.mag;
  return m;
}

/** Attack-rate multiplier from atkSpeedUp buffs (gorilla Rampage). */
export function atkSpeedMult(f: Fighter): number {
  const b = getBuff(f, 'atkSpeedUp');
  return b !== undefined ? 1 + b.mag : 1;
}

/** Sum of dmgTakenUp buffs as a multiplier (lion-ult feared-vuln etc, §7.1). */
export function dmgTakenMult(f: Fighter): number {
  const b = getBuff(f, 'dmgTakenUp');
  return b !== undefined ? 1 + b.mag : 1;
}

/**
 * Apply one ability {@link EffectSpec} from `source` to `target`. Handles buffs
 * and hard CC. `dirX/dirZ` (optional) overrides the knockback/pushback direction
 * (used by directional cones); otherwise pushback is radial from the source.
 */
export function applyEffect(_sim: Sim, source: Fighter, target: Fighter, e: EffectSpec): void {
  switch (e.kind) {
    case 'slow':
      addBuff(target, 'slow', e.mag, e.dur);
      break;
    case 'bleed':
      // Total `mag` damage over `dur`, unblockable (§7.7). Store source for credit.
      addBuff(target, 'bleed', e.mag, e.dur);
      target.bleedSourceId = source.id;
      break;
    case 'speedUp':
      addBuff(target, 'speed', e.mag, e.dur);
      break;
    case 'dmgUp':
      addBuff(target, 'rage', e.mag, e.dur);
      break;
    case 'atkSpeedUp':
      addBuff(target, 'atkSpeedUp', e.mag, e.dur);
      break;
    case 'dmgTakenUp':
      addBuff(target, 'dmgTakenUp', e.mag, e.dur);
      break;
    case 'stealth':
      addBuff(target, 'stealth', e.mag, e.dur);
      break;
    case 'blind':
      addBuff(target, 'blind', e.mag, e.dur);
      break;
    case 'root':
      if (!target.ccImmune) target.rootTimer = Math.max(target.rootTimer, e.dur);
      break;
    case 'fear':
      if (!target.ccImmune) {
        target.fearTimer = Math.max(target.fearTimer, e.dur);
        target.fearSourceX = source.state.pos.x;
        target.fearSourceZ = source.state.pos.z;
        target.interrupt();
      }
      break;
    case 'disarm':
      if (!target.ccImmune) target.disarmTimer = Math.max(target.disarmTimer, e.dur);
      break;
    case 'stun':
    case 'stagger':
      if (!target.ccImmune) {
        target.staggerTimer = Math.max(target.staggerTimer, e.dur);
        target.interrupt();
      }
      break;
    case 'knockdown':
      if (!target.ccImmune) {
        // §7.7: `dur` down + a 0.3 s rise appended.
        target.knockdownTimer = Math.max(target.knockdownTimer, e.dur + KNOCKDOWN_RISE);
        target.interrupt();
      }
      break;
    case 'knockup':
      if (!target.ccImmune) {
        target.knockdownTimer = Math.max(target.knockdownTimer, e.dur + KNOCKDOWN_RISE);
        target.state.vel.y = KNOCKUP_VELOCITY;
        target.state.airborne = true;
        target.interrupt();
      }
      break;
    case 'knockback':
      applyKnockback(target, source.state.pos.x, source.state.pos.z, e.mag);
      break;
  }
}

/**
 * Push `target` `dist` metres away from (srcX,srcZ) as an impulse over
 * {@link MOVE.knockbackImpulseDur} (§7.8). MovementSystem integrates & stops it
 * against geometry. Skipped for CC-immune targets.
 */
export function applyKnockback(target: Fighter, srcX: number, srcZ: number, dist: number): void {
  if (target.ccImmune || dist <= 0) return;
  let dx = target.state.pos.x - srcX;
  let dz = target.state.pos.z - srcZ;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 1e-6) {
    // Degenerate: push along target's facing-away direction.
    dx = Math.sin(target.state.yaw);
    dz = Math.cos(target.state.yaw);
  } else {
    dx /= len;
    dz /= len;
  }
  target.setKnockback(dx, dz, dist);
}

/** Directional pushback (cones): push `dist` metres along (dirX,dirZ). */
export function applyDirectionalKnockback(target: Fighter, dirX: number, dirZ: number, dist: number): void {
  if (target.ccImmune || dist <= 0) return;
  const len = Math.sqrt(dirX * dirX + dirZ * dirZ);
  if (len < 1e-6) return;
  target.setKnockback(dirX / len, dirZ / len, dist);
}

/**
 * Per-tick buff bookkeeping: advance timers, apply bleed damage (unblockable),
 * expire finished buffs. Bleed damage is applied via the sim so kills are
 * credited and death handled uniformly.
 */
export function tickBuffs(sim: Sim, f: Fighter, dt: number): void {
  const b = f.state.buffs;
  for (let i = b.length - 1; i >= 0; i--) {
    const buff = b[i];
    if (buff.kind === 'bleed' && buff.dur > 0) {
      const dps = buff.mag / buff.dur;
      const src = f.bleedSourceId >= 0 ? sim.fighters[f.bleedSourceId] : f;
      sim.applyBleedDamage(src, f, dps * dt);
    }
    buff.t += dt;
    if (buff.t >= buff.dur) b.splice(i, 1);
  }
}

/** Facing-away yaw the feared fighter should run toward (§7.7). */
export function fearFleeYaw(f: Fighter): number {
  return dirToYaw(f.state.pos.x - f.fearSourceX, f.state.pos.z - f.fearSourceZ);
}
