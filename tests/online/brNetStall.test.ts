/**
 * v1.10.1 — the Battle Royale client under the failures behind the "100-5500 ms ping spikes" report: a frozen path followed by a
 * flood of stale + fresh packets, packet loss with jitter, and queueing behind a backed-up channel. The wire is modelled by
 * `netPipe.ts` (guard = the real `unreliableBlock` / `MAX_UNRELIABLE_BACKLOG`), the netcode is the real BrNetHost/BrNetClient on
 * the loopback harness with a real `World`.
 */

import { describe, expect, it } from 'vitest';
import { STALL_GAP_MS } from '../../src/online/br/BrNetClient';
import { MAX_UNRELIABLE_BACKLOG } from '../../src/online/transport/fastChannel';
import type { NetConditions } from '../../src/online/transport/loopback';
import { chaserScript, pctile, runSession, truthPose, TICK_MS, type Session } from './brNetHarness';
import { neutral } from './brTestUtil';
import { throttle, type Pipe, type PipeConfig } from './netPipe';

const LEGACY_BACKLOG = 64 * 1024;
const COUNTDOWN_MS = 3000; // the match clock starts after the countdown, so raw "lag" has this constant offset

interface Analysis {
  /** ms after `recoverAt` until the picture is within 0.6 m of the host's truth and < 450 ms old for 30 frames in a row; -1 never. */
  settleMs: number;
  /** Largest live lag (ms over the pre-stall lag) from `recoverAt + 600` on. */
  lagAfterMax: number;
  /** Largest extrapolation applied to any frame. */
  extrapMax: number;
  /** Frames from `recoverAt + 600` on whose render time advanced at < 0.7x or > 1.4x real time (rubber-banding / time dilation). */
  rateBreaks: number;
  /** Frames where the render time went backwards. */
  backwards: number;
  /** Largest per-frame move of any fighter's drawn position once the picture had settled (metres; host-side teleports excluded). */
  maxStepAfterSettle: number;
  /** Largest EMA ping the client / host ever reported (ms) and the largest raw sample. */
  clientPingMax: number;
  hostRttMax: number;
  rawPeakMax: number;
}

interface Extra {
  clientPingMax: number;
  hostRttMax: number;
  rawPeakMax: number;
}

function analyse(s: Session, stallFrom: number, recoverAt: number, extra: Extra): Analysis {
  const frames = s.frames[0];
  const pre = frames.filter((f) => (f.tick + 1) * TICK_MS < stallFrom && (f.tick + 1) * TICK_MS >= stallFrom - 1000);
  const baseLag = pre.length > 0 ? pre.reduce((a, f) => a + ((f.tick + 1) * TICK_MS - f.sample.renderTimeS * 1000), 0) / pre.length : COUNTDOWN_MS;
  let lagAfterMax = 0;
  let extrapMax = 0;
  let rateBreaks = 0;
  let backwards = 0;
  let settle = -1;
  let goodRun = 0;
  let maxStep = 0;
  let prevT = -1;
  let prevR = -Infinity; // the match clock starts at -3 s (countdown)
  const prevPos: Array<{ x: number; z: number } | null> = new Array(10).fill(null);
  for (const fr of frames) {
    const t = (fr.tick + 1) * TICK_MS;
    const R = fr.sample.renderTimeS * 1000;
    const lag = t - R - baseLag;
    extrapMax = Math.max(extrapMax, fr.sample.extrapolatedMs);
    if (R < prevR - 1e-6) backwards++;
    if (t >= recoverAt + 600) {
      lagAfterMax = Math.max(lagAfterMax, lag);
      if (prevT >= 0) {
        const rate = (R - prevR) / (t - prevT);
        if (rate < 0.7 || rate > 1.4) rateBreaks++;
      }
    }
    if (t >= recoverAt) {
      let worst = 0;
      for (const f of fr.sample.view.fighters) {
        const tp = truthPose(s.truth, f.id, fr.sample.renderTimeS);
        if (tp === null || !f.alive) continue;
        worst = Math.max(worst, Math.hypot(f.pos.x - tp.x, f.pos.z - tp.z));
      }
      if (worst < 0.6 && lag < 450) goodRun++;
      else goodRun = 0;
      if (settle < 0 && goodRun >= 30) settle = t - recoverAt - 30 * TICK_MS;
    }
    if (settle >= 0 && t >= recoverAt + settle + 300) {
      for (const f of fr.sample.view.fighters) {
        const pp = prevPos[f.id];
        if (pp === null) continue;
        // a blink / grab pull is a legitimate teleport: ignore steps the host itself made
        const tp0 = truthPose(s.truth, f.id, fr.sample.renderTimeS - 1 / 60);
        const tp1 = truthPose(s.truth, f.id, fr.sample.renderTimeS);
        const hostStep = tp0 !== null && tp1 !== null ? Math.hypot(tp1.x - tp0.x, tp1.z - tp0.z) : 0;
        if (hostStep < 0.5) maxStep = Math.max(maxStep, Math.hypot(f.pos.x - pp.x, f.pos.z - pp.z));
      }
    }
    for (const f of fr.sample.view.fighters) prevPos[f.id] = { x: f.pos.x, z: f.pos.z };
    prevT = t;
    prevR = R;
  }
  return { settleMs: settle, lagAfterMax, extrapMax, rateBreaks, backwards, maxStepAfterSettle: maxStep, ...extra };
}

