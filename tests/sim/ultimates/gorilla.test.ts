/**
 * Gorilla — Boulder Hurl (v1.3): `line` ultimate (18 m, lock-assisted, never required), 1.0 s uninterruptible
 * heave, then a real arcing boulder projectile (200 direct on the first fighter touched + 0.8 s stagger when
 * unblocked, 60 splash in 2.5 m, breaks crates), 0.6 s interruptible recovery.
 */

import { describe, it, expect } from 'vitest';
import { liveWorld, neutral, disablePickups, DT } from '../helpers';
import { ANIMALS } from '../../../src/config/animals';
import { GORILLA_HURL as K } from '../../../src/config/ultimates/gorilla';
import type { AnimalId, Difficulty, FighterIntent, GameEvent, GameEventOf, MatchConfig } from '../../../src/core/types';
import type { World } from '../../../src/sim/World';
import type { Fighter } from '../../../src/sim/Fighter';
import { hurlLanding } from '../../../src/sim/ultimates/gorilla';
import { DangerZones } from '../../../src/ai/dangerZones';
import { synth, type UltAudioApi } from '../../../src/audio/ults';
import gorillaAudio from '../../../src/audio/ults/gorilla';
import { World as BotWorld } from '../../../src/sim/World';
import { EventBus } from '../../../src/core/EventBus';
import { BotManager } from '../../../src/ai/BotManager';
import { decideAbilities, type Situation, type AbilityWish } from '../../../src/ai/scripts';
import { BOT_PROFILES } from '../../../src/config/botProfiles';
import { mulberry32 } from '../../../src/core/math';

type Timed = { tick: number; ev: GameEvent };

/** The x = -12 lane is free of pillars, crates, columns and the dais (see projectiles.test.ts). */
const LX = -12;
const CZ = -14; // the caster's z

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

/** Caster at (LX, CZ) facing +z; victim `dist` metres ahead (optionally rotated `deg` off the aim). */
function fixture(roster: AnimalId[] = ['gorilla', 'hippo'], dist = 10, deg = 0): Fx {
  const events: GameEvent[] = [];
  const { world } = liveWorld(roster, 7, events);
  disablePickups(world);
  const fs = world.fighters;
  const c = fs[0];
  const t = fs[1];
  c.state.pos = { x: LX, y: 0, z: CZ };
  c.state.yaw = 0;
  c.state.vel = { x: 0, y: 0, z: 0 };
  const a = (deg * Math.PI) / 180;
  t.state.pos = { x: LX + Math.sin(a) * dist, y: 0, z: CZ + Math.cos(a) * dist };
  t.state.yaw = Math.PI;
  t.state.vel = { x: 0, y: 0, z: 0 };
  for (let i = 2; i < fs.length; i++) fs[i].state.pos = { x: 20 + i, y: 0, z: 20 };
  return { world, events, log: [], tick: 0, c, t, intents: new Map() };
}

function step(fx: Fx, casterIntent?: Partial<FighterIntent>): void {
  const n0 = fx.events.length;
  for (const f of fx.world.fighters) {
    const base = neutral();
    if (f.id === 0) base.aimYaw = 0;
    const custom = fx.intents.get(f.id);
    fx.world.setIntent(f.id, { ...base, ...(f.id === 0 ? casterIntent : undefined), ...custom });
  }
  fx.world.step(DT);
  fx.tick++;
  for (let i = n0; i < fx.events.length; i++) fx.log.push({ tick: fx.tick, ev: fx.events[i] });
}

function cast(fx: Fx, extra?: Partial<FighterIntent>): void {
  fx.c.state.ultCharge = 100;
  step(fx, { ultimate: true, ...extra });
}

function runUntil(fx: Fx, done: () => boolean, max = 900): void {
  for (let i = 0; i < max && !done(); i++) step(fx);
}

