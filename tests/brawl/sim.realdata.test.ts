/**
 * The simulation against the SHIPPED move/stage data (src/brawl/data). Kept separate from the
 * fixture-based sim tests so a data-balance edit can never be mistaken for a sim regression.
 */

import { describe, it, expect } from 'vitest';
import { mulberry32 } from '../../src/core/math';
import type { AnimalId } from '../../src/core/types';
import type { BrawlEvent, BrawlIntent, BrawlSnapshot, MoveId, PlatformDef } from '../../src/brawl/types';
import { MOVE_IDS, STAGE_IDS } from '../../src/brawl/types';
import { BrawlWorld } from '../../src/brawl/sim/BrawlWorld';
import { MOVESETS, STAGES, getMoveBody } from '../../src/brawl/data/index';
import { cfg, intent, run } from './fixtures';

const ALL = Object.keys(MOVESETS) as AnimalId[];

const live = (animals: AnimalId[], over: Parameters<typeof cfg>[1] = {}, seed = 1): BrawlWorld => {
  const w = new BrawlWorld(cfg(animals, over), seed);
  w.skipCountdown();
  return w;
};

const fighter = (w: BrawlWorld, id: number) => w.snapshot().fighters[id];

function pressFor(id: MoveId): Partial<BrawlIntent> {
  const heavy = id.startsWith('heavy');
  const slot = id.slice(-1);
  return {
    [heavy ? 'heavy' : 'light']: true,
    moveX: slot === 'S' ? 0.8 : 0,
    moveY: slot === 'U' ? 1 : slot === 'D' ? -1 : 0,
  } as Partial<BrawlIntent>;
}

describe('sim x shipped data: every move runs to completion', () => {
  for (const animal of ALL) {
    it(`${animal}: 8 moves, ground and air forms`, () => {
      for (const id of MOVE_IDS) {
        for (const air of [false, true]) {
          const w = live([animal, 'lion'], {}, 3);
          w.debugPlace(0, 0, air ? 9 : 0);
          w.debugPlace(1, 14, 0); // far away
          w.debugFighter(1).ledgeRegrab = 9999;
          const md = MOVESETS[animal].moves[id];
          if ((air && md.groundOnly) || (!air && md.airOnly)) continue;
          run(w, 1, 0, () => pressFor(id));
          const f0 = fighter(w, 0);
          expect(f0.moveId).toBe(id);
          expect(f0.moveAir).toBe(air);
          const body = getMoveBody(animal, id, air, 0);
          expect(f0.moveFrames).toBe(body.startup + body.active + body.recovery);
          let frames = 1;
          while (fighter(w, 0).action === 'attack' && frames < 200) {
            run(w, 1, 0);
            frames++;
            const f = fighter(w, 0);
            if (!f.alive) break;
            expect(Number.isFinite(f.pos.x) && Number.isFinite(f.pos.y)).toBe(true);
          }
          // an aerial that lands early ends via landing lag; otherwise the move lasts exactly its length
          if (!air || fighter(w, 0).grounded === false) expect(frames).toBeLessThanOrEqual(body.startup + body.active + body.recovery + 1);
          expect(frames).toBeLessThan(200);
        }
      }
    });
  }
});

describe('sim x shipped data: light-neutral strings are true combos from 0 %', () => {
  for (const animal of ALL) {
    it(animal, () => {
      const links = (MOVESETS[animal].moves.lightN.chain?.length ?? 0) + 1;
      // find a spacing where the first hit connects
      let best: { dist: number; hits: number; free: number } | null = null;
      for (let dist = 0.6; dist <= 3.2; dist += 0.2) {
        const w = live([animal, 'lion']);
        w.debugPlace(0, 0, 0);
        w.debugPlace(1, dist, 0);
        w.debugSetFacing(0, 1);
        w.debugSetFacing(1, -1);
        let hits = 0;
        let free = 0;
        for (let i = 0; i < 120; i++) {
          w.setIntent(0, intent({ light: true }));
          w.step();
          for (const e of w.drainEvents()) if (e.type === 'hit') hits++;
          if (hits >= 1 && hits < links) {
            const v = fighter(w, 1);
            if (!(v.action === 'hitstun' || v.action === 'tumble')) free++;
          }
        }
        if (hits >= 1 && (best === null || hits > best.hits || (hits === best.hits && free < best.free))) best = { dist, hits, free };
      }
      expect(best).not.toBeNull();
      expect(best!.hits).toBeGreaterThanOrEqual(links);
      expect(best!.free).toBe(0);
    });
  }
});

