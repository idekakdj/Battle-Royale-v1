import { afterEach, describe, expect, it } from 'vitest';
import { NetDiag, type LinkProbe } from '../../src/online/netDiag';
import {
  DIAG_RING_SIZE,
  DiagRing,
  extractPathStats,
  formatDiagLine,
  formatDiagSummary,
  makeSample,
  pathLabel,
  worstSample,
  type LinkDiagInfo,
} from '../../src/online/netDiagModel';
import { PingEstimator } from '../../src/online/br/pingEstimator';
import { describeLink, formatSpan, isPingSpike } from '../../src/online/br/netHudModel';

type Rec = Record<string, unknown>;

/** A Chrome-style RTCStatsReport: transport → selectedCandidatePairId. */
function chromeReport(over: { local?: string; remote?: string; rtt?: number; sent?: number; recv?: number; avail?: number } = {}): Map<string, Rec> {
  const m = new Map<string, Rec>();
  m.set('T01', { id: 'T01', type: 'transport', selectedCandidatePairId: 'CP1' });
  m.set('CP0', { id: 'CP0', type: 'candidate-pair', state: 'failed', localCandidateId: 'L9', remoteCandidateId: 'R9', bytesSent: 999999 });
  m.set('CP1', {
    id: 'CP1',
    type: 'candidate-pair',
    state: 'succeeded',
    nominated: true,
    localCandidateId: 'L1',
    remoteCandidateId: 'R1',
    currentRoundTripTime: (over.rtt ?? 48) / 1000,
    availableOutgoingBitrate: over.avail,
    bytesSent: over.sent ?? 5000,
    bytesReceived: over.recv ?? 9000,
  });
  m.set('L1', { id: 'L1', type: 'local-candidate', candidateType: over.local ?? 'srflx', protocol: 'udp' });
  m.set('R1', { id: 'R1', type: 'remote-candidate', candidateType: over.remote ?? 'host', protocol: 'udp' });
  m.set('D1', { id: 'D1', type: 'data-channel', label: 'gk-fast', state: 'open', bytesSent: 10, bytesReceived: 20 });
  return m;
}

const INFO: LinkDiagInfo = { open: true, fast: 'on', fastReason: '', dropped: 0, buffered: 0, sentUnreliable: 5, receivedUnreliable: 6 };

describe('extractPathStats', () => {
  it('reads the selected pair, candidate types, rtt and data channels (Chrome shape)', () => {
    const s = extractPathStats(chromeReport({ avail: 250000 }));
    expect(s).not.toBeNull();
    expect(s?.path).toBe('direct');
    expect(s?.localType).toBe('srflx');
    expect(s?.remoteType).toBe('host');
    expect(s?.protocol).toBe('udp');
    expect(s?.rttMs).toBeCloseTo(48, 5);
    expect(s?.availOutKbps).toBeCloseTo(250, 5);
    expect(s?.bytesSent).toBe(5000);
    expect(s?.channels).toEqual([{ label: 'gk-fast', state: 'open', bytesSent: 10, bytesReceived: 20 }]);
  });

  it('flags a TURN relay on either side', () => {
    expect(extractPathStats(chromeReport({ remote: 'relay' }))?.path).toBe('relay');
    expect(extractPathStats(chromeReport({ local: 'relay' }))?.path).toBe('relay');
    expect(extractPathStats(chromeReport({ local: 'host', remote: 'host' }))?.path).toBe('direct');
  });

  it('falls back to the `selected` / nominated pair when there is no transport.selectedCandidatePairId (Firefox shape)', () => {
    const m = chromeReport();
    m.set('T01', { id: 'T01', type: 'transport' });
    m.set('CP1', { ...(m.get('CP1') as Rec), selected: true });
    expect(extractPathStats(m)?.rttMs).toBeCloseTo(48, 5);
    const m2 = chromeReport();
    m2.set('T01', { id: 'T01', type: 'transport' });
    expect(extractPathStats(m2)?.bytesSent).toBe(5000); // the nominated + succeeded one, not the failed one with more bytes
  });

  it('is null without a pair, never throws on junk', () => {
    expect(extractPathStats(new Map())).toBeNull();
    expect(extractPathStats(null)).toBeNull();
    expect(extractPathStats(42)).toBeNull();
    expect(extractPathStats(new Map([['x', 'not an object']]))).toBeNull();
  });
});

