/**
 * Mole — Sinkhole Vortex (v1.3): dig + tremor crack (untargetable tunnel), the pit surfaces the mole at its
 * rim, a 2 s vortex drags grounded foes to the centre and grinds them, then the collapse damages + roots.
 */

import { describe, it, expect } from 'vitest';
import { liveWorld, neutral, disablePickups, DT } from '../helpers';
import { ANIMALS } from '../../../src/config/animals';
import { MOLE_VORTEX } from '../../../src/config/ultimates/mole';
import type { AnimalId, FighterIntent, GameEvent, GameEventOf } from '../../../src/core/types';
import type { World } from '../../../src/sim/World';
import type { Fighter } from '../../../src/sim/Fighter';
import { dealDamage } from '../../../src/sim/CombatSystem';
import { sinkholeSurface } from '../../../src/sim/ultimates/mole';
import { isTargetable } from '../../../src/sim/hitbox';
import { DangerZones } from '../../../src/ai/dangerZones';
import { synth, type UltAudioApi } from '../../../src/audio/ults';
import moleAudio from '../../../src/audio/ults/mole';
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
  intents: Map<number, FighterIntent>;
}

function ofType<T extends GameEvent['type']>(log: Timed[], type: T): { tick: number; ev: GameEventOf<T> }[] {
  return log.filter((e) => e.ev.type === type) as { tick: number; ev: GameEventOf<T> }[];
}

