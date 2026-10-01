import { describe, it, expect } from 'vitest';
import { liveWorld, neutral, disablePickups, DT } from '../helpers';
import { ANIMALS } from '../../../src/config/animals';
import { PANTHER_EXEC as E, PANTHER_T_END, PANTHER_T_RECOVERY, PANTHER_ULTIMATE, pantherBlinkTime } from '../../../src/config/ultimates/panther';
import type { AnimalId, GameEvent, GameEventOf } from '../../../src/core/types';
import type { World } from '../../../src/sim/World';
import type { Fighter } from '../../../src/sim/Fighter';
import { dealDamage } from '../../../src/sim/CombatSystem';
import { applyEffect } from '../../../src/sim/StatusEffects';
import { previewUltTarget } from '../../../src/sim/ultimates/targeting';
import { angleDelta, dirToYaw } from '../../../src/core/math';

function ofType<T extends GameEvent['type']>(events: GameEvent[], type: T): GameEventOf<T>[] {
  return events.filter((e): e is GameEventOf<T> => e.type === type);
}

interface Fx {
  world: World;
  events: GameEvent[];
  c: Fighter; // the panther
  t: Fighter; // the victim
}

function fixture(victim: AnimalId = 'gorilla', dist = 6, seed = 7): Fx {
  const events: GameEvent[] = [];
  // A far-off bystander keeps the match alive when the panther or its victim dies.
  const { world } = liveWorld(['panther', victim, 'hippo'], seed, events);
  disablePickups(world);
  const c = world.fighters[0];
  const t = world.fighters[1];
  world.fighters[2].state.pos = { x: -20, y: 0, z: -20 };
  c.state.pos = { x: 0, y: 0, z: 0 };
  c.state.yaw = 0;
  t.state.pos = { x: 0, y: 0, z: dist };
  t.state.yaw = Math.PI;
  return { world, events, c, t };
}

function tick(fx: Fx, n = 1, hook?: () => void): void {
  for (let i = 0; i < n; i++) {
    const a = neutral();
    a.aimYaw = 0;
    fx.world.setIntent(fx.c.id, a);
    fx.world.setIntent(fx.t.id, neutral());
    fx.world.setIntent(2, neutral());
    hook?.();
    fx.world.step(DT);
  }
}

function cast(fx: Fx): void {
  fx.c.state.ultCharge = 100;
  const press = neutral();
  press.ultimate = true;
  press.aimYaw = 0;
  fx.world.setIntent(fx.c.id, press);
  fx.world.setIntent(fx.t.id, neutral());
  fx.world.setIntent(2, neutral());
  fx.world.step(DT);
}

const STRIKE = PANTHER_ULTIMATE.damage as number; // 40
const FINISHER = PANTHER_ULTIMATE.splashDamage as number; // 85
const EXEC = PANTHER_ULTIMATE.bonusDamage as number; // +90
const TOTAL = 5 * STRIKE + FINISHER; // 285
const secs = (s: number): number => Math.round(s / DT);
const hasBuff = (f: Fighter, kind: string): boolean => f.state.buffs.some((b) => b.kind === kind);

