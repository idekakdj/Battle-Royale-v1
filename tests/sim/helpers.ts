/**
 * Shared test helpers: build Fighters + a minimal Sim for pipeline unit tests,
 * and drive a World past its 3 s countdown for ability/integration tests.
 */

import { Fighter } from '../../src/sim/Fighter';
import type { Sim, CrateRuntime } from '../../src/sim/Fighter';
import { World } from '../../src/sim/World';
import { EventBus } from '../../src/core/EventBus';
import { ANIMALS } from '../../src/config/animals';
import { mulberry32 } from '../../src/core/math';
import type { Obstacle } from '../../src/config/arena';
import type { AnimalId, FighterIntent, GameEvent, MatchConfig } from '../../src/core/types';

export const DT = 1 / 60;

export function makeFighter(id: number, animal: AnimalId, x: number, z: number, yaw = 0): Fighter {
  return new Fighter(id, animal, ANIMALS[animal], id === 0, { x, y: 0, z }, yaw);
}

/** A bare Sim wrapping the fighters, capturing events, with World-equivalent hp. */
export function makeSim(fighters: Fighter[], events: GameEvent[] = [], obstacles: readonly Obstacle[] = []): Sim {
  const bus = new EventBus();
  bus.onAny((e) => events.push(e));
  const sim: Sim = {
    fighters,
    crates: [] as CrateRuntime[],
    staticObstacles: obstacles,
    bus,
    rng: mulberry32(1),
    time: 0,
    bloodlustMult: 1,
    emit(ev) {
      bus.emit(ev);
    },
    dealHp(att, tgt, amount) {
      if (amount <= 0 || !tgt.state.alive) return;
      const applied = Math.min(amount, tgt.state.hp);
      if (applied <= 0) return;
      tgt.state.hp -= applied;
      if (att !== null && att !== tgt) {
        tgt.lastAttackerId = att.id;
        att.state.damageDealt += applied;
      }
    },
    applyBleedDamage(s, t, a) {
      this.dealHp(s, t, a);
    },
    damageCrate() {
      /* not needed in unit tests */
    },
  };
  return sim;
}

export function neutral(): FighterIntent {
  return { moveX: 0, moveZ: 0, aimYaw: 0, attack: false, block: false, special: false, ultimate: false, jump: false };
}

/** Build a World and step it just past the countdown so the fight is live. */
export function liveWorld(animals: AnimalId[], seed = 42, events: GameEvent[] = []): { world: World; events: GameEvent[] } {
  const cfg: MatchConfig = { roster: animals.map((a, i) => ({ animal: a, isPlayer: i === 0 })), difficulty: 1 };
  const bus = new EventBus();
  bus.onAny((e) => events.push(e));
  const world = new World(cfg, seed, bus);
  for (let i = 0; i < 190; i++) world.step(DT); // 3 s countdown = 180 ticks
  events.length = 0; // discard countdown/no-op events
  return { world, events };
}
