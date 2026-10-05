/**
 * Champions League online — the match screen factory the Online UI imports lazily (`src/online/matchTypes.ts`,
 * WP-N5). The controller (and with it the rollback session) is created right here, synchronously, so it is already
 * subscribed to the room's `GameChannel` when the first packets of faster peers arrive.
 */

import type { OnlineMatchFactory } from '../../online/matchTypes';
import { NetBrawlController } from './NetBrawlController';

export const createNetBrawlScreen: OnlineMatchFactory = (opts) => new NetBrawlController(opts);

export { NetBrawlController, NET_BRAWL_BYE } from './NetBrawlController';
export type { NetBrawlControllerOptions, NetBrawlPhase } from './NetBrawlController';
