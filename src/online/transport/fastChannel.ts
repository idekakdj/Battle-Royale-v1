/**
 * The v1.10.1 FAST (truly unreliable) data channel and the backlog guard, as pure(ish) logic with no PeerJS in it so it can be
 * unit-tested with fake `RTCDataChannel`s. `peerjs.ts` owns one {@link FastPath} per link.
 *
 * WHY. PeerJS 1.5 opens its "unreliable" DataConnection with `ordered: false` but WITHOUT `maxRetransmits` / `maxPacketLifeTime`,
 * so SCTP still retransmits every lost packet and, after a retransmission timeout, collapses its congestion window and backs
 * the timer off. Snapshots (30 Hz, per client), 60 Hz inputs and the 500 ms ping/pong then QUEUE behind the retransmits and
 * arrive seconds late (the 100-5500 ms ping spikes users reported). Stale snapshots and stale inputs are worthless in a realtime
 * game — they must be DROPPED, not delivered late.
 *
 * HOW. On the RTCPeerConnection of the PeerJS "unreliable" half (a separate SCTP association from the reliable half, so reliable
 * retransmits can never stall it) both ends create the SAME negotiated channel
 * `createDataChannel('gk-fast', { negotiated: true, id: FAST_CHANNEL_ID, ordered: false, maxRetransmits: 0 })`.
 * A negotiated channel has no in-band open handshake, so data sent before the other end has created its channel would vanish.
 * Therefore each end announces {@link FAST_READY_PACKET} over the RELIABLE channel once ITS end is open, and starts sending
 * 'unreliable' traffic on the fast channel only after the PEER's READY arrived. Until then — and permanently if READY does not
 * arrive within {@link FAST_READY_TIMEOUT_MS}, or the fast channel errors/closes (e.g. the peer is a v1.10.0 build that never
 * creates it) — the old PeerJS unreliable half keeps carrying everything. Incoming data from either path is delivered as
 * 'unreliable'. No wire format of the game layers changes; the READY packet is transport-internal: its first byte (0x0f) is
 * below every game kind and its body is not JSON, so a v1.10.0 peer's room layer drops it as junk.
 *
 * LOSS TOLERANCE (why 0 retransmits, not a short packet lifetime). Every 'unreliable' packet of the game is idempotent or
 * superseded by the next one: Battle Royale snapshots (30 Hz, state-complete; keyframes every 2 s), BR intents (60 Hz, free-running
 * edge counters), BR_SYNC / room PING+PONG (periodic), Champions League CL_INPUTS (every frame, carries ALL not-yet-acked inputs,
 * up to 48 frames of redundancy, plus a header ack) and CL_SYNC (100 ms periodic). A retransmit window would only re-introduce
 * the lateness this channel removes, so `maxRetransmits: 0` is used for both modes.
 */

/** Label of the negotiated fast channel. */
export const FAST_CHANNEL_LABEL = 'gk-fast';
/**
 * SCTP stream id of the negotiated channel, identical on both ends. PeerJS's own in-band channel on the same connection gets
 * the lowest free id (0 or 1 depending on the DTLS role), so a fixed high id can never clash with it.
 */
export const FAST_CHANNEL_ID = 100;
/** How long to wait (from the link opening) for the peer's READY before giving up on the fast channel for good. */
export const FAST_READY_TIMEOUT_MS = 3000;

/**
 * Unreliable sends are DROPPED (not queued) once this many bytes are waiting in the data channel. Rationale: at 30 Hz a
 * Battle Royale snapshot stream is 10-35 KB/s (~320-1200 B per snapshot), so 8 KB is at most ~0.25-0.8 s of snapshots; anything
 * older than half a second is stale (the client interpolates ~70-250 ms behind and extrapolates at most 100 ms), so delivering
 * it late can only hurt. The previous 64 KB limit was ~2-6 s of snapshots — exactly the multi-second ping spikes.
 */
export const MAX_UNRELIABLE_BACKLOG = 8 * 1024;

/** Transport-internal control kind sent on the reliable channel. Not an `MSG` kind; no game layer uses 0x0f. */
export const FAST_CTRL_KIND = 0x0f;
/** `[0x0f]['gkF1']` — the peer's fast channel is open. 'gkF1' is not valid JSON, so a v1.10.0 room layer ignores it. */
export const FAST_READY_PACKET: Readonly<Uint8Array> = new Uint8Array([FAST_CTRL_KIND, 0x67, 0x6b, 0x46, 0x31]);

export function isFastReady(data: Uint8Array): boolean {
  if (data.length !== FAST_READY_PACKET.length) return false;
  for (let i = 0; i < FAST_READY_PACKET.length; i++) if (data[i] !== FAST_READY_PACKET[i]) return false;
  return true;
}

/** `off` = permanently not used (see `reason`); the old PeerJS unreliable half carries the traffic. */
export type FastState = 'off' | 'opening' | 'handshake' | 'on';

export interface FastTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: FastTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface FastInfo {
  state: FastState;
  /** Why the channel is off ('' while it is not). */
  reason: string;
  sent: number;
  received: number;
  /** Packets refused by the backlog guard on the fast channel. */
  dropped: number;
}

export interface FastPathOptions {
  /** Send {@link FAST_READY_PACKET} over the reliable channel. Returns true when it went out. */
  sendReady(): boolean;
  /** An 'unreliable' packet arrived on the fast channel. */
  onData(bytes: Uint8Array): void;
  /** The state changed (for diagnostics). */
  onState?(state: FastState, reason: string): void;
  timers?: FastTimers;
  /** Override {@link FAST_READY_TIMEOUT_MS} (tests). */
  readyTimeoutMs?: number;
}

