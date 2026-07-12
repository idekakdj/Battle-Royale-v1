/**
 * Combat micro helpers (BLUEPRINT §10.3 executor half 2): aim noise, incoming
 * swing/telegraph block scheduling (incl. Apex perfect-block timing), and the
 * §7.3 impact-instant maths used to time defenses.
 */

import { gaussian, DEG2RAD, type Rng } from '../core/math';
import { COMBO } from '../config/balance';

/**
 * Gaussian aim-noise offset (radians) from the profile's `aimErrorDeg` σ.
 * Blind status triples the error (§7.7).
 */
export function sampleAimNoise(rng: Rng, sigmaDeg: number, blind: boolean): number {
  return gaussian(rng, sigmaDeg * (blind ? 3 : 1)) * DEG2RAD;
}

/** Seconds until a perceived swing's single damage tick (§7.3: 55% through). */
export function timeToImpact(actionT: number, actionDur: number): number {
  return actionDur * COMBO.impactFraction - actionT;
}

/**
 * One scheduled block window per bot. `schedule` is called when a threat is
 * perceived (after reaction delay) and the profile's blockOnTelegraph roll
 * succeeded; `perfect` delays the block start so it begins just before impact
 * (panther perfect-block counter window, gorilla parry-shove release reads).
 */
export class BlockControl {
  private from = Infinity;
  private until = -Infinity;
  /** World yaw toward the threat; the bot faces this while blocking. */
  yaw = 0;

  /** Schedule (or extend) a block covering an impact `tti` seconds away. */
  schedule(now: number, tti: number, yaw: number, perfect: boolean): void {
    const start = perfect ? now + Math.max(0, tti - 0.16) : now;
    if (now > this.until) {
      this.from = start;
      this.until = now + Math.max(tti, 0) + 0.2;
    } else {
      // Already in/awaiting a window — extend, keep the earlier start.
      this.from = Math.min(this.from, start);
      this.until = Math.max(this.until, now + Math.max(tti, 0) + 0.2);
    }
    this.yaw = yaw;
  }

  /** Ask the block to end early (gorilla parry-shove: release after a block). */
  releaseSoon(now: number): void {
    if (this.active(now)) this.until = Math.min(this.until, now + 0.1);
  }

  active(now: number): boolean {
    return now >= this.from && now <= this.until;
  }

  /** A window is scheduled but has not started yet (perfect-block delay). */
  pending(now: number): boolean {
    return now < this.from && this.until > now;
  }

  clear(): void {
    this.from = Infinity;
    this.until = -Infinity;
  }
}
