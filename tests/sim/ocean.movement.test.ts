/**
 * v1.9 elevations in the sim (docs/OCEAN-PLAN.md): the cliff / step rule in MovementSystem. A grounded fighter cannot step up more than
 * 0.6 m (it is blocked and slides along the cliff like along an obstacle), ramps are climbed at full speed, a jump clears a step no
 * higher than its apex, walking off an edge drops you, and knockback / charges / leaps / burrows stop at a cliff instead of
 * teleporting up it. Custom bare arenas (no cover) isolate the rule; the Ocean Dome itself is exercised through a real World.
 */

import { describe, it, expect } from 'vitest';
import type { ArenaDef, ElevationPiece } from '../../src/config/arenas';
import { OCEAN_ARENA, arenaGroundHeight, staticObstaclesOf } from '../../src/config/arenas';
import { ANIMALS } from '../../src/config/animals';
import { Fighter } from '../../src/sim/Fighter';
import { chargeStep, locomote, pushOutOfCliffs, resolveFighterCollisions } from '../../src/sim/MovementSystem';
import { applyDirectionalKnockback } from '../../src/sim/StatusEffects';
import { altitudeOf } from '../../src/sim/hitbox';
import { createPickups, updatePickups } from '../../src/sim/PickupSystem';
import { mulberry32 } from '../../src/core/math';
import type { AnimalId, FighterIntent, GameEvent, PickupState } from '../../src/core/types';
import { DT, liveWorld, makeSim, neutral } from './helpers';

/** A bare test arena (no cover, no pads in the way) with the given elevation pieces. */
function bare(pieces: readonly ElevationPiece[]): ArenaDef {
  return { ...OCEAN_ARENA, solids: [], circles: [], segments: [], crates: [], heightfield: pieces };
}

function rig(arena: ArenaDef, animal: AnimalId, x: number, z: number, yaw = Math.PI / 2) {
  const y = arenaGroundHeight(arena, x, z);
  const f = new Fighter(0, animal, ANIMALS[animal], true, { x, y, z }, yaw, arena);
  const sim = makeSim([f], [], staticObstaclesOf(arena));
  (sim as { arena: ArenaDef }).arena = arena;
  return { f, sim };
}

function tick(sim: ReturnType<typeof makeSim>, f: Fighter, intent: Partial<FighterIntent> = {}): void {
  f.setIntent({ ...neutral(), ...intent });
  f.computeEdges();
  locomote(sim, f, DT);
}

/** A 1.5 m terrace disc (radius 10) at the origin. */
const TERRACE = bare([{ kind: 'plateau', x: 0, z: 0, radius: 10, height: 1.5 }]);
/** A ramp up the +x direction (x -3 .. 3, 0 -> 1.5) onto a flat plateau (x 3 .. 15). */
const RAMP_ARENA = bare([
  { kind: 'ramp', x: 0, z: 0, dirDeg: 0, length: 6, width: 6, h0: 0, h1: 1.5 },
  { kind: 'plateau', x: 9, z: 0, radius: 6, height: 1.5 },
]);

