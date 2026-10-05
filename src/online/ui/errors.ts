/**
 * Online UI (WP-N4) — user-facing text for room errors, room-end reasons and match-end reasons. Pure functions, no DOM:
 * every {@link RoomErrorCode} and every {@link NetEndReason} has a friendly title, explanation and (where useful) a hint.
 */

import type { NetEndReason } from '../types';
import type { OnlineMatchResult } from '../matchTypes';
import type { RoomEndReason, RoomErrorCode, RoomErrorDetails, RoomVersions } from '../room/types';

export interface ErrorText {
  title: string;
  /** One or two plain sentences. */
  message: string;
  /** Optional advice ("check your firewall ..."). */
  hint?: string;
}

/** The slice of `RoomError` the UI reads (so tests and the screens can pass plain objects). */
export interface RoomErrorLike {
  code: RoomErrorCode | string;
  message?: string;
  details?: RoomErrorDetails;
}

const NETWORK_HINT =
  'A firewall, VPN or strict router (NAT) may be blocking the direct connection. Try another network or switch the VPN off. ' +
  'If it keeps failing, a TURN relay server can be configured (localStorage "gk-ice").';

/** Human name of a data-fingerprint mismatch entry such as `fingerprint:championsLeague`. */
function mismatchLabel(entry: string): string {
  if (entry === 'protocol') return 'online protocol';
  if (entry === 'appVersion') return 'game version';
  if (entry.endsWith('championsLeague')) return 'Champions League data';
  if (entry.endsWith('battleRoyale')) return 'Battle Royale data';
  return entry;
}

function versionOf(v: RoomVersions | undefined): string | null {
  return v !== undefined && typeof v.appVersion === 'string' && v.appVersion.length > 0 ? v.appVersion : null;
}

/**
 * "The host runs v1.4.1, you run v1.4.0." (falls back to protocol / data wording when the app versions are equal, or when only
 * the patch differs: the room accepts patch differences, so a mismatch then comes from the protocol or the data).
 */
export function describeVersionMismatch(details: RoomErrorDetails | undefined, fallback?: string): ErrorText {
  const title = 'Different game versions';
  const hint = 'Everyone in a room needs the same version of the game (the same x.y release, e.g. 1.5). Update the game (or reload the web page) and try again.';
  const host = details?.host;
  const local = details?.local;
  const hv = versionOf(host);
  const lv = versionOf(local);
  const appDiffers = details?.mismatch === undefined || details.mismatch.includes('appVersion');
  if (hv !== null && lv !== null && hv !== lv && appDiffers) {
    return { title, message: `The host runs v${hv}, you run v${lv}.`, hint };
  }
  if (host !== undefined && local !== undefined && host.protocol !== local.protocol) {
    return { title, message: `The host runs online protocol ${host.protocol}, you run protocol ${local.protocol}.`, hint };
  }
  const diff = (details?.mismatch ?? []).map(mismatchLabel);
  if (diff.length > 0) {
    const who = hv === null ? '' : lv === null || lv === hv ? ` (both v${hv})` : ` (host v${hv}, you v${lv})`;
    return { title, message: `The game data differs${who}: ${[...new Set(diff)].join(', ')}.`, hint };
  }
  return { title, message: fallback !== undefined && fallback.length > 0 ? fallback : 'The host runs a different version of the game.', hint };
}

