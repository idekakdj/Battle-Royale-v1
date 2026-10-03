/**
 * Pose layer acceptance (plan §6, WP-A1): for lion + gorilla, every move x ground/air x chain body:
 *  (a) the peak pose lands on the first active frame,
 *  (b) the strike tip is inside / within 0.5 m of the move's hitbox on every active frame,
 *  (c) no joint rotates more than 0.5 rad per 60 Hz frame (0.9 on the strike frames), including entry / exit with idle / fall,
 *  (d) no NaN.
 */

import { afterAll, describe, expect, it } from 'vitest';
import type { AnimalId } from '../../src/core/types';
import { ANIMAL_IDS } from '../../src/config/animals';
import { MOVE_IDS, type MoveId } from '../../src/brawl/types';
import { getMoveBody, getMoveset } from '../../src/brawl/data';
import { BrawlRig } from '../../src/brawl/render/pose/BrawlRig';
import { getBuilt, STEP_NORMAL, STEP_STRIKE } from '../../src/brawl/render/pose/build';
import { disposeSolvers } from '../../src/brawl/render/pose/solver';
import { runMove, tipToHitbox } from './poseHelpers';

const ANIMALS: AnimalId[] = ['lion', 'gorilla'];
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
afterAll(() => {
  for (const r of rigs.values()) r.dispose();
  disposeSolvers();
});

for (const animal of ANIMALS) {
  describe(`pose moves: ${animal}`, () => {
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
  });
}

// The other eight animals render through the auto-generated generic profile until WP-A2 / WP-A3 write theirs: every move must
// at least play finite and inside the angular budget (tip fidelity is checked per animal when their profiles land).
for (const animal of ANIMAL_IDS.filter((a) => !ANIMALS.includes(a))) {
  describe(`pose moves (generic profile): ${animal}`, () => {
    it('every move x ground/air x chain plays finite and smooth', () => {
      for (const c of casesOf(animal)) {
        const body = getMoveBody(animal, c.id, c.air, c.chain);
        const first = Math.min(...body.hitboxes.map((h) => h.from));
        const end = Math.max(...body.hitboxes.map((h) => h.to));
        const run = runMove(rigOf(animal), animal, c.id, c.air, c.chain, { facing: c.chain % 2 === 0 ? 1 : -1 });
        const label = `${animal} ${c.id}${c.air ? ' air' : ''}${c.chain ? ` chain${c.chain}` : ''}`;
        expect(run.nan, label).toBe(false);
        for (let i = 1; i < run.rec.log.length; i++) {
          const k = run.rec.log[i].k;
          const strike = k >= first - 2 && k <= end - 1;
          expect(run.rec.log[i].step, `${label}: step at log ${i}`).toBeLessThanOrEqual((strike ? STEP_STRIKE : STEP_NORMAL) + EPS);
        }
      }
    });
  });
}
