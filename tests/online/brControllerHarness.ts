/**
 * Headless harness for the WP-N6 Battle Royale match drivers: a `HostSimDriver` and N `ClientSimDriver`s on a
 * `LoopbackNetwork` with a manual clock, stepped exactly like `MatchController` steps them (client `tick` → host `tick` →
 * network → client `pull` once per frame). No WebGL, no DOM.
 */

import { HostSimDriver } from '../../src/online/br/hostDriver';
import { ClientSimDriver } from '../../src/online/br/clientDriver';
import { LoopbackNetwork, type NetConditions } from '../../src/online/transport/loopback';
import type { OnlineSlotInfo, OnlineStart } from '../../src/online/types';
import { ANIMAL_IDS } from '../../src/config/animals';
import type { AnimalId, Difficulty, FighterIntent, GameEvent, WorldSnapshot } from '../../src/core/types';
import { TICK_MS, chaserScript, makeMachine, type Machine } from './brNetHarness';
import { DT, rng } from './brTestUtil';

export { DT, TICK_MS };

export interface DriverSessionOptions {
  /** Fighters in the roster (humans + bots). Default 4. */
  fighters?: number;
  /** Real slots of the humans; the FIRST entry is the host. Default [0, 1, 2]. */
  humanSlots?: number[];
  net?: Partial<NetConditions>;
  netSeed?: number;
  seed?: number;
  difficulty?: Difficulty;
  gateTimeoutS?: number;
  /** Per-client intent script (default: a chasing, mashing player). Return null to send nothing special (neutral). */
  script?: (who: number, tick: number, truth: WorldSnapshot, slot: number, r: () => number) => FighterIntent;
  /** If true the clients do not tick at all until `startClients()` (gate tests). */
  holdClients?: boolean;
}

export interface ClientSide {
  driver: ClientSimDriver;
  machine: Machine;
  slot: number;
  name: string;
  /** Events the controller would emit on the bus (after the id swap), in order. */
  events: GameEvent[];
  views: WorldSnapshot[];
  active: boolean;
}

export interface DriverSession {
  net: LoopbackNetwork;
  start: OnlineStart;
  hostMachine: Machine;
  host: HostSimDriver;
  hostEvents: GameEvent[];
  clients: ClientSide[];
  tick: number;
  step(): void;
  run(ticks: number, until?: () => boolean): void;
  startClients(): void;
  /** Runs until the host's sim says the match is over (or `maxTicks`), then a little longer so the final messages land. */
  runToEnd(maxTicks?: number): void;
}

export const NAMES = ['Hosty', 'Ann', 'Bob', 'Cy'];

export function makeStart(opts: DriverSessionOptions, localSlot: number, peerOf: (slot: number) => string | null, names: string[]): OnlineStart {
  const n = opts.fighters ?? 4;
  const humans = opts.humanSlots ?? [0, 1, 2];
  const slots: OnlineSlotInfo[] = [];
  for (let i = 0; i < n; i++) {
    const hi = humans.indexOf(i);
    slots.push({
      slot: i,
      peerId: hi >= 0 ? peerOf(i) : null,
      name: hi >= 0 ? names[hi] : (ANIMAL_IDS as AnimalId[])[i],
      animal: (ANIMAL_IDS as AnimalId[])[i],
      kind: hi >= 0 ? 'human' : 'bot',
    });
  }
  return { mode: 'battleRoyale', seed: opts.seed ?? 4242, slots, localSlot, hostPeerId: 'host', br: { difficulty: opts.difficulty ?? 4 } };
}

export async function makeDriverSession(opts: DriverSessionOptions = {}): Promise<DriverSession> {
  const humans = opts.humanSlots ?? [0, 1, 2];
  const net = new LoopbackNetwork(opts.net ?? {}, opts.netSeed ?? 1);
  const now = (): number => net.now;
  const peerOf = (slot: number): string => {
    const i = humans.indexOf(slot);
    return i === 0 ? 'host' : `c${i}`;
  };
  const hostMachine = await makeMachine(net, 'host');
  const clientMachines: Machine[] = [];
  for (let i = 1; i < humans.length; i++) {
    const m = await makeMachine(net, `c${i}`);
    clientMachines.push(m);
    const link = await hostMachine.transport.connect(m.id);
    hostMachine.channel.addLink(link);
  }
  net.advance(0);

  const startFor = (slot: number): OnlineStart => makeStart(opts, slot, peerOf, NAMES);
  const host = new HostSimDriver({ start: startFor(humans[0]), channel: hostMachine.channel, now, gateTimeoutS: opts.gateTimeoutS });
  const hostEvents: GameEvent[] = [];
  host.bus.onAny((e) => hostEvents.push(e));
  const clients: ClientSide[] = clientMachines.map((m, i) => {
    const slot = humans[i + 1];
    const driver = new ClientSimDriver({ start: startFor(slot), channel: m.channel, now });
    return { driver, machine: m, slot, name: NAMES[i + 1], events: [], views: [], active: !opts.holdClients };
  });

  const script = opts.script ?? chaserScript;
  const r = rng((opts.seed ?? 4242) ^ 0x5eed);
  const sess: DriverSession = {
    net,
    start: startFor(humans[0]),
    hostMachine,
    host,
    hostEvents,
    clients,
    tick: 0,
    step(): void {
      const truth = host.simSnapshot();
      clients.forEach((c, i) => {
        if (!c.active) return;
        // Clients decide on what they last rendered; the script peeks at the (real-slot) truth for aiming, like brNetHarness.
        c.driver.tick(DT, script(i + 1, sess.tick, truth, c.slot, r));
      });
      // Host's own seat: the same kind of player (null intent when dead, like the controller).
      const me = truth.fighters[humans[0]];
      host.tick(DT, me.alive ? script(0, sess.tick, truth, humans[0], r) : null);
      net.advance(TICK_MS);
      for (const c of clients) {
        if (!c.active) continue;
        const pulled = c.driver.pull();
        if (pulled === null) continue;
        c.views.push(pulled.snapshot);
        for (const e of pulled.events) {
          c.events.push(e);
          c.driver.bus.emit(e);
        }
      }
      sess.tick++;
    },
    run(ticks: number, until?: () => boolean): void {
      for (let i = 0; i < ticks; i++) {
        sess.step();
        if (until?.() === true) return;
      }
    },
    startClients(): void {
      for (const c of clients) c.active = true;
    },
    runToEnd(maxTicks = 30000): void {
      sess.run(maxTicks, () => host.simSnapshot().matchOver);
      sess.run(240); // final snapshot repeats, results, render delay
    },
  };
  return sess;
}

export function disposeSession(s: DriverSession): void {
  s.host.dispose();
  for (const c of s.clients) c.driver.dispose();
}
