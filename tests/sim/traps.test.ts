/**
 * v1.2 arena traps (UPGRADE-PLAN-v1.2 §3.2 / §3.3): seeded placement validity
 * and determinism, ground-only triggering, the triggerer is hurt at once, an
 * exactly-8 s active window, unblockable true damage, airborne / burrowed
 * immunity, expiry + re-arm, killerId −1 deaths and snapshot fidelity.
 */
import { describe, it, expect } from 'vitest';
import { World } from '../../src/sim/World';
import { EventBus } from '../../src/core/EventBus';
import { makeTrap, placeTraps, obstacleSurfaceDist } from '../../src/sim/TrapSystem';
import {
  TRAP_COUNT_BY_DIFFICULTY,
  TRAP_ACTIVE_SECONDS,
  TRAP_REARM_SECONDS,
  TRAP_KINDS,
  TRAP_MAX_RADIUS,
  TRAP_PLACEMENT,
} from '../../src/config/traps';
import { PILLARS, DAIS, PICKUP_PADS } from '../../src/config/arena';
import { MATCH, PICKUPS } from '../../src/config/balance';
import type { AnimalId, Difficulty, FighterIntent, GameEvent, GameEventOf, MatchConfig, TrapKind } from '../../src/core/types';
import { ANIMAL_IDS } from '../../src/config/animals';
import { DT, liveWorld, neutral, disablePickups } from './helpers';

function spawnsFor(n: number): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((270 + (360 / n) * i) * Math.PI) / 180;
    out.push({ x: MATCH.spawnRing * Math.cos(a), z: MATCH.spawnRing * Math.sin(a) });
  }
  return out;
}

function ofType<T extends GameEvent['type']>(events: GameEvent[], type: T): GameEventOf<T>[] {
  return events.filter((e): e is GameEventOf<T> => e.type === type);
}

/** 2-fighter live world (no seeded traps) with one hand-placed trap at (10, 0). */
function trapWorld(kind: TrapKind, a0: AnimalId = 'gorilla', a1: AnimalId = 'lion') {
  const { world, events } = liveWorld([a0, a1], 7);
  disablePickups(world);
  world.traps.push(makeTrap(0, kind, 10, 0, world.fighters.length));
  // Park fighter 1 far away.
  const f1 = world.fighters[1].state;
  f1.pos.x = -20;
  f1.pos.z = 0;
  return { world, events };
}

function place(world: World, id: number, x: number, z: number, y = 0): void {
  const s = world.fighters[id].state;
  s.pos.x = x;
  s.pos.z = z;
  s.pos.y = y;
  s.vel.x = 0;
  s.vel.y = 0;
  s.vel.z = 0;
  s.airborne = y > 0;
}

function run(world: World, seconds: number, intents: Record<number, FighterIntent> = {}): void {
  const ticks = Math.round(seconds / DT);
  for (let t = 0; t < ticks; t++) {
    for (const [id, it] of Object.entries(intents)) world.setIntent(Number(id), it);
    world.step(DT);
  }
}

