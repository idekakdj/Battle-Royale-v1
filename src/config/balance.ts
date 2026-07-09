/**
 * Global gameplay tunables (BLUEPRINT §6 / §7). Every magic number the combat,
 * movement, status, pickup, and match systems need lives here — systems must
 * read these, never hard-code (BLUEPRINT §2, §15).
 *
 * All values are `as const` so consumers get literal, read-only types.
 */

/** Fixed simulation timestep (seconds), mirrored from GameLoop for sim use. */
export const SIM_DT = 1 / 60;

// ── Ultimate & charge (§7.2, §7.6) ───────────────────────────────────────────
export const ULT = {
  /** Charge required to cast an ultimate; casting consumes all of it. */
  cost: 100,
  /** Charge cap; charge persists until the ult is cast. */
  max: 100,
  /** Charge gained on a landed hit1. */
  gainHit1: 8,
  /** Charge gained on a landed hit2. */
  gainHit2: 8,
  /** Charge gained on a landed finisher (hit3). */
  gainFinisher: 14,
  /** Multiplier applied to charge gain when the hit was blocked (halved). */
  blockedGainMult: 0.5,
} as const;

// ── Basic-attack combo (§7.2, §7.3) ──────────────────────────────────────────
export const COMBO = {
  /** Combo resets after this long without a swing (seconds). */
  resetTime: 1.2,
  /**
   * A queued next-step is accepted if attack is pressed during the last
   * `chainWindowFraction` of the current swing …
   */
  chainWindowFraction: 0.4,
  /** … or within this many seconds after the swing ends. */
  chainWindowAfter: 0.5,
  /** Fraction through a swing at which the hit is applied (single tick). */
  impactFraction: 0.55,
  /** Max yaw turn rate while swinging (radians/sec ≈ 240°/s). */
  attackTurnRateRad: (240 * Math.PI) / 180,
} as const;

// ── Block & guard (§7.4) ─────────────────────────────────────────────────────
export const GUARD = {
  /** Frontal block arc, full angle in degrees. */
  blockArcDeg: 150,
  /** Guard drained = incoming `final` damage × this factor. */
  drainFactor: 0.45,
  /** Guard regenerated per second once regen is active. */
  regenPerSec: 15,
  /** Seconds without blocking a hit before guard regen begins. */
  regenDelay: 1.0,
  /** Stagger duration on a guard break (seconds). */
  breakStagger: 1.5,
  /** Extra damage-taken multiplier while under guard-break vulnerability. */
  breakVulnMult: 1.25,
  /** Fraction of max guard refilled after a guard-break stagger ends. */
  breakRefill: 0.5,
} as const;

// ── Hit reactions (§7.3) ─────────────────────────────────────────────────────
export const REACT = {
  /** `hit` flinch duration from hit1/hit2 (only vs idle/run/jump victims). */
  flinch: 0.15,
  /** `stagger` duration caused by finishers and specials. */
  finisherStagger: 0.4,
} as const;

// ── Damage pipeline multipliers (§7.1) ───────────────────────────────────────
export const DAMAGE = {
  /** Attacker damage multiplier while the `rage` buff is active. */
  rageMult: 1.25,
  /** Panther backstab multiplier (attacker within 75° rear arc of target). */
  backstabMult: 1.25,
  /** Rear arc (full angle, degrees) that counts as "behind" for backstab. */
  backstabArcDeg: 75,
  /** Target vulnerability multiplier while staggered. */
  staggeredVulnMult: 1.25,
  /** Target vulnerability multiplier while feared-vulnerable (lion ult). */
  fearedVulnMult: 1.2,
  /** Damage taken multiplier while the `armorUp` buff is active. */
  armorUpMult: 0.7,
} as const;

// ── Movement & collision (§7.8) ──────────────────────────────────────────────
export const MOVE = {
  /** Ground acceleration (m/s²). */
  accel: 40,
  /** Ground deceleration (m/s²). */
  decel: 30,
  /** Gravity (m/s²). */
  gravity: 20,
  /** Jump launch velocity (m/s); apex ≈ 1.2 m with g = 20. */
  jumpVelocity: 7,
  /** Move-speed multiplier while swinging a basic attack. */
  attackMoveMult: 0.4,
  /** Move-speed multiplier while blocking (eagle overrides to 1.2, §8). */
  blockMoveMult: 0.5,
  /** Duration over which a knockback impulse is applied (seconds). */
  knockbackImpulseDur: 0.15,
  /**
   * Vertical overlap tolerance for a melee hit to connect (|Δy| ≤ this).
   * Giraffe uses {@link MOVE.heightOverlapGiraffe} (§7.3).
   */
  heightOverlap: 2.2,
  /** Giraffe's taller vertical overlap tolerance for melee hits. */
  heightOverlapGiraffe: 3.2,
  /** Height (m) of low walls that a jump clears (fallen columns). */
  lowWallClearHeight: 0.9,
} as const;

// ── Arena geometry shared with match logic (§6, §9) ──────────────────────────
export const ARENA = {
  /** Circular sand floor / wall radius (m); fighters are clamped inside. */
  radius: 30,
  /** Ground plane height. */
  groundY: 0,
  /** Central dais top height (walkable step-up). */
  daisY: 0.6,
} as const;

// ── Match flow (§6) ──────────────────────────────────────────────────────────
export const MATCH = {
  /** Spawn ring radius (m); fighters spaced every 36°, facing center. */
  spawnRing: 24,
  /** Angular spacing between spawns (degrees). Player at index 0 (south). */
  spawnStepDeg: 36,
  /** Pre-fight countdown length (seconds), sim frozen. */
  countdown: 3,
} as const;

// ── Crowd's Bloodlust anti-stall ramp (§6) ───────────────────────────────────
export const BLOODLUST = {
  /** Multiplier before the ramp begins. */
  base: 1.0,
  /** Match time (seconds) at which the ramp starts (first ×1.25 step). */
  startTime: 120,
  /** Multiplier increment applied at start and every {@link stepInterval}. */
  step: 0.25,
  /** Seconds between ramp increments after the start. */
  stepInterval: 30,
  /** Maximum multiplier. */
  cap: 2.0,
} as const;

// ── Pickups (§9) ─────────────────────────────────────────────────────────────
export const PICKUPS = {
  /** Pickup pad trigger radius (m). */
  radius: 1.2,
  /** Seconds after a pickup is taken before it respawns. */
  respawn: 20,
  /** Spawn-kind selection weights; must sum to 1. */
  weights: { heal: 0.5, speed: 0.25, rage: 0.25 },
  /** Instant HP restored by a heal pickup. */
  healAmount: 250,
  /** Move-speed bonus fraction from a speed pickup. */
  speedBonus: 0.3,
  /** Speed buff duration (seconds). */
  speedDur: 8,
  /** Damage bonus fraction from a rage pickup. */
  rageBonus: 0.25,
  /** Rage buff duration (seconds). */
  rageDur: 8,
} as const;

/** Convenience flat re-exports for the most-used constants. */
export const FIXED_TIMESTEP = SIM_DT;
