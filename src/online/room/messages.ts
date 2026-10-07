/**
 * Room-layer wire messages (WP-N1). Lobby traffic is low-rate reliable JSON under the `MSG.*` kinds of
 * `src/online/types.ts`; the `t` field discriminates within a kind. Everything from the network is untrusted:
 * the `parse*` helpers validate shape and clamp values, returning null for anything malformed.
 *
 *   HELLO       c→h  {t:'hello', protocol, appVersion, fingerprints, name, animal}   join request
 *               c→h  {t:'name', name}                                                 rename
 *               h→c  {t:'reject', reason, message, mismatch?, host, you?}             handshake refused
 *   ROOM_STATE  h→c  {t:'room', …}                                                    full roster/settings snapshot
 *   PICK        c→h  {t:'pick', animal}          h→c {t:'denied', animal, reason}
 *   READY       c→h  {t:'ready', ready}
 *   KICK        h→c  {t:'kick', message}
 *   LEAVE       c→h  {t:'leave'}                 h→c {t:'close', message}
 *   PEER_LIST   h→c  {t:'prepare', start, dial, await}     match is about to start: link up with these peers
 *   START       c→h  {t:'linked'} | {t:'abort', reason, message, peers?}
 *               h→c  {t:'go'}     | {t:'abort', reason, message, peers?}
 *   MATCH_END   h→c  {t:'end'}                    host returned the room to the lobby
 *               c→h  {t:'leaveMatch'}             this client left the match but stays in the room
 *   PING/PONG   both unreliable binary: f64 sender clock (ms), echoed back
 */

import { ANIMAL_IDS } from '../../config/animals';
import { STAGE_IDS, type StageId } from '../../brawl/types';
import type { AnimalId, ArenaId, Difficulty } from '../../core/types';
import { ARENA_IDS } from '../../core/types';
import type { OnlineMode, OnlineSlotInfo, OnlineStart } from '../types';
import { ROOM_LIMITS, type RoomSettings, type RoomVersions } from './types';

export interface WireSlot {
  id: string;
  kind: 'human' | 'bot';
  name: string;
  animal: AnimalId;
  ready: boolean;
  ping: number;
}

export interface RoomMsg {
  t: 'room';
  rev: number;
  code: string;
  host: string;
  phase: 'lobby' | 'starting' | 'inMatch';
  mode: OnlineMode;
  settings: RoomSettings;
  slots: WireSlot[];
  hostVersions: RoomVersions;
  botFill: number;
}

export interface HelloMsg {
  t: 'hello';
  protocol: number;
  appVersion: string;
  fingerprints: Record<OnlineMode, string>;
  name: string;
  animal: AnimalId;
}

export type RejectReason = 'version-mismatch' | 'room-full' | 'room-busy' | 'bad-hello';

export interface RejectMsg {
  t: 'reject';
  reason: RejectReason;
  message: string;
  mismatch?: string[];
  host: RoomVersions;
  you?: RoomVersions;
}

/** `OnlineStart` without the per-machine `localSlot`. */
export type WireStart = Omit<OnlineStart, 'localSlot'>;

export interface PrepareMsg {
  t: 'prepare';
  start: WireStart;
  dial: string[];
  await: string[];
}

export interface AbortMsg {
  t: 'abort';
  reason: 'mesh-failed' | 'timeout' | 'peer-left' | 'cancelled';
  message: string;
  peers?: string[];
}

// ── generic helpers ──────────────────────────────────────────────────────────

export function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown, max = 64): string | null {
  return typeof v === 'string' && v.length <= max ? v : null;
}

export function isAnimal(v: unknown): v is AnimalId {
  return typeof v === 'string' && (ANIMAL_IDS as readonly string[]).includes(v);
}

function isMode(v: unknown): v is OnlineMode {
  return v === 'battleRoyale' || v === 'championsLeague';
}

/** Trim, drop control characters, collapse whitespace, cap the length; `fallback` when nothing is left. */
export function sanitizeName(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f<>]/g, '').replace(/\s+/g, ' ').trim();
  const cut = Array.from(s).slice(0, ROOM_LIMITS.maxNameLength).join('').trim();
  return cut.length > 0 ? cut : fallback;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

