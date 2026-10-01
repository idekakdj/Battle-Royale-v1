/**
 * Eagle — Death From Above (v1.3 "stoop"): lock (16 m / 90°), spiral ascent out of sight, reticle that
 * tracks then commits, fast dive onto the committed circle (240 direct r1.4 + 60 splash 3 m), whiff recovery.
 */

import { describe, it, expect } from 'vitest';
import { liveWorld, neutral, disablePickups, DT } from '../helpers';
import { ANIMALS } from '../../../src/config/animals';
import { EAGLE_DFA } from '../../../src/config/ultimates/eagle';
import type { AnimalId, FighterIntent, GameEvent, GameEventOf } from '../../../src/core/types';
import type { World } from '../../../src/sim/World';
import type { Fighter } from '../../../src/sim/Fighter';
import { dfaBeat, dfaReticle } from '../../../src/sim/ultimates/eagle';
import { DangerZones } from '../../../src/ai/dangerZones';
import { synth, type UltAudioApi } from '../../../src/audio/ults';
import eagleAudio from '../../../src/audio/ults/eagle';
import { World as BotWorld } from '../../../src/sim/World';
import { EventBus } from '../../../src/core/EventBus';
import { BotManager } from '../../../src/ai/BotManager';
import type { Difficulty, MatchConfig } from '../../../src/core/types';
import { decideAbilities, type Situation, type AbilityWish } from '../../../src/ai/scripts';
import { BOT_PROFILES } from '../../../src/config/botProfiles';
import { mulberry32 } from '../../../src/core/math';

type Timed = { tick: number; ev: GameEvent };

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

function fixture(roster: AnimalId[] = ['eagle', 'hippo'], targetDist = 8, targetDeg = 0): Fx {
  const events: GameEvent[] = [];
  const { world } = liveWorld(roster, 7, events);
  disablePickups(world);
  const fs = world.fighters;
  const c = fs[0];
  const t = fs[1];
  c.state.pos = { x: 0, y: 0, z: 0 };
  c.state.yaw = 0;
  c.state.vel = { x: 0, y: 0, z: 0 };
  const a = (targetDeg * Math.PI) / 180;
  t.state.pos = { x: Math.sin(a) * targetDist, y: 0, z: Math.cos(a) * targetDist };
  t.state.yaw = Math.PI;
  t.state.vel = { x: 0, y: 0, z: 0 };
  // Park everybody else far away so nothing interferes.
  for (let i = 2; i < fs.length; i++) fs[i].state.pos = { x: -20 + i, y: 0, z: -20 };
  return { world, events, log: [], tick: 0, c, t, others: fs.slice(2), intents: new Map() };
}

/** Advance one tick with the given intents (default neutral), logging the new events with the tick number. */
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

describe('eagle Death From Above — config', () => {
  const spec = ANIMALS.eagle.ultimate;
  it('is a 16 m / 90° lock that requires a target and opts into the commit dodge protocol', () => {
    expect(spec.name).toBe('Death From Above');
    expect(spec.targeting?.kind).toBe('lock');
    expect(spec.targeting?.range).toBe(16);
    expect(spec.targeting?.coneDeg).toBe(90);
    expect(spec.targeting?.requireTarget).toBe(true);
    expect(spec.targeting?.dodge?.mode).toBe('commit');
    expect(spec.damage).toBe(240);
    expect(spec.splashDamage).toBe(60);
    expect(spec.splashRadius).toBe(3);
    expect(spec.description).toMatch(/reticle/i);
  });
  it('commitS covers the warning plus the stoop and the tracking cap covers ascent + tracking', () => {
    const d = spec.targeting!.dodge!;
    expect(d.commitS!).toBeGreaterThan(EAGLE_DFA.commitS + 0.8);
    expect(d.activeS!).toBeGreaterThan(EAGLE_DFA.trackS + 0.3);
  });
});

