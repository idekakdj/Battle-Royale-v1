/**
 * Room codes and peer ids (plan §3). A room code is 5 characters from an alphabet without look-alikes
 * (no I, L, O, 0, 1). The host registers the peer id `gk1-<CODE>`; every joiner registers `gk1-<CODE>-<random6>`.
 */

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 5;
/** Peer-id prefix (also versions the signalling namespace: bump with the protocol if ids ever need to change). */
export const PEER_ID_PREFIX = 'gk1-';

const CODE_RE = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);
const SUFFIX_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** Random bytes from WebCrypto when present (browser, Electron, Node ≥ 19), else `Math.random`. */
function randomIndex(n: number, rng?: () => number): number {
  if (rng !== undefined) return Math.min(n - 1, Math.floor(rng() * n));
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c !== undefined && typeof c.getRandomValues === 'function') {
    // Rejection sampling: no modulo bias.
    const limit = 256 - (256 % n);
    const buf = new Uint8Array(1);
    for (let i = 0; i < 32; i++) {
      c.getRandomValues(buf);
      if (buf[0] < limit) return buf[0] % n;
    }
  }
  return Math.floor(Math.random() * n);
}

/** A fresh random room code. `rng` (in [0,1)) is for deterministic tests. */
export function generateRoomCode(rng?: () => number): string {
  let out = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) out += ROOM_CODE_ALPHABET[randomIndex(ROOM_CODE_ALPHABET.length, rng)];
  return out;
}

export function isValidRoomCode(code: string): boolean {
  return CODE_RE.test(code);
}

/**
 * Accepts what people actually paste: the bare code in any case with spaces/dashes (`abc de`, `ABC-DE`), a peer id
 * (`gk1-ABCDE`, `gk1-ABCDE-x7k2pq`) or an invite link (`https://…/?join=ABCDE`). Returns the canonical code or null.
 */
export function normalizeRoomCode(input: string): string | null {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (s.length === 0) return null;
  const q = /[?&#]join=([^&#\s]+)/i.exec(s);
  if (q !== null) {
    try {
      s = decodeURIComponent(q[1]);
    } catch {
      s = q[1];
    }
  }
  const peer = /gk1-([A-Za-z0-9]{5})(?:-[A-Za-z0-9]+)?/i.exec(s);
  if (peer !== null) s = peer[1];
  s = s.replace(/[\s-]+/g, '').toUpperCase();
  return isValidRoomCode(s) ? s : null;
}

/** Peer id the host registers. */
export function hostPeerId(code: string): string {
  return `${PEER_ID_PREFIX}${code}`;
}

/** Peer id a joiner registers (random suffix, lower-case so it can never collide with a host id). */
export function clientPeerId(code: string, rng?: () => number): string {
  let suffix = '';
  for (let i = 0; i < 6; i++) suffix += SUFFIX_ALPHABET[randomIndex(SUFFIX_ALPHABET.length, rng)];
  return `${PEER_ID_PREFIX}${code}-${suffix}`;
}

/** `gk1-ABCDE[-xxxxxx]` → `ABCDE`, else null. */
export function codeFromPeerId(peerId: string): string | null {
  const m = /^gk1-([A-Z0-9]{5})(?:-[a-z0-9]{6})?$/.exec(peerId);
  return m !== null && isValidRoomCode(m[1]) ? m[1] : null;
}

/**
 * Shareable link for a code: `<base>?join=CODE`. `base` is a page URL (query/hash are dropped); pass the page the friend
 * should open (the hosted web build). Returns just `?join=CODE` when no base is given.
 */
export function inviteLink(code: string, base?: string): string {
  const b = base === undefined ? '' : base.split(/[?#]/)[0];
  return `${b}?join=${code}`;
}
