/**
 * Champions League online — public types of the rollback layer (v1.5, WP-N2).
 */

import type { GameChannel, NetEndReason, OnlineStart } from '../../online/types';
import type { BrawlEvent, BrawlIntent, BrawlMatchConfig, BrawlSnapshot, BrawlWorldApi } from '../types';
import type { BrawlSavedState } from '../sim/stateIO';

export type { BrawlSavedState } from '../sim/stateIO';

/** What `RollbackSession` needs from a simulation (`BrawlWorld` implements it; tests may wrap it). */
export interface RollbackWorld extends BrawlWorldApi {
  /** Current sim frame. */
  readonly frame: number;
  /** True once the match is decided. */
  readonly isOver: boolean;
  saveState(into?: BrawlSavedState): BrawlSavedState;
  loadState(s: BrawlSavedState): void;
  checksum(): number;
  forfeit(id: number): void;
}

/** A confirmed-state checksum disagreement with a remote peer. */
export interface RollbackDesync {
  frame: number;
  /** Fighter slot of the peer that disagrees. */
  slot: number;
  peerId: string;
  localChecksum: number;
  remoteChecksum: number;
  /** True when the disagreement was found in the end-of-match exchange (winner / final state), false for the periodic check. */
  atMatchEnd: boolean;
}

/** Delivered once to `onEnded` when the session stops producing frames. */
export interface RollbackEnd {
  /** `finished` = the match was decided on confirmed frames; otherwise why the session gave up. */
  reason: 'finished' | NetEndReason;
  /** Winner slot (−1 = draw / unknown). */
  winnerId: number;
  /** The frame the match ended on (the last simulated frame for an abort). */
  frame: number;
  /** Checksum of the final state. */
  checksum: number;
  /** For `finished`: every still-connected peer reported the same winner and final-state checksum. */
  agreed: boolean;
}

/** Why a fighter was removed from the match by the session. */
export interface RollbackForfeit {
  slot: number;
  /** The agreed frame the fighter leaves the sim on. */
  frame: number;
}

export interface RollbackStats {
  /** Number of rollbacks performed (each = one `loadState` + re-simulation). */
  rollbacks: number;
  maxRollbackDepth: number;
  /** Total re-simulated frames. */
  resimulatedFrames: number;
  /** Number of distinct stall episodes ("waiting for player"). */
  stalls: number;
  /** Total sim frames the clock wanted to run but could not (accumulated stall time in frames). */
  stalledFrames: number;
  /** Largest observed round trip to a peer (ms, smoothed; 0 until measured). */
  pingMs: number;
  /** Per remote slot: smoothed round trip (ms), 0 = unknown / not a remote. */
  pingBySlot: number[];
  /** Local clock minus the (latency-corrected) remote clock, in frames (positive = we are ahead). Smoothed. */
  remoteAdvantage: number;
  /** Current local input delay (frames). */
  inputDelay: number;
  simFrame: number;
  confirmedFrame: number;
  /** Clock dilation currently applied (1 ± 0.05). */
  timeScale: number;
  packetsSent: number;
  packetsReceived: number;
  bytesSent: number;
  checksumsCompared: number;
}

export interface RollbackSessionOptions {
  channel: GameChannel;
  start: OnlineStart;
  /** The simulation factory (default: `new BrawlWorld(config, seed)`). Receives the config built from `start`. */
  createWorld?: (config: BrawlMatchConfig, seed: number) => RollbackWorld;
  /**
   * The local player's current intent, polled once per fresh sim frame (never during a re-simulation).
   * `targetFrame` is the sim frame the sampled input will be applied on (= current frame + input delay).
   */
  localIntent: (targetFrame: number) => BrawlIntent;
  /** Initial input delay in frames (default 2). */
  inputDelay?: number;
  /** Re-tune the delay (1–4) from the measured round trip (default true). */
  adaptiveDelay?: boolean;
  /** Most frames the sim may run ahead of the last fully-confirmed frame before it stalls (default 8). */
  maxRollback?: number;
  /** Compare checksums every this many confirmed frames (default 30). */
  checksumInterval?: number;
  /** Give up (`onEnded` with `timeout`) after this long without confirmation progress (default 12 000 ms; 30 000 before the first frame). */
  stallTimeoutMs?: number;
  /** After the local match end, wait this long for the other peers' end-of-match reports (default 2000 ms). */
  agreementTimeoutMs?: number;
  /** Keep a per-frame record of the confirmed inputs and checksums for tests / tools (default false). */
  record?: boolean;
  onDesync?: (info: RollbackDesync) => void;
  onEnded?: (info: RollbackEnd) => void;
  /** A fighter was forfeited (peer left), fired when the host's control message is applied locally. */
  onForfeit?: (info: RollbackForfeit) => void;
}

export interface RollbackView {
  prev: BrawlSnapshot;
  cur: BrawlSnapshot;
  /** Interpolation factor in [0, 1] between `prev` and `cur`. */
  alpha: number;
}

export type { BrawlEvent, BrawlIntent };
