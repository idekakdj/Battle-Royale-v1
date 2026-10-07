/**
 * Loopback harness for the Battle Royale host/client netcode (WP-N3 tests, reusable by QA): a real `World` + `BotManager` on the
 * "host", one or two `BrNetClient`s on a `LoopbackNetwork` with a manual clock, scripted remote players, and full ground truth
 * so tests can measure what a client actually renders against what the host really simulated.
 */

import { World } from '../../src/sim/World';
import { EventBus } from '../../src/core/EventBus';
import { BotManager } from '../../src/ai/BotManager';
import { LinkChannel } from '../../src/online/channel';
import { LoopbackNetwork, type NetConditions } from '../../src/online/transport/loopback';
import { BrNetHost, type BrNetHostOptions } from '../../src/online/br/BrNetHost';
import { BrNetClient, type BrNetClientOptions, type BrSample } from '../../src/online/br/BrNetClient';
import type { Link, OnlineSlotInfo, OnlineStart, Transport } from '../../src/online/types';
import { ANIMAL_IDS } from '../../src/config/animals';
import type { AnimalId, ArenaId, FighterIntent, GameEvent, WorldSnapshot } from '../../src/core/types';
import { DT, neutral, rng } from './brTestUtil';

export const TICK_MS = 1000 / 60;

export interface Machine {
  transport: Transport;
  channel: LinkChannel;
  id: string;
}

export async function makeMachine(net: LoopbackNetwork, id: string): Promise<Machine> {
  const transport = net.createTransport();
  await transport.open(id);
  const channel = new LinkChannel(id);
  transport.setHandlers({
    onLink: (l: Link) => channel.addLink(l),
    onData: (l, c, d) => channel.handleData(l, c, d),
    onClose: (l, r) => channel.handleClose(l, r),
  });
  return { transport, channel, id };
}

export interface SessionOptions {
  net?: Partial<NetConditions>;
  netSeed?: number;
  clients?: number; // remote humans (1..4)
  seed?: number;
  seconds?: number; // of wall/sim time to run (including the 3 s countdown)
  /** v1.8: the arena the host World / bots play on (default: the colosseum). */
  arena?: ArenaId;
  snapshotHz?: number;
  hostOpts?: Partial<BrNetHostOptions>;
  clientOpts?: Partial<BrNetClientOptions>;
  /** Called every sim tick with the truth, returns the intent for remote client `c` (0-based). */
  script?: (c: number, tick: number, truth: WorldSnapshot, slot: number, r: () => number) => FighterIntent;
  /** Called once after the machines exist, before the host/clients are built (e.g. to wrap channel.send). */
  tamper?: (hostChannel: LinkChannel, clientChannels: LinkChannel[]) => void;
  /** Called after every tick (host side) for custom injections. */
  onTick?: (tick: number, s: Session) => void;
}

export interface FrameRecord {
  tick: number;
  sample: BrSample;
}

export interface Session {
  net: LoopbackNetwork;
  world: World;
  bus: EventBus;
  host: BrNetHost;
  hostMachine: Machine;
  clients: BrNetClient[];
  clientMachines: Machine[];
  start: OnlineStart;
  /** Ground truth, one entry per sim tick. */
  truth: WorldSnapshot[];
  /** Events emitted in each tick. */
  truthEvents: GameEvent[][];
  /** For client 0: every rendered frame. */
  frames: FrameRecord[][];
  /** Events released to each client, with the render time of release. */
  released: Array<Array<{ ev: GameEvent; renderTimeS: number }>>;
  /** Client stats captured once per second of sim time. */
  statsLog: Array<ReturnType<BrNetClient['stats']>[]>;
  /** Presses (rising edges) each scripted client generated. */
  pressed: Array<{ attack: number; special: number; ultimate: number }>;
  slots: number[];
}

/** A chasing, mashing "player": runs at the nearest enemy, attacks in range, blocks / specials / ults now and then. */
export function chaserScript(c: number, tick: number, truth: WorldSnapshot, slot: number, r: () => number): FighterIntent {
  const me = truth.fighters[slot];
  const out = neutral();
  if (!me.alive) return out;
  let best = -1;
  let bd = Infinity;
  for (const f of truth.fighters) {
    if (f.id === slot || !f.alive) continue;
    const d = Math.hypot(f.pos.x - me.pos.x, f.pos.z - me.pos.z);
    if (d < bd) {
      bd = d;
      best = f.id;
    }
  }
  if (best < 0) return out;
  const t = truth.fighters[best];
  const dx = t.pos.x - me.pos.x;
  const dz = t.pos.z - me.pos.z;
  const len = Math.max(1e-6, Math.hypot(dx, dz));
  out.moveX = dx / len;
  out.moveZ = dz / len;
  out.aimYaw = Math.atan2(dx, dz);
  if (bd < 3.2) out.attack = (tick + c * 7) % 11 < 2 || r() < 0.2;
  out.block = bd < 6 && r() < 0.08;
  out.special = r() < 0.02;
  out.ultimate = r() < 0.01;
  out.jump = r() < 0.01;
  return out;
}

