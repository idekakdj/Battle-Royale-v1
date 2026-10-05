/**
 * BrNetClient (WP-N3): the client side of an online Battle Royale. It never simulates: it sends the local intent to the host
 * (60 Hz, unreliable, loss-proof edge counters) and turns the host's snapshot stream into a smooth, delayed view.
 *
 *   sendIntent(intent)        every client sim tick
 *   sample(nowMs?)            every render frame → { prev, cur, alpha, view, events, … } (or null before the first snapshot)
 *
 * TIMELINE. Snapshots carry the host's sim time. For each arrival the client records `d = arrivalLocalMs − simMs`; the
 * windowed minimum of `d` is the transit-time estimate, slewed slowly (≤ 2 % of real time) into the clock so the render time
 * never jumps. Render time (in host sim ms) is `now − offset − interpDelay`, where `interpDelay ≈ 2 snapshot intervals` plus
 * a jitter allowance. Between two buffered snapshots `a ≤ R ≤ b` the view is interpolated (see interp.ts); if `R` runs past the
 * newest snapshot the newest one is extrapolated along its velocities for at most `maxExtrapolationMs`, then held.
 * Teleporting fighters (a `blink` event in the interval, or a jump beyond a plausible stride) are never interpolated.
 *
 * EVENTS arrive reliably with sequence ids (duplicates are dropped) and host sim timestamps; `sample().events` releases each one
 * when render time reaches its timestamp so hit sparks / sounds line up with the interpolated state.
 */

import type { FighterIntent, GameEvent, WorldSnapshot } from '../../core/types';
import type { GameChannel, OnlineStart } from '../types';
import { MSG } from '../types';
import { decodeEventBatch } from './eventCodec';
import { swapEventIds, swapIds } from './idSwap';
import { IntentSender } from './intentCodec';
import { detectTeleports, extrapolateSnapshot, lerpSnapshots, splitTeleports } from './interp';
import { NO_ACK, decodeResults, decodeSync, encodeSync, unwrapSnapshot, type BrResults } from './miscCodec';
import { SnapshotDecoder } from './snapshotCodec';

export interface BrNetClientOptions {
  channel: GameChannel;
  start: OnlineStart;
  /** Expected snapshot rate (only used until the real spacing is measured). Default 30. */
  snapshotHz?: number;
  /** Monotonic clock in ms (default `performance.now`). */
  now?: () => number;
  /** Base interpolation delay in snapshot intervals. Default 2. */
  interpDelaySnapshots?: number;
  /** Longest extrapolation past the newest snapshot (ms). Default 100. */
  maxExtrapolationMs?: number;
  /** Ping cadence (ms). Default 500. */
  pingIntervalMs?: number;
}

/** What the renderer / controller consumes each frame. */
export interface BrSample {
  /** Earlier bracketing snapshot (teleporting fighters already at their destination once `alpha` passes the jump instant). */
  prev: WorldSnapshot;
  /** Later bracketing snapshot (an extrapolated copy of the newest one while starved; teleporting fighters held at their origin until the jump). */
  cur: WorldSnapshot;
  /** 0..1 position between `prev` and `cur`. */
  alpha: number;
  /** `prev`/`cur` already blended per the rules in interp.ts — draw this. */
  view: WorldSnapshot;
  /** Events whose host timestamp has been reached since the previous `sample()` (in order). */
  events: GameEvent[];
  /** Render time in host sim seconds. */
  renderTimeS: number;
  /** True when render time is past the newest snapshot (extrapolating or holding). */
  starved: boolean;
  /** Milliseconds of extrapolation currently applied (0 when interpolating). */
  extrapolatedMs: number;
  /** The newest snapshot has `matchOver` and render time has reached it. */
  finished: boolean;
}