const seconds = (ticks: number): number => ticks * DT;
const released = (fx: Fx): boolean => ofType(fx.log, 'ultimateStage').some((s) => s.ev.stage === 1);
const landed = (fx: Fx): boolean => ofType(fx.log, 'projectileImpact').length > 0;
const loss = (f: Fighter): number => f.state.maxHp - f.state.hp;

describe('gorilla Boulder Hurl — config', () => {
  const spec = ANIMALS.gorilla.ultimate;
  it('is an 18 m line lock-assist (40° cone) that is never required, opts into the commit dodge protocol', () => {
    expect(spec.name).toBe('Boulder Hurl');
    expect(spec.targeting?.kind).toBe('line');
    expect(spec.targeting?.range).toBe(18);
    expect(spec.targeting?.coneDeg).toBe(40);
    expect(spec.targeting?.width).toBe(1.6);
    expect(spec.targeting?.requireTarget).toBeUndefined();
    expect(spec.targeting?.dodge?.mode).toBe('commit');
    expect(spec.damage).toBe(200);
    expect(spec.splashDamage).toBe(60);
    expect(spec.splashRadius).toBe(2.5);
    expect(spec.windup).toBe(K.windupS);
    expect(spec.description).toMatch(/boulder|slab/i);
  });
  it('the commit zone outlives the longest flight (range / speed) and the heave fits its tracking cap', () => {
    const d = spec.targeting!.dodge!;
    expect(d.commitS!).toBeGreaterThan(K.maxThrow / K.speed + 0.25);
    expect(d.activeS!).toBeGreaterThanOrEqual(1);
  });
});

describe('gorilla Boulder Hurl — targeting (never fizzles)', () => {
  it('with nobody around it still throws, down the aim line at full range', () => {
    const fx = fixture();
    fx.t.state.pos = { x: 25, y: 0, z: 25 };
    cast(fx);
    expect(ofType(fx.log, 'ultimateFizzle')).toHaveLength(0);
    expect(fx.c.ability).not.toBeNull();
    expect(fx.c.ability!.lockId).toBe(-1);
    expect(fx.c.state.ultCharge).toBe(0);
    const tg = ofType(fx.log, 'ultimateTarget');
    expect(tg).toHaveLength(1);
    expect(tg[0].ev.kind).toBe('line');
    expect(tg[0].ev.targetId).toBe(-1);
    expect(tg[0].ev.to.z).toBeCloseTo(CZ + 18, 1);
    expect(tg[0].ev.windup).toBeCloseTo(K.windupS, 9);
    runUntil(fx, () => released(fx));
    const st1 = ofType(fx.log, 'ultimateStage').find((s) => s.ev.stage === 1)!;
    expect(st1.ev.pos.x).toBeCloseTo(LX, 1);
    expect(st1.ev.pos.z).toBeCloseTo(CZ + 18, 0);
  });

  it('a foe inside the 40° cone is locked (the path ends on them); one outside it is not', () => {
    const inCone = fixture(['gorilla', 'hippo'], 12, 15);
    cast(inCone);
    expect(inCone.c.ability!.lockId).toBe(1);
    const tg = ofType(inCone.log, 'ultimateTarget')[0].ev;
    expect(tg.targetId).toBe(1);
    expect(tg.to.z).toBeCloseTo(inCone.t.state.pos.z, 6);
    const outside = fixture(['gorilla', 'hippo'], 12, 40);
    cast(outside);
    expect(outside.c.ability!.lockId).toBe(-1);
    expect(ofType(outside.log, 'ultimateTarget')[0].ev.targetId).toBe(-1);
  });

  it('a foe beyond 18 m is not locked but the throw still happens', () => {
    const fx = fixture(['gorilla', 'hippo'], 22);
    cast(fx);
    expect(fx.c.ability).not.toBeNull();
    expect(fx.c.ability!.lockId).toBe(-1);
  });
});

