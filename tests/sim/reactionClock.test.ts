/**
 * v1.3: the reaction-pose clocks. While a fighter shows `stagger`, `hit` (flinch) or `feared`,
 * `World.resolveAction` drives `state.actionT / actionDur` from the real timer (`actionT` = seconds the
 * reaction has been on screen, `actionDur` = that + the time still to go), so the renderer's
 * `poseStagger(u)` / `poseHit(u)` / feared pose run from u = 0 to 1. The clocks are cosmetic: the
 * timers themselves are untouched (the balance sweep is identical before/after).
 */

import { describe, it, expect } from 'vitest';
import { applyEffect } from '../../src/sim/StatusEffects';
import { applyReaction } from '../../src/sim/CombatSystem';
import { REACT } from '../../src/config/balance';
import { LION_HUNT as H } from '../../src/config/ultimates/lion';
import { liveWorld, disablePickups, neutral, DT } from './helpers';
import type { Fighter } from '../../src/sim/Fighter';
import type { World } from '../../src/sim/World';
import type { FighterAction } from '../../src/core/types';

function fixture(): { world: World; victim: Fighter; attacker: Fighter } {
  const { world } = liveWorld(['lion', 'gorilla']);
  disablePickups(world);
  return { world, attacker: world.fighters[0], victim: world.fighters[1] };
}

/** Step until the victim's visible action leaves `action`; returns what each shown tick looked like. */
function runShown(world: World, action: FighterAction, max = 600): { t: number; dur: number }[] {
  const out: { t: number; dur: number }[] = [];
  for (let i = 0; i < max; i++) {
    world.step(DT);
    const st = world.snapshot().fighters[1];
    if (st.action !== action) break;
    out.push({ t: st.actionT, dur: st.actionDur });
  }
  return out;
}

function expectRamp(shown: { t: number; dur: number }[], total: number): void {
  expect(shown.length).toBeGreaterThan(2);
  let prev = -1;
  for (const f of shown) {
    expect(f.dur).toBeCloseTo(total, 6); // constant total, so u = actionT / actionDur is a clean ramp
    expect(f.t).toBeGreaterThan(prev - 1e-12);
    expect(f.t).toBeLessThanOrEqual(f.dur + 1e-9);
    prev = f.t;
  }
  expect(shown[0].t / shown[0].dur).toBeLessThan(0.02); // starts at the beginning of the pose
  const last = shown[shown.length - 1];
  expect(last.t / last.dur).toBeGreaterThan(0.85); // ends at (almost) the end of it
}

describe('stagger clock', () => {
  it('runs u from 0 to 1 over the real stagger timer, and the stagger lasts exactly as long as before', () => {
    const { world, attacker, victim } = fixture();
    applyEffect(world, attacker, victim, { kind: 'stagger', mag: 0, dur: 0.5 });
    const shown = runShown(world, 'stagger');
    // Applied outside a tick, so the first tick's decrement is not on screen: total = dur - one tick.
    expectRamp(shown, 0.5 - DT);
    expect((shown.length + 1) * DT).toBeGreaterThan(0.5 - DT);
    expect((shown.length + 1) * DT).toBeLessThan(0.5 + 2 * DT);
    expect(victim.staggerTimer).toBe(0);
  });

  it('a longer stagger landing mid-way extends the same clock (no restart)', () => {
    const { world, attacker, victim } = fixture();
    applyEffect(world, attacker, victim, { kind: 'stagger', mag: 0, dur: 0.5 });
    for (let i = 0; i < 12; i++) world.step(DT);
    const before = world.snapshot().fighters[1];
    expect(before.action).toBe('stagger');
    applyEffect(world, attacker, victim, { kind: 'stagger', mag: 0, dur: 1.0 });
    world.step(DT);
    const after = world.snapshot().fighters[1];
    expect(after.actionT).toBeCloseTo(before.actionT + DT, 6); // the clock kept running
    expect(after.actionDur).toBeGreaterThan(before.actionDur + 0.3); // and stretched to the new end
    expect(after.actionT).toBeLessThan(after.actionDur);
    expect(runShown(world, 'stagger').length * DT).toBeLessThan(1.0);
    expect(victim.staggerTimer).toBe(0);
  });

  it('a stagger hidden behind a knockdown starts its pose at u = 0 when it becomes visible', () => {
    const { world, attacker, victim } = fixture();
    applyEffect(world, attacker, victim, { kind: 'knockdown', mag: 0, dur: 0.5 }); // 0.8 s down
    applyEffect(world, attacker, victim, { kind: 'stagger', mag: 0, dur: 1.0 }); // 0.2 s of it left afterwards
    for (let i = 0; i < 20 && world.snapshot().fighters[1].action !== 'stagger'; i++) world.step(DT);
    expect(world.snapshot().fighters[1].action).not.toBe('stagger'); // still down
    const shown = runShown(world, 'knockdown'); // runs out the rest of the knockdown
    expect(shown.length).toBeGreaterThan(0);
    const st = world.snapshot().fighters[1];
    expect(st.action).toBe('stagger');
    expect(st.actionT).toBeLessThan(2 * DT);
    expect(st.actionDur).toBeGreaterThan(0.1);
    expect(st.actionDur).toBeLessThan(0.3);
    const rest = runShown(world, 'stagger');
    expect(rest.length).toBeGreaterThan(2);
    for (const f of rest) expect(f.dur).toBeCloseTo(st.actionDur, 6);
    expect(rest[rest.length - 1].t / st.actionDur).toBeGreaterThan(0.85);
  });

  it('a stagger zeroed and re-applied out of another action restarts (croc / python hold-stun → toss / crush)', () => {
    const { world, victim } = fixture();
    victim.state.grabbedById = 0; // shown as 'grabbed' while the hold-stun runs
    victim.staggerTimer = 3;
    for (let i = 0; i < 60; i++) world.step(DT);
    expect(world.snapshot().fighters[1].action).toBe('grabbed');
    victim.state.grabbedById = -1;
    victim.staggerTimer = 0; // the crush is not amplified by the hold stun…
    victim.staggerTimer = 0.45; // …then its own stagger lands
    world.step(DT);
    const st = world.snapshot().fighters[1];
    expect(st.action).toBe('stagger');
    expect(st.actionT).toBe(0);
    expect(st.actionDur).toBeCloseTo(0.45 - DT, 6);
  });
});

