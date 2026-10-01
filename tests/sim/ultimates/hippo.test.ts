/**
 * Hippo — Riverlord's Flood (v1.3): gape-and-bellow windup with the path marked, then a wave surges along an
 * 11 m x 3.4 m line at 14 m/s hitting everyone once (130 + shove + stagger) and leaving a mud pool (5.5 s, -40%
 * speed for grounded fighters; the hippo itself is unaffected).
 */

import { describe, it, expect } from 'vitest';
import { liveWorld, neutral, disablePickups, DT } from '../helpers';
import { ANIMALS } from '../../../src/config/animals';
import { HIPPO_FLOOD, floodSurgeS } from '../../../src/config/ultimates/hippo';
import type { AnimalId, Difficulty, FighterIntent, GameEvent, GameEventOf, MatchConfig } from '../../../src/core/types';
import type { World } from '../../../src/sim/World';
import type { Fighter } from '../../../src/sim/Fighter';
import { dealDamage } from '../../../src/sim/CombatSystem';
import { addBuff, getBuff } from '../../../src/sim/StatusEffects';
import { floodPath } from '../../../src/sim/ultimates/hippo';
import { zoneExtent, zoneOverlaps } from '../../../src/sim/groundZones';
import { DangerZones } from '../../../src/ai/dangerZones';
import { synth, type UltAudioApi } from '../../../src/audio/ults';
import hippoAudio from '../../../src/audio/ults/hippo';
import { World as BotWorld } from '../../../src/sim/World';
import { EventBus } from '../../../src/core/EventBus';
import { BotManager } from '../../../src/ai/BotManager';
import { decideAbilities, type Situation, type AbilityWish } from '../../../src/ai/scripts';
import { BOT_PROFILES } from '../../../src/config/botProfiles';
import { mulberry32 } from '../../../src/core/math';
import { WALL_RADIUS } from '../../../src/config/arena';

type Timed = { tick: number; ev: GameEvent };

interface Fx {
  world: World;
  events: GameEvent[];
  log: Timed[];
  tick: number;
  c: Fighter;
  t: Fighter;
  intents: Map<number, FighterIntent>;
}

function ofType<T extends GameEvent['type']>(log: Timed[], type: T): { tick: number; ev: GameEventOf<T> }[] {
  return log.filter((e) => e.ev.type === type) as { tick: number; ev: GameEventOf<T> }[];
}

const SURGE = floodSurgeS(HIPPO_FLOOD.length);

/** Hippo at the origin facing +z; a lion victim `targetDist` metres ahead (and `lateral` m to the side). */
function fixture(roster: AnimalId[] = ['hippo', 'lion'], targetDist = 5, lateral = 0): Fx {
  const events: GameEvent[] = [];
  const { world } = liveWorld(roster, 7, events);
  disablePickups(world);
  const fs = world.fighters;
  const c = fs[0];
  const t = fs[1];
  c.state.pos = { x: 0, y: 0, z: 0 };
  c.state.yaw = 0;
  c.state.vel = { x: 0, y: 0, z: 0 };
  t.state.pos = { x: lateral, y: 0, z: targetDist };
  t.state.yaw = Math.PI;
  t.state.vel = { x: 0, y: 0, z: 0 };
  for (let i = 2; i < fs.length; i++) fs[i].state.pos = { x: -25 + i, y: 0, z: -22 };
  return { world, events, log: [], tick: 0, c, t, intents: new Map() };
}

function step(fx: Fx, casterIntent?: Partial<FighterIntent>): void {
  const n0 = fx.events.length;
  for (const f of fx.world.fighters) {
    const base = neutral();
    const custom = fx.intents.get(f.id);
    fx.world.setIntent(f.id, { ...base, ...(f.id === 0 ? casterIntent : undefined), ...custom });
  }
  fx.world.step(DT);
  fx.tick++;
  for (let i = n0; i < fx.events.length; i++) fx.log.push({ tick: fx.tick, ev: fx.events[i] });
}

function cast(fx: Fx): void {
  fx.c.state.ultCharge = 100;
  step(fx, { ultimate: true });
}

