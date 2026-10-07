/**
 * Online UI (WP-N4) — the room screen's view-model: turns a {@link RoomState} into exactly what the cards, the fighter
 * picker and the Start button need. Pure (no DOM) so the logic is unit-testable with fake states.
 */

import { ANIMALS, ANIMAL_IDS } from '../../config/animals';
import type { AnimalId, ArenaId } from '../../core/types';
import { ARENA_IDS } from '../../core/types';
import { getArena } from '../../config/arenas';
import { STAGES } from '../../brawl/data';
import { STAGE_IDS, type StageId } from '../../brawl/types';
import { stageCards, type StageBadge } from '../../brawl/ui/stageThumb';
import type { OnlineMode } from '../types';
import { ROOM_LIMITS, type RoomSlot, type RoomState, type StartBlocker } from '../room/types';
import { joinNames, pingInfo, type PingInfo } from './helpers';

export const MODE_LABEL: Record<OnlineMode, string> = {
  championsLeague: 'Champions League',
  battleRoyale: 'Battle Royale',
};

export const MODE_BLURB: Record<OnlineMode, string> = {
  championsLeague: 'Platform fighter. 2–4 players, no bots. Knock rivals off the stage.',
  battleRoyale: 'Free-for-all in the colosseum or the jungle. 2–4 players, bots fill the arena up to 10 fighters.',
};

/** The rule line shown under the roster. */
export const MODE_CONSTRAINT: Record<OnlineMode, string> = {
  championsLeague: 'Champions League: 2–4 players, humans only (no bots). Everyone needs a different fighter.',
  battleRoyale: 'Battle Royale: 2–4 players plus bots, up to 10 fighters. Every human needs a different fighter.',
};

/** One card of the Champions League stage picker in the room (every stage of `STAGE_IDS`, in order, with its badges). */
export interface StagePickVM {
  id: StageId;
  name: string;
  selected: boolean;
  badges: StageBadge[];
}

export function stagePickerItems(selected: StageId): StagePickVM[] {
  return stageCards(STAGE_IDS, STAGES).map((c) => ({ id: c.id, name: c.name, selected: c.id === selected, badges: c.badges }));
}

/** One card of the Battle Royale map picker in the room (every arena of `ARENA_IDS`, in order; copy straight from the `ArenaDef`). */
export interface MapPickVM {
  id: ArenaId;
  name: string;
  blurb: string;
  selected: boolean;
}

export function mapPickerItems(selected: ArenaId): MapPickVM[] {
  return ARENA_IDS.map((id) => {
    const a = getArena(id);
    return { id, name: a.name, blurb: a.blurb, selected: id === selected };
  });
}

export interface PlayerCardVM {
  id: string;
  kind: 'human' | 'bot';
  peerId: string | null;
  name: string;
  animal: AnimalId;
  animalName: string;
  accent: string;
  ready: boolean;
  isHost: boolean;
  isLocal: boolean;
  ping: PingInfo;
  /** The host may remove this human (never themself, never a bot, only in the lobby). */
  canKick: boolean;
  /** The host may remove this bot. */
  canRemoveBot: boolean;
}

export interface RosterCounts {
  humans: number;
  bots: number;
  /** Extra bots added automatically when the match starts (Battle Royale `fillBots`). */
  fill: number;
  total: number;
}

export interface FighterAvailability {
  animal: AnimalId;
  /** Picked by ANOTHER human: cannot be chosen. */
  taken: boolean;
  /** Name of the human holding it (when taken). */
  takenBy: string | null;
  /** Held by a host-added bot (a pick swaps the bot to the picker's old fighter, so it stays selectable). */
  heldByBot: boolean;
  /** This machine's current fighter. */
  mine: boolean;
}

export interface RoomVM {
  code: string;
  isHost: boolean;
  mode: OnlineMode;
  modeLabel: string;
  constraint: string;
  humans: PlayerCardVM[];
  bots: PlayerCardVM[];
  /** How many empty human places to draw (up to 4 humans). */
  emptySlots: number;
  counts: RosterCounts;
  local: PlayerCardVM | null;
  fighters: FighterAvailability[];
  /** Start/ready messaging. */
  canStart: boolean;
  blockers: string[];
  /** One line for the status area (host: why Start is disabled; client: what to do / wait for). */
  status: string;
  phase: RoomState['phase'];
  /** Controls are locked while the room is starting / in a match / closed. */
  locked: boolean;
}

