/**
 * `OnlineRoom` — the "play with friends" lobby (WP-N1, plan §3). One instance per machine:
 *
 *   const room = await OnlineRoom.host({ name: 'Ann', animal: 'lion' });     // → room.state.code to share
 *   const room = await OnlineRoom.join('K7P4Q', { name: 'Bob', animal: 'eagle' });
 *   room.on('state', (s) => render(s));
 *   room.on('start', (start, channel) => beginMatch(start, channel));        // same OnlineStart everywhere (own localSlot)
 *   room.on('ended', (reason, message) => showError(message));
 *
 * Topology: every client has ONE link to the host (the host's peer id is `gk1-<CODE>`). When a Champions League match
 * starts the host also tells the clients to dial each other (full mesh); Battle Royale stays a star. The host is the
 * only authority over roster, settings and start; clients send requests (HELLO / PICK / READY / …) and render the
 * host's ROOM_STATE broadcasts.
 *
 * Heartbeats (PING/PONG on the unreliable channel, 1 Hz) measure RTT and detect dead peers (5 s of silence).
 * Message formats: see `messages.ts`.
 */

import { ANIMALS, ANIMAL_IDS } from '../../config/animals';
import type { AnimalId } from '../../core/types';
import { LinkChannel } from '../channel';
import { createDefaultTransport } from '../transport';
import { MSG } from '../types';
import type { Channel, Link, OnlineMode, OnlineSlotInfo, OnlineStart, Transport } from '../types';
import { ByteReader, ByteWriter, frame, jsonPayload, parseJsonPayload } from '../wire';
import { realClock, type RoomClock } from './clock';
import { smoothRtt } from './rtt';
import { diffVersions, localVersions } from './fingerprint';
import {
  asRecord,
  isAnimal,
  parseAbort,
  parseHello,
  parsePrepare,
  parseReject,
  parseRoom,
  parseSettings,
  sanitizeName,
  type AbortMsg,
  type HelloMsg,
  type PrepareMsg,
  type RejectReason,
  type RoomMsg,
  type WireSlot,
  type WireStart,
} from './messages';
import { clientPeerId, generateRoomCode, hostPeerId, normalizeRoomCode } from './roomCode';
import {
  DEFAULT_ROOM_SETTINGS,
  ROOM_LIMITS,
  RoomError,
  type HostOptions,
  type JoinOptions,
  type RoomEndReason,
  type RoomErrorCode,
  type RoomErrorDetails,
  type RoomEvents,
  type RoomOptions,
  type RoomPhase,
  type RoomRole,
  type RoomSettings,
  type RoomSettingsPatch,
  type RoomSlot,
  type RoomState,
  type RoomVersions,
  type StartBlocker,
} from './types';

/** First message kind owned by the game layers (everything below belongs to the room). */
const GAME_KIND_MIN = 0x10;
/** Host: a link that has not said HELLO within this long is dropped. */
const HELLO_TIMEOUT_MS = 8000;
/** Client: how long to wait for the host's answer to HELLO. */
const JOIN_TIMEOUT_MS = 10000;
/** Starting a match: peers must be linked within this long. */
const MESH_TIMEOUT_MS = 15000;
/** Grace period so a final LEAVE / KICK / reject message is flushed before the link is torn down. */
const FLUSH_MS = 200;

/** The channel handed to the game layers; `retire()` silences sends once the match is over (links stay open). */
class MatchChannel extends LinkChannel {
  private alive = true;

  retire(): void {
    this.alive = false;
  }

  override send(peerId: string, channel: Channel, kind: number, payload: Uint8Array): void {
    if (this.alive) super.send(peerId, channel, kind, payload);
  }

  override broadcast(channel: Channel, kind: number, payload: Uint8Array): void {
    if (this.alive) super.broadcast(channel, kind, payload);
  }
}

interface Member {
  peerId: string;
  name: string;
  animal: AnimalId;
  ready: boolean;
  /** Ping value last published in ROOM_STATE. */
  shownPing: number;
}

interface BotEntry {
  id: string;
  animal: AnimalId;
}

interface PeerStat {
  lastSeen: number;
  srtt: number;
  samples: number;
}

interface Early {
  link: Link;
  channel: Channel;
  data: Uint8Array;
}

interface Prep {
  start: WireStart;
  need: Set<string>;
  linked: boolean;
  cancel: () => void;
}

interface StartWait {
  start: OnlineStart;
  waiting: Set<string>;
  cancel: () => void;
}

interface JoinWaiter {
  resolve: () => void;
  reject: (e: RoomError) => void;
  cancel: () => void;
}

type Listeners = { [K in keyof RoomEvents]: Set<RoomEvents[K]> };

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function randomU32(rng?: () => number): number {
  if (rng !== undefined) return Math.floor(rng() * 4294967296) >>> 0;
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c !== undefined && typeof c.getRandomValues === 'function') return c.getRandomValues(new Uint32Array(1))[0];
  return Math.floor(Math.random() * 4294967296) >>> 0;
}

function describeVersions(v: RoomVersions): string {
  return `v${v.appVersion} (protocol ${v.protocol})`;
}

export class OnlineRoom {
  readonly role: RoomRole;

  private transport!: Transport;
  private readonly clock: RoomClock;
  private readonly rng: (() => number) | undefined;
  private readonly versions: RoomVersions;
  private readonly heartbeatMs: number;
  private readonly silenceMs: number;
  private readonly connectTimeoutMs: number;
  private readonly listeners: Listeners = { state: new Set(), start: new Set(), ended: new Set(), error: new Set() };

  private code = '';
  private localPeerId = '';
  private hostId = '';
  private phase: RoomPhase = 'connecting';
  private rev = 0;
  private view: RoomMsg | null = null;
  private localName: string;
  private localAnimal: AnimalId;

  private readonly links = new Map<string, Link>();
  private readonly stats = new Map<string, PeerStat>();
  private cancelTick: (() => void) | null = null;
  private match: MatchChannel | null = null;
  private early: Early[] = [];

  // host
  private mode: OnlineMode = 'battleRoyale';
  private settings: RoomSettings = { br: { ...DEFAULT_ROOM_SETTINGS.br }, cl: { ...DEFAULT_ROOM_SETTINGS.cl } };
  private readonly members: Member[] = [];
  private readonly bots: BotEntry[] = [];
  private botSeq = 0;
  private readonly pending = new Map<string, { link: Link; cancel: () => void }>();
  private startWait: StartWait | null = null;

