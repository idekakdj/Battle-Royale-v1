import { describe, it, expect } from 'vitest';
import { liveWorld, neutral, disablePickups, DT } from './helpers';
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
  disablePickups(world); // a knocked-back target must not land on a heal pad
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
    disablePickups(world);
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
  it('lion Royal Hunt: pounce pin + 4 piercing maul strikes + roar mark (290+ total, marked, speed buff)', () => {
    const fx = fixture('lion', 3);
    fire(fx, 'ultimate', 230); // ~3.9 s: the whole sequence
    expect(fx.t.state.hp).toBeLessThanOrEqual(HP0 - 290);
    expect(getBuff(fx.t, 'dmgTakenUp')).toBeDefined(); // the roar's mark
    expect(getBuff(fx.c, 'speed')).toBeDefined(); // +20% speed for 4 s
  });

  it('gorilla Boulder Hurl: heave, release, the boulder lands for 200 + a stagger (v1.3: ≈ 1.6 s to impact)', () => {
    const fx = fixture('gorilla', 9);
    fire(fx, 'ultimate', 130);
    expect(fx.t.state.hp).toBeLessThanOrEqual(HP0 - 198);
    expect(fx.t.staggerTimer).toBeGreaterThan(0);
  });

  it('crocodile Death Roll: grab drains heavy damage', () => {
    const fx = fixture('crocodile', 3);
    fire(fx, 'ultimate', 200);
    expect(fx.t.state.hp).toBeLessThanOrEqual(HP0 - 100);
  });

  it("hippo Riverlord's Flood (v1.3): a 130 wave along the path, then a slowing mud pool", () => {
    const fx = fixture('hippo', 3);
    fire(fx, 'ultimate', 100);
    expect(fx.t.state.hp).toBeLessThanOrEqual(HP0 - 130);
    expect(getBuff(fx.t, 'slow')).toBeDefined();
  });

  it('rhino Seismic Stampede (v1.3): gores the locked foe for 120 on contact', () => {
    const fx = fixture('rhino', 3);
    fire(fx, 'ultimate', 100);
    expect(fx.t.state.hp).toBeLessThanOrEqual(HP0 - 120);
  });

  it('eagle Death From Above: spiral up, track, commit, then stoop for heavy damage (v1.3: ≈ 3.4 s to impact)', () => {
    const fx = fixture('eagle', 8);
    fire(fx, 'ultimate', 230);
    expect(fx.t.state.hp).toBeLessThanOrEqual(HP0 - 200);
  });

  it('panther Shadow Execution: shadow form during 5 shadow-step strikes + finisher (285 total)', () => {
    const fx = fixture('panther', 3);
    fire(fx, 'ultimate', 60); // mid-sequence
    expect(getBuff(fx.c, 'stealth')).toBeDefined(); // melted into shadow
    expect(fx.c.incomingDamageReduction).toBeCloseTo(0.6, 9); // −60% damage taken
    expect(fx.c.ccImmune).toBe(true);
    for (let i = 0; i < 200; i++) {
      fx.world.setIntent(fx.c.id, neutral());
      fx.world.setIntent(fx.t.id, neutral());
      fx.world.step(DT);
    }
    expect(fx.t.state.hp).toBeLessThanOrEqual(HP0 - 270);
    expect(getBuff(fx.c, 'stealth')).toBeUndefined(); // visible again after the finisher
    expect(fx.c.incomingDamageReduction).toBe(0);
  });

  it('python Constrictor\'s Embrace: grab drains heavy damage', () => {
    const fx = fixture('python', 4);
    fire(fx, 'ultimate', 240);
    expect(fx.t.state.hp).toBeLessThanOrEqual(HP0 - 100);
  });

  it('giraffe Timber Fall: rear back, circle commits, the neck-hammer slam for 230 + a stun (v1.3: ≈ 1.25 s to impact)', () => {
    const fx = fixture('giraffe', 5);
    fire(fx, 'ultimate', 90);
    expect(fx.t.state.hp).toBeLessThanOrEqual(HP0 - 228);
    expect(fx.t.staggerTimer).toBeGreaterThan(0.5);
  });

  it('mole Sinkhole Vortex: dig + crack, vortex grind, then the collapse damages + roots (v1.3: ≈ 3.3 s)', () => {
    const fx = fixture('mole', 9.5);
    fire(fx, 'ultimate', 215);
    expect(fx.t.state.hp).toBeLessThan(HP0);
    expect(fx.t.rootTimer).toBeGreaterThan(0);
  });
});