describe('panther Shadow Execution: config + targeting', () => {
  it('is an 11 m lock ultimate that requires a target', () => {
    const u = ANIMALS.panther.ultimate;
    expect(u).toBe(PANTHER_ULTIMATE);
    expect(u.name).toBe('Shadow Execution');
    expect(u.targeting).toMatchObject({ kind: 'lock', range: 11, requireTarget: true });
    expect(u.description.length).toBeGreaterThan(40);
    expect(u.damageReduction).toBeCloseTo(0.6, 9);
  });

  it('fizzles with no valid target: nothing is spent, ultimateFizzle is emitted', () => {
    const fx = fixture('gorilla', 30);
    cast(fx);
    expect(fx.c.state.ultCharge).toBe(100);
    expect(fx.c.state.ultsUsed).toBe(0);
    expect(fx.c.ability).toBeNull();
    expect(hasBuff(fx.c, 'stealth')).toBe(false);
    expect(ofType(fx.events, 'ultimateFizzle')).toHaveLength(1);
    expect(ofType(fx.events, 'blink')).toHaveLength(0);
  });

  it('a foe behind the panther, an untargetable foe and a flier do not lock; 11.5 m is out of range', () => {
    const behind = fixture('gorilla', 6);
    behind.t.state.pos = { x: 0, y: 0, z: -6 };
    cast(behind);
    expect(ofType(behind.events, 'ultimateFizzle')).toHaveLength(1);
    const ghost = fixture('gorilla', 6);
    ghost.t.untargetable = true;
    cast(ghost);
    expect(ofType(ghost.events, 'ultimateFizzle')).toHaveLength(1);
    const flier = fixture('gorilla', 6);
    flier.t.state.pos.y = 4;
    cast(flier);
    expect(ofType(flier.events, 'ultimateFizzle')).toHaveLength(1);
    const far = fixture('gorilla', 13);
    cast(far);
    expect(ofType(far.events, 'ultimateFizzle')).toHaveLength(1);
    const near = fixture('gorilla', 10);
    cast(near);
    expect(ofType(near.events, 'ultimateFizzle')).toHaveLength(0);
  });

  it('the shared preview agrees with the sim', () => {
    const fx = fixture('gorilla', 10);
    expect(previewUltTarget(ANIMALS.panther.ultimate, fx.c.state, [fx.c.state, fx.t.state], { aimYaw: 0 }).valid).toBe(true);
    fx.t.state.pos.z = 14;
    expect(previewUltTarget(ANIMALS.panther.ultimate, fx.c.state, [fx.c.state, fx.t.state], { aimYaw: 0 }).valid).toBe(false);
  });

  it('locks at cast: ultimateTarget (lock) names the victim; the panther fades into shadow (stealth) during the windup', () => {
    const fx = fixture();
    cast(fx);
    const te = ofType(fx.events, 'ultimateTarget');
    expect(te).toHaveLength(1);
    expect(te[0]).toMatchObject({ fighterId: 0, animal: 'panther', kind: 'lock', targetId: 1 });
    const st = fx.world.snapshot().fighters[0];
    expect(st.ultPhase).toBe('windup');
    expect(st.ultTargetId).toBe(1);
    expect(hasBuff(fx.c, 'stealth')).toBe(true);
    expect(fx.c.state.ultCharge).toBe(0);
  });
});

