import { describe, expect, it } from 'vitest';
import { BrawlWorld } from '../../src/brawl/sim/BrawlWorld';
import { quantizeIntent, unpackIntent } from '../../src/brawl/net/inputCodec';
import type { BrawlEvent, BrawlMatchConfig } from '../../src/brawl/types';
import { STAGE_IDS } from '../../src/brawl/types';
import { Mesh, hammerIntent, makeConfig, runReference, scriptIntent, truthFor } from './netHelpers';
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

// v1.6: the acceptance matrix runs on EVERY stage — the original two plus the two dynamic ones (moving solid platform / breakables).
describe('rollback netcode: confirmed states match across peers and the reference sim', () => {
  for (const stage of STAGE_IDS) {
    for (const c of CASES) {
      for (const n of [2, 3, 4]) {
        it(`${stage}: ${n} peers, ${c.name}`, async () => {
          const seed = 4242 + n;
          const delay = 2;
          const mesh = await Mesh.create({
            n,
            seed,
            stage,
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
          const ref = runReference(makeConfig(n, stage), seed, Math.max(...cps) + 1, truth, cps);
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
  }
});

// ── a demolition match: things break and the stage flips to its final form INSIDE the rollback window ──────────────────

const BREAK_CONFIG = (n: number): BrawlMatchConfig => makeConfig(n, 'crumblingAmphitheatre');

/** The frame the reference sim (true input log) flips the stage to its final form, or −1 within `limit` frames. */
function referenceFinal(n: number, seed: number, delay: number, limit: number): { final: number; breaks: number; hits: number } {
  const w = new BrawlWorld(BREAK_CONFIG(n), seed);
  const truth = truthFor(delay, (slot, frame) => hammerIntent(seed, slot, frame));
  const base = quantizeIntent({ moveX: 0, moveY: 0, jump: false, jumpHeld: false, light: false, heavy: false, dodge: false });
  let final = -1;
  let breaks = 0;
  let hits = 0;
  for (let f = 0; f < limit && final < 0; f++) {
    for (let p = 0; p < n; p++) w.setIntent(p, unpackIntent(truth(p, f), base));
    w.step();
    for (const e of w.drainEvents()) {
      if (e.type === 'stageFinal') final = w.frame;
      else if (e.type === 'platformBreak') breaks++;
      else if (e.type === 'platformHit') hits++;
    }
  }
  return { final, breaks, hits };
}

/** A demolition seed (from a short candidate list, then a scan) whose final form arrives between frames 400 and 2900. */
function breakerSeed(n: number, delay: number): number {
  const candidates = [13, 15, 3, 22, 30, 18, 33, 38, 54, 57, 26];
  for (let s = 1; s <= 120; s++) candidates.push(s);
  for (const seed of candidates) {
    const r = referenceFinal(n, seed, delay, 2900);
    if (r.final >= 400) return seed;
  }
  throw new Error(`no demolition seed found for ${n} players`);
}

describe('rollback netcode: the stage flips to its final form inside the rollback window', () => {
  class TapWorld extends BrawlWorld {
    /** Raw (pre-dedupe) number of times each event type left the sim, re-simulations after a rollback included. */
    readonly drained = { platformHit: 0, platformBreak: 0, stageFinal: 0 };
    override drainEvents(): BrawlEvent[] {
      const ev = super.drainEvents();
      for (const e of ev) if (e.type === 'platformHit' || e.type === 'platformBreak' || e.type === 'stageFinal') this.drained[e.type]++;
      return ev;
    }
  }

  for (const n of [2, 3, 4]) {
    it(`${n} peers, lossy network: breaks, final form and checksums agree with the true-input reference`, async () => {
      const delay = 2;
      const seed = breakerSeed(n, delay);
      const ref = referenceFinal(n, seed, delay, 2900);
      expect(ref.final).toBeGreaterThanOrEqual(400);
      expect(ref.breaks).toBe(6);
      const frames = ref.final + 500;
      const taps: TapWorld[] = [];
      const mesh = await Mesh.create({
        n,
        seed,
        stage: 'crumblingAmphitheatre',
        cond: { latencyMs: 60, jitterMs: 50, loss: 0.08 },
        netSeed: 31 * n,
        drift: [0, 0.004, -0.003, 0.006].slice(0, n),
        script: (slot, frame) => hammerIntent(seed, slot, frame),
        session: (slot) => ({
          record: true,
          checksumInterval: 10,
          adaptiveDelay: false,
          inputDelay: delay,
          createWorld: (cfg: BrawlMatchConfig, s: number) => {
            const w = new TapWorld(cfg, s);
            taps[slot] = w;
            return w;
          },
        }),
      });
      mesh.runFrames(frames);
      mesh.settle(1500);
      const sessions = mesh.peers.map((p) => p.session);
      for (const s of sessions) {
        expect(s.isDesynced).toBe(false);
        expect(s.frame).toBeGreaterThanOrEqual(frames);
      }
      // the real sim saw the final form, and (somewhere) a rollback re-simulated the frame it happened on
      let resimulated = 0;
      for (let slot = 0; slot < n; slot++) {
        expect(taps[slot].drained.stageFinal, `peer ${slot} reached the final form`).toBeGreaterThanOrEqual(1);
        resimulated += taps[slot].drained.stageFinal - 1;
        // ... but the session delivered it exactly once (rollbacks never replay an event)
        expect(mesh.events[slot].filter((e) => e.type === 'stageFinal'), `peer ${slot} stageFinal deliveries`).toHaveLength(1);
        expect(mesh.events[slot].filter((e) => e.type === 'platformBreak'), `peer ${slot} platformBreak deliveries`).toHaveLength(6);
        expect(mesh.events[slot].filter((e) => e.type === 'platformHit'), `peer ${slot} platformHit deliveries`).toHaveLength(ref.hits);
        expect(mesh.events[slot].find((e) => e.type === 'stageFinal')!.frame).toBeGreaterThan(180);
      }
      expect(resimulated, 'the final form frame was re-simulated by at least one rollback').toBeGreaterThan(0);
      expect(sessions.reduce((a, s) => a + s.stats.rollbacks, 0)).toBeGreaterThan(20);

      // identical confirmed checksums across the peers AND equal to the reference, before and after the flip
      const first = sessions[0].recordedChecksums();
      for (let i = 1; i < sessions.length; i++) {
        const other = sessions[i].recordedChecksums();
        let common = 0;
        for (const [f, sum] of first) {
          const o = other.get(f);
          if (o === undefined) continue;
          common++;
          expect(o, `frame ${f} peer ${i}`).toBe(sum);
        }
        expect(common).toBeGreaterThan(100);
      }
      const cps = new Set<number>(first.keys());
      const truth = truthFor(delay, (slot, frame) => hammerIntent(seed, slot, frame));
      const refSums = runReference(BREAK_CONFIG(n), seed, Math.max(...cps) + 1, truth, cps);
      let before = 0;
      let after = 0;
      for (const [f, sum] of first) {
        const r = refSums.get(f);
        if (r === undefined) continue;
        expect(sum, `reference frame ${f}`).toBe(r);
        if (f < ref.final) before++;
        else after++;
      }
      expect(before).toBeGreaterThan(30);
      expect(after).toBeGreaterThan(20);
    }, 180000);
  }
});
