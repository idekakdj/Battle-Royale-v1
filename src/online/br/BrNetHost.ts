/**
 * BrNetHost (WP-N3): the host side of an online Battle Royale. The host machine runs the one `World` + `BotManager`; this
 * class talks to the remote humans over a {@link GameChannel}:
 *
 *   inbound   BR_INTENT (unreliable, 60 Hz)  → per-slot {@link RemoteIntent}   → `remoteIntent(slot)`
 *             BR_SYNC ping/pong                → RTT per client
 *   outbound  BR_SNAPSHOT (unreliable, 30 Hz default) shared body + 3-byte per-client wrapper
 *             BR_EVENTS   (reliable, one batch per tick that had events, sequence-numbered)
 *             BR_RESULTS  (reliable, once, when the match ends)
 *
 * Controller wiring (per fixed sim tick, 60 Hz):
 *
 *   for each human remote slot s:  const i = host.remoteIntent(s); if (i) world.setIntent(s, i); else <bot intent>
 *   world.step(dt); const snap = world.snapshot();
 *   host.afterStep(snap, eventsEmittedThisTick);
 *   // host.onPeerLeft((slot) => …hand the slot to a bot…)
 *
 * `remoteIntent(slot)` MUST be called at most once per sim tick per slot (it consumes the slot's queued edges).
 */

import { SIM_DT } from '../../config/balance';
import type { FighterIntent, GameEvent, WorldSnapshot } from '../../core/types';
import type { GameChannel, OnlineSlotInfo, OnlineStart } from '../types';
import { MSG } from '../types';
import { encodeEventBatches } from './eventCodec';
import { RemoteIntent, decodeIntentPacket, type RemoteIntentStats } from './intentCodec';
import { decodeSync, encodeResults, encodeSync, wrapSnapshot, type BrResults } from './miscCodec';
import { STATS_EVERY, encodeSnapshot } from './snapshotCodec';

export interface BrNetHostOptions {
  channel: GameChannel;
  start: OnlineStart;
  /** Snapshots per second (a divisor of 60: 20 / 30 / 60). Default 30. */
  snapshotHz?: number;
  /** Monotonic clock in ms (default `performance.now`). Tests inject the loopback clock. */
  now?: () => number;
  /** Keyframe (statics) cadence in ms. Default 2000. */
  keyframeIntervalMs?: number;
  /** A remote intent stream silent for this long stops the fighter (movement/block released). Default 300 ms. */
  staleIntentMs?: number;
  /** Ping cadence per client (ms). Default 500. */
  pingIntervalMs?: number;
}

export interface BrHostClientStats {
  slot: number;
  peerId: string;
  name: string;
  connected: boolean;
  /** Smoothed round-trip time (ms) from BR_SYNC ping/pong (0 until measured). */
  rttMs: number;
  bytesOut: number;
  bytesIn: number;
  /** Rolling outbound / inbound rate (kilobytes per second, ~1 s window). */
  kBpsOut: number;
  kBpsIn: number;
  snapshotsSent: number;
  keyframesSent: number;
  /** Newest snapshot seq the client reports having received (−1 before the first report). */
  ackSnap: number;
  /** Snapshots sent but not yet acknowledged. */
  ackLag: number;
  intent: RemoteIntentStats;
}

interface Client {
  slot: number;
  peerId: string;
  name: string;
  connected: boolean;
  intent: RemoteIntent;
  rttMs: number;
  bytesOut: number;
  bytesIn: number;
  rateOutBytes: number;
  rateInBytes: number;
  rateAt: number;
  kBpsOut: number;
  kBpsIn: number;
  snapshotsSent: number;
  keyframesSent: number;
  nextPingAt: number;
}

const RATE_WINDOW_MS = 1000;
/** After the match ends the final snapshot is repeated this many times, this far apart. */
const FINAL_REPEATS = 8;
const FINAL_REPEAT_MS = 100;

