/**
 * Sea-serpent event (v1.9, Ocean Dome; binding plan docs/OCEAN-PLAN.md). Every serpent number lives here;
 * `sim/SerpentSystem.ts` reads it, the AI / HUD / renderer read the same table (warning time, strip width, speeds).
 *
 * The event, in live match time (the 3-2-1 countdown does not count): every {@link SERPENT.intervalS} seconds
 * (t = 20, 40, 60 …) the world rolls its OWN seeded stream (match seed XOR {@link SERPENT.seedSalt}; the sim RNG is
 * never touched); with probability {@link SERPENT.chance} the serpent attacks from a random point of the dome edge.
 * Timeline (seconds): WARN {@link SERPENT.warnS} -> STRIKE {@link SERPENT.strikeS} -> HOLD {@link SERPENT.holdS} ->
 * RETREAT {@link SERPENT.retreatS}. Only STRIKE hurts: the head travels from the dome wall (r = wallRadius) to the centre
 * at wallRadius / strikeS m/s along the strike line; every alive, targetable, non-burrowed fighter whose body circle
 * overlaps the head's swept capsule (radius {@link SERPENT.headRadius}) while its altitude above the LOCAL ground is
 * <= {@link SERPENT.hazardHeight} takes {@link SERPENT.damage} TRUE damage ONCE per event. True damage = blocking,
 * guard, armour, buffs and the Crowd's Bloodlust never change it, it never drains guard, never flinches / knocks down,
 * grants nobody ult charge (not even the victim's damage-taken comeback lever) and credits nobody for damage dealt;
 * a death from it is `killerId -1` with `cause: 'serpent'` (the same rule as traps). Soaring eagles and anyone more
 * than `hazardHeight` above the ground are untouched; the body trailing behind the head does not hurt.
 *
 * TUNING TARGET ("fast enough to be difficult to dodge but not impossible"; measured by tests/sim/serpent.dodge.test.ts,
 * final table in docs/OCEAN-PLAN.md "Serpent tuning"; the plan's numbers 1.3 s / 0.55 s / 1.6 m were retuned within +-20 %
 * to meet it — the plan's own values let even the slowest animal start 0.77 s late and still escape):
 *   - a fighter that starts moving off the line the instant the warning begins ALWAYS escapes, even the slowest animal;
 *   - the slowest animal (rhino) still escapes when it starts within ~0.5 s of the warning, wherever it stands (0.52 s at
 *     the rim, 0.60 / 0.72 / 0.83 s at 20 / 12 / 4 m from the centre);
 *   - a fighter reacting after ~0.7 s escapes only if it is fast / lucky (at the rim: 3 of 10 animals; nearer the centre
 *     more time remains, the head still has to cross the dome);
 *   - nobody who starts moving later than ~1.1 s after the warning can escape from the middle of the strip (latest
 *     escaping start of the fastest animal: 0.75 s at the rim, 1.07 s at the centre);
 *   - a stationary fighter on the line is ALWAYS hit;
 *   - bot dodge rates by level (O2 implements, the balance sweep measures): Apex >= 90 %, Veteran >= 75 %,
 *     Fighter >= 50 %, Cub ~ 25-40 %.
 * v1.9.1 retune (user request): the first release rolled 10 % once a minute ("a match rarely sees it"); it now rolls 50 % every
 * 20 s of live match time, i.e. ~1.5 events per minute and ~2 per average match. The event itself (timeline, strip, damage,
 * dodge budget) is unchanged; only how often it comes.
 */

/** Strike-line half-width (m): the telegraphed strip and the head capsule's radius. */
const STRIP_HALF_WIDTH = 1.8;

export const SERPENT = {
  /** Seconds of live match time between two rolls (t = intervalS, 2 x intervalS, …). */
  intervalS: 20,
  /** Probability that a roll starts an event. */
  chance: 0.5,
  /** WARN: the strip is telegraphed, the serpent coils outside the dome (s). Plan 1.3, tuned to 1.1 (-15 %; see "Serpent tuning"). */
  warnS: 1.1,
  /** STRIKE: the head sweeps wall -> centre (s); speed = wallRadius / strikeS (30 m / 0.44 s = 68 m/s on the Ocean Dome). Plan 0.55, tuned -20 %. */
  strikeS: 0.44,
  /** HOLD: the head rests at the centre (s); harmless. */
  holdS: 0.35,
  /** RETREAT: the head withdraws centre -> wall (s); harmless. */
  retreatS: 0.8,
  /** Half-width of the strike strip (m); a fighter is hit when its centre is within `stripHalfWidth + bodyRadius` of the head's path. Plan 1.6, tuned +12.5 %. */
  stripHalfWidth: STRIP_HALF_WIDTH,
  /** Radius of the head capsule swept along the strike line (m) — equal to the strip half-width, so the telegraph IS the hitbox. */
  headRadius: STRIP_HALF_WIDTH,
  /** True damage dealt to each fighter the strip catches (once per event). */
  damage: 300,
  /** Altitude (m) ABOVE THE LOCAL GROUND up to which the strike reaches; higher fighters (soaring eagle) are untouched. */
  hazardHeight: 3.0,
  /** XOR'd into the match seed so the serpent's RNG never perturbs the sim RNG (determinism). */
  seedSalt: 0x5ea5e47e,
} as const;

/** Head speed during the strike (m/s) on an arena whose wall is `wallRadius` m away. */
export function serpentStrikeSpeed(wallRadius: number): number {
  return wallRadius / SERPENT.strikeS;
}

/** Total duration of one event (warn + strike + hold + retreat), seconds. */
export const SERPENT_EVENT_S = SERPENT.warnS + SERPENT.strikeS + SERPENT.holdS + SERPENT.retreatS;