describe('trap placement (seeded, §3.2)', () => {
  const spawns = spawnsFor(10);

  it('places the difficulty count, deterministically, honouring every clearance over 200 seeds', () => {
    const P = TRAP_PLACEMENT;
    const R = TRAP_MAX_RADIUS;
    for (const d of [1, 2, 3, 4] as Difficulty[]) {
      let fire = 0;
      let spikes = 0;
      for (let seed = 1; seed <= 200; seed++) {
        const a = placeTraps(seed * 7919 + d, d, spawns, 10);
        const b = placeTraps(seed * 7919 + d, d, spawns, 10);
        expect(a.length).toBe(TRAP_COUNT_BY_DIFFICULTY[d]);
        expect(a.map((t) => [t.kind, t.pos.x, t.pos.z])).toEqual(b.map((t) => [t.kind, t.pos.x, t.pos.z]));
        const kinds = new Set(a.map((t) => t.kind));
        if (a.length >= 2) expect(kinds.size).toBe(2); // both kinds appear
        for (let i = 0; i < a.length; i++) {
          const t = a[i];
          if (t.kind === 'fire') fire++;
          else spikes++;
          expect(t.phase).toBe('armed');
          expect(t.radius).toBe(TRAP_KINDS[t.kind].radius);
          const r = Math.hypot(t.pos.x, t.pos.z);
          expect(r).toBeGreaterThanOrEqual(P.minRadius - 1e-6);
          expect(r).toBeLessThanOrEqual(P.maxRadius + 1e-6);
          // Independent re-checks: pillars, dais, pads, spawns, other traps.
          for (const p of PILLARS) expect(Math.hypot(t.pos.x - p.x, t.pos.z - p.z) - p.radius - R).toBeGreaterThanOrEqual(P.obstacleClear - 1e-6);
          expect(Math.hypot(t.pos.x - DAIS.x, t.pos.z - DAIS.z) - DAIS.radius - R).toBeGreaterThanOrEqual(P.obstacleClear - 1e-6);
          expect(obstacleSurfaceDist(t.pos.x, t.pos.z) - R).toBeGreaterThanOrEqual(P.obstacleClear - 1e-6); // + columns & crates
          for (const pad of PICKUP_PADS) {
            expect(Math.hypot(t.pos.x - pad.x, t.pos.z - pad.z) - PICKUPS.radius - R).toBeGreaterThanOrEqual(P.pickupClear - 1e-6);
          }
          for (const s of spawns) expect(Math.hypot(t.pos.x - s.x, t.pos.z - s.z) - R).toBeGreaterThanOrEqual(P.spawnClear - 1e-6);
          for (let j = 0; j < i; j++) {
            expect(Math.hypot(t.pos.x - a[j].pos.x, t.pos.z - a[j].pos.z) - 2 * R).toBeGreaterThanOrEqual(P.trapClear - 1e-6);
          }
        }
      }
      expect(fire).toBeGreaterThan(0);
      expect(spikes).toBeGreaterThan(0);
    }
  });

  it('World places the seeded layout for its difficulty without perturbing the sim RNG', () => {
    const roster = ANIMAL_IDS.map((a) => ({ animal: a, isPlayer: false }));
    for (const d of [1, 4] as Difficulty[]) {
      const cfg: MatchConfig = { roster, difficulty: d };
      const withTraps = new World(cfg, 1234, new EventBus());
      const without = new World(cfg, 1234, new EventBus(), { traps: false });
      const snap = withTraps.snapshot();
      expect(snap.traps.length).toBe(TRAP_COUNT_BY_DIFFICULTY[d]);
      expect(without.snapshot().traps).toEqual([]);
      const expected = placeTraps(1234, d, spawnsFor(10), 10);
      expect(snap.traps.map((t) => [t.id, t.kind, t.pos.x, t.pos.z])).toEqual(expected.map((t) => [t.id, t.kind, t.pos.x, t.pos.z]));
      // Pickup kinds come from the sim RNG: identical with or without traps.
      expect(snap.pickups.map((p) => p.kind)).toEqual(without.snapshot().pickups.map((p) => p.kind));
      expect(withTraps.rng()).toBe(without.rng());
    }
  });
});