interface StallRun {
  s: Session;
  a: Analysis;
  /** [host -> client, client -> host] */
  pipes: Pipe[];
}

/** Track the largest ping the client and the host ever REPORTED (EMA) and the largest raw sample, every tick. */
function pingTracker(): { onTick: (t: number, ses: Session) => void; get: () => Extra } {
  let clientPingMax = 0;
  let hostRttMax = 0;
  let rawPeakMax = 0;
  return {
    onTick: (_t, ses) => {
      const cs = ses.clients[0].stats();
      const hs = ses.host.clientStats(1);
      clientPingMax = Math.max(clientPingMax, cs.pingMs);
      hostRttMax = Math.max(hostRttMax, hs?.rttMs ?? 0);
      rawPeakMax = Math.max(rawPeakMax, cs.pingPeakMs, hs?.rttPeakMs ?? 0);
    },
    get: () => ({ clientPingMax, hostRttMax, rawPeakMax }),
  };
}

async function runStall(h2c: PipeConfig, c2h: PipeConfig, stallFrom: number, recoverAt: number, seconds = 20): Promise<StallRun> {
  const pipes: Pipe[] = [];
  const track = pingTracker();
  const s = await runSession({
    net: { latencyMs: 40, jitterMs: 10 },
    seconds,
    tamper: (h, cs, net) => {
      pipes.push(throttle(h, net, h2c));
      pipes.push(throttle(cs[0], net, c2h));
    },
    onTick: track.onTick,
  });
  for (const p of pipes) p.stop();
  return { s, a: analyse(s, stallFrom, recoverAt, track.get()), pipes };
}

const OUTAGE = { from: 5000, to: 8000 };