describe('panther Shadow Execution: shadow steps, damage, execute', () => {
  it('blinks 6 times (5 strikes + the finisher), one ultimateStage each, 0.22 s apart, then reappears (stage 8)', () => {
    const fx = fixture();
    cast(fx);
    const stageT: Record<number, number> = {};
    for (let i = 0; i < secs(PANTHER_T_END + 0.5); i++) {
      tick(fx);
      for (const e of ofType(fx.events, 'ultimateStage')) if (stageT[e.stage] === undefined) stageT[e.stage] = fx.world.snapshot().fighters[0].actionT;
    }
    const stages = ofType(fx.events, 'ultimateStage').map((e) => e.stage);
    expect(stages).toEqual([1, 2, 3, 4, 5, 6, 8]); // no execute flash on a healthy victim
    const blinks = ofType(fx.events, 'blink');
    expect(blinks).toHaveLength(6);
    for (const b of blinks) expect(b.fighterId).toBe(0);
    for (let k = 0; k <= 5; k++) expect(stageT[k + 1 > 6 ? 6 : k + 1]).toBeCloseTo(pantherBlinkTime(k), 1);
    expect(stageT[8]).toBeCloseTo(PANTHER_T_RECOVERY, 1);
    // Gaps between the strike blinks are 0.22 s.
    for (let k = 1; k <= 5; k++) expect(stageT[Math.min(k + 1, 6)] - stageT[k]).toBeCloseTo(E.strikeGap, 1);
  });

  it('circles the victim from changing angles at melee distance and finishes BEHIND them', () => {
    const fx = fixture();
    cast(fx);
    // Track where the panther stands at every stage beat (relative to the victim).
    const seen: { stage: number; ang: number; d: number; behind: number }[] = [];
    for (let i = 0; i < secs(PANTHER_T_END + 0.5); i++) {
      tick(fx);
      for (const e of ofType(fx.events, 'ultimateStage')) {
        if (seen.some((s) => s.stage === e.stage)) continue;
        if (e.stage > 6) continue;
        const dx = e.pos.x - fx.t.state.pos.x;
        const dz = e.pos.z - fx.t.state.pos.z;
        const fwd = { x: Math.sin(fx.t.state.yaw), z: Math.cos(fx.t.state.yaw) };
        seen.push({ stage: e.stage, ang: dirToYaw(dx, dz), d: Math.hypot(dx, dz), behind: (dx * fwd.x + dz * fwd.z) / Math.hypot(dx, dz) });
      }
    }
    expect(seen).toHaveLength(6);
    for (const s of seen) {
      expect(s.d).toBeGreaterThan(1.2);
      expect(s.d).toBeLessThan(2.6);
    }
    // Every consecutive pair of strike angles differs by a clear margin (not a straight-line pace).
    for (let k = 0; k < 4; k++) expect(Math.abs(angleDelta(seen[k].ang, seen[k + 1].ang))).toBeGreaterThan(0.6);
    // Finisher: behind the victim's facing (dot < -0.5 along their forward).
    expect(seen[5].behind).toBeLessThan(-0.5);
    // Each blink puts the panther facing the victim.
    expect(ofType(fx.events, 'blink')).toHaveLength(6);
  });

  it('total damage on an unblocked victim = 5 × 40 + 85 = 285 (no backstab stacking); hits are ~0.08 s after each blink', () => {
    const fx = fixture();
    const hp0 = fx.t.state.hp;
    cast(fx);
    tick(fx, secs(PANTHER_T_END + 0.5));
    expect(hp0 - fx.t.state.hp).toBeCloseTo(TOTAL, 6);
    const hits = ofType(fx.events, 'hit').filter((h) => h.attackerId === 0);
    expect(hits.map((h) => h.damage)).toEqual([STRIKE, STRIKE, STRIKE, STRIKE, STRIKE, FINISHER]);
    expect(hits[5].heavy).toBe(true);
    expect(hits[0].heavy).toBe(false);
  });

  it('executes: a victim under 35% HP when the finisher lands takes +90 and the stage-7 flash fires', () => {
    const fx = fixture('gorilla', 6);
    fx.t.state.hp = 590; // 5 × 40 → 390 = 33.9% of 1150 → under the line
    cast(fx);
    tick(fx, secs(PANTHER_T_END + 0.5));
    expect(590 - fx.t.state.hp).toBeCloseTo(TOTAL + EXEC, 6);
    const stages = ofType(fx.events, 'ultimateStage').map((e) => e.stage);
    expect(stages).toContain(7);
    expect(stages.indexOf(7)).toBeGreaterThan(stages.indexOf(6));
    expect(stages.indexOf(7)).toBeLessThan(stages.indexOf(8));
    const finisher = ofType(fx.events, 'hit').filter((h) => h.attackerId === 0).pop();
    expect(finisher!.damage).toBe(FINISHER + EXEC);
  });

  it('no execute bonus at 35% HP or above, and the line is checked when the finisher lands (not at cast)', () => {
    const fx = fixture('gorilla', 6);
    fx.t.state.hp = 800; // → 590 = 51% before the finisher
    cast(fx);
    tick(fx, secs(PANTHER_T_END + 0.5));
    expect(800 - fx.t.state.hp).toBeCloseTo(TOTAL, 6);
    expect(ofType(fx.events, 'ultimateStage').map((e) => e.stage)).not.toContain(7);
  });

  it('a jumping victim (out of ground reach) dodges the strikes but the panther still completes the sequence', () => {
    const fx = fixture();
    const hp0 = fx.t.state.hp;
    cast(fx);
    tick(fx, secs(PANTHER_T_END + 0.5), () => {
      fx.t.state.pos.y = 4;
    });
    expect(fx.t.state.hp).toBe(hp0);
    expect(ofType(fx.events, 'blink')).toHaveLength(6);
    expect(fx.c.ability).toBeNull();
  });

  it('a guarding victim still takes half-pierced damage (blockIgnore 0.5); flank and rear strikes bypass the guard arc', () => {
    const fx = fixture('rhino', 6);
    cast(fx);
    for (let i = 0; i < secs(PANTHER_T_END + 0.3); i++) {
      const guard = neutral();
      guard.block = true;
      guard.aimYaw = Math.PI; // facing where the panther started, guard up
      fx.world.setIntent(0, neutral());
      fx.world.setIntent(1, guard);
      fx.world.setIntent(2, neutral());
      fx.world.step(DT);
    }
    const blocked = ofType(fx.events, 'blocked').filter((b) => b.attackerId === 0);
    expect(blocked.length).toBeGreaterThanOrEqual(1);
    expect(blocked.length).toBeLessThan(6); // the shifting angles get around the guard
    const pierced = ANIMALS.rhino.blockReduction * (1 - E.strikeBlockIgnore);
    for (const b of blocked) {
      if (b.damage > 60) continue; // (the heavy finisher lands from behind, never blocked)
      expect(b.damage).toBe(Math.round(STRIKE * (1 - pierced)));
      expect(b.damage).toBeGreaterThan(Math.round(STRIKE * (1 - ANIMALS.rhino.blockReduction)));
    }
  });
});