function fixture(roster: AnimalId[] = ['mole', 'hippo'], targetDist = 9.5): Fx {
  const events: GameEvent[] = [];
  const { world } = liveWorld(roster, 7, events);
  disablePickups(world);
  const fs = world.fighters;
  const c = fs[0];
  const t = fs[1];
  c.state.pos = { x: 0, y: 0, z: 0 };
  c.state.yaw = 0;
  c.state.vel = { x: 0, y: 0, z: 0 };
  t.state.pos = { x: 0, y: 0, z: targetDist };
  t.state.yaw = Math.PI;
  t.state.vel = { x: 0, y: 0, z: 0 };
  for (let i = 2; i < fs.length; i++) fs[i].state.pos = { x: -20 + i, y: 0, z: -20 };
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
const seconds = (ticks: number): number => ticks * DT;
const dist = (a: Fighter, x: number, z: number): number => Math.hypot(a.state.pos.x - x, a.state.pos.z - z);

/** Cast, then run to the moment the pit opens (stage 1). Returns the pit centre. */
function openPit(fx: Fx): { x: number; z: number } {
  cast(fx);
  runUntil(fx, () => stageSeen(fx, 1));
  const e = ofType(fx.log, 'ultimateStage').find((s) => s.ev.stage === 1)!;
  return { x: e.ev.pos.x, z: e.ev.pos.z };
}

describe('mole Sinkhole Vortex — config', () => {
  const spec = ANIMALS.mole.ultimate;
  it('is a 10 m / 4.5 m ground zone with the vortex numbers and a fixed dodge zone', () => {
    expect(spec.name).toBe('Sinkhole Vortex');
    expect(spec.description).toMatch(/vortex/i);
    expect(spec.targeting?.kind).toBe('ground');
    expect(spec.targeting?.range).toBe(10);
    expect(spec.targeting?.radius).toBe(4.5);
    expect(spec.targeting?.dodge?.mode).toBe('fixed');
    expect(spec.damage).toBe(100);
    expect(spec.bonusVsRooted).toBe(0.25);
    expect(spec.effects?.[0]).toMatchObject({ kind: 'root', dur: 2 });
    expect(MOLE_VORTEX.pullSpeed).toBe(5);
    expect(MOLE_VORTEX.tickDps).toBe(30);
    expect(spec.windup).toBeCloseTo(MOLE_VORTEX.digS + MOLE_VORTEX.crackS, 9);
  });
});

describe('mole Sinkhole Vortex — cast and tunnel', () => {
  it('emits the ground ultimateTarget (zone diameter 9, lead = dig + crack) snapped onto the aimed foe', () => {
    const fx = fixture();
    cast(fx);
    const tg = ofType(fx.log, 'ultimateTarget');
    expect(tg).toHaveLength(1);
    expect(tg[0].ev.kind).toBe('ground');
    expect(tg[0].ev.width).toBe(9);
    expect(tg[0].ev.windup).toBeCloseTo(1.3, 9);
    expect(tg[0].ev.to.z).toBeCloseTo(9.5, 6);
    const types = fx.log.map((l) => l.ev.type);
    expect(types.indexOf('ultimateTarget')).toBeGreaterThan(types.indexOf('ultimate'));
  });

  it('digs in place, goes untargetable, tunnels to the pit rim and surfaces facing the pit', () => {
    const fx = fixture();
    cast(fx);
    // Dig-in: still at the launch point, visible / targetable for the first 0.3 s.
    for (let i = 0; i < 10; i++) step(fx);
    expect(fx.c.state.pos.z).toBeCloseTo(0, 6);
    expect(isTargetable(fx.c)).toBe(true);
    // Tunnel: untargetable, uninterruptible, moving toward the pit.
    for (let i = 0; i < 30; i++) step(fx);
    expect(fx.c.untargetable).toBe(true);
    expect(fx.c.ccImmuneChannel).toBe(true);
    expect(fx.c.state.pos.z).toBeGreaterThan(0.2);
    fx.c.interrupt();
    expect(fx.c.ability).not.toBeNull();
    const surface = sinkholeSurface(fx.c.ability)!;
    runUntil(fx, () => stageSeen(fx, 1));
    expect(fx.c.untargetable).toBe(false);
    const st = fx.world.snapshot().fighters[0];
    expect(st.ultPhase).toBe('active');
    expect(st.ultStage).toBe(1);
    expect(fx.c.state.pos.x).toBeCloseTo(surface.x, 3);
    expect(fx.c.state.pos.z).toBeCloseTo(surface.z, 3);
    // Rim of the 4.5 m pit (+0.9 m) on the side it came from, facing the centre.
    expect(dist(fx.c, 0, 9.5)).toBeCloseTo(4.5 + MOLE_VORTEX.surfaceGap, 1);
    expect(Math.abs(fx.c.state.yaw)).toBeLessThan(0.05);
    expect(seconds(fx.tick - 1)).toBeCloseTo(1.3, 1);
  });

  it('a foe closer than the rim: the mole stays put and the pit forms on the foe', () => {
    const fx = fixture(['mole', 'hippo'], 3);
    cast(fx);
    runUntil(fx, () => stageSeen(fx, 1));
    expect(fx.c.state.pos.z).toBeLessThan(0.3);
    const pit = ofType(fx.log, 'ultimateStage').find((s) => s.ev.stage === 1)!.ev.pos;
    expect(pit.z).toBeCloseTo(3, 1);
  });

  it('phases in the snapshot: windup(0) → active(1) → recovery(2)', () => {
    const fx = fixture();
    cast(fx);
    const seen = new Set<string>();
    for (let i = 0; i < 400 && fx.c.ability !== null; i++) {
      step(fx);
      const st = fx.world.snapshot().fighters[0];
      seen.add(`${st.ultPhase}:${st.ultStage}`);
    }
    expect(seen.has('windup:0')).toBe(true);
    expect(seen.has('active:1')).toBe(true);
    expect(seen.has('recovery:2')).toBe(true);
    expect(fx.c.ability).toBeNull();
    expect(fx.c.untargetable).toBe(false);
    expect(fx.c.ccImmuneChannel).toBe(false);
  });
});

describe('mole Sinkhole Vortex — pull, grind, collapse', () => {
  it('pulls a grounded foe toward the centre at ~5 m/s and grinds ~30 dmg/s', () => {
    const fx = fixture();
    const c = openPit(fx);
    fx.t.state.pos = { x: c.x + 3.4, y: 0, z: c.z };
    const d0 = dist(fx.t, c.x, c.z);
    const hp0 = fx.t.state.hp;
    for (let i = 0; i < 30; i++) step(fx); // 0.5 s
    const d1 = dist(fx.t, c.x, c.z);
    expect(d0 - d1).toBeGreaterThan(2.2); // ~2.5 m in 0.5 s
    expect(d0 - d1).toBeLessThan(2.8);
    for (let i = 0; i < 12; i++) step(fx); // 0.7 s in total: two 7.5-point grinding ticks so far
    const lost = hp0 - fx.t.state.hp;
    expect(lost).toBeGreaterThanOrEqual(14);
    expect(lost).toBeLessThanOrEqual(16);
    // Unblockable, no flinch: the victim keeps its footing while being dragged.
    expect(fx.t.staggerTimer).toBe(0);
  });

  it('the whole cast deals ≈160 to a victim caught in the pit (60 grind + 100 collapse) and roots ~2 s', () => {
    const fx = fixture();
    cast(fx);
    runUntil(fx, () => fx.c.ability === null);
    const lost = fx.t.state.maxHp - fx.t.state.hp;
    expect(lost).toBeGreaterThanOrEqual(155);
    expect(lost).toBeLessThanOrEqual(175);
    const hits = ofType(fx.log, 'hit').filter((h) => h.ev.targetId === 1);
    expect(hits.length).toBeGreaterThanOrEqual(8); // 8 grinding ticks + the collapse
    expect(fx.t.rootTimer).toBeGreaterThan(1.2);
    expect(fx.t.rootTimer).toBeLessThanOrEqual(2.0);
  });

  it('collapse comes exactly vortexS after the pit opens; recovery is short and then it ends', () => {
    const fx = fixture();
    cast(fx);
    runUntil(fx, () => fx.c.ability === null);
    const st = ofType(fx.log, 'ultimateStage');
    const open = st.find((s) => s.ev.stage === 1)!;
    const col = st.find((s) => s.ev.stage === 2)!;
    expect(seconds(col.tick - open.tick)).toBeCloseTo(MOLE_VORTEX.vortexS, 1);
    expect(seconds(fx.tick - col.tick)).toBeCloseTo(MOLE_VORTEX.recoveryS, 1);
  });

  it('the mole deals +25% to the rooted victim afterwards (existing rule kept)', () => {
    const fx = fixture();
    cast(fx);
    runUntil(fx, () => fx.c.ability === null);
    expect(fx.t.rootTimer).toBeGreaterThan(0);
    const before = fx.t.state.hp;
    dealDamage(fx.world as never, fx.c, fx.t, 60, { blockable: true, heavy: false, reaction: 'none', isBasic: true });
    expect(before - fx.t.state.hp).toBeCloseTo(60 * 1.25, 4);
  });

  it('flyers above ground reach are not pulled, ground-ticked or rooted', () => {
    const fx = fixture();
    const c = openPit(fx);
    fx.t.state.pos = { x: c.x + 2.5, y: 4, z: c.z };
    for (let i = 0; i < 400 && fx.c.ability !== null; i++) {
      fx.t.state.pos.y = 4;
      step(fx);
    }
    expect(fx.t.state.pos.x).toBeCloseTo(c.x + 2.5, 1);
    expect(fx.t.state.hp).toBe(fx.t.state.maxHp);
    expect(fx.t.rootTimer).toBe(0);
  });

  it('a hop (above 0.6 m) is not pulled but a foe low in the pit still grinds', () => {
    const fx = fixture();
    const c = openPit(fx);
    fx.t.state.pos = { x: c.x + 3, y: 1.2, z: c.z };
    const x0 = fx.t.state.pos.x;
    for (let i = 0; i < 30; i++) {
      fx.t.state.pos.y = 1.2;
      step(fx);
    }
    expect(fx.t.state.pos.x).toBeGreaterThan(x0 - 0.3);
    expect(fx.t.state.hp).toBeLessThan(fx.t.state.maxHp);
  });

  it('a foe outside the rim is untouched', () => {
    const fx = fixture();
    const c = openPit(fx);
    fx.t.state.pos = { x: c.x + 7, y: 0, z: c.z };
    for (let i = 0; i < 400 && fx.c.ability !== null; i++) step(fx);
    expect(fx.t.state.hp).toBe(fx.t.state.maxHp);
    expect(fx.t.rootTimer).toBe(0);
    expect(fx.t.state.pos.x).toBeCloseTo(c.x + 7, 3);
  });

  it('DODGE BY LEAVING: a foe that walks out before the pit opens takes nothing', () => {
    const fx = fixture();
    cast(fx);
    fx.intents.set(1, { ...neutral(), moveX: 1 });
    runUntil(fx, () => fx.c.ability === null);
    expect(fx.t.state.hp).toBe(fx.t.state.maxHp);
    expect(fx.t.rootTimer).toBe(0);
  });

  it('pulled foes stop inside the arena and are not dragged through pillars or the wall', () => {
    const fx = fixture(['mole', 'hippo'], 9.5);
    const c = openPit(fx);
    fx.t.state.pos = { x: c.x, y: 0, z: c.z };
    for (let i = 0; i < 400 && fx.c.ability !== null; i++) step(fx);
    expect(Math.hypot(fx.t.state.pos.x, fx.t.state.pos.z)).toBeLessThan(40);
    expect(Number.isFinite(fx.t.state.pos.x)).toBe(true);
  });

  it('several victims are all pulled and hit; the mole is never hurt by its own pit', () => {
    const fx = fixture(['mole', 'hippo', 'gorilla']);
    const c = openPit(fx);
    const g = fx.world.fighters[2];
    fx.t.state.pos = { x: c.x + 2, y: 0, z: c.z };
    g.state.pos = { x: c.x - 2, y: 0, z: c.z + 2 };
    const hpMole = fx.c.state.hp;
    runUntil(fx, () => fx.c.ability === null);
    expect(fx.t.state.hp).toBeLessThan(fx.t.state.maxHp - 100);
    expect(g.state.hp).toBeLessThan(g.state.maxHp - 100);
    expect(fx.t.rootTimer).toBeGreaterThan(0);
    expect(g.rootTimer).toBeGreaterThan(0);
    expect(fx.c.state.hp).toBe(hpMole);
  });
});

describe('mole Sinkhole Vortex — cleanup', () => {
  it('the mole dying mid-vortex ends the pit and leaves no flags', () => {
    const fx = fixture();
    const c = openPit(fx);
    fx.t.state.pos = { x: c.x + 3, y: 0, z: c.z };
    for (let i = 0; i < 20; i++) step(fx);
    fx.c.state.hp = 0;
    step(fx);
    expect(fx.c.state.alive).toBe(false);
    expect(fx.c.ability).toBeNull();
    expect(fx.c.untargetable).toBe(false);
    expect(fx.c.ccImmuneChannel).toBe(false);
    const x1 = fx.t.state.pos.x;
    const hp1 = fx.t.state.hp;
    for (let i = 0; i < 60; i++) step(fx);
    expect(fx.t.state.pos.x).toBeCloseTo(x1, 2); // no more pulling
    expect(fx.t.state.hp).toBe(hp1); // no more grinding
    expect(fx.t.rootTimer).toBe(0); // and no collapse
  });

  it('the mole dying underground leaves no flags either', () => {
    const fx = fixture();
    cast(fx);
    for (let i = 0; i < 40; i++) step(fx);
    expect(fx.c.untargetable).toBe(true);
    fx.c.state.hp = 0;
    step(fx);
    expect(fx.c.ability).toBeNull();
    expect(fx.c.untargetable).toBe(false);
    expect(fx.c.ccImmuneChannel).toBe(false);
  });

  it('an interrupt in the recovery ends cleanly', () => {
    const fx = fixture();
    cast(fx);
    runUntil(fx, () => stageSeen(fx, 2));
    step(fx);
    fx.c.interrupt();
    expect(fx.c.ability).toBeNull();
    expect(fx.c.untargetable).toBe(false);
    expect(fx.c.ccImmuneChannel).toBe(false);
  });
});

describe('mole Sinkhole Vortex — bot danger zone (fixed)', () => {
  it('ultimateTarget makes a live circle at the pit centre right away; it outlives the collapse', () => {
    const fx = fixture();
    const zones = new DangerZones();
    cast(fx);
    let fed = 0;
    let liveAtCast = false;
    let liveAtCollapse = false;
    let collapseChecked = false;
    for (let i = 0; i < 500 && fx.c.ability !== null; i++) {
      step(fx);
      for (; fed < fx.log.length; fed++) zones.ingest(fx.log[fed].ev, fx.tick * DT, 0, 1, () => 'mole');
      const z = zones.find(0);
      if (fx.tick === 2) {
        expect(z).toBeDefined();
        liveAtCast = z !== undefined && zones.isLive(z, fx.tick * DT);
        expect(z!.r).toBeCloseTo(4.5, 6);
        expect(z!.az).toBeCloseTo(9.5, 6);
      }
      const rt = fx.c.ability;
      if (rt !== null && rt.stage === 2 && !collapseChecked) {
        collapseChecked = true; // the collapse tick itself
        liveAtCollapse = z !== undefined && zones.isLive(z, fx.tick * DT);
      }
    }
    expect(liveAtCast).toBe(true);
    expect(liveAtCollapse).toBe(true);
  });
});

describe('mole Sinkhole Vortex — determinism', () => {
  it('two identical runs match exactly', () => {
    const run = (): string => {
      const fx = fixture(['mole', 'hippo', 'gorilla']);
      cast(fx);
      fx.intents.set(1, { ...neutral(), moveX: 0.3, moveZ: -0.4 });
      runUntil(fx, () => fx.c.ability === null);
      const trace: string[] = [];
      for (const l of fx.log) if (l.ev.type === 'ultimateStage' || l.ev.type === 'hit') trace.push(JSON.stringify([l.tick, l.ev]));
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

describe('mole Sinkhole Vortex — audio module', () => {
  const tgt = { type: 'ultimateTarget', fighterId: 0, animal: 'mole', kind: 'ground', targetId: 1, from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 9.5 }, range: 10, width: 9, windup: 1.3 } as GameEventOf<'ultimateTarget'>;
  const stage = (n: number): GameEventOf<'ultimateStage'> => ({ type: 'ultimateStage', fighterId: 0, animal: 'mole', stage: n, targetId: -1, pos: { x: 0, y: 0, z: 9.5 } });
  it('dig + rumble + crack on cast, suction bed on the pit, collapse boom; aborted casts fade the beds; never throws', () => {
    const fx = fakeAudioApi();
    moleAudio.onTarget!(fx.api, tgt);
    const afterCast = fx.voices();
    expect(afterCast).toBeGreaterThanOrEqual(8);
    moleAudio.onStage!(fx.api, stage(1));
    const afterOpen = fx.voices();
    expect(afterOpen).toBeGreaterThan(afterCast + 3);
    moleAudio.onStage!(fx.api, stage(2));
    expect(fx.voices()).toBeGreaterThan(afterOpen + 4);
    moleAudio.onEnd!(fx.api, 0);
    // A second cast aborted mid-vortex: onEnd must fade without throwing.
    moleAudio.onStage!(fx.api, stage(1));
    moleAudio.onEnd!(fx.api, 0);
    moleAudio.dispose!();
  });
  it('is inaudible (no voices) when far from the listener', () => {
    const fx = fakeAudioApi();
    (fx.api as unknown as { gainAt: () => number }).gainAt = () => 0;
    moleAudio.onTarget!(fx.api, tgt);
    moleAudio.onStage!(fx.api, stage(1));
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

describe('mole Sinkhole Vortex — real bots sidestep the marked ground', () => {
  it('Apex (strict) bots leave the pit before it opens: at most one of eight seeds is caught; Cubs (never dodge) are caught more often', () => {
    let apex = 0;
    let cub = 0;
    for (let seed = 1; seed <= 8; seed++) {
      if (botVictimLoss('mole', 4, seed, 5, -6) > 100) apex++;
      if (botVictimLoss('mole', 1, seed, 5, -6) > 100) cub++;
    }
    expect(apex).toBeLessThanOrEqual(1);
    expect(cub).toBeGreaterThan(apex);
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

describe('mole Sinkhole Vortex — bot script', () => {
  it('Apex casts at kiters, blockers, helpless / rooted / mid-cast foes and clusters within ~12 m', () => {
    expect(wantsUlt(sit('mole', 4, { tdist: 6, targetFleeing: true }))).toBe(true);
    expect(wantsUlt(sit('mole', 4, { tdist: 6, targetBlocking: true }))).toBe(true);
    expect(wantsUlt(sit('mole', 4, { tdist: 6, targetHelpless: true }))).toBe(true);
    expect(wantsUlt(sit('mole', 4, { tdist: 6, targetRooted: true }))).toBe(true);
    expect(wantsUlt(sit('mole', 4, { tdist: 6, targetCommitted: true }))).toBe(true);
    expect(wantsUlt(sit('mole', 4, { tdist: 6, enemiesNearTarget8: 2 }))).toBe(true);
    expect(wantsUlt(sit('mole', 4, { tdist: 6 }))).toBe(false);
    expect(wantsUlt(sit('mole', 4, { tdist: 14, targetFleeing: true }))).toBe(false);
    expect(wantsUlt(sit('mole', 4, { tdist: 1.5, targetFleeing: true }))).toBe(false);
  });
  it('Veteran fires it on a fleeing target', () => {
    expect(wantsUlt(sit('mole', 3, { tdist: 6, targetFleeing: true }))).toBe(true);
  });
});
