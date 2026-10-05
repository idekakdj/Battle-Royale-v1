/**
 * Small Battle Royale messages: `BR_SYNC` (ping/pong, unreliable, both directions) and `BR_RESULTS` (reliable, host → clients),
 * plus the per-client snapshot wrapper `[u16 ackIntentSeq][u8 holdMs]` that precedes the shared snapshot body.
 */

import { ByteReader, ByteWriter } from '../wire';
import { readOptId, writeOptId } from './tables';

// ── BR_SYNC ──────────────────────────────────────────────────────────────────

export type SyncMsg =
  | { kind: 'ping'; sentMs: number }
  /** `echoMs` = the ping's `sentMs`; `nowMs` = the answering side's own clock when it replied. */
  | { kind: 'pong'; echoMs: number; nowMs: number };

export function encodeSync(m: SyncMsg): Uint8Array {
  const w = new ByteWriter(10);
  if (m.kind === 'ping') return w.u8(0).u32(m.sentMs >>> 0).finish();
  return w.u8(1).u32(m.echoMs >>> 0).u32(m.nowMs >>> 0).finish();
}

export function decodeSync(bytes: Uint8Array): SyncMsg | null {
  try {
    const r = new ByteReader(bytes);
    const t = r.u8();
    let m: SyncMsg;
    if (t === 0) m = { kind: 'ping', sentMs: r.u32() };
    else if (t === 1) m = { kind: 'pong', echoMs: r.u32(), nowMs: r.u32() };
    else return null;
    return r.remaining === 0 ? m : null;
  } catch {
    return null;
  }
}

// ── BR_RESULTS ───────────────────────────────────────────────────────────────

export interface BrFighterResult {
  /** 1 = champion … 10 = first death; 0 = unknown. */
  placement: number;
  kills: number;
  damageDealt: number;
  damageBlocked: number;
  ultsUsed: number;
}

/** Final standings, indexed by fighter id (= slot). */
export interface BrResults {
  winnerId: number;
  /** Sim seconds. */
  matchTimeS: number;
  fighters: BrFighterResult[];
}

export function encodeResults(m: BrResults): Uint8Array {
  const w = new ByteWriter(16 + m.fighters.length * 10);
  writeOptId(w, m.winnerId);
  w.f32(m.matchTimeS);
  w.u8(m.fighters.length);
  for (const f of m.fighters) {
    w.u8(Math.max(0, Math.min(255, f.placement)));
    w.varu(Math.max(0, f.kills));
    w.varu(Math.max(0, Math.round(f.damageDealt * 16)));
    w.varu(Math.max(0, Math.round(f.damageBlocked * 16)));
    w.varu(Math.max(0, f.ultsUsed));
  }
  return w.finish();
}

export function decodeResults(bytes: Uint8Array): BrResults | null {
  try {
    const r = new ByteReader(bytes);
    const winnerId = readOptId(r);
    const matchTimeS = r.f32();
    if (!Number.isFinite(matchTimeS)) return null;
    const n = r.u8();
    const fighters: BrFighterResult[] = [];
    for (let i = 0; i < n; i++) {
      fighters.push({
        placement: r.u8(),
        kills: r.varu(),
        damageDealt: r.varu() / 16,
        damageBlocked: r.varu() / 16,
        ultsUsed: r.varu(),
      });
    }
    return r.remaining === 0 ? { winnerId, matchTimeS, fighters } : null;
  } catch {
    return null;
  }
}

// ── Per-client snapshot wrapper ──────────────────────────────────────────────

export const SNAPSHOT_WRAPPER_BYTES = 3;

/** `holdMs` byte meaning "the host has not heard any intent from you yet" (ack fields are meaningless). */
export const NO_ACK = 255;

/**
 * Host → client: `[u16 ackIntentSeq][u8 holdMs]` + shared snapshot body. holdMs = how long the host sat on that intent (clamped
 * to 254); `null` = no intent received yet.
 */
export function wrapSnapshot(ackIntentSeq: number, holdMs: number | null, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(SNAPSHOT_WRAPPER_BYTES + body.length);
  out[0] = ackIntentSeq & 0xff;
  out[1] = (ackIntentSeq >> 8) & 0xff;
  out[2] = holdMs === null ? NO_ACK : Math.max(0, Math.min(254, Math.round(holdMs)));
  out.set(body, SNAPSHOT_WRAPPER_BYTES);
  return out;
}

export function unwrapSnapshot(payload: Uint8Array): { ackIntentSeq: number; holdMs: number; body: Uint8Array } | null {
  if (payload.length <= SNAPSHOT_WRAPPER_BYTES) return null;
  return { ackIntentSeq: payload[0] | (payload[1] << 8), holdMs: payload[2], body: payload.subarray(SNAPSHOT_WRAPPER_BYTES) };
}