export interface BrClientStats {
  /** Round trip (ms): ping/pong EMA, falling back to the intent-ack estimate. */
  pingMs: number;
  /** Snapshot inter-arrival jitter (ms, RFC 3550-style EMA). */
  jitterMs: number;
  /** Newest snapshot sim time minus render time (ms) — the cushion left in the buffer. */
  bufferDepthMs: number;
  /** Snapshots held in the buffer. */
  buffered: number;
  /** Snapshot loss over the last ~3 s (0..1). */
  loss: number;
  snapshotsPerSec: number;
  kBpsIn: number;
  kBpsOut: number;
  /** Current interpolation delay (ms). */
  interpDelayMs: number;
  /** Measured snapshot spacing (ms). */
  snapshotIntervalMs: number;
  /** Milliseconds of extrapolation applied at the last sample. */
  extrapolatedMs: number;
  /** Frames that had to extrapolate / hold. */
  starvedFrames: number;
  /** Hard clock resyncs. */
  resyncs: number;
  /** Packets that failed to decode. */
  badPackets: number;
  duplicateSnapshots: number;
  duplicateEvents: number;
  /** Event sequence gaps (should stay 0: events are reliable). */
  eventGaps: number;
  intentsSent: number;
  keyframesReceived: number;
  /** ms since anything arrived from the host. */
  hostSilenceMs: number;
}

interface Buffered {
  simMs: number;
  seq: number; // extended
  snap: WorldSnapshot;
}

interface QueuedEvent {
  seq: number;
  timeMs: number;
  ev: GameEvent;
}

const OFFSET_WINDOW_MS = 4000;
const SLEW = 0.02;
const RESYNC_MS = 250;
const BUFFER_KEEP_MS = 600;
const BUFFER_MAX = 64;
const SEEN_MAX = 256;
const MAX_QUEUED_EVENTS = 4000;

export class BrNetClient {
  private readonly channel: GameChannel;
  private readonly start: OnlineStart;
  private readonly now: () => number;
  private readonly hostPeerId: string;
  private readonly maxExtrapMs: number;
  private readonly baseDelaySnaps: number;
  private readonly pingIntervalMs: number;
  private readonly decoder = new SnapshotDecoder();
  private readonly sender = new IntentSender();
  private readonly unsubs: Array<() => void> = [];

  private buffer: Buffered[] = [];
  private readonly seen = new Set<number>();
  private newestSeqExt = -1;
  private newestSeq16 = 0;
  private haveSeq = false;

  // clock
  private offsets: Array<{ at: number; d: number }> = [];
  private applied = 0;
  private delayMs = 0;
  private clockReady = false;
  private lastR = -Infinity;
  private excessEma = 0;
  private intervalMs: number;
  private jitter = 0;
  private lastArrival = 0;
  private lastSimMs = 0;
  private haveLast = false;

  // events
  private nextEventSeq = 0;
  private eventQueue: QueuedEvent[] = [];
  private blinkHist: Array<{ timeMs: number; id: number }> = [];

  // stats
  private pingEma = 0;
  private ackRttEma = 0;
  private lastPingAt = -Infinity;
  private lastRecvAt = 0;
  private arrivals: Array<{ at: number; seq: number; bytes: number }> = [];
  private sentLog: Array<{ at: number; bytes: number }> = [];
  private readonly intentSentAt = new Float64Array(128).fill(-1);
  private readonly intentSentSeq = new Int32Array(128).fill(-1);
  private readonly counters = {
    starvedFrames: 0,
    resyncs: 0,
    badPackets: 0,
    duplicateSnapshots: 0,
    duplicateEvents: 0,
    eventGaps: 0,
    intentsSent: 0,
    keyframesReceived: 0,
  };
  private lastExtrapMs = 0;
  private sampleAt = 0;

  private resultsMsg: BrResults | null = null;
  private readonly resultsCbs: Array<(r: BrResults) => void> = [];
  private readonly hostLeftCbs: Array<(reason: string) => void> = [];
  private hostLeft = false;

  constructor(opts: BrNetClientOptions) {
    this.channel = opts.channel;
    this.start = opts.start;
    this.hostPeerId = opts.start.hostPeerId;
    this.now = opts.now ?? (() => performance.now());
    this.maxExtrapMs = opts.maxExtrapolationMs ?? 100;
    this.baseDelaySnaps = opts.interpDelaySnapshots ?? 2;
    this.pingIntervalMs = opts.pingIntervalMs ?? 500;
    this.intervalMs = 1000 / (opts.snapshotHz ?? 30);
    this.delayMs = this.baseDelaySnaps * this.intervalMs;
    this.lastRecvAt = this.now();
    this.unsubs.push(this.channel.onMessage((peer, kind, payload) => this.onMessage(peer, kind, payload)));
    this.unsubs.push(this.channel.onPeerLeft((peer, reason) => this.onLeft(peer, reason)));
  }