function runUntil(fx: Fx, done: () => boolean, max = 900): void {
  for (let i = 0; i < max && !done(); i++) step(fx);
}

const stageSeen = (fx: Fx, n: number): boolean => ofType(fx.log, 'ultimateStage').some((s) => s.ev.stage === n);
/** Cast and run to the slam (stage 1). */
function toSlam(fx: Fx): void {
  cast(fx);
  runUntil(fx, () => stageSeen(fx, 1));
}
const hitsOn = (fx: Fx, id: number): { tick: number; ev: GameEventOf<'hit'> }[] => ofType(fx.log, 'hit').filter((h) => h.ev.targetId === id);
const slowOf = (f: Fighter): number => getBuff(f, 'slow')?.mag ?? 0;

describe("hippo Riverlord's Flood — config", () => {
  const spec = ANIMALS.hippo.ultimate;
  it('is an 11 m x 3.4 m line with the flood numbers and a fixed dodge zone covering windup + surge + mud', () => {
    expect(spec.name).toBe("Riverlord's Flood");
    expect(spec.description).toMatch(/mud/i);
    expect(spec.targeting?.kind).toBe('line');
    expect(spec.targeting?.range).toBe(11);
    expect(spec.targeting?.width).toBe(3.4);
    expect(spec.targeting?.requireTarget).toBeUndefined();
    expect(spec.targeting?.dodge?.mode).toBe('fixed');
    expect(spec.targeting?.dodge?.activeS).toBeCloseTo(SURGE + HIPPO_FLOOD.mudS, 9);
    expect(spec.windup).toBeCloseTo(0.9, 9);
    expect(spec.damage).toBe(130);
    expect(spec.knockback).toBe(5);
    expect(HIPPO_FLOOD.waveSpeed).toBe(14);
    expect(HIPPO_FLOOD.mudSlow).toBe(0.4);
    expect(HIPPO_FLOOD.mudS).toBe(5.5);
  });
});

describe("hippo Riverlord's Flood — cast and windup", () => {
  it('emits the line ultimateTarget (width 3.4, 11 m ahead, lead 0.9 s) after the ultimate event; spends the charge', () => {
    const fx = fixture();
    cast(fx);
    const tg = ofType(fx.log, 'ultimateTarget');
    expect(tg).toHaveLength(1);
    expect(tg[0].ev.kind).toBe('line');
    expect(tg[0].ev.width).toBe(3.4);
    expect(tg[0].ev.windup).toBeCloseTo(0.9, 9);
    expect(tg[0].ev.to.x).toBeCloseTo(0, 6);
    expect(tg[0].ev.to.z).toBeCloseTo(11, 6);
    const types = fx.log.map((l) => l.ev.type);
    expect(types.indexOf('ultimateTarget')).toBeGreaterThan(types.indexOf('ultimate'));
    expect(fx.c.state.ultCharge).toBe(0);
    expect(fx.c.state.ultPhase ?? fx.world.snapshot().fighters[0].ultPhase).toBe('windup');
  });

  it('the hippo plants itself during the gape: no movement, nothing is hit, no mud yet', () => {
    const fx = fixture();
    cast(fx);
    fx.intents.set(0, { ...neutral(), moveX: 1, moveZ: 1 });
    for (let i = 0; i < 40; i++) step(fx, { moveX: 1 });
    expect(fx.c.state.pos.x).toBeCloseTo(0, 6);
    expect(fx.c.state.pos.z).toBeCloseTo(0, 6);
    expect(fx.t.state.hp).toBe(fx.t.state.maxHp);
    expect(fx.world.groundZones.count).toBe(0);
    expect(fx.world.snapshot().fighters[0].ultPhase).toBe('windup');
  });

  it('the path is clipped at the arena wall (a hippo at the rim facing out gets a short flood)', () => {
    const fx = fixture(['hippo', 'lion'], 5);
    fx.c.state.pos = { x: 0, y: 0, z: WALL_RADIUS - 4 };
    fx.c.state.yaw = 0;
    fx.t.state.pos = { x: -10, y: 0, z: -10 };
    cast(fx);
    const tg = ofType(fx.log, 'ultimateTarget')[0].ev;
    const len = Math.hypot(tg.to.x - tg.from.x, tg.to.z - tg.from.z);
    expect(len).toBeLessThan(4);
    expect(len).toBeGreaterThanOrEqual(HIPPO_FLOOD.minLength - 1e-6);
  });

  it('a stagger during the windup interrupts the cast: no slam, no mud, charge stays spent', () => {
    const fx = fixture(['hippo', 'lion'], 4);
    cast(fx);
    for (let i = 0; i < 20; i++) step(fx);
    dealDamage(fx.world, fx.t, fx.c, 50, { blockable: false, heavy: true, reaction: 'stagger', isBasic: false });
    step(fx);
    expect(fx.c.ability).toBeNull();
    for (let i = 0; i < 200; i++) step(fx);
    expect(stageSeen(fx, 1)).toBe(false);
    expect(fx.world.groundZones.count).toBe(0);
    expect(fx.c.state.ultCharge).toBeLessThan(100);
  });
});

