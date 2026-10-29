import { afterEach, describe, expect, it } from 'vitest';
import {
  FAST_CHANNEL_ID,
  FAST_CHANNEL_LABEL,
  FAST_CTRL_KIND,
  FAST_READY_PACKET,
  FAST_READY_TIMEOUT_MS,
  FastPath,
  MAX_UNRELIABLE_BACKLOG,
  isFastReady,
  unreliableBlock,
  type FastState,
  type FastTimers,
} from '../../src/online/transport/fastChannel';
import { PeerJsLink } from '../../src/online/transport/peerjs';
import { netDiag } from '../../src/online/netDiag';
import type { Channel } from '../../src/online/types';

// ── fakes ─────────────────────────────────────────────────────────────────────

class FakeDataChannel {
  readyState: string = 'connecting';
  bufferedAmount = 0;
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Uint8Array[] = [];
  throwOnSend: Error | null = null;
  constructor(
    readonly label: string,
    readonly init: Record<string, unknown>,
  ) {}
  send(d: Uint8Array): void {
    if (this.throwOnSend !== null) throw this.throwOnSend;
    this.sent.push(d.slice());
  }
  close(): void {
    this.readyState = 'closed';
  }
  open(): void {
    this.readyState = 'open';
    this.onopen?.();
  }
  receive(bytes: Uint8Array): void {
    const copy = bytes.slice();
    this.onmessage?.({ data: copy.buffer });
  }
}

class FakePc {
  channels: FakeDataChannel[] = [];
  throwOnCreate: Error | null = null;
  stats: Map<string, unknown> = new Map();
  createDataChannel(label: string, init: Record<string, unknown>): FakeDataChannel {
    if (this.throwOnCreate !== null) throw this.throwOnCreate;
    const ch = new FakeDataChannel(label, init);
    this.channels.push(ch);
    return ch;
  }
  getStats(): Promise<unknown> {
    return Promise.resolve(this.stats);
  }
}

class ManualTimers implements FastTimers {
  now = 0;
  private next = 1;
  private pending = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.pending.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.pending.delete(h as number);
  }
  advance(ms: number): void {
    this.now += ms;
    for (const [id, t] of [...this.pending]) {
      if (t.at <= this.now) {
        this.pending.delete(id);
        t.fn();
      }
    }
  }
  get count(): number {
    return this.pending.size;
  }
}

/** The bit of a PeerJS DataConnection that PeerJsLink touches. */
class FakeDc {
  open = false;
  sent: Uint8Array[] = [];
  closed = false;
  throwOnSend: Error | null = null;
  readonly pc = new FakePc();
  /** PeerJS's own in-band channel. */
  readonly dataChannel = new FakeDataChannel('gk-u', {});
  private handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  get peerConnection(): FakePc {
    return this.pc;
  }
  on(ev: string, fn: (...a: unknown[]) => void): void {
    const l = this.handlers.get(ev) ?? [];
    l.push(fn);
    this.handlers.set(ev, l);
  }
  emit(ev: string, ...a: unknown[]): void {
    for (const fn of this.handlers.get(ev) ?? []) fn(...a);
  }
  send(d: Uint8Array): void {
    if (this.throwOnSend !== null) throw this.throwOnSend;
    this.sent.push(d.slice());
  }
  close(): void {
    this.closed = true;
    this.open = false;
  }
  becomeOpen(): void {
    this.open = true;
    this.dataChannel.readyState = 'open';
    this.emit('open');
  }
  receive(bytes: Uint8Array): void {
    this.emit('data', bytes.slice().buffer);
  }
}

const bytes = (...n: number[]): Uint8Array => new Uint8Array(n);

// ── FastPath ──────────────────────────────────────────────────────────────────

