/**
 * v1.8 WP-J2: a rhino staggered in the middle of its Lockdown Charge carry used to lose the ability without letting go of its
 * victim (`Fighter.interrupt` only keeps `isGrab` abilities), leaving the victim `grabbed` for ever — found as a jungle L3 timeout
 * (seed 3396). World now releases a held fighter whose holder has no ability any more — on EVERY arena (the colosseum had the same
 * bug; the architect lifted the jungle-only gate in v1.8, so the tests below run on both arenas).
 */

import { describe, it, expect } from 'vitest';
import { liveWorld, neutral, disablePickups, DT } from './helpers';

describe.each(['jungle', 'colosseum'] as const)('orphaned grab (holder interrupted mid-carry) on the %s', (arenaId) => {
  function carry(): { rhino: ReturnType<typeof liveWorld>['world']['fighters'][number]; victim: ReturnType<typeof liveWorld>['world']['fighters'][number]; world: ReturnType<typeof liveWorld>['world'] } {
    const { world } = liveWorld(['rhino', 'hippo'], 7, [], { arena: arenaId });
    disablePickups(world);
    const rhino = world.fighters[0];
    const victim = world.fighters[1];
    rhino.state.pos = { x: 0, y: 0, z: 0 };
    rhino.state.yaw = 0;
    victim.state.pos = { x: 0, y: 0, z: 3 };
    rhino.state.specialCd = 0;
    const press = neutral();
    press.special = true;
    press.aimYaw = 0;
    world.setIntent(0, press);
    world.setIntent(1, neutral());
    world.step(DT);
    for (let i = 0; i < 90 && victim.state.grabbedById !== 0; i++) {
      world.setIntent(0, neutral());
      world.setIntent(1, neutral());
      world.step(DT);
    }
    return { rhino, victim, world };
  }

  it('the charge grabs and carries the victim', () => {
    const { rhino, victim } = carry();
    expect(victim.state.grabbedById).toBe(0);
    expect(rhino.state.grabTargetId).toBe(1);
    expect(rhino.ability).not.toBeNull();
  });

  it('a stagger that cancels the charge lets the victim go on the next tick', () => {
    const { rhino, victim, world } = carry();
    rhino.staggerTimer = 1;
    rhino.interrupt();
    expect(rhino.ability).toBeNull();
    world.setIntent(0, neutral());
    world.setIntent(1, neutral());
    world.step(DT);
    expect(victim.state.grabbedById).toBe(-1);
    expect(rhino.state.grabTargetId).toBe(-1);
    // and the victim is a normal fighter again
    for (let i = 0; i < 20; i++) {
      world.setIntent(0, neutral());
      world.setIntent(1, neutral());
      world.step(DT);
    }
    expect(victim.state.action).not.toBe('grabbed');
  });

  it('a healthy carry is not released early', () => {
    const { rhino, victim, world } = carry();
    for (let i = 0; i < 6; i++) {
      world.setIntent(0, neutral());
      world.setIntent(1, neutral());
      world.step(DT);
      expect(victim.state.grabbedById).toBe(0);
      expect(rhino.state.grabTargetId).toBe(1);
    }
  });
});