describe("hippo Riverlord's Flood — the wave", () => {
  it('slam: stage 1 at 0.9 s, the wave hits a foe in the path once for 130, then stage 2 and recovery', () => {
    const fx = fixture(['hippo', 'lion'], 5);
    toSlam(fx);
    const slam = ofType(fx.log, 'ultimateStage').find((s) => s.ev.stage === 1)!;
    expect(slam.tick * DT).toBeGreaterThan(0.85);
    expect(slam.tick * DT).toBeLessThan(1.0);
    runUntil(fx, () => fx.c.ability === null);
    const hits = hitsOn(fx, 1);
    expect(hits).toHaveLength(1);
    expect(hits[0].ev.damage).toBe(130);
    expect(fx.t.state.hp).toBeCloseTo(fx.t.state.maxHp - 130, 6);
    expect(stageSeen(fx, 2)).toBe(true);
    expect(fx.c.ability).toBeNull();
    expect(fx.c.ccImmuneChannel).toBe(false);
    expect(fx.c.state.action === 'idle' || fx.c.state.action === 'run').toBe(true);
  });

  it('hits land as the wave head passes: the near foe first, the far foe ~0.5 s later', () => {
    const fx = fixture(['hippo', 'lion', 'gorilla'], 3);
    const g = fx.world.fighters[2];
    g.state.pos = { x: 0, y: 0, z: 9.5 };
    g.state.yaw = Math.PI;
    toSlam(fx);
    runUntil(fx, () => fx.c.ability === null);
    const near = hitsOn(fx, 1)[0];
    const far = hitsOn(fx, 2)[0];
    expect(near).toBeDefined();
    expect(far).toBeDefined();
    const gap = (far.tick - near.tick) * DT;
    // ~6.5 m between them at 14 m/s (the near one is shoved forward too, so a little less/more).
    expect(gap).toBeGreaterThan(0.25);
    expect(gap).toBeLessThan(0.6);
  });

  it('resolves the rectangle: in = hit, too far to the side / behind / beyond the end = untouched', () => {
    const cases: { name: string; x: number; z: number; hit: boolean }[] = [
      { name: 'on the centre line', x: 0, z: 6, hit: true },
      { name: 'near the edge (within half width + radius)', x: 1.7 + 0.6, z: 6, hit: true },
      { name: 'just outside the edge', x: 1.7 + 0.7 + 0.15, z: 6, hit: false },
      { name: 'behind the hippo', x: 0, z: -3, hit: false },
      { name: 'beyond the far end', x: 0, z: 11 + 0.7 + 0.3, hit: false },
      { name: 'at the far end (body reaches the end)', x: 0, z: 11.4, hit: true },
    ];
    for (const c of cases) {
      const fx = fixture(['hippo', 'lion'], 6);
      fx.t.state.pos = { x: c.x, y: 0, z: c.z };
      toSlam(fx);
      runUntil(fx, () => fx.c.ability === null);
      expect(hitsOn(fx, 1).length > 0, c.name).toBe(c.hit);
    }
  });

  it('every fighter in the path is hit exactly once (three in a line), damage identical', () => {
    const fx = fixture(['hippo', 'lion', 'gorilla', 'panther'], 3);
    fx.world.fighters[2].state.pos = { x: 0.6, y: 0, z: 6.5 };
    fx.world.fighters[3].state.pos = { x: -0.8, y: 0, z: 9.5 };
    toSlam(fx);
    runUntil(fx, () => fx.c.ability === null);
    for (const id of [1, 2, 3]) {
      const h = hitsOn(fx, id);
      expect(h, `fighter ${id}`).toHaveLength(1);
    }
    // Lion is not blocked, unstaggered: exactly 130.
    expect(hitsOn(fx, 1)[0].ev.damage).toBe(130);
  });

  it('shoves the foe ~5 m along the line (not sideways) and staggers it', () => {
    const fx = fixture(['hippo', 'lion'], 4, 0.4);
    toSlam(fx);
    let staggered = false;
    for (let i = 0; i < 90; i++) {
      step(fx);
      if (fx.t.staggerTimer > 0) staggered = true;
    }
    expect(staggered).toBe(true);
    expect(fx.t.state.pos.z - 4).toBeGreaterThan(3.8);
    expect(fx.t.state.pos.z - 4).toBeLessThan(5.8); // the 0.15 s impulse integrates over 10 ticks: 5 m nominal, ~5.5 m in practice
    expect(Math.abs(fx.t.state.pos.x - 0.4)).toBeLessThan(0.3);
  });

  it('is blockable: a guard facing the hippo takes the reduced damage (the shove still applies)', () => {
    const fx = fixture(['hippo', 'lion'], 4);
    fx.intents.set(1, { ...neutral(), block: true, aimYaw: Math.PI }); // a guard raised toward the hippo
    toSlam(fx);
    runUntil(fx, () => fx.c.ability === null);
    const lost = fx.t.state.maxHp - fx.t.state.hp;
    expect(lost).toBeGreaterThan(0);
    expect(lost).toBeLessThan(130 * (1 - ANIMALS.lion.blockReduction) + 1);
    expect(ofType(fx.log, 'blocked').length).toBeGreaterThan(0);
  });

  it('a high jump / flight clears the flood: nothing is hit above the ground-reach altitude', () => {
    const fx = fixture(['hippo', 'lion'], 6);
    toSlam(fx);
    fx.t.state.pos.y = 3.2;
    fx.t.state.vel.y = 0;
    for (let i = 0; i < 3; i++) {
      fx.t.state.pos.y = 3.2;
      step(fx);
    }
    expect(hitsOn(fx, 1)).toHaveLength(0);
  });

  it('the surge cannot be interrupted (CC-immune) and ends with a recovery the hippo can be hit in', () => {
    const fx = fixture(['hippo', 'lion'], 8);
    toSlam(fx);
    step(fx);
    dealDamage(fx.world, fx.t, fx.c, 10, { blockable: false, heavy: true, reaction: 'stagger', isBasic: false });
    fx.c.interrupt();
    expect(fx.c.ability).not.toBeNull();
    runUntil(fx, () => stageSeen(fx, 2));
    expect(fx.c.ability).not.toBeNull(); // recovery runs
    expect(fx.c.ccImmuneChannel).toBe(false);
  });
});

