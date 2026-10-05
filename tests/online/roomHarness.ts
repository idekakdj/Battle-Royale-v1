/**
 * Test rig for the room layer: several `OnlineRoom`s on one `LoopbackNetwork` + its manual clock. Everything async is
 * pumped by advancing simulated time, so tests are deterministic and instant.
 */

import { mulberry32 } from '../../src/core/math';
import type { AnimalId } from '../../src/core/types';
import { loopbackClock } from '../../src/online/room/clock';
import { OnlineRoom } from '../../src/online/room/OnlineRoom';
import type { HostOptions, JoinOptions, RoomEndReason, RoomError, RoomState } from '../../src/online/room/types';
import type { GameChannel, OnlineStart } from '../../src/online/types';
import { LoopbackNetwork, type NetConditions } from '../../src/online/transport/loopback';

export interface RoomPeer {
  name: string;
  room: OnlineRoom;
  states: RoomState[];
  starts: { start: OnlineStart; channel: GameChannel }[];
  ended: { reason: RoomEndReason; message: string }[];
  errors: RoomError[];
  /** Latest state. */
  readonly state: RoomState;
}

async function flush(): Promise<void> {
  // Promise continuations are microtasks: a handful of ticks lets every pending async chain advance.
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

export class Rig {
  readonly net: LoopbackNetwork;
  readonly clock;
  private readonly rng: () => number;

  constructor(cond: Partial<NetConditions> = {}, seed = 7) {
    this.net = new LoopbackNetwork(cond, seed);
    this.clock = loopbackClock(this.net);
    this.rng = mulberry32(seed);
  }

  /** Advance simulated time in small steps, letting promise continuations run in between. */
  async run(ms: number, step = 10): Promise<void> {
    for (let t = 0; t < ms; t += step) {
      this.net.advance(Math.min(step, ms - t));
      await flush();
    }
  }

  /** Pump time until `p` settles (max `maxMs`). */
  async until<T>(p: Promise<T>, maxMs = 30000): Promise<T> {
    let settled = false;
    const wrapped = p.finally(() => {
      settled = true;
    });
    wrapped.catch(() => undefined);
    for (let t = 0; t < maxMs && !settled; t += 10) {
      this.net.advance(10);
      await flush();
    }
    return p;
  }

  /** Pump time until `cond()` is true (max `maxMs`); returns whether it became true. */
  async waitFor(cond: () => boolean, maxMs = 5000): Promise<boolean> {
    for (let t = 0; t < maxMs; t += 10) {
      if (cond()) return true;
      this.net.advance(10);
      await flush();
    }
    return cond();
  }

  private wrap(name: string, room: OnlineRoom): RoomPeer {
    const peer: RoomPeer = {
      name,
      room,
      states: [room.state],
      starts: [],
      ended: [],
      errors: [],
      get state() {
        return room.state;
      },
    };
    room.on('state', (s) => peer.states.push(s));
    room.on('start', (start, channel) => peer.starts.push({ start, channel }));
    room.on('ended', (reason, message) => peer.ended.push({ reason, message }));
    room.on('error', (e) => peer.errors.push(e));
    return peer;
  }

  async host(name: string, animal: AnimalId = 'lion', opts: Partial<HostOptions> = {}): Promise<RoomPeer> {
    const room = await this.until(
      OnlineRoom.host({ transport: this.net.createTransport(), clock: this.clock, rng: this.rng, name, animal, ...opts }),
    );
    return this.wrap(name, room);
  }

  /** Raw join attempt (the promise may reject with a RoomError). */
  joinRoom(code: string, name: string, animal: AnimalId = 'eagle', opts: Partial<JoinOptions> = {}): Promise<OnlineRoom> {
    return this.until(OnlineRoom.join(code, { transport: this.net.createTransport(), clock: this.clock, rng: this.rng, name, animal, ...opts }));
  }

  async join(code: string, name: string, animal: AnimalId = 'eagle', opts: Partial<JoinOptions> = {}): Promise<RoomPeer> {
    return this.wrap(name, await this.joinRoom(code, name, animal, opts));
  }

  /** Host + `n` clients, all joined (not ready). */
  async lobby(n: number, hostOpts: Partial<HostOptions> = {}): Promise<{ host: RoomPeer; clients: RoomPeer[] }> {
    const host = await this.host('Host', 'lion', hostOpts);
    const animals: AnimalId[] = ['eagle', 'gorilla', 'hippo'];
    const clients: RoomPeer[] = [];
    for (let i = 0; i < n; i++) clients.push(await this.join(host.state.code, `P${i + 1}`, animals[i]));
    await this.run(200);
    return { host, clients };
  }

  /** Everybody ready, then start; resolves once every machine fired `start`. */
  async startAll(host: RoomPeer, clients: RoomPeer[]): Promise<void> {
    const before = new Map([host, ...clients].map((p) => [p, p.starts.length]));
    for (const c of clients) c.room.setReady(true);
    await this.waitFor(() => host.state.canStart);
    const blockers = host.room.startMatch();
    if (blockers.length > 0) throw new Error(`cannot start: ${blockers.join(',')}`);
    const ok = await this.waitFor(() => [host, ...clients].every((p) => p.starts.length > (before.get(p) ?? 0)), 20000);
    if (!ok) throw new Error('match did not start');
  }
}
