/**
 * Online Battle Royale — roster, names and results conversion (WP-N6). Pure data helpers (no DOM, no three.js) so the drivers
 * and the tests share them.
 *
 * Slot rules (plan §1/§2):
 *  - The sim roster is the room's FIXED slot order (`OnlineStart.slots[i]` = fighter id `i`); the offline bot seating shuffle
 *    is never used online.
 *  - BotManager only builds brains for roster entries with `isPlayer: false`, so remote humans AND bots are flagged
 *    `isPlayer: false` (a brain exists for the takeover when a peer leaves) and only the host's own seat is `isPlayer: true`.
 *  - The match controller assumes the local player is fighter 0, so everything it sees is remapped with the 0 ↔ localSlot
 *    transposition (`controllerNames`, `controllerRoster`, the drivers' snapshot/event swap).
 */

import { ANIMALS } from '../../config/animals';
import type { Difficulty, RosterEntry } from '../../core/types';
import type { MatchResults, ResultsStanding } from '../../ui/Results';
import type { OnlineSlotInfo, OnlineStart } from '../types';
import { swapId, swapList } from './idSwap';
import type { BrResults } from './miscCodec';

/** Longest name shown on a nameplate / feed (the room itself allows 16). */
export const MAX_NAME_CHARS = 16;

/** Slots in fighter-id order (the contract says index = id; sort defensively). */
export function orderedSlots(start: OnlineStart): OnlineSlotInfo[] {
  return [...start.slots].sort((a, b) => a.slot - b.slot);
}

/**
 * The World roster for an online match, in fixed slot order. `playerSlot` = the slot of the machine that owns the World (the
 * host's own seat → `isPlayer: true`); everybody else — remote humans, bots — is `isPlayer: false`. Clients pass `null`.
 */
export function buildNetRoster(start: OnlineStart, playerSlot: number | null): RosterEntry[] {
  return orderedSlots(start).map((s) => ({ animal: s.animal, isPlayer: playerSlot !== null && s.slot === playerSlot }));
}

/** Replaces control characters, zero-width / bidi marks and line separators with a space (names are other players' input). */
function stripUnsafe(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const c = ch.codePointAt(0) as number;
    const bad =
      c < 0x20 || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
    out += bad ? ' ' : ch;
  }
  return out;
}

/** A display name that is safe to show: no control characters, collapsed spaces, trimmed, ≤ {@link MAX_NAME_CHARS}. */
export function cleanName(raw: string, fallback: string): string {
  const flat = stripUnsafe(raw).replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return fallback;
  const chars = Array.from(flat);
  return chars.length > MAX_NAME_CHARS ? chars.slice(0, MAX_NAME_CHARS).join('').trimEnd() : flat;
}

/**
 * Display name per CONTROLLER id (slot `localSlot` shown as fighter 0): humans get their chosen name, bots `null` (the UI then
 * shows the animal name, exactly like offline).
 */
export function controllerNames(start: OnlineStart, localSlot: number): (string | null)[] {
  const bySlot = orderedSlots(start).map((s) => (s.kind === 'human' ? cleanName(s.name, ANIMALS[s.animal].displayName) : null));
  return swapList(bySlot, 0, localSlot);
}

/** The roster in controller id order (local player = id 0). */
export function controllerRoster(roster: readonly RosterEntry[], localSlot: number): RosterEntry[] {
  return swapList(roster, 0, localSlot);
}

/** Display name of a SLOT (not a controller id): the chosen name for humans, the animal's name for bots. */
export function slotLabel(slot: OnlineSlotInfo): string {
  return slot.kind === 'human' ? cleanName(slot.name, ANIMALS[slot.animal].displayName) : ANIMALS[slot.animal].displayName;
}

/** Controller id of a slot (the transposition is its own inverse, so this also maps ids back to slots). */
export function toControllerId(slot: number, localSlot: number): number {
  return swapId(slot, 0, localSlot);
}

/**
 * The host's `BrResults` (slot space) → the existing Results screen's {@link MatchResults} for the local player, plus the
 * room's standings. `fallback` (the controller's own reading of the final snapshot) fills in anything the message lacks.
 */
export function brResultsToMatchResults(
  r: BrResults,
  start: OnlineStart,
  localSlot: number,
  difficulty: Difficulty,
  fallback?: MatchResults,
): MatchResults {
  const slots = orderedSlots(start);
  const me = r.fighters[localSlot];
  const local = slots[localSlot];
  const victory = r.winnerId === localSlot;
  const rawPlace = me?.placement ?? 0;
  const placement = victory ? 1 : rawPlace > 0 ? rawPlace : (fallback?.placement ?? 2);
  const standings: ResultsStanding[] = slots.map((s) => {
    const f = r.fighters[s.slot];
    const place = s.slot === r.winnerId ? 1 : (f?.placement ?? 0);
    return {
      placement: place,
      animal: s.animal,
      name: slotLabel(s),
      kills: f?.kills ?? 0,
      isYou: s.slot === localSlot,
      isBot: s.kind === 'bot',
    };
  });
  return {
    victory,
    placement,
    animal: local?.animal ?? fallback?.animal ?? 'lion',
    kills: me?.kills ?? fallback?.kills ?? 0,
    damageDealt: Math.round(me?.damageDealt ?? fallback?.damageDealt ?? 0),
    damageBlocked: Math.round(me?.damageBlocked ?? fallback?.damageBlocked ?? 0),
    ultsUsed: me?.ultsUsed ?? fallback?.ultsUsed ?? 0,
    matchTimeS: Math.max(0, r.matchTimeS),
    difficulty,
    standings,
  };
}