describe('gorilla Boulder Hurl — windup, release, recovery', () => {
  it('heaves for 1.0 s uninterruptible, releases exactly one boulder, then recovers for 0.6 s (interruptible)', () => {
    const fx = fixture();
    cast(fx);
    let flags = 0;
    step(fx); // World refreshes `ccImmune` from the channel flag at the start of a tick
    while (fx.c.ability !== null && fx.c.ability.phase === 0 && fx.tick < 200) {
      expect(fx.c.ccImmuneChannel).toBe(true);
      fx.c.interrupt();
      expect(fx.c.ability).not.toBeNull(); // the heave cannot be interrupted
      const st = fx.world.snapshot().fighters[0];
      expect(st.ultPhase).toBe('windup');
      expect(st.ultStage).toBe(0);
      expect(st.ultTargetId).toBe(1);
      step(fx);
      flags++;
    }
    const tRel = seconds(fx.tick - 1);
    expect(tRel).toBeGreaterThanOrEqual(K.windupS - 0.02);
    expect(tRel).toBeLessThan(K.windupS + 0.05);
    expect(flags).toBeGreaterThan(50);
    // The release tick spawned exactly one boulder and dropped the immunity.
    expect(fx.world.projectiles.count).toBe(1);
    expect(fx.c.ccImmuneChannel).toBe(false);
    expect(ofType(fx.log, 'ultimateStage').filter((s) => s.ev.stage === 1)).toHaveLength(1);
    const snap = fx.world.snapshot();
    expect(snap.projectiles).toHaveLength(1);
    expect(snap.projectiles![0]).toMatchObject({ kind: 'boulder', ownerId: 0, radius: K.boulderRadius });
    expect(snap.fighters[0].ultPhase).toBe('recovery');
    // Recovery lasts 0.6 s from the release.
    const tStart = fx.tick;
    runUntil(fx, () => fx.c.ability === null);
    expect(seconds(fx.tick - tStart)).toBeGreaterThan(K.recoveryS - 0.05);
    expect(seconds(fx.tick - tStart)).toBeLessThan(K.recoveryS + 0.1);
    expect(fx.world.projectiles.count).toBeLessThanOrEqual(1);
  });

  it('an interrupt (stun) during the recovery ends the ultimate cleanly; the boulder keeps flying and lands', () => {
    const fx = fixture();
    cast(fx);
    runUntil(fx, () => released(fx));
    step(fx); // World refreshes `ccImmune` from the channel flag
    expect(fx.c.ability).not.toBeNull();
    fx.c.interrupt();
    expect(fx.c.ability).toBeNull();
    expect(fx.c.ccImmuneChannel).toBe(false);
    runUntil(fx, () => landed(fx));
    expect(loss(fx.t)).toBeGreaterThanOrEqual(198);
  });

  it('stage 0 (tracking) every ~0.1 s while heaving with the predicted landing point, then 1 (release) then 2 (impact)', () => {
    const fx = fixture();
    cast(fx);
    runUntil(fx, () => landed(fx));
    const stages = ofType(fx.log, 'ultimateStage');
    const seq = stages.map((s) => s.ev.stage);
    expect(seq[seq.length - 1]).toBe(2);
    expect(seq.filter((s) => s === 1)).toHaveLength(1);
    expect(seq.filter((s) => s === 2)).toHaveLength(1);
    const i1 = seq.indexOf(1);
    expect(seq.slice(0, i1).every((s) => s === 0)).toBe(true);
    expect(i1).toBeGreaterThanOrEqual(8);
    for (let i = 2; i < i1; i++) expect(seconds(stages[i].tick - stages[i - 1].tick)).toBeLessThan(0.15);
    // A stationary victim: predicted / committed / impact points all sit on them.
    for (const s of stages.slice(0, i1 + 1)) expect(s.ev.pos.z).toBeCloseTo(fx.t.state.pos.z, 1);
    expect(stages[seq.length - 1].ev.pos.z).toBeGreaterThan(fx.t.state.pos.z - 2.6);
    expect(stages[i1].ev.targetId).toBe(1);
  });
});