  // client
  private joinWaiter: JoinWaiter | null = null;
  private prep: Prep | null = null;
  private localBack = false;
  /**
   * Client that went back to the room before the host did: the host is still in the match and ignores READY, and it will reset
   * every ready flag when it returns. So `setReady` is remembered here (and shown as the local flag) and sent once the host is back.
   */
  private deferredReady: boolean | null = null;

  private constructor(role: RoomRole, opts: RoomOptions) {
    this.role = role;
    this.clock = opts.clock ?? realClock;
    this.rng = opts.rng;
    this.versions = { ...localVersions(), ...opts.versions, fingerprints: { ...localVersions().fingerprints, ...opts.versions?.fingerprints } };
    this.heartbeatMs = opts.heartbeatMs ?? 1000;
    // 15 s: a slow laptop can freeze the page for several seconds on the first rendered frame (shader compile), which
    // would otherwise look like a dead peer and drop a friend from the room right as the match starts.
    this.silenceMs = opts.silenceMs ?? 15000;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 12000;
    this.localName = sanitizeName(opts.name, 'Player');
    this.localAnimal = opts.animal !== undefined && isAnimal(opts.animal) ? opts.animal : 'lion';
  }

  // ── creation ───────────────────────────────────────────────────────────────

  /** Create a room and become its host. Resolves once the room code is registered with the signalling server. */
  static async host(opts: HostOptions): Promise<OnlineRoom> {
    const room = new OnlineRoom('host', opts);
    try {
      await room.initHost(opts);
    } catch (e) {
      room.abandon();
      throw OnlineRoom.toRoomError(e, 'signalling-failed');
    }
    return room;
  }

  /**
   * Join the room with `code` (also accepts a pasted invite link or peer id). Resolves once the host has accepted us;
   * rejects with a {@link RoomError} (`bad-code`, `no-such-room`, `connect-failed`, `version-mismatch`, `room-full`, …).
   */
  static async join(code: string, opts: JoinOptions): Promise<OnlineRoom> {
    const norm = normalizeRoomCode(code);
    if (norm === null) throw new RoomError('bad-code', 'That is not a valid room code (5 letters/digits).');
    const room = new OnlineRoom('client', opts);
    room.code = norm;
    room.hostId = hostPeerId(norm);
    try {
      await room.initClient(opts);
    } catch (e) {
      room.abandon();
      throw OnlineRoom.toRoomError(e, 'connect-failed');
    }
    return room;
  }

  private static toRoomError(e: unknown, fallback: RoomErrorCode): RoomError {
    if (e instanceof RoomError) return e;
    return new RoomError(fallback, errMessage(e));
  }

  private async initHost(opts: HostOptions): Promise<void> {
    this.mode = opts.mode ?? 'battleRoyale';
    if (opts.settings !== undefined) this.settings = this.mergeSettings(opts.settings);
    this.transport = opts.transport ?? (await createDefaultTransport());
    this.installHandlers();
    const attempts = Math.max(1, opts.codeAttempts ?? 8);
    for (let i = 0; i < attempts && this.code === ''; i++) {
      const code = generateRoomCode(this.rng);
      try {
        this.localPeerId = await this.transport.open(hostPeerId(code));
        this.code = code;
      } catch (e) {
        if (errMessage(e) === 'id-taken') continue;
        throw new RoomError('signalling-failed', `Could not reach the signalling server (${errMessage(e)}).`);
      }
    }
    if (this.code === '') throw new RoomError('signalling-failed', 'Could not find a free room code. Try again.');
    this.hostId = this.localPeerId;
    this.members.push({ peerId: this.localPeerId, name: this.localName, animal: this.localAnimal, ready: true, shownPing: 0 });
    this.phase = 'lobby';
    this.view = this.buildWire();
    this.startTick();
  }

  private async initClient(opts: JoinOptions): Promise<void> {
    this.transport = opts.transport ?? (await createDefaultTransport());
    this.installHandlers();
    for (let i = 0; i < 4 && this.localPeerId === ''; i++) {
      try {
        this.localPeerId = await this.transport.open(clientPeerId(this.code, this.rng));
      } catch (e) {
        if (errMessage(e) === 'id-taken') continue;
        throw new RoomError('signalling-failed', `Could not reach the signalling server (${errMessage(e)}).`);
      }
    }
    if (this.localPeerId === '') throw new RoomError('signalling-failed', 'Could not register with the signalling server.');
    let link: Link;
    try {
      link = await this.transport.connect(this.hostId, this.connectTimeoutMs);
    } catch (e) {
      const m = errMessage(e);
      if (m === 'unknown-peer' || m.startsWith('peer-unavailable')) {
        throw new RoomError('no-such-room', `No room "${this.code}" was found. Check the code, or ask the host to open it again.`);
      }
      if (m === 'timeout') {
        throw new RoomError('connect-failed', 'Could not open a connection to the host (firewall / NAT?). A TURN server may be needed.');
      }
      if (m.startsWith('signalling')) throw new RoomError('signalling-failed', `Lost the signalling server (${m}).`);
      throw new RoomError('connect-failed', `Could not connect to the host (${m}).`);
    }
    this.registerLink(link);
    this.startTick();
    const hello: HelloMsg = {
      t: 'hello',
      protocol: this.versions.protocol,
      appVersion: this.versions.appVersion,
      fingerprints: this.versions.fingerprints,
      name: this.localName,
      animal: this.localAnimal,
    };
    await new Promise<void>((resolve, reject) => {
      this.joinWaiter = {
        resolve,
        reject,
        cancel: this.clock.after(JOIN_TIMEOUT_MS, () => reject(new RoomError('timeout', 'The host did not answer. Is the room still open?'))),
      };
      this.sendJson(link, MSG.HELLO, hello);
    });
  }

  private installHandlers(): void {
    this.transport.setHandlers({
      onLink: (link) => this.onLink(link),
      onData: (link, channel, data) => this.onData(link, channel, data),
      onClose: (link, reason) => this.onClose(link, reason),
    });
  }

  // ── public: observation ────────────────────────────────────────────────────

