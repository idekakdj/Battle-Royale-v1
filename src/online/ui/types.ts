/**
 * Online UI (WP-N4) — the narrow views of the room layer the screens depend on. Tests pass fakes that satisfy these.
 */

import type { OnlineRoom } from '../room/OnlineRoom';
import type { HostOptions, JoinOptions } from '../room/types';

/** What the Room screen and the flow need from an `OnlineRoom`. */
export type RoomLike = Pick<
  OnlineRoom,
  'state' | 'on' | 'setName' | 'pickAnimal' | 'setReady' | 'leave' | 'backToRoom' | 'setMode' | 'setSettings' | 'addBot' | 'removeBot' | 'kick' | 'startMatch'
>;

/** What the Online screen needs to create / join rooms (`OnlineRoom` satisfies it; tests inject fakes). */
export interface RoomFactoryApi {
  host(opts: HostOptions): Promise<RoomLike>;
  join(code: string, opts: JoinOptions): Promise<RoomLike>;
}

/** A banner shown above the forms of the Online screen (e.g. why the previous room ended). */
export interface OnlineNotice {
  kind: 'info' | 'error';
  title: string;
  message: string;
  hint?: string;
}
