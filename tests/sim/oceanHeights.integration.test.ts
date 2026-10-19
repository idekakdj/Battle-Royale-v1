/**
 * v1.10 integration on the REAL Ocean Dome (WP-H1's layout + WP-H2's rules): the two serpent lanes and fall damage as the shipped arena
 * shapes them. Skipped while `OCEAN_ARENA.hazards.serpentSplitY` is undefined (the layout has not landed); the rules themselves are
 * tested on a synthetic dome in serpent.lanes.test.ts / fall.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { World } from '../../src/sim/World';
import { EventBus } from '../../src/core/EventBus';
import { BotManager } from '../../src/ai/BotManager';
import { ANIMAL_IDS } from '../../src/config/animals';
import { OCEAN_ARENA, OCEAN_UPPER_HEIGHT, arenaGroundHeight, arenaSerpentBand, type ElevationPiece } from '../../src/config/arenas';
import { serpentLaneBins } from '../../src/config/serpentLanes';
import type { AnimalId, GameEvent, MatchConfig } from '../../src/core/types';
import { DT, ofType, standAt, stepN, neutralIntent } from './heightsFixture';

const HAS_SPLIT = OCEAN_ARENA.hazards?.serpentSplitY !== undefined;
const FALL = OCEAN_ARENA.hazards?.fallDamage;

type Tower = Extract<ElevationPiece, { kind: 'plateau' }>;
const towers = (): Tower[] =>
  (OCEAN_ARENA.heightfield ?? []).filter((p): p is Tower => p.kind === 'plateau' && p.height === OCEAN_UPPER_HEIGHT);

function oceanWorld(animals: AnimalId[], seed = 5): { world: World; events: GameEvent[] } {
  const cfg: MatchConfig = { roster: animals.map((a, i) => ({ animal: a, isPlayer: i === 0 })), difficulty: 1, arena: 'ocean' };
  const bus = new EventBus();
  const events: GameEvent[] = [];
  bus.onAny((e) => events.push(e));
  const world = new World(cfg, seed, bus, { traps: false });
  for (let i = 0; i < 190; i++) world.step(DT);
  events.length = 0;
  return { world, events };
}

/** Parks every fighter not in `keep` on a seabed spot far from everything the tests do. */
function park(world: World, keep: readonly number[]): void {
  let k = 0;
  for (const f of world.fighters) {
    if (keep.includes(f.id)) continue;
    const a = ((200 + k * 12) * Math.PI) / 180;
    standAt(world, f.id, 27.5 * Math.cos(a), 27.5 * Math.sin(a));
    k++;
  }
}

