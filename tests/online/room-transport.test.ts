import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConditionedTransport, parseNetSim } from '../../src/online/transport/conditioned';
import { DEFAULT_ICE_SERVERS, parseIceServers, parseSignalParam, resolveIceServers } from '../../src/online/transport/iceConfig';
import { LoopbackNetwork } from '../../src/online/transport/loopback';
import { createDefaultTransport } from '../../src/online/transport';
import type { Link, Transport } from '../../src/online/types';

describe('iceConfig', () => {
  it('defaults to public STUN only', () => {
    const s = resolveIceServers({ search: '', storage: null });
    expect(s).toEqual([...DEFAULT_ICE_SERVERS]);
    expect(s.every((x) => String(x.urls).startsWith('stun:'))).toBe(true);
  });

  it('adds extras from ?ice= (JSON or short list) and from storage, ignoring junk', () => {
    const turn = { urls: 'turn:turn.example.org:3478', username: 'u', credential: 'p' };
    const fromJson = resolveIceServers({ search: `?ice=${encodeURIComponent(JSON.stringify([turn]))}`, storage: null });
    expect(fromJson).toEqual([...DEFAULT_ICE_SERVERS, turn]);
    const short = resolveIceServers({ search: `?ice=${encodeURIComponent('stun:a.example:3478,turn:t.example:3478|bob|secret')}`, storage: null });
    expect(short.slice(DEFAULT_ICE_SERVERS.length)).toEqual([{ urls: 'stun:a.example:3478' }, { urls: 'turn:t.example:3478', username: 'bob', credential: 'secret' }]);
    const stored = resolveIceServers({ search: '', storage: { getItem: (k) => (k === 'gk-ice' ? JSON.stringify(turn) : null) } });
    expect(stored[stored.length - 1]).toEqual(turn);
    const both = resolveIceServers({ search: '?ice=stun:x.example:1', storage: { getItem: () => JSON.stringify([turn]) } });
    expect(both).toHaveLength(DEFAULT_ICE_SERVERS.length + 2);
    // junk is dropped, never thrown
    expect(parseIceServers('not json, javascript:alert(1), http://x')).toEqual([]);
    expect(parseIceServers('[{"urls":"file:///etc/passwd"},{"urls":["stun:ok.example","bad"]},42,null]')).toEqual([{ urls: 'stun:ok.example' }]);
    expect(parseIceServers('{broken')).toEqual([]);
    expect(parseIceServers(null)).toEqual([]);
    expect(parseIceServers('x'.repeat(5000))).toEqual([]);
    const throwing = { getItem: () => { throw new Error('blocked'); } };
    expect(resolveIceServers({ search: '', storage: throwing })).toEqual([...DEFAULT_ICE_SERVERS]);
  });
});

describe('signalling parameter', () => {
  it('parses host:port, urls and paths', () => {
    expect(parseSignalParam('localhost:9000')).toEqual({ host: 'localhost', port: 9000, path: '/', secure: false });
    expect(parseSignalParam('192.168.1.20:9100')).toEqual({ host: '192.168.1.20', port: 9100, path: '/', secure: false });
    expect(parseSignalParam('localhost')).toEqual({ host: 'localhost', port: 9000, path: '/', secure: false });
    expect(parseSignalParam('signal.example.org')).toEqual({ host: 'signal.example.org', port: 443, path: '/', secure: true });
    expect(parseSignalParam('https://signal.example.org/peerjs-app')).toEqual({ host: 'signal.example.org', port: 443, path: '/peerjs-app/', secure: true });
    expect(parseSignalParam('ws://127.0.0.1:9000')).toEqual({ host: '127.0.0.1', port: 9000, path: '/', secure: false });
    expect(parseSignalParam('')).toBeNull();
    expect(parseSignalParam(null)).toBeNull();
    expect(parseSignalParam('host:99999')).toBeNull();
    expect(parseSignalParam('bad host')).toBeNull();
  });
});

