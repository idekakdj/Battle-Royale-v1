/**
 * v1.2 bot awareness (UPGRADE-PLAN-v1.2 §3.2 "Bots"): Cubs ignore traps,
 * Fighters step out of active hazards, Veterans/Apex route around plates and
 * leave hazards at once; eagle bots (Veteran/Apex) soar defensively and always
 * release Space.
 */
import { describe, it, expect } from 'vitest';
import { World } from '../../src/sim/World';
import { EventBus } from '../../src/core/EventBus';
import { BotManager } from '../../src/ai/BotManager';
import { avoidTraps, type Move2 } from '../../src/ai/Steering';
import { makeTrap, type TrapRuntime } from '../../src/sim/TrapSystem';
import { BOT_PROFILES } from '../../src/config/botProfiles';
import { TRAP_COUNT_BY_DIFFICULTY } from '../../src/config/traps';
import { ANIMALS } from '../../src/config/animals';
import type { AnimalId, Difficulty, GameEvent, MatchConfig, TrapState } from '../../src/core/types';
import { DT, runMatch } from './helpers';

function trap(kind: TrapState['kind'], x: number, z: number, phase: TrapState['phase']): TrapState {
  return { id: 0, kind, pos: { x, y: 0, z }, radius: kind === 'fire' ? 2 : 1.8, phase, timeLeft: phase === 'armed' ? 0 : 5, triggeredBy: -1 };
}

describe('Steering.avoidTraps', () => {
  it('Cub (ignore) leaves the heading untouched, even inside an active hazard', () => {
    const m: Move2 = { x: 1, z: 0 };
    expect(avoidTraps(m, 0, 0, 0.7, [trap('fire', 0.5, 0, 'active')], 'ignore')).toBe(false);
    expect(m).toEqual({ x: 1, z: 0 });
  });

  it('every aware level steps straight out of an active hazard', () => {
    for (const mode of ['soft', 'route', 'exploit'] as const) {
      const m: Move2 = { x: 1, z: 0 }; // heading deeper in
      expect(avoidTraps(m, 1, 0.2, 0.7, [trap('fire', 2, 0, 'active')], mode)).toBe(true);
      expect(m.x).toBeLessThan(-0.9); // away from the centre at (2, 0)
    }
  });

  it('Veteran/Apex bend around an armed plate ahead; Fighter only for a plate squarely ahead', () => {
    const plate = [trap('spikes', 2.5, 1.5, 'armed')];
    const route: Move2 = { x: 1, z: 0 };
    avoidTraps(route, 0, 0, 0.7, plate, 'route');
    expect(route.z).toBeLessThan(-0.2); // bends away from the plate's side
    const soft: Move2 = { x: 1, z: 0 };
    avoidTraps(soft, 0, 0, 0.7, plate, 'soft'); // off-centre: not worth a detour
    expect(soft).toEqual({ x: 1, z: 0 });
    const squarely: Move2 = { x: 1, z: 0 };
    avoidTraps(squarely, 0, 0, 0.7, [trap('spikes', 2.5, 0.2, 'armed')], 'soft');
    expect(squarely.z).toBeLessThan(0);
  });

  it('spent (cooldown) plates are ignored', () => {
    const m: Move2 = { x: 1, z: 0 };
    avoidTraps(m, 0, 0, 0.7, [trap('fire', 2, 0, 'cooldown')], 'route');
    expect(m).toEqual({ x: 1, z: 0 });
  });
});

/** Bot `animal` at `from`, idle player gorilla target at `to`, one hand-placed trap between. */
function crossing(
  difficulty: Difficulty,
  phase: 'armed' | 'active',
  animal: AnimalId = 'lion',
): { world: World; bots: BotManager; events: GameEvent[]; t: TrapRuntime } {
  const cfg: MatchConfig = {
    roster: [
      { animal, isPlayer: false },
      { animal: 'gorilla', isPlayer: true },
    ],
    difficulty,
  };
  const bus = new EventBus();
  const events: GameEvent[] = [];
  bus.onAny((e) => events.push(e));
  const world = new World(cfg, 99, bus, { traps: false });
  const bots = new BotManager(bus, difficulty, 99);
  const t = makeTrap(0, 'fire', -8, -17, 2);
  if (phase === 'active') {
    t.phase = 'active';
    t.timeLeft = 1e6;
  }
  world.traps.push(t);
  // Teleport during the frozen countdown so every bot's delayed view agrees.
  const b = world.fighters[0].state;
  b.pos.x = -13;
  b.pos.z = -17;
  const g = world.fighters[1].state;
  g.pos.x = -3;
  g.pos.z = -17;
  for (let i = 0; i < 180; i++) {
    bots.update(world.snapshot(), DT);
    world.setIntent(0, bots.getIntent(0));
    world.step(DT);
  }
  events.length = 0;
  return { world, bots, events, t };
}

