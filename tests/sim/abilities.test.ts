import { describe, it, expect } from 'vitest';
import { liveWorld, neutral, DT } from './helpers';
import { getBuff } from '../../src/sim/StatusEffects';
import type { World } from '../../src/sim/World';
import type { AnimalId } from '../../src/core/types';

/**
 * One smoke test per special and ultimate (§8): set the caster at the origin
 * facing +Z with a target ahead, fire the ability, and assert its signature
 * effect landed. Target is a hippo (1300 hp) so multi-tick ults don't kill it.
 */

const HP0 = 1300;

interface Fixture {
  world: World;
  c: World['fighters'][number];
  t: World['fighters'][number];
}

function fixture(caster: AnimalId, targetDist: number): Fixture {
  const { world } = liveWorld([caster, 'hippo'], 7);
  const c = world.fighters[0];
  const t = world.fighters[1];
  c.state.pos = { x: 0, y: 0, z: 0 };
  c.state.yaw = 0;
  c.state.vel = { x: 0, y: 0, z: 0 };
  t.state.pos = { x: 0, y: 0, z: targetDist };
  t.state.yaw = Math.PI;
  t.state.vel = { x: 0, y: 0, z: 0 };
  return { world, c, t };
}

function fire(fx: Fixture, kind: 'special' | 'ultimate', steps: number): void {
  const { world, c, t } = fx;
  if (kind === 'ultimate') c.state.ultCharge = 100;
  else c.state.specialCd = 0;
  const press = neutral();
  press.aimYaw = 0;
  if (kind === 'ultimate') press.ultimate = true;
  else press.special = true;
  world.setIntent(c.id, press);
  world.setIntent(t.id, neutral());
  world.step(DT);
  const hold = neutral();
  for (let i = 0; i < steps; i++) {
    world.setIntent(c.id, hold);
    world.setIntent(t.id, neutral());
    world.step(DT);
  }
}

describe('specials — signature effects (§8)', () => {
  it('lion Pounce lands an AoE at the leap point', () => {
    const fx = fixture('lion', 7.6);
    fire(fx, 'special', 80);
    expect(fx.t.state.hp).toBeLessThan(HP0);
  });

  it('gorilla Silverback Leap slams + knocks back', () => {
    const fx = fixture('gorilla', 6.8);
    fire(fx, 'special', 80);
    expect(fx.t.state.hp).toBeLessThan(HP0);
  });

  it('crocodile Ambush Lunge primes the follow-up bonus', () => {
    const fx = fixture('crocodile', 20);
    fire(fx, 'special', 55);
    expect(fx.c.ambushBonusTimer).toBeGreaterThan(0);
  });

  it('hippo River Rush impacts for damage', () => {
    const fx = fixture('hippo', 3);
    fire(fx, 'special', 110);
    expect(fx.t.state.hp).toBeLessThan(HP0);
  });

  it('rhino Lockdown Charge deals contact damage', () => {
    const fx = fixture('rhino', 3);
    fire(fx, 'special', 80);
    expect(fx.t.state.hp).toBeLessThanOrEqual(HP0 - 100);
  });

  it('eagle Gale Burst damages + disarms', () => {
    const fx = fixture('eagle', 3);
    fire(fx, 'special', 35);
    expect(fx.t.state.hp).toBeLessThan(HP0);
    expect(fx.t.disarmTimer).toBeGreaterThan(0);
  });

  it('panther Shadow Dash deals pass-through damage', () => {
    const fx = fixture('panther', 3);
    fire(fx, 'special', 45);
    expect(fx.t.state.hp).toBeLessThan(HP0);
  });

  it('python Coil Sweep damages + slows in 360°', () => {
    const fx = fixture('python', 2.5);
    fire(fx, 'special', 35);
    expect(fx.t.state.hp).toBeLessThan(HP0);
    expect(getBuff(fx.t, 'slow')).toBeDefined();
  });

  it('giraffe Thunder Kick damages + knocks back', () => {
    const fx = fixture('giraffe', 2);
    fire(fx, 'special', 35);
    expect(fx.t.state.hp).toBeLessThan(HP0);
  });

  it('mole Burrow goes untargetable then erupts on emerge', () => {
    const { world } = liveWorld(['mole', 'hippo'], 7);
    const c = world.fighters[0];
    const t = world.fighters[1];
    c.state.pos = { x: 0, y: 0, z: 0 };
    c.state.yaw = 0;
    t.state.pos = { x: 0, y: 0, z: 1.3 };
    c.state.specialCd = 0;
    const press = neutral();
    press.special = true;
    world.setIntent(0, press);
    world.setIntent(1, neutral());
    world.step(DT);
    for (let i = 0; i < 30; i++) {
      world.setIntent(0, neutral());
      world.setIntent(1, neutral());
      world.step(DT);
    }
    expect(c.untargetable).toBe(true);
    // Re-press to emerge.
    world.setIntent(0, press);
    world.step(DT);
    for (let i = 0; i < 15; i++) {
      world.setIntent(0, neutral());
      world.setIntent(1, neutral());
      world.step(DT);
    }
    expect(t.state.hp).toBeLessThan(HP0);
  });
});

