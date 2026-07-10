import { describe, it, expect } from 'vitest';
import { createPickups, updatePickups } from '../../src/sim/PickupSystem';
import { makeFighter, makeSim, DT } from './helpers';
import { mulberry32 } from '../../src/core/math';
import { PICKUP_PADS } from '../../src/config/arena';
import { getBuff } from '../../src/sim/StatusEffects';
import type { GameEvent, PickupState } from '../../src/core/types';

const pad = PICKUP_PADS[0];

function padPickup(kind: PickupState['kind']): PickupState {
  return { id: 0, kind, pos: { x: pad.x, y: 0, z: pad.z }, active: true, respawnT: 0 };
}

describe('pickups (§9)', () => {
  it('spawns 6 pads', () => {
    expect(createPickups(mulberry32(1)).length).toBe(6);
  });

  it('heal restores +250 hp (capped) and emits a pickup event', () => {
    const events: GameEvent[] = [];
    const f = makeFighter(0, 'lion', pad.x, pad.z);
    f.state.hp = 500;
    const sim = makeSim([f], events);
    const pickups = [padPickup('heal')];
    updatePickups(sim, pickups, DT);
    expect(f.state.hp).toBe(750);
    expect(pickups[0].active).toBe(false);
    expect(pickups[0].respawnT).toBe(20);
    expect(events.some((e) => e.type === 'pickup')).toBe(true);
  });

  it('speed grants a +30% speed buff', () => {
    const f = makeFighter(0, 'lion', pad.x, pad.z);
    const sim = makeSim([f]);
    updatePickups(sim, [padPickup('speed')], DT);
    expect(getBuff(f, 'speed')?.mag).toBeCloseTo(0.3, 5);
  });

  it('rage grants a +25% rage buff', () => {
    const f = makeFighter(0, 'lion', pad.x, pad.z);
    const sim = makeSim([f]);
    updatePickups(sim, [padPickup('rage')], DT);
    expect(getBuff(f, 'rage')?.mag).toBeCloseTo(0.25, 5);
  });

  it('respawns after the respawn delay', () => {
    const f = makeFighter(0, 'lion', 100, 100); // off the pad
    const sim = makeSim([f]);
    const pickups: PickupState[] = [{ id: 0, kind: 'heal', pos: { x: pad.x, y: 0, z: pad.z }, active: false, respawnT: 0.02 }];
    updatePickups(sim, pickups, DT);
    expect(pickups[0].active).toBe(true);
  });
});