  /** This machine's fighter id on the host's World. */
  get localSlot(): number {
    return this.start.localSlot;
  }

  // ── Outbound ───────────────────────────────────────────────────────────────

  /** Send this tick's intent (call every client sim tick, ~60 Hz). */
  sendIntent(intent: FighterIntent): void {
    const now = this.now();
    const needKey = this.decoder.needsKeyframe;
    const seq = this.sentSeq();
    const bytes = this.sender.next(intent, this.haveSeq ? this.newestSeq16 : 0, needKey);
    this.intentSentAt[seq & 127] = now;
    this.intentSentSeq[seq & 127] = seq;
    this.channel.send(this.hostPeerId, 'unreliable', MSG.BR_INTENT, bytes);
    this.counters.intentsSent++;
    this.sentLog.push({ at: now, bytes: bytes.length + 1 });
    if (now - this.lastPingAt >= this.pingIntervalMs) {
      this.lastPingAt = now;
      const p = encodeSync({ kind: 'ping', sentMs: now });
      this.channel.send(this.hostPeerId, 'unreliable', MSG.BR_SYNC, p);
      this.sentLog.push({ at: now, bytes: p.length + 1 });
    }
    while (this.sentLog.length > 0 && now - this.sentLog[0].at > 1000) this.sentLog.shift();
  }

  private sentSeq(): number {
    return this.counters.intentsSent & 0xffff;
  }

  /** Rising edges the sender has counted so far (tests / diagnostics). */
  get pressedEdges(): { attack: number; special: number; ultimate: number } {
    return this.sender.pressed;
  }

  // ── Inbound ────────────────────────────────────────────────────────────────

  private onMessage(peer: string, kind: number, payload: Uint8Array): void {
    if (peer !== this.hostPeerId) return;
    const now = this.now();
    this.lastRecvAt = now;
    if (kind === MSG.BR_SNAPSHOT) this.onSnapshot(payload, now);
    else if (kind === MSG.BR_EVENTS) this.onEvents(payload);
    else if (kind === MSG.BR_RESULTS) {
      const r = decodeResults(payload);
      if (r === null) this.counters.badPackets++;
      else if (this.resultsMsg === null) {
        this.resultsMsg = r;
        for (const cb of [...this.resultsCbs]) cb(r);
      }
    } else if (kind === MSG.BR_BYE) {
      // The host left the match early (it stays in the room, so the link never drops): do not wait for the silence timeout.
      this.onLeft(peer, 'host-left-match');
    } else if (kind === MSG.BR_SYNC) {
      const m = decodeSync(payload);
      if (m === null) this.counters.badPackets++;
      else if (m.kind === 'ping') this.channel.send(this.hostPeerId, 'unreliable', MSG.BR_SYNC, encodeSync({ kind: 'pong', echoMs: m.sentMs, nowMs: now }));
      else {
        const rtt = now - m.echoMs;
        if (rtt >= 0 && rtt < 30000) this.pingEma = this.pingEma === 0 ? rtt : this.pingEma * 0.7 + rtt * 0.3;
      }
    }
  }