describe("hippo Riverlord's Flood — the mud pool", () => {
  it('is laid at the slam along the path and grows with the wave (fully laid after the surge)', () => {
    const fx = fixture(['hippo', 'lion'], 5);
    toSlam(fx);
    expect(fx.world.groundZones.count).toBe(1);
    const z = fx.world.groundZones.list[0];
    expect(z.kind).toBe('mud');
    expect(z.len).toBeCloseTo(11, 6);
    expect(z.halfWidth).toBeCloseTo(1.7, 6);
    expect(zoneExtent(z)).toBeLessThan(1);
    const path = floodPath(fx.c.ability);
    expect(path).not.toBeNull();
    for (let i = 0; i < 60; i++) step(fx); // 0.79 s surge
    expect(zoneExtent(z)).toBeCloseTo(11, 6);
    expect(zoneOverlaps(z, 0, 10, 0.7)).toBe(true);
    expect(zoneOverlaps(z, 5, 6, 0.7)).toBe(false);
  });

  it('slows grounded foes 40% while they stand in it, but not the hippo itself', () => {
    const fx = fixture(['hippo', 'lion'], 5);
    toSlam(fx);
    for (let i = 0; i < 60; i++) step(fx);
    // After the surge the lion was shoved ~5 m (z ~ 10): still inside the pool.
    expect(fx.world.groundZones.count).toBe(1);
    fx.t.state.pos = { x: 0, y: 0, z: 7 };
    step(fx);
    expect(slowOf(fx.t)).toBeCloseTo(0.4, 9);
    expect(slowOf(fx.c)).toBe(0); // the lord of the river wades through unslowed
  });

  it('measurably slows movement: a runner covers ~60% of the distance inside the mud', () => {
    const run = (mud: boolean): number => {
      const fx = fixture(['hippo', 'lion'], 5);
      if (mud) {
        toSlam(fx);
        for (let i = 0; i < 60; i++) step(fx);
      } else {
        for (let i = 0; i < 100; i++) step(fx);
      }
      fx.t.state.pos = { x: -1.0, y: 0, z: 1.5 };
      fx.t.state.vel = { x: 0, y: 0, z: 0 };
      fx.intents.set(1, { ...neutral(), moveZ: 1 });
      for (let i = 0; i < 45; i++) step(fx); // 0.75 s: stay inside the 11 m pool
      return fx.t.state.pos.z - 1.5;
    };
    // x = -1.0 is inside the half width (1.7): the same path with no mud for comparison.
    const free = run(false);
    const slowed = run(true);
    expect(slowed / free).toBeGreaterThan(0.5);
    expect(slowed / free).toBeLessThan(0.72);
  });

  it('only grounded fighters are slowed (a jumper above 0.6 m is not), and the slow lingers 0.3 s', () => {
    const fx = fixture(['hippo', 'lion'], 5);
    toSlam(fx);
    for (let i = 0; i < 60; i++) step(fx);
    fx.t.state.pos = { x: 0, y: 0, z: 6 };
    step(fx);
    expect(slowOf(fx.t)).toBeGreaterThan(0);
    // Leave the pool: the buff runs out within 0.3 s.
    fx.t.state.pos = { x: 10, y: 0, z: 6 };
    for (let i = 0; i < 25; i++) step(fx);
    expect(slowOf(fx.t)).toBe(0);
    // A jumper high over the mud is not slowed.
    const t = fx.t;
    t.state.pos = { x: 0, y: 1.4, z: 6 };
    t.state.vel = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 3; i++) {
      t.state.pos.y = 1.4;
      step(fx);
    }
    expect(slowOf(t)).toBe(0);
  });

  it('expires 5.5 s after the slam; the slow is gone within the linger time', () => {
    const fx = fixture(['hippo', 'lion'], 5);
    toSlam(fx);
    const t0 = fx.tick;
    fx.t.state.pos = { x: 0, y: 0, z: 6 };
    // Keep the victim in place; find the expiry tick.
    let lastSlowTick = -1;
    let goneAt = -1;
    for (let i = 0; i < 60 * 8; i++) {
      fx.t.state.pos = { x: 0, y: 0, z: 6 };
      step(fx);
      if (slowOf(fx.t) > 0) lastSlowTick = fx.tick;
      if (goneAt < 0 && fx.world.groundZones.count === 0) goneAt = fx.tick;
    }
    expect((goneAt - t0) * DT).toBeGreaterThan(5.4);
    expect((goneAt - t0) * DT).toBeLessThan(5.7);
    expect((lastSlowTick - goneAt) * DT).toBeLessThan(HIPPO_FLOOD.slowLingerS + 2 * DT);
    expect(slowOf(fx.t)).toBe(0);
  });

  it('persists after the hippo dies, and a pool laid by a dead hippo still slows foes', () => {
    const fx = fixture(['hippo', 'lion', 'gorilla'], 5);
    toSlam(fx);
    fx.c.state.hp = 0;
    step(fx);
    expect(fx.c.state.alive).toBe(false);
    expect(fx.c.ability).toBeNull();
    expect(fx.c.ccImmuneChannel).toBe(false);
    expect(fx.world.groundZones.count).toBe(1);
    for (let i = 0; i < 60; i++) step(fx); // the pool keeps laying itself out without its owner
    fx.t.state.pos = { x: 0, y: 0, z: 5 };
    for (let i = 0; i < 5; i++) step(fx);
    expect(slowOf(fx.t)).toBeGreaterThan(0);
  });

  it('a stronger slow from another source is not weakened by the mud', () => {
    const fx = fixture(['hippo', 'lion'], 5);
    toSlam(fx);
    for (let i = 0; i < 60; i++) step(fx);
    fx.t.state.pos = { x: 0, y: 0, z: 6 };
    addBuff(fx.t, 'slow', 0.7, 2);
    step(fx);
    expect(slowOf(fx.t)).toBeCloseTo(0.7, 9);
  });
});