export class BrNetHost {
  private readonly channel: GameChannel;
  private readonly start: OnlineStart;
  private readonly now: () => number;
  private readonly tickEvery: number;
  private readonly keyframeEvery: number;
  private readonly pingIntervalMs: number;
  private readonly bySlot = new Map<number, Client>();
  private readonly byPeer = new Map<string, Client>();
  private readonly leftCbs: Array<(slot: number, reason: string) => void> = [];
  private readonly unsubs: Array<() => void> = [];

  private tick = 0;
  private snapSeq = 0;
  private snapsSent = 0;
  private eventSeq = 0;
  private matchOverSent = false;
  private byeSent = false;
  private finalRepeats = 0;
  private lastFinalAt = 0;
  private readonly placements = new Map<number, number>();
  private lastResults: BrResults | null = null;

  constructor(opts: BrNetHostOptions) {
    this.channel = opts.channel;
    this.start = opts.start;
    this.now = opts.now ?? (() => performance.now());
    const hz = Math.max(10, Math.min(60, opts.snapshotHz ?? 30));
    this.tickEvery = Math.max(1, Math.round(1 / (hz * SIM_DT)));
    const effHz = 1 / (this.tickEvery * SIM_DT);
    this.keyframeEvery = Math.max(1, Math.round(((opts.keyframeIntervalMs ?? 2000) / 1000) * effHz));
    this.pingIntervalMs = opts.pingIntervalMs ?? 500;

    const t0 = this.now();
    for (const s of this.start.slots) {
      if (s.kind !== 'human' || s.peerId === null || s.peerId === this.channel.localPeerId) continue;
      const c = this.makeClient(s, opts.staleIntentMs ?? 300, t0);
      this.bySlot.set(s.slot, c);
      this.byPeer.set(s.peerId, c);
    }
    this.unsubs.push(this.channel.onMessage((peer, kind, payload) => this.onMessage(peer, kind, payload)));
    this.unsubs.push(this.channel.onPeerLeft((peer, reason) => this.onLeft(peer, reason)));
  }

