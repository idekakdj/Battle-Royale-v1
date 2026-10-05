import { beforeAll, describe, expect, it } from 'vitest';
import type { GameEvent } from '../../src/core/types';
import { swapSample } from '../../src/online/br/BrNetClient';
import { chaserScript, pctile, runSession, truthPose, type Session, TICK_MS } from './brNetHarness';
import { neutral } from './brTestUtil';

const SECONDS = 63; // 3 s countdown + 60 s fight
const QUIET_TICKS = 120; // no presses in the last 2 s so every edge has time to arrive

interface Metrics {
  frames: number;
  firstFrameTick: number;
  err: { p50: number; p95: number; p99: number; max: number };
  /** frames in which a non-blinking fighter moved by more than the plausible stride */
  snaps: number;
  maxStepRatio: number;
  starvedFrames: number;
  edgesPressed: number;
  edgesConsumed: number;
  edgesDropped: number;
  eventsTruth: number;
  eventsReleased: number;
  eventsInOrder: boolean;
  eventsEarly: number;
  eventsLateMaxMs: number;
  hostKBpsOutAvg: number;
  hostBytesPerSnapshotAvg: number;
  clientKBpsOutAvg: number;
  stats: ReturnType<Session['clients'][number]['stats']>;
}

const sig = (e: GameEvent): string => {
  const o = e as unknown as Record<string, unknown>;
  const ids = Object.keys(o)
    .filter((k) => /Id$/.test(k) || k === 'type' || k === 'placement')
    .sort()
    .map((k) => `${k}=${String(o[k])}`);
  return ids.join(',');
};

function measure(s: Session, ci = 0): Metrics {
  const frames = s.frames[ci];
  const slot = s.slots[ci];
  // Blink windows (host sim time) per fighter.
  const blinks: Array<{ id: number; t: number }> = [];
  s.truthEvents.forEach((evs, k) => evs.forEach((e) => e.type === 'blink' && blinks.push({ id: e.fighterId, t: s.truth[k].time })));
  // Sim-level discontinuities WITHOUT a blink event (e.g. a grabbed fighter pulled to its captor) also count as teleports:
  // a single 1/60 s tick displacement above 1.2 m (72 m/s) is not locomotion.
  for (let k = 1; k < s.truth.length; k++) {
    for (let id = 0; id < 10; id++) {
      const a = s.truth[k - 1].fighters[id].pos;
      const b = s.truth[k].fighters[id].pos;
      if (Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) > 1.2) blinks.push({ id, t: s.truth[k].time });
    }
  }
  const nearBlink = (id: number, t: number, w = 0.2): boolean => blinks.some((b) => b.id === id && Math.abs(b.t - t) <= w);

  // Per-fighter fastest legitimate per-tick stride (excluding blink ticks).
  const maxSpeed = new Array(10).fill(0);
  for (let k = 1; k < s.truth.length; k++) {
    for (let id = 0; id < 10; id++) {
      if (nearBlink(id, s.truth[k].time, 0.05)) continue;
      const a = s.truth[k - 1].fighters[id].pos;
      const b = s.truth[k].fighters[id].pos;
      maxSpeed[id] = Math.max(maxSpeed[id], Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / (1 / 60));
    }
  }

  const errs: number[] = [];
  let snaps = 0;
  let maxStepRatio = 0;
  let prevPos: Array<{ x: number; y: number; z: number; t: number } | null> = new Array(10).fill(null);
  for (const fr of frames) {
    const v = fr.sample.view;
    for (const f of v.fighters) {
      const t = fr.sample.renderTimeS;
      const tp = truthPose(s.truth, f.id, t);
      if (tp !== null && !nearBlink(f.id, t, 0.25) && f.alive) {
        errs.push(Math.hypot(f.pos.x - tp.x, f.pos.y - tp.y, f.pos.z - tp.z));
      }
      const pp = prevPos[f.id];
      if (pp !== null && !nearBlink(f.id, t, 0.25)) {
        const step = Math.hypot(f.pos.x - pp.x, f.pos.y - pp.y, f.pos.z - pp.z);
        const dtS = Math.max(1e-3, t - pp.t);
        // allowed: the fastest the fighter ever really moved (+ clock slew / extrapolation slack) over the elapsed host time
        const allowed = maxSpeed[f.id] * dtS * 1.25 + 0.06;
        maxStepRatio = Math.max(maxStepRatio, step / allowed);
        if (step > allowed) snaps++;
      }
      prevPos[f.id] = { x: f.pos.x, y: f.pos.y, z: f.pos.z, t };
    }
  }

  // Events.
  const truthEvents: Array<{ e: GameEvent; t: number }> = [];
  s.truthEvents.forEach((evs, k) => evs.forEach((e) => truthEvents.push({ e, t: s.truth[k].time })));
  const rel = s.released[ci];
  let inOrder = rel.length > 0 || truthEvents.length === 0;
  let early = 0;
  let lateMax = 0;
  const n = Math.min(rel.length, truthEvents.length);
  for (let i = 0; i < n; i++) {
    if (sig(rel[i].ev) !== sig(truthEvents[i].e)) inOrder = false;
    const dt = (rel[i].renderTimeS - truthEvents[i].t) * 1000;
    if (dt < -1) early++;
    lateMax = Math.max(lateMax, dt);
  }

  const hs = s.host.clientStats(slot);
  const seconds = s.truth.length / 60;
  const snapsSent = hs?.snapshotsSent ?? 1;
  const cs = s.clients[ci].stats();
  const pressed = s.pressed[ci];
  return {
    frames: frames.length,
    firstFrameTick: frames.length > 0 ? frames[0].tick : -1,
    err: { p50: pctile(errs, 0.5), p95: pctile(errs, 0.95), p99: pctile(errs, 0.99), max: Math.max(0, ...errs) },
    snaps,
    maxStepRatio,
    starvedFrames: cs.starvedFrames,
    edgesPressed: pressed.attack + pressed.special + pressed.ultimate,
    edgesConsumed: hs?.intent.edgesConsumed ?? -1,
    edgesDropped: hs?.intent.edgesDropped ?? -1,
    eventsTruth: truthEvents.length,
    eventsReleased: rel.length,
    eventsInOrder: inOrder,
    eventsEarly: early,
    eventsLateMaxMs: lateMax,
    hostKBpsOutAvg: (hs?.bytesOut ?? 0) / 1000 / seconds,
    hostBytesPerSnapshotAvg: (hs?.bytesOut ?? 0) / snapsSent,
    clientKBpsOutAvg: (cs.kBpsOut),
    stats: cs,
  };
}