describe('cliff rule: a grounded fighter is blocked at a cliff and slides along it', () => {
  it('running straight at a 1.5 m cliff stops at the body radius; the feet stay on the ground', () => {
    for (const animal of ['lion', 'hippo', 'mole', 'giraffe'] as const) {
      const { f, sim } = rig(TERRACE, animal, -16, 0);
      const r = f.def.radius;
      for (let i = 0; i < 240; i++) {
        tick(sim, f, { moveX: 1 });
        expect(f.state.pos.y).toBe(0);
        expect(Math.hypot(f.state.pos.x, f.state.pos.z)).toBeGreaterThanOrEqual(10 + r - 1e-6);
      }
      expect(f.state.pos.x).toBeCloseTo(-(10 + r), 4);
      expect(f.state.airborne).toBe(false);
    }
  });

  it('running diagonally into the cliff keeps the tangential component (slides) and never penetrates', () => {
    const { f, sim } = rig(TERRACE, 'lion', -14, -1);
    const r = f.def.radius;
    let z0 = f.state.pos.z;
    for (let i = 0; i < 120; i++) {
      tick(sim, f, { moveX: 0.7071, moveZ: 0.7071 });
      expect(Math.hypot(f.state.pos.x, f.state.pos.z)).toBeGreaterThanOrEqual(10 + r - 1e-6);
      expect(f.state.pos.y).toBe(0);
    }
    expect(f.state.pos.z - z0).toBeGreaterThan(4); // it slid sideways along the rim
    z0 = f.state.pos.z;
    expect(Math.hypot(f.state.pos.x, f.state.pos.z)).toBeLessThan(10 + r + 0.8); // ... hugging the cliff
  });

  it('the same input is deterministic and identical on a repeat run', () => {
    const run = (): [number, number][] => {
      const { f, sim } = rig(TERRACE, 'rhino', -13, 3);
      const out: [number, number][] = [];
      for (let i = 0; i < 90; i++) {
        tick(sim, f, { moveX: 0.9, moveZ: -0.3 });
        out.push([f.state.pos.x, f.state.pos.z]);
      }
      return out;
    };
    expect(run()).toEqual(run());
  });

  it('a low step (<= 0.6 m) is simply walked up; a 0.7 m step blocks', () => {
    const low = bare([{ kind: 'plateau', x: 0, z: 0, radius: 10, height: 0.6 }]);
    const high = bare([{ kind: 'plateau', x: 0, z: 0, radius: 10, height: 0.7 }]);
    {
      const { f, sim } = rig(low, 'lion', -16, 0);
      for (let i = 0; i < 180; i++) tick(sim, f, { moveX: 1 });
      expect(f.state.pos.x).toBeGreaterThan(-5);
      expect(f.state.pos.y).toBeCloseTo(0.6, 9);
      expect(altitudeOf(f)).toBeCloseTo(0, 9);
    }
    {
      const { f, sim } = rig(high, 'lion', -16, 0);
      for (let i = 0; i < 180; i++) tick(sim, f, { moveX: 1 });
      expect(f.state.pos.x).toBeCloseTo(-(10 + f.def.radius), 4);
      expect(f.state.pos.y).toBe(0);
    }
  });
});

