/**
 * Giraffe — Timber Fall (v1.3): lock (7.5 m / 70°, required), 1.1 s rear-back with a circle that tracks the victim for
 * 0.6 s then commits for 0.5 s, the neck-hammer slam (230 direct in r 1.6 + 1.0 s stun, 50 + stagger in a 2.2 m shock
 * ring), 0.9 s whiff recovery. Interruptible while the circle tracks, CC-immune from the commit on.
 */

import { describe, it, expect } from 'vitest';
import { liveWorld, neutral, disablePickups, DT } from '../helpers';
import { ANIMALS } from '../../../src/config/animals';
import { GIRAFFE_TIMBER as K } from '../../../src/config/ultimates/giraffe';
import type { AnimalId, Difficulty, FighterIntent, GameEvent, GameEventOf, MatchConfig } from '../../../src/core/types';
import type { World } from '../../../src/sim/World';
import type { Fighter } from '../../../src/sim/Fighter';
import { timberBeat, timberReticle } from '../../../src/sim/ultimates/giraffe';
import { DangerZones } from '../../../src/ai/dangerZones';
import { synth, type UltAudioApi } from '../../../src/audio/ults';
import giraffeAudio from '../../../src/audio/ults/giraffe';
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
  others: Fighter[];
  intents: Map<number, FighterIntent>;
}

function ofType<T extends GameEvent['type']>(log: Timed[], type: T): { tick: number; ev: GameEventOf<T> }[] {
  return log.filter((e) => e.ev.type === type) as { tick: number; ev: GameEventOf<T> }[];
}

