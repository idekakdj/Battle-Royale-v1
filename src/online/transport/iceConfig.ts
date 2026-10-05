/**
 * Connection configuration for the PeerJS transport (plan §3): ICE servers (NAT traversal) and the signalling server.
 *
 *  - Defaults: public Google STUN servers (free, best-effort; enough for most home networks).
 *  - Extras (e.g. a TURN server for strict NATs / corporate networks) come from, in this order of appearance:
 *      1. the URL parameter `?ice=…`
 *      2. `localStorage['gk-ice']`
 *    Both accept either a JSON array/object of RTCIceServer dictionaries
 *      `[{"urls":"turn:turn.example.org:3478","username":"u","credential":"p"}]`
 *    or a short list: `stun:host:3478,turn:host:3478|user|pass` (comma separated; `|` separates url, username, credential).
 *  Extras are APPENDED to the defaults. Every access to `window`/storage is wrapped in try/catch — bad input is ignored.
 */

export interface IceServerSpec {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export const DEFAULT_ICE_SERVERS: readonly IceServerSpec[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/** localStorage key for user-configured extra ICE servers. */
export const ICE_STORAGE_KEY = 'gk-ice';

const URL_RE = /^(stun|stuns|turn|turns):[^\s,|]+$/i;

function cleanUrl(u: unknown): string | null {
  return typeof u === 'string' && u.length <= 256 && URL_RE.test(u.trim()) ? u.trim() : null;
}

function cleanSpec(raw: unknown): IceServerSpec | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const urls: string[] = [];
  if (Array.isArray(r.urls)) {
    for (const u of r.urls) {
      const c = cleanUrl(u);
      if (c !== null) urls.push(c);
    }
  } else {
    const c = cleanUrl(r.urls);
    if (c !== null) urls.push(c);
  }
  if (urls.length === 0) return null;
  const spec: IceServerSpec = { urls: urls.length === 1 ? urls[0] : urls };
  if (typeof r.username === 'string' && r.username.length <= 256) spec.username = r.username;
  if (typeof r.credential === 'string' && r.credential.length <= 512) spec.credential = r.credential;
  return spec;
}

/**
 * Parse user-supplied ICE servers (JSON or the short comma list). Invalid entries are dropped; never throws.
 * Returns only the extras, not the defaults.
 */
export function parseIceServers(raw: string | null | undefined): IceServerSpec[] {
  if (typeof raw !== 'string') return [];
  const text = raw.trim();
  if (text.length === 0 || text.length > 4096) return [];
  const out: IceServerSpec[] = [];
  if (text.startsWith('[') || text.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return [];
    }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      const s = cleanSpec(item);
      if (s !== null) out.push(s);
      if (out.length >= 8) break;
    }
    return out;
  }
  for (const part of text.split(',')) {
    const [url, username, credential] = part.split('|').map((x) => x.trim());
    const s = cleanSpec({ urls: url, username: username || undefined, credential: credential || undefined });
    if (s !== null) out.push(s);
    if (out.length >= 8) break;
  }
  return out;
}

export interface IceSources {
  /** `location.search` (default: the current page's). */
  search?: string;
  /** Storage with `getItem` (default: `localStorage`). */
  storage?: Pick<Storage, 'getItem'> | null;
}

/** Defaults + extras from `?ice=` and `localStorage['gk-ice']`. */
export function resolveIceServers(src: IceSources = {}): IceServerSpec[] {
  const out: IceServerSpec[] = DEFAULT_ICE_SERVERS.map((s) => ({ ...s }));
  let search = src.search;
  if (search === undefined) {
    try {
      search = typeof location !== 'undefined' ? location.search : '';
    } catch {
      search = '';
    }
  }
  try {
    const p = new URLSearchParams(search).get('ice');
    if (p !== null) out.push(...parseIceServers(p));
  } catch {
    /* ignore */
  }
  try {
    const st = src.storage !== undefined ? src.storage : typeof localStorage !== 'undefined' ? localStorage : null;
    if (st !== null) out.push(...parseIceServers(st.getItem(ICE_STORAGE_KEY)));
  } catch {
    /* storage blocked */
  }
  return out;
}

// ── signalling server ────────────────────────────────────────────────────────

export interface SignalServer {
  host: string;
  port: number;
  path: string;
  secure: boolean;
}

/**
 * Parse the `?signal=` parameter: `host:port`, `host:port/path`, `host` (port 9000 if the host is local, else 443) or a URL
 * (`http(s)://`, `ws(s)://`). Secure when the scheme is https/wss or the port is 443. Returns null for empty/invalid input.
 */
export function parseSignalParam(raw: string | null | undefined): SignalServer | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (s.length === 0 || s.length > 200) return null;
  let secure: boolean | null = null;
  const scheme = /^(https?|wss?):\/\//i.exec(s);
  if (scheme !== null) {
    secure = /^(https|wss)$/i.test(scheme[1]);
    s = s.slice(scheme[0].length);
  }
  const m = /^([A-Za-z0-9.\-_[\]:]+?)(?::(\d{1,5}))?(\/.*)?$/.exec(s);
  if (m === null) return null;
  const host = m[1];
  const local = /^(localhost|127\.|\[?::1\]?$|10\.|192\.168\.)/i.test(host);
  const port = m[2] !== undefined ? Number(m[2]) : secure === true ? 443 : local ? 9000 : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  let path = m[3] ?? '/';
  if (!path.endsWith('/')) path += '/';
  return { host, port, path, secure: secure ?? port === 443 };
}

