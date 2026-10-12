/**
 * v1.9 sea serpent — timeline, geometry, true damage, altitude / burrow immunity, kill attribution, snapshot and events (WP-O1b).
 * Runs on a flat, obstacle-free test dome (see serpentHelpers) so the numbers do not depend on the Ocean Dome's layout.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { SerpentSystem } from '../../src/sim/SerpentSystem';
import { SERPENT, SERPENT_EVENT_S, serpentStrikeSpeed } from '../../src/config/serpent';
import { ANIMALS } from '../../src/config/animals';
import type { GameEvent, SerpentState } from '../../src/core/types';
import {
  DT,
  FLAT_ARENA,
  R,
  arenaWithRaisedDisc,
  installOcean,
  neutralIntent,
  ofType,
  oceanWorld,
  place,
  runToEnd,
  stand,
  stubSim,
  trueDeal,
} from './serpentHelpers';

beforeAll(() => installOcean(FLAT_ARENA));

/** Runs a stub-sim event started at `angleDeg` to its end; returns the events. */
function runStub(sys: SerpentSystem, sim: ReturnType<typeof stubSim>['sim'], angleDeg: number, ticks = 400): void {
  expect(sys.trigger(angleDeg)).toBe(true);
  for (let i = 0; i < ticks && sys.active; i++) {
    sim.time += DT;
    sys.step(sim, DT, trueDeal);
  }
}

const hits = (events: GameEvent[]) => ofType(events, 'serpentHit');