  private onSnapshot(payload: Uint8Array, now: number): void {
    const w = unwrapSnapshot(payload);
    if (w === null) {
      this.counters.badPackets++;
      return;
    }
    const dec = this.decoder.decode(w.body);
    if (dec === null) {
      // A non-keyframe before the first keyframe is expected; anything else is a corrupt packet.
      if (!this.decoder.needsKeyframe) this.counters.badPackets++;
      return;
    }
    if (dec.keyframe) this.counters.keyframesReceived++;
    // Extend the 16-bit sequence number.
    let ext: number;
    if (!this.haveSeq) {
      ext = dec.seq;
      this.haveSeq = true;
      this.newestSeqExt = ext;
      this.newestSeq16 = dec.seq;
    } else {
      const diff = ((dec.seq - this.newestSeq16) << 16) >> 16;
      ext = this.newestSeqExt + diff;
      if (diff > 0) {
        this.newestSeqExt = ext;
        this.newestSeq16 = dec.seq;
      }
    }
    if (this.seen.has(ext)) {
      this.counters.duplicateSnapshots++;
      return;
    }
    this.seen.add(ext);
    if (this.seen.size > SEEN_MAX) {
      const lo = this.newestSeqExt - SEEN_MAX / 2;
      for (const s of this.seen) if (s < lo) this.seen.delete(s);
    }
    this.arrivals.push({ at: now, seq: ext, bytes: payload.length + 1 });
    while (this.arrivals.length > 0 && now - this.arrivals[0].at > 3000) this.arrivals.shift();

    // Intent-ack RTT estimate.
    if (w.holdMs !== NO_ACK) {
      const slot = w.ackIntentSeq & 127;
      if (this.intentSentSeq[slot] === w.ackIntentSeq) {
        const rtt = now - this.intentSentAt[slot] - w.holdMs;
        if (rtt >= 0 && rtt < 30000) this.ackRttEma = this.ackRttEma === 0 ? rtt : this.ackRttEma * 0.8 + rtt * 0.2;
      }
    }

    const simMs = Math.round(dec.snapshot.time * 1000);
    // A snapshot that carries no new sim time (the host's repeated final snapshot, or a stalled host) adds nothing.
    for (const b of this.buffer) {
      if (b.simMs === simMs) {
        this.counters.duplicateSnapshots++;
        return;
      }
    }
    // Clock bookkeeping (only for snapshots that are newest so far, so reordered old ones don't skew it).
    const last = this.buffer.length > 0 ? this.buffer[this.buffer.length - 1] : null;
    if (last === null || (ext > last.seq && simMs > last.simMs)) {
      const d = now - simMs;
      this.offsets.push({ at: now, d });
      while (this.offsets.length > 0 && now - this.offsets[0].at > OFFSET_WINDOW_MS) this.offsets.shift();
      if (this.haveLast && last !== null) {
        const dSeq = ext - last.seq;
        const dSim = simMs - last.simMs;
        if (dSeq > 0 && dSim > 0) this.intervalMs += (dSim / dSeq - this.intervalMs) * 0.1;
        const dd = Math.abs(now - this.lastArrival - (simMs - this.lastSimMs));
        this.jitter += (dd - this.jitter) / 16;
      }
      this.haveLast = true;
      this.lastArrival = now;
      this.lastSimMs = simMs;
      const target = this.minOffset();
      this.excessEma += (Math.max(0, d - target) - this.excessEma) / 16;
    }

    // Insert sorted by simMs.
    let i = this.buffer.length;
    while (i > 0 && this.buffer[i - 1].simMs > simMs) i--;
    this.buffer.splice(i, 0, { simMs, seq: ext, snap: dec.snapshot });
    if (this.buffer.length > BUFFER_MAX) this.buffer.shift();
  }

  private onEvents(payload: Uint8Array): void {
    const b = decodeEventBatch(payload);
    if (b === null) {
      this.counters.badPackets++;
      return;
    }
    for (let i = 0; i < b.events.length; i++) {
      const seq = b.firstSeq + i;
      if (seq < this.nextEventSeq) {
        this.counters.duplicateEvents++;
        continue;
      }
      if (seq > this.nextEventSeq) this.counters.eventGaps += seq - this.nextEventSeq;
      this.nextEventSeq = seq + 1;
      const ev = b.events[i];
      this.eventQueue.push({ seq, timeMs: b.timeMs, ev });
      if (ev.type === 'blink') this.blinkHist.push({ timeMs: b.timeMs, id: ev.fighterId });
      // Bounded memory even if the controller stops sampling (backgrounded tab): drop the oldest.
      if (this.eventQueue.length > MAX_QUEUED_EVENTS) this.eventQueue.splice(0, this.eventQueue.length - MAX_QUEUED_EVENTS);
      if (this.blinkHist.length > 256) this.blinkHist.splice(0, this.blinkHist.length - 256);
    }
  }

