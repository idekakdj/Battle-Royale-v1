/**
 * Test model of the 'unreliable' data channel under stress (v1.10.1), used with the BR loopback harness (`brNetHarness.ts`).
 *
 * `throttle(channel, net, cfg)` puts a byte-rate-limited FIFO "wire" in front of a machine's outgoing 'unreliable' packets
 * (reliable ones are untouched — they live on their own SCTP association in production). The backlog guard is the REAL one
 * (`unreliableBlock` + the cap in `cfg.maxBacklog`), so the model exercises exactly what `PeerJsLink.send` does:
 *
 *   mode 'retransmit'  the pre-1.10.1 behaviour: SCTP never gives a packet up. During an outage NOTHING departs, the queue grows
 *                      until the guard (64 KB then) starts dropping, and after the outage it drains at a collapsed rate.
 *   mode 'abandon'     `maxRetransmits: 0`: whatever departs into a dead network is LOST (not retried); after the outage the
 *                      sender may stay blocked for an RTO (`rtoStallMs`) and then flushes what the 8 KB guard let through.
 *
 * The model is deliberately simple (1 ms steps) — it is a regression harness for "late is worse than lost", not an SCTP emulator.
 */

import type { LinkChannel } from '../../src/online/channel';
import type { LoopbackNetwork } from '../../src/online/transport/loopback';
import { unreliableBlock } from '../../src/online/transport/fastChannel';

export interface PipeConfig {
  mode: 'abandon' | 'retransmit';
  /** The guard threshold in bytes (`MAX_UNRELIABLE_BACKLOG` for 1.10.1; 64 KB for the old transport). */
  maxBacklog: number;
  /** Wire speed in bytes per ms (default: unlimited). */
  rate?: number;
  /** Outage windows on the network clock (ms). */
  outages?: ReadonlyArray<{ from: number; to: number }>;
  /** 'abandon': the sender stays blocked this long after an outage ends (retransmission-timer backoff). */
  rtoStallMs?: number;
  /** 'retransmit': after an outage the wire drains at `recoverRate` bytes/ms for `recoverMs` (congestion window collapsed). */
  recoverRate?: number;
  recoverMs?: number;
}

export interface PipeStats {
  offered: number;
  delivered: number;
  /** Refused by the backlog guard (= `PeerJsLink`'s dropped counter). */
  guardDrops: number;
  /** Departed into the outage and abandoned. */
  wireLost: number;
  maxBuffered: number;
}

export class Pipe {
  readonly stats: PipeStats = { offered: 0, delivered: 0, guardDrops: 0, wireLost: 0, maxBuffered: 0 };
  private queue: Array<{ size: number; deliver: () => void }> = [];
  private bytes = 0;
  private credit = 0;
  private stopped = false;

  constructor(
    private readonly net: LoopbackNetwork,
    private readonly cfg: PipeConfig,
  ) {
    this.tick();
  }

  get buffered(): number {
    return this.bytes;
  }

  stop(): void {
    this.stopped = true;
  }

  offer(size: number, deliver: () => void): void {
    this.stats.offered++;
    if (unreliableBlock({ readyState: 'open', bufferedAmount: this.bytes }, this.cfg.maxBacklog) !== null) {
      this.stats.guardDrops++;
      return;
    }
    this.queue.push({ size, deliver });
    this.bytes += size;
    if (this.bytes > this.stats.maxBuffered) this.stats.maxBuffered = this.bytes;
  }

  private inOutage(t: number): boolean {
    for (const o of this.cfg.outages ?? []) if (t >= o.from && t < o.to) return true;
    return false;
  }

  private sinceOutageEnd(t: number): number {
    let best = Infinity;
    for (const o of this.cfg.outages ?? []) if (t >= o.to) best = Math.min(best, t - o.to);
    return best;
  }

  private tick(): void {
    if (this.stopped) return;
    this.net.schedule(1, () => {
      this.step(this.net.now);
      this.tick();
    });
  }

  private step(t: number): void {
    const cfg = this.cfg;
    let rate = cfg.rate ?? Infinity;
    let lose = false;
    if (cfg.mode === 'retransmit') {
      if (this.inOutage(t)) rate = 0;
      else if (this.sinceOutageEnd(t) < (cfg.recoverMs ?? 0)) rate = Math.min(rate, cfg.recoverRate ?? rate);
    } else if (this.inOutage(t)) {
      lose = true;
    } else if (this.sinceOutageEnd(t) < (cfg.rtoStallMs ?? 0)) {
      rate = 0;
    }
    if (this.queue.length === 0) {
      this.credit = 0;
      return;
    }
    this.credit = rate === Infinity ? Infinity : this.credit + rate;
    while (this.queue.length > 0 && this.credit >= this.queue[0].size) {
      const p = this.queue.shift() as { size: number; deliver: () => void };
      this.bytes -= p.size;
      if (this.credit !== Infinity) this.credit -= p.size;
      if (lose) this.stats.wireLost++;
      else {
        this.stats.delivered++;
        p.deliver();
      }
    }
  }
}

/** Route this channel's outgoing 'unreliable' packets through a {@link Pipe}. Returns the pipe (call `stop()` when done). */
export function throttle(channel: LinkChannel, net: LoopbackNetwork, cfg: PipeConfig): Pipe {
  const pipe = new Pipe(net, cfg);
  const orig = channel.send.bind(channel);
  channel.send = (peerId, ch, kind, payload): void => {
    if (ch !== 'unreliable') {
      orig(peerId, ch, kind, payload);
      return;
    }
    pipe.offer(payload.length + 1, () => orig(peerId, ch, kind, payload));
  };
  return pipe;
}