describe('timeline and snapshot', () => {
  it('WARN -> STRIKE -> HOLD -> RETREAT take the configured seconds, then one serpentEnd and no snapshot', () => {
    const { world, events } = oceanWorld(['lion', 'gorilla'], 3);
    expect(world.snapshot().serpent).toBeUndefined();
    expect(world.debugTriggerSerpent(137.5)).toBe(true);
    expect(world.debugTriggerSerpent(10)).toBe(false); // one event at a time (also while one is queued)
    expect(world.snapshot().serpent).toBeUndefined(); // queued: it starts with the next tick
    world.step(DT); // the start tick: the warning is emitted, the event shows t = 0
    const perPhase: Record<string, SerpentState[]> = { warn: [], strike: [], hold: [], retreat: [] };
    let s = world.snapshot().serpent;
    let ticks = 0;
    while (s !== undefined && ticks < 400) {
      perPhase[s.phase].push(s);
      world.step(DT);
      ticks++;
      s = world.snapshot().serpent;
    }
    const near = (n: number, secs: number): void => {
      expect(n).toBeGreaterThanOrEqual(Math.floor(secs / DT) - 1);
      expect(n).toBeLessThanOrEqual(Math.ceil(secs / DT) + 1);
    };
    near(perPhase.warn.length, SERPENT.warnS);
    near(perPhase.strike.length, SERPENT.strikeS);
    near(perPhase.hold.length, SERPENT.holdS);
    near(perPhase.retreat.length, SERPENT.retreatS);
    near(ticks, SERPENT_EVENT_S);
    // the clock restarts at each phase and stays below the phase length
    for (const [phase, dur] of [['warn', SERPENT.warnS], ['strike', SERPENT.strikeS], ['hold', SERPENT.holdS], ['retreat', SERPENT.retreatS]] as const) {
      expect(perPhase[phase][0].t).toBeLessThan(DT + 1e-9);
      for (const st of perPhase[phase]) {
        expect(st.t).toBeGreaterThanOrEqual(0);
        expect(st.t).toBeLessThan(dur + 1e-9);
        expect(st.angleDeg).toBe(137.5);
      }
    }
    // head distance: parked at the wall while warning, 30 -> 0 in the strike, 0 while holding, 0 -> 30 on the retreat
    expect(perPhase.warn.every((st) => st.headR === R)).toBe(true);
    expect(perPhase.strike[0].headR).toBeCloseTo(R, 6);
    expect(perPhase.strike[perPhase.strike.length - 1].headR).toBeLessThan(serpentStrikeSpeed(R) * DT + 1e-6);
    for (let i = 1; i < perPhase.strike.length; i++) expect(perPhase.strike[i].headR).toBeLessThan(perPhase.strike[i - 1].headR);
    expect(perPhase.hold.every((st) => st.headR === 0)).toBe(true);
    for (let i = 1; i < perPhase.retreat.length; i++) expect(perPhase.retreat[i].headR).toBeGreaterThan(perPhase.retreat[i - 1].headR);
    expect(perPhase.retreat[perPhase.retreat.length - 1].headR).toBeGreaterThan(R - (R / SERPENT.retreatS) * DT - 1e-6);
    // the head's speed is wallRadius / strikeS
    const dR = perPhase.strike[1].headR - perPhase.strike[2].headR;
    expect(dR / DT).toBeCloseTo(serpentStrikeSpeed(R), 3);
    // events: warning, strike, end, once each, in order
    const names = events.map((e) => e.type).filter((t) => t.startsWith('serpent'));
    expect(names).toEqual(['serpentWarning', 'serpentStrike', 'serpentEnd']);
    const warn = ofType(events, 'serpentWarning')[0];
    expect(warn.angleDeg).toBe(137.5);
    expect(warn.warnS).toBe(SERPENT.warnS);
    expect(ofType(events, 'serpentStrike')[0].angleDeg).toBe(137.5);
    expect(world.snapshot().serpent).toBeUndefined();
    expect(world.serpent?.active).toBe(false);
  });

  it('debugTriggerSerpent normalises the angle, draws one from the serpent stream when omitted, and can run again after the end', () => {
    const { world } = oceanWorld(['lion', 'gorilla'], 3);
    expect(world.debugTriggerSerpent(-90)).toBe(true);
    world.step(DT);
    expect(world.snapshot().serpent?.angleDeg).toBe(270);
    runToEnd(world);
    expect(world.debugTriggerSerpent(725)).toBe(true);
    world.step(DT);
    expect(world.snapshot().serpent?.angleDeg).toBe(5);
    runToEnd(world);
    expect(world.debugTriggerSerpent()).toBe(true);
    world.step(DT);
    const a = world.snapshot().serpent?.angleDeg as number;
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(360);
  });

  it('the match ending mid-event ends the event at once (no frozen half-strike on the results screen)', () => {
    const { world, events } = oceanWorld(['lion', 'gorilla'], 3);
    place(world, 0, 5, 20);
    place(world, 1, 15, 0); // on the line
    world.fighters[1].state.hp = 100; // the strike kills the only opponent
    world.debugTriggerSerpent(0);
    runToEnd(world);
    expect(world.matchOver).toBe(true);
    expect(world.snapshot().serpent).toBeUndefined();
    const names = events.map((e) => e.type).filter((t) => t === 'serpentHit' || t === 'death' || t === 'matchEnd' || t === 'serpentEnd');
    expect(names).toEqual(['serpentHit', 'death', 'matchEnd', 'serpentEnd']);
    expect(ofType(events, 'serpentEnd')).toHaveLength(1);
  });
});