/** Friendly text for any {@link RoomErrorCode} (also used for the non-fatal `error` events of an open room). */
export function describeRoomError(err: RoomErrorLike): ErrorText {
  const raw = typeof err.message === 'string' ? err.message : '';
  switch (err.code as RoomErrorCode) {
    case 'bad-code':
      return {
        title: 'That is not a room code',
        message: 'Room codes are 5 letters and digits, like K7P4Q.',
        hint: 'You can also paste the whole invite link.',
      };
    case 'no-such-room':
      return {
        title: 'Room not found',
        message: 'No room with that code is open right now.',
        hint: 'Check the code with the host and make sure the room is still open.',
      };
    case 'signalling-failed':
      return {
        title: 'Cannot reach the matchmaking server',
        message: 'The free matchmaking service did not answer.',
        hint: 'Check your internet connection and try again in a moment. Some school or work networks block it.',
      };
    case 'connect-failed':
      return { title: 'Could not connect to the host', message: 'A direct connection to the host could not be opened.', hint: NETWORK_HINT };
    case 'timeout':
      return {
        title: 'The host did not answer',
        message: 'The connection opened but the host never replied.',
        hint: `Is the room still open? ${NETWORK_HINT}`,
      };
    case 'version-mismatch':
      return describeVersionMismatch(err.details, raw);
    case 'room-full':
      return { title: 'The room is full', message: 'This room already has 4 players.', hint: 'Ask the host to open a new room, or wait for someone to leave.' };
    case 'room-busy':
      return { title: 'A match is starting', message: 'This room is already starting a match.', hint: 'Try again once everybody is back in the room.' };
    case 'kicked':
      return { title: 'You were removed', message: 'The host removed you from the room.' };
    case 'host-left':
      return { title: 'The host left', message: 'The host closed the room.' };
    case 'not-host':
      return { title: 'Only the host can do that', message: 'Ask the host to change the room or start the match.' };
    case 'wrong-phase':
      return { title: 'Not right now', message: raw.length > 0 ? raw : 'The room cannot be changed at the moment.' };
    case 'animal-taken':
      return { title: 'Fighter already taken', message: 'Another player already picked that fighter. Choose a different one.' };
    case 'cannot-start':
      return { title: 'The match cannot start yet', message: raw.length > 0 ? raw : 'Wait until everybody is ready.' };
    case 'mesh-failed':
      return {
        title: 'Players could not connect to each other',
        message: raw.length > 0 ? raw : 'Two of the players could not open a direct connection.',
        hint: `You are back in the room, so you can press Start to try again. ${NETWORK_HINT}`,
      };
    case 'protocol':
      return {
        title: 'Incompatible game data',
        message: 'The host sent something this version of the game does not understand.',
        hint: 'Make sure everybody runs exactly the same version.',
      };
    case 'internal':
      return { title: 'Something went wrong', message: raw.length > 0 ? raw : 'An unexpected error happened.', hint: 'Try again; if it keeps happening, restart the game.' };
    default:
      return { title: 'Something went wrong', message: raw.length > 0 ? raw : 'An unexpected error happened.' };
  }
}

export type AnyEndReason = RoomEndReason | NetEndReason | 'finished';

/** Why the room / match is over, with a title for the panel. `message` (from the room or the match) wins over the default text. */
export function describeEndReason(reason: AnyEndReason, message?: string): ErrorText {
  const m = typeof message === 'string' && message.trim().length > 0 ? message.trim() : '';
  switch (reason) {
    case 'host-left':
      return { title: 'The host left', message: m || 'The host closed the room, so the game is over.' };
    case 'kicked':
      return { title: 'You were removed', message: m || 'The host removed you from the room.' };
    case 'left':
      return { title: 'You left the room', message: m || 'You left the room.' };
    case 'timeout':
      return {
        title: 'Connection lost',
        message: m || 'The connection timed out.',
        hint: 'Check your internet connection; if it happens often, a firewall or VPN may be interfering.',
      };
    case 'peer-left':
      return { title: 'A player left', message: m || 'Another player left the match.' };
    case 'desync':
      return {
        title: 'The game went out of sync',
        message: m || 'The players’ games disagreed about what happened, so the match was stopped.',
        hint: 'Start the match again. If it repeats, make sure everybody runs the same version.',
      };
    case 'version-mismatch':
      return { title: 'Different game versions', message: m || 'The players run different versions of the game.', hint: 'Everybody needs the same version.' };
    case 'error':
      return { title: 'Something went wrong', message: m || 'The match stopped because of an error.' };
    case 'finished':
      return { title: 'Match finished', message: m || 'The match is over.' };
    default:
      return { title: 'The room closed', message: m || 'The room is closed.' };
  }
}

/** One-line toast shown in the room after a match: null when it ended normally. */
export function describeMatchResult(result: OnlineMatchResult): string | null {
  if (result.reason === 'finished') return null;
  const t = describeEndReason(result.reason, result.message);
  return result.message !== undefined && result.message.trim().length > 0 ? t.message : `${t.title}. ${t.message}`;
}
