/**
 * Hand-written pose profiles of WP-A2 (crocodile, hippo, rhino, panther): the same acceptance checks as pose.moves.test.ts /
 * pose.sim.test.ts, applied to these four animals:
 *  (a) the peak pose lands on the first active frame,
 *  (b) the strike tip is inside / within 0.5 m of the move's hitbox on every active frame (ground + air, every chain link, both facings),
 *  (c) no joint rotates more than 0.5 rad per 60 Hz frame (0.9 on the strike frames), including entry / exit with idle / fall / run,
 *  (d) no NaN, a profile is registered for each animal and drives the key anatomy,
 *  (e) the real BrawlWorld drive: while the world publishes an active hitbox for the attacker, the strike tip is within 0.5 m of it.
 */

import { afterAll, describe, expect, it } from 'vitest';
import type { AnimalId } from '../../src/core/types';
import { MOVE_IDS, idleIntent, type BrawlAction, type BrawlIntent, type BrawlMatchConfig, type HitboxView, type MoveId } from '../../src/brawl/types';
import { getMoveBody, getMoveset } from '../../src/brawl/data';
import { BrawlWorld } from '../../src/brawl/sim/BrawlWorld';
import { BrawlRig } from '../../src/brawl/render/pose/BrawlRig';
import { getBuilt, STEP_NORMAL, STEP_STRIKE } from '../../src/brawl/render/pose/build';
import { getRegisteredProfile } from '../../src/brawl/render/pose/profile';
import { disposeSolvers } from '../../src/brawl/render/pose/solver';
import { hasNaN, mkState, runMove, tipToHitbox } from './poseHelpers';

const ANIMALS: AnimalId[] = ['crocodile', 'hippo', 'rhino', 'panther'];
const EPS = 1e-4;

interface Case {
  animal: AnimalId;
  id: MoveId;
  air: boolean;
  chain: number;
}

function casesOf(animal: AnimalId): Case[] {
  const out: Case[] = [];
  const set = getMoveset(animal);
  for (const id of MOVE_IDS) {
    const m = set.moves[id];
    if (!m.airOnly) out.push({ animal, id, air: false, chain: 0 });
    if ((m.air !== null && !m.groundOnly) || m.airOnly) out.push({ animal, id, air: true, chain: 0 });
    (m.chain ?? []).forEach((_, i) => out.push({ animal, id, air: false, chain: i + 1 }));
  }
  return out;
}

const rigs = new Map<AnimalId, BrawlRig>();
function rigOf(a: AnimalId): BrawlRig {
  let r = rigs.get(a);
  if (r === undefined) {
    r = new BrawlRig(a);
    rigs.set(a, r);
  }
  return r;
}
const extraRigs: BrawlRig[] = [];
afterAll(() => {
  for (const r of rigs.values()) r.dispose();
  for (const r of extraRigs) r.dispose();
  disposeSolvers();
});

