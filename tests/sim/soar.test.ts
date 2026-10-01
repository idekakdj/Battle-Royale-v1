/**
 * v1.2 eagle soar (UPGRADE-PLAN-v1.2 §3.1 / §3.3): holding Space climbs to the
 * max height, no attack/block/special/ult above the lock height, ground AoEs /
 * charges / melee / pickups miss a high flyer, the landing slam (damage,
 * radius, knockback, recovery, `landingImpact` payload) and the flight
 * cooldown that starts on touchdown.
 */
import { describe, it, expect } from 'vitest';
import type { World } from '../../src/sim/World';
import type { AnimalId, FighterIntent, GameEvent, GameEventOf } from '../../src/core/types';
import { ANIMALS } from '../../src/config/animals';
import { MOVE } from '../../src/config/balance';
import { landingDamage } from '../../src/sim/soar';
import { DT, liveWorld, neutral, disablePickups } from './helpers';

const EAGLE = ANIMALS.eagle;
const SOAR = EAGLE.perks.soar!;
const GLIDE = EAGLE.perks.glide!;

function ofType<T extends GameEvent['type']>(events: GameEvent[], type: T): GameEventOf<T>[] {
  return events.filter((e): e is GameEventOf<T> => e.type === type);
}

function place(world: World, id: number, x: number, z: number, yaw = 0): void {
  const s = world.fighters[id].state;
  s.pos.x = x;
  s.pos.z = z;
  s.pos.y = 0;
  s.vel.x = 0;
  s.vel.y = 0;
  s.vel.z = 0;
  s.airborne = false;
  s.yaw = yaw;
}

/** Eagle (id 0) + others parked far away; test area centred on (0, -18). */
function eagleWorld(others: AnimalId[] = ['lion']): { world: World; events: GameEvent[] } {
  const { world, events } = liveWorld(['eagle', ...others], 11);
  disablePickups(world);
  place(world, 0, 0, -18);
  for (let i = 1; i < world.fighters.length; i++) place(world, i, -22 + 3 * i, 12);
  return { world, events };
}

/** Circle at glide speed (radius ≈ 4 m) so the flight never reaches the wall. */
function circling(t: number, jump: boolean): FighterIntent {
  return { ...neutral(), moveX: Math.cos(2 * t), moveZ: Math.sin(2 * t), jump };
}

/** Jump + hold until `holdS`, recording the eagle's peak altitude. */
function flyFor(world: World, holdS: number): number {
  let peak = 0;
  const n = Math.round(holdS / DT);
  for (let i = 0; i < n; i++) {
    world.setIntent(0, circling(i * DT, true));
    world.step(DT);
    peak = Math.max(peak, world.fighters[0].state.pos.y);
  }
  return peak;
}

/** Hover (keep holding) with the eagle pinned over (x, z) at its current altitude. */
function holdOver(world: World, x: number, z: number): void {
  const s = world.fighters[0].state;
  s.pos.x = x;
  s.pos.z = z;
  s.vel.x = 0;
  s.vel.z = 0;
}

