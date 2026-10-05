/**
 * Online UI (WP-N4) public surface. This barrel is imported lazily (`await import('./online/ui')` in main.ts), so the
 * online stylesheet and every online module stay out of the offline game's bundle.
 */

import '../../styles/online.css';

export { startOnlineFlow, currentJoinCode, type OnlineFlow, type OnlineFlowOptions } from './flow';
export { OnlineScreen, type OnlineScreenOptions, type OnlineTab } from './OnlineScreen';
export { RoomScreen, type RoomScreenOptions } from './RoomScreen';
export { launchOnlineMatch, loadMatchFactory, prefetchMatchFactory } from './launch';
export { describeRoomError, describeEndReason, describeMatchResult, describeVersionMismatch, type ErrorText } from './errors';
export { buildInviteLink, copyText, parseJoinInput, joinCodeFromSearch } from './helpers';
export { buildRoomView, describeStartBlockers, fighterAvailability } from './viewModel';
