/**
 * Shared fixtures for the v1.9 sea-serpent tests (WP-O1b). The serpent's geometry only depends on the dome radius and the
 * ground-height helper, so the tests run on a FLAT, obstacle-free dome (the colosseum's constants minus pillars/crates/dais/pads)
 * that is independent of the Ocean Dome's layout (WP-O1a), which keeps them stable while the real arena evolves.
 */

import { World } from '../../src/sim/World';
import { EventBus } from '../../src/core/EventBus';
import { ARENAS, COLOSSEUM_ARENA, type ArenaDef } from '../../src/config/arenas';
import type { SerpentOptions } from '../../src/sim/SerpentSystem';
import type { Fighter, Sim } from '../../src/sim/Fighter';
import type { AnimalId, FighterIntent, GameEvent, MatchConfig } from '../../src/core/types';
import { makeFighter } from './helpers';

export const DT = 1 / 60;
export const R = 30;

/** A flat 30 m dome with the serpent hazard: no solids, no pads, no dais. */
export const FLAT_ARENA: ArenaDef = {
  ...COLOSSEUM_ARENA,
  id: 'ocean',
  name: 'Flat test dome',
  dais: undefined,
  solids: [],
  circles: [],
  segments: [],
  crates: [],
  pickupPads: [],
  hazards: { serpent: true },
};

/** FLAT_ARENA with a raised disc of `height` m at (x, 0) (stands in for an Ocean Dome level; read through `arenaGroundHeight`). */
export function arenaWithRaisedDisc(x: number, radius: number, height: number): ArenaDef {
  return { ...FLAT_ARENA, dais: { shape: 'circle', x, z: 0, radius, height, walkable: true, jumpable: false } as NonNullable<ArenaDef['dais']> };
}

/** Registers `arena` as the 'ocean' arena for the rest of this test file (vitest isolates module state per file). */
export function installOcean(arena: ArenaDef): void {
  (ARENAS as Record<string, ArenaDef>).ocean = arena;
}

/** True environmental damage as the World applies it (hp removed, kill credit erased). */
export function trueDeal(f: Fighter, amount: number): number {
  if (amount <= 0 || !f.state.alive) return 0;
  const applied = Math.min(amount, f.state.hp);
  f.state.hp -= applied;
  f.lastAttackerId = -1;
  return applied;
}

/** A bare Sim for SerpentSystem unit tests: `time` is driven by the test, events are captured. */
export function stubSim(fighters: Fighter[], arena: ArenaDef = FLAT_ARENA): { sim: Sim; events: GameEvent[] } {
  const events: GameEvent[] = [];
  const sim = { fighters, arena, time: 0, emit: (e: GameEvent) => events.push(e) } as unknown as Sim;
  return { sim, events };
}

/** A fighter standing at (x, z) on the ground (or at altitude y). */
export function stand(id: number, animal: AnimalId, x: number, z: number, y = 0): Fighter {
  const f = makeFighter(id, animal, x, z);
  f.state.pos.y = y;
  return f;
}

export function neutralIntent(): FighterIntent {
  return { moveX: 0, moveZ: 0, aimYaw: 0, attack: false, block: false, special: false, ultimate: false, jump: false };
}

/** A live (past the countdown) World on the registered 'ocean' arena, traps off. */
export function oceanWorld(
  animals: AnimalId[],
  seed = 11,
  serpent?: SerpentOptions,
): { world: World; events: GameEvent[] } {
  const cfg: MatchConfig = { roster: animals.map((a, i) => ({ animal: a, isPlayer: i === 0 })), difficulty: 1, arena: 'ocean' };
  const bus = new EventBus();
  const events: GameEvent[] = [];
  bus.onAny((e) => events.push(e));
  const world = new World(cfg, seed, bus, { traps: false, ...(serpent !== undefined ? { serpent } : {}) });
  for (let i = 0; i < 190; i++) world.step(DT); // 3 s countdown
  events.length = 0;
  return { world, events };
}

/** Teleport a World fighter to (x, z) at altitude `y`, at rest. */
export function place(world: World, id: number, x: number, z: number, y = 0): void {
  const s = world.fighters[id].state;
  s.pos.x = x;
  s.pos.z = z;
  s.pos.y = y;
  s.vel.x = 0;
  s.vel.y = 0;
  s.vel.z = 0;
  s.airborne = y > 0;
}

export function stepN(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) world.step(DT);
}

/** Steps `world` until its serpent event ends (or `maxTicks`); returns the number of ticks stepped. */
export function runToEnd(world: World, maxTicks = 400): number {
  let n = 0;
  while (world.serpent?.active === true && n < maxTicks) {
    world.step(DT);
    n++;
  }
  return n;
}

export function ofType<T extends GameEvent['type']>(events: readonly GameEvent[], type: T): Extract<GameEvent, { type: T }>[] {
  return events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);
}