describe('FastPath (the gk-fast channel handshake)', () => {
  function make(opts: { readyOk?: boolean } = {}) {
    const pc = new FakePc();
    const timers = new ManualTimers();
    const got: Uint8Array[] = [];
    const states: Array<[FastState, string]> = [];
    let readySent = 0;
    const fp = new FastPath(pc as unknown as RTCPeerConnection, {
      sendReady: () => {
        if (opts.readyOk === false) return false;
        readySent++;
        return true;
      },
      onData: (b) => got.push(b),
      onState: (s, r) => states.push([s, r]),
      timers,
    });
    return { pc, timers, got, states, fp, ready: () => readySent, ch: pc.channels[0] };
  }

  it('creates the negotiated, unordered, zero-retransmit channel on both ends with a fixed id', () => {
    const { pc, ch, fp } = make();
    expect(pc.channels).toHaveLength(1);
    expect(ch.label).toBe(FAST_CHANNEL_LABEL);
    expect(ch.init).toEqual({ negotiated: true, id: FAST_CHANNEL_ID, ordered: false, maxRetransmits: 0 });
    expect(ch.binaryType).toBe('arraybuffer');
    expect(FAST_CHANNEL_ID).toBeGreaterThan(1); // PeerJS's in-band channel takes id 0 or 1
    expect(fp.state).toBe('opening');
    expect(fp.active).toBe(false);
  });

  it('turns on only after the local end is open AND the peer sent READY; READY goes out once, only when the link is open', () => {
    const { ch, fp, ready, states } = make();
    ch.open();
    expect(fp.state).toBe('handshake');
    expect(ready()).toBe(0); // the reliable channel is not usable yet
    fp.linkOpened();
    expect(ready()).toBe(1);
    expect(fp.active).toBe(false);
    expect(fp.send(bytes(1, 2))).toBe('off'); // nothing goes out before the peer confirmed
    expect(ch.sent).toHaveLength(0);
    fp.peerReady();
    expect(fp.state).toBe('on');
    expect(fp.send(bytes(1, 2))).toBe('sent');
    expect(Array.from(ch.sent[0])).toEqual([1, 2]);
    fp.linkOpened(); // idempotent
    expect(ready()).toBe(1);
    expect(states.map((x) => x[0])).toEqual(['handshake', 'on']);
  });

  it('peer READY before the local end opened is remembered', () => {
    const { ch, fp, ready } = make();
    fp.peerReady();
    expect(fp.active).toBe(false);
    fp.linkOpened();
    expect(ready()).toBe(0); // our end is not open yet
    ch.open();
    expect(ready()).toBe(1);
    expect(fp.active).toBe(true);
  });

  it('gives up for good when READY does not arrive in time (e.g. a v1.10.0 peer) and closes the channel', () => {
    const { ch, fp, timers, states } = make();
    ch.open();
    fp.linkOpened();
    timers.advance(FAST_READY_TIMEOUT_MS - 1);
    expect(fp.state).toBe('handshake');
    timers.advance(1);
    expect(fp.state).toBe('off');
    expect(fp.info().reason).toBe('ready-timeout');
    expect(ch.readyState).toBe('closed');
    expect(fp.send(bytes(9))).toBe('off');
    fp.peerReady(); // a late READY must not resurrect it
    expect(fp.active).toBe(false);
    expect(states[states.length - 1]).toEqual(['off', 'ready-timeout']);
  });

  it('the timer is cancelled once the channel is on', () => {
    const { ch, fp, timers } = make();
    ch.open();
    fp.linkOpened();
    fp.peerReady();
    expect(timers.count).toBe(0);
    timers.advance(10_000);
    expect(fp.state).toBe('on');
  });

  it('an error or close of the channel switches it off permanently', () => {
    for (const ev of ['onerror', 'onclose'] as const) {
      const { ch, fp } = make();
      ch.open();
      fp.linkOpened();
      fp.peerReady();
      expect(fp.active).toBe(true);
      ch[ev]?.();
      expect(fp.state).toBe('off');
      expect(fp.info().reason).toBe(ev === 'onerror' ? 'error' : 'closed');
      expect(fp.send(bytes(1))).toBe('off');
    }
  });

  it('createDataChannel throwing leaves the path off (the link keeps using the PeerJS half)', () => {
    const pc = new FakePc();
    pc.throwOnCreate = new Error('InvalidAccessError');
    const fp = new FastPath(pc as unknown as RTCPeerConnection, { sendReady: () => true, onData: () => undefined });
    expect(fp.state).toBe('off');
    expect(fp.info().reason).toContain('create-failed');
    fp.linkOpened();
    fp.peerReady();
    expect(fp.active).toBe(false);
  });

  it('drops (and counts) instead of queueing once the channel is backed up; stops using a closing channel', () => {
    const { ch, fp } = make();
    ch.open();
    fp.linkOpened();
    fp.peerReady();
    ch.bufferedAmount = MAX_UNRELIABLE_BACKLOG; // exactly at the limit is still fine
    expect(fp.send(bytes(1))).toBe('sent');
    ch.bufferedAmount = MAX_UNRELIABLE_BACKLOG + 1;
    expect(fp.send(bytes(2))).toBe('dropped');
    expect(fp.send(bytes(3))).toBe('dropped');
    expect(fp.dropped).toBe(2);
    expect(ch.sent).toHaveLength(1);
    ch.bufferedAmount = 0;
    expect(fp.send(bytes(4))).toBe('sent'); // recovers as soon as the backlog drains
    ch.readyState = 'closing';
    expect(fp.send(bytes(5))).toBe('off');
    expect(fp.state).toBe('off');
    expect(ch.sent).toHaveLength(2);
  });

  it('a send() that throws counts as a drop', () => {
    const { ch, fp } = make();
    ch.open();
    fp.linkOpened();
    fp.peerReady();
    ch.throwOnSend = new Error('boom');
    expect(fp.send(bytes(1))).toBe('dropped');
    expect(fp.dropped).toBe(1);
    expect(fp.active).toBe(true); // still open, only that packet was lost
  });

  it('delivers incoming packets as soon as the channel is open, even before the handshake finished', () => {
    const { ch, fp, got } = make();
    ch.open();
    ch.receive(bytes(7, 8, 9));
    expect(got).toHaveLength(1);
    expect(Array.from(got[0])).toEqual([7, 8, 9]);
    expect(fp.info().received).toBe(1);
    ch.onmessage?.({ data: 'a string is not a packet' });
    expect(got).toHaveLength(1);
  });

  it('close() detaches everything', () => {
    const { ch, fp, got } = make();
    ch.open();
    fp.close();
    expect(ch.readyState).toBe('closed');
    expect(ch.onmessage).toBeNull();
    expect(fp.state).toBe('off');
    expect(got).toHaveLength(0);
  });
});