describe("hippo Riverlord's Flood — cleanup and determinism", () => {
  it('the hippo dying mid-windup ends the cast without mud and without stray flags', () => {
    const fx = fixture();
    cast(fx);
    for (let i = 0; i < 20; i++) step(fx);
    fx.c.state.hp = 0;
    step(fx);
    expect(fx.c.ability).toBeNull();
    expect(fx.c.ccImmuneChannel).toBe(false);
    for (let i = 0; i < 120; i++) step(fx);
    expect(fx.world.groundZones.count).toBe(0);
    expect(fx.t.state.hp).toBe(fx.t.state.maxHp);
  });

  it('the hippo dying mid-surge stops the wave hits', () => {
    const fx = fixture(['hippo', 'lion'], 10);
    toSlam(fx);
    fx.c.state.hp = 0;
    step(fx);
    for (let i = 0; i < 60; i++) step(fx);
    expect(hitsOn(fx, 1)).toHaveLength(0);
    expect(fx.c.ccImmuneChannel).toBe(false);
  });

  it('two identical runs match exactly (events, positions, hp, pool expiry)', () => {
    const run = (): string => {
      const fx = fixture(['hippo', 'lion', 'gorilla'], 4);
      fx.world.fighters[2].state.pos = { x: 0.5, y: 0, z: 8 };
      fx.intents.set(1, { ...neutral(), moveX: 0.3, moveZ: 0.6 });
      cast(fx);
      for (let i = 0; i < 60 * 8; i++) step(fx);
      const trace: string[] = [];
      for (const l of fx.log) if (l.ev.type === 'ultimateStage' || l.ev.type === 'hit') trace.push(JSON.stringify([l.tick, l.ev]));
      trace.push(JSON.stringify([fx.t.state.pos, fx.world.fighters[2].state.pos, fx.t.state.hp, fx.world.fighters[2].state.hp, fx.world.groundZones.count]));
      return trace.join('\n');
    };
    expect(run()).toBe(run());
  });
});