describe('samples, the HUD line and the ring', () => {
  it('measures rates between samples and formats the documented line', () => {
    const a = makeSample(10_000, null, extractPathStats(chromeReport({ sent: 10_000, recv: 20_000 })), INFO);
    expect(a.outKbps).toBe(0); // no previous sample
    const b = makeSample(12_000, a, extractPathStats(chromeReport({ sent: 40_000, recv: 22_000 })), { ...INFO, dropped: 3 });
    expect(b.outKbps).toBeCloseTo((30_000 * 8) / 1000 / 2, 5); // 120 kbps
    expect(b.inKbps).toBeCloseTo((2_000 * 8) / 1000 / 2, 5);
    expect(formatDiagLine(b)).toBe('path: direct (srflx) · rtt 48 ms · out 120 kbps · dropped 3 · fast-channel on');
    expect(formatDiagLine(null)).toBe('');
  });

  it('names the more NAT-traversed end, relay and unknown', () => {
    const base = { path: 'direct' as const };
    expect(pathLabel({ ...base, localType: 'host', remoteType: 'host' })).toBe('direct (host)');
    expect(pathLabel({ ...base, localType: 'host', remoteType: 'srflx' })).toBe('direct (srflx)');
    expect(pathLabel({ ...base, localType: 'prflx', remoteType: 'srflx' })).toBe('direct (prflx)');
    expect(pathLabel({ path: 'relay', localType: 'relay', remoteType: 'host' })).toBe('relay');
    expect(pathLabel({ path: 'unknown', localType: 'unknown', remoteType: 'unknown' })).toBe('unknown');
  });

  it('keeps the previous byte counters when getStats failed, and says so', () => {
    const a = makeSample(1000, null, extractPathStats(chromeReport({ sent: 100 })), INFO);
    const b = makeSample(3000, a, null, { ...INFO, fast: 'off', fastReason: 'ready-timeout' }, 'getStats-timeout');
    expect(b.bytesSent).toBe(100);
    expect(b.outKbps).toBe(0);
    expect(b.statsError).toBe('getStats-timeout');
    expect(formatDiagLine(b)).toContain('fast-channel off');
    expect(b.fastReason).toBe('ready-timeout');
  });

  it('the ring holds the last 60 samples', () => {
    const r = new DiagRing();
    for (let i = 0; i < 100; i++) r.push(makeSample(i * 2000, r.last, null, INFO));
    expect(DIAG_RING_SIZE).toBe(60);
    expect(r.length).toBe(60);
    expect(r.toArray()[0].at).toBe(40 * 2000);
    expect(r.last?.at).toBe(99 * 2000);
  });

  it('with several links the worst one is shown', () => {
    const fast = makeSample(0, null, extractPathStats(chromeReport({ rtt: 30 })), INFO);
    const slow = makeSample(0, null, extractPathStats(chromeReport({ rtt: 210, remote: 'srflx' })), INFO);
    expect(worstSample([fast, null, slow]).sample).toBe(slow);
    expect(worstSample([fast, null, slow]).count).toBe(2);
    expect(formatDiagSummary([fast, slow])).toMatch(/^worst of 2 links · path: direct \(srflx\) · rtt 210 ms/);
    expect(formatDiagSummary([fast])).toMatch(/^path: /);
    expect(formatDiagSummary([null])).toBe('');
  });
});

describe('NetDiag poller', () => {
  const made: NetDiag[] = [];
  afterEach(() => {
    for (const d of made.splice(0)) d.dispose();
    delete (globalThis as { __gkNetDiag?: unknown }).__gkNetDiag;
  });

  function setup() {
    let clock = 1_000_000;
    let tick: (() => void) | null = null;
    let cleared = 0;
    const diag = new NetDiag({
      now: () => clock,
      setInterval: (fn) => {
        tick = fn;
        return 1;
      },
      clearInterval: () => {
        cleared++;
        tick = null;
      },
      installGlobal: true,
    });
    made.push(diag);
    let n = 0;
    const probe: LinkProbe = {
      peerId: 'host',
      linkId: 'abc',
      getStats: () => Promise.resolve(chromeReport({ sent: 10_000 * ++n, rtt: 40 + n })),
      info: () => ({ ...INFO, dropped: n }),
    };
    return { diag, probe, advance: (ms: number) => (clock += ms), tick: () => tick, cleared: () => cleared };
  }

  it('polls on its timer, keeps a 60-sample ring and exposes window.__gkNetDiag()', async () => {
    const { diag, probe, advance, tick } = setup();
    const stop = diag.register(probe);
    expect(tick()).not.toBeNull();
    for (let i = 0; i < 80; i++) {
      advance(2000);
      await diag.pollNow();
    }
    const before = diag.snapshot().links[0].ring.length;
    tick()?.(); // the interval callback polls too
    await diag.pollNow();
    expect(diag.snapshot().links[0].ring.length).toBe(Math.min(60, before + 0)); // capped at 60 either way
    const fn = (globalThis as { __gkNetDiag?: () => ReturnType<NetDiag['snapshot']> }).__gkNetDiag;
    expect(typeof fn).toBe('function');
    const snap = fn?.();
    expect(snap?.version).toBe(1);
    expect(snap?.links).toHaveLength(1);
    expect(snap?.links[0].ring).toHaveLength(60);
    expect(snap?.links[0].current?.rttMs).toBeGreaterThan(40);
    expect(snap?.links[0].closed).toBe(false);
    expect(snap?.text).toContain('host: path: direct (srflx)');
    expect(() => JSON.stringify(snap)).not.toThrow();
    expect(diag.summaryLine()).toMatch(/^path: direct \(srflx\) · rtt \d+ ms · out \d+ kbps · dropped \d+ · fast-channel on$/);
    stop();
  });

  it('stops its timer when the last link goes, but keeps the ring for a report after the drop', async () => {
    const { diag, probe, cleared } = setup();
    const stop = diag.register(probe);
    await diag.pollNow();
    stop();
    expect(cleared()).toBe(1);
    expect(diag.summaryLine()).toBe(''); // closed links are not on the HUD
    const snap = diag.snapshot();
    expect(snap.links[0].closed).toBe(true);
    expect(snap.links[0].ring.length).toBeGreaterThan(0);
  });

  it('survives getStats rejecting, hanging or returning junk', async () => {
    const { diag } = setup();
    const bad: LinkProbe = { peerId: 'p', linkId: 'bad', getStats: () => Promise.reject(new Error('nope')), info: () => INFO };
    const none: LinkProbe = { peerId: 'q', linkId: 'none', getStats: () => null, info: () => ({ ...INFO, fast: 'off', fastReason: 'unsupported' }) };
    const junk: LinkProbe = { peerId: 'r', linkId: 'junk', getStats: () => Promise.resolve(new Map()), info: () => INFO };
    diag.register(bad);
    diag.register(none);
    diag.register(junk);
    await diag.pollNow();
    const byId = Object.fromEntries(diag.snapshot().links.map((l) => [l.linkId, l.current]));
    expect(byId.bad?.statsError).toBe('nope');
    expect(byId.none?.statsError).toBe('no-peer-connection');
    expect(byId.junk?.statsError).toBe('no-selected-pair');
    expect(byId.none?.fast).toBe('off');
  });
});

