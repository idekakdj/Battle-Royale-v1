/**
 * Battle Royale `FighterIntent` wire format + the loss-proof edge handling (WP-N3). 12 bytes, sent at 60 Hz, UNRELIABLE.
 *
 *   u16 seq · u8 flags(block, jump, needKeyframe) · i8 moveX · i8 moveZ · u16 aimYaw · u8 attackCount · u8 specialCount ·
 *   u8 ultimateCount · u16 ackSnap (newest snapshot seq the client has received)
 *
 * EDGES. `attack` / `special` / `ultimate` are edge-triggered in the sim. Instead of sending a one-tick flag (which a lost packet
 * would swallow) the client keeps three free-running 8-bit PRESS COUNTERS (one tick per rising edge of the intent it was given)
 * and puts the current values in EVERY packet. That is the "latch until acked" rule made idempotent: any later packet repeats
 * the news, a duplicate or reordered packet adds nothing, and the host consumes exactly `counter delta` edges, each as a separate
 * rising edge (pulse, gap tick, pulse…) so the sim's own edge detector sees every one exactly once. No ack channel is needed
 * for correctness (`ackSnap` only drives the snapshot-loss statistics).
 *
 * Levels (move/aim/block/jump) are taken from the newest packet by `seq` (u16 wrap-aware); older reordered packets only
 * contribute their counters.
 */

import type { FighterIntent } from '../../core/types';
import { ByteReader, ByteWriter } from '../wire';
import { Q, angleToU16, seq16Newer, u16ToAngle } from './tables';

export const INTENT_PACKET_BYTES = 12;

export interface IntentPacket {
  seq: number;
  block: boolean;
  jump: boolean;
  /** The client has no statics yet and wants a keyframe. */
  needKeyframe: boolean;
  moveX: number;
  moveZ: number;
  aimYaw: number;
  attackCount: number;
  specialCount: number;
  ultimateCount: number;
  ackSnap: number;
}

const FL_BLOCK = 1;
const FL_JUMP = 2;
const FL_NEED_KEY = 4;

export function encodeIntentPacket(p: IntentPacket): Uint8Array {
  const w = new ByteWriter(INTENT_PACKET_BYTES);
  w.u16(p.seq & 0xffff);
  w.u8((p.block ? FL_BLOCK : 0) | (p.jump ? FL_JUMP : 0) | (p.needKeyframe ? FL_NEED_KEY : 0));
  w.i8(stick(p.moveX)).i8(stick(p.moveZ));
  w.u16(angleToU16(p.aimYaw));
  w.u8(p.attackCount & 0xff).u8(p.specialCount & 0xff).u8(p.ultimateCount & 0xff);
  w.u16(p.ackSnap & 0xffff);
  return w.finish();
}

function stick(v: number): number {
  if (!(v === v)) return 0;
  return Math.max(-127, Math.min(127, Math.round(v * Q.STICK)));
}

/** Never throws: wrong length / reserved bits give null. */
export function decodeIntentPacket(bytes: Uint8Array): IntentPacket | null {
  if (bytes.length !== INTENT_PACKET_BYTES) return null;
  try {
    const r = new ByteReader(bytes);
    const seq = r.u16();
    const flags = r.u8();
    if ((flags & ~7) !== 0) return null;
    let moveX = r.i8() / Q.STICK;
    let moveZ = r.i8() / Q.STICK;
    const len2 = moveX * moveX + moveZ * moveZ;
    if (len2 > 1) {
      const inv = 1 / Math.sqrt(len2);
      moveX *= inv;
      moveZ *= inv;
    }
    return {
      seq,
      block: (flags & FL_BLOCK) !== 0,
      jump: (flags & FL_JUMP) !== 0,
      needKeyframe: (flags & FL_NEED_KEY) !== 0,
      moveX,
      moveZ,
      aimYaw: u16ToAngle(r.u16()),
      attackCount: r.u8(),
      specialCount: r.u8(),
      ultimateCount: r.u8(),
      ackSnap: r.u16(),
    };
  } catch {
    return null;
  }
}

// ── Client side ──────────────────────────────────────────────────────────────

/** Turns the controller's per-tick intents into packets (sequence numbers, rising-edge press counters). */
export class IntentSender {
  private seq = 0;
  private prevAttack = false;
  private prevSpecial = false;
  private prevUlt = false;
  attackCount = 0;
  specialCount = 0;
  ultimateCount = 0;

  /** Rising edges seen so far (for tests / stats). */
  get pressed(): { attack: number; special: number; ultimate: number } {
    return { attack: this.attackCount, special: this.specialCount, ultimate: this.ultimateCount };
  }