describe('gorilla Boulder Hurl — the boulder', () => {
  it('flies a gravity ARC (rises above the release height on a long throw) at ~18 m/s horizontally', () => {
    const fx = fixture(['gorilla', 'hippo'], 17);
    cast(fx);
    runUntil(fx, () => fx.world.projectiles.count > 0);
    let maxY = 0;
    const z0 = fx.world.projectiles.list[0].z;
    let vh = 0;
    for (let i = 0; i < 120 && fx.world.projectiles.count > 0; i++) {
      const p = fx.world.projectiles.list[0];
      maxY = Math.max(maxY, p.y);
      vh = Math.hypot(p.vx, p.vz);
      step(fx);
    }
    expect(vh).toBeGreaterThan(17.5);
    expect(vh).toBeLessThan(18.5);
    expect(maxY).toBeGreaterThan(K.releaseHeight + 0.3);
    expect(z0).toBeGreaterThan(CZ + K.releaseForward - 0.01); // first observed one tick after the release
    expect(z0).toBeLessThan(CZ + K.releaseForward + 0.6);
  });

  it('a stationary victim takes 200 once (no splash on top) and is staggered 0.8 s', () => {
    const fx = fixture();
    cast(fx);
    runUntil(fx, () => landed(fx));
    expect(loss(fx.t)).toBeGreaterThanOrEqual(198);
    expect(loss(fx.t)).toBeLessThanOrEqual(202);
    const hits = ofType(fx.log, 'hit').filter((h) => h.ev.targetId === 1);
    expect(hits).toHaveLength(1);
    const imp = ofType(fx.log, 'projectileImpact');
    expect(imp).toHaveLength(1);
    expect(imp[0].ev.hitId).toBe(1);
    expect(imp[0].ev.radius).toBe(2.5);
    expect(imp[0].ev.ownerId).toBe(0);
    expect(fx.t.staggerTimer).toBeGreaterThan(K.staggerS - 0.1);
    expect(fx.t.staggerTimer).toBeLessThanOrEqual(K.staggerS);
  });

  it('SPLASH: a bystander 2 m from the impact takes 60, one at 4.6 m is untouched; the first body touched is the victim', () => {
    const fx = fixture(['gorilla', 'hippo', 'lion', 'lion'], 10);
    const near = fx.world.fighters[2];
    const far = fx.world.fighters[3];
    near.state.pos = { x: LX + 2.8, y: 0, z: CZ + 10.5 }; // ~2.85 m from the victim: inside 2.5 + its body
    far.state.pos = { x: LX + 6.5, y: 0, z: CZ + 12 }; // far outside
    cast(fx);
    runUntil(fx, () => landed(fx));
    expect(loss(fx.t)).toBeGreaterThanOrEqual(198);
    expect(loss(near)).toBeGreaterThanOrEqual(58);
    expect(loss(near)).toBeLessThanOrEqual(62);
    expect(loss(far)).toBe(0);
    // The splash does not stagger (only the direct hit does).
    expect(near.staggerTimer).toBe(0);
  });

  it('hits the FIRST body in the path, even a foe that is not the locked one', () => {
    const fx = fixture(['gorilla', 'hippo', 'lion'], 14);
    const mid = fx.world.fighters[2];
    mid.state.pos = { x: LX, y: 0, z: CZ + 16.5 }; // just short of... beyond: not in the way
    mid.state.pos = { x: LX, y: 0, z: CZ + 13 }; // in front of the locked victim, near the end of the arc
    cast(fx);
    runUntil(fx, () => landed(fx));
    expect(fx.log.filter((l) => l.ev.type === 'hit').length).toBeGreaterThanOrEqual(1);
    const imp = ofType(fx.log, 'projectileImpact')[0].ev;
    expect([1, 2]).toContain(imp.hitId);
    expect(imp.hitId).toBe(2); // the nearer one catches it
  });

  it('DODGE BY MOVING: a victim that sidesteps after the release takes no direct damage', () => {
    const fx = fixture();
    cast(fx);
    runUntil(fx, () => released(fx));
    fx.intents.set(1, { ...neutral(), moveX: 1 }); // sidestep as the boulder leaves the hands
    runUntil(fx, () => landed(fx));
    expect(ofType(fx.log, 'projectileImpact')[0].ev.hitId).toBe(-1);
    expect(fx.t.state.hp).toBeGreaterThan(fx.t.state.maxHp - 61); // at most the 60 splash, never the 200
    expect(fx.t.staggerTimer).toBe(0);
  });

  it('DODGE BY FLYING: a victim above the flight height when the boulder arrives is missed entirely', () => {
    const fx = fixture();
    cast(fx);
    runUntil(fx, () => released(fx));
    for (let i = 0; i < 200 && !landed(fx); i++) {
      fx.t.state.pos.y = 4.5;
      fx.t.state.vel.y = 0;
      step(fx);
    }
    expect(fx.t.state.hp).toBe(fx.t.state.maxHp);
    expect(ofType(fx.log, 'projectileImpact')[0].ev.hitId).not.toBe(1);
  });

  it('an untargetable (burrowed) victim is skipped by the boulder', () => {
    const fx = fixture();
    cast(fx);
    runUntil(fx, () => released(fx));
    fx.t.untargetable = true;
    runUntil(fx, () => landed(fx));
    expect(ofType(fx.log, 'projectileImpact')[0].ev.hitId).toBe(-1);
    expect(fx.t.state.hp).toBe(fx.t.state.maxHp);
  });

  it('a BLOCKING victim takes the reduced (blockable) hit, is not staggered by the effect, and the guard drains', () => {
    const fx = fixture();
    fx.intents.set(1, { ...neutral(), block: true, aimYaw: Math.PI });
    cast(fx);
    runUntil(fx, () => landed(fx));
    const hippoBlock = ANIMALS.hippo.blockReduction;
    expect(loss(fx.t)).toBeLessThan(200 * (1 - hippoBlock) + 3);
    expect(loss(fx.t)).toBeGreaterThan(0);
    expect(ofType(fx.log, 'blocked').length).toBeGreaterThanOrEqual(1);
    expect(fx.t.state.guard).toBeLessThan(fx.t.state.maxGuard);
  });

  it('BREAKS CRATES: a boulder landing on a crate destroys it and splashes a fighter behind it', () => {
    const fx = fixture(['gorilla', 'hippo', 'lion'], 10);
    fx.t.state.pos = { x: 25, y: 0, z: -25 }; // the locked foe is out of the way
    const crate = { id: 99, x: LX, z: CZ + 12, halfX: 0.9, halfZ: 0.9, height: 1.8, hp: 40, alive: true };
    fx.world.crates.push(crate);
    const behind = fx.world.fighters[2];
    behind.state.pos = { x: LX, y: 0, z: CZ + 13.8 };
    cast(fx);
    runUntil(fx, () => landed(fx));
    expect(crate.alive).toBe(false);
    expect(loss(behind)).toBeGreaterThanOrEqual(58);
    const imp = ofType(fx.log, 'projectileImpact')[0].ev;
    expect(imp.hitId).toBe(-1);
  });

  it('LEADS a runner: a victim running straight across at constant speed is hit; one that reverses after the release is missed', () => {
    const chase = (reverse: boolean): number => {
      const fx = fixture(['gorilla', 'hippo'], 12);
      fx.intents.set(1, { ...neutral(), moveX: 1 });
      cast(fx);
      runUntil(fx, () => released(fx));
      if (reverse) fx.intents.set(1, { ...neutral(), moveX: -1 });
      runUntil(fx, () => landed(fx));
      return loss(fx.t);
    };
    expect(chase(false)).toBeGreaterThanOrEqual(195);
    expect(chase(true)).toBeLessThan(150);
  });

  it('the landing point freezes at the release: the victim walking away later does not bend the flight', () => {
    const fx = fixture();
    cast(fx);
    runUntil(fx, () => released(fx));
    const r = hurlLanding(fx.c.ability)!;
    expect(r.released).toBe(true);
    const x0 = r.x;
    const z0 = r.z;
    fx.intents.set(1, { ...neutral(), moveX: 1 });
    runUntil(fx, () => landed(fx));
    const imp = ofType(fx.log, 'projectileImpact')[0].ev;
    expect(Math.hypot(imp.pos.x - x0, imp.pos.z - z0)).toBeLessThan(2.2);
  });
});

