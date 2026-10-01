import { describe, it, expect } from 'vitest';
import { liveWorld, neutral, disablePickups, DT } from '../helpers';
import { ANIMALS } from '../../../src/config/animals';
import { LION_HUNT as H, LION_T_END, LION_T_LAND, LION_T_ROAR, LION_ULTIMATE } from '../../../src/config/ultimates/lion';

const POUNCE = LION_ULTIMATE.damage as number; // 65
const STRIKE = LION_ULTIMATE.bonusDamage as number; // 48
const TOTAL = POUNCE + 4 * STRIKE + H.roarDamage; // 292
import type { AnimalId, GameEvent, GameEventOf } from '../../../src/core/types';
import type { World } from '../../../src/sim/World';
import type { Fighter } from '../../../src/sim/Fighter';
import { dealDamage } from '../../../src/sim/CombatSystem';
import { applyEffect } from '../../../src/sim/StatusEffects';
import { previewUltTarget } from '../../../src/sim/ultimates/targeting';

function ofType<T extends GameEvent['type']>(events: GameEvent[], type: T): GameEventOf<T>[] {
  return events.filter((e): e is GameEventOf<T> => e.type === type);
}

interface Fx {
  world: World;
  events: GameEvent[];
  c: Fighter; // the lion
  t: Fighter; // the victim
}