/** Caster at (LX, CZ) facing +z; victim `dist` metres ahead (optionally rotated `deg` off the aim). */
function fixture(roster: AnimalId[] = ['giraffe', 'hippo'], dist = 5, deg = 0): Fx {
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
  return { world, events, log: [], tick: 0, c, t, others: fs.slice(2), intents: new Map() };
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

function cast(fx: Fx): void {
  fx.c.state.ultCharge = 100;
  step(fx, { ultimate: true });
}

function runUntil(fx: Fx, done: () => boolean, max = 900): void {
  for (let i = 0; i < max && !done(); i++) step(fx);
}

const seconds = (ticks: number): number => ticks * DT;
const committed = (fx: Fx): boolean => ofType(fx.log, 'ultimateStage').some((s) => s.ev.stage === 1);
const slammed = (fx: Fx): boolean => ofType(fx.log, 'ultimateStage').some((s) => s.ev.stage === 2);
const loss = (f: Fighter): number => f.state.maxHp - f.state.hp;

describe('giraffe Timber Fall — config', () => {
  const spec = ANIMALS.giraffe.ultimate;
  it('is a 7.5 m / 70° lock that requires a target and opts into the commit dodge protocol', () => {
    expect(spec.name).toBe('Timber Fall');
    expect(spec.targeting?.kind).toBe('lock');
    expect(spec.targeting?.range).toBe(7.5);
    expect(spec.targeting?.coneDeg).toBe(70);
    expect(spec.targeting?.requireTarget).toBe(true);
    expect(spec.targeting?.dodge?.mode).toBe('commit');
    expect(spec.damage).toBe(230);
    expect(spec.splashDamage).toBe(50);
    expect(spec.splashRadius).toBe(2.2);
    expect(spec.radius).toBe(1.6);
    expect(spec.windup).toBe(K.windupS);
    expect(spec.description).toMatch(/circle/i);
  });
  it('the timeline adds up and the zone outlives the slam', () => {
    expect(K.trackS + K.commitS).toBeCloseTo(K.windupS, 9);
    const d = ANIMALS.giraffe.ultimate.targeting!.dodge!;
    expect(d.commitS!).toBeGreaterThan(K.commitS + K.slamS);
    expect(d.activeS!).toBeGreaterThan(K.trackS);
  });
});

describe('giraffe Timber Fall — targeting / fizzle', () => {
  it('no foe in the 70° cone: fizzles, nothing spent, no cast events', () => {
    const fx = fixture(['giraffe', 'hippo'], 5, 90);
    cast(fx);
    expect(fx.c.state.ultCharge).toBe(100);
    expect(fx.c.ability).toBeNull();
    expect(ofType(fx.log, 'ultimateFizzle')).toHaveLength(1);
    expect(ofType(fx.log, 'ultimate')).toHaveLength(0);
    expect(ofType(fx.log, 'ultimateTarget')).toHaveLength(0);
  });

  it('a foe beyond 7.5 m (plus body) fizzles, one inside (and 30° off-axis) locks', () => {
    const far = fixture(['giraffe', 'hippo'], 10);
    cast(far);
    expect(ofType(far.log, 'ultimateFizzle')).toHaveLength(1);
    expect(far.c.state.ultCharge).toBe(100);

    const near = fixture(['giraffe', 'hippo'], 7, 25);
    cast(near);
    expect(ofType(near.log, 'ultimateFizzle')).toHaveLength(0);
    expect(near.c.ability!.lockId).toBe(1);
    expect(near.c.state.ultCharge).toBe(0);
  });

  it('a flier above ground reach or an untargetable foe cannot be locked', () => {
    const hi = fixture();
    hi.t.state.pos.y = 4;
    cast(hi);
    expect(ofType(hi.log, 'ultimateFizzle')).toHaveLength(1);
    const un = fixture();
    un.t.untargetable = true;
    cast(un);
    expect(ofType(un.log, 'ultimateFizzle')).toHaveLength(1);
  });

  it('emits ultimateTarget (lock, victim id, the 1.1 s lead time) right after the ultimate event', () => {
    const fx = fixture();
    cast(fx);
    const tg = ofType(fx.log, 'ultimateTarget');
    expect(tg).toHaveLength(1);
    expect(tg[0].ev.kind).toBe('lock');
    expect(tg[0].ev.targetId).toBe(1);
    expect(tg[0].ev.range).toBe(7.5);
    expect(tg[0].ev.windup).toBeCloseTo(K.windupS, 9);
    expect(tg[0].ev.to.z).toBeCloseTo(CZ + 5, 6);
    const types = fx.log.map((l) => l.ev.type);
    expect(types.indexOf('ultimateTarget')).toBeGreaterThan(types.indexOf('ultimate'));
  });
});

describe('giraffe Timber Fall — phases, interruption, approach', () => {
  it('snapshot walks windup (stage 0 → 1) → active (stage 1) → recovery (stage 2)', () => {
    const fx = fixture();
    cast(fx);
    const seen = new Set<string>();
    for (let i = 0; i < 400 && fx.c.ability !== null; i++) {
      step(fx);
      const st = fx.world.snapshot().fighters[0];
      seen.add(`${st.ultPhase}:${st.ultStage}`);
      if (st.ultPhase !== undefined) expect(st.ultTargetId).toBe(1);
    }
    expect(seen.has('windup:0')).toBe(true);
    expect(seen.has('windup:1')).toBe(true);
    expect(seen.has('active:1')).toBe(true);
    expect(seen.has('recovery:2')).toBe(true);
    expect(fx.c.ability).toBeNull();
    expect(fx.c.ccImmuneChannel).toBe(false);
  });

  it('is interruptible while the circle tracks, uninterruptible from the commit through the slam', () => {
    const tracking = fixture();
    cast(tracking);
    for (let i = 0; i < 10; i++) step(tracking);
    expect(tracking.c.ability).not.toBeNull();
    expect(tracking.c.ccImmuneChannel).toBe(false);
    tracking.c.interrupt();
    expect(tracking.c.ability).toBeNull(); // stun / stagger cancels it (charge is gone)
    expect(tracking.c.state.ultCharge).toBe(0);
    for (let i = 0; i < 120; i++) step(tracking);
    expect(tracking.t.state.hp).toBe(tracking.t.state.maxHp);

    const fx = fixture();
    cast(fx);
    runUntil(fx, () => committed(fx));
    step(fx); // World refreshes `ccImmune` from the channel flag
    let checked = 0;
    while (fx.c.ability !== null && !slammed(fx) && checked < 90) {
      expect(fx.c.ccImmuneChannel).toBe(true);
      fx.c.interrupt();
      expect(fx.c.ability).not.toBeNull();
      step(fx);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('creeps in while rearing: a victim 7 m away is brought within hammer reach; one already in reach does not move the giraffe', () => {
    const far = fixture(['giraffe', 'hippo'], 7);
    cast(far);
    runUntil(far, () => slammed(far));
    const gap = Math.hypot(far.t.state.pos.x - far.c.state.pos.x, far.t.state.pos.z - far.c.state.pos.z);
    expect(gap).toBeLessThan(K.reach + 0.6);
    expect(far.c.state.pos.z).toBeGreaterThan(CZ + 2);
    const near = fixture(['giraffe', 'hippo'], 2.8);
    cast(near);
    runUntil(near, () => slammed(near));
    expect(Math.hypot(near.c.state.pos.x - LX, near.c.state.pos.z - CZ)).toBeLessThan(0.2);
    expect(loss(near.t)).toBeGreaterThanOrEqual(228);
  });

  it('faces the circle as it rears', () => {
    const fx = fixture(['giraffe', 'hippo'], 5, 30);
    cast(fx);
    runUntil(fx, () => committed(fx));
    const want = Math.atan2(fx.t.state.pos.x - fx.c.state.pos.x, fx.t.state.pos.z - fx.c.state.pos.z);
    expect(Math.abs(fx.c.state.yaw - want)).toBeLessThan(0.4);
  });
});

describe('giraffe Timber Fall — track → commit → slam', () => {
  it('stage events: 0 while tracking (steady cadence, centre near the victim), one 1 (commit) then one 2 (impact)', () => {
    const fx = fixture();
    cast(fx);
    runUntil(fx, () => fx.c.ability === null);
    const st = ofType(fx.log, 'ultimateStage');
    const stages = st.map((s) => s.ev.stage);
    const iCommit = stages.indexOf(1);
    expect(iCommit).toBeGreaterThanOrEqual(4);
    expect(stages.filter((s) => s === 1)).toHaveLength(1);
    expect(stages.filter((s) => s === 2)).toHaveLength(1);
    expect(stages[stages.length - 1]).toBe(2);
    expect(stages.slice(0, iCommit).every((s) => s === 0)).toBe(true);
    for (let i = 2; i < iCommit; i++) expect(seconds(st[i].tick - st[i - 1].tick)).toBeLessThan(0.15);
    // Commit lands trackS after the cast (the first tick already advanced once); the slam commitS + slamS later.
    expect(seconds(st[iCommit].tick - 1)).toBeCloseTo(K.trackS, 1);
    const impact = st[st.length - 1];
    expect(seconds(impact.tick - st[iCommit].tick)).toBeGreaterThan(K.commitS + K.slamS - 0.05);
    expect(seconds(impact.tick - st[iCommit].tick)).toBeLessThan(K.commitS + K.slamS + 0.1);
    // A stationary victim: the circle sits on them and the impact equals the commit point.
    expect(st[iCommit].ev.pos.z).toBeCloseTo(CZ + 5, 1);
    expect(impact.ev.pos.z).toBeCloseTo(st[iCommit].ev.pos.z, 6);
    expect(impact.ev.targetId).toBe(1);
  });

  it('the circle LAGS a moving victim, then freezes at the commit', () => {
    const fx = fixture(['giraffe', 'hippo'], 4);
    cast(fx);
    fx.intents.set(1, { ...neutral(), moveX: 1 }); // the victim walks along +X the whole time
    runUntil(fx, () => committed(fx), 400);
    const st = ofType(fx.log, 'ultimateStage');
    const last0 = st.filter((s) => s.ev.stage === 0).slice(-1)[0];
    const commit = st.find((s) => s.ev.stage === 1)!;
    const victimX = fx.t.state.pos.x;
    expect(victimX).toBeGreaterThan(LX + 2.5);
    expect(commit.ev.pos.x).toBeLessThan(victimX - 0.3); // behind the victim
    expect(commit.ev.pos.x).toBeGreaterThan(LX + 0.3); // but following
    expect(commit.ev.pos.x).toBeGreaterThanOrEqual(last0.ev.pos.x - 1e-9); // monotone toward the victim
    const ret = timberReticle(fx.c.ability);
    for (let i = 0; i < 10; i++) step(fx);
    const ret2 = timberReticle(fx.c.ability);
    expect(ret2!.x).toBeCloseTo(ret!.x, 9);
    expect(timberBeat(fx.c.ability)).toBe('commit');
  });

  it('a stationary victim takes 230 once (no shock on top), is stunned 1 s; recovery after a hit is short', () => {
    const fx = fixture();
    cast(fx);
    runUntil(fx, () => slammed(fx));
    expect(loss(fx.t)).toBeGreaterThanOrEqual(228);
    expect(loss(fx.t)).toBeLessThanOrEqual(232);
    const hits = ofType(fx.log, 'hit').filter((h) => h.ev.targetId === 1);
    expect(hits).toHaveLength(1);
    expect(fx.t.staggerTimer).toBeGreaterThan(K.stunS - 0.05);
    expect(fx.t.staggerTimer).toBeLessThanOrEqual(K.stunS);
    const impact = ofType(fx.log, 'ultimateStage').slice(-1)[0];
    runUntil(fx, () => fx.c.ability === null);
    const recTicks = fx.tick - impact.tick;
    expect(seconds(recTicks)).toBeLessThan(K.hitRecoveryS + 0.1);
    expect(seconds(recTicks)).toBeGreaterThan(K.hitRecoveryS - 0.1);
  });

  it('DODGE BY LEAVING: a victim that walks out of the committed circle takes nothing; the giraffe whiffs for ~0.9 s', () => {
    const fx = fixture();
    cast(fx);
    runUntil(fx, () => committed(fx), 400);
    fx.intents.set(1, { ...neutral(), moveX: 1 }); // sidestep as soon as the circle commits
    runUntil(fx, () => fx.c.ability === null);
    // Leaving the direct circle spares the 230 and the stun; a slow walker can still clip the 50-damage shock ring.
    expect(loss(fx.t)).toBeLessThanOrEqual(52);
    expect(fx.t.staggerTimer).toBeLessThan(K.stunS - 0.2);
    const impact = ofType(fx.log, 'ultimateStage').slice(-1)[0];
    expect(impact.ev.stage).toBe(2);
    const recTicks = fx.tick - impact.tick;
    expect(seconds(recTicks)).toBeGreaterThan(K.recoveryS - 0.1);
    expect(seconds(recTicks)).toBeLessThan(K.recoveryS + 0.15);
  });

  it('SHOCK RING: a bystander 2.9 m from the impact takes 50 + stagger, the victim only the direct 230; 6 m away is untouched', () => {
    const fx = fixture(['giraffe', 'hippo', 'lion', 'lion'], 5);
    const sub = fx.world.fighters[2];
    const far = fx.world.fighters[3];
    sub.state.pos = { x: LX + 2.9, y: 0, z: CZ + 5 }; // inside the 2.2 ring + its body, outside the 1.6 direct circle + body
    far.state.pos = { x: LX + 6.5, y: 0, z: CZ + 5 };
    fx.others.length = 0;
    cast(fx);
    runUntil(fx, () => slammed(fx));
    expect(loss(fx.t)).toBeGreaterThanOrEqual(228);
    expect(loss(fx.t)).toBeLessThanOrEqual(232);
    expect(loss(sub)).toBeGreaterThanOrEqual(48);
    expect(loss(sub)).toBeLessThanOrEqual(52);
    expect(sub.staggerTimer).toBeGreaterThan(0);
    expect(sub.staggerTimer).toBeLessThan(K.stunS); // a stagger, not the 1 s stun
    expect(loss(far)).toBe(0);
  });

  it('a BLOCKING victim takes the reduced (blockable) hit and is NOT stunned; the guard drains', () => {
    const fx = fixture();
    fx.intents.set(1, { ...neutral(), block: true, aimYaw: Math.PI });
    cast(fx);
    runUntil(fx, () => slammed(fx));
    expect(loss(fx.t)).toBeLessThan(230 * (1 - ANIMALS.hippo.blockReduction) + 3);
    expect(ofType(fx.log, 'blocked').length).toBeGreaterThanOrEqual(1);
    expect(fx.t.state.guard).toBeLessThan(fx.t.state.maxGuard);
    expect(fx.t.staggerTimer).toBeLessThanOrEqual(1.6); // at most a guard-break stagger, never the stun on top
  });

  it('a victim in the air (above ground reach) at impact is missed', () => {
    const fx = fixture();
    cast(fx);
    runUntil(fx, () => committed(fx), 400);
    for (let i = 0; i < 300 && fx.c.ability !== null && !slammed(fx); i++) {
      fx.t.state.pos.y = 4.5;
      step(fx);
    }
    expect(fx.t.state.hp).toBe(fx.t.state.maxHp);
  });

  it('a victim that dies mid-tracking does not stop the slam (it whiffs onto the last circle position)', () => {
    const fx = fixture(['giraffe', 'hippo', 'lion']); // a third fighter keeps the match running
    cast(fx);
    for (let i = 0; i < 20; i++) step(fx);
    fx.t.state.hp = 0;
    runUntil(fx, () => fx.c.ability === null);
    expect(fx.c.ability).toBeNull();
    expect(ofType(fx.log, 'ultimateStage').slice(-1)[0].ev.stage).toBe(2);
  });
});

describe('giraffe Timber Fall — cleanup', () => {
  it('the caster dying mid-ultimate leaves no flags behind', () => {
    const fx = fixture();
    cast(fx);
    runUntil(fx, () => committed(fx), 400);
    step(fx);
    expect(fx.c.ccImmuneChannel).toBe(true);
    fx.c.state.hp = 0;
    step(fx);
    expect(fx.c.state.alive).toBe(false);
    expect(fx.c.ability).toBeNull();
    expect(fx.c.ccImmuneChannel).toBe(false);
  });

  it('an interrupt during the recovery ends the ultimate cleanly (no stuck flags)', () => {
    const fx = fixture();
    cast(fx);
    runUntil(fx, () => slammed(fx), 500);
    step(fx); // World refreshes `ccImmune` from the channel flag (cleared at the slam)
    expect(fx.c.ability).not.toBeNull();
    fx.c.interrupt();
    expect(fx.c.ability).toBeNull();
    expect(fx.c.ccImmuneChannel).toBe(false);
  });
});

describe('giraffe Timber Fall — bot danger-zone protocol', () => {
  it('the real events drive DangerZones: tracking is not dodged, the commit is, the impact clears it', () => {
    const fx = fixture();
    const zones = new DangerZones();
    cast(fx);
    let committedSeen = false;
    let clearedAfter = false;
    let fedTo = 0;
    for (let i = 0; i < 400 && fx.c.ability !== null; i++) {
      step(fx);
      for (; fedTo < fx.log.length; fedTo++) zones.ingest(fx.log[fedTo].ev, fx.tick * DT, 0, 1, () => 'giraffe');
      const z = zones.find(0);
      const stage = fx.c.ability?.stage ?? 2;
      if (z !== undefined && stage === 0) expect(zones.isLive(z, fx.tick * DT)).toBe(false);
      if (z !== undefined && stage === 1) {
        committedSeen = true;
        expect(zones.isLive(z, fx.tick * DT)).toBe(true);
        expect(zones.insideAny(fx.t.state.pos.x, fx.t.state.pos.z, 0.5, fx.tick * DT)).toBe(true);
        expect(zones.insideAny(fx.t.state.pos.x + 4, fx.t.state.pos.z, 0.5, fx.tick * DT)).toBe(false);
      }
      if (z === undefined && stage >= 2) clearedAfter = true;
    }
    expect(committedSeen).toBe(true);
    expect(clearedAfter).toBe(true);
    expect(zones.count).toBe(0);
  });
});

describe('giraffe Timber Fall — determinism', () => {
  it('two identical runs produce identical events, positions and hp', () => {
    const run = (): string => {
      const fx = fixture(['giraffe', 'hippo', 'lion']);
      cast(fx);
      fx.intents.set(1, { ...neutral(), moveX: 0.6, moveZ: 0.4 });
      const trace: string[] = [];
      runUntil(fx, () => fx.c.ability === null);
      for (const l of fx.log) if (l.ev.type === 'ultimateStage' || l.ev.type === 'hit') trace.push(JSON.stringify([l.tick, l.ev]));
      trace.push(JSON.stringify([fx.c.state.pos, fx.t.state.hp, fx.tick]));
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

describe('giraffe Timber Fall — audio module', () => {
  const tgt = { type: 'ultimateTarget', fighterId: 0, animal: 'giraffe', kind: 'lock', targetId: 1, from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 5 }, range: 7.5, width: 0, windup: 1.1 } as GameEventOf<'ultimateTarget'>;
  const stage = (n: number): GameEventOf<'ultimateStage'> => ({ type: 'ultimateStage', fighterId: 0, animal: 'giraffe', stage: n, targetId: 1, pos: { x: 0, y: 0, z: 5 } });
  it('creak + whoosh on cast, silent tracking beats, lock tone on commit, slam thud on impact; never throws', () => {
    const fx = fakeAudioApi();
    giraffeAudio.onTarget!(fx.api, tgt);
    const afterCast = fx.voices();
    expect(afterCast).toBeGreaterThanOrEqual(3);
    giraffeAudio.onStage!(fx.api, stage(0));
    expect(fx.voices()).toBe(afterCast); // the tracking cadence makes no sound
    giraffeAudio.onStage!(fx.api, stage(1));
    const afterCommit = fx.voices();
    expect(afterCommit).toBeGreaterThan(afterCast + 1);
    giraffeAudio.onStage!(fx.api, stage(2));
    expect(fx.voices()).toBeGreaterThan(afterCommit + 3);
  });
  it('is inaudible (no voices) when far from the listener', () => {
    const fx = fakeAudioApi();
    (fx.api as unknown as { gainAt: () => number }).gainAt = () => 0;
    giraffeAudio.onTarget!(fx.api, tgt);
    giraffeAudio.onStage!(fx.api, stage(1));
    giraffeAudio.onStage!(fx.api, stage(2));
    expect(fx.voices()).toBe(0);
  });
});

// ── bots: a hippo victim (seeds 1-8 at 6 m; a bot that is mid-melee or mid-special when the circle commits never dodges) driven by the real BotManager at a given difficulty (caster = human-controlled intents) ──
function botVictimLoss(lvl: Difficulty, seed: number): number {
  const cfg: MatchConfig = { roster: [{ animal: 'giraffe', isPlayer: true }, { animal: 'hippo', isPlayer: false }], difficulty: lvl };
  const bus = new EventBus();
  const world = new BotWorld(cfg, seed, bus, { traps: false });
  const bots = new BotManager(bus, lvl, seed);
  let slammedOnce = false;
  bus.on('ultimateStage', (e) => {
    if (e.stage === 2) slammedOnce = true;
  });
  for (let i = 0; i < 190; i++) world.step(DT);
  const c = world.fighters[0];
  const v = world.fighters[1];
  c.state.pos = { x: LX, y: 0, z: CZ };
  c.state.yaw = 0;
  v.state.pos = { x: LX, y: 0, z: CZ + 6 };
  v.state.yaw = Math.PI;
  c.state.ultCharge = 100;
  let pressed = false;
  for (let i = 0; i < 60 * 6; i++) {
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
    if (slammedOnce && c.ability === null) break;
  }
  return v.state.maxHp - v.state.hp;
}

describe('giraffe Timber Fall — real bots dodge the committed circle', () => {
  it('Apex (strict) bots leave it: at most one of eight seeds eats the 230 direct hit; never-dodging Cubs nearly always do', () => {
    let apexDirect = 0;
    for (let seed = 1; seed <= 8; seed++) if (botVictimLoss(4, seed) >= 200) apexDirect++;
    expect(apexDirect).toBeLessThanOrEqual(1);
    let ctrl = 0;
    for (let seed = 1; seed <= 8; seed++) if (botVictimLoss(1, seed) >= 200) ctrl++;
    expect(ctrl).toBeGreaterThanOrEqual(apexDirect + 4);
  });
});

// ── bot script (decideAbilities → ULT_SCRIPTS) ──
function sit(animal: AnimalId, lvl: Difficulty, over: Partial<Situation>): Situation {
  return {
    animal, profile: BOT_PROFILES[lvl], rng: mulberry32(1), now: 10, hpFrac: 1, guardFrac: 1, specialReady: false, ultReady: true,
    ultHeldS: 0, retreating: false, hasTarget: true, tdist: 4, tHpFrac: 1, tGuardFrac: 1, targetHelpless: false, targetRooted: false,
    targetBlocking: false, targetCommitted: false, targetFleeing: false, targetIsolated: false, nearestEnemyDist: 4, enemiesNearSelf5: 0,
    enemiesNearSelf8: 0, enemiesNearTarget8: 0, wallBehindTarget: false, recentFinisher: false, aimYawToTarget: 0, aimYawAway: Math.PI,
    aimYawNearest: 0, ...over,
  };
}
function wantsUlt(s: Situation): boolean {
  const out: AbilityWish = { special: false, ult: false, aimYaw: 0 };
  decideAbilities(s, out);
  return out.ult;
}

describe('giraffe Timber Fall — bot script', () => {
  it('Apex casts at helpless / rooted / mid-cast / guard-broken / hurt-and-isolated / turtling-and-isolated foes in range, never at runners or healthy crowds', () => {
    expect(wantsUlt(sit('giraffe', 4, { targetHelpless: true }))).toBe(true);
    expect(wantsUlt(sit('giraffe', 4, { targetRooted: true, tdist: 6 }))).toBe(true);
    expect(wantsUlt(sit('giraffe', 4, { targetCommitted: true }))).toBe(true);
    expect(wantsUlt(sit('giraffe', 4, { tGuardFrac: 0.2 }))).toBe(true);
    expect(wantsUlt(sit('giraffe', 4, { targetIsolated: true, tHpFrac: 0.5 }))).toBe(true);
    expect(wantsUlt(sit('giraffe', 4, { targetIsolated: true, targetBlocking: true }))).toBe(true);
    expect(wantsUlt(sit('giraffe', 4, { targetHelpless: true, targetFleeing: true }))).toBe(false);
    expect(wantsUlt(sit('giraffe', 4, {}))).toBe(false);
    expect(wantsUlt(sit('giraffe', 4, { targetIsolated: true, tHpFrac: 0.9 }))).toBe(false);
  });
  it('range gate: not at a hugging foe, not beyond ~6.8 m (lock range 7.5 m)', () => {
    expect(wantsUlt(sit('giraffe', 4, { targetHelpless: true, tdist: 1.2 }))).toBe(false);
    expect(wantsUlt(sit('giraffe', 4, { targetHelpless: true, tdist: 7.4 }))).toBe(false);
    expect(wantsUlt(sit('giraffe', 2, { tdist: 4 }))).toBe(true); // Fighter: any target in range
    expect(wantsUlt(sit('giraffe', 2, { tdist: 8 }))).toBe(false);
  });
  it('Veteran uses the ranged window: helpless / guard-broken / hurt-and-isolated foes yes, runners no', () => {
    expect(wantsUlt(sit('giraffe', 3, { targetHelpless: true }))).toBe(true);
    expect(wantsUlt(sit('giraffe', 3, { tGuardFrac: 0.1 }))).toBe(true);
    expect(wantsUlt(sit('giraffe', 3, { targetIsolated: true, tHpFrac: 0.4, targetFleeing: true }))).toBe(false);
    expect(wantsUlt(sit('giraffe', 3, {}))).toBe(false);
  });
});
