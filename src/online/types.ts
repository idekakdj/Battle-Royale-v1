/**
 * Online multiplayer — shared contracts (v1.5). Architect-owned: other agents may extend ADDITIVELY and must say so in
 * their report. Binding plan: docs/ONLINE-PLAN.md.
 *
 * Layers (bottom → top):
 *   Transport / Link   WebRTC data channels via PeerJS in production, in-memory `LoopbackNetwork` in tests
 *   GameChannel        framed `[kind][payload]` messages between the humans of one room (src/online/channel.ts)
 *   Room (lobby)       codes, roster, readiness, version check, start (src/online/room, WP-N1)
 *   Game sessions      Champions League rollback (src/brawl/net, WP-N2) · Battle Royale host/client (src/online/br, WP-N3)
 *   Controllers + UI   NetBrawlController (WP-N5), BR net controller (WP-N6), Online screens (WP-N4)
 */

import type { AnimalId, Difficulty } from '../core/types';
import type { StageId } from '../brawl/types';

/** Bump whenever ANY wire format changes (both peers must match exactly, checked in the room handshake). */
export const ONLINE_PROTOCOL_VERSION = 1;

export type OnlineMode = 'battleRoyale' | 'championsLeague';

/** `reliable` = ordered + retransmitted (lobby, events, control); `unreliable` = unordered, may be lost (inputs, snapshots). */
export type Channel = 'reliable' | 'unreliable';

// ── Transport ────────────────────────────────────────────────────────────────

/** A bidirectional link to ONE remote peer. */
export interface Link {
  readonly peerId: string;
  readonly open: boolean;
  /** Smoothed round-trip time in ms (0 until known). */
  readonly rttMs: number;
  /** `data` is copied. Sending on a closed link is a silent no-op. */
  send(channel: Channel, data: Uint8Array): void;
  close(): void;
  /**
   * OPTIONAL, additive (WP-N1): the room layer's heartbeat reports its smoothed RTT here so links that cannot measure
   * it themselves (PeerJS) expose a real `rttMs` to the game layers. Links with a built-in RTT (loopback) may ignore it.
   */
  reportRtt?(ms: number): void;
}

export interface TransportHandlers {
  /** A link finished opening (outgoing `connect` also resolves; this fires for incoming ones and, for convenience, outgoing). */
  onLink(link: Link): void;
  onData(link: Link, channel: Channel, data: Uint8Array): void;
  onClose(link: Link, reason: string): void;
}

export interface Transport {
  readonly kind: 'peerjs' | 'loopback';
  /** Register this peer. Resolves with the id obtained. Rejects with Error('id-taken') when `wantedId` is in use. */
  open(wantedId?: string): Promise<string>;
  /** Open a link to a registered peer. Rejects on timeout / unknown peer. */
  connect(peerId: string, timeoutMs?: number): Promise<Link>;
  setHandlers(h: TransportHandlers): void;
  dispose(): void;
}

// ── Game-message channel ─────────────────────────────────────────────────────

/** Message kinds (first byte of every packet). Ranges are reserved per layer. */
export const MSG = {
  // room / lobby — reliable, JSON payloads
  HELLO: 0x01,
  ROOM_STATE: 0x02,
  PICK: 0x03,
  READY: 0x04,
  SETTINGS: 0x05,
  START: 0x06,
  LEAVE: 0x07,
  PING: 0x08,
  PONG: 0x09,
  KICK: 0x0a,
  PEER_LIST: 0x0b,
  MATCH_END: 0x0c,
  // championsLeague rollback
  CL_INPUTS: 0x10, // unreliable
  CL_CHECKSUM: 0x11, // reliable
  CL_CONTROL: 0x12, // reliable (frame-stamped, host-authored: forfeit, …)
  CL_SYNC: 0x13, // unreliable (frame advantage / ack)
  // battleRoyale host-authoritative
  BR_INTENT: 0x20, // client → host, unreliable
  BR_SNAPSHOT: 0x21, // host → client, unreliable
  BR_EVENTS: 0x22, // host → client, reliable
  BR_RESULTS: 0x23, // host → client, reliable
  BR_SYNC: 0x24, // both ways, unreliable (acks, time sync)
  BR_BYE: 0x25, // host → clients, reliable: the host left the match early (QA: clients used to wait for the 15 s timeout)
} as const;

export type MsgKind = (typeof MSG)[keyof typeof MSG];

/** What the game layers use to talk to the other humans of the room (all routing/framing is hidden). */
export interface GameChannel {
  readonly localPeerId: string;
  /** Currently connected remote peer ids. */
  peers(): readonly string[];
  rttMs(peerId: string): number;
  send(peerId: string, channel: Channel, kind: number, payload: Uint8Array): void;
  broadcast(channel: Channel, kind: number, payload: Uint8Array): void;
  /** Returns an unsubscribe function. Malformed packets are dropped before they get here. */
  onMessage(cb: (peerId: string, kind: number, payload: Uint8Array, channel: Channel) => void): () => void;
  onPeerLeft(cb: (peerId: string, reason: string) => void): () => void;
}

// ── Match start hand-off (room → game) ───────────────────────────────────────

export interface OnlineSlotInfo {
  /** Fighter id in the sim (= roster index). */
  slot: number;
  /** null for bots. */
  peerId: string | null;
  name: string;
  animal: AnimalId;
  kind: 'human' | 'bot';
}

/** Everything a game session needs to begin; identical on every machine except `localSlot`. */
export interface OnlineStart {
  mode: OnlineMode;
  /** Sim seed (both modes). */
  seed: number;
  /** index = fighter id. Humans first is NOT guaranteed; always use `peerId`/`slot`. */
  slots: OnlineSlotInfo[];
  /** This machine's fighter id. */
  localSlot: number;
  hostPeerId: string;
  /** Battle Royale: bot skill for the bot slots. */
  br?: { difficulty: Difficulty };
  /** Champions League: rules. Bots (if any) use `botLevel`. */
  cl?: { stage: StageId; stocks: number; timeLimitS: number; botLevel: Difficulty };
}

/** Why a networked match stopped before a normal result. */
export type NetEndReason = 'host-left' | 'peer-left' | 'desync' | 'timeout' | 'version-mismatch' | 'error';
