/**
 * `PeerJsTransport` — the production {@link Transport}: WebRTC data channels brokered by a PeerJS signalling server
 * (the free public PeerJS cloud by default, or a local `scripts/dev-signal.mjs` via `?signal=host:port`).
 *
 * One {@link Link} = TWO PeerJS `DataConnection`s to the same remote peer, both `serialization: 'raw'` (binary):
 *   - `reliable: true`   ordered + retransmitted      → Channel 'reliable'
 *   - `reliable: false`  UNORDERED (no head-of-line blocking; own SCTP association)  → Channel 'unreliable'
 * The link opens only when BOTH are open (12 s timeout). The two halves of an incoming link are paired through the
 * `metadata.linkId` the dialler attached.
 *
 * v1.10.1 — TRULY unreliable channel. PeerJS 1.5 opens its unordered channel WITHOUT `maxRetransmits`, so SCTP still retransmits
 * lost packets and, after a timeout, collapses its congestion window: snapshots, inputs and pings queued behind the retransmits and
 * arrived seconds late (the 100-5500 ms ping spikes). Each link therefore also negotiates a `gk-fast` data channel
 * (`maxRetransmits: 0`, unordered) on the RTCPeerConnection of the 'unreliable' half; once BOTH ends confirmed theirs is open (READY
 * over the reliable channel) all 'unreliable' traffic uses it, and the old half stays as the fallback (v1.10.0 peers, READY timeout,
 * channel error/close). Unreliable sends are dropped, not queued, when more than {@link MAX_UNRELIABLE_BACKLOG} bytes are waiting.
 * Details and rationale: `fastChannel.ts`; numbers shown to the player: `netDiag.ts`.
 *
 * Compile-checked + unit-tested with fake data channels (`tests/online/fastChannel.test.ts`); the real WebRTC behaviour is driven by
 * the manual two-tab recipe only (docs/ONLINE-NOTES.md — WebRTC does not exist in the test environment).
 */

import { Peer, type DataConnection, type PeerOptions } from 'peerjs';
import type { Channel, Link, Transport, TransportHandlers } from '../types';
import { netDiag } from '../netDiag';
import type { LinkDiagInfo } from '../netDiagModel';
import { FAST_READY_PACKET, FastPath, isFastReady, unreliableBlock } from './fastChannel';
import { resolveIceServers, type IceServerSpec, type SignalServer } from './iceConfig';

export { MAX_UNRELIABLE_BACKLOG } from './fastChannel';

export interface PeerJsTransportOptions {
  /** Custom signalling server; omit for the PeerJS cloud. */
  signal?: SignalServer | null;
  /** ICE servers; default = {@link resolveIceServers}() (Google STUN + `?ice=` / `gk-ice`). */
  iceServers?: IceServerSpec[];
  /** Default link-open timeout (ms). */
  connectTimeoutMs?: number;
  /** PeerJS log level 0 (off) … 3 (all). */
  debug?: 0 | 1 | 2 | 3;
}

