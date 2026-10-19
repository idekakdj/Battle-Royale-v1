/**
 * Synthetic "two-height" dome for the v1.10 tests (docs/OCEAN-HEIGHTS-PLAN.md, WP-H2): a flat floor with ONE round 6.5 m platform,
 * a ramp up to it, and two lower shelves, with the Ocean Dome's hazard rules (`serpentSplitY 4.5`, fall damage 50 from 3.4 m).
 * It does NOT depend on the real Ocean Dome layout (WP-H1), so the lane / fall rules are tested in isolation; the World is given the
 * fixture through the `arena` option (`WorldOptions.arena`), the shipped registry is never touched.
 *
 *   floor     height 0
 *   platform  round, r 3.5, top 6.5 at (14, 0)             - cliffs all round except where the ramp / the shelf touch it
 *   ramp      x 12..16, z -22..-3, rises 0 -> 6.5 (grade 0.34) along +z, its top tucked 0.5 m under the platform edge
 *   shelf     round, r 3.2, top 3.0 at (14, 6)             - walking +z off the platform: a 3.5 m drop (damage)
 *   ledge     round, r 3.0, top 3.0 at (-14, 0)            - walking off it onto the floor: a 3.0 m drop (no damage)
 *
 * High ground (>= 4.5): the platform top and the upper part of the ramp (z > -8.85). Everything else is low ground.
 */

import { World, type WorldOptions } from '../../src/sim/World';
import { EventBus } from '../../src/core/EventBus';
import { arenaGroundHeight, type ArenaDef, type ElevationPiece } from '../../src/config/arenas';
import { FLAT_ARENA } from './serpentHelpers';
import type { AnimalId, FighterIntent, GameEvent, MatchConfig } from '../../src/core/types';

export const DT = 1 / 60;

export const SPLIT_Y = 4.5;
export const FALL_RULE = { minDrop: 3.4, damage: 50 } as const;
export const PLATFORM = { x: 14, z: 0, radius: 3.5, height: 6.5 } as const;
export const SHELF = { x: 14, z: 6, radius: 3.2, height: 3.0 } as const;
export const LEDGE = { x: -14, z: 0, radius: 3, height: 3.0 } as const;
export const RAMP = { x: 14, z: -12.5, dirDeg: 90, length: 19, width: 4, h0: 0, h1: 6.5 } as const;

export const HEIGHTS_FIELD: readonly ElevationPiece[] = [
  { kind: 'plateau', x: PLATFORM.x, z: PLATFORM.z, radius: PLATFORM.radius, height: PLATFORM.height },
  { kind: 'plateau', x: SHELF.x, z: SHELF.z, radius: SHELF.radius, height: SHELF.height },
  { kind: 'plateau', x: LEDGE.x, z: LEDGE.z, radius: LEDGE.radius, height: LEDGE.height },
  { kind: 'ramp', ...RAMP },
];

/** The fixture arena. Id 'ocean' (a label only: the World is handed this definition directly). */
export const HEIGHTS_ARENA: ArenaDef = {
  ...FLAT_ARENA,
  name: 'Heights test dome',
  heightfield: HEIGHTS_FIELD,
  hazards: { serpent: true, serpentSplitY: SPLIT_Y, fallDamage: { ...FALL_RULE } },
};

/** Variants of the fixture's hazards (a fresh object each time: the lane-bin cache is per arena object). */
export function heightsArena(hazards: ArenaDef['hazards']): ArenaDef {
  return { ...HEIGHTS_ARENA, hazards };
}

export function neutralIntent(): FighterIntent {
  return { moveX: 0, moveZ: 0, aimYaw: 0, attack: false, block: false, special: false, ultimate: false, jump: false };
}

export interface HeightsWorld {
  world: World;
  events: GameEvent[];
}

/** A live (past the countdown) World on `arena` (default {@link HEIGHTS_ARENA}), traps off. The events array collects every event. */
export function heightsWorld(
  animals: AnimalId[],
  seed = 11,
  opts: { arena?: ArenaDef; world?: WorldOptions } = {},
): HeightsWorld {
  const cfg: MatchConfig = { roster: animals.map((a, i) => ({ animal: a, isPlayer: i === 0 })), difficulty: 1, arena: 'ocean' };
  const bus = new EventBus();
  const events: GameEvent[] = [];
  bus.onAny((e) => events.push(e));
  const world = new World(cfg, seed, bus, { traps: false, arena: opts.arena ?? HEIGHTS_ARENA, ...(opts.world ?? {}) });
  for (let i = 0; i < 190; i++) world.step(DT); // 3 s countdown
  events.length = 0;
  return { world, events };
}

/** Teleport fighter `id` to stand on the ground at (x, z), at rest, then step once so the sim registers the new footing. */
export function standAt(world: World, id: number, x: number, z: number): void {
  const f = world.fighters[id];
  const s = f.state;
  s.pos.x = x;
  s.pos.z = z;
  s.pos.y = arenaGroundHeight(world.arena, x, z);
  s.vel.x = 0;
  s.vel.y = 0;
  s.vel.z = 0;
  s.airborne = false;
  f.lastGroundY = s.pos.y;
  f.fallArmed = false;
}

/** Park every fighter that is not in `keep` far from everything (on the floor, off all strike lines of the tests). */
export function parkOthers(world: World, keep: readonly number[]): void {
  let k = 0;
  for (const f of world.fighters) {
    if (keep.includes(f.id)) continue;
    standAt(world, f.id, -22 + (k % 3) * 1.5, 18 + Math.floor(k / 3) * 1.5);
    k++;
  }
}

export function stepN(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) world.step(DT);
}

export function ofType<T extends GameEvent['type']>(events: readonly GameEvent[], type: T): Extract<GameEvent, { type: T }>[] {
  return events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);
}

/** Steps until neither serpent lane has an event running (or `maxTicks`). */
export function runSerpentsToEnd(world: World, maxTicks = 400): number {
  let n = 0;
  while (world.serpent?.active === true && n < maxTicks) {
    world.step(DT);
    n++;
  }
  return n;
}