describe('the READY packet and the guard', () => {
  it('is transport-internal: below every game kind, not JSON (a v1.10.0 room layer drops it), 5 bytes', () => {
    expect(FAST_READY_PACKET[0]).toBe(FAST_CTRL_KIND);
    expect(FAST_CTRL_KIND).toBeLessThan(0x10);
    expect(isFastReady(FAST_READY_PACKET.slice())).toBe(true);
    expect(isFastReady(bytes(FAST_CTRL_KIND))).toBe(false);
    expect(isFastReady(bytes(0x08, 1, 2, 3, 4))).toBe(false);
    expect(() => JSON.parse(new TextDecoder().decode(FAST_READY_PACKET.subarray(1)))).toThrow();
  });

  it('the backlog limit is small: well under a second of snapshots', () => {
    expect(MAX_UNRELIABLE_BACKLOG).toBe(8 * 1024);
    expect(unreliableBlock({ readyState: 'open', bufferedAmount: 8192 })).toBeNull();
    expect(unreliableBlock({ readyState: 'open', bufferedAmount: 8193 })).toBe('backlog');
    expect(unreliableBlock({ readyState: 'closing', bufferedAmount: 0 })).toBe('closed');
    expect(unreliableBlock({ readyState: 'closed', bufferedAmount: 0 })).toBe('closed');
    expect(unreliableBlock(null)).toBe('closed');
  });
});

// ── PeerJsLink with fake DataConnections ────────────────────────────────────────

