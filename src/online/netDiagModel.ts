/**
 * Network diagnostics — the PURE half (v1.10.1): turn an `RTCPeerConnection.getStats()` report plus the link's own counters into
 * one {@link DiagSample}, keep a ring of the last 60, and format the one-line summary the net HUD shows. No DOM, no timers, so it
 * is unit-tested with hand-made reports. The stateful poller lives in `netDiag.ts`.
 */

import type { FastState } from './transport/fastChannel';

export type PathKind = 'direct' | 'relay' | 'unknown';
export type CandidateType = 'host' | 'srflx' | 'prflx' | 'relay' | 'unknown';

/** What the browser says about the selected ICE candidate pair and the data channels of one RTCPeerConnection. */
export interface PathStats {
  path: PathKind;
  localType: CandidateType;
  remoteType: CandidateType;
  /** 'udp' | 'tcp' | '' */
  protocol: string;
  /** ICE round trip (STUN consent checks): the NETWORK path only, it never includes our own queueing. Null when not reported. */
  rttMs: number | null;
  /** The congestion controller's estimate (browsers often omit it for data-only connections). Null when not reported. */
  availOutKbps: number | null;
  bytesSent: number;
  bytesReceived: number;
  channels: Array<{ label: string; state: string; bytesSent: number; bytesReceived: number }>;
}

/** The link's own counters (from the transport; independent of the browser stats). */
export interface LinkDiagInfo {
  open: boolean;
  /** 'n/a' for links without a fast channel (loopback). */
  fast: FastState | 'n/a';
  fastReason: string;
  /** Unreliable packets refused by the backlog guard (fast + fallback paths), cumulative. */
  dropped: number;
  /** Bytes currently queued in the channel that carries the 'unreliable' traffic. */
  buffered: number;
  sentUnreliable: number;
  receivedUnreliable: number;
}

export interface DiagSample {
  /** Epoch ms. */
  at: number;
  path: PathKind;
  localType: CandidateType;
  remoteType: CandidateType;
  protocol: string;
  rttMs: number | null;
  availOutKbps: number | null;
  /** Measured since the previous sample (kilobits per second): all traffic of the connection that carries the fast channel. */
  outKbps: number;
  inKbps: number;
  bytesSent: number;
  bytesReceived: number;
  fast: FastState | 'n/a';
  fastReason: string;
  dropped: number;
  buffered: number;
  sentUnreliable: number;
  receivedUnreliable: number;
  /** Set when getStats() failed or timed out. */
  statsError?: string;
}

export const DIAG_RING_SIZE = 60;

export class DiagRing {
  private items: DiagSample[] = [];

  constructor(readonly capacity = DIAG_RING_SIZE) {}

  push(s: DiagSample): void {
    this.items.push(s);
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
  }

  toArray(): DiagSample[] {
    return this.items.slice();
  }

  get last(): DiagSample | null {
    return this.items.length > 0 ? this.items[this.items.length - 1] : null;
  }

  get length(): number {
    return this.items.length;
  }
}

type Stat = Record<string, unknown>;