describe('stall + flood: 3 s freeze, then stale and fresh packets arrive together', () => {
  it('the legacy transport model (retransmit, 64 KB guard) reproduces the multi-second spikes', async () => {
    const cfg: PipeConfig = { mode: 'retransmit', maxBacklog: LEGACY_BACKLOG, rate: 60, recoverRate: 20, recoverMs: 3000, outages: [OUTAGE] };
    const { a, pipes } = await runStall(cfg, cfg, OUTAGE.from, OUTAGE.to);
    // the channel queued tens of kilobytes (seconds of snapshots) and the picture / pings lagged by seconds
    expect(pipes[0].stats.maxBuffered).toBeGreaterThan(20_000);
    expect(a.rawPeakMax).toBeGreaterThan(1500);
    expect(a.lagAfterMax).toBeGreaterThan(800);
  });

  it('instant flood (90 queued snapshots released at once): stale ones are dropped, never replayed; the picture is live immediately', async () => {
    const cfg: PipeConfig = { mode: 'retransmit', maxBacklog: Infinity, outages: [OUTAGE] };
    const { s, a, pipes } = await runStall(cfg, cfg, OUTAGE.from, OUTAGE.to);
    const st = s.clients[0].stats();
    expect(pipes[0].stats.delivered).toBeGreaterThan(80); // the whole backlog really did arrive in one go
    expect(st.stalls).toBe(1);
    expect(st.staleSnapshots).toBeGreaterThanOrEqual(10);
    expect(st.badPackets).toBe(0);
    expect(a.backwards).toBe(0);
    expect(a.extrapMax).toBeLessThanOrEqual(100 + 1e-6);
    expect(a.settleMs).toBeGreaterThanOrEqual(0);
    expect(a.settleMs).toBeLessThan(400);
    expect(a.lagAfterMax).toBeLessThan(80); // not 3 s behind, not draining history at 1x
    expect(a.rateBreaks).toBe(0);
    expect(a.maxStepAfterSettle).toBeLessThan(1.0);
    expect(st.resyncs).toBeLessThanOrEqual(1);
    // the queued pings come back all at once: the shown round trip stays far below the 3 s they waited
    expect(a.clientPingMax).toBeLessThan(1000);
    expect(a.hostRttMax).toBeLessThan(1000);
  });

  it('during the freeze the client holds still after at most 100 ms of extrapolation instead of drifting off on stale velocities', async () => {
    const cfg: PipeConfig = { mode: 'abandon', maxBacklog: MAX_UNRELIABLE_BACKLOG, outages: [OUTAGE] };
    const { s, a } = await runStall(cfg, cfg, OUTAGE.from, OUTAGE.to);
    expect(a.extrapMax).toBeLessThanOrEqual(100 + 1e-6);
    const during = s.frames[0].filter((f) => {
      const t = (f.tick + 1) * TICK_MS;
      return t > OUTAGE.from + 600 && t < OUTAGE.to - 100;
    });
    expect(during.length).toBeGreaterThan(100);
    const first = during[0].sample.view.fighters.map((f) => ({ x: f.pos.x, z: f.pos.z }));
    for (const fr of during) {
      fr.sample.view.fighters.forEach((f, i) => {
        expect(Math.hypot(f.pos.x - first[i].x, f.pos.z - first[i].z)).toBeLessThan(1e-6);
      });
    }
  });

  it('maxRetransmits:0 (abandon) with a pure 3 s outage: nothing is queued, so there is no flood and recovery is instant', async () => {
    const cfg: PipeConfig = { mode: 'abandon', maxBacklog: MAX_UNRELIABLE_BACKLOG, outages: [OUTAGE] };
    const { s, a, pipes } = await runStall(cfg, cfg, OUTAGE.from, OUTAGE.to);
    const st = s.clients[0].stats();
    expect(pipes[0].stats.wireLost).toBeGreaterThan(80);
    expect(pipes[0].stats.maxBuffered).toBeLessThan(2000);
    expect(st.stalls).toBe(1);
    expect(st.staleSnapshots).toBe(0);
    expect(a.settleMs).toBeLessThan(150);
    expect(a.lagAfterMax).toBeLessThan(30);
    expect(a.rateBreaks).toBe(0);
    expect(st.resyncs).toBe(0);
    expect(a.clientPingMax).toBeLessThan(400);
    expect(a.hostRttMax).toBeLessThan(400);
  });

  it('bounded flood (8 KB guard, then a 1 s retransmission-timer stall): the little stale data that arrives is dropped, pings stay under 1 s', async () => {
    const rto = 1000;
    const cfg: PipeConfig = { mode: 'abandon', maxBacklog: MAX_UNRELIABLE_BACKLOG, rate: 60, rtoStallMs: rto, outages: [OUTAGE] };
    const { s, a, pipes } = await runStall(cfg, cfg, OUTAGE.from, OUTAGE.to + rto + 200);
    const st = s.clients[0].stats();
    // the guard refused what would have piled up, and the queue never grew past its limit (+ one packet)
    expect(pipes[0].stats.guardDrops).toBeGreaterThan(0);
    expect(pipes[0].stats.maxBuffered).toBeLessThanOrEqual(MAX_UNRELIABLE_BACKLOG + 1500);
    expect(st.stalls).toBe(1);
    expect(st.staleSnapshots).toBeGreaterThanOrEqual(2);
    expect(a.backwards).toBe(0);
    expect(a.extrapMax).toBeLessThanOrEqual(100 + 1e-6);
    expect(a.settleMs).toBeLessThan(500);
    expect(a.lagAfterMax).toBeLessThan(80);
    expect(a.rateBreaks).toBe(0);
    expect(st.resyncs).toBeLessThanOrEqual(2);
    // ping spike behaviour: queueing is bounded by the guard, so the reported round trip never includes seconds of it
    expect(a.clientPingMax).toBeLessThan(1000);
    expect(a.hostRttMax).toBeLessThan(1000);
  });

  it('queueing delay is bounded by guard / wire speed: 8 KB is a fraction of what 64 KB was when the wire slows down', async () => {
    const normal = 40; // bytes per ms (40 KB/s) — comfortably above the ~10 KB/s snapshot stream
    const slow = { from: 5000, to: 9000, rate: 4 }; // a 4 s overload: the wire drops to 4 KB/s
    const run = async (backlog: number, mode: PipeConfig['mode']): Promise<{ maxBuffered: number; peak: number }> => {
      const pipes: Pipe[] = [];
      const track = pingTracker();
      await runSession({
        net: { latencyMs: 40, jitterMs: 10 },
        seconds: 16,
        tamper: (h, cs, net) => {
          const hostCfg: PipeConfig = { mode, maxBacklog: backlog, rate: normal };
          pipes.push(throttle(h, net, hostCfg));
          pipes.push(throttle(cs[0], net, { mode, maxBacklog: backlog, rate: normal }));
          net.schedule(slow.from, () => (hostCfg.rate = slow.rate));
          net.schedule(slow.to, () => (hostCfg.rate = normal));
        },
        onTick: track.onTick,
      });
      for (const p of pipes) p.stop();
      return { maxBuffered: pipes[0].stats.maxBuffered, peak: track.get().rawPeakMax };
    };
    const old = await run(LEGACY_BACKLOG, 'retransmit');
    const fresh = await run(MAX_UNRELIABLE_BACKLOG, 'abandon');
    expect(fresh.maxBuffered).toBeLessThanOrEqual(MAX_UNRELIABLE_BACKLOG + 1500);
    expect(old.maxBuffered).toBeGreaterThan(MAX_UNRELIABLE_BACKLOG * 1.5);
    expect(fresh.maxBuffered / slow.rate).toBeLessThan(2500); // 8 KB at 4 KB/s = 2 s is the worst case of the guard
    expect(fresh.peak).toBeLessThan(old.peak);
  });
});

