/**
 * Network diagnostics poller (v1.10.1). Every link that can be probed (the PeerJS ones) registers a {@link LinkProbe}; every
 * 2 s this polls `RTCPeerConnection.getStats()` of the connection that carries the fast channel, adds the link's own counters
 * (fast-channel state, packets dropped by the backlog guard) and keeps the last 60 samples per link. The net HUD shows the
 * newest as one line, and `window.__gkNetDiag()` returns everything as plain JSON (paste it when reporting lag).
 *
 * The pure maths (stats extraction, sample building, the one-line format) is in `netDiagModel.ts`.
 */

import {
  DiagRing,
  extractPathStats,
  formatDiagLine,
  formatDiagSummary,
  makeSample,
  worstSample,
  type DiagSample,
  type LinkDiagInfo,
  type PathStats,
} from './netDiagModel';

export interface LinkProbe {
  readonly peerId: string;
  readonly linkId: string;
  /** `getStats()` of the RTCPeerConnection that carries the 'unreliable' traffic; null when there is none (yet). */
  getStats(): Promise<unknown> | null;
  /** The link's own counters. */
  info(): LinkDiagInfo;
}

export const DIAG_POLL_MS = 2000;
const STATS_TIMEOUT_MS = 1500;
const MAX_CLOSED_ENTRIES = 4;

interface Entry {
  probe: LinkProbe;
  ring: DiagRing;
  closed: boolean;
  registeredAt: number;
}

export interface DiagLinkReport {
  peerId: string;
  linkId: string;
  closed: boolean;
  /** Newest sample (null before the first poll finished). */
  current: DiagSample | null;
  line: string;
  /** Oldest → newest, at most 60 samples, one per 2 s. */
  ring: DiagSample[];
}

export interface DiagSnapshot {
  version: 1;
  takenAt: string;
  intervalMs: number;
  userAgent: string;
  links: DiagLinkReport[];
  /** Human-readable summary of the same data (one block per link). */
  text: string;
}

export interface NetDiagOptions {
  intervalMs?: number;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** Expose `window.__gkNetDiag` when the first link registers. */
  installGlobal?: boolean;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('getStats-timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export class NetDiag {
  private readonly entries = new Map<string, Entry>();
  private timer: unknown = null;
  private polling = false;
  private globalInstalled = false;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly setIv: (fn: () => void, ms: number) => unknown;
  private readonly clearIv: (h: unknown) => void;
  private readonly installGlobal: boolean;

  constructor(opts: NetDiagOptions = {}) {
    this.intervalMs = opts.intervalMs ?? DIAG_POLL_MS;
    this.now = opts.now ?? (() => Date.now());
    this.setIv = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIv = opts.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    this.installGlobal = opts.installGlobal ?? false;
  }

  /** Start probing a link. Returns the function that stops (the ring is kept for a while so a report after a drop still works). */
  register(probe: LinkProbe): () => void {
    const key = `${probe.peerId}|${probe.linkId}`;
    const entry: Entry = { probe, ring: new DiagRing(), closed: false, registeredAt: this.now() };
    this.entries.set(key, entry);
    this.install();
    this.ensureTimer();
    void this.pollOne(entry);
    return () => {
      if (entry.closed) return;
      entry.closed = true;
      this.pruneClosed();
      if (!this.hasActive()) this.stopTimer();
    };
  }

  /** Poll every active link now (the timer calls this; tests await it). */
  async pollNow(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const active = [...this.entries.values()].filter((e) => !e.closed);
      await Promise.all(active.map((e) => this.pollOne(e)));
    } finally {
      this.polling = false;
    }
  }

  /** Newest samples of the active links (HUD). */
  currents(): DiagSample[] {
    const out: DiagSample[] = [];
    for (const e of this.entries.values()) if (!e.closed && e.ring.last !== null) out.push(e.ring.last);
    return out;
  }

  /** The HUD line (worst link), '' when nothing is probed yet. */
  summaryLine(): string {
    return formatDiagSummary(this.currents());
  }

  worst(): DiagSample | null {
    return worstSample(this.currents()).sample;
  }

  snapshot(): DiagSnapshot {
    const links: DiagLinkReport[] = [...this.entries.values()].map((e) => ({
      peerId: e.probe.peerId,
      linkId: e.probe.linkId,
      closed: e.closed,
      current: e.ring.last,
      line: formatDiagLine(e.ring.last),
      ring: e.ring.toArray(),
    }));
    const text = links.length === 0 ? 'no online links' : links.map((l) => `${l.peerId}${l.closed ? ' (closed)' : ''}: ${l.line || 'no sample yet'}`).join('\n');
    return {
      version: 1,
      takenAt: new Date(this.now()).toISOString(),
      intervalMs: this.intervalMs,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      links,
      text,
    };
  }

  dispose(): void {
    this.stopTimer();
    this.entries.clear();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async pollOne(entry: Entry): Promise<void> {
    const info = entry.probe.info();
    let stats: PathStats | null = null;
    let error: string | undefined;
    let pending: Promise<unknown> | null = null;
    try {
      pending = entry.probe.getStats();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    if (pending !== null) {
      try {
        stats = extractPathStats(await withTimeout(pending, STATS_TIMEOUT_MS));
        if (stats === null) error = 'no-selected-pair';
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    } else if (error === undefined) {
      error = 'no-peer-connection';
    }
    // The link may have been closed while getStats() was in flight: keep the sample anyway (it is still true).
    entry.ring.push(makeSample(this.now(), entry.ring.last, stats, info, error));
  }

  private hasActive(): boolean {
    for (const e of this.entries.values()) if (!e.closed) return true;
    return false;
  }

  private pruneClosed(): void {
    const closed = [...this.entries.entries()].filter(([, e]) => e.closed);
    for (let i = 0; i < closed.length - MAX_CLOSED_ENTRIES; i++) this.entries.delete(closed[i][0]);
  }

  private ensureTimer(): void {
    if (this.timer !== null) return;
    this.timer = this.setIv(() => void this.pollNow(), this.intervalMs);
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    this.clearIv(this.timer);
    this.timer = null;
  }

  private install(): void {
    if (!this.installGlobal || this.globalInstalled) return;
    this.globalInstalled = true;
    try {
      (globalThis as unknown as { __gkNetDiag?: () => DiagSnapshot }).__gkNetDiag = () => this.snapshot();
    } catch {
      /* frozen global: diagnostics still work through the HUD */
    }
  }
}

/** The app-wide instance: PeerJS links register here, the Battle Royale HUD reads it, `window.__gkNetDiag()` dumps it. */
export const netDiag = new NetDiag({ installGlobal: true });
