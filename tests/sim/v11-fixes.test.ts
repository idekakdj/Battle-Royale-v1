/**
 * v1.1 (WP-J) sim regressions: one test per real bug fixed plus the new
 * damage-taken ult-charge comeback lever.
 */

import { describe, it, expect } from 'vitest';
import { dealDamage, tryStartSwing, updateSwing } from '../../src/sim/CombatSystem';
import { addBuff } from '../../src/sim/StatusEffects';
import { ULT } from '../../src/config/balance';
import { ANIMALS } from '../../src/config/animals';
import { makeFighter, makeSim, liveWorld, disablePickups, neutral, DT } from './helpers';
import type { DamageOpts } from '../../src/sim/CombatSystem';
import type { AnimalId } from '../../src/core/types';

const basic: DamageOpts = { blockable: true, heavy: false, reaction: 'none', isBasic: true };

describe('ult charge from damage taken (v1.1 comeback lever)', () => {
  it('the victim banks gainPerDamageTaken × incoming damage', () => {
    const a = makeFighter(0, 'lion', 0, 2, 0);
    const t = makeFighter(1, 'gorilla', 0, 0, 0);
    const sim = makeSim([a, t]);
    dealDamage(sim, a, t, 100, basic);
    expect(ULT.gainPerDamageTaken).toBeGreaterThan(0);
    expect(t.state.ultCharge).toBeCloseTo(100 * ULT.gainPerDamageTaken, 6);
    // The attacker gets nothing from dealDamage itself (basics pay on swing).
    expect(a.state.ultCharge).toBe(0);
  });

  it('blocking does not reduce the victim’s charge gain', () => {
    const mk = (blocking: boolean): number => {
      const a = makeFighter(0, 'lion', 0, 2, 0); // in front of a +Z-facing target
      const t = makeFighter(1, 'gorilla', 0, 0, 0);
      const sim = makeSim([a, t]);
      t.blocking = blocking;
      const r = dealDamage(sim, a, t, 100, basic);
      expect(r.blocked).toBe(blocking);
      return t.state.ultCharge;
    };
    expect(mk(true)).toBeCloseTo(mk(false), 6);
  });

  it('is capped at ULT.max and is a fraction of the landed-hit rate', () => {
    const a = makeFighter(0, 'lion', 0, 2, 0);
    const t = makeFighter(1, 'hippo', 0, 0, 0);
    const sim = makeSim([a, t]);
    t.state.ultCharge = ULT.max - 1;
    dealDamage(sim, a, t, 500, basic);
    expect(t.state.ultCharge).toBe(ULT.max);
    // Comeback, not a replacement: per point of damage the victim earns well
    // under half of what a landed hit1 pays its attacker.
    const hitRate = ULT.gainHit1 / ANIMALS.lion.combo[0];
    expect(ULT.gainPerDamageTaken).toBeLessThan(hitRate * 0.5);
  });
});

describe('panther Night Prowl crit is bound to the stealth window (v1.1 fix)', () => {
  function swingOnce(stealthed: boolean): number {
    const p = makeFighter(0, 'panther', 0, 0, 0);
    const t = makeFighter(1, 'hippo', 0, 1.8, Math.PI); // faces the panther: no backstab
    const sim = makeSim([p, t]);
    p.stealthCritPending = true;
    if (stealthed) addBuff(p, 'stealth', 0, 5);
    p.intent.aimYaw = 0;
    tryStartSwing(p);
    for (let i = 0; i < 200 && p.swinging; i++) updateSwing(sim, p, DT);
    expect(p.stealthCritPending).toBe(false);
    return t.state.maxHp - t.state.hp;
  }

  it('a swing from stealth crits for the bonus', () => {
    expect(swingOnce(true)).toBeCloseTo(ANIMALS.panther.combo[0] + (ANIMALS.panther.ultimate.stealthBonusDamage ?? 0), 5);
  });

  it('once stealth has expired a lingering flag no longer crits', () => {
    expect(swingOnce(false)).toBeCloseTo(ANIMALS.panther.combo[0], 5);
  });
});