  private onLeft(peer: string, reason: string): void {
    if (peer !== this.hostPeerId || this.hostLeft) return;
    this.hostLeft = true;
    for (const cb of [...this.hostLeftCbs]) cb(reason);
  }

  /** Fired once when the host's link drops (the match is over for this client). */
  onHostLeft(cb: (reason: string) => void): () => void {
    this.hostLeftCbs.push(cb);
    return () => {
      const i = this.hostLeftCbs.indexOf(cb);
      if (i >= 0) this.hostLeftCbs.splice(i, 1);
    };
  }

  /** Fired once with the final standings. */
  onResults(cb: (r: BrResults) => void): () => void {
    this.resultsCbs.push(cb);
    if (this.resultsMsg !== null) cb(this.resultsMsg);
    return () => {
      const i = this.resultsCbs.indexOf(cb);
      if (i >= 0) this.resultsCbs.splice(i, 1);
    };
  }

  results(): BrResults | null {
    return this.resultsMsg;
  }

  // ── Sampling ───────────────────────────────────────────────────────────────

  private minOffset(): number {
    let m = Infinity;
    for (const o of this.offsets) if (o.d < m) m = o.d;
    return m;
  }

  private targetDelay(): number {
    const base = this.baseDelaySnaps * this.intervalMs;
    return base + Math.max(0, Math.min(150, 1.5 * this.excessEma));
  }

  /** Newest received snapshot (raw, un-interpolated), or null. */
  latest(): WorldSnapshot | null {
    return this.buffer.length > 0 ? this.buffer[this.buffer.length - 1].snap : null;
  }

  /**
   * The state to draw at local time `nowMs` (default: the client clock), plus the events that are now due.
   * Returns null until the first snapshot (keyframe) has been received.
   */
  sample(nowMs?: number): BrSample | null {
    const now = nowMs ?? this.now();
    const buf = this.buffer;
    if (buf.length === 0) return null;
    const newest = buf[buf.length - 1];

    // Clock: slew the offset and the delay toward their targets.
    const target = this.minOffset();
    const dTarget = this.targetDelay();
    if (!this.clockReady) {
      this.applied = target;
      this.delayMs = dTarget;
      this.clockReady = true;
      this.sampleAt = now;
    } else {
      const dt = Math.max(0, Math.min(250, now - this.sampleAt));
      this.sampleAt = now;
      const err = target - this.applied;
      if (Math.abs(err) > RESYNC_MS) {
        this.applied = target;
        this.counters.resyncs++;
      } else {
        const step = SLEW * dt;
        this.applied += Math.max(-step, Math.min(step, err));
      }
      const derr = dTarget - this.delayMs;
      const dstep = SLEW * dt;
      this.delayMs += Math.max(-dstep, Math.min(dstep, derr));
    }

    let R = now - this.applied - this.delayMs;
    if (R < this.lastR) R = this.lastR; // render time never runs backwards
    const oldest = buf[0];
    if (R < oldest.simMs) R = oldest.simMs;
    // Once the final (matchOver) snapshot is in, the sim clock has stopped for good: hold it, don't extrapolate.
    const limit = newest.snap.matchOver ? newest.simMs : newest.simMs + this.maxExtrapMs;
    if (R > limit) R = limit;
    this.lastR = R;

    let prev: WorldSnapshot;
    let cur: WorldSnapshot;
    let alpha: number;
    let view: WorldSnapshot;
    let extrap = 0;
    if (R > newest.simMs) {
      // Starved: extrapolate the newest snapshot (bounded by maxExtrapMs via the clamp above).
      extrap = R - newest.simMs;
      cur = extrapolateSnapshot(newest.snap, extrap / 1000);
      prev = newest.snap;
      alpha = 1;
      view = cur;
    } else {
      let bi = buf.length - 1;
      while (bi > 0 && buf[bi - 1].simMs > R) bi--;
      const b = buf[bi];
      const a = bi > 0 ? buf[bi - 1] : b;
      const span = b.simMs - a.simMs;
      alpha = span > 0 ? (R - a.simMs) / span : 1;
      const tele = detectTeleports(a.snap, b.snap, this.blinkedBetween(a.simMs, b.simMs));
      const pair = splitTeleports(a.snap, b.snap, tele, alpha);
      prev = pair.prev;
      cur = pair.cur;
      view = a === b ? b.snap : lerpSnapshots(a.snap, b.snap, alpha, tele);
    }
    this.lastExtrapMs = extrap;
    if (extrap > 0) this.counters.starvedFrames++;

    // Due events.
    const events: GameEvent[] = [];
    let n = 0;
    const q = this.eventQueue;
    while (n < q.length && q[n].timeMs <= R) events.push(q[n++].ev);
    if (n > 0) q.splice(0, n);

    // Prune the buffer (keep the bracket + history) and old blink records.
    while (buf.length > 2 && buf[1].simMs < R - BUFFER_KEEP_MS) buf.shift();
    while (this.blinkHist.length > 0 && this.blinkHist[0].timeMs < R - 3000) this.blinkHist.shift();

    return {
      prev,
      cur,
      alpha,
      view,
      events,
      renderTimeS: R / 1000,
      starved: extrap > 0,
      extrapolatedMs: extrap,
      finished: newest.snap.matchOver && R >= newest.simMs,
    };
  }

