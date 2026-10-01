/**
 * v1.3: the knockdown clock. While a fighter is knocked down `World` drives
 * `state.actionT / actionDur` (fall → hold → rise, total = down time + the 0.3 s rise) so the
 * renderer's generic knockdown pose animates for every victim. The clock is cosmetic: the
 * knockdown still lasts exactly `dur + KNOCKDOWN_RISE` and nothing about gameplay changes
 * (the balance sweep is identical before/after).
 */

import { describe, it, expect } from 'vitest';
import { applyEffect } from '../../src/sim/StatusEffects';
import { KNOCKDOWN_RISE } from '../../src/sim/simTuning';
import type { Fighter } from '../../src/sim/Fighter';
import type { World } from '../../src/sim/World';
import { liveWorld, disablePickups, DT } from './helpers';

function fixture(): { world: World; victim: Fighter } {
  const { world } = liveWorld(['lion', 'gorilla']);
  disablePickups(world);
  return { world, victim: world.fighters[1] };
}

describe('knockdown clock (cosmetic actionT/actionDur)', () => {
  it('runs from 0 to actionDur = down time + rise, then hands back to normal actions', () => {
    const { world, victim } = fixture();
    applyEffect(world, world.fighters[0], victim, { kind: 'knockdown', mag: 0, dur: 0.8 });
    const total = 0.8 + KNOCKDOWN_RISE;
    let ticks = 0;
    let prevT = -1;
    let last = { t: 0, dur: 0 };
    while (ticks < 300) {
      world.step(DT);
      const st = world.snapshot().fighters[1];
      if (st.action !== 'knockdown') break;
      ticks++;
      expect(st.actionDur).toBeCloseTo(total, 9); // constant total: u = actionT / actionDur is a clean 0 → 1 ramp
      expect(st.actionT).toBeGreaterThan(prevT); // strictly advances every tick
      expect(st.actionT).toBeLessThanOrEqual(st.actionDur + 1e-12); // never past its duration
      prevT = st.actionT;
      last = { t: st.actionT, dur: st.actionDur };
    }
    // Gameplay is unchanged: the fighter is down for exactly dur + rise (to within one tick).
    expect(ticks * DT).toBeGreaterThan(total - 2 * DT);
    expect(ticks * DT).toBeLessThan(total + 2 * DT);
    expect(victim.knockdownTimer).toBe(0);
    // The last knocked-down frame is at the very end of the rise.
    expect(last.t / last.dur).toBeGreaterThan(0.97);
    expect(world.snapshot().fighters[1].action).not.toBe('knockdown');
  });

  it('starts at the fall (u ≈ 0) on the tick the knockdown lands', () => {
    const { world, victim } = fixture();
    applyEffect(world, world.fighters[0], victim, { kind: 'knockdown', mag: 0, dur: 0.5 });
    world.step(DT);
    const st = world.snapshot().fighters[1];
    expect(st.action).toBe('knockdown');
    expect(st.actionT / st.actionDur).toBeLessThan(0.05);
  });

  it('a longer knockdown landing mid-way extends the same clock (no restart, still ends exactly at the end)', () => {
    const { world, victim } = fixture();
    applyEffect(world, world.fighters[0], victim, { kind: 'knockdown', mag: 0, dur: 0.5 });
    for (let i = 0; i < 18; i++) world.step(DT); // 0.3 s in
    const before = world.snapshot().fighters[1];
    expect(before.actionT).toBeCloseTo(18 * DT, 6);
    applyEffect(world, world.fighters[0], victim, { kind: 'knockdown', mag: 0, dur: 1.5 }); // 1.8 s total from now
    world.step(DT);
    const after = world.snapshot().fighters[1];
    expect(after.actionT).toBeCloseTo(19 * DT, 6); // the clock kept running
    expect(after.actionDur).toBeCloseTo(19 * DT + (1.5 + KNOCKDOWN_RISE - DT), 6); // = elapsed + what is still to go
    // The pose's end coincides with the real end of the knockdown.
    while (world.snapshot().fighters[1].action === 'knockdown') world.step(DT);
    expect(victim.knockdownTimer).toBe(0);
  });

  it('a second, later knockdown starts a fresh clock', () => {
    const { world, victim } = fixture();
    applyEffect(world, world.fighters[0], victim, { kind: 'knockdown', mag: 0, dur: 0.2 });
    for (let i = 0; i < 90; i++) world.step(DT); // long over
    expect(world.snapshot().fighters[1].action).not.toBe('knockdown');
    applyEffect(world, world.fighters[0], victim, { kind: 'knockdown', mag: 0, dur: 0.6 });
    world.step(DT);
    const st = world.snapshot().fighters[1];
    expect(st.action).toBe('knockdown');
    expect(st.actionT).toBeLessThan(2 * DT);
    expect(st.actionDur).toBeCloseTo(0.6 + KNOCKDOWN_RISE, 9);
  });

  it('is the same for a knock-up (also a knockdown) and does not touch a fighter that is not knocked down', () => {
    const { world, victim } = fixture();
    world.step(DT);
    const idle = world.snapshot().fighters[1];
    expect(idle.action).not.toBe('knockdown');
    expect(victim.knockdownClock).toBe(0);
    applyEffect(world, world.fighters[0], victim, { kind: 'knockup', mag: 0, dur: 0.6 });
    world.step(DT);
    const st = world.snapshot().fighters[1];
    expect(st.action).toBe('knockdown');
    expect(st.actionDur).toBeCloseTo(0.6 + KNOCKDOWN_RISE, 9);
    expect(st.actionT).toBeGreaterThan(0);
  });
});