describe('gorilla Boulder Hurl — cleanup', () => {
  it('the caster dying mid-heave spawns no boulder and leaves no flags behind', () => {
    const fx = fixture();
    cast(fx);
    for (let i = 0; i < 30; i++) step(fx);
    expect(fx.c.ccImmuneChannel).toBe(true);
    fx.c.state.hp = 0;
    step(fx);
    expect(fx.c.state.alive).toBe(false);
    expect(fx.c.ability).toBeNull();
    expect(fx.c.ccImmuneChannel).toBe(false);
    for (let i = 0; i < 120; i++) step(fx);
    expect(fx.world.projectiles.count).toBe(0);
    expect(fx.t.state.hp).toBe(fx.t.state.maxHp);
  });

  it('the caster dying mid-FLIGHT does not stop the boulder, and it cleans up when it lands', () => {
    const fx = fixture(['gorilla', 'hippo', 'lion']);
    cast(fx);
    runUntil(fx, () => released(fx));
    fx.c.state.hp = 0;
    step(fx);
    expect(fx.c.state.alive).toBe(false);
    runUntil(fx, () => landed(fx));
    expect(fx.world.projectiles.count).toBe(0);
  });

  it('a victim that dies mid-heave: the throw falls back to the aim line and still releases', () => {
    const fx = fixture(['gorilla', 'hippo', 'lion']);
    cast(fx);
    for (let i = 0; i < 20; i++) step(fx);
    fx.t.state.hp = 0;
    runUntil(fx, () => released(fx));
    expect(released(fx)).toBe(true);
    expect(fx.world.projectiles.count).toBe(1);
  });
});