describe('ramps: climbed at full speed, no airborne flicker, the feet follow the ground', () => {
  it('walking up a ramp onto the plateau: grounded every tick, y = ground height every tick, speed untouched', () => {
    const flat = bare([]);
    for (const animal of ['lion', 'hippo', 'giraffe', 'mole'] as const) {
      const a = rig(RAMP_ARENA, animal, -8, 0);
      const b = rig(flat, animal, -8, 0);
      for (let i = 0; i < 150; i++) {
        tick(a.sim, a.f, { moveX: 1 });
        tick(b.sim, b.f, { moveX: 1 });
        expect(a.f.state.airborne, `${animal} tick ${i}`).toBe(false);
        expect(a.f.state.pos.y).toBeCloseTo(arenaGroundHeight(RAMP_ARENA, a.f.state.pos.x, a.f.state.pos.z), 9);
        expect(a.f.state.pos.x).toBe(b.f.state.pos.x); // exactly the flat-ground distance: ramps do not slow anyone
      }
      expect(a.f.state.pos.y).toBeCloseTo(1.5, 9);
      expect(a.f.state.pos.x).toBeGreaterThan(3);
    }
  });

  it('walking down the ramp stays grounded (no fall, no jump pose) and ends at 0', () => {
    for (const animal of ['lion', 'rhino', 'panther'] as const) {
      const { f, sim } = rig(RAMP_ARENA, animal, 8, 0, -Math.PI / 2);
      for (let i = 0; i < 150; i++) {
        tick(sim, f, { moveX: -1 });
        expect(f.state.airborne, `${animal} tick ${i}`).toBe(false);
        expect(f.state.pos.y).toBeCloseTo(arenaGroundHeight(RAMP_ARENA, f.state.pos.x, f.state.pos.z), 9);
      }
      expect(f.state.pos.x).toBeLessThan(-3);
      expect(f.state.pos.y).toBe(0);
    }
  });

  it('the largest body (r 1.2) climbs the real Ocean ramps at every angle without being pushed back', () => {
    const ramps = (OCEAN_ARENA.heightfield as readonly ElevationPiece[]).filter((p) => p.kind === 'ramp') as Extract<ElevationPiece, { kind: 'ramp' }>[];
    expect(ramps.length).toBe(9);
    for (const rp of ramps) {
      const a = (rp.dirDeg * Math.PI) / 180;
      const c = Math.cos(a);
      const s = Math.sin(a);
      // start 4 m before the low end on the lower level, walk along the ramp axis
      const sx = rp.x - c * (rp.length / 2 + 4);
      const sz = rp.z - s * (rp.length / 2 + 4);
      const { f, sim } = rig(OCEAN_ARENA, 'hippo', sx, sz, Math.atan2(c, s));
      let maxBack = 0;
      let prevAlong = (f.state.pos.x - rp.x) * c + (f.state.pos.z - rp.z) * s;
      for (let i = 0; i < 200; i++) {
        tick(sim, f, { moveX: c, moveZ: s });
        const along = (f.state.pos.x - rp.x) * c + (f.state.pos.z - rp.z) * s;
        maxBack = Math.max(maxBack, prevAlong - along);
        prevAlong = along;
        expect(f.state.airborne).toBe(false);
      }
      expect(maxBack).toBeLessThan(1e-6);
      expect(f.state.pos.y).toBeGreaterThanOrEqual(rp.h1 - 1e-6);
    }
  });
});

describe('drops and jumps', () => {
  it('walking off a ledge drops the fighter with gravity: airborne on the way, landed at 0', () => {
    const { f, sim } = rig(TERRACE, 'lion', 8, 0, Math.PI / 2);
    let sawAir = false;
    for (let i = 0; i < 120; i++) {
      tick(sim, f, { moveX: 1 });
      if (f.state.airborne) sawAir = true;
    }
    expect(sawAir).toBe(true);
    expect(f.state.airborne).toBe(false);
    expect(f.state.pos.y).toBe(0);
    expect(f.state.pos.x).toBeGreaterThan(10);
  });

  it('walking off a ledge does not shove the body: no tick moves it farther than its run speed allows, even while it falls along the wall', () => {
    for (const animal of ['lion', 'hippo', 'giraffe'] as const) {
      const { f, sim } = rig(TERRACE, animal, 8, 0, Math.PI / 2);
      let prev = f.state.pos.x;
      let worst = 0;
      for (let i = 0; i < 90; i++) {
        tick(sim, f, { moveX: 1 });
        worst = Math.max(worst, f.state.pos.x - prev);
        prev = f.state.pos.x;
      }
      expect(worst).toBeLessThanOrEqual(f.def.speed * DT + 1e-9);
      expect(f.state.pos.y).toBe(0);
      // ... and a fighter that steps off and stops is only eased clear of the wall once it LANDS
      const g = rig(TERRACE, animal, 9.9, 0, Math.PI / 2);
      for (let i = 0; i < 60; i++) tick(sim, g.f, { moveX: i < 4 ? 1 : 0 });
      expect(Math.hypot(g.f.state.pos.x, g.f.state.pos.z)).toBeGreaterThanOrEqual(10 + g.f.def.radius - 1e-6);
      expect(g.f.state.pos.y).toBe(0);
    }
  });

  it('a jump (apex ~1.2 m) lands on a 0.9 m step but cannot climb a 1.5 m terrace', () => {
    const step09 = bare([{ kind: 'plateau', x: 0, z: 0, radius: 10, height: 0.9 }]);
    {
      const { f, sim } = rig(step09, 'lion', -12.6, 0); // jump 1.9 m before the cliff line: the apex is over the rim
      for (let i = 0; i < 150; i++) tick(sim, f, { moveX: 1, jump: true });
      expect(f.state.pos.x).toBeGreaterThan(-8);
      expect(f.state.pos.y).toBeCloseTo(0.9, 9);
    }
    {
      const { f, sim } = rig(TERRACE, 'lion', -12.6, 0);
      for (let i = 0; i < 150; i++) tick(sim, f, { moveX: 1, jump: true });
      expect(f.state.pos.x).toBeLessThan(-10.5);
      expect(f.state.pos.y).toBe(0);
    }
  });

  it('jumping while climbing a ramp neither pushes the fighter back nor drops it', () => {
    const { f, sim } = rig(RAMP_ARENA, 'hippo', -6, 0);
    let prev = f.state.pos.x;
    for (let i = 0; i < 120; i++) {
      tick(sim, f, { moveX: 1, jump: i % 40 < 20 });
      expect(f.state.pos.x).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = f.state.pos.x;
    }
    expect(f.state.pos.y).toBeCloseTo(1.5, 9);
  });
});

