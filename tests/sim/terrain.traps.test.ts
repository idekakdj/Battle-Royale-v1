/**
 * v1.8 traps × terrain: the difficulty-scaled trap system is unchanged on the jungle — same counts, never placed in the pool /
 * on moss / near a trunk (checked through the real World, with the terrain system's own verdicts), and a triggered trap works
 * normally for a fighter standing on moss-adjacent ground (terrain neither triggers, blocks nor reduces trap damage).
 */

import { describe, it, expect } from 'vitest';
import { World } from '../../src/sim/World';
import { EventBus } from '../../src/core/EventBus';
import { JUNGLE_ARENA as J } from '../../src/config/arenas';
import { TRAP_COUNT_BY_DIFFICULTY, TRAP_KINDS, TRAP_ACTIVE_SECONDS } from '../../src/config/traps';
import type { AnimalId, Difficulty, GameEvent, MatchConfig } from '../../src/core/types';
import { DT, disablePickups, neutral } from './helpers';
import { minSurfaceDist, terrainDist } from '../config/arenaGeom';

const ROSTER: AnimalId[] = ['lion', 'gorilla', 'crocodile', 'hippo', 'rhino', 'eagle', 'panther', 'python', 'giraffe', 'mole'];
const LEVELS: Difficulty[] = [1, 2, 3, 4];
const MOSS = J.terrain.filter((z) => z.kind === 'moss');
const TREES = J.circles.filter((c) => c.kind === 'tree');

function jungleWorld(difficulty: Difficulty, seed: number, events: GameEvent[] = []): World {
  const cfg: MatchConfig = { roster: ROSTER.map((a) => ({ animal: a, isPlayer: false })), difficulty, arena: 'jungle' };
  const bus = new EventBus();
  bus.onAny((e) => events.push(e));
  const w = new World(cfg, seed, bus, { traps: true });
  disablePickups(w);
  for (let i = 0; i < 190; i++) w.step(DT);
  events.length = 0;
  return w;
}

describe('jungle traps keep their difficulty counts and respect the terrain', () => {
  it('every difficulty × 60 seeds: full count; no trap centre or trap disc in water, on moss, or within reach of a trunk', () => {
    for (const d of LEVELS) {
      for (let seed = 1; seed <= 60; seed++) {
        const w = jungleWorld(d, seed * 131 + d);
        expect(w.traps.length, `L${d} seed ${seed}`).toBe(TRAP_COUNT_BY_DIFFICULTY[d]);
        for (const t of w.traps) {
          const r = TRAP_KINDS[t.kind].radius;
          for (const z of J.terrain) {
            expect(terrainDist(z, t.pos.x, t.pos.z) - r, `L${d} seed ${seed} terrain`).toBeGreaterThanOrEqual(J.trapRules.terrainClear - 1e-6);
          }
          for (const tr of TREES) expect(Math.hypot(t.pos.x - tr.x, t.pos.z - tr.z) - tr.radius - r, `L${d} seed ${seed} tree`).toBeGreaterThanOrEqual(1.0 - 1e-6);
          expect(minSurfaceDist(J.solids, t.pos.x, t.pos.z) - r).toBeGreaterThanOrEqual(1.0 - 1e-6);
          // the terrain system itself agrees: a fighter standing on a plate is neither wading nor on moss
          expect(w.terrain.waterIndexAt(t.pos.x, t.pos.z, 0.15)).toBe(-1);
          expect(w.terrain.mossOverlaps(t.pos.x, t.pos.z, 0)).toBe(false);
        }
      }
    }
  });

  it('a trap triggers and hurts normally for a big fighter standing at the plate edge nearest a moss patch', () => {
    let checked = 0;
    let overlapped = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const events: GameEvent[] = [];
      const w = jungleWorld(4, seed * 17, events);
      // the (trap, moss patch) pair with the smallest gap
      let best: { t: (typeof w.traps)[number]; gap: number; m: (typeof MOSS)[number] } | null = null;
      for (const t of w.traps) {
        for (const m of MOSS) {
          const gap = terrainDist(m, t.pos.x, t.pos.z) - t.radius;
          if (best === null || gap < best.gap) best = { t, gap, m };
        }
      }
      if (best === null || best.gap > 2.5) continue;
      const { t, m } = best;
      const hippo = w.fighters[ROSTER.indexOf('hippo')]; // radius 1.2: its body reaches the patch
      const ux = (m.x - t.pos.x) / Math.hypot(m.x - t.pos.x, m.z - t.pos.z);
      const uz = (m.z - t.pos.z) / Math.hypot(m.x - t.pos.x, m.z - t.pos.z);
      hippo.state.pos.x = t.pos.x + ux * (t.radius - 0.1);
      hippo.state.pos.z = t.pos.z + uz * (t.radius - 0.1);
      hippo.state.pos.y = 0;
      hippo.setIntent(neutral());
      const hp0 = hippo.state.hp;
      for (let k = 0; k < 90; k++) w.step(DT);
      checked++;
      if (hippo.onMoss) overlapped++;
      expect(events.some((e) => e.type === 'trapTriggered' && e.trapId === t.id && e.fighterId === hippo.id), `seed ${seed}`).toBe(true);
      expect(events.some((e) => e.type === 'trapDamage' && e.targetId === hippo.id), `seed ${seed}`).toBe(true);
      expect(hippo.state.hp).toBeLessThan(hp0);
      expect(t.phase === 'active' || t.phase === 'cooldown').toBe(true);
      expect(TRAP_ACTIVE_SECONDS).toBeGreaterThan(1);
    }
    expect(checked).toBeGreaterThan(5);
    expect(overlapped).toBeGreaterThan(0); // at least one of the fighters really was standing on moss when it triggered
  });
});