describe('gorilla Boulder Hurl — bot danger-zone protocol', () => {
  it('the real events drive DangerZones: the heave is not dodged, the release commits the landing point, the impact clears it', () => {
    const fx = fixture();
    const zones = new DangerZones();
    cast(fx);
    let committedSeen = false;
    let cleared = false;
    let fedTo = 0;
    for (let i = 0; i < 400; i++) {
      step(fx);
      const now = fx.tick * DT;
      for (; fedTo < fx.log.length; fedTo++) zones.ingest(fx.log[fedTo].ev, now, 0, 1, () => 'gorilla');
      const z = zones.find(0);
      const rel = released(fx);
      if (z !== undefined && !rel) expect(zones.isLive(z, now)).toBe(false);
      if (z !== undefined && rel && !landed(fx)) {
        committedSeen = true;
        expect(zones.isLive(z, now)).toBe(true);
        expect(zones.insideAny(fx.t.state.pos.x, fx.t.state.pos.z, 0.5, now)).toBe(true);
        expect(zones.insideAny(fx.t.state.pos.x + 5, fx.t.state.pos.z, 0.5, now)).toBe(false);
      }
      if (z === undefined && ofType(fx.log, 'ultimateStage').some((s) => s.ev.stage === 2)) cleared = true;
      if (cleared) break;
    }
    expect(committedSeen).toBe(true);
    expect(cleared).toBe(true);
    expect(zones.count).toBe(0);
  });
});