describe("hippo Riverlord's Flood — bot danger zone (fixed)", () => {
  it('ultimateTarget makes a live capsule over the path; it is still live through the surge and the mud', () => {
    const fx = fixture();
    const zones = new DangerZones();
    cast(fx);
    let fed = 0;
    let liveAtCast = false;
    let liveAtMudEnd = false;
    for (let i = 0; i < 60 * 8 && fx.tick < 60 * 7; i++) {
      step(fx);
      for (; fed < fx.log.length; fed++) zones.ingest(fx.log[fed].ev, fx.tick * DT, 0, 1, () => 'hippo');
      const z = zones.find(0);
      if (fx.tick === 2) {
        expect(z).toBeDefined();
        liveAtCast = z !== undefined && zones.isLive(z, fx.tick * DT);
        expect(z!.shape).toBe('capsule');
        expect(z!.r).toBeCloseTo(1.7, 6);
        expect(z!.bz).toBeCloseTo(11, 6);
      }
      if (fx.tick === Math.round((0.9 + SURGE + HIPPO_FLOOD.mudS - 0.3) / DT)) liveAtMudEnd = z !== undefined && zones.isLive(z, fx.tick * DT);
    }
    expect(liveAtCast).toBe(true);
    expect(liveAtMudEnd).toBe(true);
  });
});