export async function runSession(opts: SessionOptions = {}): Promise<Session> {
  const nClients = opts.clients ?? 1;
  const seed = opts.seed ?? 4242;
  const net = new LoopbackNetwork(opts.net ?? {}, opts.netSeed ?? 1);
  const hostMachine = await makeMachine(net, 'host');
  const clientMachines: Machine[] = [];
  for (let i = 0; i < nClients; i++) {
    const m = await makeMachine(net, `c${i + 1}`);
    clientMachines.push(m);
    const link = await hostMachine.transport.connect(m.id);
    hostMachine.channel.addLink(link);
  }
  net.advance(0);
  opts.tamper?.(
    hostMachine.channel,
    clientMachines.map((m) => m.channel),
  );

  const animals = ANIMAL_IDS as AnimalId[];
  const slots: OnlineSlotInfo[] = animals.map((animal, i) => ({
    slot: i,
    peerId: i === 0 ? 'host' : i <= nClients ? `c${i}` : null,
    name: `P${i}`,
    animal,
    kind: i <= nClients ? 'human' : 'bot',
  }));
  const mkStart = (localSlot: number): OnlineStart => ({
    mode: 'battleRoyale',
    seed,
    slots,
    localSlot,
    hostPeerId: 'host',
    br: { difficulty: 4 },
  });

  const bus = new EventBus();
  let tickEvents: GameEvent[] = [];
  bus.onAny((e) => tickEvents.push(e));
  // BotManager only builds brains for roster entries with isPlayer=false, so remote humans are NOT flagged isPlayer: a brain
  // exists for the takeover when a peer leaves (the host overrides its output while host.remoteIntent(slot) is non-null).
  // The host's own slot 0 is bot-driven here so fights stay busy.
  const world = new World({ roster: animals.map((a) => ({ animal: a, isPlayer: false })), difficulty: 4, arena: opts.arena }, seed, bus);
  const bots = new BotManager(bus, 4, seed, world.arena);
  const now = (): number => net.now;
  const host = new BrNetHost({ channel: hostMachine.channel, start: mkStart(0), now, snapshotHz: opts.snapshotHz, ...opts.hostOpts });
  const clients = clientMachines.map(
    (m, i) => new BrNetClient({ channel: m.channel, start: mkStart(i + 1), now, snapshotHz: opts.snapshotHz, ...opts.clientOpts }),
  );

  const session: Session = {
    net,
    world,
    bus,
    host,
    hostMachine,
    clients,
    clientMachines,
    start: mkStart(0),
    truth: [],
    truthEvents: [],
    frames: clients.map(() => []),
    released: clients.map(() => []),
    statsLog: clients.map(() => []),
    pressed: clients.map(() => ({ attack: 0, special: 0, ultimate: 0 })),
    slots: clients.map((_, i) => i + 1),
  };

  const scriptRng = rng(seed ^ 0x5eed);
  const script = opts.script ?? chaserScript;
  const prev = clients.map(() => ({ a: false, s: false, u: false }));
  const ticks = Math.ceil(((opts.seconds ?? 63) * 1000) / TICK_MS);
  let lastTruth = world.snapshot();
  for (let tick = 0; tick < ticks; tick++) {
    // Clients: decide + send this tick's intent (they act on what they last rendered; scripts peek at truth for aiming).
    clients.forEach((cl, i) => {
      const intent = script(i, tick, lastTruth, i + 1, scriptRng);
      const p = prev[i];
      if (intent.attack && !p.a) session.pressed[i].attack++;
      if (intent.special && !p.s) session.pressed[i].special++;
      if (intent.ultimate && !p.u) session.pressed[i].ultimate++;
      p.a = intent.attack;
      p.s = intent.special;
      p.u = intent.ultimate;
      cl.sendIntent(intent);
    });

    // Host: bots + remote intents, step, publish.
    bots.update(lastTruth, DT);
    for (let id = 0; id < world.fighters.length; id++) {
      const remote = host.remoteIntent(id);
      world.setIntent(id, remote ?? bots.getIntent(id));
    }
    tickEvents = [];
    world.step(DT);
    lastTruth = world.snapshot();
    session.truth.push(lastTruth);
    session.truthEvents.push(tickEvents);
    host.afterStep(lastTruth, tickEvents);
    opts.onTick?.(tick, session);

    net.advance(TICK_MS);

    // Render: every client samples once per tick (60 fps).
    clients.forEach((cl, i) => {
      const s = cl.sample(net.now);
      if (s === null) return;
      session.frames[i].push({ tick, sample: s });
      for (const ev of s.events) session.released[i].push({ ev, renderTimeS: s.renderTimeS });
      if (tick % 60 === 59) session.statsLog[i].push(cl.stats());
    });
  }
  return session;
}

/** Ground-truth position of fighter `id` at host sim time `t` (seconds), interpolated between 60 Hz ticks; null outside the recording. */
export function truthPose(truth: readonly WorldSnapshot[], id: number, t: number): { x: number; y: number; z: number } | null {
  if (truth.length === 0 || t < truth[0].time || t > truth[truth.length - 1].time) return null;
  let lo = 0;
  let hi = truth.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (truth[mid].time <= t) lo = mid;
    else hi = mid;
  }
  const A = truth[lo].fighters[id].pos;
  const B = truth[hi].fighters[id].pos;
  const span = truth[hi].time - truth[lo].time;
  const k = span > 0 ? Math.min(1, Math.max(0, (t - truth[lo].time) / span)) : 0;
  return { x: A.x + (B.x - A.x) * k, y: A.y + (B.y - A.y) * k, z: A.z + (B.z - A.z) * k };
}

export function pctile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
