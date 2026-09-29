/**
 * Arena traps (v1.2, UPGRADE-PLAN-v1.2 §3.2). Every trap number lives here;
 * `sim/TrapSystem.ts` reads it, the AI reads the same table for hazard radii.
 *
 * A trap is a pressure plate on the sand. A GROUNDED fighter stepping onto an
 * armed plate triggers it; the hazard then stays up for exactly
 * {@link TRAP_ACTIVE_SECONDS} and hurts everyone standing inside — including
 * the fighter who triggered it. Damage is TRUE damage: blocking, guard, armour
 * and the Crowd's Bloodlust never change it, it never drains guard, never
 * flinches, never grants ult charge to anyone (not even the victim's
 * damage-taken comeback lever) and a trap kill credits nobody (killerId −1).
 *
 * Tuning target (BALANCE.md "Traps"): traps are flavour — ≤ ~6% of all damage,
 * ≤ ~3% of deaths, and no animal's average placement moves by more than ~0.5
 * versus a no-trap run.
 */

import type { Difficulty, TrapKind } from '../core/types';

/** Traps placed at match start, by difficulty (1 Cub … 4 Apex). */
export const TRAP_COUNT_BY_DIFFICULTY: Readonly<Record<Difficulty, number>> = {
  1: 2,
  2: 3,
  3: 5,
  4: 7,
};

/** Seconds a triggered trap stays active (fixed by the design brief). */
export const TRAP_ACTIVE_SECONDS = 8;

/** Seconds a spent trap waits after expiring before it re-arms. */
export const TRAP_REARM_SECONDS = 20;

/** Per-kind hazard numbers. */
export interface TrapKindSpec {
  /** Trigger + damage radius (m); a fighter's CENTRE must be inside. */
  radius: number;
  /** Damage per pulse to each fighter inside (true damage). */
  pulseDamage: number;
  /**
   * Seconds between pulses for one victim. A victim's first pulse lands the
   * tick it is first inside an active trap (so the triggerer is hurt at once);
   * the per-victim timer keeps running while they step out, so dancing in and
   * out of the hazard neither dodges nor doubles a pulse.
   */
  pulseInterval: number;
  /**
   * Altitude (m above the ground) up to which the hazard reaches. Fighters
   * higher than this (mid-jump, gliding, soaring) are unaffected.
   */
  hazardHeight: number;
}

export const TRAP_KINDS: Readonly<Record<TrapKind, TrapKindSpec>> = {
  /** Fire pit: erupts into flame — a steady 14/s burn (7 every 0.5 s; 112 if you stand in it for all 8 s). */
  fire: { radius: 2.0, pulseDamage: 7, pulseInterval: 0.5, hazardHeight: 1.0 },
  /** Spikes: blades spring from the plate — 25 per stab, one stab per 0.8 s (10 stabs = 250 over 8 s). */
  spikes: { radius: 1.8, pulseDamage: 25, pulseInterval: 0.8, hazardHeight: 0.6 },
};

/** Largest trap radius — placement clearances use it so either kind fits. */
export const TRAP_MAX_RADIUS = Math.max(TRAP_KINDS.fire.radius, TRAP_KINDS.spikes.radius);

/**
 * Seeded placement rules. Clearances are EDGE gaps: from the trap disc's edge
 * (radius {@link TRAP_MAX_RADIUS}) to the obstacle surface / pad edge / spawn
 * point / other trap disc edge.
 */
export const TRAP_PLACEMENT = {
  /** Trap centres lie in this ring around the arena centre (m). */
  minRadius: 6,
  maxRadius: 25,
  /** Gap to pillars, fallen columns, crates and the central dais (m). */
  obstacleClear: 1.5,
  /** Gap to pickup-pad trigger circles (m). */
  pickupClear: 2.5,
  /** Gap to fighter spawn points (m). */
  spawnClear: 3.5,
  /** Gap between two traps' discs (m). */
  trapClear: 6,
  /** Candidate positions tried before giving up (placing fewer). */
  maxAttempts: 600,
  /** XOR'd into the match seed so trap RNG never perturbs the sim RNG. */
  seedSalt: 0x7a3c5e11,
} as const;