describe('PeerJsLink: fast channel, fallback and counters', () => {
  const links: PeerJsLink[] = [];
  afterEach(() => {
    for (const l of links.splice(0)) l.close(); // stops the netDiag registration (and its timer)
  });

  function makeLink() {
    const got: Array<{ ch: Channel; data: Uint8Array }> = [];
    const link = new PeerJsLink('peer-x', 'link-1', (_l, ch, d) => got.push({ ch, data: d }));
    links.push(link);
    const rel = new FakeDc();
    const unr = new FakeDc();
    link.attach('reliable', rel as never);
    link.attach('unreliable', unr as never);
    const fast = unr.pc.channels[0];
    const open = (): void => {
      rel.becomeOpen();
      unr.becomeOpen();
      fast.open();
    };
    return { link, rel, unr, fast, got, open };
  }

  it('negotiates the fast channel on the RTCPeerConnection of the unreliable half only', () => {
    const { rel, unr, fast } = makeLink();
    expect(rel.pc.channels).toHaveLength(0);
    expect(unr.pc.channels).toHaveLength(1);
    expect(fast.label).toBe(FAST_CHANNEL_LABEL);
  });

  it('announces READY on the reliable channel once, uses the fast channel after the peer did, never leaks READY upward', () => {
    const { link, rel, unr, fast, got, open } = makeLink();
    open();
    expect(link.open).toBe(true);
    expect(rel.sent.filter((p) => isFastReady(p))).toHaveLength(1);
    // before the peer's READY: the old PeerJS half carries unreliable traffic
    link.send('unreliable', bytes(0x21, 1));
    expect(unr.sent).toHaveLength(1);
    expect(fast.sent).toHaveLength(0);
    // the peer's READY (reliable) switches over — and is swallowed
    rel.receive(FAST_READY_PACKET.slice());
    expect(got).toHaveLength(0);
    link.send('unreliable', bytes(0x21, 2));
    link.send('unreliable', bytes(0x21, 3));
    expect(Array.from(fast.sent[0])).toEqual([0x21, 2]);
    expect(fast.sent).toHaveLength(2);
    expect(unr.sent).toHaveLength(1);
    // reliable traffic never touches the fast channel
    link.send('reliable', bytes(0x22, 5));
    expect(rel.sent.filter((p) => !isFastReady(p))).toHaveLength(1);
    expect(fast.sent).toHaveLength(2);
  });

  it('incoming data from either path is delivered as unreliable; reliable stays reliable', () => {
    const { link, rel, unr, fast, got, open } = makeLink();
    open();
    rel.receive(FAST_READY_PACKET.slice());
    fast.receive(bytes(0x21, 1, 1));
    unr.receive(bytes(0x24, 2, 2));
    rel.receive(bytes(0x22, 3, 3));
    expect(got.map((g) => [g.ch, g.data[0]])).toEqual([
      ['unreliable', 0x21],
      ['unreliable', 0x24],
      ['reliable', 0x22],
    ]);
    expect(link.diagInfo().receivedUnreliable).toBe(2);
  });

  it('a peer that never sends READY (a v1.10.0 build): keeps the old half, gives up after 3 s, nothing is lost', () => {
    const real = globalThis.setTimeout;
    const fired: Array<() => void> = [];
    // The link uses the real timers; capture the give-up timer instead of waiting 3 s.
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      if (ms === FAST_READY_TIMEOUT_MS) {
        fired.push(fn);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return real(fn, ms);
    }) as typeof setTimeout;
    try {
      const { link, unr, fast, open } = makeLink();
      open();
      expect(fired).toHaveLength(1);
      link.send('unreliable', bytes(1));
      expect(unr.sent).toHaveLength(1);
      fired[0]();
      expect(link.diagInfo().fast).toBe('off');
      expect(link.diagInfo().fastReason).toBe('ready-timeout');
      expect(fast.readyState).toBe('closed');
      link.send('unreliable', bytes(2));
      expect(unr.sent).toHaveLength(2);
      expect(fast.sent).toHaveLength(0);
    } finally {
      globalThis.setTimeout = real;
    }
  });

  it('falls back to the old half the moment the fast channel errors or closes', () => {
    const { link, unr, fast, rel, open } = makeLink();
    open();
    rel.receive(FAST_READY_PACKET.slice());
    link.send('unreliable', bytes(1));
    expect(fast.sent).toHaveLength(1);
    fast.onerror?.();
    link.send('unreliable', bytes(2));
    expect(unr.sent).toHaveLength(1);
    expect(link.open).toBe(true); // a dead fast channel never kills the link
  });

  it('READY arriving before the unreliable half was attached is not lost', () => {
    const got: Uint8Array[] = [];
    const link = new PeerJsLink('p', 'l', (_l, _c, d) => got.push(d));
    links.push(link);
    const rel = new FakeDc();
    const unr = new FakeDc();
    link.attach('reliable', rel as never);
    rel.becomeOpen();
    rel.receive(FAST_READY_PACKET.slice());
    link.attach('unreliable', unr as never);
    unr.becomeOpen();
    unr.pc.channels[0].open();
    expect(link.open).toBe(true);
    link.send('unreliable', bytes(1));
    expect(unr.pc.channels[0].sent).toHaveLength(1);
  });

  it('counts guard drops per link on BOTH paths and never queues behind a backed-up channel', () => {
    const { link, unr, fast, rel, open } = makeLink();
    open();
    // old half
    unr.dataChannel.bufferedAmount = MAX_UNRELIABLE_BACKLOG + 1;
    link.send('unreliable', bytes(1));
    expect(unr.sent).toHaveLength(0);
    expect(link.diagInfo().dropped).toBe(1);
    unr.dataChannel.bufferedAmount = 0;
    link.send('unreliable', bytes(2));
    expect(unr.sent).toHaveLength(1);
    // closing old half
    unr.dataChannel.readyState = 'closing';
    link.send('unreliable', bytes(3));
    expect(unr.sent).toHaveLength(1);
    expect(link.diagInfo().dropped).toBe(2);
    unr.dataChannel.readyState = 'open';
    // fast path
    rel.receive(FAST_READY_PACKET.slice());
    fast.bufferedAmount = MAX_UNRELIABLE_BACKLOG + 500;
    link.send('unreliable', bytes(4));
    link.send('unreliable', bytes(5));
    expect(fast.sent).toHaveLength(0);
    expect(link.diagInfo().dropped).toBe(4);
    expect(link.diagInfo().buffered).toBe(MAX_UNRELIABLE_BACKLOG + 500);
    // reliable sends are never dropped by the guard
    rel.dataChannel.bufferedAmount = 10 * MAX_UNRELIABLE_BACKLOG;
    link.send('reliable', bytes(0x22));
    expect(rel.sent.filter((p) => !isFastReady(p))).toHaveLength(1);
  });

  it('close() tears the fast channel down and sends become no-ops', () => {
    const { link, fast, unr, rel, open } = makeLink();
    open();
    rel.receive(FAST_READY_PACKET.slice());
    link.close();
    expect(fast.readyState).toBe('closed');
    expect(unr.closed && rel.closed).toBe(true);
    link.send('unreliable', bytes(1));
    expect(fast.sent).toHaveLength(0);
  });

  it('registers with the network diagnostics while open and leaves them on close', async () => {
    const { link, unr, open } = makeLink();
    open();
    link.startDiag();
    unr.pc.stats = new Map<string, unknown>([
      ['T', { id: 'T', type: 'transport', selectedCandidatePairId: 'P' }],
      ['P', { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', currentRoundTripTime: 0.048, bytesSent: 1000, bytesReceived: 2000 }],
      ['L', { id: 'L', type: 'local-candidate', candidateType: 'srflx', protocol: 'udp' }],
      ['R', { id: 'R', type: 'remote-candidate', candidateType: 'host', protocol: 'udp' }],
    ]);
    await netDiag.pollNow();
    const snap = netDiag.snapshot().links.find((l) => l.linkId === 'link-1');
    expect(snap).toBeDefined();
    expect(snap?.closed).toBe(false);
    expect(snap?.current?.path).toBe('direct');
    expect(snap?.line).toContain('direct (srflx)');
    expect(snap?.line).toContain('fast-channel handshake');
    link.close();
    expect(netDiag.snapshot().links.find((l) => l.linkId === 'link-1')?.closed).toBe(true);
  });
});
