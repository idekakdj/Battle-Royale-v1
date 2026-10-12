/**
 * v1.9 sea serpent — the roll SCHEDULE (WP-O1b): 10 % per minute of LIVE match time, rolled on exact 60 s multiples (never during
 * the countdown) from the serpent's own RNG stream; deterministic; and arenas without `hazards.serpent` never see it.
 */
import { describe, it, expect } from 'vitest';
import { SerpentSystem } from '../../src/sim/SerpentSystem';
import { SERPENT, SERPENT_EVENT_S } from '../../src/config/serpent';
import { OCEAN_ARENA, COLOSSEUM_ARENA, JUNGLE_ARENA } from '../../src/config/arenas';
import { mulberry32 } from '../../src/core/math';
import { World } from '../../src/sim/World';
import { EventBus } from '../../src/core/EventBus';
import type { GameEvent, MatchConfig } from '../../src/core/types';
import { ANIMAL_IDS } from '../../src/config/animals';
import { DT, FLAT_ARENA, stubSim, trueDeal } from './serpentHelpers';

describe('serpent config', () => {
  it('is the binding plan (docs/OCEAN-PLAN.md): 10 % per 60 s, 1.3 / 0.55 / 0.35 / 0.8 s, 1.6 m strip, 300 true damage, 3 m reach', () => {
    expect(SERPENT.intervalS).toBe(60);
    expect(SERPENT.chance).toBe(0.1);
    expect(SERPENT.damage).toBe(300);
    expect(SERPENT.hazardHeight).toBe(3);
    expect(SERPENT.headRadius).toBe(SERPENT.stripHalfWidth); // the telegraph IS the hitbox
    // the plan allows tuning warn / width / strike within +-20 %
    expect(SERPENT.warnS).toBeGreaterThanOrEqual(1.3 * 0.8 - 1e-9);
    expect(SERPENT.warnS).toBeLessThanOrEqual(1.3 * 1.2 + 1e-9);
    expect(SERPENT.strikeS).toBeGreaterThanOrEqual(0.55 * 0.8 - 1e-9);
    expect(SERPENT.strikeS).toBeLessThanOrEqual(0.55 * 1.2 + 1e-9);
    expect(SERPENT.stripHalfWidth).toBeGreaterThanOrEqual(1.6 * 0.8 - 1e-9);
    expect(SERPENT.stripHalfWidth).toBeLessThanOrEqual(1.6 * 1.2 + 1e-9);
    expect(SERPENT_EVENT_S).toBeCloseTo(SERPENT.warnS + SERPENT.strikeS + SERPENT.holdS + SERPENT.retreatS, 12);
    expect(OCEAN_ARENA.hazards?.serpent).toBe(true);
    expect(OCEAN_ARENA.wallRadius).toBe(30);
  });
});