describe('ultimates — signature effects (§8)', () => {
  it('lion King\'s Roar: AoE damage + fear + feared-vuln', () => {
    const fx = fixture('lion', 3);
    fire(fx, 'ultimate', 30);
    expect(fx.t.state.hp).toBeLessThan(HP0);
    expect(fx.t.fearTimer).toBeGreaterThan(0);
    expect(getBuff(fx.t, 'dmgTakenUp')).toBeDefined();
  });

  it('gorilla Primal Rampage: self buffs + CC-immunity', () => {
    const fx = fixture('gorilla', 3);
    fire(fx, 'ultimate', 40);
    expect(getBuff(fx.c, 'atkSpeedUp')).toBeDefined();
    expect(getBuff(fx.c, 'rage')).toBeDefined();
    expect(fx.c.rampageTimer).toBeGreaterThan(0);
  });

  it('crocodile Death Roll: grab drains heavy damage', () => {
    const fx = fixture('crocodile', 3);
    fire(fx, 'ultimate', 200);
    expect(fx.t.state.hp).toBeLessThanOrEqual(HP0 - 100);
  });

  it('hippo Colossal Chomp: cone damage + slow', () => {
    const fx = fixture('hippo', 3);
    fire(fx, 'ultimate', 100);
    expect(fx.t.state.hp).toBeLessThanOrEqual(HP0 - 200);
    expect(getBuff(fx.t, 'slow')).toBeDefined();
  });

  it('rhino Seismic Stampede: run-through damage', () => {
    const fx = fixture('rhino', 3);
    fire(fx, 'ultimate', 70);
    expect(fx.t.state.hp).toBeLessThanOrEqual(HP0 - 150);
  });

  it('eagle Death From Above: soar then dive for heavy damage', () => {
    const fx = fixture('eagle', 8);
    fire(fx, 'ultimate', 140);
    expect(fx.t.state.hp).toBeLessThanOrEqual(HP0 - 200);
  });

  it('panther Night Prowl: stealth + speed + primed crit', () => {
    const fx = fixture('panther', 3);
    fire(fx, 'ultimate', 20);
    expect(getBuff(fx.c, 'stealth')).toBeDefined();
    expect(getBuff(fx.c, 'speed')).toBeDefined();
    expect(fx.c.stealthCritPending).toBe(true);
  });

  it('python Constrictor\'s Embrace: grab drains heavy damage', () => {
    const fx = fixture('python', 4);
    fire(fx, 'ultimate', 240);
    expect(fx.t.state.hp).toBeLessThanOrEqual(HP0 - 100);
  });

  it('giraffe Guillotine Spin: two sweeps for ≥90 + knockdown', () => {
    const fx = fixture('giraffe', 3);
    fire(fx, 'ultimate', 160);
    expect(fx.t.state.hp).toBeLessThanOrEqual(HP0 - 90);
  });

  it('mole Sinkhole: delayed zone damage + root', () => {
    const fx = fixture('mole', 9.5);
    fire(fx, 'ultimate', 100);
    expect(fx.t.state.hp).toBeLessThan(HP0);
    expect(fx.t.rootTimer).toBeGreaterThan(0);
  });
});