function eachStat(report: unknown, fn: (s: Stat) => void): void {
  const r = report as { forEach?: (cb: (v: unknown) => void) => void } | null | undefined;
  if (r === null || r === undefined || typeof r.forEach !== 'function') return;
  r.forEach((v) => {
    if (typeof v === 'object' && v !== null) fn(v as Stat);
  });
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function candType(v: unknown): CandidateType {
  return v === 'host' || v === 'srflx' || v === 'prflx' || v === 'relay' ? v : 'unknown';
}

/** Read the selected candidate pair + data channels out of an `RTCStatsReport` (or anything with `forEach`). Null: no pair yet. */
export function extractPathStats(report: unknown): PathStats | null {
  const pairs = new Map<string, Stat>();
  const cands = new Map<string, Stat>();
  let selectedId = '';
  const channels: PathStats['channels'] = [];
  eachStat(report, (s) => {
    const id = str(s.id);
    switch (s.type) {
      case 'transport':
        if (str(s.selectedCandidatePairId) !== '') selectedId = str(s.selectedCandidatePairId);
        break;
      case 'candidate-pair':
        pairs.set(id, s);
        break;
      case 'local-candidate':
      case 'remote-candidate':
        cands.set(id, s);
        break;
      case 'data-channel':
        channels.push({ label: str(s.label), state: str(s.state), bytesSent: num(s.bytesSent) ?? 0, bytesReceived: num(s.bytesReceived) ?? 0 });
        break;
      default:
        break;
    }
  });
  let pair = selectedId !== '' ? pairs.get(selectedId) : undefined;
  if (pair === undefined) {
    // Older Firefox: `selected`; otherwise the nominated pair that has carried the most data.
    let best: Stat | undefined;
    for (const p of pairs.values()) {
      const chosen = p.selected === true || (p.nominated === true && p.state === 'succeeded');
      if (!chosen) continue;
      if (best === undefined || p.selected === true || (num(p.bytesSent) ?? 0) > (num(best.bytesSent) ?? 0)) best = p;
    }
    pair = best;
  }
  if (pair === undefined) return null;
  const local = cands.get(str(pair.localCandidateId));
  const remote = cands.get(str(pair.remoteCandidateId));
  const localType = candType(local?.candidateType);
  const remoteType = candType(remote?.candidateType);
  const path: PathKind = localType === 'relay' || remoteType === 'relay' ? 'relay' : localType === 'unknown' && remoteType === 'unknown' ? 'unknown' : 'direct';
  const rtt = num(pair.currentRoundTripTime);
  const avail = num(pair.availableOutgoingBitrate);
  return {
    path,
    localType,
    remoteType,
    protocol: str(local?.protocol) || str(remote?.protocol),
    rttMs: rtt === null ? null : rtt * 1000,
    availOutKbps: avail === null ? null : avail / 1000,
    bytesSent: num(pair.bytesSent) ?? 0,
    bytesReceived: num(pair.bytesReceived) ?? 0,
    channels,
  };
}

/** One ring entry from a stats extraction (null = getStats failed) + the link counters; rates are measured against `prev`. */
export function makeSample(at: number, prev: DiagSample | null, stats: PathStats | null, info: LinkDiagInfo, statsError?: string): DiagSample {
  const dtS = prev !== null ? (at - prev.at) / 1000 : 0;
  const bytesSent = stats?.bytesSent ?? prev?.bytesSent ?? 0;
  const bytesReceived = stats?.bytesReceived ?? prev?.bytesReceived ?? 0;
  const rate = (now: number, before: number | undefined): number => (before === undefined || dtS <= 0 || now < before ? 0 : ((now - before) * 8) / 1000 / dtS);
  const sample: DiagSample = {
    at,
    path: stats?.path ?? 'unknown',
    localType: stats?.localType ?? 'unknown',
    remoteType: stats?.remoteType ?? 'unknown',
    protocol: stats?.protocol ?? '',
    rttMs: stats?.rttMs ?? null,
    availOutKbps: stats?.availOutKbps ?? null,
    outKbps: stats === null ? 0 : rate(bytesSent, prev?.bytesSent),
    inKbps: stats === null ? 0 : rate(bytesReceived, prev?.bytesReceived),
    bytesSent,
    bytesReceived,
    fast: info.fast,
    fastReason: info.fastReason,
    dropped: info.dropped,
    buffered: info.buffered,
    sentUnreliable: info.sentUnreliable,
    receivedUnreliable: info.receivedUnreliable,
  };
  if (statsError !== undefined) sample.statsError = statsError;
  return sample;
}

const NAT_RANK: Record<CandidateType, number> = { host: 0, unknown: 0, srflx: 1, prflx: 2, relay: 3 };

/** `direct (srflx)` (the more NAT-traversed of the two ends is named), `relay`, or `unknown`. */
export function pathLabel(s: Pick<DiagSample, 'path' | 'localType' | 'remoteType'>): string {
  if (s.path === 'relay') return 'relay';
  if (s.path === 'unknown') return 'unknown';
  const t = NAT_RANK[s.localType] >= NAT_RANK[s.remoteType] ? s.localType : s.remoteType;
  return `direct (${t})`;
}

/** `path: direct (srflx) · rtt 48 ms · out 120 kbps · dropped 0 · fast-channel on` */
export function formatDiagLine(s: DiagSample | null): string {
  if (s === null) return '';
  const rtt = s.rttMs === null ? '– ms' : `${Math.round(s.rttMs)} ms`;
  return `path: ${pathLabel(s)} · rtt ${rtt} · out ${Math.round(s.outKbps)} kbps · dropped ${s.dropped} · fast-channel ${s.fast}`;
}

/** The sample to put on the HUD when a machine has several links (the host): the one with the worst ICE round trip. */
export function worstSample(list: ReadonlyArray<DiagSample | null>): { sample: DiagSample | null; count: number } {
  let worst: DiagSample | null = null;
  let count = 0;
  for (const s of list) {
    if (s === null) continue;
    count++;
    if (worst === null || (s.rttMs ?? -1) > (worst.rttMs ?? -1) || (s.path === 'relay' && worst.path !== 'relay')) worst = s;
  }
  return { sample: worst, count };
}

/** HUD line for 0..n links. */
export function formatDiagSummary(list: ReadonlyArray<DiagSample | null>): string {
  const { sample, count } = worstSample(list);
  if (sample === null) return '';
  return count > 1 ? `worst of ${count} links · ${formatDiagLine(sample)}` : formatDiagLine(sample);
}