describe('geometry (swept capsule, half-width + body radius)', () => {
  const R0 = SERPENT.headRadius;

  it('a fighter on the line is hit exactly once, 300 true damage, even though the head sweeps over it for several ticks', () => {
    const f = stand(0, 'lion', 15, 0);
    const { sim, events } = stubSim([f]);
    const sys = new SerpentSystem(1, FLAT_ARENA);
    runStub(sys, sim, 0);
    expect(hits(events)).toHaveLength(1);
    expect(hits(events)[0]).toMatchObject({ fighterId: 0, damage: 300, pos: { x: 15, y: 0, z: 0 } });
    expect(f.state.hp).toBe(f.state.maxHp - 300);
  });

  it('the hit comes during the STRIKE only, when the head reaches the fighter (not during the warning)', () => {
    const f = stand(0, 'lion', 15, 0);
    const { sim, events } = stubSim([f]);
    const sys = new SerpentSystem(1, FLAT_ARENA);
    sys.trigger(0);
    let hitTick = -1;
    let strikeTick = -1;
    for (let i = 0; i < 400 && sys.active; i++) {
      sim.time += DT;
      sys.step(sim, DT, trueDeal);
      if (strikeTick < 0 && events.some((e) => e.type === 'serpentStrike')) strikeTick = i;
      if (hitTick < 0 && hits(events).length > 0) hitTick = i;
    }
    expect(strikeTick).toBeGreaterThan(Math.floor(SERPENT.warnS / DT) - 3);
    expect(hitTick).toBeGreaterThanOrEqual(strikeTick);
    // the head reaches the fighter when its centre is (half-width + body radius) beyond it: r = 15 + 1.8 + 0.7
    const want = (R - (15 + SERPENT.headRadius + ANIMALS.lion.radius)) / serpentStrikeSpeed(R) / DT;
    const dTicks = hitTick - strikeTick;
    expect(dTicks).toBeGreaterThanOrEqual(Math.floor(want) - 1);
    expect(dTicks).toBeLessThanOrEqual(Math.ceil(want) + 1);
  });

  it('lateral edge: just inside half-width + radius is hit, just outside is not (every animal radius)', () => {
    for (const animal of Object.keys(ANIMALS) as (keyof typeof ANIMALS)[]) {
      const rad = ANIMALS[animal].radius;
      for (const [off, want] of [[R0 + rad - 0.05, true], [R0 + rad + 0.05, false], [0, true]] as const) {
        const f = stand(0, animal, 12, off);
        const { sim, events } = stubSim([f]);
        runStub(new SerpentSystem(1, FLAT_ARENA), sim, 0);
        expect(hits(events).length, `${animal} offset ${off}`).toBe(want ? 1 : 0);
        expect(f.state.hp).toBe(want ? f.state.maxHp - 300 : f.state.maxHp);
      }
    }
  });

  it('works for any direction: a fighter on the line at angle 213.7 deg is hit, one 5 m beside it is not', () => {
    const a = (213.7 * Math.PI) / 180;
    const on = stand(0, 'gorilla', 18 * Math.cos(a), 18 * Math.sin(a));
    const side = stand(1, 'gorilla', 18 * Math.cos(a) - 5 * Math.sin(a), 18 * Math.sin(a) + 5 * Math.cos(a));
    const opposite = stand(2, 'gorilla', -18 * Math.cos(a), -18 * Math.sin(a)); // the far side of the dome: the line stops at the centre
    const { sim, events } = stubSim([on, side, opposite]);
    runStub(new SerpentSystem(1, FLAT_ARENA), sim, 213.7);
    expect(hits(events).map((h) => h.fighterId)).toEqual([0]);
  });

  it('edge cases: pressed against the dome wall on the line is hit at the very start; the centre is hit at the very end; just behind the centre only within the head radius', () => {
    const rad = ANIMALS.lion.radius;
    const wall = stand(0, 'lion', R - rad, 0); // as far out as the wall clamp allows
    const centre = stand(1, 'lion', 0, 0);
    const behindNear = stand(2, 'lion', -(R0 + rad - 0.1), 0); // inside the head disc when it reaches the centre
    const behindFar = stand(3, 'lion', -(R0 + rad + 0.1), 0);
    const { sim, events } = stubSim([wall, centre, behindNear, behindFar]);
    const sys = new SerpentSystem(1, FLAT_ARENA);
    sys.trigger(0);
    const hitAt: Record<number, number> = {};
    let strike0 = -1;
    for (let i = 0; i < 400 && sys.active; i++) {
      sim.time += DT;
      sys.step(sim, DT, trueDeal);
      if (strike0 < 0 && events.some((e) => e.type === 'serpentStrike')) strike0 = i;
      for (const h of hits(events)) if (hitAt[h.fighterId] === undefined) hitAt[h.fighterId] = i;
    }
    expect(Object.keys(hitAt).map(Number).sort()).toEqual([0, 1, 2]);
    expect(hitAt[0] - strike0).toBeLessThanOrEqual(1); // the head starts AT the wall
    // the head is within (half-width + radius) of the centre for the last (2.5 m / 68 m/s) of the strike
    const lastTicks = SERPENT.strikeS / DT;
    expect(hitAt[1] - strike0).toBeGreaterThanOrEqual(lastTicks - 4);
    expect(hitAt[1] - strike0).toBeLessThanOrEqual(lastTicks + 1);
    expect(hitAt[2] - strike0).toBeGreaterThanOrEqual(lastTicks - 4);
  });

  it('the swept capsule does not tunnel: a fast head (54.5 m/s = 0.9 m per tick) never skips a fighter standing anywhere on the line', () => {
    for (let x = 0; x <= 29; x += 0.37) {
      const f = stand(0, 'mole', x, 0);
      const { sim, events } = stubSim([f]);
      runStub(new SerpentSystem(1, FLAT_ARENA), sim, 0);
      expect(hits(events), `x=${x}`).toHaveLength(1);
    }
  });

  it('after the head has passed a point it does not damage there: hold / retreat and the trailing body are harmless', () => {
    const late = stand(0, 'lion', 20, 0);
    late.state.pos.z = 40; // parked off the arena; moved onto the line once the head has gone by
    const { sim, events } = stubSim([late]);
    const sys = new SerpentSystem(1, FLAT_ARENA);
    sys.trigger(0);
    let moved = false;
    for (let i = 0; i < 400 && sys.active; i++) {
      sim.time += DT;
      sys.step(sim, DT, trueDeal);
      if (!moved && sys.phase === 'hold') {
        late.state.pos.z = 0; // onto the line at r = 20, behind the head (which is at the centre)
        moved = true;
      }
    }
    expect(moved).toBe(true);
    expect(hits(events)).toHaveLength(0);
    expect(late.state.hp).toBe(late.state.maxHp);
    // ...and nobody is hurt while the serpent is only warning
    const early = stand(0, 'lion', 15, 0);
    const s2 = stubSim([early]);
    const sys2 = new SerpentSystem(1, FLAT_ARENA);
    sys2.trigger(0);
    for (let i = 0; i < Math.floor(SERPENT.warnS / DT) - 3; i++) {
      s2.sim.time += DT;
      sys2.step(s2.sim, DT, trueDeal);
    }
    expect(sys2.phase).toBe('warn');
    expect(early.state.hp).toBe(early.state.maxHp);
  });

  it('several fighters on the line are all hit once each, in ascending id order, nobody off the line', () => {
    const fs = [stand(0, 'lion', 25, 0), stand(1, 'rhino', 8, 0.5), stand(2, 'eagle', 16, -1), stand(3, 'hippo', 16, 4), stand(4, 'mole', 3, 0)];
    const { sim, events } = stubSim(fs);
    runStub(new SerpentSystem(2, FLAT_ARENA), sim, 0);
    expect(hits(events).map((h) => h.fighterId).sort()).toEqual([0, 1, 2, 4]);
    expect(fs[3].state.hp).toBe(fs[3].state.maxHp);
  });

  it('a dead fighter is ignored', () => {
    const f = stand(0, 'lion', 12, 0);
    f.state.alive = false;
    f.state.hp = 0;
    const { sim, events } = stubSim([f]);
    runStub(new SerpentSystem(1, FLAT_ARENA), sim, 0);
    expect(hits(events)).toHaveLength(0);
  });
});