// ── audio smoke test: the hooks run against a recording fake AudioContext (exponential ramps to <= 0 throw, like WebAudio) ──
function fakeParam(): Record<string, unknown> {
  const p: Record<string, unknown> = { value: 0 };
  p.setValueAtTime = (v: number) => {
    p.value = v;
    return p;
  };
  p.linearRampToValueAtTime = () => p;
  p.exponentialRampToValueAtTime = (v: number) => {
    if (!(v > 0)) throw new RangeError('exponentialRampToValueAtTime target must be > 0');
    return p;
  };
  p.cancelScheduledValues = () => p;
  return p;
}
function fakeNode(): Record<string, unknown> {
  const n: Record<string, unknown> = { type: '', buffer: null, onended: null };
  n.frequency = fakeParam();
  n.gain = fakeParam();
  n.Q = fakeParam();
  n.connect = (x: unknown) => x;
  n.disconnect = () => undefined;
  n.start = () => undefined;
  n.stop = () => undefined;
  return n;
}
function fakeAudioApi(): { api: UltAudioApi; voices: () => number } {
  let created = 0;
  const ctx = { currentTime: 10, createGain: fakeNode, createOscillator: fakeNode, createBiquadFilter: fakeNode, createBufferSource: fakeNode };
  const sc = {
    ctx,
    sfxBus: fakeNode(),
    musicBus: fakeNode(),
    noise: {},
    voices: {
      create: () => {
        created++;
        return { gain: fakeNode(), sources: [], startTime: 10 };
      },
      add: () => undefined,
    },
  };
  const api = { sc, now: 10, gainAt: () => 1, isListener: () => true, synth } as unknown as UltAudioApi;
  return { api, voices: () => created };
}

describe("hippo Riverlord's Flood — audio module", () => {
  const tgt = { type: 'ultimateTarget', fighterId: 0, animal: 'hippo', kind: 'line', targetId: -1, from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 11 }, range: 11, width: 3.4, windup: 0.9 } as GameEventOf<'ultimateTarget'>;
  const stage = (n: number): GameEventOf<'ultimateStage'> => ({ type: 'ultimateStage', fighterId: 0, animal: 'hippo', stage: n, targetId: -1, pos: { x: 0, y: 0, z: 1.6 } });
  it('bellow on cast, slam boom + rushing water on the slam, exhale on recovery; aborted casts fade the beds; never throws', () => {
    const fx = fakeAudioApi();
    hippoAudio.onTarget!(fx.api, tgt);
    const afterCast = fx.voices();
    expect(afterCast).toBeGreaterThanOrEqual(3);
    hippoAudio.onStage!(fx.api, stage(1));
    const afterSlam = fx.voices();
    expect(afterSlam).toBeGreaterThan(afterCast + 4);
    hippoAudio.onStage!(fx.api, stage(2));
    expect(fx.voices()).toBeGreaterThan(afterSlam);
    hippoAudio.onEnd!(fx.api, 0);
    hippoAudio.onTarget!(fx.api, tgt);
    hippoAudio.onEnd!(fx.api, 0); // aborted mid-bellow
    hippoAudio.dispose!();
  });
  it('is inaudible (no voices) when far from the listener', () => {
    const fx = fakeAudioApi();
    (fx.api as unknown as { gainAt: () => number }).gainAt = () => 0;
    hippoAudio.onTarget!(fx.api, tgt);
    hippoAudio.onStage!(fx.api, stage(1));
    expect(fx.voices()).toBe(0);
  });
});

