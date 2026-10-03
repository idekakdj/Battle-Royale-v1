/**
 * Pose layer x the REAL simulation: drive BrawlRigs from `BrawlWorld` snapshots and check "what you see is what hits":
 * on every frame the world publishes an active hitbox for the attacker, the rig's strike tip (in world space) is inside or
 * within 0.5 m of that hitbox (and the pose is finite) — lion and gorilla, every move, ground and air, both facings.
 */

import { afterAll, describe, expect, it } from 'vitest';
import type { AnimalId } from '../../src/core/types';
import { BrawlWorld } from '../../src/brawl/sim/BrawlWorld';
import { MOVE_IDS, idleIntent, type BrawlIntent, type BrawlMatchConfig, type HitboxView, type MoveId } from '../../src/brawl/types';
import { getMoveset } from '../../src/brawl/data';
import { BrawlRig } from '../../src/brawl/render/pose/BrawlRig';
import { disposeSolvers } from '../../src/brawl/render/pose/solver';
import { hasNaN } from './poseHelpers';

const rigs: BrawlRig[] = [];
function rig(a: AnimalId): BrawlRig {
  const r = new BrawlRig(a);
  rigs.push(r);
  return r;
}
afterAll(() => {
  for (const r of rigs) r.dispose();
  disposeSolvers();
});

function distToView(h: HitboxView, px: number, py: number): number {
  if (h.shape === 'circle') return Math.max(0, Math.hypot(px - h.x, py - h.y) - h.r);
  const dx = Math.max(0, Math.abs(px - h.x) - h.w / 2);
  const dy = Math.max(0, Math.abs(py - h.y) - h.h / 2);
  return Math.hypot(dx, dy);
}

function press(id: MoveId, facing: 1 | -1): BrawlIntent {
  const heavy = id.startsWith('heavy');
  const slot = id.slice(-1);
  return {
    ...idleIntent(),
    [heavy ? 'heavy' : 'light']: true,
    moveX: slot === 'S' ? 0.8 * facing : 0,
    moveY: slot === 'U' ? 1 : slot === 'D' ? -1 : 0,
  };
}

function config(a: AnimalId): BrawlMatchConfig {
  return { stage: 'brokenColosseum', roster: [{ animal: a, isPlayer: true }, { animal: 'gorilla', isPlayer: false }], difficulty: 1, stocks: 3, timeLimitS: 0 };
}

describe('pose x sim: the strike tip is in the published hitbox', () => {
  for (const animal of ['lion', 'gorilla'] as const) {
    it(`${animal}: every move, ground and air, both facings`, () => {
      const set = getMoveset(animal);
      const r = rig(animal);
      let checked = 0;
      for (const id of MOVE_IDS) {
        for (const air of [false, true]) {
          const md = set.moves[id];
          if ((air && md.groundOnly) || (!air && md.airOnly)) continue;
          for (const facing of [1, -1] as const) {
            const w = new BrawlWorld(config(animal), 5);
            w.skipCountdown();
            w.debugPlace(0, 0, air ? 19 : 0);
            w.debugPlace(1, facing === 1 ? 14 : -14, 0);
            w.debugFighter(1).ledgeRegrab = 9999;
            w.setIntent(0, { ...idleIntent(), moveX: facing * 0.2 });
            w.step();
            w.setIntent(0, press(id, facing));
            w.step();
            w.setIntent(0, idleIntent());
            let prev = w.snapshot();
            let started = false;
            for (let i = 0; i < 90; i++) {
              const cur = w.snapshot();
              const f = cur.fighters[0];
              r.update(f, prev.fighters[0], 1, 1 / 60);
              expect(hasNaN(r), `${animal} ${id} air=${air} frame ${i}`).toBe(false);
              if (f.action === 'attack') started = true;
              const boxes = cur.hitboxes.filter((h) => h.fighterId === 0);
              if (boxes.length > 0 && f.action === 'attack') {
                const tip = r.tipWorld('strike');
                expect(tip, `${animal} ${id}: strike tip exists`).not.toBeNull();
                const t = tip as { x: number; y: number };
                let best = Infinity;
                for (const h of boxes) best = Math.min(best, distToView(h, t.x, t.y));
                expect(best, `${animal} ${id} air=${air} facing=${facing} moveFrame=${f.moveFrame}: tip (${t.x.toFixed(2)}, ${t.y.toFixed(2)}) vs hitbox`).toBeLessThanOrEqual(0.5);
                checked++;
              }
              prev = cur;
              w.step();
              if (started && f.action !== 'attack') break;
            }
            expect(started, `${animal} ${id} air=${air} started`).toBe(true);
          }
        }
      }
      expect(checked).toBeGreaterThan(40);
    });
  }
});