describe('forced movement stops at a cliff instead of teleporting up it', () => {
  it('knockback into a cliff', () => {
    const { f, sim } = rig(TERRACE, 'lion', -12.5, 0);
    applyDirectionalKnockback(f, 1, 0, 9);
    for (let i = 0; i < 60; i++) tick(sim, f);
    expect(f.state.pos.x).toBeCloseTo(-(10 + f.def.radius), 3);
    expect(f.state.pos.y).toBe(0);
  });

  it('knockback along a ramp-less cliff at an angle slides (keeps the tangential part)', () => {
    const { f, sim } = rig(TERRACE, 'lion', -12, 0);
    applyDirectionalKnockback(f, 0.8, 0.6, 9);
    for (let i = 0; i < 60; i++) tick(sim, f);
    expect(f.state.pos.z).toBeGreaterThan(2);
    expect(Math.hypot(f.state.pos.x, f.state.pos.z)).toBeGreaterThanOrEqual(10 + f.def.radius - 1e-6);
    expect(f.state.pos.y).toBe(0);
  });

  it('a charge (chargeStep) runs into the cliff and reports stopped', () => {
    const { f, sim } = rig(TERRACE, 'rhino', -16, 0);
    let stoppedAt = -1;
    for (let i = 0; i < 100; i++) {
      const r = chargeStep(sim, f, 0.3, false);
      if (r.stopped) {
        stoppedAt = i;
        break;
      }
    }
    expect(stoppedAt).toBeGreaterThan(0);
    expect(f.state.pos.x).toBeLessThanOrEqual(-(10 + f.def.radius) + 1e-4);
    expect(f.state.pos.y).toBe(0);
  });

  it('a charge UP a ramp is not stopped, and its feet follow the ramp', () => {
    const { f, sim } = rig(RAMP_ARENA, 'rhino', -8, 0);
    for (let i = 0; i < 40; i++) {
      const r = chargeStep(sim, f, 0.3, false);
      expect(r.stopped).toBe(false);
      expect(f.state.pos.y).toBeCloseTo(arenaGroundHeight(RAMP_ARENA, f.state.pos.x, f.state.pos.z), 9);
    }
    expect(f.state.pos.y).toBeCloseTo(1.5, 9);
  });

  it('a charge off a ledge keeps going; the feet come down at <= 0.3 m per tick', () => {
    const { f, sim } = rig(TERRACE, 'rhino', 8, 0);
    let last = f.state.pos.y;
    for (let i = 0; i < 30; i++) {
      const r = chargeStep(sim, f, 0.3, false);
      expect(r.stopped).toBe(false);
      expect(last - f.state.pos.y).toBeLessThanOrEqual(0.3 + 1e-9);
      last = f.state.pos.y;
    }
    expect(f.state.pos.y).toBe(0);
  });

  it('pushOutOfCliffs moves a fighter that was shoved into the cliff (fighter push-out / carry) back out, a clear one not at all', () => {
    const { f } = rig(TERRACE, 'gorilla', -10.2, 0);
    f.state.pos.y = 0;
    expect(pushOutOfCliffs(TERRACE, f)).toBe(true);
    expect(f.state.pos.x).toBeCloseTo(-(10 + f.def.radius), 6);
    const g = rig(TERRACE, 'gorilla', -20, 0).f;
    expect(pushOutOfCliffs(TERRACE, g)).toBe(false);
    // flat arenas never push
    const flat = rig(bare([]), 'gorilla', -0.5, 0).f;
    expect(pushOutOfCliffs(bare([]), flat)).toBe(false);
  });

  it('soft fighter-fighter push-out cannot squeeze a body into the cliff', () => {
    const a = rig(TERRACE, 'rhino', -(10 + 1.0) - 0.01, 0).f; // pressed against the cliff
    const bFighter = new Fighter(1, 'rhino', ANIMALS.rhino, false, { x: -(10 + 1.0) - 1.1, y: 0, z: 0 }, 0, TERRACE);
    const sim = makeSim([a, bFighter], [], []);
    (sim as { arena: ArenaDef }).arena = TERRACE;
    for (let i = 0; i < 30; i++) resolveFighterCollisions(sim);
    expect(Math.hypot(a.state.pos.x, a.state.pos.z)).toBeGreaterThanOrEqual(10 + a.def.radius - 1e-6);
    expect(Math.hypot(bFighter.state.pos.x, bFighter.state.pos.z)).toBeGreaterThanOrEqual(10 + bFighter.def.radius - 1e-6);
  });
});

