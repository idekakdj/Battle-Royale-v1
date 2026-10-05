/**
 * Transport factory (WP-N1). `createDefaultTransport()` builds what the game uses in production:
 *
 *   PeerJsTransport   signalling: PeerJS cloud, or `?signal=host:port` (e.g. `scripts/dev-signal.mjs`)
 *                     ICE: Google STUN + `?ice=` / `localStorage['gk-ice']` (see iceConfig.ts)
 *   └─ wrapped in ConditionedTransport when `?netsim=latency:80,jitter:20,loss:0.05` is present (QA only)
 *
 * Every setting also has a localStorage fallback for the Electron build, which has no query string:
 * `gk-signal`, `gk-netsim`, `gk-ice`. PeerJS is imported lazily so it never loads (or is evaluated by tests) unless
 * someone actually goes online.
 */

import type { Transport } from '../types';
import { ConditionedTransport, parseNetSim } from './conditioned';
import { parseSignalParam, resolveIceServers } from './iceConfig';

export { ConditionedTransport, parseNetSim } from './conditioned';
export type { NetSim } from './conditioned';
export { DEFAULT_ICE_SERVERS, ICE_STORAGE_KEY, parseIceServers, parseSignalParam, resolveIceServers } from './iceConfig';
export type { IceServerSpec, SignalServer } from './iceConfig';
export { LoopbackNetwork } from './loopback';

export const SIGNAL_STORAGE_KEY = 'gk-signal';
export const NETSIM_STORAGE_KEY = 'gk-netsim';

function readParam(search: string, name: string, storageKey: string): string | null {
  try {
    const v = new URLSearchParams(search).get(name);
    if (v !== null && v.length > 0) return v;
  } catch {
    /* ignore */
  }
  try {
    if (typeof localStorage !== 'undefined') return localStorage.getItem(storageKey);
  } catch {
    /* storage blocked */
  }
  return null;
}

export interface DefaultTransportOptions {
  /** Query string to read the `signal` / `ice` / `netsim` parameters from (default: `location.search`). */
  search?: string;
}

export async function createDefaultTransport(opts: DefaultTransportOptions = {}): Promise<Transport> {
  let search = opts.search;
  if (search === undefined) {
    try {
      search = typeof location !== 'undefined' ? location.search : '';
    } catch {
      search = '';
    }
  }
  const { PeerJsTransport } = await import('./peerjs');
  let transport: Transport = new PeerJsTransport({
    signal: parseSignalParam(readParam(search, 'signal', SIGNAL_STORAGE_KEY)),
    iceServers: resolveIceServers({ search }),
  });
  const sim = parseNetSim(readParam(search, 'netsim', NETSIM_STORAGE_KEY));
  if (sim !== null) transport = new ConditionedTransport(transport, sim);
  return transport;
}
