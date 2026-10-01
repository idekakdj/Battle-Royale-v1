/**
 * Rhino — Seismic Stampede (v1.3): a steerable, CC-immune charge that HOMES on the foe locked at the cast (16 m,
 * 50 degree cone, turn <= 110 deg/s), gores it (120), hoists it on the horn and carries it until a wall / pillar
 * crushes it (+100, stun 1.2 s); everyone else in the path is swept (60 + knockdown); crates are smashed.
 */

import { describe, it, expect } from 'vitest';
import { liveWorld, neutral, disablePickups, DT } from '../helpers';
import { ANIMALS } from '../../../src/config/animals';
import { RHINO_STAMPEDE as K } from '../../../src/config/ultimates/rhino';
import { PILLARS, CRATES, WALL_RADIUS } from '../../../src/config/arena';
import type { AnimalId, Difficulty, FighterIntent, GameEvent, GameEventOf } from '../../../src/core/types';
import type { World } from '../../../src/sim/World';
import type { Fighter } from '../../../src/sim/Fighter';
import { dealDamage } from '../../../src/sim/CombatSystem';
import { stampedeState } from '../../../src/sim/ultimates/rhino';
import { previewUltTarget } from '../../../src/sim/ultimates/targeting';
import { synth, type UltAudioApi } from '../../../src/audio/ults';
import rhinoAudio from '../../../src/audio/ults/rhino';
import { decideAbilities, type Situation, type AbilityWish } from '../../../src/ai/scripts';
import { BOT_PROFILES } from '../../../src/config/botProfiles';
import { DEG2RAD, angleDelta, mulberry32 } from '../../../src/core/math';

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

/** Rhino at (cx, cz) facing +z; a lion victim at (tx, tz); everybody else parked far away. */
function fixture(roster: AnimalId[] = ['rhino', 'lion'], tx = 0, tz = 8, cx = 0, cz = 0): Fx {
  const events: GameEvent[] = [];
  const { world } = liveWorld(roster, 7, events);
  disablePickups(world);
  const fs = world.fighters;
  const c = fs[0];
  const t = fs[1];
  c.state.pos = { x: cx, y: 0, z: cz };
  c.state.yaw = 0;
  c.state.vel = { x: 0, y: 0, z: 0 };
  t.state.pos = { x: tx, y: 0, z: tz };
  t.state.yaw = Math.PI;
  t.state.vel = { x: 0, y: 0, z: 0 };
  for (let i = 2; i < fs.length; i++) fs[i].state.pos = { x: -25 + i, y: 0, z: 22 };
  return { world, events, log: [], tick: 0, c, t, intents: new Map() };
}

