/** Online room layer — public surface (WP-N1). The UI (WP-N4) and the controllers import from here. */

export { OnlineRoom } from './OnlineRoom';
export {
  DEFAULT_ROOM_SETTINGS,
  ROOM_LIMITS,
  RoomError,
  type BrRoomSettings,
  type ClRoomSettings,
  type HostOptions,
  type JoinOptions,
  type RoomErrorCode,
  type RoomErrorDetails,
  type RoomEndReason,
  type RoomEvents,
  type RoomOptions,
  type RoomPhase,
  type RoomRole,
  type RoomSettings,
  type RoomSettingsPatch,
  type RoomSlot,
  type RoomState,
  type RoomVersions,
  type StartBlocker,
} from './types';
export { generateRoomCode, hostPeerId, inviteLink, isValidRoomCode, normalizeRoomCode, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from './roomCode';
export { computeFingerprint, diffVersions, localVersions } from './fingerprint';
export { loopbackClock, realClock, type RoomClock } from './clock';