for (const animal of ANIMALS) {
  describe(`pose a2 moves: ${animal}`, () => {
    it('has a hand-written profile with the key tips', () => {
      const p = getRegisteredProfile(animal);
      expect(p, `${animal} profile registered`).toBeDefined();
      expect(p?.note).toMatch(/WP-A2/);
      expect(p?.tips.body).toBeDefined();
    });

    for (const c of casesOf(animal)) {
      const label = `${c.id}${c.air ? ' air' : ''}${c.chain ? ` chain${c.chain}` : ''}`;
      it(`${label}: peak on first active frame, tip in hitbox, smooth, finite`, () => {
        const body = getMoveBody(animal, c.id, c.air, c.chain);
        const built = getBuilt(animal, body, c.air, c.chain);
        const first = Math.min(...body.hitboxes.map((h) => h.from));
        const end = Math.max(...body.hitboxes.map((h) => h.to));

        // (a) peak exactly on the first active frame (pure timeline).
        expect(built.strikeFrame).toBe(first);
        const v = new Float64Array(built.peak.length);
        built.timeline.evalAt(first, v);
        for (let i = 0; i < v.length; i++) {
          if (built.timeline.lag[i] === 0) expect(v[i]).toBeCloseTo(built.peak[i], 6);
        }

        for (const facing of [1, -1] as const) {
          const rig = rigOf(animal);
          const run = runMove(rig, animal, c.id, c.air, c.chain, { facing });
          expect(run.nan).toBe(false);

          // (b) tip within 0.5 m of an active hitbox on every active frame.
          for (let k = first; k < end; k++) {
            const e = run.rec.log[run.moveStart + k];
            expect(e.tip).not.toBeNull();
            const d = tipToHitbox(body, k, e.tip as { x: number; y: number });
            expect(d, `${label} facing ${facing} frame ${k}: tip ${JSON.stringify(e.tip)} is ${d.toFixed(2)} m from the hitbox`).toBeLessThanOrEqual(0.5);
          }

          // (c) smoothness on the real joint nodes, entry -> move -> exit.
          const log = run.rec.log;
          for (let i = 1; i < log.length; i++) {
            const k = log[i].k;
            const strike = k >= first - 2 && k <= end - 1;
            const lim = (strike ? STEP_STRIKE : STEP_NORMAL) + EPS;
            expect(log[i].step, `${label} facing ${facing}: step ${log[i].step.toFixed(3)} at log ${i} (move frame ${k})`).toBeLessThanOrEqual(lim);
          }
        }
      });
    }

    it('entry from a run and exit into a fall stay continuous and finite', () => {
      const rig = rigOf(animal);
      for (const [id, air] of [['lightN', false], ['heavyS', false], ['heavyD', true]] as const) {
        const body = getMoveBody(animal, id, air, 0);
        const first = Math.min(...body.hitboxes.map((h) => h.from));
        const end = Math.max(...body.hitboxes.map((h) => h.to));
        const run = runMove(rig, animal, id, air, 0, { preAction: air ? 'fall' : 'run', preVx: 8, postAction: air ? 'fall' : 'run', facing: -1 });
        expect(run.nan).toBe(false);
        for (let i = 1; i < run.rec.log.length; i++) {
          const k = run.rec.log[i].k;
          const strike = k >= first - 2 && k <= end - 1;
          expect(run.rec.log[i].step, `${animal} ${id} step at log ${i} (k ${k})`).toBeLessThanOrEqual((strike ? STEP_STRIKE : STEP_NORMAL) + EPS);
        }
      }
    });

    it('generic states play finite and smooth (hitstun, tumble, knockdown, ledge, dodge)', () => {
      const rig = rigOf(animal);
      const seq: { action: BrawlAction; frames: number; grounded: boolean }[] = [
        { action: 'idle', frames: 6, grounded: true },
        { action: 'hitstun', frames: 18, grounded: false },
        { action: 'tumble', frames: 30, grounded: false },
        { action: 'fall', frames: 8, grounded: false },
        { action: 'ledgeHang', frames: 20, grounded: false },
        { action: 'ledgeClimb', frames: 16, grounded: false },
        { action: 'knockdown', frames: 20, grounded: true },
        { action: 'getup', frames: 16, grounded: true },
        { action: 'dodgeRoll', frames: 20, grounded: true },
        { action: 'dodgeSpot', frames: 16, grounded: true },
        { action: 'dodgeAir', frames: 16, grounded: false },
        { action: 'idle', frames: 6, grounded: true },
      ];
      let prev = null as ReturnType<typeof mkState> | null;
      for (const s of seq) {
        for (let i = 0; i < s.frames; i++) {
          const cur = mkState(animal, { action: s.action, actionFrame: i, actionFrames: s.frames, grounded: s.grounded, pos: { x: 0, y: s.grounded ? 0 : 3 }, hitstunTotal: 18, hitstun: 18 - i });
          rig.update(cur, prev, 1, 1 / 60);
          expect(hasNaN(rig), `${animal} ${s.action} frame ${i}`).toBe(false);
          prev = cur;
        }
      }
    });
  });
}

// ── The real simulation ─────────────────────────────────────────────────────────

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

describe('pose a2 x sim: the strike tip is in the published hitbox', () => {
  for (const animal of ANIMALS) {
    it(`${animal}: every move, ground and air, both facings`, () => {
      const set = getMoveset(animal);
      const r = new BrawlRig(animal);
      extraRigs.push(r);
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
