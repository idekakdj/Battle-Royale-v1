/**
 * In-memory network for tests and the local QA harness: a `LoopbackNetwork` hands out `Transport`s whose links behave
 * like a real network (latency, jitter, loss, reordering) but run on a MANUAL clock — `advance(ms)` delivers due
 * packets in (time, sequence) order — so netcode tests are fully deterministic. Architect-owned shared code.
 *
 *  - `reliable` packets: ordered, never lost (only delayed; delivery time is forced monotonic per direction).
 *  - `unreliable` packets: dropped with probability `loss`, may be delayed/reordered by jitter, may be duplicated.
 */

import type { Channel, Link, Transport, TransportHandlers } from '../types';

export interface NetConditions {
  /** One-way base latency (ms). */
  latencyMs: number;
  /** Uniform extra delay in [0, jitterMs] per packet (unreliable packets can overtake each other). */
  jitterMs: number;
  /** Unreliable loss probability 0..1. */
  loss: number;
  /** Unreliable duplication probability 0..1. */
  duplicate: number;
}

export const PERFECT_NET: Readonly<NetConditions> = { latencyMs: 0, jitterMs: 0, loss: 0, duplicate: 0 };

interface Scheduled {
  at: number;
  seq: number;
  run: () => void;
}

function rngFrom(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class LoopbackNetwork {
  /** Simulated clock (ms). */
  now = 0;
  cond: NetConditions;
  private readonly rng: () => number;
  private seq = 0;
  private queue: Scheduled[] = [];
  private readonly peers = new Map<string, LoopbackTransport>();
  private anon = 0;

  constructor(cond: Partial<NetConditions> = {}, seed = 1) {
    this.cond = { ...PERFECT_NET, ...cond };
    this.rng = rngFrom(seed);
  }

  setConditions(c: Partial<NetConditions>): void {
    this.cond = { ...this.cond, ...c };
  }

  createTransport(): Transport {
    return new LoopbackTransport(this);
  }

  /** Number of packets/events still in flight. */
  pending(): number {
    return this.queue.length;
  }

  /** Advance the clock, delivering everything due, in order. Handlers may schedule more traffic. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let best = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const q = this.queue[i];
        if (q.at > target) continue;
        if (best < 0 || q.at < this.queue[best].at || (q.at === this.queue[best].at && q.seq < this.queue[best].seq)) best = i;
      }
      if (best < 0) break;
      const ev = this.queue.splice(best, 1)[0];
      if (ev.at > this.now) this.now = ev.at;
      ev.run();
    }
    this.now = target;
  }

  /** @internal */
  schedule(delayMs: number, run: () => void): void {
    this.queue.push({ at: this.now + Math.max(0, delayMs), seq: this.seq++, run });
  }

  /** @internal */
  random(): number {
    return this.rng();
  }

  /** @internal */
  register(wanted: string | undefined, t: LoopbackTransport): string {
    const id = wanted ?? `peer-${++this.anon}`;
    if (this.peers.has(id)) throw new Error('id-taken');
    this.peers.set(id, t);
    return id;
  }

  /** @internal */
  unregister(id: string): void {
    this.peers.delete(id);
  }

  /** @internal */
  lookup(id: string): LoopbackTransport | undefined {
    return this.peers.get(id);
  }
}

class LoopbackLink implements Link {
  open = true;
  other!: LoopbackLink;
  /** Last scheduled reliable delivery time in this direction (keeps reliable traffic ordered). */
  private lastReliableAt = 0;

  constructor(
    readonly peerId: string,
    private readonly owner: LoopbackTransport,
    private readonly net: LoopbackNetwork,
  ) {}

  get rttMs(): number {
    return 2 * this.net.cond.latencyMs + this.net.cond.jitterMs;
  }

  send(channel: Channel, data: Uint8Array): void {
    if (!this.open || !this.other.open) return;
    const c = this.net.cond;
    const copies = channel === 'unreliable' && this.net.random() < c.duplicate ? 2 : 1;
    for (let i = 0; i < copies; i++) {
      if (channel === 'unreliable' && this.net.random() < c.loss) continue;
      let delay = c.latencyMs + this.net.random() * c.jitterMs;
      if (channel === 'reliable') {
        const at = Math.max(this.net.now + delay, this.lastReliableAt);
        this.lastReliableAt = at;
        delay = at - this.net.now;
      }
      const payload = data.slice();
      const dest = this.other;
      this.net.schedule(delay, () => {
        if (dest.open) dest.owner.deliver(dest, channel, payload);
      });
    }
  }

  close(): void {
    this.shutdown('closed');
  }

  /** @internal */
  shutdown(reason: string): void {
    if (!this.open) return;
    this.open = false;
    const other = this.other;
    this.net.schedule(this.net.cond.latencyMs, () => {
      if (other.open) {
        other.open = false;
        other.owner.dropped(other, reason === 'closed' ? 'remote-closed' : reason);
      }
    });
  }
}

class LoopbackTransport implements Transport {
  readonly kind = 'loopback' as const;
  private id: string | null = null;
  private handlers: TransportHandlers | null = null;
  private readonly links: LoopbackLink[] = [];

  constructor(private readonly net: LoopbackNetwork) {}

  async open(wantedId?: string): Promise<string> {
    this.id = this.net.register(wantedId, this);
    return this.id;
  }

  async connect(peerId: string): Promise<Link> {
    if (this.id === null) throw new Error('not-open');
    const remote = this.net.lookup(peerId);
    if (remote === undefined) throw new Error('unknown-peer');
    const mine = new LoopbackLink(peerId, this, this.net);
    const theirs = new LoopbackLink(this.id, remote, this.net);
    mine.other = theirs;
    theirs.other = mine;
    this.links.push(mine);
    remote.links.push(theirs);
    // The remote learns about the link one latency later (like a real handshake); the caller gets it immediately.
    this.net.schedule(this.net.cond.latencyMs, () => remote.handlers?.onLink(theirs));
    this.handlers?.onLink(mine);
    return mine;
  }

  setHandlers(h: TransportHandlers): void {
    this.handlers = h;
  }

  dispose(): void {
    for (const l of [...this.links]) l.shutdown('closed');
    this.links.length = 0;
    if (this.id !== null) this.net.unregister(this.id);
    this.id = null;
    this.handlers = null;
  }

  /** @internal */
  deliver(link: LoopbackLink, channel: Channel, data: Uint8Array): void {
    this.handlers?.onData(link, channel, data);
  }

  /** @internal */
  dropped(link: LoopbackLink, reason: string): void {
    const i = this.links.indexOf(link);
    if (i >= 0) this.links.splice(i, 1);
    this.handlers?.onClose(link, reason);
  }
}
