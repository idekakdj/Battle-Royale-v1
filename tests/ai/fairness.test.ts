/**
 * v1.1 player-facing fairness (UPGRADE-PLAN §3 goal 3): a Cub (L1) bot must
 * not be able to delete an idle, full-HP human in under ~15 s of fight time.
 * Every animal is tried as the attacker against an idle Eagle — the lowest-HP
 * fighter in the roster — standing 3 m away (so approach time is negligible).
 * Fight time runs from the first damage to the kill.
 */

import { describe, it, expect } from 'vitest';
import { World } from '../../src/sim/World';
import { EventBus } from '../../src/core/EventBus';
import { BotManager } from '../../src/ai/BotManager';
import { ANIMAL_IDS, ANIMALS } from '../../src/config/animals';
import { disablePickups } from '../sim/helpers';
import type { AnimalId, MatchConfig } from '../../src/core/types';
import { DT } from './helpers';

const MIN_TTK_S = 15;

/** Seconds from first damage to the idle victim's death (Infinity if it survives `capS`). */
function timeToKill(attacker: AnimalId, victim: AnimalId, seed: number, capS = 90): number {
  const cfg: MatchConfig = {
    roster: [
      { animal: victim, isPlayer: true },
      { animal: attacker, isPlayer: false },
    ],
    difficulty: 1,
  };
  const bus = new EventBus();
  const world = new World(cfg, seed, bus);
  disablePickups(world);
  world.fighters[0].state.pos = { x: 0, y: 0, z: -12 };
  world.fighters[1].state.pos = { x: 0, y: 0, z: -9 };
  const bots = new BotManager(bus, 1, seed);
  let first = -1;
  let dead = -1;
  const onDmg = (e: { targetId: number }): void => {
    if (e.targetId === 0 && first < 0) first = world.time;
  };
  bus.on('hit', onDmg);
  bus.on('blocked', onDmg);
  bus.on('death', (e) => {
    if (e.targetId === 0) dead = world.time;
  });
  const maxTicks = Math.ceil((capS + 3) / DT);
  for (let tick = 0; tick < maxTicks && dead < 0; tick++) {
    bots.update(world.snapshot(), DT);
    world.setIntent(1, bots.getIntent(1)); // the "player" (id 0) stays idle
    world.step(DT);
  }
  return dead < 0 ? Infinity : dead - first;
}

describe('L1 Cub fairness vs an idle human (v1.1)', () => {
  it(`no Cub kills an idle full-HP ${ANIMALS.eagle.displayName} (${ANIMALS.eagle.hp} HP) in under ${MIN_TTK_S} s`, () => {
    const ttks: string[] = [];
    let fastest = Infinity;
    for (const a of ANIMAL_IDS) {
      for (const seed of [3, 4]) {
        const t = timeToKill(a, 'eagle', seed);
        fastest = Math.min(fastest, t);
        ttks.push(`${a}:${t.toFixed(1)}`);
      }
    }
    console.info(`[WP-J fairness] L1 time-to-kill vs idle eagle (s): ${ttks.join(' ')}`);
    expect(fastest).toBeGreaterThanOrEqual(MIN_TTK_S);
  });
});
