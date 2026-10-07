/**
 * Online room layer — public types (WP-N1, v1.5). The Online UI (WP-N4) is built on exactly these:
 *
 *   `OnlineRoom.host()/join()`  →  an {@link OnlineRoom}
 *   `room.on('state', cb)`      →  {@link RoomState} after EVERY change (roster, ready flags, settings, pings, phase)
 *   `room.on('start', cb)`      →  `(OnlineStart, GameChannel)` — hand them to the game session
 *   `room.on('ended', cb)`      →  {@link RoomEndReason} + a human-readable message (host left, kicked, timeout …)
 *   `room.on('error', cb)`      →  {@link RoomError} for refused / failed commands that do NOT close the room
 *
 * Lifecycle of `phase`:
 *   `lobby` ── startMatch() ──► `starting` (peers dialling each other; ≤ ~15 s) ──► `inMatch` ── backToRoom() ──► `lobby`
 *   any phase ── leave() / host gone / kicked ──► `closed`
 */

import type { AnimalId, ArenaId, Difficulty } from '../../core/types';
import type { StageId } from '../../brawl/types';
import type { GameChannel, NetEndReason, OnlineMode, OnlineStart, Transport } from '../types';
import type { RoomClock } from './clock';

/** Fixed room limits (plan §1). */
export const ROOM_LIMITS = {
  /** Champions League and Battle Royale both need at least 2 humans … */
  minHumans: 2,
  /** … and take at most 4. */
  maxHumans: 4,
  /** Battle Royale roster size (humans + bots). There are exactly 10 animals, so each one is used once. */
  maxFighters: 10,
  /** Longest display name (characters). */
  maxNameLength: 16,
} as const;

export type RoomRole = 'host' | 'client';

export type RoomPhase =
  /** Transport is being opened / the host has not answered yet (only seen while `host()`/`join()` is pending). */
  | 'connecting'
  /** Roster editing: picks, ready, settings. */
  | 'lobby'
  /** The host pressed Start; peers are linking up. The roster is frozen. Short (≤ ~15 s). */
  | 'starting'
  /** A match is running (the `start` event has fired). */
  | 'inMatch'
  /** Terminal: left, kicked, host gone or fatal error. */
  | 'closed';

/** What a peer reports about its build (compared in the HELLO handshake; every field must match exactly). */
export interface RoomVersions {
  /** `ONLINE_PROTOCOL_VERSION`. */
  protocol: number;
  /** `APP_VERSION`. */
  appVersion: string;
  /** Data fingerprints per mode (FNV-1a hex of the tuning data + app + protocol version). */
  fingerprints: Record<OnlineMode, string>;
}

export interface BrRoomSettings {
  /** Bot skill (1 Cub … 4 Apex). */
  botLevel: Difficulty;
  /** Fill the roster with bots up to {@link ROOM_LIMITS.maxFighters} when the match starts (default true). */
  fillBots: boolean;
  /** v1.8: the map the host picked (default 'colosseum'). Visible to everyone, host-only editable. */
  arena: ArenaId;
}

export interface ClRoomSettings {
  stage: StageId;
  /** 1–5. */
  stocks: number;
  /** Seconds; 0 = no limit. */
  timeLimitS: number;
}

/** Host-controlled rules for both modes (the inactive mode's settings are kept so switching back loses nothing). */
export interface RoomSettings {
  br: BrRoomSettings;
  cl: ClRoomSettings;
}

/** Partial update accepted by `setSettings` (host only; values are validated and clamped). */
export interface RoomSettingsPatch {
  br?: Partial<BrRoomSettings>;
  cl?: Partial<ClRoomSettings>;
}

export const DEFAULT_ROOM_SETTINGS: Readonly<RoomSettings> = {
  br: { botLevel: 2, fillBots: true, arena: 'colosseum' },
  cl: { stage: 'brokenColosseum', stocks: 3, timeLimitS: 300 },
};

/** One row of the roster (humans in join order — the host first — then bots, Battle Royale only). */
export interface RoomSlot {
  /** Stable key for the UI: the peer id of a human, `bot:N` for a bot. */
  id: string;
  kind: 'human' | 'bot';
  /** Transport peer id (null for bots). This is the id `kick()` and the game layers use. */
  peerId: string | null;
  name: string;
  /** Always set; unique among the whole roster. */
  animal: AnimalId;
  /** The host counts as always ready. Bots are always ready. */
  ready: boolean;
  /** Round-trip time between this human and the HOST in ms (0 for the host, bots and "not measured yet"). */
  pingMs: number;
  isHost: boolean;
  /** This row is the machine that owns the {@link OnlineRoom}. */
  isLocal: boolean;
}