// ── loss + jitter ───────────────────────────────────────────────────────────────

describe('packet loss with jitter (the real unreliable behaviour: dropped, never retransmitted)', () => {
  const SECONDS = 33;
  const QUIET_TICKS = 120;
  const quiet: typeof chaserScript = (c, tick, truth, slot, r) =>
    tick >= Math.ceil((SECONDS * 1000) / TICK_MS) - QUIET_TICKS ? neutral() : chaserScript(c, tick, truth, slot, r);

  async function lossRun(cond: Partial<NetConditions>, seed: number) {
    const s = await runSession({ net: cond, netSeed: seed, script: quiet, seconds: SECONDS });
    const errs: number[] = [];
    let extrapMax = 0;
    let backwards = 0;
    let prevR = -Infinity;
    for (const fr of s.frames[0]) {
      extrapMax = Math.max(extrapMax, fr.sample.extrapolatedMs);
      const R = fr.sample.renderTimeS;
      if (R < prevR - 1e-9) backwards++;
      prevR = R;
      if (fr.tick < 300) continue;
      for (const f of fr.sample.view.fighters) {
        const tp = truthPose(s.truth, f.id, fr.sample.renderTimeS);
        if (tp !== null && f.alive) errs.push(Math.hypot(f.pos.x - tp.x, f.pos.y - tp.y, f.pos.z - tp.z));
      }
    }
    const pings = s.statsLog[0].map((x) => x.pingMs).filter((x) => x > 0);
    const hs = s.host.clientStats(1);
    return { s, p50: pctile(errs, 0.5), p95: pctile(errs, 0.95), extrapMax, backwards, pings, hs, st: s.clients[0].stats() };
  }

  it('5% loss, 50 ms +- 30 ms: smooth picture, bounded extrapolation, no spurious stall recovery, no lost edges', async () => {
    const r = await lossRun({ latencyMs: 50, jitterMs: 30, loss: 0.05, duplicate: 0.02 }, 11);
    expect(r.p50).toBeLessThan(0.05);
    expect(r.p95).toBeLessThan(0.12);
    expect(r.extrapMax).toBeLessThanOrEqual(100 + 1e-6);
    expect(r.backwards).toBe(0);
    expect(r.st.stalls).toBe(0);
    expect(r.st.staleSnapshots).toBe(0);
    expect(r.st.resyncs).toBe(0);
    expect(r.st.badPackets).toBe(0);
    expect(Math.max(...r.pings)).toBeLessThan(400);
    expect(r.st.pingPeakMs).toBeLessThan(400); // jitter alone is no spike
    expect(r.hs?.intent.edgesDropped).toBe(0);
    const pressed = r.s.pressed[0];
    expect(r.hs?.intent.edgesConsumed).toBe(pressed.attack + pressed.special + pressed.ultimate);
  });

  it('15% loss, 50 ms +- 40 ms: still smooth, still no replay, edges still exactly once', async () => {
    const r = await lossRun({ latencyMs: 50, jitterMs: 40, loss: 0.15, duplicate: 0.03 }, 23);
    expect(r.p50).toBeLessThan(0.06);
    expect(r.p95).toBeLessThan(0.2);
    expect(r.extrapMax).toBeLessThanOrEqual(100 + 1e-6);
    expect(r.backwards).toBe(0);
    expect(r.st.stalls).toBe(0);
    expect(r.st.staleSnapshots).toBe(0);
    expect(r.st.badPackets).toBe(0);
    expect(Math.max(...r.pings)).toBeLessThan(500);
    expect(r.st.loss).toBeGreaterThan(0.03); // the loss is really there
    expect(r.hs?.intent.edgesDropped).toBe(0);
    const pressed = r.s.pressed[0];
    expect(r.hs?.intent.edgesConsumed).toBe(pressed.attack + pressed.special + pressed.ultimate);
  });

  it('the stall detector needs a >= 400 ms silence (12 snapshots in a row), far beyond ordinary 15% loss', () => {
    expect(STALL_GAP_MS).toBeGreaterThanOrEqual(12 * (1000 / 30) - 1);
  });
});