export function parseVersions(v: unknown): RoomVersions | null {
  const r = asRecord(v);
  if (r === null) return null;
  const fp = asRecord(r.fingerprints);
  const app = str(r.appVersion, 32);
  if (typeof r.protocol !== 'number' || app === null || fp === null) return null;
  const br = str(fp.battleRoyale, 16);
  const cl = str(fp.championsLeague, 16);
  if (br === null || cl === null) return null;
  return { protocol: r.protocol, appVersion: app, fingerprints: { battleRoyale: br, championsLeague: cl } };
}

/** A wire arena id: one of `ARENA_IDS`, else `fallback` (an unknown map from a newer/older build never crashes a peer). */
function parseArenaId(v: unknown, fallback: ArenaId): ArenaId {
  return typeof v === 'string' && (ARENA_IDS as readonly string[]).includes(v) ? (v as ArenaId) : fallback;
}

export function parseSettings(v: unknown, base: RoomSettings): RoomSettings {
  const r = asRecord(v);
  if (r === null) return base;
  const br = asRecord(r.br);
  const cl = asRecord(r.cl);
  return {
    br: {
      botLevel: clampInt(br?.botLevel, 1, 4, base.br.botLevel) as Difficulty,
      fillBots: typeof br?.fillBots === 'boolean' ? br.fillBots : base.br.fillBots,
      arena: parseArenaId(br?.arena, base.br.arena),
    },
    cl: {
      stage: (STAGE_IDS as readonly unknown[]).includes(cl?.stage) ? (cl?.stage as StageId) : base.cl.stage,
      stocks: clampInt(cl?.stocks, 1, 5, base.cl.stocks),
      timeLimitS: clampInt(cl?.timeLimitS, 0, 3600, base.cl.timeLimitS),
    },
  };
}

// ── message parsers ──────────────────────────────────────────────────────────

export function parseHello(o: Record<string, unknown>): HelloMsg | null {
  const fp = asRecord(o.fingerprints);
  const appVersion = str(o.appVersion, 32);
  if (typeof o.protocol !== 'number' || appVersion === null || fp === null) return null;
  const br = str(fp.battleRoyale, 16);
  const cl = str(fp.championsLeague, 16);
  if (br === null || cl === null) return null;
  return {
    t: 'hello',
    protocol: o.protocol,
    appVersion,
    fingerprints: { battleRoyale: br, championsLeague: cl },
    name: typeof o.name === 'string' ? o.name : '',
    animal: isAnimal(o.animal) ? o.animal : 'lion',
  };
}

export function parseReject(o: Record<string, unknown>): RejectMsg | null {
  const host = parseVersions(o.host);
  const reason = o.reason;
  if (host === null) return null;
  if (reason !== 'version-mismatch' && reason !== 'room-full' && reason !== 'room-busy' && reason !== 'bad-hello') return null;
  const you = parseVersions(o.you) ?? undefined;
  const mismatch = Array.isArray(o.mismatch) ? o.mismatch.filter((x): x is string => typeof x === 'string').slice(0, 8) : undefined;
  return { t: 'reject', reason, message: str(o.message, 300) ?? '', mismatch, host, you };
}