/** Why the host cannot press Start right now (empty array = go). */
export type StartBlocker =
  | 'not-host'
  | 'wrong-phase'
  /** Fewer than {@link ROOM_LIMITS.minHumans} humans in the room. */
  | 'need-players'
  /** At least one non-host human has not pressed Ready. */
  | 'not-all-ready';

export interface RoomState {
  /** Monotonic revision, bumped on every change (UIs may ignore it). */
  rev: number;
  /** The 5-character room code to share. */
  code: string;
  role: RoomRole;
  phase: RoomPhase;
  mode: OnlineMode;
  settings: RoomSettings;
  /** Roster. Battle Royale: humans then the bots the host added (auto-fill bots are NOT listed — see {@link botFill}). */
  slots: RoomSlot[];
  localPeerId: string;
  hostPeerId: string;
  /** The local build's versions. */
  versions: RoomVersions;
  /** The host's versions (equal to `versions` for every accepted client). */
  hostVersions: RoomVersions;
  /** Battle Royale: how many extra bots will be added when the match starts (0 in Champions League or with `fillBots` off). */
  botFill: number;
  /** Host only (clients always see `canStart: false`, `startBlockers: ['not-host']`). */
  canStart: boolean;
  startBlockers: StartBlocker[];
}

/** Why a room closed. `NetEndReason` values plus the two room-only ones. */
export type RoomEndReason = NetEndReason | 'kicked' | 'left';

export type RoomErrorCode =
  /** The typed code/link is not a valid room code. */
  | 'bad-code'
  /** Nobody is hosting this code (wrong code, host closed the room, or signalling lost). */
  | 'no-such-room'
  /** The signalling server could not be reached / refused us. */
  | 'signalling-failed'
  /** The WebRTC link to the host did not open in time (firewall / NAT; a TURN server may be needed). */
  | 'connect-failed'
  /** The host did not answer the handshake in time. */
  | 'timeout'
  /** Protocol, app version or data fingerprint differs — see `details`. */
  | 'version-mismatch'
  | 'room-full'
  /** The room is already starting / in a match. */
  | 'room-busy'
  | 'kicked'
  | 'host-left'
  /** Host-side: a command was refused. */
  | 'not-host'
  | 'wrong-phase'
  | 'animal-taken'
  | 'cannot-start'
  /** Two peers could not open a link to each other while starting Champions League (NAT; TURN may be needed). */
  | 'mesh-failed'
  | 'protocol'
  | 'internal';

export class RoomError extends Error {
  readonly code: RoomErrorCode;
  /** For `version-mismatch`: both sides' versions and which fields differ. */
  readonly details?: RoomErrorDetails;

  constructor(code: RoomErrorCode, message: string, details?: RoomErrorDetails) {
    super(message);
    this.name = 'RoomError';
    this.code = code;
    this.details = details;
  }
}

export interface RoomErrorDetails {
  /** The host's build. */
  host?: RoomVersions;
  /** The joining build. */
  local?: RoomVersions;
  /** Which fields differ (`fingerprint:championsLeague` …). */
  mismatch?: string[];
  /** Peers involved (mesh failures). */
  peers?: string[];
}

export interface RoomEvents {
  state: (state: RoomState) => void;
  start: (start: OnlineStart, channel: GameChannel) => void;
  ended: (reason: RoomEndReason, message: string) => void;
  error: (error: RoomError) => void;
}

/** Options shared by `OnlineRoom.host` and `OnlineRoom.join`. */
export interface RoomOptions {
  /** Defaults to a `PeerJsTransport` built from the URL (`?signal=`, `?ice=`, `?netsim=`). */
  transport?: Transport;
  /** Display name (sanitised: trimmed, ≤ 16 chars). */
  name: string;
  /** Preferred fighter; the host assigns the first free one when taken. Default `'lion'`. */
  animal?: AnimalId;
  /** Timers + clock (tests pass `loopbackClock(net)`). Default: real timers. */
  clock?: RoomClock;
  /** Override the reported versions (tests, QA). Default: this build. */
  versions?: Partial<RoomVersions>;
  /** Random source in [0,1) — room codes, seeds, peer-id suffixes (tests). */
  rng?: () => number;
  /** Heartbeat period in ms (default 1000). */
  heartbeatMs?: number;
  /** Silence after which a peer counts as gone (default 5000). */
  silenceMs?: number;
  /** Open-link timeout in ms (default 12000). */
  connectTimeoutMs?: number;
}

export interface HostOptions extends RoomOptions {
  mode?: OnlineMode;
  settings?: RoomSettingsPatch;
  /** How many fresh room codes to try when the peer id is taken (default 8). */
  codeAttempts?: number;
}

export type JoinOptions = RoomOptions;
