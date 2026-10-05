/**
 * `PeerJsTransport` — the production {@link Transport}: WebRTC data channels brokered by a PeerJS signalling server
 * (the free public PeerJS cloud by default, or a local `scripts/dev-signal.mjs` via `?signal=host:port`).
 *
 * One {@link Link} = TWO PeerJS `DataConnection`s to the same remote peer, both `serialization: 'raw'` (binary):
 *   - `reliable: true`   ordered + retransmitted      → Channel 'reliable'
 *   - `reliable: false`  UNORDERED (no head-of-line blocking; own SCTP association)  → Channel 'unreliable'
 * The link opens only when BOTH are open (12 s timeout). The two halves of an incoming link are paired through the
 * `metadata.linkId` the dialler attached. NOTE: PeerJS 1.5 opens its unordered channel without `maxRetransmits`, so
 * "unreliable" packets are late-but-delivered rather than dropped — the game layers de-duplicate/ignore stale input anyway.
 *
 * Compile-checked + driven by the manual two-tab recipe only (WebRTC does not exist in the test environment).
 */

import { Peer, type DataConnection, type PeerOptions } from 'peerjs';
import type { Channel, Link, Transport, TransportHandlers } from '../types';
import { resolveIceServers, type IceServerSpec, type SignalServer } from './iceConfig';

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

/** Unreliable packets are dropped instead of queued once the data channel backs up past this many bytes. */
const MAX_UNRELIABLE_BACKLOG = 64 * 1024;

class PeerJsLink implements Link {
  readonly linkId: string;
  private rel: DataConnection | null = null;
  private unr: DataConnection | null = null;
  private opened = false;
  private closed = false;
  private rtt = 0;
  private buffer: { ch: Channel; data: Uint8Array }[] = [];
  /** Called once when both halves are open. */
  onReady: ((link: PeerJsLink) => void) | null = null;
  /** Called when a half fails/closes before or after the link was ready. */
  onDead: ((link: PeerJsLink, reason: string) => void) | null = null;

  constructor(
    readonly peerId: string,
    linkId: string,
    private readonly deliver: (link: PeerJsLink, ch: Channel, data: Uint8Array) => void,
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
      if (this.opened) this.deliver(this, ch, bytes);
      else if (this.buffer.length < 256) this.buffer.push({ ch, data: bytes });
    });
    dc.on('open', () => this.check());
    dc.on('close', () => this.fail('remote-closed'));
    dc.on('error', (e: Error) => this.fail(`error:${e.message}`));
    if (dc.open) this.check();
  }

  /** Both halves open → ready. */
  private check(): void {
    if (this.opened || this.closed) return;
    if (this.rel?.open !== true || this.unr?.open !== true) return;
    this.opened = true;
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
    const dc = channel === 'reliable' ? this.rel : this.unr;
    if (dc === null || !dc.open) return;
    try {
      if (channel === 'unreliable') {
        const dch = dc.dataChannel as RTCDataChannel | null;
        if (dch !== null && dch !== undefined && dch.bufferedAmount > MAX_UNRELIABLE_BACKLOG) return;
      }
      void dc.send(data.slice());
    } catch {
      /* a failed send surfaces as the connection closing */
    }
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
    const link = new PeerJsLink(peerId, linkId, (l, ch, d) => this.handlers?.onData(l, ch, d));
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
      const link = new PeerJsLink(dc.peer, md.linkId, (l, ch, d) => this.handlers?.onData(l, ch, d));
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