export type FastSendResult = 'sent' | 'dropped' | 'off';

/** Why an unreliable send must not go out on `dch` right now (`null` = fine). */
export function unreliableBlock(dch: Pick<RTCDataChannel, 'readyState' | 'bufferedAmount'> | null | undefined, maxBacklog = MAX_UNRELIABLE_BACKLOG): 'closed' | 'backlog' | null {
  if (dch === null || dch === undefined || dch.readyState !== 'open') return 'closed';
  return dch.bufferedAmount > maxBacklog ? 'backlog' : null;
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

export class FastPath {
  private dch: RTCDataChannel | null = null;
  private st: FastState = 'opening';
  private why = '';
  private localOpen = false;
  private linkOpen = false;
  private peerIsReady = false;
  private readySent = false;
  private timer: unknown = null;
  private readonly timers: FastTimers;
  private readonly readyTimeoutMs: number;
  private nSent = 0;
  private nRecv = 0;
  private nDropped = 0;

  constructor(
    pc: Pick<RTCPeerConnection, 'createDataChannel'>,
    private readonly opts: FastPathOptions,
  ) {
    this.timers = opts.timers ?? realTimers;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? FAST_READY_TIMEOUT_MS;
    try {
      const dch = pc.createDataChannel(FAST_CHANNEL_LABEL, { negotiated: true, id: FAST_CHANNEL_ID, ordered: false, maxRetransmits: 0 });
      dch.binaryType = 'arraybuffer';
      dch.onopen = () => this.onOpen();
      dch.onmessage = (e: MessageEvent) => this.onMessage(e.data);
      dch.onclose = () => this.die('closed');
      dch.onerror = () => this.die('error');
      this.dch = dch;
      if (dch.readyState === 'open') this.onOpen();
    } catch (e) {
      this.dch = null;
      this.die(`create-failed:${e instanceof Error ? e.message : String(e)}`);
    }
  }

  get state(): FastState {
    return this.st;
  }

  /** True when 'unreliable' traffic should go out on the fast channel. */
  get active(): boolean {
    return this.st === 'on';
  }

  get dropped(): number {
    return this.nDropped;
  }

  info(): FastInfo {
    return { state: this.st, reason: this.why, sent: this.nSent, received: this.nRecv, dropped: this.nDropped };
  }

  /** The link (both PeerJS halves) is open: the reliable channel can carry READY, and the give-up timer starts. */
  linkOpened(): void {
    if (this.linkOpen) return;
    this.linkOpen = true;
    if (this.st === 'off') return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      if (this.st !== 'on') this.die('ready-timeout');
    }, this.readyTimeoutMs);
    this.maybeSendReady();
  }

  /** The peer's READY packet arrived on the reliable channel. */
  peerReady(): void {
    this.peerIsReady = true;
    this.maybeOn();
  }

  send(data: Uint8Array): FastSendResult {
    if (this.st !== 'on' || this.dch === null) return 'off';
    const block = unreliableBlock(this.dch);
    if (block === 'closed') {
      // closing / closed under us: stop using it (the link falls back to the PeerJS half) — nothing was queued.
      this.die(this.dch.readyState === 'open' ? 'closed' : this.dch.readyState);
      return 'off';
    }
    if (block === 'backlog') {
      this.nDropped++;
      return 'dropped';
    }
    try {
      this.dch.send(data as unknown as Uint8Array<ArrayBuffer>);
      this.nSent++;
      return 'sent';
    } catch {
      this.nDropped++;
      if (this.dch.readyState !== 'open') this.die(this.dch.readyState);
      return 'dropped';
    }
  }

  /** Currently buffered bytes (diagnostics). */
  get bufferedAmount(): number {
    return this.dch?.bufferedAmount ?? 0;
  }

  close(): void {
    this.clearTimer();
    this.st = 'off';
    if (this.why === '') this.why = 'link-closed';
    const dch = this.dch;
    this.dch = null;
    if (dch !== null) {
      dch.onopen = dch.onmessage = dch.onclose = dch.onerror = null;
      try {
        dch.close();
      } catch {
        /* already closed */
      }
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private onOpen(): void {
    if (this.st === 'off' || this.localOpen) return;
    this.localOpen = true;
    this.setState('handshake', '');
    this.maybeSendReady();
    this.maybeOn();
  }

  private onMessage(data: unknown): void {
    const bytes = toBytes(data);
    if (bytes === null) return;
    this.nRecv++;
    this.opts.onData(bytes);
  }

  private maybeSendReady(): void {
    if (this.readySent || !this.localOpen || !this.linkOpen || this.st === 'off') return;
    this.readySent = this.opts.sendReady();
  }

  private maybeOn(): void {
    if (this.st === 'off' || !this.localOpen || !this.peerIsReady) return;
    this.clearTimer();
    this.setState('on', '');
  }

  private die(reason: string): void {
    if (this.st === 'off') return;
    this.clearTimer();
    this.st = 'off';
    this.why = reason;
    const dch = this.dch;
    this.dch = null;
    if (dch !== null) {
      dch.onopen = dch.onmessage = dch.onclose = dch.onerror = null;
      try {
        dch.close();
      } catch {
        /* already closed */
      }
    }
    this.opts.onState?.('off', reason);
  }

  private setState(s: FastState, reason: string): void {
    if (this.st === s) return;
    this.st = s;
    this.why = reason;
    this.opts.onState?.(s, reason);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