describe('ping estimator (BR_SYNC) and the spike indicator', () => {
  it('behaves like a plain EMA for ordinary samples', () => {
    const p = new PingEstimator();
    for (let i = 0; i < 40; i++) p.add(60 + (i % 3) * 5, i * 500);
    expect(p.value).toBeGreaterThan(55);
    expect(p.value).toBeLessThan(75);
  });

  it('a flood of pings queued behind a 3 s stall cannot push the shown ping past one second', () => {
    const p = new PingEstimator();
    for (let i = 0; i < 20; i++) p.add(60, i * 500);
    // six pings sent every 500 ms during the stall are answered at once when it ends
    const t = 10_000;
    for (const age of [3000, 2500, 2000, 1500, 1000, 500]) p.add(age, t);
    expect(p.value).toBeLessThan(1000);
    expect(p.peakMs(t)).toBe(3000);
    expect(p.ignoredTotal).toBe(2);
    // and it recovers once ordinary samples return
    for (let i = 0; i < 25; i++) p.add(60, t + 500 * (i + 1));
    expect(p.value).toBeLessThan(120);
  });

  it('believes a link that really is that slow (3 samples in a row)', () => {
    const p = new PingEstimator();
    for (let i = 0; i < 10; i++) p.add(60, i * 500);
    for (let i = 0; i < 60; i++) p.add(2600, 5000 + i * 500);
    expect(p.value).toBeGreaterThan(2000);
  });

  it('spike rules and HUD text', () => {
    expect(isPingSpike(50, 120)).toBe(false);
    expect(isPingSpike(50, 290)).toBe(false); // below the absolute floor
    expect(isPingSpike(200, 400)).toBe(false); // not far enough above the usual
    expect(isPingSpike(50, 900)).toBe(true);
    expect(formatSpan(640)).toBe('640 ms');
    expect(formatSpan(1234)).toBe('1.2 s');
    const base = { role: 'client' as const, pingMs: 48, loss: 0, hostSilenceMs: 10, haveSnapshot: true, waitingFor: [] as string[] };
    const calm = describeLink({ ...base, pingPeakMs: 70, diagLine: 'path: direct (host) · rtt 3 ms' });
    expect(calm.text).toBe('PING 48 ms · LOSS 0%');
    expect(calm.spike).toBe(false);
    expect(calm.detail).toBe('path: direct (host) · rtt 3 ms');
    expect(calm.quality).toBe('good');
    const spiky = describeLink({ ...base, pingPeakMs: 1500 });
    expect(spiky.text).toBe('PING 48 ms · LOSS 0% · SPIKE 1.5 s');
    expect(spiky.spike).toBe(true);
    expect(spiky.quality).toBe('poor');
    expect(spiky.detail).toBeNull();
    const host = describeLink({ role: 'host', pingMs: 80, loss: 0, hostSilenceMs: 0, haveSnapshot: true, waitingFor: [], pingPeakMs: 700, diagLine: '' });
    expect(host.text).toBe('HOST · WORST PING 80 ms · SPIKE 700 ms');
    expect(host.detail).toBeNull();
  });
});