describe('altitude above the LOCAL ground, burrow and untargetable immunity', () => {
  it('a soaring eagle / anyone more than 3 m above the ground is untouched; at or below 3 m is hit', () => {
    for (const [y, want] of [[0, true], [1.5, true], [2.99, true], [3.0, true], [3.05, false], [6, false], [20, false]] as const) {
      const f = stand(0, 'eagle', 14, 0, y);
      const { sim, events } = stubSim([f]);
      runStub(new SerpentSystem(1, FLAT_ARENA), sim, 0);
      expect(hits(events).length, `altitude ${y}`).toBe(want ? 1 : 0);
    }
  });

  it('measures altitude above the LOCAL ground via arenaGroundHeight: standing on a 3.5 m raised level is hit, 3.3 m above it is not', () => {
    const raised = arenaWithRaisedDisc(14, 5, 3.5);
    const standing = stand(0, 'lion', 14, 0, 3.5); // feet on the raised level: altitude 0
    const soaring = stand(1, 'eagle', 14, 2, 3.5 + 3.3); // 3.3 m above the raised level
    const hovering = stand(2, 'eagle', 14, -2, 3.5 + 2.9); // 2.9 m above it: still within reach
    const { sim, events } = stubSim([standing, soaring, hovering], raised);
    runStub(new SerpentSystem(1, raised), sim, 0);
    expect(hits(events).map((h) => h.fighterId).sort()).toEqual([0, 2]);
    // the same height OFF the raised level is out of reach (3.5 m above the sea bed)
    const off = stand(0, 'lion', 24, 0, 3.5);
    const s2 = stubSim([off], raised);
    runStub(new SerpentSystem(1, raised), s2.sim, 0);
    expect(hits(s2.events)).toHaveLength(0);
  });

  it('a burrowed mole and any untargetable fighter are immune', () => {
    const mole = stand(0, 'mole', 14, 0);
    mole.state.burrowT = 0.5;
    const ghost = stand(1, 'eagle', 8, 0);
    ghost.untargetable = true;
    const normal = stand(2, 'lion', 20, 0);
    const { sim, events } = stubSim([mole, ghost, normal]);
    runStub(new SerpentSystem(1, FLAT_ARENA), sim, 0);
    expect(hits(events).map((h) => h.fighterId)).toEqual([2]);
    expect(mole.state.hp).toBe(mole.state.maxHp);
    expect(ghost.state.hp).toBe(ghost.state.maxHp);
  });

  it('World: an eagle held 6 m up through the strike is untouched while the grounded fighters on the line are hit', () => {
    const { world, events } = oceanWorld(['lion', 'eagle', 'rhino', 'gorilla'], 5);
    place(world, 0, 20, 0);
    place(world, 1, 14, 0.5, 6);
    place(world, 2, 8, 0);
    place(world, 3, 0, -22); // off the line
    world.debugTriggerSerpent(0);
    for (let i = 0; i < 260 && world.serpent?.active; i++) {
      place(world, 1, world.fighters[1].state.pos.x, world.fighters[1].state.pos.z, 6); // hold the soar
      world.step(DT);
    }
    expect(new Set(hits(events).map((h) => h.fighterId))).toEqual(new Set([0, 2]));
    expect(world.fighters[1].state.hp).toBe(world.fighters[1].state.maxHp);
  });
});