describe('sim x shipped data: full-match fuzz', () => {
  function checkNoNaN(s: BrawlSnapshot, defs: PlatformDef[], sizes: { w: number; h: number }[]): void {
    // v1.6: solids are read from the snapshot (moving platforms; destroyed / not-yet-active ones do not collide)
    const solids = s.platforms
      .map((p, i) => ({ ...p, thickness: defs[i].thickness, solid: defs[i].kind === 'solid' }))
      .filter((p) => p.solid && p.active !== false);
    for (const f of s.fighters) {
      const sz = sizes[f.id];
      if (f.alive && f.action !== 'respawn') {
        for (const p of solids) {
          const ox = Math.min(f.pos.x + sz.w / 2, p.x1) - Math.max(f.pos.x - sz.w / 2, p.x0);
          const oy = Math.min(f.pos.y + sz.h, p.y) - Math.max(f.pos.y, p.y - p.thickness);
          if (ox > 0.75 && oy > 0.75) throw new Error(`fighter ${f.id} (${f.animal}) embedded in a solid at frame ${s.frame}: ${JSON.stringify(f.pos)}`);
        }
      }
      for (const n of [f.pos.x, f.pos.y, f.vel.x, f.vel.y, f.percent, f.invuln, f.hitlag, f.hitstun]) {
        if (!Number.isFinite(n)) throw new Error(`non-finite value in frame ${s.frame}: ${JSON.stringify(f)}`);
      }
      if (f.percent < 0 || f.percent > 999) throw new Error('percent out of range');
      if (f.alive === (f.action === 'ko')) throw new Error(`alive/action mismatch ${f.alive} ${f.action}`);
    }
  }

  for (const stage of STAGE_IDS) {
    it(`20 000 frames x 4 random fighters on ${stage}`, () => {
      const rng = mulberry32(2024);
      const roster: AnimalId[] = [0, 1, 2, 3].map(() => ALL[Math.floor(rng() * ALL.length)]);
      const w = live(roster, { stage, stocks: 999, timeLimitS: 0 }, 17);
      const defs = STAGES[stage].platforms;
      const sizes = roster.map((a) => ({ w: MOVESETS[a].stats.width, h: MOVESETS[a].stats.height }));
      const st = [0, 0, 0, 0].map(() => ({ x: 0, y: 0, held: false }));
      let hits = 0;
      let kos = 0;
      for (let i = 0; i < 20000; i++) {
        for (let id = 0; id < 4; id++) {
          const p = st[id];
          if (rng() < 0.12) p.x = [-1, -0.5, 0, 0, 0.5, 1][Math.floor(rng() * 6)];
          if (rng() < 0.1) p.y = [-1, 0, 0, 0, 1][Math.floor(rng() * 5)];
          if (rng() < 0.08) p.held = !p.held;
          w.setIntent(id, { moveX: p.x, moveY: p.y, jump: rng() < 0.04, jumpHeld: p.held, light: rng() < 0.07, heavy: rng() < 0.04, dodge: rng() < 0.02 });
        }
        w.step();
        checkNoNaN(w.snapshot(), defs, sizes);
        for (const e of w.drainEvents() as BrawlEvent[]) {
          if (e.type === 'hit') hits++;
          else if (e.type === 'ko') kos++;
        }
      }
      expect(hits).toBeGreaterThan(30);
      expect(kos).toBeGreaterThan(2);
    });
  }

  it('is deterministic with the shipped data', () => {
    const go = () => {
      const w = live(['lion', 'eagle', 'hippo', 'panther'], { stage: 'skyAqueduct', stocks: 99, timeLimitS: 0 }, 5);
      const rng = mulberry32(8);
      const out: string[] = [];
      for (let i = 0; i < 2500; i++) {
        for (let id = 0; id < 4; id++) {
          w.setIntent(id, { moveX: Math.round(rng() * 2 - 1), moveY: Math.round(rng() * 2 - 1), jump: rng() < 0.04, jumpHeld: rng() < 0.5, light: rng() < 0.08, heavy: rng() < 0.05, dodge: rng() < 0.02 });
        }
        w.step();
        if (i % 25 === 0) out.push(JSON.stringify(w.snapshot()));
      }
      return out.join('\n') + JSON.stringify(w.drainEvents());
    };
    expect(go()).toBe(go());
  });

  it('stage data matches the plan geometry the sim relies on (ledges, spawns on a solid)', () => {
    for (const id of STAGE_IDS) {
      const s = STAGES[id];
      const w = live(['lion', 'lion', 'lion', 'lion'], { stage: id });
      const snap = w.snapshot();
      snap.fighters.forEach((f, i) => {
        expect(f.grounded, `spawn ${i} on ${id}`).toBe(true);
        // riders of a moving platform were carried along during the (skipped) countdown
        const di = snap.platforms.findIndex((p) => p.id === f.platformId);
        const carried = snap.platforms[di].x0 - s.platforms[di].x0;
        expect(f.pos.x).toBeCloseTo(s.spawns[i].x + carried, 9);
      });
      expect(s.platforms.filter((p) => p.ledgeLeft || p.ledgeRight).length).toBeGreaterThan(0);
    }
  });
});
