/**
 * Data fingerprint (plan §3): both machines must simulate with IDENTICAL tuning data, so the HELLO handshake compares
 * a hash of it. `computeFingerprint(mode)` = 32-bit FNV-1a (8 hex digits) of the stable-stringified tuning data of that
 * mode plus `APP_VERSION` and `ONLINE_PROTOCOL_VERSION`.
 *
 *   championsLeague  MOVESETS + STAGES + PHYS   (everything the rollback sim reads)
 *   battleRoyale     ANIMALS (incl. ultimates) + balance + traps + arena   (everything host AND client read)
 */

import { APP_VERSION } from '../../version';
import { ANIMALS } from '../../config/animals';
import * as balance from '../../config/balance';
import * as traps from '../../config/traps';
import * as arena from '../../config/arena';
import { PHYS } from '../../brawl/config';
import { MOVESETS, STAGES } from '../../brawl/data';
import { ONLINE_PROTOCOL_VERSION, type OnlineMode } from '../types';
import type { RoomVersions } from './types';

/**
 * Deterministic JSON-like serialisation: object keys sorted, `undefined`/functions skipped (functions are code, not
 * data — the build is pinned by `APP_VERSION`), non-finite numbers and `-0` spelled out. Cycles throw.
 */
export function stableStringify(value: unknown): string {
  const seen = new Set<object>();
  const walk = (v: unknown): string => {
    switch (typeof v) {
      case 'number':
        if (Number.isNaN(v)) return '"NaN"';
        if (!Number.isFinite(v)) return v > 0 ? '"Inf"' : '"-Inf"';
        return Object.is(v, -0) ? '0' : String(v);
      case 'string':
        return JSON.stringify(v);
      case 'boolean':
        return v ? 'true' : 'false';
      case 'bigint':
        return `"${v.toString()}n"`;
      case 'object': {
        if (v === null) return 'null';
        if (seen.has(v)) throw new Error('stableStringify: cycle');
        seen.add(v);
        let out: string;
        if (Array.isArray(v)) {
          out = `[${v.map((x) => (typeof x === 'function' || x === undefined ? 'null' : walk(x))).join(',')}]`;
        } else {
          const rec = v as Record<string, unknown>;
          const parts: string[] = [];
          for (const k of Object.keys(rec).sort()) {
            const x = rec[k];
            if (x === undefined || typeof x === 'function' || typeof x === 'symbol') continue;
            parts.push(`${JSON.stringify(k)}:${walk(x)}`);
          }
          out = `{${parts.join(',')}}`;
        }
        seen.delete(v);
        return out;
      }
      default:
        return 'null'; // undefined / function / symbol at the top level
    }
  };
  return walk(value);
}

/** 32-bit FNV-1a over the UTF-16 code units' UTF-8 bytes. */
export function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    // Encode as UTF-8 so the hash is independent of how the engine stores strings.
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    const bytes: number[] =
      c < 0x80
        ? [c]
        : c < 0x800
          ? [0xc0 | (c >> 6), 0x80 | (c & 63)]
          : c < 0x10000
            ? [0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)]
            : [0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)];
    for (const b of bytes) {
      h ^= b;
      h = Math.imul(h, 0x01000193);
    }
  }
  return h >>> 0;
}

export function hex32(n: number): string {
  return (n >>> 0).toString(16).padStart(8, '0');
}

/** The tuning data a mode depends on (exported for tests / diagnostics). */
export function fingerprintData(mode: OnlineMode): unknown {
  if (mode === 'championsLeague') return { movesets: MOVESETS, stages: STAGES, phys: PHYS };
  return { animals: ANIMALS, balance: { ...balance }, traps: { ...traps }, arena: { ...arena } };
}

const cache = new Map<OnlineMode, string>();

/** Fingerprint of `mode`'s data + `APP_VERSION` + protocol, as 8 lower-case hex digits. Cached per mode. */
export function computeFingerprint(mode: OnlineMode): string {
  const hit = cache.get(mode);
  if (hit !== undefined) return hit;
  const text = stableStringify({ mode, protocol: ONLINE_PROTOCOL_VERSION, app: APP_VERSION, data: fingerprintData(mode) });
  const fp = hex32(fnv1a32(text));
  cache.set(mode, fp);
  return fp;
}

/** This build's versions as exchanged in the handshake. */
export function localVersions(): RoomVersions {
  return {
    protocol: ONLINE_PROTOCOL_VERSION,
    appVersion: APP_VERSION,
    fingerprints: {
      battleRoyale: computeFingerprint('battleRoyale'),
      championsLeague: computeFingerprint('championsLeague'),
    },
  };
}

/** Fields that differ between two builds (`protocol`, `appVersion`, `fingerprint:<mode>`); empty = compatible. */
export function diffVersions(a: RoomVersions, b: RoomVersions): string[] {
  const out: string[] = [];
  if (a.protocol !== b.protocol) out.push('protocol');
  if (a.appVersion !== b.appVersion) out.push('appVersion');
  for (const m of ['battleRoyale', 'championsLeague'] as const) {
    if (a.fingerprints[m] !== b.fingerprints[m]) out.push(`fingerprint:${m}`);
  }
  return out;
}