function token(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c !== undefined && typeof c.getRandomValues === 'function') {
    return Array.from(c.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return Math.random().toString(16).slice(2, 18).padEnd(16, '0');
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/** @internal exported for the unit tests (fake DataConnections); production code only reaches it through {@link PeerJsTransport}. */
export class PeerJsLink implements Link {
  readonly linkId: string;
  private rel: DataConnection | null = null;
  private unr: DataConnection | null = null;
  private opened = false;
  private closed = false;
  private rtt = 0;
  private buffer: { ch: Channel; data: Uint8Array }[] = [];
  /** v1.10.1: the negotiated `maxRetransmits: 0` channel next to the PeerJS 'unreliable' half (null: not creatable). */
  private fast: FastPath | null = null;
  private peerReadyEarly = false;
  private stopDiag: (() => void) | null = null;
  private droppedUnreliable = 0;
  private sentUnreliable = 0;
  private receivedUnreliable = 0;
  /** Called once when both halves are open. */
  onReady: ((link: PeerJsLink) => void) | null = null;
  /** Called when a half fails/closes before or after the link was ready. */
  onDead: ((link: PeerJsLink, reason: string) => void) | null = null;

  constructor(
    readonly peerId: string,
    linkId: string,
    private readonly deliver: (link: PeerJsLink, ch: Channel, data: Uint8Array) => void,
    private readonly log: ((msg: string) => void) | null = null,
  ) {
    this.linkId = linkId;
  }

  get open(): boolean {
    return this.opened && !this.closed;
  }

  get rttMs(): number {
    return this.rtt;
  }

  reportRtt(ms: number): void {
    if (Number.isFinite(ms) && ms >= 0) this.rtt = ms;
  }

  /** Wire a DataConnection in as one half. */
  attach(ch: Channel, dc: DataConnection): void {
    if (ch === 'reliable') this.rel = dc;
    else this.unr = dc;
    dc.on('data', (d) => {
      const bytes = toBytes(d);
      if (bytes === null || this.closed) return;
      if (ch === 'reliable' && isFastReady(bytes)) {
        // Transport-internal handshake: never reaches the game layers.
        if (this.fast !== null) this.fast.peerReady();
        else this.peerReadyEarly = true;
        return;
      }
      this.receive(ch, bytes);
    });
    dc.on('open', () => this.check());
    dc.on('close', () => this.fail('remote-closed'));
    dc.on('error', (e: Error) => this.fail(`error:${e.message}`));
    if (ch === 'unreliable') this.initFast(dc);
    if (dc.open) this.check();
  }

  private receive(ch: Channel, bytes: Uint8Array): void {
    if (ch === 'unreliable') this.receivedUnreliable++;
    if (this.opened) this.deliver(this, ch, bytes);
    else if (this.buffer.length < 256) this.buffer.push({ ch, data: bytes });
  }

  /** Create our end of the `gk-fast` channel on the RTCPeerConnection of the 'unreliable' half. */
  private initFast(dc: DataConnection): void {
    const pc = (dc as { peerConnection?: RTCPeerConnection | null }).peerConnection;
    if (pc === null || pc === undefined || typeof pc.createDataChannel !== 'function') return;
    this.fast = new FastPath(pc, {
      sendReady: () => this.sendReady(),
      onData: (bytes) => {
        if (!this.closed) this.receive('unreliable', bytes);
      },
      onState: (state, reason) => this.log?.(`fast channel to ${this.peerId}: ${state}${reason !== '' ? ` (${reason})` : ''}`),
    });
    if (this.peerReadyEarly) this.fast.peerReady();
  }

  private sendReady(): boolean {
    const rel = this.rel;
    if (rel === null || !rel.open) return false;
    try {
      void rel.send(FAST_READY_PACKET.slice());
      return true;
    } catch {
      return false;
    }
  }

  /** Both halves open → ready. */
  private check(): void {
    if (this.opened || this.closed) return;
    if (this.rel?.open !== true || this.unr?.open !== true) return;
    this.opened = true;
    this.fast?.linkOpened();
    this.onReady?.(this);
  }

  /** Deliver anything that arrived between the halves opening and the owner being told (call after `onLink`). */
  flush(): void {
    const buf = this.buffer;
    this.buffer = [];
    for (const m of buf) {
      if (this.closed) return;
      this.deliver(this, m.ch, m.data);
    }
  }

  send(channel: Channel, data: Uint8Array): void {
    if (!this.open) return;
    if (channel === 'unreliable') {
      this.sendUnreliable(data);
      return;
    }
    const dc = this.rel;
    if (dc === null || !dc.open) return;
    try {
      void dc.send(data.slice());
    } catch {
      /* a failed send surfaces as the connection closing */
    }
  }

  /**
   * 'unreliable' traffic: the fast channel once it is confirmed on both ends, else the PeerJS half. Either way a packet is
   * DROPPED (and counted) rather than queued when the channel is backed up or closing — late is worse than lost.
   */
  private sendUnreliable(data: Uint8Array): void {
    const fast = this.fast;
    if (fast !== null && fast.active) {
      const r = fast.send(data);
      if (r === 'sent') {
        this.sentUnreliable++;
        return;
      }
      if (r === 'dropped') {
        this.droppedUnreliable++;
        return;
      }
      // 'off': the fast channel just died — fall through to the PeerJS half.
    }
    const dc = this.unr;
    if (dc === null || !dc.open) return;
    try {
      const dch = dc.dataChannel as RTCDataChannel | null | undefined;
      if (dch !== null && dch !== undefined && unreliableBlock(dch) !== null) {
        this.droppedUnreliable++;
        return;
      }
      void dc.send(data.slice());
      this.sentUnreliable++;
    } catch {
      /* a failed send surfaces as the connection closing */
    }
  }

  /** Diagnostics: this link's own counters (see `netDiag.ts`). */
  diagInfo(): LinkDiagInfo {
    const fast = this.fast;
    const dch = this.unr?.dataChannel as RTCDataChannel | null | undefined;
    const buffered = fast !== null && fast.active ? fast.bufferedAmount : (dch?.bufferedAmount ?? 0);
    return {
      open: this.open,
      fast: fast === null ? 'off' : fast.state,
      fastReason: fast === null ? 'unsupported' : fast.info().reason,
      dropped: this.droppedUnreliable,
      buffered,
      sentUnreliable: this.sentUnreliable,
      receivedUnreliable: this.receivedUnreliable,
    };
  }

  /** `getStats()` of the RTCPeerConnection that carries the fast channel (null when there is none). */
  diagStats(): Promise<unknown> | null {
    const pc = this.unr?.peerConnection as RTCPeerConnection | null | undefined;
    if (pc === null || pc === undefined || typeof pc.getStats !== 'function') return null;
    return pc.getStats();
  }

  /** Start publishing this link to the network diagnostics (HUD line, `window.__gkNetDiag()`). */
  startDiag(): void {
    if (this.stopDiag !== null || this.closed) return;
    this.stopDiag = netDiag.register({ peerId: this.peerId, linkId: this.linkId, getStats: () => this.diagStats(), info: () => this.diagInfo() });
  }

  close(): void {
    this.teardown();
  }

  private fail(reason: string): void {
    if (this.closed) return;
    const wasOpen = this.opened;
    this.teardown();
    this.onDead?.(this, wasOpen ? reason : `connect-failed:${reason}`);
  }

  private teardown(): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer = [];
    this.stopDiag?.();
    this.stopDiag = null;
    this.fast?.close();
    for (const dc of [this.rel, this.unr]) {
      try {
        dc?.close();
      } catch {
        /* already closed */
      }
    }
  }
}

interface PendingConnect {
  peerId: string;
  reject: (e: Error) => void;
}

export class PeerJsTransport implements Transport {
  readonly kind = 'peerjs' as const;
  private peer: Peer | null = null;
  private handlers: TransportHandlers | null = null;
  private disposed = false;
  private readonly links = new Map<string, PeerJsLink>();
  /** Incoming halves waiting for their sibling, keyed by `peerId|linkId`. */
  private readonly incoming = new Map<string, { link: PeerJsLink; timer: ReturnType<typeof setTimeout> }>();
  private readonly connecting = new Set<PendingConnect>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly signal: SignalServer | null;
  private readonly iceServers: IceServerSpec[];
  private readonly connectTimeoutMs: number;
  private readonly debug: 0 | 1 | 2 | 3;

  constructor(opts: PeerJsTransportOptions = {}) {
    this.signal = opts.signal ?? null;
    this.iceServers = opts.iceServers ?? resolveIceServers();
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 12000;
    this.debug = opts.debug ?? 1;
  }

  setHandlers(h: TransportHandlers): void {
    this.handlers = h;
  }

  /** Register with the signalling server. Rejects with Error('id-taken') when `wantedId` is in use. */
  open(wantedId?: string): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('disposed'));
    this.destroyPeer();
    const options: PeerOptions = {
      debug: this.debug,
      config: { iceServers: this.iceServers, sdpSemantics: 'unified-plan' },
    };
    if (this.signal !== null) {
      options.host = this.signal.host;
      options.port = this.signal.port;
      options.path = this.signal.path;
      options.secure = this.signal.secure;
    }
    const peer = wantedId !== undefined ? new Peer(wantedId, options) : new Peer(options);
    this.peer = peer;
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.destroyPeer();
        reject(new Error('signalling-timeout'));
      }, 15000);
      peer.on('open', (id) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.attachPeer(peer);
        resolve(id);
      });
      peer.on('error', (err) => {
        const type = (err as { type?: string }).type ?? 'unknown';
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.destroyPeer();
          reject(type === 'unavailable-id' ? new Error('id-taken') : new Error(`signalling-failed:${type}`));
          return;
        }
        this.onPeerError(type, err.message);
      });
    });
  }

  private attachPeer(peer: Peer): void {
    peer.on('connection', (dc) => this.onIncoming(dc));
    peer.on('disconnected', () => this.scheduleReconnect(peer));
  }

  /** Keep our id registered with the signalling server so new joiners can still find us. */
  private scheduleReconnect(peer: Peer, attempt = 0): void {
    if (this.disposed || this.peer !== peer || peer.destroyed || this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = null;
        if (this.disposed || this.peer !== peer || peer.destroyed) return;
        try {
          if (peer.disconnected) {
            peer.reconnect();
            if (attempt < 20) setTimeout(() => peer.disconnected && this.scheduleReconnect(peer, attempt + 1), 3000);
          }
        } catch {
          /* try again on the next 'disconnected' */
        }
      },
      Math.min(10000, 500 * 2 ** Math.min(attempt, 5)),
    );
  }

  private onPeerError(type: string, message: string): void {
    if (type === 'peer-unavailable') {
      const id = /peer\s+(\S+)/.exec(message)?.[1];
      for (const c of [...this.connecting]) {
        if (id === undefined || c.peerId === id) {
          this.connecting.delete(c);
          c.reject(new Error('unknown-peer'));
        }
      }
      return;
    }
    if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
      for (const c of [...this.connecting]) {
        this.connecting.delete(c);
        c.reject(new Error(`signalling-failed:${type}`));
      }
    }
    // 'webrtc' and 'disconnected' errors: the affected connections report themselves through their own events.
    if (this.debug > 0) console.warn(`[online] PeerJS ${type}: ${message}`);
  }

  async connect(peerId: string, timeoutMs?: number): Promise<Link> {
    const peer = this.peer;
    if (this.disposed || peer === null || peer.destroyed) throw new Error('not-open');
    const existing = this.links.get(peerId);
    if (existing !== undefined && existing.open) return existing;
    const linkId = token();
    const link = new PeerJsLink(peerId, linkId, (l, ch, d) => this.handlers?.onData(l, ch, d), this.linkLog());
    const meta = (ch: Channel): object => ({ gk: 1, linkId, ch });
    const rel = peer.connect(peerId, { reliable: true, serialization: 'raw', label: 'gk-r', metadata: meta('reliable') });
    const unr = peer.connect(peerId, { reliable: false, serialization: 'raw', label: 'gk-u', metadata: meta('unreliable') });
    return new Promise<Link>((resolve, reject) => {
      let done = false;
      const pend: PendingConnect = { peerId, reject: (e) => finish(e) };
      this.connecting.add(pend);
      const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs ?? this.connectTimeoutMs);
      const finish = (err: Error | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.connecting.delete(pend);
        if (err !== null) {
          link.onReady = null;
          link.onDead = null;
          link.close();
          reject(err);
          return;
        }
        this.activate(link);
        resolve(link);
      };
      link.onReady = () => finish(null);
      link.onDead = (_l, reason) => finish(new Error(reason.startsWith('connect-failed') ? 'connect-failed' : reason));
      link.attach('reliable', rel);
      link.attach('unreliable', unr);
    });
  }

  /** A link whose two halves are open: register, announce, flush buffered traffic, watch for later death. */
  private activate(link: PeerJsLink): void {
    const old = this.links.get(link.peerId);
    if (old !== undefined && old !== link) {
      old.onDead = null;
      old.close();
    }
    this.links.set(link.peerId, link);
    link.startDiag();
    link.onReady = null;
    link.onDead = (l, reason) => {
      if (this.links.get(l.peerId) === l) this.links.delete(l.peerId);
      if (!this.disposed) this.handlers?.onClose(l, reason);
    };
    this.handlers?.onLink(link);
    link.flush();
  }

  private onIncoming(dc: DataConnection): void {
    const md = dc.metadata as { gk?: unknown; linkId?: unknown; ch?: unknown } | null | undefined;
    if (md === null || md === undefined || md.gk !== 1 || typeof md.linkId !== 'string' || md.linkId.length > 40 || (md.ch !== 'reliable' && md.ch !== 'unreliable')) {
      try {
        dc.close();
      } catch {
        /* ignore */
      }
      return;
    }
    const key = `${dc.peer}|${md.linkId}`;
    let entry = this.incoming.get(key);
    if (entry === undefined) {
      const link = new PeerJsLink(dc.peer, md.linkId, (l, ch, d) => this.handlers?.onData(l, ch, d), this.linkLog());
      const timer = setTimeout(() => {
        const e = this.incoming.get(key);
        if (e === undefined) return;
        this.incoming.delete(key);
        e.link.onDead = null;
        e.link.close();
      }, this.connectTimeoutMs);
      link.onReady = (l) => {
        clearTimeout(timer);
        this.incoming.delete(key);
        this.activate(l);
      };
      link.onDead = () => {
        clearTimeout(timer);
        this.incoming.delete(key);
      };
      entry = { link, timer };
      this.incoming.set(key, entry);
    }
    entry.link.attach(md.ch, dc);
  }

  private linkLog(): ((msg: string) => void) | null {
    return this.debug > 0 ? (msg) => console.info(`[online] ${msg}`) : null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const c of [...this.connecting]) c.reject(new Error('closed'));
    this.connecting.clear();
    for (const e of this.incoming.values()) {
      clearTimeout(e.timer);
      e.link.onDead = null;
      e.link.close();
    }
    this.incoming.clear();
    for (const l of [...this.links.values()]) {
      l.onDead = null;
      l.close();
    }
    this.links.clear();
    this.destroyPeer();
    this.handlers = null;
  }

  private destroyPeer(): void {
    const p = this.peer;
    this.peer = null;
    if (p === null) return;
    try {
      p.destroy();
    } catch {
      /* ignore */
    }
  }
}