describe('roll statistics (own RNG stream)', () => {
  /** The outcome of the t = 60 s roll for `seed` (the system is stepped with the clock set to the roll time). */
  function firstRoll(seed: number): { started: boolean; angleDeg: number } {
    const { sim } = stubSim([]);
    const sys = new SerpentSystem(seed, FLAT_ARENA);
    sim.time = 60;
    sys.step(sim, DT, trueDeal);
    expect(sys.rollLog).toHaveLength(1);
    expect(sys.rollLog[0].at).toBe(60);
    return { started: sys.rollLog[0].started, angleDeg: sys.rollLog[0].angleDeg };
  }

  it('the t = 60 s roll succeeds in 10 % +- 2 % of 4000 seeds', () => {
    let ok = 0;
    const angles: number[] = [];
    const N = 4000;
    for (let seed = 1; seed <= N; seed++) {
      const r = firstRoll(seed);
      if (r.started) {
        ok++;
        angles.push(r.angleDeg);
      }
    }
    const rate = ok / N;
    console.log(`[serpent] first-roll success rate over ${N} seeds: ${(rate * 100).toFixed(2)} %`);
    expect(rate).toBeGreaterThan(0.08);
    expect(rate).toBeLessThan(0.12);
    // angles are uniform over [0, 360): every 60-degree sector is used and none dominates
    const sectors = new Array<number>(6).fill(0);
    for (const a of angles) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(360);
      sectors[Math.floor(a / 60)]++;
    }
    for (const c of sectors) {
      expect(c).toBeGreaterThan(angles.length / 6 / 2);
      expect(c).toBeLessThan((angles.length / 6) * 1.6);
    }
  });

  it('later rolls (t = 120, 180, … ) follow the same 10 % law over a long match', () => {
    let rolls = 0;
    let ok = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const { sim } = stubSim([]);
      // intervalS shortened only for the clock; the chance is the real 10 %
      const sys = new SerpentSystem(seed, FLAT_ARENA, { intervalS: 60 });
      for (let k = 1; k <= 10; k++) {
        sim.time = 60 * k;
        sys.step(sim, DT, trueDeal);
        // an event started by this roll is skipped over by the next ones: abort it so every roll is a real roll
        if (sys.active) sys.abort(sim);
      }
      rolls += sys.rollLog.filter((r) => !r.skipped).length;
      ok += sys.rollLog.filter((r) => r.started).length;
    }
    expect(rolls).toBe(4000);
    expect(ok / rolls).toBeGreaterThan(0.085);
    expect(ok / rolls).toBeLessThan(0.115);
  });

  it('the stream is seed ^ salt: it matches an independent mulberry32 and never touches another stream', () => {
    for (const seed of [1, 7, 12345, 0xdeadbeef]) {
      const rng = mulberry32((seed ^ SERPENT.seedSalt) >>> 0);
      const wantStart = rng() < SERPENT.chance;
      const wantAngle = wantStart ? rng() * 360 : -1;
      const { sim } = stubSim([]);
      const sys = new SerpentSystem(seed, FLAT_ARENA);
      sim.time = 60;
      sys.step(sim, DT, trueDeal);
      expect(sys.rollLog[0].started).toBe(wantStart);
      expect(sys.rollLog[0].angleDeg).toBe(wantAngle);
    }
  });

  it('options override the real rules: chance 1 always starts, chance 0 never, firstAtS moves the first roll', () => {
    const { sim } = stubSim([]);
    const always = new SerpentSystem(5, FLAT_ARENA, { chance: 1, firstAtS: 2 });
    sim.time = 1.99;
    always.step(sim, DT, trueDeal);
    expect(always.rollLog).toHaveLength(0);
    sim.time = 2;
    always.step(sim, DT, trueDeal);
    expect(always.rollLog).toHaveLength(1);
    expect(always.rollLog[0].started).toBe(true);
    expect(always.phase).toBe('warn');
    const never = new SerpentSystem(5, FLAT_ARENA, { chance: 0, intervalS: 10 });
    for (let k = 1; k <= 5; k++) {
      sim.time = 10 * k;
      never.step(sim, DT, trueDeal);
    }
    expect(never.rollLog.map((r) => r.at)).toEqual([10, 20, 30, 40, 50]);
    expect(never.rollLog.some((r) => r.started)).toBe(false);
    expect(never.eventsStarted).toBe(0);
  });

  it('a roll that falls due during a running event is skipped without consuming random numbers', () => {
    const { sim } = stubSim([]);
    const sys = new SerpentSystem(9, FLAT_ARENA, { chance: 1, intervalS: 1 }); // the event (3 s) outlasts the 1 s interval
    sim.time = 1;
    sys.step(sim, DT, trueDeal);
    expect(sys.rollLog[0].started).toBe(true);
    const angle = sys.angleDeg;
    for (let k = 0; k < 120; k++) {
      sim.time += DT;
      sys.step(sim, DT, trueDeal);
    }
    expect(sys.rollLog.some((r) => r.skipped)).toBe(true);
    expect(sys.eventsStarted).toBe(1); // never two at once
    expect(sys.angleDeg).toBe(angle);
  });
});

