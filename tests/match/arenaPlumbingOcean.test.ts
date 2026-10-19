/**
 * v1.9 Ocean Dome plumbing for an OFFLINE match (WP-O4): `LocalSimDriver({ arena: 'ocean', serpent })` is the seam that
 * `MatchController` / `main.ts` / the `?br=1&arena=ocean&serpent=1` QA shortcut use. (The controller itself needs WebGL.)
 */

import { describe, expect, it } from 'vitest';
import { LocalSimDriver } from '../../src/match/SimDriver';
import { seatPositions } from '../../src/match/seating';
import { OCEAN_ARENA, arenaGroundHeight } from '../../src/config/arenas';
import { SERPENT } from '../../src/config/serpent';
import type { GameEvent, WorldSnapshot } from '../../src/core/types';

const DT = 1 / 60;
const SEED = 424242;

function run(driver: LocalSimDriver, ticks: number): WorldSnapshot {
  for (let i = 0; i < ticks; i++) driver.tick(DT, null);
  return driver.snapshot();
}

describe('LocalSimDriver on the Ocean Dome', () => {
  it('arena "ocean" builds an ocean World with its hazards, ocean seating and bots; the run is stable', () => {
    const d = new LocalSimDriver({ animal: 'lion', difficulty: 3, seed: SEED, arena: 'ocean' });
    expect(d.arena).toBe('ocean');
    expect(d.world.arena).toBe(OCEAN_ARENA);
    expect(d.world.arena.hazards?.serpent).toBe(true);
    expect(d.world.serpent).not.toBeNull(); // the real rules: a 50 % roll every 20 s
    expect(d.roster).toHaveLength(10);
    expect(d.roster[0]).toMatchObject({ animal: 'lion', isPlayer: true });
    const seats = seatPositions(10, OCEAN_ARENA);
    d.snapshot().fighters.forEach((f, i) => {
      expect(f.pos.x).toBeCloseTo(seats[i].x, 3);
      expect(f.pos.z).toBeCloseTo(seats[i].z, 3);
      expect(f.pos.y).toBeCloseTo(arenaGroundHeight(OCEAN_ARENA, f.pos.x, f.pos.z), 6);
    });
    const after = run(d, 600);
    expect(after.fighters.every((f) => Number.isFinite(f.pos.x) && Number.isFinite(f.pos.y) && Number.isFinite(f.pos.z))).toBe(true);
    expect(after.serpent).toBeUndefined(); // no event in the first 10 s of the real schedule
  });

  it('the forced-serpent option (?serpent=1&serpentAt=N) fires the warning at N live seconds and the snapshot carries the state', () => {
    const d = new LocalSimDriver({ animal: 'lion', difficulty: 2, seed: SEED, arena: 'ocean', serpent: { chance: 1, firstAtS: 2 } });
    const events: GameEvent[] = [];
    for (const t of ['serpentWarning', 'serpentStrike', 'serpentEnd'] as const) d.bus.on(t, (e) => events.push(e));
    let warnTime = -1;
    for (let i = 0; i < 60 * 12; i++) {
      d.tick(DT, null);
      const snap = d.snapshot();
      if (snap.serpent?.phase === 'warn' && warnTime < 0) {
        warnTime = snap.time;
        expect(snap.serpent.headR).toBeCloseTo(OCEAN_ARENA.wallRadius, 6);
        expect(snap.serpent.angleDeg).toBeGreaterThanOrEqual(0);
        expect(snap.serpent.angleDeg).toBeLessThan(360);
      }
    }
    expect(warnTime).toBeGreaterThanOrEqual(2 - 1e-6); // live time: the 3-2-1 countdown does not count
    expect(warnTime).toBeLessThan(2.1);
    // v1.10: the forced options apply to BOTH serpents of the Ocean Dome (low first, then the high one, whose events carry tier 'high')
    const lanes = d.world.serpent?.lanes.length ?? 0;
    expect(lanes).toBe(OCEAN_ARENA.hazards?.serpentSplitY !== undefined ? 2 : 1);
    const once = (type: 'serpentWarning' | 'serpentStrike' | 'serpentEnd'): string[] => Array.from({ length: lanes }, () => type);
    expect(events.map((e) => e.type)).toEqual([...once('serpentWarning'), ...once('serpentStrike'), ...once('serpentEnd')]);
    const warning = events[0];
    if (warning.type === 'serpentWarning') {
      expect(warning.warnS).toBeCloseTo(SERPENT.warnS, 6);
      expect('tier' in warning).toBe(false); // the low serpent's event is exactly the v1.9 one
    }
    if (lanes === 2) expect((events[1] as { tier?: string }).tier).toBe('high');
  });

  it('world.debugTriggerSerpent(angle) works on the driver\'s world (the QA console path)', () => {
    const d = new LocalSimDriver({ animal: 'lion', difficulty: 1, seed: SEED, arena: 'ocean' });
    let angle = -1;
    d.bus.on('serpentWarning', (e) => (angle = e.angleDeg));
    run(d, 200); // past the frozen 3-2-1 countdown (the sim only steps once the fight is live)
    expect(d.world.debugTriggerSerpent(123)).toBe(true);
    d.tick(DT, null);
    expect(angle).toBeCloseTo(123, 6);
    expect(d.snapshot().serpent?.phase).toBe('warn');
  });

  it('the serpent option is ignored off the ocean (no hazard, no events); absent options leave the colosseum untouched', () => {
    for (const arena of ['colosseum', 'jungle'] as const) {
      const d = new LocalSimDriver({ animal: 'lion', difficulty: 2, seed: SEED, arena, serpent: { chance: 1, firstAtS: 1 } });
      expect(d.world.serpent).toBeNull();
      let warned = 0;
      d.bus.on('serpentWarning', () => warned++);
      run(d, 300);
      expect(warned).toBe(0);
      expect(d.snapshot().serpent).toBeUndefined();
      expect(d.world.debugTriggerSerpent(10)).toBe(false);
    }
    const none = JSON.stringify(run(new LocalSimDriver({ animal: 'lion', difficulty: 3, seed: SEED }), 600));
    const withOpt = JSON.stringify(run(new LocalSimDriver({ animal: 'lion', difficulty: 3, seed: SEED, serpent: { chance: 1, firstAtS: 1 } }), 600));
    expect(withOpt).toBe(none);
  });

  it('a forced event does not change the seating or roster of the same seed', () => {
    const a = new LocalSimDriver({ animal: 'lion', difficulty: 2, seed: SEED, arena: 'ocean' });
    const b = new LocalSimDriver({ animal: 'lion', difficulty: 2, seed: SEED, arena: 'ocean', serpent: { chance: 1, firstAtS: 1 } });
    expect(b.roster.map((r) => r.animal)).toEqual(a.roster.map((r) => r.animal));
    expect(JSON.stringify(b.snapshot().fighters.map((f) => f.pos))).toBe(JSON.stringify(a.snapshot().fighters.map((f) => f.pos)));
  });
});