describe('eagle Death From Above — targeting / fizzle', () => {
  it('no foe in the 90° cone: fizzles, nothing spent, no cast events', () => {
    const fx = fixture(['eagle', 'hippo'], 8, 90); // 90° off the aim
    cast(fx);
    expect(fx.c.state.ultCharge).toBe(100);
    expect(fx.c.ability).toBeNull();
    expect(ofType(fx.log, 'ultimateFizzle')).toHaveLength(1);
    expect(ofType(fx.log, 'ultimate')).toHaveLength(0);
    expect(ofType(fx.log, 'ultimateTarget')).toHaveLength(0);
  });

  it('a foe beyond 16 m fizzles, one inside 16 m (and 40° off-axis) locks', () => {
    const far = fixture(['eagle', 'hippo'], 18);
    cast(far);
    expect(ofType(far.log, 'ultimateFizzle')).toHaveLength(1);
    expect(far.c.state.ultCharge).toBe(100);

    const near = fixture(['eagle', 'hippo'], 15, 40);
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

  it('emits ultimateTarget (lock, victim id, ascent lead time) right after the ultimate event', () => {
    const fx = fixture();
    cast(fx);
    const tg = ofType(fx.log, 'ultimateTarget');
    expect(tg).toHaveLength(1);
    expect(tg[0].ev.kind).toBe('lock');
    expect(tg[0].ev.targetId).toBe(1);
    expect(tg[0].ev.range).toBe(16);
    expect(tg[0].ev.windup).toBeCloseTo(EAGLE_DFA.ascentS, 9);
    expect(tg[0].ev.to.z).toBeCloseTo(8, 6);
    const types = fx.log.map((l) => l.ev.type);
    expect(types.indexOf('ultimateTarget')).toBeGreaterThan(types.indexOf('ultimate'));
  });
});

describe('eagle Death From Above — ascent, hold and phases', () => {
  it('rockets up untargetable and uninterruptible; snapshot walks windup → active(stage 0 → 1) → recovery(stage 2)', () => {
    const fx = fixture();
    cast(fx);
    let maxY = 0;
    let sawWindupEnd = false;
    const seen = new Set<string>();
    for (let i = 0; i < 400 && fx.c.ability !== null; i++) {
      step(fx);
      const st = fx.world.snapshot().fighters[0];
      seen.add(`${st.ultPhase}:${st.ultStage}`);
      if (st.ultPhase !== undefined) expect(st.ultTargetId).toBe(1);
      maxY = Math.max(maxY, st.pos.y);
      if (fx.c.ability !== null && fx.c.ability.phase !== 0 && !sawWindupEnd) {
        sawWindupEnd = true;
        expect(seconds(fx.tick - 1)).toBeGreaterThanOrEqual(EAGLE_DFA.ascentS - 0.05);
      }
      if (st.ultPhase === 'windup' || st.ultPhase === 'active') {
        if (st.ultStage !== 2) {
          expect(fx.c.untargetable).toBe(true);
          expect(fx.c.ccImmuneChannel).toBe(true);
          fx.c.interrupt();
          expect(fx.c.ability).not.toBeNull(); // cannot be interrupted while airborne
        }
      }
    }
    expect(maxY).toBeGreaterThan(EAGLE_DFA.holdAlt - 1.5);
    expect(seen.has('windup:0')).toBe(true);
    expect(seen.has('active:0')).toBe(true);
    expect(seen.has('active:1')).toBe(true);
    expect(seen.has('recovery:2')).toBe(true);
    expect(fx.c.ability).toBeNull();
    expect(fx.c.untargetable).toBe(false);
    expect(fx.c.ccImmuneChannel).toBe(false);
  });

  it('is out of ground reach during the ascent (a ground AoE cast under it hits nothing) and lands exactly once', () => {
    const fx = fixture();
    cast(fx);
    for (let i = 0; i < Math.round(EAGLE_DFA.ascentS / DT) + 20; i++) step(fx);
    expect(fx.c.state.pos.y).toBeGreaterThan(EAGLE_DFA.holdAlt * 0.6);
    expect(fx.c.state.airborne).toBe(true);
    runUntil(fx, () => fx.c.ability === null);
    expect(ofType(fx.log, 'landingImpact')).toHaveLength(0); // no double-trigger of the v1.2 landing slam
    expect(fx.c.state.pos.y).toBe(0);
    expect(fx.c.state.airborne).toBe(false);
    expect(fx.c.landRecoverT).toBe(0);
    expect(fx.c.pendingLandingPeak).toBe(0);
    // A few more ticks of normal locomotion: still no slam, still on the ground.
    for (let i = 0; i < 40; i++) step(fx);
    expect(ofType(fx.log, 'landingImpact')).toHaveLength(0);
    expect(fx.c.state.pos.y).toBe(0);
  });

  it('cancels a low glide when the cast starts (no slam on the way down, flight cooldown starts)', () => {
    const fx = fixture();
    fx.c.state.pos.y = 2.4;
    fx.c.state.glideT = 1.5;
    cast(fx);
    expect(fx.c.ability).not.toBeNull();
    step(fx);
    expect(fx.c.state.glideT).toBe(0);
    runUntil(fx, () => fx.c.ability === null);
    expect(ofType(fx.log, 'landingImpact')).toHaveLength(0);
  });
});

describe('eagle Death From Above — track → commit → stoop', () => {
  it('stage events: 0 while tracking (steady cadence, centre near the victim), one 1 (commit) then one 2 (impact)', () => {
    const fx = fixture();
    cast(fx);
    runUntil(fx, () => fx.c.ability === null);
    const st = ofType(fx.log, 'ultimateStage');
    const stages = st.map((s) => s.ev.stage);
    const iCommit = stages.indexOf(1);
    expect(iCommit).toBeGreaterThan(3);
    expect(stages.filter((s) => s === 1)).toHaveLength(1);
    expect(stages.filter((s) => s === 2)).toHaveLength(1);
    expect(stages[stages.length - 1]).toBe(2);
    expect(stages.slice(0, iCommit).every((s) => s === 0)).toBe(true);
    // Tracking cadence ~0.1 s.
    const track = st.slice(0, iCommit);
    for (let i = 2; i < track.length; i++) expect(seconds(track[i].tick - track[i - 1].tick)).toBeLessThan(0.15);
    // Commit lands ascent + trackS after the cast (the first tick already advanced once).
    expect(seconds(st[iCommit].tick - 1)).toBeCloseTo(EAGLE_DFA.ascentS + EAGLE_DFA.trackS, 1);
    // The stoop starts commitS later and lands quickly (fast dive).
    const impact = st[st.length - 1];
    const dive = seconds(impact.tick - st[iCommit].tick) - EAGLE_DFA.commitS;
    expect(dive).toBeGreaterThan(0.4);
    expect(dive).toBeLessThan(1.3);
    // A stationary victim: the reticle sits on them, and the commit pos equals the impact pos.
    expect(st[iCommit].ev.pos.z).toBeCloseTo(8, 1);
    expect(impact.ev.pos.z).toBeCloseTo(st[iCommit].ev.pos.z, 1);
    expect(impact.ev.targetId).toBe(1);
  });

  it('the reticle LAGS a moving victim, then freezes at the commit', () => {
    const fx = fixture(['eagle', 'hippo'], 6);
    cast(fx);
    fx.intents.set(1, { ...neutral(), moveX: 1 }); // the victim walks along +X the whole time
    runUntil(fx, () => ofType(fx.log, 'ultimateStage').some((s) => s.ev.stage === 1), 400);
    const st = ofType(fx.log, 'ultimateStage');
    const last0 = st.filter((s) => s.ev.stage === 0).slice(-1)[0];
    const commit = st.find((s) => s.ev.stage === 1)!;
    const victimX = fx.t.state.pos.x;
    expect(victimX).toBeGreaterThan(3);
    expect(commit.ev.pos.x).toBeLessThan(victimX - 0.4); // behind the victim
    expect(commit.ev.pos.x).toBeGreaterThan(0.3); // but following
    expect(commit.ev.pos.x).toBeGreaterThanOrEqual(last0.ev.pos.x - 1e-9); // monotone toward the victim
    // Frozen after the commit.
    const ret = dfaReticle(fx.c.ability);
    for (let i = 0; i < 20; i++) step(fx);
    const ret2 = dfaReticle(fx.c.ability);
    expect(ret2!.x).toBeCloseTo(ret!.x, 9);
    expect(dfaBeat(fx.c.ability)).toBe('commit');
  });

  it('a stationary victim takes 240 once (no splash on top), is staggered; recovery after a hit is short', () => {
    const fx = fixture();
    cast(fx);
    runUntil(fx, () => fx.c.ability === null);
    expect(fx.t.state.maxHp - fx.t.state.hp).toBeGreaterThanOrEqual(238);
    expect(fx.t.state.maxHp - fx.t.state.hp).toBeLessThanOrEqual(242);
    const hits = ofType(fx.log, 'hit').filter((h) => h.ev.targetId === 1);
    expect(hits).toHaveLength(1);
    const impact = ofType(fx.log, 'ultimateStage').slice(-1)[0];
    const recTicks = fx.tick - impact.tick;
    expect(seconds(recTicks)).toBeLessThan(0.75);
    expect(seconds(recTicks)).toBeGreaterThan(0.4);
  });

  it('DODGE BY LEAVING: a victim that walks out of the committed circle takes nothing; the eagle whiffs for ~1 s', () => {
    const fx = fixture();
    cast(fx);
    runUntil(fx, () => ofType(fx.log, 'ultimateStage').some((s) => s.ev.stage === 1), 400);
    fx.intents.set(1, { ...neutral(), moveX: 1 }); // sidestep as soon as the circle commits
    runUntil(fx, () => fx.c.ability === null);
    expect(fx.t.state.hp).toBe(fx.t.state.maxHp);
    const impact = ofType(fx.log, 'ultimateStage').slice(-1)[0];
    expect(impact.ev.stage).toBe(2);
    expect(fx.c.ability).toBeNull();
    const recTicks = fx.tick - impact.tick;
    expect(seconds(recTicks)).toBeGreaterThan(0.9);
    expect(seconds(recTicks)).toBeLessThan(1.2);
    // The whiffing eagle is a normal, targetable fighter on the ground again.
    expect(fx.c.untargetable).toBe(false);
  });

  it('SPLASH: a bystander 3.6 m from the impact takes 60, the victim takes only the direct 240', () => {
    const fx = fixture(['eagle', 'hippo', 'hippo'], 8);
    // Third fighter 3.6 m from the victim (splash radius 3 + body 1.2 reach, direct 1.4 + 1.2 does not).
    const sub = fx.world.fighters[2];
    sub.state.pos = { x: 3.6, y: 0, z: 8 };
    fx.others.length = 0;
    cast(fx);
    runUntil(fx, () => fx.c.ability === null);
    expect(fx.t.state.maxHp - fx.t.state.hp).toBeGreaterThanOrEqual(238);
    expect(fx.t.state.maxHp - fx.t.state.hp).toBeLessThanOrEqual(242);
    const splashHp = sub.state.maxHp - sub.state.hp;
    expect(splashHp).toBeGreaterThanOrEqual(58);
    expect(splashHp).toBeLessThanOrEqual(62);
  });

  it('a bystander outside the 3 m splash is untouched', () => {
    const fx = fixture(['eagle', 'hippo', 'hippo'], 8);
    const far = fx.world.fighters[2];
    far.state.pos = { x: 6.5, y: 0, z: 8 };
    cast(fx);
    runUntil(fx, () => fx.c.ability === null);
    expect(far.state.hp).toBe(far.state.maxHp);
  });

  it('a victim in the air (above ground reach) at impact is missed', () => {
    const fx = fixture();
    cast(fx);
    runUntil(fx, () => ofType(fx.log, 'ultimateStage').some((s) => s.ev.stage === 1), 400);
    for (let i = 0; i < 300 && fx.c.ability !== null && ofType(fx.log, 'ultimateStage').every((s) => s.ev.stage !== 2); i++) {
      fx.t.state.pos.y = 4.5;
      step(fx);
    }
    expect(fx.t.state.hp).toBe(fx.t.state.maxHp);
  });

  it('a victim that dies mid-tracking does not stop the stoop (it whiffs onto the last reticle position)', () => {
    const fx = fixture(['eagle', 'hippo', 'hippo']); // a third fighter keeps the match running
    cast(fx);
    for (let i = 0; i < 60; i++) step(fx);
    fx.t.state.hp = 0;
    runUntil(fx, () => fx.c.ability === null);
    expect(fx.c.ability).toBeNull();
    expect(ofType(fx.log, 'ultimateStage').slice(-1)[0].ev.stage).toBe(2);
  });
});

describe('eagle Death From Above — cleanup', () => {
  it('the caster dying mid-ultimate leaves no flags behind', () => {
    const fx = fixture();
    cast(fx);
    for (let i = 0; i < 90; i++) step(fx);
    expect(fx.c.untargetable).toBe(true);
    fx.c.state.hp = 0;
    step(fx);
    expect(fx.c.state.alive).toBe(false);
    expect(fx.c.ability).toBeNull();
    expect(fx.c.untargetable).toBe(false);
    expect(fx.c.ccImmuneChannel).toBe(false);
    expect(fx.c.state.airborne).toBe(false);
  });

  it('an interrupt during the recovery ends the ultimate cleanly (no stuck flags)', () => {
    const fx = fixture();
    cast(fx);
    runUntil(fx, () => ofType(fx.log, 'ultimateStage').some((s) => s.ev.stage === 2), 500);
    step(fx); // World refreshes `ccImmune` from the channel flag (cleared at the touchdown)
    expect(fx.c.ability).not.toBeNull();
    fx.c.interrupt();
    expect(fx.c.ability).toBeNull();
    expect(fx.c.untargetable).toBe(false);
    expect(fx.c.ccImmuneChannel).toBe(false);
  });
});

describe('eagle Death From Above — bot danger-zone protocol', () => {
  it('the real events drive DangerZones: tracking is not dodged, the commit is, the impact clears it', () => {
    const fx = fixture();
    const zones = new DangerZones();
    cast(fx);
    let committedSeen = false;
    let clearedAfter = false;
    let fedTo = 0;
    for (let i = 0; i < 400 && fx.c.ability !== null; i++) {
      step(fx);
      for (; fedTo < fx.log.length; fedTo++) zones.ingest(fx.log[fedTo].ev, fx.tick * DT, 0, 1, () => 'eagle');
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

describe('eagle Death From Above — determinism', () => {
  it('two identical runs produce identical events, positions and hp', () => {
    const run = (): string => {
      const fx = fixture(['eagle', 'hippo', 'lion']);
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

describe('eagle Death From Above — audio module', () => {
  const tgt = { type: 'ultimateTarget', fighterId: 0, animal: 'eagle', kind: 'lock', targetId: 1, from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 8 }, range: 16, width: 0, windup: 0.8 } as GameEventOf<'ultimateTarget'>;
  const stage = (n: number): GameEventOf<'ultimateStage'> => ({ type: 'ultimateStage', fighterId: 0, animal: 'eagle', stage: n, targetId: 1, pos: { x: 0, y: 0, z: 8 } });
  it('screech on cast, silent tracking beats, ping + stoop rush on commit, thud on impact; never throws', () => {
    const fx = fakeAudioApi();
    eagleAudio.onTarget!(fx.api, tgt);
    const afterCast = fx.voices();
    expect(afterCast).toBeGreaterThanOrEqual(4); // 3 wing beats + screech layers
    eagleAudio.onStage!(fx.api, stage(0));
    expect(fx.voices()).toBe(afterCast); // the tracking cadence makes no sound
    eagleAudio.onStage!(fx.api, stage(1));
    const afterCommit = fx.voices();
    expect(afterCommit).toBeGreaterThan(afterCast + 4); // pings + screech + wind rush layers
    eagleAudio.onStage!(fx.api, stage(2));
    expect(fx.voices()).toBeGreaterThan(afterCommit + 2);
  });
  it('is inaudible (no voices) when far from the listener', () => {
    const fx = fakeAudioApi();
    (fx.api as unknown as { gainAt: () => number }).gainAt = () => 0;
    eagleAudio.onTarget!(fx.api, tgt);
    eagleAudio.onStage!(fx.api, stage(1));
    expect(fx.voices()).toBe(0);
  });
});

// ── bots: a hippo victim driven by the real BotManager at a given difficulty (caster = human-controlled intents) ──
function botVictimLoss(animal: AnimalId, lvl: Difficulty, seed: number, victimZ: number, casterZ: number): number {
  const cfg: MatchConfig = { roster: [{ animal, isPlayer: true }, { animal: 'hippo', isPlayer: false }], difficulty: lvl };
  const bus = new EventBus();
  const world = new BotWorld(cfg, seed, bus, { traps: false });
  const bots = new BotManager(bus, lvl, seed);
  let impacted = false;
  bus.on('ultimateStage', (e) => {
    if (e.stage === 2) impacted = true;
  });
  for (let i = 0; i < 190; i++) world.step(DT);
  const c = world.fighters[0];
  const v = world.fighters[1];
  c.state.pos = { x: 0, y: 0, z: casterZ };
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
    if (impacted && c.ability === null) break;
  }
  return v.state.maxHp - v.state.hp;
}

describe('eagle Death From Above — real bots dodge the committed circle', () => {
  it('Apex (strict) bots leave it: at most one of eight seeds eats the 240 direct hit; never-dodging Cubs do sometimes', () => {
    let apexDirect = 0;
    for (let seed = 1; seed <= 8; seed++) if (botVictimLoss('eagle', 4, seed, 5, -6) >= 200) apexDirect++;
    expect(apexDirect).toBeLessThanOrEqual(1);
    let ctrl = 0;
    for (let seed = 1; seed <= 8; seed++) if (botVictimLoss('eagle', 1, seed, 5, -6) >= 200) ctrl++;
    expect(ctrl).toBeGreaterThanOrEqual(apexDirect);
  });
});

// ── bot script (decideAbilities → ULT_SCRIPTS) ──
function sit(animal: AnimalId, lvl: Difficulty, over: Partial<Situation>): Situation {
  return {
    animal, profile: BOT_PROFILES[lvl], rng: mulberry32(1), now: 10, hpFrac: 1, guardFrac: 1, specialReady: false, ultReady: true,
    ultHeldS: 0, retreating: false, hasTarget: true, tdist: 8, tHpFrac: 1, tGuardFrac: 1, targetHelpless: false, targetRooted: false,
    targetBlocking: false, targetCommitted: false, targetFleeing: false, targetIsolated: false, nearestEnemyDist: 8, enemiesNearSelf5: 0,
    enemiesNearSelf8: 0, enemiesNearTarget8: 0, wallBehindTarget: false, recentFinisher: false, aimYawToTarget: 0, aimYawAway: Math.PI,
    aimYawNearest: 0, ...over,
  };
}
function wantsUlt(s: Situation): boolean {
  const out: AbilityWish = { special: false, ult: false, aimYaw: 0 };
  decideAbilities(s, out);
  return out.ult;
}

describe('eagle Death From Above — bot script', () => {
  it('Apex casts at helpless / rooted / mid-cast / hurt-and-isolated / blocking-and-isolated foes in range, never at runners or healthy crowds', () => {
    expect(wantsUlt(sit('eagle', 4, { targetHelpless: true }))).toBe(true);
    expect(wantsUlt(sit('eagle', 4, { targetRooted: true, tdist: 13 }))).toBe(true);
    expect(wantsUlt(sit('eagle', 4, { targetCommitted: true }))).toBe(true);
    expect(wantsUlt(sit('eagle', 4, { targetIsolated: true, tHpFrac: 0.5 }))).toBe(true);
    expect(wantsUlt(sit('eagle', 4, { targetIsolated: true, targetBlocking: true }))).toBe(true);
    expect(wantsUlt(sit('eagle', 4, { targetHelpless: true, targetFleeing: true }))).toBe(false);
    expect(wantsUlt(sit('eagle', 4, {}))).toBe(false);
    expect(wantsUlt(sit('eagle', 4, { targetIsolated: true, tHpFrac: 0.9 }))).toBe(false);
  });
  it('range gate: not in melee, not beyond ~14.5 m (lock range 16 m)', () => {
    expect(wantsUlt(sit('eagle', 4, { targetHelpless: true, tdist: 2 }))).toBe(false);
    expect(wantsUlt(sit('eagle', 4, { targetHelpless: true, tdist: 15.5 }))).toBe(false);
    expect(wantsUlt(sit('eagle', 2, { tdist: 9 }))).toBe(true); // Fighter: any target in range
    expect(wantsUlt(sit('eagle', 2, { tdist: 18 }))).toBe(false);
  });
  it('Veteran uses the ranged window: isolated / helpless foes yes, runners no', () => {
    expect(wantsUlt(sit('eagle', 3, { targetIsolated: true }))).toBe(true);
    expect(wantsUlt(sit('eagle', 3, { targetIsolated: true, targetFleeing: true }))).toBe(false);
  });
});