  private makeClient(s: OnlineSlotInfo, staleMs: number, t0: number): Client {
    return {
      slot: s.slot,
      peerId: s.peerId as string,
      name: s.name,
      connected: true,
      intent: new RemoteIntent(staleMs),
      rttMs: 0,
      bytesOut: 0,
      bytesIn: 0,
      rateOutBytes: 0,
      rateInBytes: 0,
      rateAt: t0,
      kBpsOut: 0,
      kBpsIn: 0,
      snapshotsSent: 0,
      keyframesSent: 0,
      nextPingAt: t0,
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Slots driven by connected remote humans (the controller must NOT run a bot brain for these). */
  remoteSlots(): number[] {
    const out: number[] = [];
    for (const c of this.bySlot.values()) if (c.connected) out.push(c.slot);
    return out.sort((a, b) => a - b);
  }

  isRemote(slot: number): boolean {
    return this.bySlot.get(slot)?.connected === true;
  }

  /**
   * The intent to feed `world.setIntent(slot, …)` THIS tick, or `null` when the slot has no connected remote human (bot /
   * local player / left). Call once per sim tick; the returned object is reused by the next call.
   */
  remoteIntent(slot: number): FighterIntent | null {
    const c = this.bySlot.get(slot);
    if (c === undefined || !c.connected) return null;
    return c.intent.consume(this.now());
  }

  /** Register a callback fired when a remote human's link drops — turn the slot into a bot. */
  onPeerLeft(cb: (slot: number, reason: string) => void): () => void {
    this.leftCbs.push(cb);
    return () => {
      const i = this.leftCbs.indexOf(cb);
      if (i >= 0) this.leftCbs.splice(i, 1);
    };
  }

  /**
   * Call once per sim tick after `world.step`, with that tick's snapshot and the events emitted during the step.
   * Sends events immediately (reliable) and snapshots at the configured rate; the first snapshot with `matchOver` is always
   * sent (a full keyframe, with stats) and followed by the results message.
   */
  afterStep(snapshot: WorldSnapshot, events: readonly GameEvent[]): void {
    const now = this.now();
    this.tick++;

    for (const e of events) if (e.type === 'death') this.placements.set(e.targetId, e.placement);

    if (events.length > 0) {
      const timeMs = Math.round(snapshot.time * 1000);
      const batches = encodeEventBatches(this.eventSeq, timeMs, events);
      this.eventSeq += events.length;
      for (const c of this.bySlot.values()) {
        if (!c.connected) continue;
        for (const b of batches) this.sendTo(c, 'reliable', MSG.BR_EVENTS, b);
      }
    }

    const finishing = snapshot.matchOver && !this.matchOverSent;
    if (finishing) {
      this.sendSnapshot(snapshot, true, now);
      this.lastFinalAt = now;
    } else if (snapshot.matchOver) {
      // The sim clock has stopped. The final snapshot rides an unreliable channel, so repeat it a few times (the client
      // ignores snapshots that carry no new sim time) instead of streaming an endless identical feed.
      if (this.finalRepeats < FINAL_REPEATS && now - this.lastFinalAt >= FINAL_REPEAT_MS) {
        this.finalRepeats++;
        this.lastFinalAt = now;
        this.sendSnapshot(snapshot, true, now);
      }
    } else if (this.tick % this.tickEvery === 0) {
      this.sendSnapshot(snapshot, false, now);
    }

    if (finishing) {
      this.matchOverSent = true;
      const results = this.buildResults(snapshot);
      this.lastResults = results;
      const bytes = encodeResults(results);
      for (const c of this.bySlot.values()) if (c.connected) this.sendTo(c, 'reliable', MSG.BR_RESULTS, bytes);
    }

    for (const c of this.bySlot.values()) {
      if (!c.connected) continue;
      if (now >= c.nextPingAt) {
        c.nextPingAt = now + this.pingIntervalMs;
        this.sendTo(c, 'unreliable', MSG.BR_SYNC, encodeSync({ kind: 'ping', sentMs: now }));
      }
      this.updateRates(c, now);
    }
  }

  /** Final standings (available once the match-over snapshot has gone through `afterStep`). */
  results(): BrResults | null {
    return this.lastResults;
  }

  clientStats(slot: number): BrHostClientStats | null {
    const c = this.bySlot.get(slot);
    if (c === undefined) return null;
    const ack = c.intent.ackSnap;
    const sent = (this.snapSeq - 1) & 0xffff;
    return {
      slot: c.slot,
      peerId: c.peerId,
      name: c.name,
      connected: c.connected,
      rttMs: c.rttMs,
      bytesOut: c.bytesOut,
      bytesIn: c.bytesIn,
      kBpsOut: c.kBpsOut,
      kBpsIn: c.kBpsIn,
      snapshotsSent: c.snapshotsSent,
      keyframesSent: c.keyframesSent,
      ackSnap: ack,
      ackLag: ack < 0 || c.snapshotsSent === 0 ? 0 : (sent - ack) & 0xffff,
      intent: { ...c.intent.stats },
    };
  }

  allStats(): BrHostClientStats[] {
    const out: BrHostClientStats[] = [];
    for (const slot of [...this.bySlot.keys()].sort((a, b) => a - b)) {
      const s = this.clientStats(slot);
      if (s !== null) out.push(s);
    }
    return out;
  }

  /**
   * The host is leaving the match early (menu → Leave): tell every client right away so they do not sit through the silence
   * timeout. Idempotent; a no-op once the match is over (the results message already told them).
   */
  sendBye(): void {
    if (this.byeSent || this.matchOverSent) return;
    this.byeSent = true;
    for (const c of this.bySlot.values()) if (c.connected) this.sendTo(c, 'reliable', MSG.BR_BYE, new Uint8Array(0));
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.leftCbs.length = 0;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private sendSnapshot(snapshot: WorldSnapshot, force: boolean, now: number): void {
    const seq = this.snapSeq;
    this.snapSeq = (this.snapSeq + 1) & 0xffff;
    const periodic = this.snapsSent % this.keyframeEvery === 0 || force;
    this.snapsSent++;
    const withStats = seq % STATS_EVERY === 0;
    let plain: Uint8Array | null = null;
    let key: Uint8Array | null = null;
    for (const c of this.bySlot.values()) {
      if (!c.connected) continue;
      const wantKey = periodic || c.intent.needKeyframe;
      let body: Uint8Array;
      if (wantKey) {
        key ??= encodeSnapshot(snapshot, { seq, keyframe: true });
        body = key;
        c.keyframesSent++;
      } else {
        plain ??= encodeSnapshot(snapshot, { seq, stats: withStats });
        body = plain;
      }
      const heard = c.intent.newestSeq >= 0;
      const wrapped = wrapSnapshot(heard ? c.intent.newestSeq : 0, heard ? now - c.intent.lastRecv : null, body);
      this.sendTo(c, 'unreliable', MSG.BR_SNAPSHOT, wrapped);
      c.snapshotsSent++;
    }
  }

  private buildResults(s: WorldSnapshot): BrResults {
    const fighters = s.fighters.map((f) => ({
      placement: f.id === s.winnerId ? 1 : (this.placements.get(f.id) ?? 0),
      kills: f.kills,
      damageDealt: f.damageDealt,
      damageBlocked: f.damageBlocked,
      ultsUsed: f.ultsUsed,
    }));
    return { winnerId: s.winnerId, matchTimeS: Math.max(0, s.time), fighters };
  }

  private sendTo(c: Client, ch: 'reliable' | 'unreliable', kind: number, payload: Uint8Array): void {
    this.channel.send(c.peerId, ch, kind, payload);
    const n = payload.length + 1;
    c.bytesOut += n;
    c.rateOutBytes += n;
  }

  private updateRates(c: Client, now: number): void {
    const dt = now - c.rateAt;
    if (dt < RATE_WINDOW_MS) return;
    c.kBpsOut = c.rateOutBytes / 1000 / (dt / 1000);
    c.kBpsIn = c.rateInBytes / 1000 / (dt / 1000);
    c.rateOutBytes = 0;
    c.rateInBytes = 0;
    c.rateAt = now;
  }

  private onMessage(peer: string, kind: number, payload: Uint8Array): void {
    const c = this.byPeer.get(peer);
    if (c === undefined || !c.connected) return;
    const n = payload.length + 1;
    c.bytesIn += n;
    c.rateInBytes += n;
    const now = this.now();
    if (kind === MSG.BR_INTENT) {
      const pkt = decodeIntentPacket(payload);
      if (pkt !== null) c.intent.ingest(pkt, now);
    } else if (kind === MSG.BR_SYNC) {
      const m = decodeSync(payload);
      if (m === null) return;
      if (m.kind === 'ping') {
        this.sendTo(c, 'unreliable', MSG.BR_SYNC, encodeSync({ kind: 'pong', echoMs: m.sentMs, nowMs: now }));
      } else {
        const rtt = now - m.echoMs;
        if (rtt >= 0 && rtt < 30000) c.rttMs = c.rttMs === 0 ? rtt : c.rttMs * 0.7 + rtt * 0.3;
      }
    }
  }

  private onLeft(peer: string, reason: string): void {
    const c = this.byPeer.get(peer);
    if (c === undefined || !c.connected) return;
    c.connected = false;
    for (const cb of [...this.leftCbs]) {
      try {
        cb(c.slot, reason);
      } catch (err) {
        console.error('[online] BrNetHost peer-left callback threw', err);
      }
    }
  }
}
