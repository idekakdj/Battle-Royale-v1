/**
 * `ConditionedTransport` — wraps ANY {@link Transport} and degrades what THIS machine sends with real timers, for QA in
 * two browser tabs / windows (`?netsim=latency:80,jitter:20,loss:0.05`). Outgoing packets are delayed by
 * `latency + U[0, jitter]` ms; `unreliable` ones are additionally dropped with probability `loss` (and may overtake each
 * other under jitter); `reliable` ones keep their order. Incoming packets are untouched, so with netsim on both sides
 * a round trip costs the sum of both settings.
 */

import type { Channel, Link, Transport, TransportHandlers } from '../types';

export interface NetSim {
  /** Added one-way delay (ms). */
  latencyMs: number;
  /** Extra uniform random delay in [0, jitterMs] (ms). */
  jitterMs: number;
  /** Unreliable loss probability 0..1. */
  loss: number;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
};

/** Parse `latency:80,jitter:20,loss:0.05` (also `latencyMs`, `lat`, `ping`; `loss` > 1 is read as a percentage). Null when empty/invalid. */
export function parseNetSim(raw: string | null | undefined): NetSim | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const sim: NetSim = { latencyMs: 0, jitterMs: 0, loss: 0 };
  let any = false;
  for (const part of raw.split(',')) {
    const [k, v] = part.split(':').map((x) => x.trim().toLowerCase());
    const n = Number(v);
    if (k === undefined || v === undefined || !Number.isFinite(n) || n < 0) continue;
    if (k === 'latency' || k === 'latencyms' || k === 'lat' || k === 'delay') sim.latencyMs = Math.min(n, 5000);
    else if (k === 'jitter' || k === 'jitterms') sim.jitterMs = Math.min(n, 5000);
    else if (k === 'loss' || k === 'drop') sim.loss = Math.min(1, n > 1 ? n / 100 : n);
    else continue;
    any = true;
  }
  return any ? sim : null;
}

class ConditionedLink implements Link {
  /** Reliable traffic is delivered in order: never earlier than the previous reliable packet. */
  private lastReliableAt = 0;
  private readonly timers = new Set<unknown>();

  constructor(
    readonly inner: Link,
    private readonly owner: ConditionedTransport,
  ) {}

  get peerId(): string {
    return this.inner.peerId;
  }
  get open(): boolean {
    return this.inner.open;
  }
  get rttMs(): number {
    return this.inner.rttMs;
  }

  reportRtt(ms: number): void {
    this.inner.reportRtt?.(ms);
  }

  send(channel: Channel, data: Uint8Array): void {
    const { sim, timers, rng } = this.owner;
    if (channel === 'unreliable' && rng() < sim.loss) return;
    let delay = sim.latencyMs + rng() * sim.jitterMs;
    const copy = data.slice();
    if (channel === 'reliable') {
      const now = timers.now();
      const at = Math.max(now + delay, this.lastReliableAt);
      this.lastReliableAt = at;
      delay = at - now;
      if (delay <= 0 && this.relQueue.length === 0) {
        this.inner.send(channel, copy);
        return;
      }
      // QA: browsers truncate timer delays to whole milliseconds, so two timers meant for the same instant can fire in the
      // wrong order. Every timer therefore flushes the whole queue up to "now" in FIFO order: a reliable channel never reorders.
      this.relQueue.push({ at, data: copy });
      const h = timers.setTimeout(() => {
        this.timers.delete(h);
        this.flushReliable(timers.now() + 1.5);
      }, Math.max(0, delay));
      this.timers.add(h);
      return;
    }
    if (delay <= 0) {
      this.inner.send(channel, copy);
      return;
    }
    const h = timers.setTimeout(() => {
      this.timers.delete(h);
      if (this.inner.open) this.inner.send(channel, copy);
    }, delay);
    this.timers.add(h);
  }

  private readonly relQueue: Array<{ at: number; data: Uint8Array }> = [];

  private flushReliable(upTo: number): void {
    while (this.relQueue.length > 0 && this.relQueue[0].at <= upTo) {
      const item = this.relQueue.shift() as { at: number; data: Uint8Array };
      if (this.inner.open) this.inner.send('reliable', item.data);
    }
  }

  close(): void {
    // Let already-queued packets (e.g. a goodbye message) out before the link goes down.
    const wait = Math.max(0, this.lastReliableAt - this.owner.timers.now());
    if (wait <= 0 || this.timers.size === 0) {
      this.cancelPending();
      this.inner.close();
      return;
    }
    this.owner.timers.setTimeout(() => {
      this.cancelPending();
      this.inner.close();
    }, wait + 5);
  }

  cancelPending(): void {
    for (const h of this.timers) this.owner.timers.clearTimeout(h);
    this.timers.clear();
    this.relQueue.length = 0;
  }
}

export class ConditionedTransport implements Transport {
  readonly kind: Transport['kind'];
  readonly rng: () => number;
  readonly timers: Timers;
  private readonly wrapped = new WeakMap<Link, ConditionedLink>();

  constructor(
    private readonly inner: Transport,
    readonly sim: NetSim,
    opts: { rng?: () => number; timers?: Timers } = {},
  ) {
    this.kind = inner.kind;
    this.rng = opts.rng ?? Math.random;
    this.timers = opts.timers ?? realTimers;
  }

  private wrap(link: Link): ConditionedLink {
    let w = this.wrapped.get(link);
    if (w === undefined) {
      w = new ConditionedLink(link, this);
      this.wrapped.set(link, w);
    }
    return w;
  }

  open(wantedId?: string): Promise<string> {
    return this.inner.open(wantedId);
  }

  async connect(peerId: string, timeoutMs?: number): Promise<Link> {
    return this.wrap(await this.inner.connect(peerId, timeoutMs));
  }

  setHandlers(h: TransportHandlers): void {
    this.inner.setHandlers({
      onLink: (l) => h.onLink(this.wrap(l)),
      onData: (l, c, d) => h.onData(this.wrap(l), c, d),
      onClose: (l, r) => {
        const w = this.wrap(l);
        w.cancelPending();
        h.onClose(w, r);
      },
    });
  }

  dispose(): void {
    this.inner.dispose();
  }
}
