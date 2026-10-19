/**
 * One isolated sea-serpent dodge trial on the real Ocean Dome (v1.9 WP-O2; two lanes since v1.10 WP-H3); shared by
 * `scripts/serpent-dodge.ts` and `tests/ai/serpent.dodge.test.ts`.
 *
 * ONE fighter of the given animal stands at a random standable point INSIDE the telegraphed strip (uniform over its area, on the ground
 * of the serpent's own band), a serpent event of the given lane fires at an angle drawn the way the sim draws it (`pickLaneAngle`: the
 * LOW serpent only along lines clear of the upper platforms, the HIGH one only along lines over them), and the bot's
 * {@link SerpentSense} (the exact class BotBrain uses) steers it through the real World physics. Nothing else moves, nobody fights:
 * this isolates the reaction + the choice of the way out. For the HIGH lane the fighter starts on a tower top or the upper part of a
 * tower ramp; stepping off the rim costs the fall damage and is reported (`fell`).
 */
import { World } from '../src/sim/World';
import { EventBus } from '../src/core/EventBus';
import { BOT_PROFILES } from '../src/config/botProfiles';
import { OCEAN_ARENA, arenaGroundHeight, arenaSerpentBand, arenaStandable } from '../src/config/arenas';
import { pickLaneAngle } from '../src/config/serpentLanes';
import { SERPENT } from '../src/config/serpent';
import { mulberry32 } from '../src/core/math';
import { SerpentSense } from '../src/ai/SerpentSense';
import type { AnimalId, Difficulty, FighterIntent, MatchConfig, SerpentTier } from '../src/core/types';
import type { Move2 } from '../src/ai/Steering';
import { ANIMALS } from '../src/config/animals';

const DT = 1 / 60;

export interface TrialResult {
  /** Took the serpent's 300 damage. */
  hit: boolean;
  /** Seconds after the warning at which the bot first moved by its own intent (-1 = never). */
  reactedAt: number;
  /** Took fall damage (walked or dived off a platform). */
  fell: boolean;
  /** The bot chose the deliberate fall (SerpentSense.diving). */
  dived: boolean;
  /** Where it started: the band and ground height. */
  startY: number;
}

/** One isolated trial of `tier`'s serpent; exported for the unit test. */
export function trial(animal: AnimalId, level: Difficulty, seed: number, tier: SerpentTier = 'low'): TrialResult {
  const rng = mulberry32(seed);
  const radius = ANIMALS[animal].radius;
  const need = SERPENT.headRadius + radius;
  const angle = pickLaneAngle(OCEAN_ARENA, tier, rng);
  const a = (angle * Math.PI) / 180;
  const ux = Math.cos(a);
  const uz = Math.sin(a);
  // a random standable point inside the strip, in the band the serpent hurts
  let px = 0;
  let pz = 0;
  for (let k = 0; k < 3000; k++) {
    const s = 0.5 + rng() * 28;
    const l = (rng() * 2 - 1) * (need - 0.05);
    px = ux * s - uz * l;
    pz = uz * s + ux * l;
    if (arenaSerpentBand(OCEAN_ARENA, px, pz) === tier && arenaStandable(OCEAN_ARENA, px, pz, radius, true)) break;
  }
  const cfg: MatchConfig = {
    roster: [
      { animal, isPlayer: true },
      { animal: 'lion', isPlayer: true },
    ],
    difficulty: level,
    arena: 'ocean',
  };
  const bus = new EventBus();
  let hit = false;
  let fell = false;
  bus.on('serpentHit', (e) => {
    if (e.fighterId === 0) hit = true;
  });
  bus.on('fall', (e) => {
    if (e.fighterId === 0) fell = true;
  });
  const world = new World(cfg, seed, bus, { traps: false });
  for (let i = 0; i < 190; i++) world.step(DT);
  const f0 = world.fighters[0].state;
  f0.pos.x = px;
  f0.pos.z = pz;
  f0.pos.y = arenaGroundHeight(OCEAN_ARENA, px, pz); // feet on the ground of the chosen spot
  f0.vel.x = 0;
  f0.vel.z = 0;
  f0.airborne = false;
  world.fighters[0].lastGroundY = f0.pos.y;
  const startY = f0.pos.y;
  // park the dummy far from the line (opposite side of the dome, on the seabed)
  const f1 = world.fighters[1].state;
  const opp = a + Math.PI;
  const dx = Math.cos(opp + 1.2) * 26;
  const dz = Math.sin(opp + 1.2) * 26;
  f1.pos.x = dx;
  f1.pos.z = dz;
  f1.pos.y = arenaGroundHeight(OCEAN_ARENA, dx, dz);
  f1.vel.x = 0;
  f1.vel.z = 0;

  const sense = new SerpentSense(OCEAN_ARENA, animal, level);
  const profile = BOT_PROFILES[level];
  const move: Move2 = { x: 0, z: 0 };
  const idle: FighterIntent = { moveX: 0, moveZ: 0, aimYaw: 0, attack: false, block: false, special: false, ultimate: false, jump: false };
  world.debugTriggerSerpent(angle, tier);
  let reactedAt = -1;
  let tWarn = -1;
  let dived = false;
  for (let t = 0; t < 400 && !hit; t++) {
    const snap = world.snapshot();
    const lane = tier === 'high' ? snap.serpentHigh : snap.serpent;
    if (lane === undefined && t > 5) break;
    if (tWarn < 0 && lane !== undefined) tWarn = world.time - lane.t;
    const dodging = sense.update(world.time, snap.fighters[0], snap.serpent, profile.reactionMs, false, rng, move, snap.serpentHigh);
    let intent = idle;
    if (dodging) {
      intent = { ...idle, moveX: move.x, moveZ: move.z, aimYaw: Math.atan2(move.x, move.z) };
      if (reactedAt < 0) reactedAt = world.time - tWarn;
      if (sense.diving) dived = true;
    } else {
      // Veteran / Apex keep out of the strip; a standing bot has no heading to repel
      move.x = 0;
      move.z = 0;
    }
    world.setIntent(0, intent);
    world.setIntent(1, idle);
    world.step(DT);
  }
  return { hit, reactedAt, fell, dived, startY };
}
