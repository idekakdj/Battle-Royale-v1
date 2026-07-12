/**
 * WP-C reaction-delay unit test (§10.1): a telegraph event must not influence
 * a bot's intents before its profile's reactionMs has elapsed.
 *
 * Two BotManagers share the same seed and see identical static snapshots; one
 * additionally receives a telegraph event. Their emitted intents MUST stay
 * identical for every tick before the reaction delay elapses, and diverge
 * shortly after (block roll / rng stream shift).
 */

import { describe, it, expect } from 'vitest';
import { EventBus } from '../../src/core/EventBus';
import { BotManager } from '../../src/ai/BotManager';
import { BOT_PROFILES } from '../../src/config/botProfiles';
import type { FighterState, WorldSnapshot } from '../../src/core/types';
import { DT } from './helpers';

function makeFighter(id: number, animal: FighterState['animal'], x: number, z: number, yaw: number): FighterState {
  return {
    id,
    animal,
    isPlayer: false,
    alive: true,
    pos: { x, y: 0, z },
    vel: { x: 0, y: 0, z: 0 },
    yaw,
    hp: 1000,
    maxHp: 1000,
    guard: 100,
    maxGuard: 100,
    guardRegenDelay: 0,
    ultCharge: 0,
    specialCd: 5,
    action: 'idle',
    actionT: 0,
    actionDur: 0,
    comboIndex: 0,
    comboWindow: 0,
    buffs: [],
    kills: 0,
    damageDealt: 0,
    damageBlocked: 0,
    ultsUsed: 0,
    grabTargetId: -1,
    grabbedById: -1,
    airborne: false,
    glideT: 0,
    burrowT: 0,
  };
}

function makeSnapshot(time: number): WorldSnapshot {
  return {
    time,
    fighters: [makeFighter(0, 'lion', 0, 0, 0), makeFighter(1, 'gorilla', 0, 3, Math.PI)],
    pickups: [],
    crates: [],
    bloodlustMult: 1,
    matchOver: false,
    winnerId: -1,
  };
}

function intentKey(m: BotManager): string {
  const i = m.getIntent(0);
  return `${i.moveX.toFixed(6)},${i.moveZ.toFixed(6)},${i.aimYaw.toFixed(6)},${i.attack},${i.block},${i.special},${i.ultimate},${i.jump}`;
}

describe('reaction delay buffering (§10.1)', () => {
  it('a telegraph influences intents only after reactionMs', () => {
    const seed = 424242;
    const busA = new EventBus();
    const busB = new EventBus();
    const withEvent = new BotManager(busA, 4, seed);
    const control = new BotManager(busB, 4, seed);

    const reactionTicks = Math.round(BOT_PROFILES[4].reactionMs / 1000 / DT); // 150 ms → 9 ticks

    const warmup = 30; // ticks before the event fires
    const total = warmup + reactionTicks + 60;
    const eventTick = warmup; // emitted right after update #warmup

    let firstDivergence = -1;
    for (let tick = 0; tick < total; tick++) {
      const snap = makeSnapshot(5 + tick * DT); // fight live, nothing moving
      withEvent.update(snap, DT);
      control.update(snap, DT);
      if (firstDivergence < 0 && intentKey(withEvent) !== intentKey(control)) {
        firstDivergence = tick;
      }
      if (tick === eventTick - 1) {
        // Enemy (id 1) telegraphs a special right on top of the bot.
        busA.emit({
          type: 'telegraph',
          fighterId: 1,
          kind: 'special',
          pos: { x: 0, y: 0, z: 3 },
          radius: 2,
          yaw: Math.PI,
          arcDeg: 60,
          windup: 0.35,
        });
      }
    }

    // The event fires when manager time = eventTick·DT (right after update
    // #eventTick−1); the earliest update at which manager time has advanced by
    // reactionMs is loop tick (eventTick − 1) + reactionTicks.
    const earliestLegal = eventTick - 1 + reactionTicks;
    // Divergence must exist (the event was perceived at all) …
    expect(firstDivergence).toBeGreaterThanOrEqual(0);
    // … but strictly not before the reaction delay elapsed.
    expect(firstDivergence).toBeGreaterThanOrEqual(earliestLegal);
    // And it should land soon after release (event actually acted upon).
    expect(firstDivergence).toBeLessThanOrEqual(earliestLegal + 30);
  });
});