  next(intent: FighterIntent, ackSnap: number, needKeyframe: boolean): Uint8Array {
    if (intent.attack && !this.prevAttack) this.attackCount = (this.attackCount + 1) & 0xff;
    if (intent.special && !this.prevSpecial) this.specialCount = (this.specialCount + 1) & 0xff;
    if (intent.ultimate && !this.prevUlt) this.ultimateCount = (this.ultimateCount + 1) & 0xff;
    this.prevAttack = intent.attack;
    this.prevSpecial = intent.special;
    this.prevUlt = intent.ultimate;
    const pkt: IntentPacket = {
      seq: this.seq,
      block: intent.block,
      jump: intent.jump,
      needKeyframe,
      moveX: intent.moveX,
      moveZ: intent.moveZ,
      aimYaw: intent.aimYaw,
      attackCount: this.attackCount,
      specialCount: this.specialCount,
      ultimateCount: this.ultimateCount,
      ackSnap,
    };
    this.seq = (this.seq + 1) & 0xffff;
    return encodeIntentPacket(pkt);
  }
}

// ── Host side ────────────────────────────────────────────────────────────────

/** Max edges queued per type before the oldest are dropped (a stuck sim must not replay minutes of button mashing). */
const MAX_PENDING_EDGES = 32;
/** An edge counter delta this large or larger is a stale (reordered) packet, not new presses. */
const COUNTER_HALF = 128;

export interface RemoteIntentStats {
  packets: number;
  /** Duplicates / older reordered packets (their levels were ignored). */
  stale: number;
  edgesAccepted: number;
  edgesConsumed: number;
  edgesDropped: number;
}

/**
 * Host-side state of ONE remote player's intent stream. `ingest` on every packet; `consume` exactly once per sim tick.
 */
export class RemoteIntent {
  readonly stats: RemoteIntentStats = { packets: 0, stale: 0, edgesAccepted: 0, edgesConsumed: 0, edgesDropped: 0 };
  private started = false;
  private lastSeq = 0;
  private lastRecvMs = -Infinity;
  private level: IntentPacket | null = null;
  private lastCount = [0, 0, 0];
  private pending = [0, 0, 0];
  private lastPulse = [false, false, false];
  private readonly out: FighterIntent = {
    moveX: 0,
    moveZ: 0,
    aimYaw: 0,
    attack: false,
    block: false,
    special: false,
    ultimate: false,
    jump: false,
  };
  /** Newest snapshot seq the client reported. */
  ackSnap = -1;
  needKeyframe = true;

  constructor(private readonly staleMs = 300) {}

  /** ms since the last accepted level update (Infinity before the first packet). */
  silenceMs(nowMs: number): number {
    return nowMs - this.lastRecvMs;
  }

  ingest(p: IntentPacket, nowMs: number): void {
    this.stats.packets++;
    // Edge counters first: they are cumulative, so even a stale packet may carry news (never old news).
    const counts = [p.attackCount, p.specialCount, p.ultimateCount];
    for (let i = 0; i < 3; i++) {
      const d = (counts[i] - this.lastCount[i]) & 0xff;
      if (d > 0 && d < COUNTER_HALF) {
        this.lastCount[i] = counts[i];
        this.stats.edgesAccepted += d;
        let total = this.pending[i] + d;
        if (total > MAX_PENDING_EDGES) {
          this.stats.edgesDropped += total - MAX_PENDING_EDGES;
          total = MAX_PENDING_EDGES;
        }
        this.pending[i] = total;
      }
    }
    if (!this.started || seq16Newer(p.seq, this.lastSeq)) {
      this.started = true;
      this.lastSeq = p.seq;
      this.lastRecvMs = nowMs;
      this.level = p;
      this.needKeyframe = p.needKeyframe;
      this.ackSnap = p.ackSnap;
    } else {
      this.stats.stale++;
    }
  }

  /** Sequence number of the newest accepted packet (−1 before the first). */
  get newestSeq(): number {
    return this.started ? this.lastSeq : -1;
  }

  /** Local clock (ms) when the newest accepted packet arrived. */
  get lastRecv(): number {
    return this.lastRecvMs;
  }

  /** Pending (accepted, not yet consumed) edges per type: attack, special, ultimate. */
  get pendingEdges(): readonly number[] {
    return this.pending;
  }

  /**
   * The intent for THIS sim tick. Call exactly once per tick. The returned object is reused (valid until the next call).
   * Edges are emitted as separate rising edges: pulse, one low tick, pulse, …
   */
  consume(nowMs: number): FighterIntent {
    const o = this.out;
    const lv = this.level;
    const stale = lv === null || nowMs - this.lastRecvMs > this.staleMs;
    if (lv !== null) {
      o.aimYaw = lv.aimYaw;
      o.moveX = stale ? 0 : lv.moveX;
      o.moveZ = stale ? 0 : lv.moveZ;
      o.block = stale ? false : lv.block;
      o.jump = stale ? false : lv.jump;
    }
    for (let i = 0; i < 3; i++) {
      let pulse = false;
      if (this.pending[i] > 0 && !this.lastPulse[i]) {
        pulse = true;
        this.pending[i]--;
        this.stats.edgesConsumed++;
      }
      this.lastPulse[i] = pulse;
    }
    o.attack = this.lastPulse[0];
    o.special = this.lastPulse[1];
    o.ultimate = this.lastPulse[2];
    return o;
  }
}