describe('netsim parameter', () => {
  it('parses latency, jitter and loss (fraction or percent)', () => {
    expect(parseNetSim('latency:80,jitter:20,loss:0.05')).toEqual({ latencyMs: 80, jitterMs: 20, loss: 0.05 });
    expect(parseNetSim('lat:30')).toEqual({ latencyMs: 30, jitterMs: 0, loss: 0 });
    expect(parseNetSim('loss:5')).toEqual({ latencyMs: 0, jitterMs: 0, loss: 0.05 });
    expect(parseNetSim('latency:99999')?.latencyMs).toBe(5000);
    expect(parseNetSim('')).toBeNull();
    expect(parseNetSim('nonsense')).toBeNull();
    expect(parseNetSim('latency:-4,x:1')).toBeNull();
    expect(parseNetSim(null)).toBeNull();
  });
});

describe('ConditionedTransport (real timers, faked)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function pair(sim: { latencyMs: number; jitterMs: number; loss: number }, rng: () => number = () => 0.5) {
    const net = new LoopbackNetwork(); // perfect network underneath
    const timers = { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (h: unknown) => clearTimeout(h as number), now: () => Date.now() };
    const a: Transport = new ConditionedTransport(net.createTransport(), sim, { rng, timers });
    const b = net.createTransport();
    await a.open('a');
    await b.open('b');
    const got: { at: number; ch: string; v: number }[] = [];
    const t0 = Date.now();
    a.setHandlers({ onLink: () => undefined, onData: () => undefined, onClose: () => undefined });
    b.setHandlers({ onLink: () => undefined, onData: (_l, ch, d) => got.push({ at: Date.now() - t0, ch, v: d[0] }), onClose: () => undefined });
    const link = (await a.connect('b')) as Link;
    net.advance(10);
    return { link, got, net, a };
  }

  it('delays outgoing packets by latency + jitter, in order for reliable ones', async () => {
    const { link, got, net } = await pair({ latencyMs: 80, jitterMs: 20, loss: 0 }, () => 0.5);
    link.send('reliable', new Uint8Array([1]));
    await vi.advanceTimersByTimeAsync(89);
    net.advance(0);
    expect(got).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    net.advance(0);
    expect(got.map((g) => g.v)).toEqual([1]);
    expect(got[0].ch).toBe('reliable');
  });

  it('keeps reliable packets in order even when later ones draw a smaller delay', async () => {
    const rolls = [1, 0, 0.5];
    let i = 0;
    const { link, got, net } = await pair({ latencyMs: 10, jitterMs: 100, loss: 0 }, () => rolls[i++ % rolls.length]);
    // delays: 110, 10, 60 → reliable delivery must still be 1,2,3 (never earlier than the previous one)
    link.send('reliable', new Uint8Array([1]));
    link.send('reliable', new Uint8Array([2]));
    link.send('reliable', new Uint8Array([3]));
    await vi.advanceTimersByTimeAsync(300);
    net.advance(0);
    expect(got.map((g) => g.v)).toEqual([1, 2, 3]);
  });

  it('QA: reliable packets stay in order when the timer truncates delays to whole milliseconds (browser behaviour)', async () => {
    // Packet 1 draws a 110 ms delay (arrives at 210.9); packet 2 (sent 0.05 ms later) draws 10 ms but must wait for packet 1, so its
    // delay is 109.95 ms -> truncated to 109 -> its timer fires BEFORE packet 1's (209.95 vs 210.9) in a naive implementation.
    const net = new LoopbackNetwork();
    const rolls = [1, 0, 0];
    let ri = 0;
    let clock = 100.9;
    const pending: Array<{ at: number; fn: () => void }> = [];
    const timers = {
      setTimeout: (fn: () => void, ms: number) => {
        const h = { at: clock + Math.trunc(ms), fn };
        pending.push(h);
        return h;
      },
      clearTimeout: (h: unknown) => {
        const i = pending.indexOf(h as { at: number; fn: () => void });
        if (i >= 0) pending.splice(i, 1);
      },
      now: () => clock,
    };
    const a: Transport = new ConditionedTransport(net.createTransport(), { latencyMs: 10, jitterMs: 100, loss: 0 }, { rng: () => rolls[ri++ % rolls.length], timers });
    const b = net.createTransport();
    await a.open('a');
    await b.open('b');
    const got: number[] = [];
    a.setHandlers({ onLink: () => undefined, onData: () => undefined, onClose: () => undefined });
    b.setHandlers({ onLink: () => undefined, onData: (_l, _c, d) => got.push(d[0]), onClose: () => undefined });
    const link = (await a.connect('b')) as Link;
    net.advance(10);
    ri = 0;
    link.send('reliable', new Uint8Array([1]));
    clock = 100.95;
    link.send('reliable', new Uint8Array([2]));
    clock = 101;
    link.send('reliable', new Uint8Array([3]));
    // fire the timers in the browser's (truncation-affected) order: earliest fire time first
    pending.sort((x, y) => x.at - y.at);
    while (pending.length > 0) {
      const t = pending.shift() as { at: number; fn: () => void };
      clock = Math.max(clock, t.at);
      t.fn();
    }
    net.advance(0);
    expect(got).toEqual([1, 2, 3]);
  });

  it('drops unreliable packets with the configured probability and lets them overtake each other', async () => {
    let n = 0;
    const draws = [0.9, 1, 0.01, 0.9, 0]; // unreliable send = loss roll, then (if kept) a jitter roll
    const { link, got, net } = await pair({ latencyMs: 0, jitterMs: 100, loss: 0.5 }, () => draws[n++ % draws.length]);
    link.send('unreliable', new Uint8Array([1])); // loss .9 ≥ .5 keep, delay 100
    link.send('unreliable', new Uint8Array([2])); // loss .01 < .5 → dropped
    link.send('unreliable', new Uint8Array([3])); // loss .9 keep, delay 0
    await vi.advanceTimersByTimeAsync(150);
    net.advance(0);
    expect(got.map((g) => g.v)).toEqual([3, 1]);
  });

  it('passes through when nothing is configured and forwards rtt reports; close flushes queued goodbyes', async () => {
    const { link, got, net, a } = await pair({ latencyMs: 0, jitterMs: 0, loss: 0 });
    link.send('reliable', new Uint8Array([5]));
    net.advance(0);
    expect(got.map((g) => g.v)).toEqual([5]);
    link.reportRtt?.(42);
    expect(a.kind).toBe('loopback');
    link.close();
    expect(link.open).toBe(false);
  });

  it('wraps incoming links so the room only ever sees the conditioned instances', async () => {
    const net = new LoopbackNetwork();
    const a = new ConditionedTransport(net.createTransport(), { latencyMs: 5, jitterMs: 0, loss: 0 });
    const b = net.createTransport();
    await a.open('a');
    await b.open('b');
    const seen: Link[] = [];
    a.setHandlers({ onLink: (l) => seen.push(l), onData: () => undefined, onClose: () => undefined });
    b.setHandlers({ onLink: () => undefined, onData: () => undefined, onClose: () => undefined });
    const out = await b.connect('a');
    net.advance(10);
    expect(seen).toHaveLength(1);
    expect(seen[0].peerId).toBe('b');
    expect(seen[0]).not.toBe(out);
    expect(seen[0].open).toBe(true);
  });
});

describe('createDefaultTransport', () => {
  it('builds a PeerJS transport lazily (wrapped in the conditioner only when netsim is requested)', async () => {
    const plain = await createDefaultTransport({ search: '?signal=localhost:9000' });
    expect(plain.kind).toBe('peerjs');
    expect(plain).not.toBeInstanceOf(ConditionedTransport);
    plain.dispose();
    const sim = await createDefaultTransport({ search: '?signal=localhost:9000&netsim=latency:80,jitter:20,loss:0.05' });
    expect(sim).toBeInstanceOf(ConditionedTransport);
    expect(sim.kind).toBe('peerjs');
    sim.dispose();
  });
});
