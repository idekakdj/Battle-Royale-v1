/**
 * WP-B sim tuning constants that the blueprint states in prose (§7/§8) but that
 * have no home in `config/*`, plus a few values §8 leaves unstated (marked
 * DEVIATION). Everything else comes from `config/balance.ts` / `config/animals.ts`.
 */

/** §7.7: knockdown = `dur` down + this rise time appended (spec: 0.3 s). */
export const KNOCKDOWN_RISE = 0.3;

/** §7.8: eagle glide altitude (spec: y ≈ 1.6). */
export const GLIDE_HEIGHT = 1.6;

// DEVIATION: §8 gives dash/lunge DISTANCES but no speeds for croc Ambush Lunge,
// panther Shadow Dash, croc Death Roll lunge and python Embrace lunge. 14 m/s
// keeps them snappy (7 m in 0.5 s) without teleporting.
export const DASH_SPEED = 14;

// DEVIATION: §8 gives no airtime for lion Pounce / gorilla Silverback Leap.
export const LEAP_DURATION = 0.35;

// DEVIATION: §8 gives rhino Seismic Stampede duration/turn-rate but no speed;
// reuse the Lockdown Charge speed (12 m/s).
export const STAMPEDE_SPEED = 12;

// DEVIATION: FighterIntent carries only `aimYaw` (no aim distance), so aimed
// ground-point abilities (eagle Death From Above dive, mole Sinkhole, lion
// Pounce, gorilla Leap) place their point at `pos + dir(aimYaw) × min(spec.range,
// AIM_POINT_DIST)`. DFA uses its own dive reach below.
export const DFA_DIVE_RANGE = 8;

// DEVIATION: vertical launch speed for `knockup` effects (mole eruption).
export const KNOCKUP_VELOCITY = 6;

// DEVIATION: yaw turn rate while running (rad/s); §7.2 only caps attack turning.
export const RUN_TURN_RATE = 12;

// DEVIATION: gorilla parry-Shove has damage/knockback in config but no range or
// arc; use a short frontal shove.
export const SHOVE_RANGE = 2.5;
export const SHOVE_ARC_DEG = 150;

// DEVIATION: contact pad (m) added to radius sums for charge/dash collision
// tests (hippo River Rush, rhino charges, grab lunges).
export const CONTACT_PAD = 0.25;

// DEVIATION: brief landing/settle time after a leap or successful dive so the
// action state is readable; not specified in §8.
export const LAND_RECOVER = 0.3;

// DEVIATION: fighters push out of each other softly; this is the fraction of
// the overlap corrected per tick per fighter (§7.8 says "soft push-out").
export const FIGHTER_PUSH_FRACTION = 0.5;

// DEVIATION: |Δy| above which fighter↔fighter push-out is skipped (a gliding
// eagle at y=1.6 should pass over grounded fighters).
export const FIGHTER_PUSH_HEIGHT = 1.2;