describe('the Ocean Dome in a real World', () => {
  const TEN: AnimalId[] = ['lion', 'gorilla', 'crocodile', 'hippo', 'rhino', 'eagle', 'panther', 'python', 'giraffe', 'mole'];

  it('heights reach the snapshot: spawn y = 0, pickups / crates / fighters on each level report their ground height', () => {
    const { world } = liveWorld(TEN, 5, [], { arena: 'ocean' });
    const snap = world.snapshot();
    for (const f of snap.fighters) expect(f.pos.y).toBe(0);
    expect(snap.pickups.map((p) => p.pos.y)).toEqual(OCEAN_ARENA.pickupPads.map((p) => arenaGroundHeight(OCEAN_ARENA, p.x, p.z)));
    expect(new Set(snap.pickups.map((p) => p.pos.y))).toEqual(new Set([0, 1.5, 3]));
    expect(snap.crates.map((c) => c.pos.y)).toEqual(OCEAN_ARENA.crates.map((c) => c.baseY));
    expect(new Set(snap.crates.map((c) => c.pos.y))).toEqual(new Set([0, 1.5]));
    // put three fighters on the three levels (away from any cover) and step: their y follows the ground
    const spots: [number, number, number][] = [
      [-15, 0, 1.5],
      [0, 0.2, 3],
      [-26, 0, 0],
    ];
    spots.forEach(([x, z, h], i) => {
      world.fighters[i].state.pos.x = x;
      world.fighters[i].state.pos.z = z;
      world.fighters[i].state.pos.y = h; // (a grounded fighter dropped onto higher ground at lower feet would be pushed back out: the cliff rule)
      world.fighters[i].state.vel.x = 0;
      world.fighters[i].state.vel.z = 0;
    });
    for (let i = 0; i < 40; i++) world.step(DT);
    const after = world.snapshot();
    spots.forEach(([, , h], i) => expect(after.fighters[i].pos.y).toBeCloseTo(h, 9));
    // altitude on raised ground is relative to the ground, not to 0
    expect(altitudeOf(world.fighters[0])).toBeCloseTo(0, 9);
    expect(altitudeOf(world.fighters[1])).toBeCloseTo(0, 9);
  });

  it('pickups: a pad on a raised level triggers for a fighter on that level, not for one at another height', () => {
    const rng = mulberry32(3);
    const pickups = createPickups(rng, OCEAN_ARENA);
    const hi = pickups.find((p) => p.pos.y === 3) as PickupState;
    expect(hi.pos).toEqual({ x: 0, y: 3, z: 0 });
    const f = new Fighter(0, 'lion', ANIMALS.lion, true, { x: 0, y: 0, z: 0 }, 0, OCEAN_ARENA);
    const events: GameEvent[] = [];
    const sim = makeSim([f], events, staticObstaclesOf(OCEAN_ARENA));
    (sim as { arena: ArenaDef }).arena = OCEAN_ARENA;
    updatePickups(sim, pickups, DT); // standing at the pad's x,z but at y = 0 (3 m below it): nothing
    expect(events.filter((e) => e.type === 'pickup')).toHaveLength(0);
    expect(hi.active).toBe(true);
    f.state.pos.y = 3; // ... on the plateau: collected
    updatePickups(sim, pickups, DT);
    expect(events.filter((e) => e.type === 'pickup')).toHaveLength(1);
    expect(hi.active).toBe(false);
  });

  it('a lion leap toward the terrace stops at the foot of the cliff (no climbing by leap)', () => {
    const { world } = liveWorld(['lion', 'lion'], 9, [], { arena: 'ocean' });
    const f = world.fighters[0];
    f.state.pos.x = -22;
    f.state.pos.z = 0;
    f.state.pos.y = 0;
    f.state.yaw = Math.PI / 2;
    world.fighters[1].state.pos.x = 20; // far away on the other side
    world.fighters[1].state.pos.z = 20;
    const intent = { ...neutral(), aimYaw: Math.PI / 2 };
    world.setIntent(0, { ...intent, special: true });
    world.step(DT);
    world.setIntent(0, intent);
    for (let i = 0; i < 120; i++) world.step(DT);
    expect(f.state.pos.x).toBeLessThanOrEqual(-(19 + f.def.radius) + 0.05);
    expect(f.state.pos.x).toBeGreaterThan(-22); // it did leap forward
    expect(f.state.pos.y).toBe(0);
  });

  it('the eagle soars onto the terrace and the plateau (fliers ignore cliffs); landing sits on that level', () => {
    const { world } = liveWorld(['eagle', 'lion'], 3, [], { arena: 'ocean' });
    const f = world.fighters[0];
    f.state.pos.x = -26;
    f.state.pos.z = 0;
    f.state.pos.y = 0;
    world.fighters[1].state.pos.x = 20;
    world.fighters[1].state.pos.z = 20;
    let maxY = 0;
    // jump + hold jump to glide, flying toward the centre
    for (let i = 0; i < 150; i++) {
      world.setIntent(0, { ...neutral(), moveX: 1, jump: true, aimYaw: Math.PI / 2 });
      world.step(DT);
      maxY = Math.max(maxY, f.state.pos.y);
    }
    expect(f.state.pos.x).toBeGreaterThan(-19 + 0.5); // crossed the terrace rim
    expect(maxY).toBeGreaterThan(1.5);
    // release and land: grounded on a raised level, standing on it
    for (let i = 0; i < 240; i++) {
      world.setIntent(0, { ...neutral() });
      world.step(DT);
    }
    expect(f.state.airborne).toBe(false);
    expect(f.state.pos.y).toBeCloseTo(arenaGroundHeight(OCEAN_ARENA, f.state.pos.x, f.state.pos.z), 6);
    expect(f.state.pos.y).toBeGreaterThanOrEqual(1.5 - 1e-9);
    expect(altitudeOf(f)).toBeCloseTo(0, 6);
  });
});