/** Remove pillars / fallen columns / crates so a pursuit test is not bent by geometry (the wall stays). */
function clearArena(fx: Fx): Fx {
  (fx.world as unknown as { staticObstacles: unknown[] }).staticObstacles = [];
  for (const c of fx.world.crates) c.alive = false;
  return fx;
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
const hitsOn = (fx: Fx, id: number): { tick: number; ev: GameEventOf<'hit'> }[] => ofType(fx.log, 'hit').filter((h) => h.ev.targetId === id);
const lostHp = (f: Fighter): number => f.state.maxHp - f.state.hp;

describe('rhino Seismic Stampede — config', () => {
  const spec = ANIMALS.rhino.ultimate;
  it('is a lock-assisted line (16 m, 50 degrees) with the gore / crush / sweep numbers and no dodge zone', () => {
    expect(spec.name).toBe('Seismic Stampede');
    expect(spec.description).toMatch(/homing/i);
    expect(spec.targeting?.kind).toBe('line');
    expect(spec.targeting?.range).toBe(16);
    expect(spec.targeting?.coneDeg).toBe(50);
    expect(spec.targeting?.requireTarget).toBeUndefined(); // never fizzles: with no lock it is a free charge
    expect(spec.targeting?.dodge).toBeUndefined();
    expect(spec.turnRateDeg).toBe(110);
    expect(spec.duration).toBe(3);
    expect(spec.damage).toBe(120);
    expect(spec.bonusDamage).toBe(100);
    expect(spec.bonusEffects?.[0]).toMatchObject({ kind: 'stun', dur: 1.2 });
    expect(spec.splashDamage).toBe(60);
    expect(spec.effects?.[0]).toMatchObject({ kind: 'knockdown' });
    expect(spec.ccImmune).toBe(true);
    expect(spec.breaksCrates).toBe(true);
    expect(K.speed).toBe(12);
  });
});

describe('rhino Seismic Stampede — cast and lock', () => {
  it('emits the line ultimateTarget locked on the foe in the cone; the snapshot names it as ultTargetId', () => {
    const fx = fixture(['rhino', 'lion'], 0, 8);
    cast(fx);
    const tg = ofType(fx.log, 'ultimateTarget');
    expect(tg).toHaveLength(1);
    expect(tg[0].ev.kind).toBe('line');
    expect(tg[0].ev.targetId).toBe(1);
    expect(tg[0].ev.width).toBe(2.4);
    expect(tg[0].ev.windup).toBeCloseTo(0.8, 9);
    const types = fx.log.map((l) => l.ev.type);
    expect(types.indexOf('ultimateTarget')).toBeGreaterThan(types.indexOf('ultimate'));
    const st = fx.world.snapshot().fighters[0];
    expect(st.ultPhase).toBe('windup');
    expect(st.ultTargetId).toBe(1);
    expect(fx.c.state.ultCharge).toBe(0);
  });

  it('locks inside the 50 degree cone (within 16 m) and not outside it; never fizzles', () => {
    const inCone = fixture(['rhino', 'lion'], 4.5, 11); // ~22 degrees off
    cast(inCone);
    expect(ofType(inCone.log, 'ultimateTarget')[0].ev.targetId).toBe(1);
    const outCone = fixture(['rhino', 'lion'], 9, 6); // ~56 degrees off
    cast(outCone);
    expect(ofType(outCone.log, 'ultimateTarget')[0].ev.targetId).toBe(-1);
    expect(outCone.c.ability).not.toBeNull(); // the cast still starts
    const tooFar = fixture(['rhino', 'lion'], 0, 20);
    cast(tooFar);
    expect(ofType(tooFar.log, 'ultimateTarget')[0].ev.targetId).toBe(-1);
    const behind = fixture(['rhino', 'lion'], 0, -6);
    cast(behind);
    expect(ofType(behind.log, 'ultimateTarget')[0].ev.targetId).toBe(-1);
    // The HUD preview uses the same pure targeting.
    const p = previewUltTarget(ANIMALS.rhino.ultimate, fx0().c.state, [fx0().c.state, fx0().t.state], { aimYaw: 0 });
    expect(p.valid).toBe(true);
    expect(p.targetId).toBe(1);
  });

  it('paws through the windup: nothing moves, nothing is hit; the rhino sights the lock by turning (<= 150 deg/s)', () => {
    const fx = fixture(['rhino', 'lion'], 5, 10); // 26.6 degrees to the right, but inside the cone by body overlap
    cast(fx);
    let maxTurn = 0;
    let prev = fx.c.state.yaw;
    for (let i = 0; i < 40; i++) {
      step(fx);
      maxTurn = Math.max(maxTurn, Math.abs(angleDelta(prev, fx.c.state.yaw)));
      prev = fx.c.state.yaw;
    }
    expect(maxTurn).toBeLessThanOrEqual(K.sightTurnDeg * DEG2RAD * DT + 1e-9);
    expect(fx.c.state.pos.x).toBeCloseTo(0, 6);
    expect(fx.c.state.pos.z).toBeCloseTo(0, 6);
    expect(fx.t.state.hp).toBe(fx.t.state.maxHp);
    expect(fx.c.state.yaw).toBeGreaterThan(0.3); // turned toward the lock (aim is 0)
  });

  it('a stagger during the windup interrupts the cast (only the charge itself is CC-immune)', () => {
    const fx = fixture(['rhino', 'lion'], 0, 8);
    cast(fx);
    for (let i = 0; i < 20; i++) step(fx);
    dealDamage(fx.world, fx.t, fx.c, 30, { blockable: false, heavy: true, reaction: 'stagger', isBasic: false });
    step(fx);
    expect(fx.c.ability).toBeNull();
    for (let i = 0; i < 120; i++) step(fx);
    expect(fx.t.state.hp).toBe(fx.t.state.maxHp);
    expect(stageSeen(fx, 1)).toBe(false);
  });
});

/** The lion victim helper for the geometry-free scenarios above. */
function fx0(): Fx {
  return fixture(['rhino', 'lion'], 0, 8);
}

describe('rhino Seismic Stampede — the homing charge', () => {
  it('homes on the lock: a foe off the aim line (aim held straight ahead) is still gored', () => {
    const fx = clearArena(fixture(['rhino', 'lion'], 4.5, 11));
    cast(fx);
    runUntil(fx, () => stageSeen(fx, 2));
    expect(stageSeen(fx, 2)).toBe(true);
    expect(hitsOn(fx, 1)[0].ev.damage).toBe(120);
  });

  it('homes on a foe walking away sideways (12 m/s closes on a 5 m/s runner)', () => {
    const fx = clearArena(fixture(['rhino', 'lion'], 0, 10));
    fx.intents.set(1, { ...neutral(), moveX: 1 }); // runs +x at ~6.5 m/s
    cast(fx);
    runUntil(fx, () => stageSeen(fx, 2), 600);
    expect(stageSeen(fx, 2)).toBe(true);
  });

  it('never turns faster than 110 deg/s while homing, and homes on the victim\'s CURRENT position', () => {
    const fx = clearArena(fixture(['rhino', 'lion'], 0, 12));
    fx.intents.set(1, { ...neutral(), moveX: -1 });
    cast(fx);
    runUntil(fx, () => fx.c.ability !== null && fx.c.ability.phase === 1);
    let maxTurn = 0;
    let prev = fx.c.state.yaw;
    let homingSeen = false;
    for (let i = 0; i < 100 && !stageSeen(fx, 2) && fx.c.ability !== null && fx.c.ability.phase === 1; i++) {
      step(fx);
      maxTurn = Math.max(maxTurn, Math.abs(angleDelta(prev, fx.c.state.yaw)));
      prev = fx.c.state.yaw;
      if (stampedeState(fx.c.ability)?.homing === true) homingSeen = true;
    }
    expect(homingSeen).toBe(true);
    expect(maxTurn).toBeLessThanOrEqual(K.homingTurnDeg * DEG2RAD * DT + 1e-9);
    expect(maxTurn).toBeGreaterThan(0);
  });

  it('drops the lock when the victim leaves the ground (flyer / high jump): the rhino keeps its heading', () => {
    const fx = clearArena(fixture(['rhino', 'lion'], 0, 12));
    cast(fx);
    runUntil(fx, () => fx.c.ability !== null && fx.c.ability.phase === 1);
    fx.t.state.pos.y = 4; // airborne (an eagle in flight would be the same)
    let yaw0 = fx.c.state.yaw;
    for (let i = 0; i < 20; i++) {
      fx.t.state.pos = { x: 6, y: 4, z: 12 };
      step(fx);
    }
    expect(stampedeState(fx.c.ability)?.homing).toBe(false);
    expect(Math.abs(angleDelta(yaw0, fx.c.state.yaw))).toBeLessThan(0.5); // no chasing (intent aim is 0: stays near)
    yaw0 = 0;
  });

  it('without a lock it is steered by the aim at <= 90 deg/s, as before', () => {
    const fx = clearArena(fixture(['rhino', 'lion'], 0, -10)); // behind: no lock
    cast(fx);
    runUntil(fx, () => fx.c.ability !== null && fx.c.ability.phase === 1);
    const start = fx.c.state.yaw;
    let maxTurn = 0;
    let prev = start;
    for (let i = 0; i < 30; i++) {
      step(fx, { aimYaw: Math.PI / 2 });
      maxTurn = Math.max(maxTurn, Math.abs(angleDelta(prev, fx.c.state.yaw)));
      prev = fx.c.state.yaw;
    }
    expect(stampedeState(fx.c.ability)?.homing).toBe(false);
    expect(Math.abs(angleDelta(start, fx.c.state.yaw))).toBeLessThanOrEqual(0.5 * 90 * DEG2RAD + 1e-6);
    expect(Math.abs(angleDelta(start, fx.c.state.yaw))).toBeGreaterThan(0.6); // it does turn
    expect(maxTurn).toBeLessThanOrEqual(K.freeTurnDeg * DEG2RAD * DT + 1e-9);
  });

  it('gallops up to 12 m/s over the 0.5 s ramp and covers ~33 m in 3 s', () => {
    const fx = clearArena(fixture(['rhino', 'lion'], 0, -10, 0, -29)); // nothing in front
    fx.t.state.pos = { x: 20, y: 0, z: 20 };
    cast(fx);
    runUntil(fx, () => fx.c.ability !== null && fx.c.ability.phase === 1);
    const s0 = fx.c.state.pos.z;
    let vmax = 0;
    let first = 0;
    for (let i = 0; i < 40; i++) {
      step(fx);
      const v = Math.hypot(fx.c.state.vel.x, fx.c.state.vel.z);
      if (i === 0) first = v;
      vmax = Math.max(vmax, v);
    }
    expect(first).toBeLessThan(5); // heavy first stride
    expect(vmax).toBeCloseTo(12, 6);
    runUntil(fx, () => stageSeen(fx, 4));
    const travelled = fx.c.state.pos.z - s0;
    expect(travelled).toBeGreaterThan(28);
    expect(travelled).toBeLessThan(37);
  });
});

describe('rhino Seismic Stampede — gore, carry and crush', () => {
  it('gores the lock on contact: exactly 120 (blockable), hoisted on the horn and carried ahead of the rhino', () => {
    const fx = fixture(['rhino', 'lion'], 0, 8);
    cast(fx);
    runUntil(fx, () => stageSeen(fx, 2));
    const gore = ofType(fx.log, 'ultimateStage').find((s) => s.ev.stage === 2)!;
    expect(gore.ev.targetId).toBe(1);
    expect(hitsOn(fx, 1)).toHaveLength(1);
    expect(hitsOn(fx, 1)[0].ev.damage).toBe(120);
    expect(fx.t.state.grabbedById).toBe(0);
    expect(fx.c.state.grabTargetId).toBe(1);
    expect(stampedeState(fx.c.ability)?.victimId).toBe(1);
    for (let i = 0; i < 25; i++) step(fx);
    // Hoisted to ~1.7 m and riding on the horn: ahead of the rhino along its heading, at the carry gap.
    expect(fx.t.state.pos.y).toBeGreaterThan(1.55);
    expect(fx.t.state.pos.y).toBeLessThan(1.8);
    const dx = fx.t.state.pos.x - fx.c.state.pos.x;
    const dz = fx.t.state.pos.z - fx.c.state.pos.z;
    expect(Math.hypot(dx, dz)).toBeCloseTo(ANIMALS.rhino.radius + K.carryGap, 1);
    expect(dx * Math.sin(fx.c.state.yaw) + dz * Math.cos(fx.c.state.yaw)).toBeGreaterThan(1.4);
    expect(fx.t.state.action).toBe('grabbed');
  });

  it('a raised guard cuts the gore damage (it is blockable) but cannot stop the carry', () => {
    const fx = fixture(['rhino', 'lion'], 0, 8);
    fx.intents.set(1, { ...neutral(), block: true, aimYaw: Math.PI });
    cast(fx);
    runUntil(fx, () => stageSeen(fx, 2));
    expect(lostHp(fx.t)).toBeLessThan(120 * (1 - ANIMALS.lion.blockReduction) + 1);
    expect(lostHp(fx.t)).toBeGreaterThan(0);
    expect(fx.t.state.grabbedById).toBe(0);
  });

  it('crushes the carried foe against the wall: +100 (true damage) and a 1.2 s stun; the charge ends; the victim drops', () => {
    const fx = fixture(['rhino', 'lion'], 0, 8);
    cast(fx);
    runUntil(fx, () => stageSeen(fx, 3), 600);
    expect(stageSeen(fx, 3)).toBe(true);
    const crush = ofType(fx.log, 'ultimateStage').find((s) => s.ev.stage === 3)!;
    expect(crush.ev.targetId).toBe(1);
    expect(Math.hypot(crush.ev.pos.x, crush.ev.pos.z)).toBeGreaterThan(WALL_RADIUS - 3.5); // at the rim
    expect(hitsOn(fx, 1).map((h) => h.ev.damage)).toEqual([120, 100]);
    expect(lostHp(fx.t)).toBeCloseTo(220, 6);
    expect(fx.t.staggerTimer).toBeGreaterThan(1.1);
    expect(fx.t.staggerTimer).toBeLessThanOrEqual(1.2 + 1e-9);
    expect(fx.t.state.grabbedById).toBe(-1);
    expect(fx.c.state.grabTargetId).toBe(-1);
    expect(fx.c.ability?.phase).toBe(2); // recovery (shake-off)
    expect(fx.c.state.vel.x).toBe(0);
    expect(fx.c.state.vel.z).toBe(0);
    // The victim falls from the horn under gravity.
    for (let i = 0; i < 60; i++) step(fx);
    expect(fx.t.state.pos.y).toBeCloseTo(0, 6);
    runUntil(fx, () => fx.c.ability === null);
    expect(fx.c.ability).toBeNull();
    expect(fx.c.ccImmuneChannel).toBe(false);
    expect(fx.c.state.grabTargetId).toBe(-1);
    expect(lostHp(fx.t)).toBeCloseTo(220, 6); // nothing more after the crush
  });

  it('a pillar crushes too (reusing the Lockdown slam rule)', () => {
    const p = PILLARS[0];
    const d = Math.hypot(p.x, p.z);
    const ux = p.x / d;
    const uz = p.z / d;
    // Rhino and victim on the ray from the centre to the pillar, victim 8 m ahead, the pillar beyond.
    const gap = p.radius + 1.8;
    const vx = p.x - ux * (gap + 5);
    const vz = p.z - uz * (gap + 5);
    const fx = fixture(['rhino', 'lion'], vx, vz, vx - ux * 8, vz - uz * 8);
    fx.c.state.yaw = Math.atan2(ux, uz);
    fx.t.state.yaw = fx.c.state.yaw + Math.PI;
    const aim = fx.c.state.yaw;
    cast(fx);
    // Aim at the victim throughout.
    for (let i = 0; i < 400 && !stageSeen(fx, 3) && fx.c.ability !== null; i++) step(fx, { aimYaw: aim });
    expect(stageSeen(fx, 3)).toBe(true);
    const crush = ofType(fx.log, 'ultimateStage').find((s) => s.ev.stage === 3)!;
    // Slammed at the pillar, far from the wall.
    expect(Math.hypot(crush.ev.pos.x - p.x, crush.ev.pos.z - p.z)).toBeLessThan(p.radius + 2.6);
    expect(lostHp(fx.t)).toBeCloseTo(220, 6);
  });

  it('a charge that runs out of time flings the carried foe (knockdown, no crush) and skids to a halt', () => {
    // From the far wall across the arena: 3 s of charge ends before the opposite rim.
    const fx = fixture(['rhino', 'lion'], 0, -20, 0, -28.5);
    cast(fx);
    runUntil(fx, () => stageSeen(fx, 4), 700);
    expect(stageSeen(fx, 4)).toBe(true);
    expect(stageSeen(fx, 3)).toBe(false);
    expect(hitsOn(fx, 1)).toHaveLength(1); // the gore only
    expect(fx.t.state.grabbedById).toBe(-1);
    expect(fx.t.knockdownTimer).toBeGreaterThan(0);
    const v0 = Math.hypot(fx.c.state.vel.x, fx.c.state.vel.z);
    expect(v0).toBeGreaterThan(0); // still sliding at the start of the skid
    expect(fx.c.ccImmuneChannel).toBe(true);
    runUntil(fx, () => fx.c.ability !== null && fx.c.ability.phase === 2);
    expect(fx.c.state.vel.x).toBe(0);
    expect(fx.c.state.vel.z).toBe(0);
    expect(fx.c.ccImmuneChannel).toBe(false);
    runUntil(fx, () => fx.c.ability === null);
    expect(fx.c.ability).toBeNull();
    expect(lostHp(fx.t)).toBeLessThan(120 + 10);
  });

  it('with no lock the first fighter touched is gored instead (and with a lock elsewhere, the others are swept)', () => {
    const fx = fixture(['rhino', 'lion'], 0, 19); // beyond the 16 m lock range, dead ahead
    cast(fx);
    expect(ofType(fx.log, 'ultimateTarget')[0].ev.targetId).toBe(-1);
    runUntil(fx, () => stageSeen(fx, 2));
    expect(stageSeen(fx, 2)).toBe(true);
    expect(hitsOn(fx, 1)[0].ev.damage).toBe(120);
  });

  it('a foe that cannot be carried (CC-immune) is gored for the damage but not hoisted', () => {
    const fx = fixture(['rhino', 'lion'], 0, 8);
    cast(fx);
    let carried = false;
    for (let i = 0; i < 200 && !stageSeen(fx, 2) && !hitsOn(fx, 1).length; i++) {
      fx.t.ccImmuneChannel = true;
      fx.t.ccImmune = true;
      step(fx);
      if (fx.t.state.grabbedById === 0) carried = true;
    }
    for (let i = 0; i < 30; i++) {
      fx.t.ccImmuneChannel = true;
      step(fx);
      if (fx.t.state.grabbedById === 0) carried = true;
    }
    expect(hitsOn(fx, 1)[0].ev.damage).toBe(120);
    expect(carried).toBe(false);
    expect(fx.t.state.pos.y).toBeLessThan(0.5);
  });
});

describe('rhino Seismic Stampede — sweeps, crates, immunity', () => {
  it('sweeps a bystander in the path for 60 + knockdown once, while still going for the lock', () => {
    const fx = fixture(['rhino', 'lion', 'gorilla'], 0, 13); // lock: dead ahead (the smallest angle wins the lock)
    const g = fx.world.fighters[2];
    g.state.pos = { x: 1.0, y: 0, z: 5 }; // in the way, but 11 degrees off: not the lock
    g.state.yaw = Math.PI;
    cast(fx);
    runUntil(fx, () => stageSeen(fx, 2), 600);
    const gh = hitsOn(fx, 2);
    expect(gh).toHaveLength(1);
    expect(gh[0].ev.damage).toBe(60);
    expect(g.knockdownTimer).toBeGreaterThan(0);
    expect(hitsOn(fx, 1)[0].ev.damage).toBe(120);
    runUntil(fx, () => fx.c.ability === null);
    expect(hitsOn(fx, 2)).toHaveLength(1); // once
  });

  it('breaks crates in its path', () => {
    const c0 = CRATES[0];
    const fx = fixture(['rhino', 'lion'], 20, 20, c0.x - 6, c0.z);
    fx.c.state.yaw = Math.PI / 2;
    fx.t.state.pos = { x: -25, y: 0, z: -20 };
    cast(fx);
    for (let i = 0; i < 200; i++) step(fx, { aimYaw: Math.PI / 2 });
    expect(fx.world.crates[0].alive).toBe(false);
  });

  it('the charge is CC-immune: stagger / knockdown / fear do not interrupt it and knockback does not move the rhino', () => {
    const fx = fixture(['rhino', 'lion'], 0, -10); // no lock
    cast(fx);
    runUntil(fx, () => fx.c.ability !== null && fx.c.ability.phase === 1);
    step(fx);
    dealDamage(fx.world, fx.t, fx.c, 40, { blockable: false, heavy: true, reaction: 'stagger', isBasic: false });
    fx.c.interrupt();
    fx.world.fighters[0].fearTimer = 0;
    expect(fx.c.ability).not.toBeNull();
    expect(fx.c.ccImmune).toBe(true);
    expect(fx.c.staggerTimer).toBe(0);
  });
});

describe('rhino Seismic Stampede — cleanup and determinism', () => {
  it('the rhino dying with a victim on the horn lets the victim go', () => {
    const fx = fixture(['rhino', 'lion', 'gorilla'], 0, 8); // a third fighter keeps the match running
    cast(fx);
    runUntil(fx, () => stageSeen(fx, 2));
    for (let i = 0; i < 12; i++) step(fx);
    expect(fx.t.state.grabbedById).toBe(0);
    fx.c.state.hp = 0;
    step(fx);
    expect(fx.c.state.alive).toBe(false);
    expect(fx.c.ability).toBeNull();
    expect(fx.c.ccImmuneChannel).toBe(false);
    expect(fx.t.state.grabbedById).toBe(-1);
    for (let i = 0; i < 60; i++) step(fx);
    expect(fx.t.state.pos.y).toBeCloseTo(0, 6); // fell to the ground
  });

  it('the victim dying on the horn ends the carry cleanly and the charge continues', () => {
    const fx = fixture(['rhino', 'lion', 'gorilla'], 0, 8);
    cast(fx);
    runUntil(fx, () => stageSeen(fx, 2));
    fx.t.state.hp = 0;
    for (let i = 0; i < 10; i++) step(fx);
    expect(fx.t.state.alive).toBe(false);
    expect(fx.c.state.grabTargetId).toBe(-1);
    runUntil(fx, () => fx.c.ability === null);
    expect(fx.c.ability).toBeNull();
  });

  it('two identical runs match exactly (events, positions, hp)', () => {
    const run = (): string => {
      const fx = fixture(['rhino', 'lion', 'gorilla'], 2, 11);
      fx.world.fighters[2].state.pos = { x: 0, y: 0, z: 5 };
      fx.intents.set(1, { ...neutral(), moveX: 0.6, moveZ: -0.3 });
      cast(fx);
      runUntil(fx, () => fx.c.ability === null);
      const trace: string[] = [];
      for (const l of fx.log) if (l.ev.type === 'ultimateStage' || l.ev.type === 'hit') trace.push(JSON.stringify([l.tick, l.ev]));
      trace.push(JSON.stringify([fx.c.state.pos, fx.t.state.pos, fx.t.state.hp, fx.world.fighters[2].state.hp, fx.tick]));
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

describe('rhino Seismic Stampede — audio module', () => {
  const tgt = { type: 'ultimateTarget', fighterId: 0, animal: 'rhino', kind: 'line', targetId: 1, from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 8 }, range: 16, width: 2.4, windup: 0.8 } as GameEventOf<'ultimateTarget'>;
  const stage = (n: number): GameEventOf<'ultimateStage'> => ({ type: 'ultimateStage', fighterId: 0, animal: 'rhino', stage: n, targetId: 1, pos: { x: 0, y: 0, z: 8 } });
  it('snort + paw on cast, gallop bed on the charge, gore / crush / skid hits; beds are cut by the crush and skid; never throws', () => {
    const fx = fakeAudioApi();
    rhinoAudio.onTarget!(fx.api, tgt);
    const afterCast = fx.voices();
    expect(afterCast).toBeGreaterThanOrEqual(8);
    rhinoAudio.onStage!(fx.api, stage(1));
    const afterCharge = fx.voices();
    expect(afterCharge).toBeGreaterThanOrEqual(afterCast + 3);
    rhinoAudio.onStage!(fx.api, stage(2));
    const afterGore = fx.voices();
    expect(afterGore).toBeGreaterThan(afterCharge + 2);
    rhinoAudio.onStage!(fx.api, stage(3));
    expect(fx.voices()).toBeGreaterThan(afterGore + 5);
    rhinoAudio.onEnd!(fx.api, 0);
    rhinoAudio.onStage!(fx.api, stage(1));
    rhinoAudio.onStage!(fx.api, stage(4));
    rhinoAudio.onStage!(fx.api, stage(1));
    rhinoAudio.onEnd!(fx.api, 0); // aborted mid-gallop
    rhinoAudio.dispose!();
  });
  it('is inaudible (no voices) when far from the listener', () => {
    const fx = fakeAudioApi();
    (fx.api as unknown as { gainAt: () => number }).gainAt = () => 0;
    rhinoAudio.onTarget!(fx.api, tgt);
    rhinoAudio.onStage!(fx.api, stage(1));
    expect(fx.voices()).toBe(0);
  });
});

// ── bot script (decideAbilities → ULT_SCRIPTS) ──
function sit(lvl: Difficulty, over: Partial<Situation>): Situation {
  return {
    animal: 'rhino', profile: BOT_PROFILES[lvl], rng: mulberry32(1), now: 10, hpFrac: 1, guardFrac: 1, specialReady: false, ultReady: true,
    ultHeldS: 10, retreating: false, hasTarget: true, tdist: 9, tHpFrac: 1, tGuardFrac: 1, targetHelpless: false, targetRooted: false,
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

describe('rhino Seismic Stampede — bot script', () => {
  it('Apex locks targets with geometry behind them and helpless / rooted / committed ones inside the lock range', () => {
    const fresh = { ultHeldS: 0 }; // just charged: the Apex patience fallback has not kicked in
    expect(wantsUlt(sit(4, { ...fresh, tdist: 9, wallBehindTarget: true }))).toBe(true);
    expect(wantsUlt(sit(4, { ...fresh, tdist: 9, targetHelpless: true }))).toBe(true);
    expect(wantsUlt(sit(4, { ...fresh, tdist: 9, targetRooted: true }))).toBe(true);
    expect(wantsUlt(sit(4, { ...fresh, tdist: 9, targetCommitted: true }))).toBe(true);
    expect(wantsUlt(sit(4, { ...fresh, tdist: 9, targetBlocking: true }))).toBe(true);
    expect(wantsUlt(sit(4, { ...fresh, tdist: 9 }))).toBe(false); // a free target with open ground behind it: wait
    expect(wantsUlt(sit(4, { ...fresh, tdist: 17, wallBehindTarget: true }))).toBe(false); // out of lock range
    expect(wantsUlt(sit(4, { ...fresh, tdist: 1.5, targetHelpless: true }))).toBe(false); // point blank: melee instead
  });
  it('Veteran casts at a cluster, Cub / Fighter whenever a foe is in the lock range', () => {
    expect(wantsUlt(sit(3, { tdist: 9, enemiesNearSelf8: 2 }))).toBe(true);
    expect(wantsUlt(sit(2, { tdist: 9 }))).toBe(true);
    expect(wantsUlt(sit(1, { tdist: 9 }))).toBe(true);
    expect(wantsUlt(sit(2, { tdist: 18 }))).toBe(false);
  });
});