function cardOf(slot: RoomSlot, state: RoomState): PlayerCardVM {
  const def = ANIMALS[slot.animal];
  const lobby = state.phase === 'lobby';
  return {
    id: slot.id,
    kind: slot.kind,
    peerId: slot.peerId,
    name: slot.name,
    animal: slot.animal,
    animalName: def.displayName,
    accent: def.accent,
    ready: slot.ready,
    isHost: slot.isHost,
    isLocal: slot.isLocal,
    ping: slot.kind === 'human' && !slot.isHost ? pingInfo(slot.pingMs) : pingInfo(0),
    canKick: state.role === 'host' && lobby && slot.kind === 'human' && !slot.isLocal && !slot.isHost,
    canRemoveBot: state.role === 'host' && lobby && slot.kind === 'bot',
  };
}

/** Which fighters can this machine pick? Humans block each other; a host-added bot just swaps. */
export function fighterAvailability(state: RoomState): FighterAvailability[] {
  const local = state.slots.find((s) => s.isLocal && s.kind === 'human');
  return ANIMAL_IDS.map((animal) => {
    const owner = state.slots.find((s) => s.animal === animal);
    const humanOwner = owner !== undefined && owner.kind === 'human' && !owner.isLocal ? owner : undefined;
    return {
      animal,
      taken: humanOwner !== undefined,
      takenBy: humanOwner?.name ?? null,
      heldByBot: owner !== undefined && owner.kind === 'bot',
      mine: local !== undefined && local.animal === animal,
    };
  });
}

/** Human-readable reasons why Start is unavailable (empty when it is available). Order: players, then readiness. */
export function describeStartBlockers(state: RoomState): string[] {
  const out: string[] = [];
  for (const b of state.startBlockers as readonly StartBlocker[]) {
    switch (b) {
      case 'need-players':
        out.push(`Need at least ${ROOM_LIMITS.minHumans} players`);
        break;
      case 'not-all-ready': {
        const waiting = state.slots.filter((s) => s.kind === 'human' && !s.isHost && !s.ready).map((s) => s.name);
        out.push(waiting.length > 0 ? `Waiting for ${joinNames(waiting)} to ready up` : 'Waiting for everyone to ready up');
        break;
      }
      case 'wrong-phase':
        out.push(state.phase === 'starting' ? 'Starting…' : state.phase === 'inMatch' ? 'A match is in progress' : 'Not available right now');
        break;
      case 'not-host':
        out.push('Only the host can start the match');
        break;
      default:
        break;
    }
  }
  return out;
}

export function rosterCounts(state: RoomState): RosterCounts {
  const humans = state.slots.filter((s) => s.kind === 'human').length;
  const bots = state.slots.filter((s) => s.kind === 'bot').length;
  const fill = state.mode === 'battleRoyale' ? Math.max(0, state.botFill) : 0;
  return { humans, bots, fill, total: humans + bots + fill };
}

/** Status line under the action buttons. */
export function statusLine(state: RoomState): string {
  if (state.phase === 'closed') return 'The room is closed';
  if (state.phase === 'starting') return 'Starting…';
  if (state.phase === 'inMatch') return 'A match is in progress';
  if (state.role === 'host') {
    if (state.canStart) return 'Everyone is ready. Press Start!';
    return describeStartBlockers(state).join('. ');
  }
  const me = state.slots.find((s) => s.isLocal);
  if (me !== undefined && !me.ready) return 'Press Ready when you have picked your fighter';
  const others = state.slots.filter((s) => s.kind === 'human' && !s.isHost && !s.ready && !s.isLocal).map((s) => s.name);
  if (others.length > 0) return `Waiting for ${joinNames(others)} to ready up`;
  return 'Waiting for the host to start';
}

export function buildRoomView(state: RoomState): RoomVM {
  const cards = state.slots.map((s) => cardOf(s, state));
  const humans = cards.filter((c) => c.kind === 'human');
  const bots = cards.filter((c) => c.kind === 'bot');
  const empty = Math.max(0, ROOM_LIMITS.maxHumans - humans.length);
  return {
    code: state.code,
    isHost: state.role === 'host',
    mode: state.mode,
    modeLabel: MODE_LABEL[state.mode],
    constraint: MODE_CONSTRAINT[state.mode],
    humans,
    bots,
    emptySlots: empty,
    counts: rosterCounts(state),
    local: cards.find((c) => c.isLocal) ?? null,
    fighters: fighterAvailability(state),
    canStart: state.canStart,
    blockers: describeStartBlockers(state),
    status: statusLine(state),
    phase: state.phase,
    locked: state.phase !== 'lobby',
  };
}

/** Cheap structural key: when it is unchanged the settings panel does not need rebuilding (keeps keyboard focus stable). */
export function settingsKey(state: RoomState): string {
  const s = state.settings;
  const bots = state.slots.filter((x) => x.kind === 'bot').length;
  return [state.role, state.mode, state.phase === 'lobby' ? 'L' : 'X', s.br.botLevel, s.br.fillBots ? 1 : 0, s.br.arena, s.cl.stage, s.cl.stocks, s.cl.timeLimitS, bots, state.botFill, state.slots.filter((x) => x.kind === 'human').length].join('|');
}