describe('true damage through the real World pipeline', () => {
  const ROSTER = ['lion', 'rhino', 'gorilla', 'hippo', 'panther'] as const;

  /** Two identical worlds; the second suffers a serpent strike along +x. Everyone stands still. */
  function twin(setup: (w: ReturnType<typeof oceanWorld>['world']) => void) {
    const a = oceanWorld([...ROSTER], 8);
    const b = oceanWorld([...ROSTER], 8);
    for (const { world } of [a, b]) {
      place(world, 0, 22, 0); // victim: blocking, on the line
      place(world, 1, 10, 0.4); // victim: armoured
      place(world, 2, 0, -22);
      place(world, 3, -22, 0);
      place(world, 4, 0, 22);
      setup(world);
    }
    return { quiet: a, struck: b };
  }

  function play(w: ReturnType<typeof oceanWorld>, strike: boolean): void {
    if (strike) w.world.debugTriggerSerpent(0);
    const intent0 = { ...neutralIntent(), block: true };
    for (let i = 0; i < 260; i++) {
      w.world.setIntent(0, intent0);
      w.world.step(DT);
    }
  }

  it('a BLOCKING fighter loses exactly 300 hp; block, guard, damageBlocked, ult charge, kills and damageDealt are untouched', () => {
    const { quiet, struck } = twin(() => undefined);
    play(quiet, false);
    play(struck, true);
    const q = quiet.world.fighters[0].state;
    const s = struck.world.fighters[0].state;
    expect(s.hp).toBe(q.hp - 300);
    expect(s.hp).toBe(s.maxHp - 300);
    // everything except hp is identical to the fighter that was not struck
    const strip = (st: typeof s) => ({ ...st, hp: 0 });
    expect(strip(s)).toEqual(strip(q));
    expect(s.action).toBe('block');
    expect(s.damageBlocked).toBe(0);
    expect(s.guard).toBe(q.guard);
    expect(s.ultCharge).toBe(0);
    for (const f of struck.world.fighters) {
      expect(f.state.ultCharge).toBe(0); // nobody gained charge (not even the victims' damage-taken lever)
      expect(f.state.damageDealt).toBe(0);
      expect(f.state.kills).toBe(0);
      expect(f.hitstunTimer).toBe(0);
      expect(f.staggerTimer).toBe(0);
      expect(f.knockdownTimer).toBe(0);
    }
    const hit = hits(struck.events);
    expect(hit.map((h) => [h.fighterId, h.damage])).toEqual([[0, 300], [1, 300]].sort((a, b) => a[0] - b[0]));
    // the others were not on the line
    for (const id of [2, 3, 4]) expect(struck.world.fighters[id].state.hp).toBe(struck.world.fighters[id].state.maxHp);
  });

  it('armour, damage-reduction buffs and Rhino bulk never change it: the victim loses exactly 300', () => {
    const { struck } = twin((w) => {
      const st = w.fighters[1].state;
      st.buffs.push({ kind: 'armorUp', t: 20, dur: 20, mag: 0.8 });
      st.buffs.push({ kind: 'stealth', t: 20, dur: 20, mag: 1 });
      w.fighters[1].incomingDamageReduction = 0.7; // as if grabbed by a python
    });
    play(struck, true);
    expect(struck.world.fighters[1].state.hp).toBe(struck.world.fighters[1].state.maxHp - 300);
    expect(struck.world.fighters[0].state.hp).toBe(struck.world.fighters[0].state.maxHp - 300);
  });

  it('a kill credits nobody: killerId -1, death.cause "serpent", previous attacker loses the credit, hit.damage = hp actually removed', () => {
    const { struck } = twin(() => undefined);
    const victim = struck.world.fighters[1];
    victim.state.hp = 120;
    victim.lastAttackerId = 3; // the hippo had been hitting it
    play(struck, true);
    expect(victim.state.alive).toBe(false);
    const death = ofType(struck.events, 'death').filter((d) => d.targetId === 1);
    expect(death).toHaveLength(1);
    expect(death[0]).toEqual({ type: 'death', targetId: 1, killerId: -1, placement: 10, cause: 'serpent' });
    expect(struck.world.fighters[3].state.kills).toBe(0);
    const h = hits(struck.events).find((e) => e.fighterId === 1);
    expect(h?.damage).toBe(120);
    // the hit is reported before the death, in the same tick
    const names = struck.events.map((e) => (e.type === 'serpentHit' && e.fighterId === 1 ? 'hit1' : e.type === 'death' ? 'death' : ''));
    expect(names.indexOf('hit1')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('hit1')).toBeLessThan(names.indexOf('death'));
  });

  it('only a serpent kill carries cause: a survivor later killed by a fighter, and a plain kill, have none', () => {
    const { struck } = twin(() => undefined);
    const w = struck.world;
    w.fighters[1].state.hp = 400; // survives the 300 with 100 left
    play(struck, true);
    expect(w.fighters[1].state.alive).toBe(true);
    expect(w.fighters[1].state.hp).toBe(100);
    // now the lion kills it (credit goes to the lion as usual) and a plain kill of another fighter
    w.dealHp(w.fighters[2], w.fighters[1], 500);
    w.dealHp(w.fighters[2], w.fighters[3], 99999);
    w.step(DT);
    const deaths = ofType(struck.events, 'death');
    expect(deaths.map((d) => [d.targetId, d.killerId, 'cause' in d])).toEqual([[1, 2, false], [3, 2, false]]);
    expect(w.fighters[2].state.kills).toBe(2);
  });

  it('kills by traps keep their old shape (killerId -1, no cause key)', () => {
    const { struck } = twin(() => undefined);
    const w = struck.world;
    w.applyTrapDamage(w.fighters[4], 99999);
    w.step(DT);
    const d = ofType(struck.events, 'death')[0];
    expect(d).toEqual({ type: 'death', targetId: 4, killerId: -1, placement: 10 });
    expect('cause' in d).toBe(false);
  });
});