describe('panther Shadow Execution: shadow form, immunity, cleanup', () => {
  it('−60% damage taken and CC-immune from the end of the windup until the recovery; stealth fades in at the reappearance', () => {
    const fx = fixture();
    cast(fx);
    // Windup (0.35 s): interruptible, no reduction yet.
    tick(fx, 10);
    expect(fx.c.incomingDamageReduction).toBe(0);
    expect(fx.c.ccImmune).toBe(false);
    tick(fx, secs(0.35) - 9); // shadow closed
    tick(fx, 3);
    expect(fx.c.incomingDamageReduction).toBeCloseTo(0.6, 9);
    expect(fx.c.ccImmune).toBe(true);
    expect(hasBuff(fx.c, 'stealth')).toBe(true);
    const hp = fx.c.state.hp;
    dealDamage(fx.world, fx.t, fx.c, 100, { blockable: false, heavy: false, reaction: 'none', isBasic: false });
    expect(hp - fx.c.state.hp).toBeCloseTo(40, 6);
    // Stagger / knockdown bounce off.
    applyEffect(fx.world, fx.t, fx.c, { kind: 'stagger', mag: 0, dur: 1 });
    applyEffect(fx.world, fx.t, fx.c, { kind: 'knockdown', mag: 0, dur: 1 });
    expect(fx.c.ability).not.toBeNull();
    // Recovery: visible again, vulnerable, ~1 s.
    const elapsed = 26; // ticks since the cast press
    tick(fx, secs(PANTHER_T_RECOVERY + 0.1) - elapsed);
    expect(fx.world.snapshot().fighters[0].ultPhase).toBe('recovery');
    expect(fx.c.incomingDamageReduction).toBe(0);
    expect(fx.c.ccImmune).toBe(false);
    expect(hasBuff(fx.c, 'stealth')).toBe(false);
    tick(fx, secs(PANTHER_T_END - 0.1 - PANTHER_T_RECOVERY - 0.1)); // just before the recovery ends
    expect(fx.c.ability).not.toBeNull();
    tick(fx, secs(0.4));
    expect(fx.c.ability).toBeNull();
  });

  it('the windup is interruptible: a stagger cancels the cast, and no shadow flags are left behind', () => {
    const fx = fixture();
    cast(fx);
    tick(fx, 8);
    applyEffect(fx.world, fx.t, fx.c, { kind: 'stagger', mag: 0, dur: 0.5 });
    expect(fx.c.ability).toBeNull();
    expect(fx.c.incomingDamageReduction).toBe(0);
    expect(fx.c.ccImmuneChannel).toBe(false);
    tick(fx, secs(1.2)); // the short stealth expires by itself
    expect(hasBuff(fx.c, 'stealth')).toBe(false);
    expect(ofType(fx.events, 'blink')).toHaveLength(0);
    expect(fx.t.state.hp).toBe(fx.t.state.maxHp);
  });

  it('dying mid-sequence clears the shadow (no ghost stealth on the corpse)', () => {
    for (const at of [0.2, 0.6, 1.3, 1.7]) {
      const fx = fixture();
      cast(fx);
      tick(fx, secs(at));
      fx.c.state.hp = 0;
      tick(fx, 2);
      expect(fx.c.state.alive).toBe(false);
      expect(fx.c.ability).toBeNull();
      expect(fx.c.incomingDamageReduction).toBe(0);
      expect(fx.c.ccImmuneChannel).toBe(false);
      expect(hasBuff(fx.c, 'stealth'), `dead at ${at}`).toBe(false);
      expect(fx.world.snapshot().fighters[0].ultPhase).toBeUndefined();
    }
  });

  it('the victim dying mid-sequence ends it: no more blinks, a short recovery, flags cleaned', () => {
    const fx = fixture();
    cast(fx);
    tick(fx, secs(0.6));
    fx.t.state.hp = 1;
    tick(fx, secs(0.4));
    expect(fx.t.state.alive).toBe(false);
    const blinks = ofType(fx.events, 'blink').length;
    expect(blinks).toBeLessThan(6);
    tick(fx, secs(E.brokenRecovery + 0.3));
    expect(ofType(fx.events, 'blink').length).toBe(blinks);
    expect(fx.c.ability).toBeNull();
    expect(fx.c.incomingDamageReduction).toBe(0);
    expect(fx.c.ccImmuneChannel).toBe(false);
    expect(hasBuff(fx.c, 'stealth')).toBe(false);
  });

  it('a victim that becomes untargetable (burrowed mole) breaks the sequence instead of blinking on empty ground', () => {
    const fx = fixture('mole', 6);
    cast(fx);
    tick(fx, secs(0.6));
    fx.t.untargetable = true;
    const blinks = ofType(fx.events, 'blink').length;
    tick(fx, secs(PANTHER_T_END));
    expect(ofType(fx.events, 'blink').length).toBe(blinks);
    expect(fx.c.ability).toBeNull();
  });

  it('every blink stays inside the arena and out of pillars (victim hugging the wall)', () => {
    const fx = fixture('gorilla', 6);
    fx.c.state.pos = { x: 0, y: 0, z: 22 };
    fx.t.state.pos = { x: 0, y: 0, z: 28 };
    cast(fx);
    tick(fx, secs(PANTHER_T_END + 0.5));
    for (const b of ofType(fx.events, 'blink')) {
      expect(Math.hypot(b.to.x, b.to.z)).toBeLessThanOrEqual(30 - fx.c.def.radius + 1e-6);
    }
    expect(ofType(fx.events, 'blink')).toHaveLength(6);
  });

  it('is deterministic (same seed → identical event stream and end state)', () => {
    const run = (): { events: string; hp: number; x: number; z: number } => {
      const fx = fixture('crocodile', 7, 11);
      cast(fx);
      tick(fx, secs(PANTHER_T_END + 0.5));
      return { events: JSON.stringify(fx.events), hp: fx.t.state.hp, x: fx.c.state.pos.x, z: fx.c.state.pos.z };
    };
    const a = run();
    expect(a).toEqual(run());
    expect(a.events.length).toBeGreaterThan(200);
  });
});