function fixture(victim: AnimalId = 'gorilla', dist = 6, seed = 7): Fx {
  const events: GameEvent[] = [];
  // A far-off bystander keeps the match alive when the lion or its victim dies.
  const { world } = liveWorld(['lion', victim, 'hippo'], seed, events);
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

const secs = (s: number): number => Math.round(s / DT);

describe('lion Royal Hunt: config + targeting', () => {
  it('is a 12 m lock ultimate that requires a target', () => {
    const u = ANIMALS.lion.ultimate;
    expect(u).toBe(LION_ULTIMATE);
    expect(u.name).toBe('Royal Hunt');
    expect(u.targeting).toMatchObject({ kind: 'lock', range: 12, requireTarget: true });
    expect(u.description.length).toBeGreaterThan(40);
  });

  it('fizzles with no valid target: nothing is spent, ultimateFizzle is emitted', () => {
    const fx = fixture('gorilla', 30);
    cast(fx);
    expect(fx.c.state.ultCharge).toBe(100);
    expect(fx.c.state.ultsUsed).toBe(0);
    expect(fx.c.ability).toBeNull();
    expect(ofType(fx.events, 'ultimateFizzle')).toHaveLength(1);
    expect(ofType(fx.events, 'ultimate')).toHaveLength(0);
  });

  it('a foe behind the lion (outside the 70° aim cone), an untargetable foe and a flier do not lock', () => {
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
  });

  it('the shared preview agrees with the sim: valid inside 12 m, invalid outside', () => {
    const fx = fixture('gorilla', 11);
    const inRange = previewUltTarget(ANIMALS.lion.ultimate, fx.c.state, [fx.c.state, fx.t.state], { aimYaw: 0 });
    expect(inRange.valid).toBe(true);
    expect(inRange.targetId).toBe(1);
    fx.t.state.pos.z = 14;
    const outRange = previewUltTarget(ANIMALS.lion.ultimate, fx.c.state, [fx.c.state, fx.t.state], { aimYaw: 0 });
    expect(outRange.valid).toBe(false);
  });

  it('locks at cast: ultimateTarget (lock) names the victim and carries the lead time to touchdown', () => {
    const fx = fixture();
    cast(fx);
    const te = ofType(fx.events, 'ultimateTarget');
    expect(te).toHaveLength(1);
    expect(te[0]).toMatchObject({ fighterId: 0, animal: 'lion', kind: 'lock', targetId: 1 });
    expect(te[0].windup).toBeCloseTo(LION_T_LAND, 9);
    const st = fx.world.snapshot().fighters[0];
    expect(st.action).toBe('ultimate');
    expect(st.ultPhase).toBe('windup');
    expect(st.ultTargetId).toBe(1);
    expect(fx.c.state.ultCharge).toBe(0);
  });
});

describe('lion Royal Hunt: stage beats, damage, pin', () => {
  it('walks the fixed timeline: leap → touchdown → 4 strikes → roar → recovery, one stage each', () => {
    const fx = fixture();
    cast(fx);
    const stageT: Record<number, number> = {};
    const phases = new Set<string>();
    let sawImmune = false;
    for (let i = 0; i < secs(LION_T_END + 0.5); i++) {
      tick(fx);
      for (const e of ofType(fx.events, 'ultimateStage')) if (stageT[e.stage] === undefined) stageT[e.stage] = fx.world.snapshot().fighters[0].actionT;
      const st = fx.world.snapshot().fighters[0];
      if (st.ultPhase !== undefined) phases.add(st.ultPhase);
      if (fx.c.ccImmune) sawImmune = true;
    }
    expect(ofType(fx.events, 'ultimateStage').map((e) => e.stage)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // Touchdown at windup + leap; strike k begins firstStrike + k × gap later; the roar at LION_T_ROAR.
    expect(stageT[1]).toBeCloseTo(H.windup, 1);
    expect(stageT[2]).toBeCloseTo(LION_T_LAND, 1);
    for (let k = 0; k < 4; k++) expect(stageT[3 + k]).toBeCloseTo(LION_T_LAND + H.firstStrike + k * H.strikeGap, 1);
    expect(stageT[7]).toBeCloseTo(LION_T_ROAR, 1);
    expect([...phases].sort()).toEqual(['active', 'recovery', 'windup']);
    expect(sawImmune).toBe(true);
    // The whole thing is over and clean.
    expect(fx.c.ability).toBeNull();
    expect(fx.c.ccImmuneChannel).toBe(false);
    expect(fx.c.state.action).not.toBe('ultimate');
    for (const e of ofType(fx.events, 'ultimateStage')) expect(e.targetId).toBe(1);
  });

  it('each stage event carries the victim position (strikes) and the whole sequence stays inside the arena', () => {
    const fx = fixture();
    cast(fx);
    for (let i = 0; i < secs(LION_T_END + 0.5); i++) {
      tick(fx);
      expect(Math.hypot(fx.c.state.pos.x, fx.c.state.pos.z)).toBeLessThan(30);
      expect(Number.isFinite(fx.c.state.pos.y)).toBe(true);
    }
    for (const e of ofType(fx.events, 'ultimateStage').filter((s) => s.stage >= 3)) {
      expect(Math.hypot(e.pos.x - fx.t.state.pos.x, e.pos.z - fx.t.state.pos.z)).toBeLessThan(0.5);
    }
  });

  it('leaps in an arc (airborne, above ground) and lands next to the victim', () => {
    const fx = fixture('gorilla', 9);
    cast(fx);
    let peak = 0;
    let airborneTicks = 0;
    for (let i = 0; i < secs(LION_T_LAND + 0.1); i++) {
      tick(fx);
      peak = Math.max(peak, fx.c.state.pos.y);
      if (fx.c.state.airborne) airborneTicks++;
    }
    expect(peak).toBeGreaterThan(1.5);
    expect(peak).toBeLessThanOrEqual(H.leapPeakMax + 0.01);
    expect(airborneTicks * DT).toBeGreaterThan(H.leapT - 0.1);
    expect(fx.c.state.airborne).toBe(false);
    expect(fx.c.state.pos.y).toBeCloseTo(0, 6);
    const gap = Math.hypot(fx.c.state.pos.x - fx.t.state.pos.x, fx.c.state.pos.z - fx.t.state.pos.z);
    expect(gap).toBeLessThan(fx.c.def.radius + fx.t.def.radius + 0.3);
  });

  it('total damage on an unblocked victim = pounce + 4 strikes + roar (65 + 4 × 48 + 35 = 292); every hit is a hit event', () => {
    const fx = fixture();
    const hp0 = fx.t.state.hp;
    cast(fx);
    tick(fx, secs(LION_T_END + 0.5));
    expect(hp0 - fx.t.state.hp).toBeCloseTo(TOTAL, 6);
    const hits = ofType(fx.events, 'hit').filter((h) => h.attackerId === 0);
    expect(hits.map((h) => h.damage)).toEqual([POUNCE, STRIKE, STRIKE, STRIKE, STRIKE, H.roarDamage]);
    expect(fx.c.state.damageDealt).toBeCloseTo(TOTAL, 6);
  });

  it('the pounce pins the victim (knockdown) until the roar, and they cannot act while mauled', () => {
    const fx = fixture();
    cast(fx);
    tick(fx, secs(LION_T_LAND + 0.05));
    expect(fx.t.knockdownTimer).toBeGreaterThan(1.5);
    expect(fx.world.snapshot().fighters[1].action).toBe('knockdown');
    // Even a victim mashing every button cannot swing, block or move while pinned.
    const pos0 = { ...fx.t.state.pos };
    for (let i = 0; i < secs(1.2); i++) {
      const mash = neutral();
      mash.attack = i % 2 === 0;
      mash.block = i % 3 === 0;
      mash.moveZ = 1;
      fx.world.setIntent(1, mash);
      fx.world.setIntent(0, neutral());
      fx.world.step(DT);
    }
    expect(fx.world.snapshot().fighters[1].action).toBe('knockdown');
    expect(Math.hypot(fx.t.state.pos.x - pos0.x, fx.t.state.pos.z - pos0.z)).toBeLessThan(0.05);
    // The pin clock the renderer keys the fall pose off starts at touchdown and advances.
    expect(fx.t.state.actionDur).toBeCloseTo(H.pinTotal, 9);
    expect(fx.t.state.actionT).toBeGreaterThan(1.0);
  });

  it('the pounce pierces guard: a blocking victim still eats the full pounce (and is pinned)', () => {
    const fx = fixture('rhino', 6);
    cast(fx);
    for (let i = 0; i < secs(LION_T_LAND + 0.05); i++) {
      const guard = neutral();
      guard.block = true;
      guard.aimYaw = Math.PI; // facing the lion, guard up
      fx.world.setIntent(0, neutral());
      fx.world.setIntent(1, guard);
      fx.world.setIntent(2, neutral());
      fx.world.step(DT);
    }
    const pounce = ofType(fx.events, 'blocked').find((h) => h.attackerId === 0);
    expect(pounce).toBeDefined();
    expect(pounce!.damage).toBe(POUNCE);
    expect(fx.t.knockdownTimer).toBeGreaterThan(1.5);
  });

  it('a whiffed pounce (victim jumped out of reach) recovers 0.9 s, is punishable and deals nothing', () => {
    const fx = fixture();
    cast(fx);
    const hp0 = fx.t.state.hp;
    // Victim leaps out of ground reach for the whole flight.
    tick(fx, secs(LION_T_LAND + 0.05), () => {
      fx.t.state.pos.y = 4;
    });
    fx.t.state.pos.y = 0;
    expect(fx.t.state.hp).toBe(hp0);
    expect(fx.c.ability).not.toBeNull();
    expect(fx.world.snapshot().fighters[0].ultPhase).toBe('recovery');
    expect(fx.c.ccImmuneChannel).toBe(false); // punishable
    tick(fx, secs(0.9) - 4);
    expect(fx.c.ability).not.toBeNull();
    tick(fx, 12);
    expect(fx.c.ability).toBeNull();
    expect(ofType(fx.events, 'ultimateStage').map((e) => e.stage)).toEqual([1, 2]); // no strikes, no roar
    expect(fx.t.knockdownTimer).toBe(0);
  });

  it('a victim who ran far away during the windup is missed (homing is limited)', () => {
    const fx = fixture('gorilla', 8);
    cast(fx);
    tick(fx, secs(LION_T_LAND + 0.05), () => {
      fx.t.state.pos.z += 6.5 * DT; // sprints straight away at 6.5 m/s
    });
    expect(fx.world.snapshot().fighters[0].ultPhase).toBe('recovery');
    expect(fx.t.state.hp).toBe(fx.t.state.maxHp);
  });
});

describe('lion Royal Hunt: roar mark, buffs, crowd-control immunity', () => {
  it('the roar marks the victim (+20% damage taken, 6 s) and gives the lion +20% speed for 4 s', () => {
    const fx = fixture();
    cast(fx);
    tick(fx, secs(LION_T_ROAR + H.roarImpactDelay + 0.05));
    const mark = fx.t.state.buffs.find((b) => b.kind === 'dmgTakenUp');
    expect(mark).toBeDefined();
    expect(mark!.mag).toBeCloseTo(0.2, 9);
    expect(mark!.dur).toBeCloseTo(6, 9);
    const speed = fx.c.state.buffs.find((b) => b.kind === 'speed');
    expect(speed).toBeDefined();
    expect(speed!.mag).toBeCloseTo(0.2, 9);
    expect(speed!.dur).toBeCloseTo(4, 9);
    // The roar staggers.
    expect(fx.t.staggerTimer).toBeGreaterThan(0.5);
    // A marked victim takes 20% more from anyone (checked with the pipeline, staggered vuln aside).
    fx.t.staggerTimer = 0;
    const before = fx.t.state.hp;
    dealDamage(fx.world, fx.c, fx.t, 100, { blockable: false, heavy: false, reaction: 'none', isBasic: false });
    expect(before - fx.t.state.hp).toBeCloseTo(120, 6);
    // …and the mark runs out.
    tick(fx, secs(6.2));
    expect(fx.t.state.buffs.some((b) => b.kind === 'dmgTakenUp')).toBe(false);
    expect(fx.c.state.buffs.some((b) => b.kind === 'speed')).toBe(false);
  });

  it('is interruptible only during the coil: a stagger cancels the windup, but not the pounce or the maul', () => {
    const early = fixture();
    cast(early);
    tick(early, 10);
    applyEffect(early.world, early.t, early.c, { kind: 'stagger', mag: 0, dur: 1 });
    expect(early.c.ability).toBeNull();
    expect(early.c.ccImmuneChannel).toBe(false);
    expect(early.t.state.hp).toBe(early.t.state.maxHp);

    for (const at of [H.windup + 0.2, LION_T_LAND + 0.1, LION_T_LAND + 0.7, LION_T_ROAR + 0.2]) {
      const fx = fixture();
      cast(fx);
      tick(fx, secs(at));
      expect(fx.c.ccImmune).toBe(true);
      applyEffect(fx.world, fx.t, fx.c, { kind: 'stagger', mag: 0, dur: 1 });
      applyEffect(fx.world, fx.t, fx.c, { kind: 'knockdown', mag: 0, dur: 1 });
      applyEffect(fx.world, fx.t, fx.c, { kind: 'fear', mag: 0, dur: 1 });
      fx.c.interrupt();
      expect(fx.c.ability, `interrupt at ${at}`).not.toBeNull();
      tick(fx, secs(LION_T_END + 0.5));
      expect(fx.c.ability).toBeNull();
      expect(fx.c.knockdownTimer).toBe(0);
    }
  });

  it('the lion takes normal damage while mauling (immune to CC, not to damage)', () => {
    const fx = fixture();
    cast(fx);
    tick(fx, secs(LION_T_LAND + 0.7));
    const hp = fx.c.state.hp;
    dealDamage(fx.world, fx.t, fx.c, 100, { blockable: false, heavy: true, reaction: 'stagger', isBasic: false });
    expect(hp - fx.c.state.hp).toBeCloseTo(100, 6);
    expect(fx.c.ability).not.toBeNull();
  });
});

describe('lion Royal Hunt: cleanup on death / victim loss, determinism', () => {
  it('the lion dying mid-maul releases the pin and leaves nothing behind', () => {
    const fx = fixture();
    cast(fx);
    tick(fx, secs(LION_T_LAND + 0.5));
    expect(fx.t.knockdownTimer).toBeGreaterThan(1);
    fx.c.state.hp = 0;
    tick(fx, 2);
    expect(fx.c.state.alive).toBe(false);
    expect(fx.c.ability).toBeNull();
    expect(fx.t.knockdownTimer).toBeLessThanOrEqual(0.3 + 1e-9);
    tick(fx, 60);
    expect(fx.t.knockdownTimer).toBe(0);
    expect(fx.world.snapshot().fighters[0].ultPhase).toBeUndefined();
  });

  it('the lion dying mid-windup or mid-leap is clean too', () => {
    for (const at of [0.2, H.windup + 0.2]) {
      const fx = fixture();
      cast(fx);
      tick(fx, secs(at));
      fx.c.state.hp = 0;
      tick(fx, 2);
      expect(fx.c.ability).toBeNull();
      expect(fx.t.knockdownTimer).toBe(0);
      expect(fx.t.state.hp).toBe(fx.t.state.maxHp);
    }
  });

  it('the victim dying mid-maul lets the sequence finish cleanly without further hits on the corpse', () => {
    const fx = fixture();
    cast(fx);
    tick(fx, secs(LION_T_LAND + 0.4));
    fx.t.state.hp = 1;
    tick(fx, secs(0.4)); // the next claw finishes them
    expect(fx.t.state.alive).toBe(false);
    const hitsAfter = ofType(fx.events, 'hit').length;
    tick(fx, secs(LION_T_END + 0.5));
    expect(ofType(fx.events, 'hit').length).toBe(hitsAfter);
    expect(fx.c.ability).toBeNull();
    expect(fx.c.ccImmuneChannel).toBe(false);
  });

  it('a lock victim that dies during the windup means a harmless whiff at the last known spot', () => {
    const fx = fixture();
    cast(fx);
    tick(fx, 10);
    fx.t.state.hp = 0;
    tick(fx, secs(LION_T_END + 1));
    expect(fx.c.ability).toBeNull();
    expect(fx.c.ccImmuneChannel).toBe(false);
  });

  it('cannot pin a CC-immune victim (raging gorilla) but still mauls them', () => {
    const fx = fixture('gorilla', 6);
    fx.t.rampageTimer = 10; // ccImmune every tick
    cast(fx);
    tick(fx, secs(LION_T_END + 0.5));
    expect(fx.t.knockdownTimer).toBe(0);
    expect(fx.world.snapshot().fighters[1].action).not.toBe('knockdown');
    const dmg = ofType(fx.events, 'hit').filter((h) => h.attackerId === 0).reduce((a, h) => a + h.damage, 0);
    expect(dmg).toBeGreaterThan(200);
  });

  it('is deterministic (same seed → identical event stream and end state)', () => {
    const run = (): { events: string; hp: number; x: number; z: number } => {
      const fx = fixture('crocodile', 7, 11);
      cast(fx);
      tick(fx, secs(LION_T_END + 0.5));
      return {
        events: JSON.stringify(fx.events),
        hp: fx.t.state.hp,
        x: fx.c.state.pos.x,
        z: fx.c.state.pos.z,
      };
    };
    const a = run();
    const b = run();
    expect(a).toEqual(b);
    expect(a.events.length).toBeGreaterThan(200);
  });
});