describe.skipIf(!HAS_SPLIT)('Ocean Dome: two serpent lanes and fall damage on the shipped layout', () => {
  it('the layout hands both lanes enough strike lines (>= 150 low, >= 80 high of 360) and has upper towers', () => {
    const bins = serpentLaneBins(OCEAN_ARENA);
    expect(bins.low.length).toBeGreaterThanOrEqual(150);
    expect(bins.high.length).toBeGreaterThanOrEqual(80);
    expect(towers().length).toBeGreaterThanOrEqual(3);
    expect(FALL).toEqual({ minDrop: 3.4, damage: 50 });
    expect(OCEAN_ARENA.hazards?.serpentSplitY).toBe(4.5);
  });

  it('the world runs both lanes: snapshot blocks, tagged events, and the high one hurts a fighter on each tower top while the low one does not', () => {
    for (const t of towers()) {
      const angle = ((Math.atan2(t.z, t.x) * 180) / Math.PI + 360) % 360;
      expect(serpentLaneBins(OCEAN_ARENA).high, `tower at ${angle}`).toContain(Math.floor(angle));
      for (const tier of ['high', 'low'] as const) {
        const { world, events } = oceanWorld(['lion', 'gorilla', 'rhino', 'hippo'], 9);
        park(world, [0, 1]);
        standAt(world, 0, t.x, t.z); // on the tower top (the pad)
        const out = 27.5;
        standAt(world, 1, out * Math.cos((angle * Math.PI) / 180), out * Math.sin((angle * Math.PI) / 180)); // the seabed, same line
        expect(arenaSerpentBand(OCEAN_ARENA, world.fighters[0].state.pos.x, world.fighters[0].state.pos.z)).toBe('high');
        expect(arenaSerpentBand(OCEAN_ARENA, world.fighters[1].state.pos.x, world.fighters[1].state.pos.z)).toBe('low');
        stepN(world, 2);
        expect(world.debugTriggerSerpent(angle, tier)).toBe(true);
        stepN(world, 1);
        const snap = world.snapshot();
        expect(snap.serpentHigh !== undefined, `${tier} block`).toBe(tier === 'high');
        expect(snap.serpent !== undefined, `${tier} block`).toBe(tier === 'low');
        while (world.serpent?.active === true) world.step(DT);
        const hits = ofType(events, 'serpentHit');
        expect(hits.map((h) => h.fighterId), `${tier} at ${angle}`).toEqual([tier === 'high' ? 0 : 1]);
        expect((hits[0] as { tier?: string }).tier).toBe(tier === 'high' ? 'high' : undefined);
        expect(hits[0].damage).toBe(300);
      }
    }
  });

  it('walking off the rim of every tower where it ends in a cliff costs exactly 50 once; the drop is measured to where the fighter came down', () => {
    for (const t of towers()) {
      let tested = 0;
      for (let k = 0; k < 24; k++) {
        const a = (k * 15 * Math.PI) / 180;
        const dx = Math.cos(a);
        const dz = Math.sin(a);
        // a cliff side: the ground right beyond the rim and a few metres further out are both well below the tower top
        const g1 = arenaGroundHeight(OCEAN_ARENA, t.x + dx * (t.radius + 0.8), t.z + dz * (t.radius + 0.8));
        const g2 = arenaGroundHeight(OCEAN_ARENA, t.x + dx * (t.radius + 3), t.z + dz * (t.radius + 3));
        const g0 = arenaGroundHeight(OCEAN_ARENA, t.x + dx * (t.radius - 0.8), t.z + dz * (t.radius - 0.8));
        if (g1 > OCEAN_UPPER_HEIGHT - 3.5 || g2 > OCEAN_UPPER_HEIGHT - 3.5 || g0 < OCEAN_UPPER_HEIGHT - 1e-6) continue;
        const { world, events } = oceanWorld(['lion', 'gorilla', 'rhino'], 3);
        park(world, [0]);
        standAt(world, 0, t.x + dx * 1.5, t.z + dz * 1.5);
        stepN(world, 2);
        events.length = 0;
        world.setIntent(0, { ...neutralIntent(), moveX: dx, moveZ: dz, aimYaw: Math.atan2(dx, dz) });
        let hpBefore = world.fighters[0].state.hp;
        let hpAfter = Number.NaN;
        for (let i = 0; i < 210 && Number.isNaN(hpAfter); i++) {
          hpBefore = world.fighters[0].state.hp;
          world.step(DT);
          if (ofType(events, 'fall').length > 0) hpAfter = world.fighters[0].state.hp; // (pads heal later, so look at the landing tick)
        }
        world.setIntent(0, neutralIntent());
        stepN(world, 60);
        const falls = ofType(events, 'fall').filter((e) => e.fighterId === 0);
        expect(falls, `tower ${t.x},${t.z} dir ${k * 15}`).toHaveLength(1);
        expect(falls[0].damage).toBe(50);
        expect(falls[0].drop).toBeGreaterThanOrEqual(3.4);
        // measured from where it LAST STOOD (the rim, or the top corner of a ramp it brushed: at most ~0.6 m lower) to where it landed
        expect(falls[0].drop).toBeLessThanOrEqual(OCEAN_UPPER_HEIGHT - falls[0].pos.y + 1e-6);
        expect(falls[0].drop).toBeGreaterThanOrEqual(OCEAN_UPPER_HEIGHT - falls[0].pos.y - 0.6);
        expect(hpAfter).toBe(hpBefore - 50);
        tested++;
      }
      expect(tested, `tower ${t.x},${t.z} has cliff sides`).toBeGreaterThan(0);
    }
  });

  it('taking the ramps never costs a thing: every ramp, up and back down, with the biggest body', () => {
    const ramps = (OCEAN_ARENA.heightfield ?? []).filter((p): p is Extract<ElevationPiece, { kind: 'ramp' }> => p.kind === 'ramp');
    expect(ramps.length).toBeGreaterThanOrEqual(12);
    for (const rp of ramps) {
      const a = (rp.dirDeg * Math.PI) / 180;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      const { world, events } = oceanWorld(['hippo', 'lion', 'gorilla'], 4);
      park(world, [0]);
      // start at the low end, walk to the high end, and back
      standAt(world, 0, rp.x - dx * (rp.length / 2 - 0.2), rp.z - dz * (rp.length / 2 - 0.2));
      stepN(world, 2);
      events.length = 0;
      world.setIntent(0, { ...neutralIntent(), moveX: dx, moveZ: dz, aimYaw: Math.atan2(dx, dz) });
      stepN(world, Math.ceil((rp.length / 5) * 60) + 30);
      world.setIntent(0, { ...neutralIntent(), moveX: -dx, moveZ: -dz, aimYaw: Math.atan2(-dx, -dz) });
      stepN(world, Math.ceil((rp.length / 5) * 60) + 30);
      expect(ofType(events, 'fall'), `ramp at ${rp.x},${rp.z} dir ${rp.dirDeg}`).toHaveLength(0);
      expect(world.fighters[0].state.hp).toBe(world.fighters[0].def.hp);
    }
  });

  it('a full 10-bot match: every fall is the fixed 50 (or the last hp), a fall death is a credit-free "fall" kill, and the run is deterministic', () => {
    const run = () => {
      const cfg: MatchConfig = { roster: (ANIMAL_IDS as AnimalId[]).map((a) => ({ animal: a, isPlayer: false })), difficulty: 3, arena: 'ocean' };
      const bus = new EventBus();
      const events: GameEvent[] = [];
      bus.onAny((e) => events.push(e));
      const world = new World(cfg, 21, bus);
      const bots = new BotManager(bus, 3, 21, world.arena);
      for (let i = 0; i < 60 * 70 && !world.matchOver; i++) {
        bots.update(world.snapshot(), DT);
        for (let id = 0; id < world.fighters.length; id++) world.setIntent(id, bots.getIntent(id));
        world.step(DT);
      }
      return events;
    };
    const a = run();
    for (const f of ofType(a, 'fall')) {
      expect(f.damage).toBeGreaterThan(0);
      expect(f.damage).toBeLessThanOrEqual(50);
      expect(f.drop).toBeGreaterThanOrEqual(3.4);
    }
    for (const d of ofType(a, 'death')) if (d.cause === 'fall') expect(d.killerId).toBe(-1);
    expect(run()).toEqual(a);
  });
});