describe('mole +25% vs rooted targets applies to all its damage (v1.1 fix)', () => {
  it('a mole basic on a rooted target deals ×(1 + bonusVsRooted)', () => {
    const m = makeFighter(0, 'mole', 0, 2, 0);
    const t = makeFighter(1, 'gorilla', 0, 0, 0);
    const sim = makeSim([m, t]);
    t.rootTimer = 1.5;
    const bonus = ANIMALS.mole.ultimate.bonusVsRooted ?? 0;
    expect(bonus).toBeGreaterThan(0);
    expect(dealDamage(sim, m, t, 60, basic).dealt).toBeCloseTo(60 * (1 + bonus), 5);
    t.rootTimer = 0;
    expect(dealDamage(sim, m, t, 60, basic).dealt).toBeCloseTo(60, 5);
  });

  it('other animals get no rooted bonus', () => {
    const l = makeFighter(0, 'lion', 0, 2, 0);
    const t = makeFighter(1, 'gorilla', 0, 0, 0);
    const sim = makeSim([l, t]);
    t.rootTimer = 1.5;
    expect(dealDamage(sim, l, t, 60, basic).dealt).toBeCloseTo(60, 5);
  });
});

describe('aimed ground-point abilities land on the aimed target (v1.1 fix)', () => {
  // Pre-fix these always landed at MAX range along the aim yaw, sailing past
  // a foe standing closer than that.
  function castAt(caster: AnimalId, dist: number, kind: 'special' | 'ultimate', steps: number): number {
    const { world } = liveWorld([caster, 'hippo'], 7);
    disablePickups(world);
    const c = world.fighters[0];
    const t = world.fighters[1];
    c.state.pos = { x: 0, y: 0, z: 0 };
    c.state.yaw = 0;
    t.state.pos = { x: 0, y: 0, z: dist };
    t.state.yaw = Math.PI;
    if (kind === 'ultimate') c.state.ultCharge = 100;
    else c.state.specialCd = 0;
    const press = neutral();
    press.aimYaw = 0;
    if (kind === 'ultimate') press.ultimate = true;
    else press.special = true;
    world.setIntent(0, press);
    world.setIntent(1, neutral());
    world.step(DT);
    const hold = neutral();
    for (let i = 0; i < steps; i++) {
      world.setIntent(0, hold);
      world.setIntent(1, neutral());
      world.step(DT);
    }
    return t.state.maxHp - t.state.hp;
  }

  it('lion Pounce at a foe 4 m away (max range 8 m) lands on them', () => {
    expect(castAt('lion', 4, 'special', 60)).toBeGreaterThan(0);
  });

  it('gorilla Silverback Leap at a foe 2.5 m away (max range 7 m) lands on them', () => {
    expect(castAt('gorilla', 2.5, 'special', 60)).toBeGreaterThan(0);
  });

  it('mole Sinkhole at a foe 3 m away (max range 10 m) catches them', () => {
    expect(castAt('mole', 3, 'ultimate', 100)).toBeGreaterThan(0);
  });

  it('eagle Death From Above at a foe 3 m away (dive range 8 m) hits them', () => {
    expect(castAt('eagle', 3, 'ultimate', 140)).toBeGreaterThan(0);
  });
});

describe('crocodile Ambush Lunge stops on contact (v1.1 fix)', () => {
  it('ends in front of the target, primed for the boosted Snap', () => {
    const { world } = liveWorld(['crocodile', 'hippo'], 7);
    disablePickups(world);
    const c = world.fighters[0];
    const t = world.fighters[1];
    c.state.pos = { x: 0, y: 0, z: 0 };
    c.state.yaw = 0;
    t.state.pos = { x: 0, y: 0, z: 3.5 };
    c.state.specialCd = 0;
    const press = neutral();
    press.aimYaw = 0;
    press.special = true;
    world.setIntent(0, press);
    world.setIntent(1, neutral());
    world.step(DT);
    for (let i = 0; i < 60; i++) {
      world.setIntent(0, neutral());
      world.setIntent(1, neutral());
      world.step(DT);
    }
    const d = Math.hypot(t.state.pos.x - c.state.pos.x, t.state.pos.z - c.state.pos.z);
    expect(c.state.pos.z).toBeLessThan(t.state.pos.z); // did not plough through
    expect(d).toBeLessThanOrEqual(ANIMALS.crocodile.range); // Snap reaches
  });
});
