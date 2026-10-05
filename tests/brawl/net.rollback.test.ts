import { describe, expect, it } from 'vitest';
import { Mesh, makeConfig, runReference, scriptIntent, truthFor } from './netHelpers';
import type { NetConditions } from '../../src/online/transport/loopback';

interface Case {
  name: string;
  cond: Partial<NetConditions>;
  frames: number;
}

const CASES: Case[] = [
  { name: 'perfect network', cond: {}, frames: 3000 },
  { name: '80 ms +-30 jitter, 5% loss', cond: { latencyMs: 50, jitterMs: 60, loss: 0.05 }, frames: 3000 },
  { name: '150 ms, 10% loss', cond: { latencyMs: 150, jitterMs: 20, loss: 0.1 }, frames: 3000 },
];

describe('rollback netcode: confirmed states match across peers and the reference sim', () => {
  for (const c of CASES) {
    for (const n of [2, 3, 4]) {
      it(`${n} peers, ${c.name}`, async () => {
        const seed = 4242 + n;
        const delay = 2;
        const mesh = await Mesh.create({
          n,
          seed,
          cond: c.cond,
          netSeed: 11 * n,
          drift: [0, 0.004, -0.003, 0.006].slice(0, n),
          session: () => ({ record: true, checksumInterval: 10, adaptiveDelay: false, inputDelay: delay }),
        });
        mesh.runFrames(c.frames);
        mesh.settle(1500);
        const sessions = mesh.peers.map((p) => p.session);
        for (const s of sessions) expect(s.isDesynced).toBe(false);
        // every peer reached the target
        for (const s of sessions) expect(s.frame).toBeGreaterThanOrEqual(c.frames);

        // 1. identical confirmed checksums across peers
        const first = sessions[0].recordedChecksums();
        expect(first.size).toBeGreaterThan(200);
        for (let i = 1; i < sessions.length; i++) {
          const other = sessions[i].recordedChecksums();
          let common = 0;
          for (const [f, sum] of first) {
            const o = other.get(f);
            if (o === undefined) continue;
            common++;
            expect(o, `frame ${f} peer ${i}`).toBe(sum);
          }
          expect(common).toBeGreaterThan(200);
        }

        // 2. equal to a single reference sim fed the true input log
        const cps = new Set<number>(first.keys());
        const truth = truthFor(delay, (slot, frame) => scriptIntent(seed, slot, frame));
        const ref = runReference(makeConfig(n), seed, Math.max(...cps) + 1, truth, cps);
        let compared = 0;
        for (const [f, sum] of first) {
          const r = ref.get(f);
          if (r === undefined) continue;
          compared++;
          expect(sum, `reference frame ${f}`).toBe(r);
        }
        expect(compared).toBeGreaterThan(200);

        // 3. the confirmed input record is the true log
        for (let slot = 0; slot < n; slot++) {
          const rec = sessions[0].recordedInputs(slot);
          expect(rec.length).toBeGreaterThan(c.frames - 50);
          for (let f = 0; f < rec.length; f += 7) expect(rec[f], `input slot ${slot} frame ${f}`).toBe(truth(slot, f));
        }

        // sanity: the scenario exercised the netcode
        if (c.cond.loss !== undefined && c.cond.loss > 0) {
          expect(sessions.reduce((a, s) => a + s.stats.rollbacks, 0)).toBeGreaterThan(0);
        }
        for (const s of sessions) expect(s.stats.maxRollbackDepth).toBeLessThanOrEqual(24);
        for (const p of mesh.peers) expect(mesh.events[p.slot].length).toBeGreaterThan(0);
      }, 120000);
    }
  }
});