describe('eagle soar — flight (§3.1)', () => {
  it('holding Space glides, then climbs smoothly to the max height, within the flight time', () => {
    const { world } = eagleWorld();
    const peak = flyFor(world, 3.0);
    const s = world.fighters[0].state;
    expect(peak).toBeGreaterThan(SOAR.maxHeight - 0.1);
    expect(peak).toBeLessThanOrEqual(SOAR.maxHeight + 1e-9);
    expect(s.glideT).toBeGreaterThan(0);
    expect(s.action).toBe('glide');
    expect(s.airborne).toBe(true);
  });

  it('climb is gradual: no single tick rises faster than the climb rate', () => {
    const { world } = eagleWorld();
    let prevY = 0;
    let maxRise = 0;
    for (let i = 0; i < Math.round(3 / DT); i++) {
      world.setIntent(0, circling(i * DT, true));
      world.step(DT);
      const y = world.fighters[0].state.pos.y;
      if (world.fighters[0].state.glideT > 0) maxRise = Math.max(maxRise, (y - prevY) / DT);
      prevY = y;
    }
    expect(maxRise).toBeLessThanOrEqual(Math.max(SOAR.climbRate, MOVE.jumpVelocity * 0.4) + 1e-6);
  });

  it('the flight ends when the flight time runs out even if Space stays held', () => {
    const { world } = eagleWorld();
    flyFor(world, GLIDE.duration + 1.5);
    const s = world.fighters[0].state;
    expect(s.glideT).toBe(0);
    expect(s.pos.y).toBeLessThan(SOAR.maxHeight);
  });

  it('above the lock height the eagle cannot attack, block, special or ult', () => {
    const { world, events } = eagleWorld();
    flyFor(world, 2.5);
    const f = world.fighters[0];
    expect(f.state.pos.y).toBeGreaterThan(SOAR.attackLockHeight);
    f.state.ultCharge = 100;
    events.length = 0;
    const presses: Partial<FighterIntent>[] = [{ attack: true }, { special: true }, { ultimate: true }, { block: true }];
    for (const p of presses) {
      world.setIntent(0, { ...circling(0, true), ...p });
      world.step(DT);
      world.setIntent(0, circling(0, true));
      world.step(DT);
    }
    expect(ofType(events, 'special')).toHaveLength(0);
    expect(ofType(events, 'ultimate')).toHaveLength(0);
    expect(ofType(events, 'telegraph')).toHaveLength(0);
    expect(f.ability).toBeNull();
    expect(f.swinging).toBe(false);
    expect(f.blocking).toBe(false);
    expect(f.state.specialCd).toBe(0);
    expect(f.state.ultCharge).toBe(100);
    expect(f.state.pos.y).toBeGreaterThan(SOAR.attackLockHeight); // still flying
  });
});

describe('eagle soar — dodging by altitude (§3.1)', () => {
  it("ground AoEs ignore a fighter above the ground-reach altitude (Coil Sweep at 2.8 m)", () => {
    // (Was King's Roar until v1.3 replaced the lion ultimate; the python's 3 m Coil Sweep special is the same ground circle.)
    const { world, events } = eagleWorld(['python', 'gorilla']);
    place(world, 1, 0, -14); // python
    place(world, 2, 2, -14); // gorilla, grounded, inside the 3 m sweep
    const eagle = world.fighters[0];
    eagle.state.pos.y = 2.8; // above 2.5 m reach, inside the old 3 m AoE tolerance
    eagle.state.airborne = true;
    world.fighters[1].state.specialCd = 0;
    const hp0 = eagle.state.hp;
    world.setIntent(1, { ...neutral(), special: true, aimYaw: Math.PI });
    world.step(DT);
    world.setIntent(1, { ...neutral(), aimYaw: Math.PI });
    for (let i = 0; i < 30; i++) {
      eagle.state.pos.y = 2.8;
      eagle.state.vel.y = 0;
      world.step(DT);
    }
    const sweepHits = ofType(events, 'hit').filter((e) => e.attackerId === 1);
    expect(sweepHits.some((e) => e.targetId === 2)).toBe(true); // sanity: the sweep fired
    expect(sweepHits.some((e) => e.targetId === 0)).toBe(false);
    expect(eagle.state.hp).toBe(hp0);
  });

  it('a charge (Seismic Stampede) runs under a soaring eagle; melee swings miss it', () => {
    const { world, events } = eagleWorld(['rhino', 'gorilla']);
    flyFor(world, 2.2);
    const eagle = world.fighters[0];
    expect(eagle.state.pos.y).toBeGreaterThan(MOVE.groundHitMaxAltitude);
    // Rhino stampedes straight through the eagle's ground position.
    place(world, 1, -6, -18, Math.PI / 2);
    world.fighters[1].state.ultCharge = 100;
    // Gorilla swings from right underneath.
    place(world, 2, 0.5, -18.5, 0);
    const hp0 = eagle.state.hp;
    // v1.3 Seismic Stampede: 0.8 s paw windup + a 0.5 s gallop ramp before it reaches the gorilla 6.5 m away.
    for (let i = 0; i < Math.round(2.0 / DT); i++) {
      holdOver(world, 0, -18);
      world.setIntent(0, { ...neutral(), jump: true });
      world.setIntent(1, { ...neutral(), ultimate: i === 0, aimYaw: Math.PI / 2 });
      world.setIntent(2, { ...neutral(), attack: i % 20 === 0, aimYaw: 0 });
      world.step(DT);
    }
    expect(ofType(events, 'ultimate').some((e) => e.fighterId === 1)).toBe(true);
    // Sanity: the stampede really ran through the spot (it trampled the gorilla there).
    expect(ofType(events, 'hit').some((e) => e.attackerId === 1 && e.targetId === 2)).toBe(true);
    expect(ofType(events, 'hit').some((e) => e.targetId === 0)).toBe(false);
    expect(eagle.state.hp).toBe(hp0);
  });

  it('a soaring eagle flies over a pickup pad without collecting it', () => {
    const { world, events } = liveWorld(['eagle', 'lion'], 11);
    place(world, 1, -22, 12);
    place(world, 0, 0, -18);
    flyFor(world, 2.2);
    expect(world.fighters[0].state.pos.y).toBeGreaterThan(MOVE.groundHitMaxAltitude);
    const pad = world.snapshot().pickups.find((p) => p.active)!;
    events.length = 0;
    for (let i = 0; i < 10; i++) {
      holdOver(world, pad.pos.x, pad.pos.z);
      world.setIntent(0, { ...neutral(), jump: true });
      world.step(DT);
    }
    expect(ofType(events, 'pickup')).toHaveLength(0);
    expect(world.snapshot().pickups.find((p) => p.id === pad.id)!.active).toBe(true);
  });
});