describe('hit (flinch) clock', () => {
  it('runs u from 0 to 1 over the flinch', () => {
    const { world, victim } = fixture();
    applyReaction(victim, 'flinch');
    expect(victim.hitstunTimer).toBeCloseTo(REACT.flinch, 9);
    const shown = runShown(world, 'hit');
    expectRamp(shown, REACT.flinch - DT);
    expect(victim.hitstunTimer).toBe(0);
  });

  it('a second hit landing mid-flinch keeps the clock running (no restart)', () => {
    const { world, victim } = fixture();
    applyReaction(victim, 'flinch');
    for (let i = 0; i < 6; i++) world.step(DT);
    const before = world.snapshot().fighters[1];
    expect(before.action).toBe('hit');
    applyReaction(victim, 'flinch'); // timer refilled
    world.step(DT);
    const after = world.snapshot().fighters[1];
    expect(after.action).toBe('hit');
    expect(after.actionT).toBeCloseTo(before.actionT + DT, 6);
    expect(after.actionDur).toBeGreaterThan(before.actionDur);
  });
});

describe('feared clock', () => {
  it('runs u from 0 to 1 over the fear timer', () => {
    const { world, attacker, victim } = fixture();
    applyEffect(world, attacker, victim, { kind: 'fear', mag: 0, dur: 1.2 });
    const shown = runShown(world, 'feared');
    expectRamp(shown, 1.2 - DT);
    expect(victim.fearTimer).toBe(0);
  });

  it('CC-immune fighters ignore the effects: no reaction on screen, no clock', () => {
    const { world, attacker, victim } = fixture();
    victim.rampageTimer = 10; // ccImmune every tick
    world.step(DT); // the immunity flag is computed at the start of a tick
    applyEffect(world, attacker, victim, { kind: 'stagger', mag: 0, dur: 0.5 });
    applyEffect(world, attacker, victim, { kind: 'fear', mag: 0, dur: 0.5 });
    world.step(DT);
    expect(victim.reactKind).toBe('');
    expect(world.snapshot().fighters[1].action).not.toBe('stagger');
  });
});

describe('the lion roar stagger after the pin now animates', () => {
  it('knockdown pose ends, then the roar stagger plays from u = 0 over what is left of it', () => {
    const { world } = liveWorld(['lion', 'gorilla', 'hippo']);
    disablePickups(world);
    const c = world.fighters[0];
    const t = world.fighters[1];
    world.fighters[2].state.pos = { x: -20, y: 0, z: -20 };
    c.state.pos = { x: 0, y: 0, z: 0 };
    c.state.yaw = 0;
    t.state.pos = { x: 0, y: 0, z: 6 };
    t.state.yaw = Math.PI;
    const step = (press: boolean): void => {
      const a = neutral();
      a.ultimate = press;
      a.aimYaw = 0;
      world.setIntent(0, a);
      world.setIntent(1, neutral());
      world.setIntent(2, neutral());
      world.step(DT);
    };
    c.state.ultCharge = 100;
    step(true);
    let pinned = false;
    let staggerAt = -1;
    let first: { t: number; dur: number } | null = null;
    const staggerFrames: { t: number; dur: number }[] = [];
    for (let i = 0; i < 400; i++) {
      step(false);
      const st = world.snapshot().fighters[1];
      if (st.action === 'knockdown') {
        pinned = true;
        expect(staggerAt).toBe(-1); // no stagger frame before the pin ends
      }
      if (st.action === 'stagger') {
        if (first === null) {
          first = { t: st.actionT, dur: st.actionDur };
          staggerAt = i;
        }
        staggerFrames.push({ t: st.actionT, dur: st.actionDur });
      }
      if (pinned && staggerAt >= 0 && st.action !== 'stagger') break;
    }
    expect(pinned).toBe(true);
    expect(first).not.toBeNull();
    // The roar stagger (0.7 s) lands 1.6 s into the 2.0 s pin: about 0.3 s of it is left once the victim can get up.
    expect(first!.t).toBeLessThan(2 * DT);
    expect(first!.dur).toBeGreaterThan(0.15);
    expect(first!.dur).toBeLessThan(H.roarStagger);
    expectRamp(staggerFrames, first!.dur);
  });
});