  /** Fighter id → host time (ms) of its blink inside (aMs, bMs]. */
  private blinkedBetween(aMs: number, bMs: number): Map<number, number> | undefined {
    let out: Map<number, number> | undefined;
    for (const h of this.blinkHist) {
      if (h.timeMs > aMs && h.timeMs <= bMs) (out ??= new Map()).set(h.id, h.timeMs);
    }
    return out;
  }

  // ── Diagnostics ────────────────────────────────────────────────────────────

  stats(): BrClientStats {
    const now = this.now();
    let loss = 0;
    let sps = 0;
    let bytesIn = 0;
    if (this.arrivals.length > 1) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const a of this.arrivals) {
        if (a.seq < lo) lo = a.seq;
        if (a.seq > hi) hi = a.seq;
        if (now - a.at <= 1000) {
          sps++;
          bytesIn += a.bytes;
        }
      }
      const expected = hi - lo + 1;
      loss = expected > 0 ? Math.max(0, 1 - this.arrivals.length / expected) : 0;
    }
    let bytesOut = 0;
    for (const s of this.sentLog) if (now - s.at <= 1000) bytesOut += s.bytes;
    const newest = this.buffer.length > 0 ? this.buffer[this.buffer.length - 1] : null;
    return {
      pingMs: this.pingEma > 0 ? this.pingEma : this.ackRttEma,
      jitterMs: this.jitter,
      bufferDepthMs: newest === null || !Number.isFinite(this.lastR) ? 0 : newest.simMs - this.lastR,
      buffered: this.buffer.length,
      loss,
      snapshotsPerSec: sps,
      kBpsIn: bytesIn / 1000,
      kBpsOut: bytesOut / 1000,
      interpDelayMs: this.delayMs,
      snapshotIntervalMs: this.intervalMs,
      extrapolatedMs: this.lastExtrapMs,
      starvedFrames: this.counters.starvedFrames,
      resyncs: this.counters.resyncs,
      badPackets: this.counters.badPackets,
      duplicateSnapshots: this.counters.duplicateSnapshots,
      duplicateEvents: this.counters.duplicateEvents,
      eventGaps: this.counters.eventGaps,
      intentsSent: this.counters.intentsSent,
      keyframesReceived: this.counters.keyframesReceived,
      hostSilenceMs: now - this.lastRecvAt,
    };
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.resultsCbs.length = 0;
    this.hostLeftCbs.length = 0;
  }
}

/**
 * The same sample with fighter ids `a` and `b` exchanged everywhere (events included) — the BR MatchController wants the local
 * player at id 0, so a client in slot `s` feeds it `swapSample(sample, 0, s)`.
 */
export function swapSample(s: BrSample, a: number, b: number): BrSample {
  if (a === b) return s;
  const prev = swapIds(s.prev, a, b);
  const cur = s.cur === s.prev ? prev : swapIds(s.cur, a, b);
  return {
    ...s,
    prev,
    cur,
    view: swapIds(s.view, a, b),
    events: s.events.map((e) => swapEventIds(e, a, b)),
  };
}

