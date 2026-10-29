/**
 * v1.10.1 (WP-L2): Ocean Dome nav-grid warm-up. The first live tick of an Ocean match used to build every bot's navigation grid at
 * once (2.7-4.4 s measured: the host's whole loop - snapshots, pongs - stalled the instant "FIGHT!" started). The warm-up builds the
 * same cached grids earlier, in slices. These tests prove (1) it lists every grid the real bots ask for, (2) it builds each exactly
 * once and the later request is the SAME cached object (so the sim sees nothing different), (3) flat arenas build nothing.
 */

import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/core/EventBus';
import type { Difficulty } from '../../src/core/types';
import { getArena, type ArenaDef } from '../../src/config/arenas';
import { World } from '../../src/sim/World';
import { BotManager } from '../../src/ai/BotManager';
import { NAV_AI } from '../../src/ai/Navigator';
import { seatRoster } from '../../src/match/seating';
import { NavWarmer, navWarmKeys } from '../../src/match/navWarm';

interface Req {
  radius: number;
  margin: number;
  hop: boolean;
  arena: ArenaDef;
}
const requested: Req[] = [];

vi.mock('../../src/ai/NavGrid', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/ai/NavGrid')>();
  return {
    ...mod,
    getNavGrid: (arena: ArenaDef, radius: number, margin: number, hop = false) => {
      requested.push({ radius, margin, hop, arena });
      return mod.getNavGrid(arena, radius, margin, hop);
    },
  };
});

const DT = 1 / 60;
const ocean = getArena('ocean');
const k = (r: number, m: number): string => `${r.toFixed(2)}:${m.toFixed(2)}`;

describe('navWarmKeys', () => {
  const lion = ['lion'] as const;

  it('flat arenas (colosseum, jungle) build no nav grids, so they warm nothing', () => {
    expect(navWarmKeys(getArena('colosseum'), lion, 3)).toEqual([]);
    expect(navWarmKeys(getArena('jungle'), lion, 3)).toEqual([]);
  });

  it('the Ocean lists one grid per distinct body radius and margin, the navigator margin first, then margin 0', () => {
    const roster = seatRoster('lion', 99, ocean).map((r) => r.animal);
    const keys = navWarmKeys(ocean, roster, 3);
    const radii = new Set(keys.map((x) => x.radius));
    expect(keys.length).toBe(radii.size * 2);
    expect(keys[0].margin).toBe(NAV_AI[3].margin);
    expect(keys[keys.length - 1].margin).toBe(0);
    expect(new Set(keys.map((x) => k(x.radius, x.margin))).size).toBe(keys.length); // no duplicates
  });

  it('difficulty 1 (margin 0) lists each radius once, not twice', () => {
    const roster = seatRoster('lion', 99, ocean).map((r) => r.animal);
    const keys = navWarmKeys(ocean, roster, 1);
    expect(keys.every((x) => x.margin === 0)).toBe(true);
    expect(new Set(keys.map((x) => x.radius)).size).toBe(keys.length);
  });
});

describe('NavWarmer', () => {
  it('builds one grid per step, none twice, then reports nothing pending; flush builds the rest', () => {
    const built: string[] = [];
    let t = 0;
    const w = new NavWarmer(
      ocean,
      [
        { radius: 0.5, margin: 0.3 },
        { radius: 0.7, margin: 0.3 },
        { radius: 0.9, margin: 0.3 },
      ],
      (_a, r, m) => built.push(k(r, m)),
      () => (t += 10),
    );
    expect(w.pending).toBe(3);
    expect(w.stepOne()).toBe(10);
    expect(w.pending).toBe(2);
    expect(w.flush()).toBe(20);
    expect(w.pending).toBe(0);
    expect(w.stepOne()).toBe(0);
    expect(w.flush()).toBe(0);
    expect(built).toEqual(['0.50:0.30', '0.70:0.30', '0.90:0.30']);
    expect(w.spentMs).toBe(30);
  });
});

describe('the warm-up covers what the real bots ask for (and hands them the same cached grids)', () => {
  it.each([1, 2, 4] as Difficulty[])(
    'Ocean, difficulty %i: every grid the bots request in the first seconds of the fight was in the warm-up list',
    (difficulty) => {
      // A fresh arena object = a cold nav-grid cache (it is keyed by the ArenaDef object); same geometry as the shipped Ocean.
      const arena = { ...ocean } as ArenaDef;
      const seed = 4242 + difficulty;
      const roster = seatRoster('lion', seed, arena);
      const bus = new EventBus();
      const world = new World({ roster, difficulty, arena: 'ocean' }, seed, bus, { arena });
      const bots = new BotManager(bus, difficulty, seed, world.arena);
      const keys = navWarmKeys(world.arena, roster.map((r) => r.animal), difficulty);
      const listed = new Set(keys.map((x) => k(x.radius, x.margin)));

      requested.length = 0;
      const warmer = new NavWarmer(world.arena, keys);
      warmer.flush();
      expect(requested.length).toBe(keys.length);

      requested.length = 0;
      let snap = world.snapshot();
      for (let i = 0; i < 60 * 3 + 90; i++) {
        bots.update(snap, DT);
        for (let id = 1; id < roster.length; id++) world.setIntent(id, bots.getIntent(id));
        world.step(DT);
        snap = world.snapshot();
      }
      expect(snap.time).toBeGreaterThan(1); // the fight is on, the bots have been steering
      const asked = requested.filter((r) => r.arena === arena && !r.hop);
      expect(asked.length).toBeGreaterThan(0); // they really did use the grids
      for (const r of asked) expect(listed.has(k(r.radius, r.margin)), `${k(r.radius, r.margin)} was not warmed`).toBe(true);
    },
    120_000,
  );
});

describe('warming changes nothing the sim can observe', () => {
  it('Ocean, difficulty 3: a run on a pre-warmed arena is bit-identical to a run that builds its grids on the first live tick', () => {
    const run = (warm: boolean): string => {
      const arena = { ...ocean } as ArenaDef; // fresh object = cold cache
      const seed = 777;
      const roster = seatRoster('lion', seed, arena);
      const bus = new EventBus();
      const world = new World({ roster, difficulty: 3, arena: 'ocean' }, seed, bus, { arena });
      const bots = new BotManager(bus, 3, seed, world.arena);
      if (warm) new NavWarmer(world.arena, navWarmKeys(world.arena, roster.map((r) => r.animal), 3)).flush();
      let snap = world.snapshot();
      for (let i = 0; i < 60 * 3 + 120; i++) {
        bots.update(snap, DT);
        for (let id = 1; id < roster.length; id++) world.setIntent(id, bots.getIntent(id));
        world.step(DT);
        snap = world.snapshot();
      }
      return JSON.stringify(snap);
    };
    expect(run(true)).toBe(run(false));
  }, 120_000);
});