  /** Subscribe; returns an unsubscribe function. */
  on<K extends keyof RoomEvents>(event: K, cb: RoomEvents[K]): () => void {
    const set = this.listeners[event] as Set<RoomEvents[K]>;
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  /** The current state (also delivered through the `state` event after every change). */
  get state(): RoomState {
    return this.makeState();
  }

  get isHost(): boolean {
    return this.role === 'host';
  }

  /** This machine's transport peer id. */
  get peerId(): string {
    return this.localPeerId;
  }

  // ── public: commands (any member) ──────────────────────────────────────────

  setName(name: string): void {
    const clean = sanitizeName(name, this.localName);
    this.localName = clean;
    if (this.phase === 'closed') return;
    if (this.role === 'host') {
      const me = this.members[0];
      me.name = this.uniqueName(clean, me);
      this.broadcastRoom();
    } else {
      this.sendToHost(MSG.HELLO, { t: 'name', name: clean });
    }
  }

  /**
   * Choose a fighter. Unique across the humans of the room: returns false (and emits an `error` with code
   * `animal-taken`, host side immediately, client side when the host denies) if another human already has it.
   * A bot holding the animal swaps to the picker's previous one.
   */
  pickAnimal(animal: AnimalId): boolean {
    if (!isAnimal(animal) || this.phase !== 'lobby') return false;
    this.localAnimal = animal;
    if (this.role === 'host') {
      const ok = this.applyPick(this.members[0], animal);
      if (!ok) this.emitError('animal-taken', 'Another player already picked that fighter.');
      return ok;
    }
    this.sendToHost(MSG.PICK, { t: 'pick', animal });
    return true;
  }

  /** Toggle readiness (clients; the host is always ready). */
  setReady(ready: boolean): void {
    if (this.role === 'host' || this.phase !== 'lobby') return;
    if (this.localBack) {
      this.deferredReady = ready; // the host is still in the match: send it when the room is back (see flushDeferredReady)
      this.emitState();
      return;
    }
    this.sendToHost(MSG.READY, { t: 'ready', ready });
  }

  /** Client: the host reopened the lobby (every ready flag was reset): re-apply a "Ready" pressed while it was still in the match. */
  private flushDeferredReady(): void {
    const d = this.deferredReady;
    this.deferredReady = null;
    if (d === true && this.phase === 'lobby') this.sendToHost(MSG.READY, { t: 'ready', ready: true });
  }

  /**
   * Leave the room. Host: the room ends for everyone (`ended('host-left')` on the clients). Client: the host removes us
   * (in a match the game layers see `onPeerLeft`). Does not emit `ended` on the leaver; `state.phase` becomes `closed`.
   */
  leave(): void {
    if (this.phase === 'closed') return;
    if (this.role === 'host') {
      for (const m of this.members) {
        const l = this.links.get(m.peerId);
        if (l !== undefined) this.sendJson(l, MSG.LEAVE, { t: 'close', message: 'The host closed the room.' });
      }
    } else {
      this.sendToHost(MSG.LEAVE, { t: 'leave' });
    }
    this.finish('left', 'You left the room.', FLUSH_MS);
  }

  /**
   * After a match: go back to the room. Host: ends the match for everybody and reopens the lobby (ready flags reset).
   * Client: if the host has not returned yet this just leaves the match locally (the host's game sees us leave) and
   * `state.phase` shows `lobby` right away. Idempotent.
   */
  backToRoom(): void {
    if (this.phase === 'closed') return;
    if (this.role === 'host') {
      if (this.phase !== 'inMatch') return;
      this.endMatchLocal();
      for (const m of this.members) if (m.peerId !== this.localPeerId) m.ready = false;
      this.phase = 'lobby';
      this.broadcastTo(MSG.MATCH_END, { t: 'end' });
      this.broadcastRoom();
      return;
    }
    if (this.phase !== 'inMatch') return;
    this.sendToHost(MSG.MATCH_END, { t: 'leaveMatch' });
    this.endMatchLocal();
    this.localBack = true;
    this.deferredReady = false; // the host resets every ready flag when it returns; show that now instead of a stale tick
    this.phase = 'lobby';
    this.emitState();
  }

  // ── public: host commands ──────────────────────────────────────────────────

  setMode(mode: OnlineMode): boolean {
    if (!this.requireHostLobby()) return false;
    if (mode !== 'battleRoyale' && mode !== 'championsLeague') return false;
    if (mode === this.mode) return true;
    this.mode = mode;
    if (mode === 'championsLeague') this.bots.length = 0; // CL is humans-only
    for (const m of this.members) if (m.peerId !== this.localPeerId) m.ready = false;
    this.broadcastRoom();
    return true;
  }

  setSettings(patch: RoomSettingsPatch): boolean {
    if (!this.requireHostLobby()) return false;
    this.settings = this.mergeSettings(patch);
    this.broadcastRoom();
    return true;
  }

  /** Battle Royale only: add a bot to the roster (a free animal; `animal` picks one). Returns false when impossible. */
  addBot(animal?: AnimalId): boolean {
    if (!this.requireHostLobby()) return false;
    if (this.mode !== 'battleRoyale') {
      this.emitError('wrong-phase', 'Bots are only available in Battle Royale.');
      return false;
    }
    if (this.members.length + this.bots.length >= ROOM_LIMITS.maxFighters) return false;
    let pick: AnimalId | null;
    if (animal !== undefined) pick = isAnimal(animal) && this.animalOwner(animal) === null ? animal : null;
    else pick = this.firstFreeAnimal();
    if (pick === null) return false;
    this.bots.push({ id: `bot:${++this.botSeq}`, animal: pick });
    this.broadcastRoom();
    return true;
  }

  /** Remove the bot with slot id `id` (e.g. `bot:2`), or the most recently added one. */
  removeBot(id?: string): boolean {
    if (!this.requireHostLobby()) return false;
    const i = id === undefined ? this.bots.length - 1 : this.bots.findIndex((b) => b.id === id);
    if (i < 0 || i >= this.bots.length) return false;
    this.bots.splice(i, 1);
    this.broadcastRoom();
    return true;
  }

  /** Remove a human (not yourself) from the room; they receive `ended('kicked')`. */
  kick(peerId: string): boolean {
    if (this.role !== 'host') {
      this.emitError('not-host', 'Only the host can remove players.');
      return false;
    }
    if (this.phase === 'closed' || peerId === this.localPeerId) return false;
    const link = this.links.get(peerId);
    if (link === undefined || !this.members.some((m) => m.peerId === peerId)) return false;
    this.sendJson(link, MSG.KICK, { t: 'kick', message: 'The host removed you from the room.' });
    this.dropLink(peerId, 'kicked', false);
    this.clock.after(FLUSH_MS, () => link.close());
    return true;
  }

  /** Why Start is not available right now (empty = it is). */
  startBlockers(): StartBlocker[] {
    if (this.role !== 'host') return ['not-host'];
    const out: StartBlocker[] = [];
    if (this.phase !== 'lobby') out.push('wrong-phase');
    if (this.members.length < ROOM_LIMITS.minHumans) out.push('need-players');
    if (this.members.some((m) => m.peerId !== this.localPeerId && !m.ready)) out.push('not-all-ready');
    return out;
  }

  /**
   * Start the match (host; ≥ 2 humans, every client ready). Asynchronous: clients are told to link up (Champions League:
   * full mesh), then every machine gets the `start` event at the same moment. Returns the blockers (empty = starting).
   * If linking fails the room returns to the lobby and an `error` (`mesh-failed`) is emitted.
   */
  startMatch(): StartBlocker[] {
    const blockers = this.startBlockers();
    if (blockers.length > 0) {
      if (this.role === 'host') this.emitError(blockers.includes('wrong-phase') ? 'wrong-phase' : 'cannot-start', 'The match cannot start yet.');
      else this.emitError('not-host', 'Only the host can start the match.');
      return blockers;
    }
    this.beginStart();
    return [];
  }

  // ── host: start sequence ───────────────────────────────────────────────────

  private beginStart(): void {
    const start = this.buildStart();
    const clients = this.members.filter((m) => m.peerId !== this.localPeerId);
    this.early = [];
    this.phase = 'starting';
    this.broadcastRoom();
    const waiting = new Set(clients.map((c) => c.peerId));
    this.startWait = {
      start,
      waiting,
      cancel: this.clock.after(MESH_TIMEOUT_MS, () => this.abortStart('timeout', 'Players could not connect to each other in time.', [...waiting])),
    };
    const wire: WireStart = { mode: start.mode, seed: start.seed, slots: start.slots, hostPeerId: start.hostPeerId, br: start.br, cl: start.cl };
    for (const c of clients) {
      let dial: string[] = [];
      let wait: string[] = [];
      if (start.mode === 'championsLeague') {
        const mine = start.slots.findIndex((s) => s.peerId === c.peerId);
        const others = start.slots.filter((s) => s.peerId !== null && s.peerId !== this.localPeerId && s.peerId !== c.peerId);
        dial = others.filter((s) => s.slot < mine).map((s) => s.peerId as string);
        wait = others.filter((s) => s.slot > mine).map((s) => s.peerId as string);
      }
      const link = this.links.get(c.peerId);
      if (link !== undefined) this.sendJson(link, MSG.PEER_LIST, { t: 'prepare', start: wire, dial, await: wait });
    }
  }

  private buildStart(): OnlineStart {
    interface Entry {
      peerId: string | null;
      name: string;
      animal: AnimalId;
      kind: 'human' | 'bot';
    }
    const humans: Entry[] = this.members.map((m) => ({ peerId: m.peerId, name: m.name, animal: m.animal, kind: 'human' }));
    const bots: Entry[] = [];
    if (this.mode === 'battleRoyale') {
      const used = new Set<AnimalId>(humans.map((h) => h.animal));
      for (const b of this.bots) {
        bots.push({ peerId: null, name: ANIMALS[b.animal].displayName, animal: b.animal, kind: 'bot' });
        used.add(b.animal);
      }
      if (this.settings.br.fillBots) {
        for (const a of ANIMAL_IDS) {
          if (humans.length + bots.length >= ROOM_LIMITS.maxFighters) break;
          if (used.has(a)) continue;
          used.add(a);
          bots.push({ peerId: null, name: ANIMALS[a].displayName, animal: a, kind: 'bot' });
        }
      }
    }
    // Spread the humans evenly around the roster (= the spawn ring): human k takes position floor(k·n/h). The host stays at 0.
    const n = humans.length + bots.length;
    const order: (Entry | undefined)[] = new Array<Entry | undefined>(n).fill(undefined);
    humans.forEach((h, k) => {
      order[Math.floor((k * n) / humans.length)] = h;
    });
    let bi = 0;
    for (let i = 0; i < n; i++) if (order[i] === undefined) order[i] = bots[bi++];
    const slots: OnlineSlotInfo[] = order.map((e, i) => {
      const x = e as Entry;
      return { slot: i, peerId: x.peerId, name: x.name, animal: x.animal, kind: x.kind };
    });
    const start: OnlineStart = {
      mode: this.mode,
      seed: randomU32(this.rng),
      slots,
      localSlot: slots.findIndex((s) => s.peerId === this.localPeerId),
      hostPeerId: this.localPeerId,
    };
    if (this.mode === 'battleRoyale') start.br = { difficulty: this.settings.br.botLevel };
    else
      start.cl = {
        stage: this.settings.cl.stage,
        stocks: this.settings.cl.stocks,
        timeLimitS: this.settings.cl.timeLimitS,
        botLevel: this.settings.br.botLevel,
      };
    return start;
  }

  private hostLinked(peerId: string): void {
    const w = this.startWait;
    if (w === null || !w.waiting.delete(peerId)) return;
    if (w.waiting.size > 0) return;
    w.cancel();
    this.startWait = null;
    const channel = this.makeMatchChannel(this.members.map((m) => m.peerId).filter((id) => id !== this.localPeerId));
    this.match = channel;
    this.phase = 'inMatch';
    this.broadcastTo(MSG.START, { t: 'go' });
    this.broadcastRoom();
    this.emit('start', w.start, channel);
    this.replayEarly(channel);
  }

  private abortStart(reason: AbortMsg['reason'], message: string, peers: string[] = []): void {
    const w = this.startWait;
    if (w === null) return;
    w.cancel();
    this.startWait = null;
    this.phase = 'lobby';
    this.broadcastTo(MSG.START, { t: 'abort', reason, message, peers });
    this.broadcastRoom();
    this.emitError(reason === 'timeout' || reason === 'mesh-failed' ? 'mesh-failed' : 'cannot-start', message, { peers });
  }

  // ── client: start sequence ─────────────────────────────────────────────────

  private clientPrepare(msg: PrepareMsg): void {
    if ((this.phase !== 'lobby' && this.phase !== 'starting') || this.localBack) return;
    if (msg.start.hostPeerId !== this.hostId || !msg.start.slots.some((s) => s.peerId === this.localPeerId)) return;
    this.prep?.cancel();
    this.early = []; // anything buffered so far belongs to a finished match
    const need = new Set<string>([...msg.dial, ...msg.await]);
    this.prep = {
      start: msg.start,
      need,
      linked: false,
      cancel: this.clock.after(MESH_TIMEOUT_MS, () => this.prepFailed('timeout', 'Could not link up with the other players in time.', [...need])),
    };
    this.phase = 'starting';
    this.emitState();
    for (const id of msg.dial) this.dial(id);
    this.checkPrep();
  }

  private dial(peerId: string): void {
    const existing = this.links.get(peerId);
    if (existing !== undefined && existing.open) return;
    this.transport.connect(peerId, this.connectTimeoutMs).then(
      (link) => {
        if (this.phase === 'closed' || this.prep === null) {
          link.close();
          return;
        }
        this.registerLink(link);
        this.checkPrep();
      },
      (err: unknown) => this.prepFailed('mesh-failed', `Could not connect to another player (${errMessage(err)}). A firewall or NAT may be in the way; a TURN server can help.`, [peerId]),
    );
  }

  private checkPrep(): void {
    const p = this.prep;
    if (p === null || p.linked) return;
    for (const id of p.need) if (this.links.get(id)?.open !== true) return;
    p.linked = true;
    this.sendToHost(MSG.START, { t: 'linked' });
  }

  private prepFailed(reason: AbortMsg['reason'], message: string, peers: string[]): void {
    const p = this.prep;
    if (p === null) return;
    p.cancel();
    this.prep = null;
    this.sendToHost(MSG.START, { t: 'abort', reason, message, peers });
    this.closeMeshLinks();
  }

  private clientGo(): void {
    const p = this.prep;
    if (p === null || this.phase !== 'starting') return;
    p.cancel();
    this.prep = null;
    const localSlot = p.start.slots.findIndex((s) => s.peerId === this.localPeerId);
    if (localSlot < 0) return;
    const start: OnlineStart = { ...p.start, localSlot };
    const channel = this.makeMatchChannel([this.hostId, ...p.need]);
    this.match = channel;
    this.phase = 'inMatch';
    this.emitState();
    this.emit('start', start, channel);
    this.replayEarly(channel);
  }

  private clientAbort(msg: AbortMsg): void {
    const had = this.prep !== null || this.phase === 'starting';
    this.prep?.cancel();
    this.prep = null;
    this.closeMeshLinks();
    if (this.phase === 'starting') this.phase = 'lobby';
    this.early = [];
    if (had) {
      this.emitError(
        msg.reason === 'timeout' || msg.reason === 'mesh-failed' ? 'mesh-failed' : 'cannot-start',
        msg.message.length > 0 ? msg.message : 'The match could not start.',
        { peers: msg.peers },
      );
    }
    this.emitState();
  }

  // ── match plumbing ─────────────────────────────────────────────────────────

  private makeMatchChannel(peerIds: string[]): MatchChannel {
    const ch = new MatchChannel(this.localPeerId);
    for (const id of peerIds) {
      const l = this.links.get(id);
      if (l !== undefined) ch.addLink(l);
    }
    return ch;
  }

  /** Game messages that arrived before `start` fired are replayed to the subscribers the `start` handlers just added. */
  private replayEarly(channel: MatchChannel): void {
    const buf = this.early;
    this.early = [];
    for (const e of buf) channel.handleData(e.link, e.channel, e.data);
  }

  private endMatchLocal(): void {
    this.match?.retire();
    this.match = null;
    this.early = [];
    this.prep?.cancel();
    this.prep = null;
    if (this.role === 'client') this.closeMeshLinks();
  }

  /** Client: close every link except the one to the host. */
  private closeMeshLinks(): void {
    for (const [id, l] of [...this.links]) {
      if (id === this.hostId) continue;
      this.links.delete(id);
      this.stats.delete(id);
      l.close();
    }
  }

  // ── roster logic (host) ────────────────────────────────────────────────────

  private requireHostLobby(): boolean {
    if (this.role !== 'host') {
      this.emitError('not-host', 'Only the host can change the room.');
      return false;
    }
    if (this.phase !== 'lobby') {
      this.emitError('wrong-phase', 'The room cannot be changed right now.');
      return false;
    }
    return true;
  }

  private mergeSettings(patch: RoomSettingsPatch): RoomSettings {
    return parseSettings({ br: { ...this.settings.br, ...patch.br }, cl: { ...this.settings.cl, ...patch.cl } }, this.settings);
  }

  private animalOwner(animal: AnimalId): { kind: 'human'; m: Member } | { kind: 'bot'; b: BotEntry } | null {
    const m = this.members.find((x) => x.animal === animal);
    if (m !== undefined) return { kind: 'human', m };
    const b = this.bots.find((x) => x.animal === animal);
    return b !== undefined ? { kind: 'bot', b } : null;
  }

  private firstFreeAnimal(): AnimalId | null {
    for (const a of ANIMAL_IDS) if (this.animalOwner(a) === null) return a;
    return null;
  }

  /** Give `m` the animal if no other human has it (a bot holding it swaps to m's old one). */
  private applyPick(m: Member, animal: AnimalId): boolean {
    if (this.phase !== 'lobby') return false;
    const owner = this.animalOwner(animal);
    if (owner !== null && owner.kind === 'human' && owner.m !== m) return false;
    if (owner !== null && owner.kind === 'bot') owner.b.animal = m.animal;
    m.animal = animal;
    this.broadcastRoom();
    return true;
  }

  private uniqueName(name: string, self: Member | null): string {
    const taken = new Set(this.members.filter((m) => m !== self).map((m) => m.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; i < 10; i++) {
      const suffix = ` ${i}`;
      const cand = `${Array.from(name).slice(0, ROOM_LIMITS.maxNameLength - suffix.length).join('')}${suffix}`;
      if (!taken.has(cand.toLowerCase())) return cand;
    }
    return name;
  }

  private hostHello(link: Link, o: Record<string, unknown>): void {
    const pend = this.pending.get(link.peerId);
    if (pend === undefined || pend.link !== link) return;
    const hello = parseHello(o);
    if (hello === null) {
      this.reject(link, 'bad-hello', 'The join request was malformed.');
      return;
    }
    const you: RoomVersions = { protocol: hello.protocol, appVersion: hello.appVersion, fingerprints: hello.fingerprints };
    const mismatch = diffVersions(this.versions, you);
    if (mismatch.length > 0) {
      this.reject(
        link,
        'version-mismatch',
        `Version mismatch: the host runs ${describeVersions(this.versions)}, you run ${describeVersions(you)}. Both players need the same version of the game.`,
        mismatch,
        you,
      );
      return;
    }
    if (this.phase !== 'lobby') {
      this.reject(link, 'room-busy', 'This room is already starting a match. Try again when it is back in the lobby.');
      return;
    }
    if (this.members.length >= ROOM_LIMITS.maxHumans) {
      this.reject(link, 'room-full', `This room is full (${ROOM_LIMITS.maxHumans} players).`);
      return;
    }
    pend.cancel();
    this.pending.delete(link.peerId);
    if (this.members.length + this.bots.length >= ROOM_LIMITS.maxFighters) this.bots.pop();
    let animal = hello.animal;
    const owner = this.animalOwner(animal);
    if (owner !== null) {
      const free = this.firstFreeAnimal();
      if (owner.kind === 'bot' && free !== null) owner.b.animal = free;
      else animal = free ?? animal;
    }
    const name = sanitizeName(hello.name, `Player ${this.members.length + 1}`);
    this.members.push({ peerId: link.peerId, name: this.uniqueName(name, null), animal, ready: false, shownPing: 0 });
    this.broadcastRoom();
  }

  private reject(link: Link, reason: RejectReason, message: string, mismatch?: string[], you?: RoomVersions): void {
    const pend = this.pending.get(link.peerId);
    if (pend !== undefined) pend.cancel();
    this.pending.delete(link.peerId);
    this.sendJson(link, MSG.HELLO, { t: 'reject', reason, message, mismatch, host: this.versions, you });
    this.links.delete(link.peerId);
    this.stats.delete(link.peerId);
    this.clock.after(FLUSH_MS, () => link.close());
  }

  // ── client: receiving room state ───────────────────────────────────────────

  private applyRoom(msg: RoomMsg): void {
    if (this.view !== null && msg.rev < this.view.rev) return;
    this.view = msg;
    if (this.phase === 'connecting') {
      this.phase = msg.phase;
      const w = this.joinWaiter;
      if (w !== null) {
        this.joinWaiter = null;
        w.cancel();
        w.resolve();
      }
    } else if (msg.phase === 'lobby') {
      if (this.phase === 'inMatch' || this.phase === 'starting' || this.match !== null || this.prep !== null) this.endMatchLocal();
      this.phase = 'lobby';
      this.clearLocalBack();
    } else if (msg.phase === 'starting' && this.phase === 'lobby' && !this.localBack) {
      this.phase = 'starting';
    }
    this.emitState();
  }

  /** The host is back in the lobby: stop being "back before the host" and apply a Ready pressed in the meantime. */
  private clearLocalBack(): void {
    const was = this.localBack;
    this.localBack = false;
    if (was) this.flushDeferredReady();
    else this.deferredReady = null;
  }

  private clientRejected(msg: ReturnType<typeof parseReject>): void {
    if (msg === null) return;
    const details: RoomErrorDetails = { host: msg.host, local: msg.you ?? this.versions, mismatch: msg.mismatch };
    const code: RoomErrorCode = msg.reason === 'bad-hello' ? 'protocol' : msg.reason;
    const err = new RoomError(code, msg.message.length > 0 ? msg.message : 'The host refused the connection.', details);
    const w = this.joinWaiter;
    if (w !== null) {
      this.joinWaiter = null;
      w.cancel();
      w.reject(err);
    }
  }

  // ── transport callbacks ────────────────────────────────────────────────────

  private onLink(link: Link): void {
    if (this.phase === 'closed') {
      link.close();
      return;
    }
    if (this.links.get(link.peerId) === link) return; // outgoing links are reported to us as well
    if (this.role === 'host') {
      if (this.links.has(link.peerId)) {
        link.close();
        return;
      }
      this.registerLink(link);
      this.pending.set(link.peerId, {
        link,
        cancel: this.clock.after(HELLO_TIMEOUT_MS, () => {
          if (this.pending.get(link.peerId)?.link === link) this.dropLink(link.peerId, 'no-hello', true);
        }),
      });
      return;
    }
    // Client: the host, or another joiner of this room (Champions League mesh). Strangers are refused.
    if (link.peerId === this.hostId || link.peerId.startsWith(`${this.hostId}-`)) {
      this.registerLink(link);
      this.checkPrep();
    } else {
      link.close();
    }
  }

  private registerLink(link: Link): void {
    if (this.links.get(link.peerId) === link) return;
    this.links.set(link.peerId, link);
    this.stats.set(link.peerId, { lastSeen: this.clock.now(), srtt: 0, samples: 0 });
    this.sendPing(link);
  }

  private onClose(link: Link, reason: string): void {
    if (this.links.get(link.peerId) !== link) return;
    this.dropLink(link.peerId, reason, false);
  }

  private onData(link: Link, channel: Channel, data: Uint8Array): void {
    if (this.phase === 'closed' || data.length < 1) return;
    if (this.links.get(link.peerId) !== link) return;
    const st = this.stats.get(link.peerId);
    if (st !== undefined) st.lastSeen = this.clock.now();
    const kind = data[0];
    if (kind >= GAME_KIND_MIN) {
      this.routeGame(link, channel, data);
      return;
    }
    const payload = data.subarray(1);
    if (kind === MSG.PING) {
      link.send('unreliable', frame(MSG.PONG, payload));
      return;
    }
    if (kind === MSG.PONG) {
      this.onPong(link, payload);
      return;
    }
    let obj: Record<string, unknown> | null;
    try {
      obj = asRecord(parseJsonPayload<unknown>(payload));
    } catch {
      return;
    }
    if (obj === null) return;
    if (this.role === 'host') this.hostMessage(link, kind, obj);
    else this.clientMessage(link, kind, obj);
  }

  private routeGame(link: Link, channel: Channel, data: Uint8Array): void {
    if (this.pending.has(link.peerId)) return;
    if (this.match !== null) {
      this.match.handleData(link, channel, data);
    } else if (this.phase === 'starting' || (this.role === 'client' && this.prep !== null) || (this.role === 'host' && this.startWait !== null)) {
      if (this.early.length < 512) this.early.push({ link, channel, data });
    }
  }

  // ── message dispatch ───────────────────────────────────────────────────────

  private hostMessage(link: Link, kind: number, o: Record<string, unknown>): void {
    if (this.pending.has(link.peerId)) {
      if (kind === MSG.HELLO && o.t === 'hello') this.hostHello(link, o);
      return;
    }
    const m = this.members.find((x) => x.peerId === link.peerId);
    if (m === undefined) return;
    switch (kind) {
      case MSG.HELLO:
        if (o.t === 'name') {
          m.name = this.uniqueName(sanitizeName(o.name, m.name), m);
          this.broadcastRoom();
        }
        break;
      case MSG.READY:
        if (o.t === 'ready' && this.phase === 'lobby') {
          m.ready = o.ready === true;
          this.broadcastRoom();
        }
        break;
      case MSG.PICK:
        if (o.t === 'pick' && isAnimal(o.animal)) {
          if (!this.applyPick(m, o.animal)) {
            this.sendJson(link, MSG.PICK, { t: 'denied', animal: o.animal, reason: this.phase === 'lobby' ? 'taken' : 'phase' });
            this.broadcastRoomTo(link);
          }
        }
        break;
      case MSG.LEAVE:
        if (o.t === 'leave') this.dropLink(link.peerId, 'left', true);
        break;
      case MSG.START:
        if (o.t === 'linked') this.hostLinked(link.peerId);
        else if (o.t === 'abort') {
          const a = parseAbort(o);
          if (a !== null) this.abortStart(a.reason, a.message.length > 0 ? a.message : `${m.name} could not link up with the other players.`, a.peers ?? [link.peerId]);
        }
        break;
      case MSG.MATCH_END:
        if (o.t === 'leaveMatch' && this.phase === 'inMatch') this.match?.handleClose(link, 'left-match');
        break;
      default:
        break;
    }
  }

  private clientMessage(link: Link, kind: number, o: Record<string, unknown>): void {
    if (link.peerId !== this.hostId) return;
    switch (kind) {
      case MSG.ROOM_STATE: {
        const msg = parseRoom(o, this.settings);
        if (msg !== null) this.applyRoom(msg);
        break;
      }
      case MSG.HELLO:
        if (o.t === 'reject') this.clientRejected(parseReject(o));
        break;
      case MSG.PICK:
        if (o.t === 'denied') this.emitError('animal-taken', 'Another player already picked that fighter.');
        break;
      case MSG.KICK:
        this.finish('kicked', typeof o.message === 'string' ? o.message.slice(0, 200) : 'The host removed you from the room.');
        break;
      case MSG.LEAVE:
        if (o.t === 'close') this.finish('host-left', typeof o.message === 'string' ? o.message.slice(0, 200) : 'The host closed the room.');
        break;
      case MSG.PEER_LIST: {
        const p = parsePrepare(o);
        if (p !== null) this.clientPrepare(p);
        break;
      }
      case MSG.START:
        if (o.t === 'go') this.clientGo();
        else if (o.t === 'abort') {
          const a = parseAbort(o);
          if (a !== null) this.clientAbort(a);
        }
        break;
      case MSG.MATCH_END:
        if (o.t === 'end') {
          if (this.phase === 'inMatch' || this.phase === 'starting' || this.match !== null) this.endMatchLocal();
          if (this.phase !== 'connecting') this.phase = 'lobby';
          this.clearLocalBack();
          this.emitState();
        }
        break;
      default:
        break;
    }
  }

  // ── heartbeat ──────────────────────────────────────────────────────────────

  private startTick(): void {
    if (this.cancelTick !== null) return;
    this.cancelTick = this.clock.every(this.heartbeatMs, () => this.tick());
  }

  private tick(): void {
    if (this.phase === 'closed') return;
    const now = this.clock.now();
    for (const [peerId, link] of [...this.links]) {
      const st = this.stats.get(peerId);
      if (st !== undefined && now - st.lastSeen > this.silenceMs) {
        this.dropLink(peerId, 'timeout', true);
        if ((this.phase as RoomPhase) === 'closed') return;
        continue;
      }
      this.sendPing(link);
    }
    if (this.role === 'host') {
      let dirty = false;
      for (const m of this.members) {
        if (m.peerId === this.localPeerId) continue;
        const cur = Math.round(this.stats.get(m.peerId)?.srtt ?? 0);
        if (Math.abs(cur - m.shownPing) >= 10 || cur === 0 !== (m.shownPing === 0)) dirty = true;
      }
      if (dirty) this.broadcastRoom();
    }
  }

  private sendPing(link: Link): void {
    link.send('unreliable', frame(MSG.PING, new ByteWriter(8).f64(this.clock.now()).finish()));
  }

  private onPong(link: Link, payload: Uint8Array): void {
    let sent: number;
    try {
      sent = new ByteReader(payload).f64();
    } catch {
      return;
    }
    const rtt = this.clock.now() - sent;
    const st = this.stats.get(link.peerId);
    if (st === undefined || !Number.isFinite(rtt) || rtt < 0 || rtt > 60000) return;
    st.srtt = st.samples === 0 ? rtt : smoothRtt(st.srtt, rtt);
    st.samples++;
    link.reportRtt?.(st.srtt);
  }

  // ── peers leaving ──────────────────────────────────────────────────────────

  /** Forget a link. `closeLink`: also close it. Notifies the match channel, the roster (host) or ends the room (host gone). */
  private dropLink(peerId: string, reason: string, closeLink: boolean): void {
    const pend = this.pending.get(peerId);
    if (pend !== undefined) {
      pend.cancel();
      this.pending.delete(peerId);
    }
    const link = this.links.get(peerId);
    if (link === undefined) return;
    this.links.delete(peerId);
    this.stats.delete(peerId);
    if (closeLink) {
      try {
        link.close();
      } catch {
        /* already closed */
      }
    }
    this.match?.handleClose(link, reason);
    if (this.phase === 'closed') return;
    if (this.role === 'host') this.hostPeerGone(peerId);
    else this.clientPeerGone(peerId, reason);
  }

  private hostPeerGone(peerId: string): void {
    const i = this.members.findIndex((m) => m.peerId === peerId);
    if (i < 0) return;
    const [gone] = this.members.splice(i, 1);
    if (this.startWait !== null) {
      this.abortStart('peer-left', `${gone.name} left while the match was starting.`, [peerId]);
      return;
    }
    this.broadcastRoom();
  }

  private clientPeerGone(peerId: string, reason: string): void {
    if (peerId === this.hostId) {
      const w = this.joinWaiter;
      if (w !== null) {
        this.joinWaiter = null;
        w.cancel();
        w.reject(new RoomError('connect-failed', 'The connection to the host was lost.'));
        return;
      }
      if (reason === 'timeout') this.finish('timeout', 'The connection to the host timed out.');
      else this.finish('host-left', 'The host left the room.');
      return;
    }
    if (this.prep?.need.has(peerId) === true) {
      this.prepFailed('mesh-failed', 'A player dropped while the match was starting.', [peerId]);
    }
  }

  // ── state / events ─────────────────────────────────────────────────────────

  private buildWire(): RoomMsg {
    const slots: WireSlot[] = [];
    for (const m of this.members) {
      const host = m.peerId === this.localPeerId;
      const ping = host ? 0 : Math.round(this.stats.get(m.peerId)?.srtt ?? 0);
      m.shownPing = ping;
      slots.push({ id: m.peerId, kind: 'human', name: m.name, animal: m.animal, ready: host || m.ready, ping });
    }
    if (this.mode === 'battleRoyale') {
      for (const b of this.bots) slots.push({ id: b.id, kind: 'bot', name: ANIMALS[b.animal].displayName, animal: b.animal, ready: true, ping: 0 });
    }
    const wirePhase: RoomMsg['phase'] = this.phase === 'starting' || this.phase === 'inMatch' ? this.phase : 'lobby';
    return {
      t: 'room',
      rev: ++this.rev,
      code: this.code,
      host: this.localPeerId,
      phase: wirePhase,
      mode: this.mode,
      settings: this.settings,
      slots,
      hostVersions: this.versions,
      botFill: this.botFill(),
    };
  }

  private botFill(): number {
    if (this.mode !== 'battleRoyale' || !this.settings.br.fillBots) return 0;
    return Math.max(0, ROOM_LIMITS.maxFighters - this.members.length - this.bots.length);
  }

  private makeState(): RoomState {
    const v = this.view;
    const blockers = this.startBlockers();
    if (v === null) {
      return {
        rev: 0,
        code: this.code,
        role: this.role,
        phase: this.phase,
        mode: this.mode,
        settings: this.settings,
        slots: [],
        localPeerId: this.localPeerId,
        hostPeerId: this.hostId,
        versions: this.versions,
        hostVersions: this.versions,
        botFill: 0,
        canStart: false,
        startBlockers: blockers,
      };
    }
    const slots: RoomSlot[] = v.slots.map((w) => ({
      id: w.id,
      kind: w.kind,
      peerId: w.kind === 'human' ? w.id : null,
      name: w.name,
      animal: w.animal,
      ready: this.deferredReady !== null && w.id === this.localPeerId ? this.deferredReady : w.ready,
      pingMs: w.ping,
      isHost: w.id === v.host,
      isLocal: w.id === this.localPeerId,
    }));
    return {
      rev: v.rev,
      code: v.code,
      role: this.role,
      phase: this.phase,
      mode: v.mode,
      settings: v.settings,
      slots,
      localPeerId: this.localPeerId,
      hostPeerId: v.host,
      versions: this.versions,
      hostVersions: v.hostVersions,
      botFill: v.botFill,
      canStart: blockers.length === 0,
      startBlockers: blockers,
    };
  }

  /** Host: publish the current roster/settings/phase to every client and to the local listeners. */
  private broadcastRoom(): void {
    if (this.role !== 'host' || this.phase === 'closed') return;
    const wire = this.buildWire();
    this.view = wire;
    const payload = frame(MSG.ROOM_STATE, jsonPayload(wire));
    for (const m of this.members) {
      if (m.peerId === this.localPeerId) continue;
      this.links.get(m.peerId)?.send('reliable', payload);
    }
    this.emitState();
  }

  /** Host: re-send the current wire state to one link (used to un-stick a client whose request was denied). */
  private broadcastRoomTo(link: Link): void {
    if (this.view !== null) link.send('reliable', frame(MSG.ROOM_STATE, jsonPayload(this.view)));
  }

  private broadcastTo(kind: number, obj: unknown): void {
    const payload = frame(kind, jsonPayload(obj));
    for (const m of this.members) {
      if (m.peerId === this.localPeerId) continue;
      this.links.get(m.peerId)?.send('reliable', payload);
    }
  }

  private sendJson(link: Link, kind: number, obj: unknown): void {
    link.send('reliable', frame(kind, jsonPayload(obj)));
  }

  private sendToHost(kind: number, obj: unknown): void {
    const l = this.links.get(this.hostId);
    if (l !== undefined) this.sendJson(l, kind, obj);
  }

  private emitState(): void {
    this.emit('state', this.makeState());
  }

  private emitError(code: RoomErrorCode, message: string, details?: RoomErrorDetails): void {
    this.emit('error', new RoomError(code, message, details));
  }

  private emit<K extends keyof RoomEvents>(event: K, ...args: Parameters<RoomEvents[K]>): void {
    for (const cb of [...(this.listeners[event] as Set<(...a: Parameters<RoomEvents[K]>) => void>)]) {
      try {
        cb(...args);
      } catch (err) {
        console.error(`[online] room "${event}" handler threw`, err);
      }
    }
  }

  // ── teardown ───────────────────────────────────────────────────────────────

  /** Close the room: `ended` (unless we left ourselves) and dispose the transport (after `flushMs` so goodbyes get out). */
  private finish(reason: RoomEndReason, message: string, flushMs = 0): void {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    this.cancelTimers();
    if (this.match !== null) {
      // The game layers learn about the room ending the same way they learn about any peer leaving.
      if (reason !== 'left') {
        for (const id of this.match.peers()) {
          const l = this.links.get(id);
          if (l !== undefined) this.match.handleClose(l, reason);
        }
      }
      this.match.retire();
    }
    const w = this.joinWaiter;
    if (w !== null) {
      this.joinWaiter = null;
      w.cancel();
      w.reject(new RoomError('connect-failed', message));
    }
    this.emitState();
    if (reason !== 'left') this.emit('ended', reason, message);
    if (flushMs > 0) this.clock.after(flushMs, () => this.transport.dispose());
    else this.transport.dispose();
  }

  private cancelTimers(): void {
    this.cancelTick?.();
    this.cancelTick = null;
    for (const p of this.pending.values()) p.cancel();
    this.pending.clear();
    this.startWait?.cancel();
    this.startWait = null;
    this.prep?.cancel();
    this.prep = null;
    this.joinWaiter?.cancel();
  }

  /** Failed construction: release everything without events. */
  private abandon(): void {
    this.phase = 'closed';
    this.cancelTimers();
    this.joinWaiter = null;
    try {
      this.transport?.dispose();
    } catch {
      /* ignore */
    }
  }
}