const quietScript: typeof chaserScript = (c, tick, truth, slot, r) => (tick >= Math.ceil((SECONDS * 1000) / TICK_MS) - QUIET_TICKS ? neutral() : chaserScript(c, tick, truth, slot, r));

function show(name: string, m: Metrics): void {
  console.log(
    `[BR net ${name}] frames=${m.frames} first@${m.firstFrameTick} err p50=${m.err.p50.toFixed(3)} p95=${m.err.p95.toFixed(3)} p99=${m.err.p99.toFixed(3)} max=${m.err.max.toFixed(3)} m | snaps=${m.snaps} maxStepRatio=${m.maxStepRatio.toFixed(2)} starved=${m.starvedFrames} | edges ${m.edgesConsumed}/${m.edgesPressed} dropped=${m.edgesDropped} | events ${m.eventsReleased}/${m.eventsTruth} early=${m.eventsEarly} lateMax=${m.eventsLateMaxMs.toFixed(0)}ms | host ${m.hostKBpsOutAvg.toFixed(1)} KB/s out, ${m.hostBytesPerSnapshotAvg.toFixed(0)} B/snap | client ${m.clientKBpsOutAvg.toFixed(2)} KB/s out | ping=${m.stats.pingMs.toFixed(0)} jitter=${m.stats.jitterMs.toFixed(1)} loss=${(m.stats.loss * 100).toFixed(1)}% delay=${m.stats.interpDelayMs.toFixed(0)}ms resyncs=${m.stats.resyncs} bad=${m.stats.badPackets} dupSnap=${m.stats.duplicateSnapshots} dupEv=${m.stats.duplicateEvents} gaps=${m.stats.eventGaps}`,
  );
}