function drive(world: World, bots: BotManager, seconds: number, t?: TrapRuntime): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    if (t !== undefined && t.phase === 'active') t.timeLeft = 1e6; // keep it burning
    bots.update(world.snapshot(), DT);
    world.setIntent(0, bots.getIntent(0));
    world.step(DT);
  }
}

describe('bots and traps (integration)', () => {
  it('a Cub walks straight through a burning pit to its target; a Veteran and an Apex route around it', () => {
    const burned: Record<number, number> = {};
    for (const d of [1, 3, 4] as Difficulty[]) {
      const { world, bots, events, t } = crossing(d, 'active');
      drive(world, bots, 3, t);
      burned[d] = events.filter((e) => e.type === 'trapDamage' && e.targetId === 0).length;
      // Everyone still reached the gorilla.
      const b = world.fighters[0].state;
      expect(Math.hypot(b.pos.x - world.fighters[1].state.pos.x, b.pos.z - world.fighters[1].state.pos.z)).toBeLessThan(4);
    }
    expect(burned[1]).toBeGreaterThan(0);
    expect(burned[3]).toBe(0);
    expect(burned[4]).toBe(0);
  });

  it('a Veteran/Apex never steps on an armed plate on the way; a Cub does', () => {
    const triggered: Record<number, boolean> = {};
    for (const d of [1, 3, 4] as Difficulty[]) {
      const { world, bots, events } = crossing(d, 'armed');
      drive(world, bots, 3);
      triggered[d] = events.some((e) => e.type === 'trapTriggered');
    }
    expect(triggered[1]).toBe(true);
    expect(triggered[3]).toBe(false);
    expect(triggered[4]).toBe(false);
  });

  it('Fighter/Veteran/Apex bots leave an active hazard quickly', () => {
    for (const d of [2, 3, 4] as Difficulty[]) {
      const { world, bots, t } = crossing(d, 'active');
      const b = world.fighters[0].state;
      b.pos.x = t.pos.x + 0.3;
      b.pos.z = t.pos.z;
      let outAt = -1;
      for (let i = 0; i < 120 && outAt < 0; i++) {
        drive(world, bots, DT, t);
        if (Math.hypot(b.pos.x - t.pos.x, b.pos.z - t.pos.z) > t.radius) outAt = (i + 1) * DT;
      }
      expect(outAt, `L${d}`).toBeGreaterThan(0);
      expect(outAt, `L${d}`).toBeLessThan(BOT_PROFILES[d].reactionMs / 1000 + 0.8);
    }
  });
});

describe('eagle bots soar (Veteran/Apex)', () => {
  it('Apex eagles soar, land slams and always release (every flight ends well before the time limit)', () => {
    let flights = 0;
    let slams = 0;
    let longest = 0;
    for (const seed of [4101, 4102, 4103]) {
      const r = runMatch(seed, 4, undefined, 300, true);
      expect(r.ended).toBe(true);
      slams += r.events.filter((e) => e.type === 'landingImpact' && e.fighterId === 5).length;
    }
    // Direct flight trace in one match (eagle is roster id 5).
    const cfg: MatchConfig = { roster: ['lion', 'gorilla', 'crocodile', 'hippo', 'rhino', 'eagle', 'panther', 'python', 'giraffe', 'mole'].map((a) => ({ animal: a as AnimalId, isPlayer: false })), difficulty: 4 };
    const bus = new EventBus();
    const world = new World(cfg, 4104, bus);
    const bots = new BotManager(bus, 4, 4104);
    let flightStart = -1;
    for (let tick = 0; tick < Math.round(120 / DT) && world.fighters[5].state.alive && !world.matchOver; tick++) {
      bots.update(world.snapshot(), DT);
      for (let id = 0; id < 10; id++) world.setIntent(id, bots.getIntent(id));
      world.step(DT);
      const s = world.fighters[5].state;
      if (s.glideT > 0 && flightStart < 0) {
        flightStart = world.time;
      }
      if (flightStart >= 0 && !s.airborne) {
        flights++;
        longest = Math.max(longest, world.time - flightStart);
        flightStart = -1;
      }
    }
    expect(flights + slams).toBeGreaterThan(0);
    expect(slams).toBeGreaterThan(0);
    // Flight time is 4 s; with the descent a flight is over in well under 6 s.
    expect(longest).toBeLessThan((ANIMALS.eagle.perks.glide?.duration ?? 4) + 2);
  });

  it('difficulty cards mention the trap count', () => {
    for (const d of [1, 2, 3, 4] as Difficulty[]) {
      const p = BOT_PROFILES[d];
      const n = String(TRAP_COUNT_BY_DIFFICULTY[d]);
      expect(p.description).toContain(`${n} `);
      expect(p.behaviors.some((b) => b.includes(`${n} arena trap`))).toBe(true);
    }
  });
});