export function parseRoom(o: Record<string, unknown>, base: RoomSettings): RoomMsg | null {
  const hostVersions = parseVersions(o.hostVersions);
  const code = str(o.code, 8);
  const host = str(o.host, 64);
  if (hostVersions === null || code === null || host === null || !isMode(o.mode)) return null;
  if (o.phase !== 'lobby' && o.phase !== 'starting' && o.phase !== 'inMatch') return null;
  if (!Array.isArray(o.slots) || o.slots.length > ROOM_LIMITS.maxFighters) return null;
  const slots: WireSlot[] = [];
  const seenAnimals = new Set<string>();
  for (const raw of o.slots) {
    const s = asRecord(raw);
    if (s === null) return null;
    const id = str(s.id, 64);
    if ((s.kind !== 'human' && s.kind !== 'bot') || id === null || !isAnimal(s.animal)) return null;
    if (seenAnimals.has(s.animal)) return null;
    seenAnimals.add(s.animal);
    slots.push({
      id,
      kind: s.kind,
      name: sanitizeName(s.name, 'Player'),
      animal: s.animal,
      ready: s.ready === true,
      ping: clampInt(s.ping, 0, 9999, 0),
    });
  }
  return {
    t: 'room',
    rev: clampInt(o.rev, 0, 2 ** 31, 0),
    code,
    host,
    phase: o.phase,
    mode: o.mode,
    settings: parseSettings(o.settings, base),
    slots,
    hostVersions,
    botFill: clampInt(o.botFill, 0, ROOM_LIMITS.maxFighters, 0),
  };
}

function parseSlotInfo(raw: unknown, index: number): OnlineSlotInfo | null {
  const s = asRecord(raw);
  if (s === null) return null;
  const peerId = s.peerId === null ? null : str(s.peerId, 64);
  const name = str(s.name, 64);
  if (name === null || !isAnimal(s.animal) || (s.kind !== 'human' && s.kind !== 'bot')) return null;
  if ((s.kind === 'human') === (peerId === null)) return null;
  return { slot: index, peerId, name, animal: s.animal, kind: s.kind };
}

export function parseStart(v: unknown): WireStart | null {
  const o = asRecord(v);
  if (o === null || !isMode(o.mode) || !Array.isArray(o.slots) || o.slots.length < 2 || o.slots.length > ROOM_LIMITS.maxFighters) return null;
  const hostPeerId = str(o.hostPeerId, 64);
  if (hostPeerId === null || typeof o.seed !== 'number' || !Number.isFinite(o.seed)) return null;
  const slots: OnlineSlotInfo[] = [];
  for (let i = 0; i < o.slots.length; i++) {
    const s = parseSlotInfo(o.slots[i], i);
    if (s === null) return null;
    slots.push(s);
  }
  const out: WireStart = { mode: o.mode, seed: o.seed >>> 0, slots, hostPeerId };
  const br = asRecord(o.br);
  if (br !== null) out.br = { difficulty: clampInt(br.difficulty, 1, 4, 2) as Difficulty, arena: parseArenaId(br.arena, 'colosseum') };
  const cl = asRecord(o.cl);
  if (cl !== null) {
    const stage: StageId = (STAGE_IDS as readonly unknown[]).includes(cl.stage) ? (cl.stage as StageId) : 'brokenColosseum';
    out.cl = {
      stage,
      stocks: clampInt(cl.stocks, 1, 5, 3),
      timeLimitS: clampInt(cl.timeLimitS, 0, 3600, 300),
      botLevel: clampInt(cl.botLevel, 1, 4, 2) as Difficulty,
    };
  }
  return out;
}

export function parsePrepare(o: Record<string, unknown>): PrepareMsg | null {
  const start = parseStart(o.start);
  if (start === null || !Array.isArray(o.dial) || !Array.isArray(o.await)) return null;
  const ids = (a: unknown[]): string[] | null => {
    const out: string[] = [];
    for (const x of a) {
      const s = str(x, 64);
      if (s === null) return null;
      out.push(s);
    }
    return out;
  };
  const dial = ids(o.dial);
  const wait = ids(o.await);
  if (dial === null || wait === null || dial.length > 8 || wait.length > 8) return null;
  return { t: 'prepare', start, dial, await: wait };
}

export function parseAbort(o: Record<string, unknown>): AbortMsg | null {
  const reason = o.reason;
  if (reason !== 'mesh-failed' && reason !== 'timeout' && reason !== 'peer-left' && reason !== 'cancelled') return null;
  const peers = Array.isArray(o.peers) ? o.peers.filter((x): x is string => typeof x === 'string').slice(0, 8) : undefined;
  return { t: 'abort', reason, message: str(o.message, 300) ?? '', peers };
}