// ── bots: a lion victim driven by the real BotManager at a given difficulty (caster = human-controlled intents) ──
function botVictimLoss(lvl: Difficulty, seed: number, victimZ: number): number {
  const cfg: MatchConfig = { roster: [{ animal: 'hippo', isPlayer: true }, { animal: 'lion', isPlayer: false }], difficulty: lvl };
  const bus = new EventBus();
  const world = new BotWorld(cfg, seed, bus, { traps: false });
  const bots = new BotManager(bus, lvl, seed);
  let slammed = false;
  bus.on('ultimateStage', (e) => {
    if (e.stage === 2) slammed = true;
  });
  for (let i = 0; i < 190; i++) world.step(DT);
  const c = world.fighters[0];
  const v = world.fighters[1];
  c.state.pos = { x: 0, y: 0, z: -6 };
  c.state.yaw = 0;
  v.state.pos = { x: 0, y: 0, z: victimZ };
  v.state.yaw = Math.PI;
  c.state.ultCharge = 100;
  let pressed = false;
  for (let i = 0; i < 60 * 12; i++) {
    const press = neutral();
    if (!pressed) {
      press.ultimate = true;
      pressed = true;
    }
    press.aimYaw = 0;
    world.setIntent(0, press);
    bots.update(world.snapshot(), DT);
    world.setIntent(1, bots.getIntent(1));
    world.step(DT);
    if (slammed && c.ability === null) break;
  }
  return v.state.maxHp - v.state.hp;
}

describe("hippo Riverlord's Flood — real bots sidestep the marked path", () => {
  it('Apex (strict) bots leave the path before the slam: at most one of eight seeds is caught; Cubs (never dodge) are caught more often', () => {
    let apex = 0;
    let cub = 0;
    for (let seed = 1; seed <= 8; seed++) {
      if (botVictimLoss(4, seed, 0) >= 100) apex++;
      if (botVictimLoss(1, seed, 0) >= 100) cub++;
    }
    expect(apex).toBeLessThanOrEqual(1);
    expect(cub).toBeGreaterThan(apex);
  });
});

// ── bot script (decideAbilities → ULT_SCRIPTS) ──
function sit(lvl: Difficulty, over: Partial<Situation>): Situation {
  return {
    animal: 'hippo', profile: BOT_PROFILES[lvl], rng: mulberry32(1), now: 10, hpFrac: 1, guardFrac: 1, specialReady: false, ultReady: true,
    ultHeldS: 0, retreating: false, hasTarget: true, tdist: 6, tHpFrac: 1, tGuardFrac: 1, targetHelpless: false, targetRooted: false,
    targetBlocking: false, targetCommitted: false, targetFleeing: false, targetIsolated: false, nearestEnemyDist: 6, enemiesNearSelf5: 0,
    enemiesNearSelf8: 0, enemiesNearTarget8: 0, wallBehindTarget: false, recentFinisher: false, aimYawToTarget: 0, aimYawAway: Math.PI,
    aimYawNearest: 0, ...over,
  };
}
function wantsUlt(s: Situation): boolean {
  const out: AbilityWish = { special: false, ult: false, aimYaw: 0 };
  decideAbilities(s, out);
  return out.ult;
}

describe("hippo Riverlord's Flood — bot script", () => {
  it('Apex casts at helpless / blocking / committed / rooted foes and lined-up groups inside the path length', () => {
    expect(wantsUlt(sit(4, { tdist: 6, targetHelpless: true }))).toBe(true);
    expect(wantsUlt(sit(4, { tdist: 6, targetBlocking: true }))).toBe(true);
    expect(wantsUlt(sit(4, { tdist: 6, targetRooted: true }))).toBe(true);
    expect(wantsUlt(sit(4, { tdist: 6, targetCommitted: true }))).toBe(true);
    expect(wantsUlt(sit(4, { tdist: 6, enemiesNearTarget8: 1 }))).toBe(true);
    expect(wantsUlt(sit(4, { tdist: 6 }))).toBe(false); // a lone, free, mobile target dodges a telegraphed wave
    expect(wantsUlt(sit(4, { tdist: 14, targetHelpless: true }))).toBe(false); // beyond the 11 m path
  });
  it('Cub / Fighter cast whenever the target is inside the path length', () => {
    expect(wantsUlt(sit(1, { tdist: 7, ultHeldS: 10 }))).toBe(true);
    expect(wantsUlt(sit(2, { tdist: 7 }))).toBe(true);
    expect(wantsUlt(sit(1, { tdist: 13, ultHeldS: 10 }))).toBe(false);
  });
});