describe('BR host/client over LoopbackNetwork', () => {
  const runs: Record<string, { s: Session; m: Metrics }> = {};

  beforeAll(async () => {
    const scenarios: Array<[string, Parameters<typeof runSession>[0]]> = [
      ['perfect', { net: {}, script: quietScript, seconds: SECONDS }],
      ['60ms+-20 5% loss', { net: { latencyMs: 60, jitterMs: 20, loss: 0.05, duplicate: 0.02 }, script: quietScript, seconds: SECONDS }],
      ['150ms 10% loss', { net: { latencyMs: 150, jitterMs: 30, loss: 0.1, duplicate: 0.02 }, netSeed: 7, script: quietScript, seconds: SECONDS }],
    ];
    for (const [name, o] of scenarios) {
      const s = await runSession(o);
      const m = measure(s);
      show(name, m);
      runs[name] = { s, m };
    }
  }, 120000);

  describe.each(['perfect', '60ms+-20 5% loss', '150ms 10% loss'])('%s', (name) => {
    it('starts rendering within a second and keeps rendering', () => {
      const { m, s } = runs[name];
      expect(m.firstFrameTick).toBeGreaterThanOrEqual(0);
      expect(m.firstFrameTick).toBeLessThan(120);
      expect(m.frames).toBeGreaterThan(s.truth.length - 130);
      expect(s.clients[0].stats().badPackets).toBe(0);
    });

    it('never loses or doubles an edge', () => {
      const { m } = runs[name];
      expect(m.edgesPressed).toBeGreaterThan(30);
      expect(m.edgesDropped).toBe(0);
      expect(m.edgesConsumed).toBe(m.edgesPressed);
    });

    it('delivers every event exactly once, in order, never before its host timestamp', () => {
      const { m } = runs[name];
      expect(m.eventsTruth).toBeGreaterThan(50);
      expect(m.eventsReleased).toBe(m.eventsTruth);
      expect(m.eventsInOrder).toBe(true);
      expect(m.eventsEarly).toBe(0);
      expect(m.stats.eventGaps).toBe(0);
    });

    it('stays inside the bandwidth budget (host -> client, 30 Hz)', () => {
      const { m } = runs[name];
      expect(m.hostBytesPerSnapshotAvg).toBeLessThanOrEqual(1200);
      expect(m.hostKBpsOutAvg).toBeLessThanOrEqual(36 + 4); // 30 snapshots x 1.2 KB + events/pings
      expect(m.clientKBpsOutAvg).toBeLessThanOrEqual(1.5); // 60 x 13 B intents + pings
    });
  });

  it('perfect network: the rendered view tracks the host closely', () => {
    const { m } = runs['perfect'];
    expect(m.err.p95).toBeLessThan(0.05);
    expect(m.err.max).toBeLessThan(1.0);
    expect(m.snaps).toBe(0);
    expect(m.starvedFrames).toBe(0);
  });

  it('60 ms +- 20 ms, 5% loss: rendered positions stay within the stated bound and nothing snaps', () => {
    const { m } = runs['60ms+-20 5% loss'];
    // error = distance between what the client draws at render time R and where the host's fighter really was at sim time R
    expect(m.err.p50).toBeLessThan(0.05);
    expect(m.err.p95).toBeLessThan(0.1);
    expect(m.err.max).toBeLessThan(1.0);
    expect(m.snaps).toBe(0);
    expect(m.stats.resyncs).toBe(0);
  });

  it('150 ms, 10% loss: still smooth (bounded error, no snaps)', () => {
    const { m } = runs['150ms 10% loss'];
    expect(m.err.p95).toBeLessThan(0.15);
    expect(m.err.max).toBeLessThan(1.5);
    expect(m.snaps).toBe(0);
  });

  it('exposes sane diagnostics (sampled mid-fight)', () => {
    const { s } = runs['60ms+-20 5% loss'];
    const mid = s.statsLog[0][30];
    expect(mid.pingMs).toBeGreaterThan(100);
    expect(mid.pingMs).toBeLessThan(220);
    expect(mid.loss).toBeLessThan(0.2);
    expect(mid.snapshotsPerSec).toBeGreaterThan(20);
    expect(mid.snapshotsPerSec).toBeLessThan(32);
    expect(mid.interpDelayMs).toBeGreaterThan(60);
    expect(mid.interpDelayMs).toBeLessThan(260);
    expect(mid.kBpsIn).toBeLessThan(36);
    expect(mid.bufferDepthMs).toBeGreaterThan(0);
  });

  it('swapSample puts the local player at id 0', () => {
    const { s } = runs['perfect'];
    const fr = s.frames[0][s.frames[0].length - 1].sample;
    const sw = swapSample(fr, 0, s.slots[0]);
    expect(sw.view.fighters[0].animal).toBe(fr.view.fighters[s.slots[0]].animal);
    expect(sw.view.fighters.map((f) => f.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
