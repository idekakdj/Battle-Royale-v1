/**
 * Online UI (WP-N4) — small pure helpers: room-code / invite-link parsing and building, clipboard access with a
 * graceful fallback, ping classification. No dependency on the room layer except the code utilities.
 */

import { normalizeRoomCode } from '../room/roomCode';

export type JoinInputResult = { kind: 'empty' } | { kind: 'invalid' } | { kind: 'ok'; code: string };

/** Classify what the player typed or pasted in the Join box (code in any case, `ABC-DE`, peer id or invite link). */
export function parseJoinInput(input: string): JoinInputResult {
  if (typeof input !== 'string' || input.trim().length === 0) return { kind: 'empty' };
  const code = normalizeRoomCode(input);
  return code === null ? { kind: 'invalid' } : { kind: 'ok', code };
}

/**
 * Keep the Join box tidy: a pasted link / peer id / lower-case code collapses to the canonical code as soon as it
 * is recognisable; everything else is left exactly as typed (so editing never fights the player).
 */
export function collapseJoinInput(value: string): string {
  const r = parseJoinInput(value);
  return r.kind === 'ok' ? r.code : value;
}

/** The `join` query parameter of a page URL (`?join=k7p4q` -> `K7P4Q`), or null when absent / not a valid code. */
export function joinCodeFromSearch(search: string): string | null {
  try {
    const v = new URLSearchParams(search).get('join');
    return v === null ? null : normalizeRoomCode(v);
  } catch {
    return null;
  }
}

/** `search` without the `join` parameter (other parameters such as `signal` / `netsim` are kept). Includes the leading `?` when non-empty. */
export function searchWithoutJoin(search: string): string {
  try {
    const p = new URLSearchParams(search);
    p.delete('join');
    const s = p.toString();
    return s.length > 0 ? `?${s}` : '';
  } catch {
    return '';
  }
}

export interface LocationLike {
  protocol: string;
  origin: string;
  pathname: string;
  search?: string;
}

/**
 * Invite link for a room: `<origin><pathname>?join=CODE`. Only web pages (http/https) can be opened by a friend, so
 * the desktop build (`app://` / `file://`) returns null and the UI offers the bare code instead. A `signal=` parameter of
 * the current page (local QA signalling server) is carried over so the friend uses the same server.
 */
export function buildInviteLink(code: string, loc: LocationLike): string | null {
  if (loc.protocol !== 'http:' && loc.protocol !== 'https:') return null;
  if (typeof loc.origin !== 'string' || loc.origin === 'null' || loc.origin.length === 0) return null;
  let extra = '';
  if (loc.search !== undefined && loc.search.length > 0) {
    try {
      const signal = new URLSearchParams(loc.search).get('signal');
      if (signal !== null && signal.length > 0) extra = `&signal=${encodeURIComponent(signal)}`;
    } catch {
      /* ignore */
    }
  }
  return `${loc.origin}${loc.pathname}?join=${encodeURIComponent(code)}${extra}`;
}

/** Copy text to the clipboard. Resolves true on success; falls back to a hidden textarea + `execCommand('copy')`. Never throws. */
export async function copyText(text: string): Promise<boolean> {
  try {
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (clip !== undefined && typeof clip.writeText === 'function') {
      await clip.writeText(text);
      return true;
    }
  } catch {
    /* permission denied / insecure context: try the legacy path */
  }
  try {
    if (typeof document === 'undefined') return false;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    document.body.appendChild(ta);
    const active = document.activeElement as HTMLElement | null;
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    active?.focus?.({ preventScroll: true });
    return ok;
  } catch {
    return false;
  }
}

export type PingQuality = 'unknown' | 'great' | 'good' | 'ok' | 'poor' | 'bad';

export interface PingInfo {
  /** Lit bars out of 4. */
  bars: number;
  quality: PingQuality;
  /** "42 ms" or "-" when not measured yet. */
  text: string;
}

/** Signal strength for a round-trip time to the host (0 / non-finite = not measured yet). */
export function pingInfo(ms: number): PingInfo {
  if (!Number.isFinite(ms) || ms <= 0) return { bars: 0, quality: 'unknown', text: '–' };
  const r = Math.round(ms);
  const text = `${r} ms`;
  if (r < 60) return { bars: 4, quality: 'great', text };
  if (r < 110) return { bars: 3, quality: 'good', text };
  if (r < 180) return { bars: 2, quality: 'ok', text };
  if (r < 300) return { bars: 1, quality: 'poor', text };
  return { bars: 1, quality: 'bad', text };
}

/** "Bob", "Bob and Cy", "Bob, Cy and Di". */
export function joinNames(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Label for a room time limit in seconds (0 = none). */
export function timeLimitLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'None';
  const m = seconds / 60;
  return Number.isInteger(m) ? `${m} min` : `${Math.round(seconds)} s`;
}