describe('World: rolls happen on exact live-time multiples of 60 s', () => {
  const roster = ANIMAL_IDS.map((a, i) => ({ animal: a, isPlayer: i === 0 }));
  const cfg = (arena: MatchConfig['arena']): MatchConfig => ({ roster, difficulty: 1, arena });

  it('first rolls at 60 s and 120 s of LIVE time (the 3 s countdown does not count), within one tick of the multiple', () => {
    const world = new World(cfg('ocean'), 31, new EventBus(), { traps: false });
    expect(world.serpent).not.toBeNull();
    let ticks = 0;
    while (world.time < 125 && !world.matchOver) {
      world.step(DT);
      ticks++;
    }
    const sys = world.serpent as SerpentSystem;
    const log = sys.rollLog;
    expect(log.map((r) => r.at)).toEqual([60, 120]);
    for (const r of log) {
      expect(r.time).toBeGreaterThanOrEqual(r.at - 1e-6);
      expect(r.time).toBeLessThan(r.at + DT);
    }
    // 125 s of live time took 3 s of countdown + 125 s of fight
    expect(ticks).toBeGreaterThanOrEqual(Math.round((125 + 3) * 60) - 2);
    expect(ticks).toBeLessThanOrEqual(Math.round((125 + 3) * 60) + 2);
  });

  it('no roll happens during the countdown, even when the first roll is forced to t = 0.5 s', () => {
    const world = new World(cfg('ocean'), 31, new EventBus(), { traps: false, serpent: { chance: 1, firstAtS: 0.5 } });
    const events: GameEvent[] = [];
    world.bus.onAny((e) => events.push(e));
    for (let i = 0; i < 180; i++) world.step(DT); // the whole 3 s countdown
    expect(world.time).toBe(0);
    expect(world.serpent?.rollLog).toHaveLength(0);
    expect(events.some((e) => e.type === 'serpentWarning')).toBe(false);
    expect(world.snapshot().serpent).toBeUndefined();
    for (let i = 0; i < 29; i++) world.step(DT); // 0.48 s of fight
    expect(world.serpent?.rollLog).toHaveLength(0);
    for (let i = 0; i < 3; i++) world.step(DT);
    expect(world.serpent?.rollLog).toHaveLength(1);
    expect(world.serpent?.rollLog[0].at).toBe(0.5);
    expect(events.filter((e) => e.type === 'serpentWarning')).toHaveLength(1);
  });

  it('the serpent never perturbs the sim RNG: forced events or not, world.rng() is the same stream', () => {
    const a = new World(cfg('ocean'), 77, new EventBus(), { traps: false });
    const b = new World(cfg('ocean'), 77, new EventBus(), { traps: false, serpent: { chance: 1, firstAtS: 0.1, intervalS: 2 } });
    for (let i = 0; i < 180 + 600; i++) {
      a.step(DT);
      b.step(DT);
    }
    expect(b.serpent?.eventsStarted).toBeGreaterThan(0);
    expect(b.rng()).toBe(a.rng());
  });

  it('is deterministic: the same seed and options give the same rolls, events and snapshots', () => {
    const run = (): { log: unknown; events: GameEvent[]; snaps: string[] } => {
      const events: GameEvent[] = [];
      const bus = new EventBus();
      bus.onAny((e) => events.push(e));
      const w = new World(cfg('ocean'), 4242, bus, { traps: false, serpent: { chance: 0.5, firstAtS: 1, intervalS: 5 } });
      const snaps: string[] = [];
      for (let i = 0; i < 180 + 1500; i++) {
        w.step(DT);
        const s = w.snapshot().serpent;
        if (s !== undefined) snaps.push(JSON.stringify(s));
      }
      return { log: w.serpent?.rollLog, events, snaps };
    };
    const x = run();
    const y = run();
    expect(x.events.filter((e) => e.type.startsWith('serpent')).length).toBeGreaterThan(4);
    expect(x.log).toEqual(y.log);
    expect(x.events).toEqual(y.events);
    expect(x.snaps).toEqual(y.snaps);
    // a different seed gives a different story
    const other = new World(cfg('ocean'), 4243, new EventBus(), { traps: false, serpent: { chance: 0.5, firstAtS: 1, intervalS: 5 } });
    for (let i = 0; i < 180 + 1500; i++) other.step(DT);
    expect(JSON.stringify(other.serpent?.rollLog)).not.toBe(JSON.stringify(x.log));
  });
});

describe('arenas without hazards.serpent never see the serpent', () => {
  const roster = ANIMAL_IDS.map((a, i) => ({ animal: a, isPlayer: i === 0 }));

  it('the colosseum and the jungle have no serpent system, ignore the options and the debug hook, and never emit serpent data', () => {
    expect(COLOSSEUM_ARENA.hazards).toBeUndefined();
    expect(JUNGLE_ARENA.hazards).toBeUndefined();
    for (const arena of ['colosseum', 'jungle'] as const) {
      const events: GameEvent[] = [];
      const bus = new EventBus();
      bus.onAny((e) => events.push(e));
      const w = new World({ roster, difficulty: 1, arena }, 5, bus, { traps: false, serpent: { chance: 1, firstAtS: 0.1 } });
      expect(w.serpent).toBeNull();
      expect(w.debugTriggerSerpent(90)).toBe(false);
      for (let i = 0; i < 180 + 600; i++) {
        w.step(DT);
        expect('serpent' in w.snapshot()).toBe(false);
      }
      expect(events.some((e) => e.type.startsWith('serpent'))).toBe(false);
      expect(events.some((e) => e.type === 'death' && 'cause' in e)).toBe(false);
    }
  });

  it('the snapshot of a serpent arena has no `serpent` key while no event runs, so its JSON is unchanged', () => {
    const w = new World({ roster, difficulty: 1, arena: 'ocean' }, 5, new EventBus(), { traps: false });
    for (let i = 0; i < 200; i++) w.step(DT);
    expect('serpent' in w.snapshot()).toBe(false);
    expect(w.debugTriggerSerpent(10)).toBe(true);
    expect('serpent' in w.snapshot()).toBe(false); // queued: it starts with the next tick
    w.step(DT);
    expect('serpent' in w.snapshot()).toBe(true);
  });
});