describe('trap rules (§3.2)', () => {
  it('only a grounded fighter triggers a plate; jumping over does not', () => {
    const { world, events } = trapWorld('spikes');
    place(world, 0, 10, 0, 2.0); // above the plate, falling
    world.step(DT);
    expect(world.traps[0].phase).toBe('armed');
    expect(ofType(events, 'trapTriggered')).toHaveLength(0);
    run(world, 0.6); // lands on it
    const trig = ofType(events, 'trapTriggered');
    expect(trig).toHaveLength(1);
    expect(trig[0].fighterId).toBe(0);
    expect(trig[0].kind).toBe('spikes');
    expect(world.traps[0].phase).toBe('active');
    expect(world.traps[0].triggeredBy).toBe(0);
  });

  it('the triggerer takes damage the tick it triggers the trap (not exempt)', () => {
    for (const kind of ['fire', 'spikes'] as TrapKind[]) {
      const { world, events } = trapWorld(kind);
      place(world, 0, 10, 0);
      const hp0 = world.fighters[0].state.hp;
      world.step(DT);
      expect(ofType(events, 'trapTriggered')).toHaveLength(1);
      const dmg = ofType(events, 'trapDamage');
      expect(dmg).toHaveLength(1);
      expect(dmg[0].targetId).toBe(0);
      expect(dmg[0].damage).toBe(TRAP_KINDS[kind].pulseDamage);
      expect(world.fighters[0].state.hp).toBeCloseTo(hp0 - TRAP_KINDS[kind].pulseDamage, 6);
    }
  });

  it('stays active for exactly 8 s, hurting everyone inside, then expires and re-arms after 20 s', () => {
    const { world, events } = trapWorld('fire', 'gorilla', 'rhino');
    place(world, 0, 9, 0);
    place(world, 1, 11, 0); // a second fighter inside the 2 m pit
    const hp1 = world.fighters[1].state.hp;
    world.step(DT);
    let ticks = 1;
    while (world.traps[0].phase === 'active' && ticks < 2000) {
      world.step(DT);
      ticks++;
    }
    // Trigger tick + 479 active ticks, expiry on tick 481 (exactly 8.0 s after the trigger).
    expect((ticks - 1) * DT).toBeCloseTo(TRAP_ACTIVE_SECONDS, 6);
    expect(ofType(events, 'trapExpired')).toHaveLength(1);
    expect(world.traps[0].phase).toBe('cooldown');
    expect(world.traps[0].timeLeft).toBeCloseTo(TRAP_REARM_SECONDS, 6);
    // Both fighters burned for the whole window: 16 pulses (one per 0.5 s) each.
    const pulses = TRAP_ACTIVE_SECONDS / TRAP_KINDS.fire.pulseInterval;
    expect(hp1 - world.fighters[1].state.hp).toBeCloseTo(pulses * TRAP_KINDS.fire.pulseDamage, 6);
    expect(ofType(events, 'trapDamage').filter((e) => e.targetId === 0)).toHaveLength(pulses);
    // Standing on the spent plate does nothing during the cooldown …
    const hpMid = world.fighters[0].state.hp;
    run(world, TRAP_REARM_SECONDS - 0.5);
    expect(world.fighters[0].state.hp).toBe(hpMid);
    expect(world.traps[0].phase).toBe('cooldown');
    // … then it re-arms and (someone still standing on it) triggers again.
    run(world, 0.6);
    expect(ofType(events, 'trapTriggered')).toHaveLength(2);
    expect(world.traps[0].phase).toBe('active');
  });

  it('snapshot phase/timeLeft track the active window', () => {
    const { world } = trapWorld('spikes');
    place(world, 0, 10, 0);
    world.step(DT);
    run(world, 3);
    const t = world.snapshot().traps[0];
    expect(t.phase).toBe('active');
    expect(t.timeLeft).toBeCloseTo(TRAP_ACTIVE_SECONDS - 3, 3);
    expect(t.triggeredBy).toBe(0);
  });

  it('blocking does NOT reduce trap damage and never drains guard; no flinch, no ult charge, no bloodlust', () => {
    const results: { lost: number; guard: number; ult: number; hitstun: number }[] = [];
    for (const blocking of [false, true]) {
      const { world } = trapWorld('spikes', 'rhino', 'gorilla');
      place(world, 0, 10, 0);
      world.time = 200; // bloodlust ×2.0 — must not scale trap damage
      const intent = { ...neutral(), block: blocking };
      const f = world.fighters[0];
      const hp0 = f.state.hp;
      const g0 = f.state.guard;
      let maxHitstun = 0;
      for (let i = 0; i < Math.round(2 / DT); i++) {
        world.setIntent(0, intent);
        world.step(DT);
        maxHitstun = Math.max(maxHitstun, f.hitstunTimer);
      }
      expect(world.bloodlustMult).toBeGreaterThan(1.5);
      if (blocking) expect(f.blocking).toBe(true);
      results.push({ lost: hp0 - f.state.hp, guard: g0 - f.state.guard, ult: f.state.ultCharge, hitstun: maxHitstun });
    }
    // 2 s in spikes: stabs at 0, 0.8, 1.6 s = 3 stabs, blocked or not.
    expect(results[0].lost).toBeCloseTo(3 * TRAP_KINDS.spikes.pulseDamage, 6);
    expect(results[1].lost).toBeCloseTo(results[0].lost, 6);
    for (const r of results) {
      expect(r.guard).toBeLessThanOrEqual(0); // no guard drain (regen only)
      expect(r.ult).toBe(0);
      expect(r.hitstun).toBe(0);
    }
  });

  it('airborne, gliding and burrowed fighters are unaffected by an active trap', () => {
    // Airborne: held above the hazard height inside an active spike trap.
    {
      const { world, events } = trapWorld('spikes', 'gorilla', 'lion');
      place(world, 1, 10.5, 0); // lion triggers it
      world.step(DT);
      expect(world.traps[0].phase).toBe('active');
      events.length = 0;
      const g = world.fighters[0];
      const hp0 = g.state.hp;
      for (let i = 0; i < 60; i++) {
        place(world, 0, 9.5, 0, 1.5);
        world.step(DT);
      }
      expect(g.state.hp).toBe(hp0);
      expect(ofType(events, 'trapDamage').some((e) => e.targetId === 0)).toBe(false);
    }
    // Burrowed mole under an active fire pit.
    {
      const { world } = trapWorld('fire', 'mole', 'lion');
      place(world, 0, 13.5, 0);
      world.setIntent(0, { ...neutral(), special: true });
      world.step(DT);
      world.setIntent(0, neutral());
      run(world, 0.5); // through the 0.35 s windup → underground
      expect(world.fighters[0].state.burrowT).toBeGreaterThan(0);
      place(world, 0, 10, 0); // tunnel under the plate: does not trigger
      world.step(DT);
      expect(world.traps[0].phase).toBe('armed');
      place(world, 1, 10.5, 0); // lion triggers it; mole still below
      const hp0 = world.fighters[0].state.hp;
      for (let i = 0; i < 60; i++) {
        world.fighters[0].state.pos.x = 10;
        world.fighters[0].state.pos.z = 0;
        world.step(DT);
      }
      expect(world.traps[0].phase).toBe('active');
      expect(world.fighters[0].state.burrowT).toBeGreaterThan(0);
      expect(world.fighters[0].state.hp).toBe(hp0);
    }
  });

  it('a trap kill reports killerId −1 and credits nobody, even after an enemy hit', () => {
    const { world, events } = trapWorld('spikes', 'gorilla', 'lion');
    const g = world.fighters[0];
    g.lastAttackerId = 1; // the lion hit it earlier
    g.state.hp = 15;
    place(world, 0, 10, 0);
    world.step(DT);
    const deaths = ofType(events, 'death');
    expect(deaths).toHaveLength(1);
    expect(deaths[0].targetId).toBe(0);
    expect(deaths[0].killerId).toBe(-1);
    expect(world.fighters[1].state.kills).toBe(0);
    expect(world.fighters[1].state.damageDealt).toBe(0);
  });

  it('snapshot().traps is an accurate deep copy', () => {
    const { world } = trapWorld('fire');
    place(world, 0, 10, 0);
    world.step(DT);
    const a = world.snapshot();
    const b = world.snapshot();
    const live = world.traps[0];
    expect(a.traps).toEqual(b.traps);
    expect(a.traps[0]).toEqual({
      id: live.id,
      kind: live.kind,
      pos: { x: live.pos.x, y: live.pos.y, z: live.pos.z },
      radius: live.radius,
      phase: live.phase,
      timeLeft: live.timeLeft,
      triggeredBy: live.triggeredBy,
    });
    expect(a.traps).not.toBe(b.traps);
    expect(a.traps[0].pos).not.toBe(live.pos);
    a.traps[0].pos.x = 999;
    a.traps[0].phase = 'armed';
    expect(live.pos.x).toBe(10);
    expect(live.phase).toBe('active');
    expect('pulseT' in a.traps[0]).toBe(false);
  });
});