describe('eagle soar — landing slam (§3.1)', () => {
  it('landing after a high flight slams nearby grounded foes, emits landingImpact, then a short recovery', () => {
    const { world, events } = eagleWorld(['lion', 'gorilla']);
    flyFor(world, 2.6);
    const eagle = world.fighters[0];
    // Pin the eagle over the landing point; lion 2 m away (inside 3.2 m), gorilla 6 m away.
    holdOver(world, 0, -18);
    place(world, 1, 2, -18);
    place(world, 2, -6, -18);
    const peakAlt = eagle.state.pos.y;
    expect(peakAlt).toBeGreaterThan(SOAR.landMinHeight);
    const lionHp = world.fighters[1].state.hp;
    const gorHp = world.fighters[2].state.hp;
    events.length = 0;
    // Release Space → controlled descent → touchdown.
    let landedTick = -1;
    for (let i = 0; i < Math.round(2 / DT) && landedTick < 0; i++) {
      world.setIntent(0, neutral());
      world.step(DT);
      if (ofType(events, 'landingImpact').length > 0) landedTick = i;
    }
    expect(landedTick).toBeGreaterThan(0);
    const imp = ofType(events, 'landingImpact');
    expect(imp).toHaveLength(1);
    const e = imp[0];
    expect(e.fighterId).toBe(0);
    expect(e.radius).toBe(SOAR.landRadius);
    expect(e.height).toBeCloseTo(peakAlt, 1);
    const expected = Math.min(SOAR.landDamageCap, SOAR.landDamageBase + SOAR.landDamagePerMetre * peakAlt);
    expect(e.damage).toBe(Math.round(expected));
    expect(e.damage).toBe(Math.round(landingDamage(eagle, e.height)));
    expect(e.pos.y).toBe(0);
    // Clearly weaker than Gale Burst (45) and Death From Above (240) per use.
    expect(e.damage).toBeLessThan(EAGLE.special.damage!);
    // Lion hit for the slam damage + knocked back; gorilla untouched.
    const slamHit = ofType(events, 'hit').find((h) => h.attackerId === 0 && h.targetId === 1)!;
    expect(slamHit).toBeDefined();
    expect(slamHit.damage).toBe(Math.round(expected));
    expect(world.fighters[1].state.hp).toBeCloseTo(lionHp - expected, 6);
    expect(world.fighters[2].state.hp).toBe(gorHp);
    expect(world.fighters[1].knockTimer).toBeGreaterThan(0);
    // Landing recovery: pressing attack does nothing for ~0.4 s.
    expect(eagle.landRecoverT).toBeGreaterThan(0);
    world.setIntent(0, { ...neutral(), attack: true });
    world.step(DT);
    expect(eagle.swinging).toBe(false);
    for (let i = 0; i < Math.round(SOAR.landRecovery / DT); i++) {
      world.setIntent(0, neutral());
      world.step(DT);
    }
    expect(eagle.landRecoverT).toBe(0);
    world.setIntent(0, { ...neutral(), attack: true, aimYaw: Math.PI / 2 });
    world.step(DT);
    expect(eagle.swinging).toBe(true);
  });

  it('a low flight (released before the slam height) lands without a slam', () => {
    const { world, events } = eagleWorld();
    flyFor(world, 0.5); // jump + short glide, well below 3 m
    expect(world.fighters[0].state.pos.y).toBeLessThan(SOAR.landMinHeight);
    for (let i = 0; i < Math.round(1.5 / DT); i++) {
      world.setIntent(0, neutral());
      world.step(DT);
    }
    expect(world.fighters[0].state.airborne).toBe(false);
    expect(ofType(events, 'landingImpact')).toHaveLength(0);
  });

  it('the flight cooldown starts on touchdown', () => {
    const { world } = eagleWorld();
    flyFor(world, 2.0);
    // Release and fall.
    let landed = -1;
    for (let i = 0; i < Math.round(2 / DT); i++) {
      world.setIntent(0, neutral());
      world.step(DT);
      if (landed < 0 && !world.fighters[0].state.airborne) landed = i;
    }
    expect(landed).toBeGreaterThan(0);
    const eagle = world.fighters[0];
    // 2 s − (landing time) of cooldown already elapsed; well short of 6.5 s: re-jump cannot glide.
    expect(eagle.glideCd).toBeGreaterThan(GLIDE.cooldown - 2.1);
    const tryFly = (): number => {
      let maxGlide = 0;
      for (let i = 0; i < Math.round(0.8 / DT); i++) {
        world.setIntent(0, { ...neutral(), jump: true });
        world.step(DT);
        maxGlide = Math.max(maxGlide, eagle.state.glideT);
      }
      for (let i = 0; i < Math.round(1 / DT); i++) {
        world.setIntent(0, neutral());
        world.step(DT);
      }
      return maxGlide;
    };
    expect(tryFly()).toBe(0);
    // Wait the cooldown out, then it flies again.
    for (let i = 0; i < Math.round(GLIDE.cooldown / DT); i++) {
      world.setIntent(0, neutral());
      world.step(DT);
    }
    expect(eagle.glideCd).toBe(0);
    expect(tryFly()).toBeGreaterThan(0);
  });

  it('slam numbers stay modest: 20 + 3/m capped at 40 (always < Gale Burst 45, ≪ DFA 240)', () => {
    const eagleF = liveWorld(['eagle', 'lion']).world.fighters[0];
    expect(landingDamage(eagleF, SOAR.landMinHeight)).toBeCloseTo(29, 6);
    expect(landingDamage(eagleF, SOAR.maxHeight)).toBeCloseTo(39.5, 6);
    expect(landingDamage(eagleF, 50)).toBe(SOAR.landDamageCap);
    expect(SOAR.landDamageCap).toBeLessThan(EAGLE.special.damage!);
    expect(SOAR.landDamageCap).toBeLessThan(EAGLE.ultimate.damage!);
  });
});