describe('gorilla Boulder Hurl — determinism', () => {
  it('two identical runs produce identical events, positions and hp', () => {
    const run = (): string => {
      const fx = fixture(['gorilla', 'hippo', 'lion']);
      cast(fx);
      fx.intents.set(1, { ...neutral(), moveX: 0.6, moveZ: 0.4 });
      runUntil(fx, () => landed(fx) && fx.c.ability === null);
      const trace: string[] = [];
      for (const l of fx.log) {
        if (l.ev.type === 'ultimateStage' || l.ev.type === 'hit' || l.ev.type === 'projectileImpact') trace.push(JSON.stringify([l.tick, l.ev]));
      }
      trace.push(JSON.stringify([fx.c.state.pos, fx.t.state.pos, fx.t.state.hp, fx.tick]));
      return trace.join('\n');
    };
    expect(run()).toBe(run());
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

describe('gorilla Boulder Hurl — audio module', () => {
  const tgt = { type: 'ultimateTarget', fighterId: 0, animal: 'gorilla', kind: 'line', targetId: 1, from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 10 }, range: 18, width: 1.6, windup: 1.0 } as GameEventOf<'ultimateTarget'>;
  const stage = (n: number): GameEventOf<'ultimateStage'> => ({ type: 'ultimateStage', fighterId: 0, animal: 'gorilla', stage: n, targetId: 1, pos: { x: 0, y: 0, z: 10 } });
  const impact = { type: 'projectileImpact', kind: 'boulder', pos: { x: 0, y: 0, z: 10 }, radius: 2.5, ownerId: 0, hitId: 1 } as GameEventOf<'projectileImpact'>;
  it('chest drums + stone rip + hoist on cast, throw grunt on release, boom on impact; never throws', () => {
    const fx = fakeAudioApi();
    gorillaAudio.onTarget!(fx.api, tgt);
    const afterCast = fx.voices();
    expect(afterCast).toBeGreaterThanOrEqual(6); // 2 drums (2 layers each) + rip layers
    gorillaAudio.onStage!(fx.api, stage(0));
    expect(fx.voices()).toBe(afterCast); // the tracking cadence makes no sound
    gorillaAudio.onStage!(fx.api, stage(1));
    const afterThrow = fx.voices();
    expect(afterThrow).toBeGreaterThan(afterCast + 2); // grunt + whoosh
    gorillaAudio.onImpact!(fx.api, impact);
    expect(fx.voices()).toBeGreaterThan(afterThrow + 3);
  });
  it('is inaudible (no voices) when far from the listener', () => {
    const fx = fakeAudioApi();
    (fx.api as unknown as { gainAt: () => number }).gainAt = () => 0;
    gorillaAudio.onTarget!(fx.api, tgt);
    gorillaAudio.onStage!(fx.api, stage(1));
    gorillaAudio.onImpact!(fx.api, impact);
    expect(fx.voices()).toBe(0);
  });
});

// ── bots: a python victim (no gap-closing special that would busy it mid-cast) driven by the real BotManager at a given difficulty (caster = human-controlled intents) ──
function botVictimLoss(lvl: Difficulty, seed: number): number {
  const cfg: MatchConfig = { roster: [{ animal: 'gorilla', isPlayer: true }, { animal: 'python', isPlayer: false }], difficulty: lvl };
  const bus = new EventBus();
  const world = new BotWorld(cfg, seed, bus, { traps: false });
  const bots = new BotManager(bus, lvl, seed);
  let landedOnce = false;
  bus.on('projectileImpact', () => {
    landedOnce = true;
  });
  for (let i = 0; i < 190; i++) world.step(DT);
  const c = world.fighters[0];
  const v = world.fighters[1];
  c.state.pos = { x: LX, y: 0, z: CZ };
  c.state.yaw = 0;
  v.state.pos = { x: LX, y: 0, z: CZ + 15 };
  v.state.yaw = Math.PI;
  c.state.ultCharge = 100;
  let pressed = false;
  for (let i = 0; i < 60 * 8; i++) {
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
    if (landedOnce && c.ability === null) break;
  }
  return v.state.maxHp - v.state.hp;
}

describe('gorilla Boulder Hurl — real bots dodge the committed landing point', () => {
  it('Apex (strict) bots leave it: at most one of eight seeds eats the 200 direct hit; never-dodging Cubs nearly always do', () => {
    let apexDirect = 0;
    for (let seed = 1; seed <= 8; seed++) if (botVictimLoss(4, seed) >= 190) apexDirect++;
    expect(apexDirect).toBeLessThanOrEqual(1);
    let ctrl = 0;
    for (let seed = 1; seed <= 8; seed++) if (botVictimLoss(1, seed) >= 190) ctrl++;
    expect(ctrl).toBeGreaterThanOrEqual(apexDirect + 4);
  });
});

// ── bot script (decideAbilities → ULT_SCRIPTS) ──
function sit(animal: AnimalId, lvl: Difficulty, over: Partial<Situation>): Situation {
  return {
    animal, profile: BOT_PROFILES[lvl], rng: mulberry32(1), now: 10, hpFrac: 1, guardFrac: 1, specialReady: false, ultReady: true,
    ultHeldS: 0, retreating: false, hasTarget: true, tdist: 9, tHpFrac: 1, tGuardFrac: 1, targetHelpless: false, targetRooted: false,
    targetBlocking: false, targetCommitted: false, targetFleeing: false, targetIsolated: false, nearestEnemyDist: 9, enemiesNearSelf5: 0,
    enemiesNearSelf8: 0, enemiesNearTarget8: 0, wallBehindTarget: false, recentFinisher: false, aimYawToTarget: 0, aimYawAway: Math.PI,
    aimYawNearest: 0, ...over,
  };
}
function wantsUlt(s: Situation): boolean {
  const out: AbilityWish = { special: false, ult: false, aimYaw: 0 };
  decideAbilities(s, out);
  return out.ult;
}

describe('gorilla Boulder Hurl — bot script', () => {
  it('Apex throws at runners, kiters, clustered foes, helpless / rooted / mid-cast foes and cracked guards in range; not at a healthy lone fighter', () => {
    expect(wantsUlt(sit('gorilla', 4, { targetFleeing: true }))).toBe(true);
    expect(wantsUlt(sit('gorilla', 4, { enemiesNearTarget8: 2 }))).toBe(true);
    expect(wantsUlt(sit('gorilla', 4, { targetHelpless: true }))).toBe(true);
    expect(wantsUlt(sit('gorilla', 4, { targetRooted: true, tdist: 14 }))).toBe(true);
    expect(wantsUlt(sit('gorilla', 4, { targetCommitted: true }))).toBe(true);
    expect(wantsUlt(sit('gorilla', 4, { targetBlocking: true, tGuardFrac: 0.3 }))).toBe(true);
    expect(wantsUlt(sit('gorilla', 4, {}))).toBe(false);
  });
  it('range gate: Apex not at point-blank (melee is better), nobody beyond ~16.5 m (throw reach 18 m)', () => {
    expect(wantsUlt(sit('gorilla', 4, { targetFleeing: true, tdist: 2 }))).toBe(false);
    expect(wantsUlt(sit('gorilla', 4, { targetFleeing: true, tdist: 3 }))).toBe(false);
    expect(wantsUlt(sit('gorilla', 4, { targetFleeing: true, tdist: 17.5 }))).toBe(false);
    expect(wantsUlt(sit('gorilla', 2, { tdist: 9 }))).toBe(true); // Fighter: any target in range
    expect(wantsUlt(sit('gorilla', 2, { tdist: 1.5 }))).toBe(false);
    expect(wantsUlt(sit('gorilla', 2, { tdist: 19 }))).toBe(false);
  });
  it('Veteran uses the ranged window (fleeing / helpless / isolated-or-clustered foes), not a healthy lone fighter', () => {
    expect(wantsUlt(sit('gorilla', 3, { targetFleeing: true }))).toBe(true);
    expect(wantsUlt(sit('gorilla', 3, { targetHelpless: true }))).toBe(true);
    expect(wantsUlt(sit('gorilla', 3, {}))).toBe(false);
  });
});
