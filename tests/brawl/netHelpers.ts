/**
 * Shared helpers for the Champions League rollback tests: scripted random inputs, an N-peer mesh over the manual-clock
 * `LoopbackNetwork`, and a real-time-style driver that updates every session at ~60 Hz (with per-peer clock drift and
 * jitter) while the network clock advances 1 ms at a time.
 */

import { LoopbackNetwork } from '../../src/online/transport/loopback';
import type { NetConditions } from '../../src/online/transport/loopback';
import { LinkChannel } from '../../src/online/channel';
import type { Link, OnlineStart, Transport } from '../../src/online/types';
import { RollbackSession } from '../../src/brawl/net/RollbackSession';
import type { RollbackSessionOptions } from '../../src/brawl/net/types';
import { packIntent, quantizeIntent, unpackIntent } from '../../src/brawl/net/inputCodec';
import type { PackedInput } from '../../src/brawl/net/inputCodec';
import { BrawlWorld } from '../../src/brawl/sim/BrawlWorld';
import type { BrawlDataSource } from '../../src/brawl/sim/dataSource';
import type { BrawlIntent, BrawlMatchConfig, StageId } from '../../src/brawl/types';
import type { AnimalId } from '../../src/core/types';

export const ANIMALS: AnimalId[] = ['lion', 'gorilla', 'crocodile', 'eagle'];

function mix(a: number, b: number, c: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35) ^ Math.imul(c + 0x165667b1, 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

/**
 * A pure scripted "player": holds a direction for 12-frame segments (biased to run around), presses jump / light / heavy /
 * dodge at pseudo-random frames. Fully determined by (seed, slot, frame).
 */
export function scriptIntent(seed: number, slot: number, frame: number): BrawlIntent {
  const seg = mix(seed, slot, frame >> 3);
  const dirs = [-1, -1, -0.5, 0, 0.5, 1, 1, 0.75];
  const moveX = dirs[seg & 7];
  const yv = (seg >>> 3) & 15;
  const moveY = yv === 0 ? -1 : yv === 1 ? 1 : yv === 2 ? -0.5 : 0;
  const r = mix(seed ^ 0x1234, slot, frame);
  const jump = (r & 31) === 0;
  const jumpHeld = jump || (mix(seed ^ 0x77, slot, frame >> 2) & 3) === 0;
  const light = ((r >>> 5) & 15) === 0;
  const heavy = ((r >>> 9) & 31) === 0;
  const dodge = ((r >>> 14) & 63) === 0;
  return { moveX: moveX + 0.01, moveY, jump, jumpHeld, light, heavy, dodge };
}

/**
 * v1.6: a pure scripted "demolition crew": every 24 frames (staggered per slot) each fighter swings a mostly DOWNWARD attack while sweeping
 * across the stage and jumping now and then — on the Crumbling Amphitheatre this breaks the pieces (and, for suitable seeds, flips the
 * stage to its final form) within a couple of thousand frames. Fully determined by (seed, slot, frame).
 */
export function hammerIntent(seed: number, slot: number, frame: number): BrawlIntent {
  const seg = mix(seed, slot, frame >> 4);
  const dirs = [-1, -0.5, 0.5, 1, 0.75, -0.75, 0, 1];
  const r = mix(seed ^ 0x55, slot, frame);
  const phase = (frame + slot * 7) % 24;
  const attack = phase === 0;
  const lowMove = (r & 3) !== 0;
  const heavy = attack && ((r >>> 4) & 3) === 0;
  const jumpTick = (mix(seed ^ 0x99, slot, frame >> 5) & 3) === 0 && phase < 2;
  return {
    moveX: dirs[seg & 7] + 0.01,
    moveY: attack && lowMove ? -1 : ((r >>> 8) & 7) === 0 ? 1 : 0,
    jump: jumpTick || ((r >>> 12) & 31) === 0,
    jumpHeld: true,
    light: attack && !heavy,
    heavy,
    dodge: ((r >>> 20) & 63) === 0,
  };
}

export interface Rules {
  stocks: number;
  timeLimitS: number;
}
const DEFAULT_RULES: Rules = { stocks: 20, timeLimitS: 0 };

export function makeConfig(n: number, stage: StageId = 'brokenColosseum', rules: Rules = DEFAULT_RULES): BrawlMatchConfig {
  return {
    stage,
    roster: Array.from({ length: n }, (_, i) => ({ animal: ANIMALS[i % ANIMALS.length], isPlayer: false })),
    difficulty: 4,
    stocks: rules.stocks,
    timeLimitS: rules.timeLimitS,
  };
}

export function makeStart(n: number, localSlot: number, seed: number, stage: StageId = 'brokenColosseum', rules: Rules = DEFAULT_RULES): OnlineStart {
  return {
    mode: 'championsLeague',
    seed,
    slots: Array.from({ length: n }, (_, i) => ({ slot: i, peerId: `p${i}`, name: `P${i}`, animal: ANIMALS[i % ANIMALS.length], kind: 'human' as const })),
    localSlot,
    hostPeerId: 'p0',
    cl: { stage, stocks: rules.stocks, timeLimitS: rules.timeLimitS, botLevel: 4 },
  };
}

/** The reference ("true input log") simulation: a single world fed the inputs the players really pressed. */
export function runReference(
  config: BrawlMatchConfig,
  seed: number,
  frames: number,
  truth: (slot: number, frame: number) => PackedInput,
  checkpoints: ReadonlySet<number>,
  forfeits: ReadonlyArray<{ slot: number; frame: number }> = [],
  source?: BrawlDataSource,
): Map<number, number> {
  const w = new BrawlWorld(config, seed, source);
  const sums = new Map<number, number>();
  const intent = quantizeIntent({ moveX: 0, moveY: 0, jump: false, jumpHeld: false, light: false, heavy: false, dodge: false });
  for (let f = 0; f < frames; f++) {
    if (checkpoints.has(f)) sums.set(f, w.checksum());
    for (const fo of forfeits) if (fo.frame === f) w.forfeit(fo.slot);
    for (let p = 0; p < config.roster.length; p++) w.setIntent(p, unpackIntent(truth(p, f), intent));
    w.step();
    w.drainEvents();
    if (w.isOver) break;
  }
  if (checkpoints.has(w.frame)) sums.set(w.frame, w.checksum());
  return sums;
}

export interface PeerRig {
  slot: number;
  id: string;
  channel: LinkChannel;
  transport: Transport;
  session: RollbackSession;
  nextAt: number;
  lastAt: number;
  period: number;
  /** Local clock rate relative to real time (1.02 = runs 2 % fast): the dt handed to the session is scaled by it. */
  rate: number;
  paused: boolean;
}

export interface MeshOptions {
  n: number;
  cond?: Partial<NetConditions>;
  netSeed?: number;
  seed?: number;
  /** Per-peer clock rate error (fractional, e.g. 0.01 = the peer's clock runs 1 % fast). */
  drift?: number[];
  /** Per-peer start offset (ms). */
  startOffset?: number[];
  session?: (slot: number) => Partial<RollbackSessionOptions>;
  /** Input script (default `scriptIntent(seed, …)`). */
  script?: (slot: number, frame: number) => BrawlIntent;
  stage?: StageId;
  rules?: Rules;
}

export class Mesh {
  readonly net: LoopbackNetwork;
  readonly peers: PeerRig[] = [];
  readonly seed: number;
  readonly script: (slot: number, frame: number) => BrawlIntent;
  readonly events: Array<Array<{ type: string; frame: number }>> = [];

  private constructor(readonly opts: MeshOptions) {
    this.net = new LoopbackNetwork(opts.cond ?? {}, opts.netSeed ?? 7);
    this.seed = opts.seed ?? 1234;
    this.script = opts.script ?? ((slot, frame) => scriptIntent(this.seed, slot, frame));
  }

  static async create(opts: MeshOptions): Promise<Mesh> {
    const m = new Mesh(opts);
    const n = opts.n;
    const transports: Transport[] = [];
    const channels: LinkChannel[] = [];
    for (let i = 0; i < n; i++) {
      const t = m.net.createTransport();
      const id = await t.open(`p${i}`);
      const ch = new LinkChannel(id);
      t.setHandlers({
        onLink: (l: Link) => ch.addLink(l),
        onData: (l, c, d) => ch.handleData(l, c, d),
        onClose: (l, r) => ch.handleClose(l, r),
      });
      transports.push(t);
      channels.push(ch);
    }
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const link = await transports[i].connect(`p${j}`);
        channels[i].addLink(link);
      }
    }
    m.net.advance(Math.max(1, (opts.cond?.latencyMs ?? 0) + (opts.cond?.jitterMs ?? 0) + 1));
    for (let i = 0; i < n; i++) {
      const extra = opts.session?.(i) ?? {};
      const session = new RollbackSession({
        channel: channels[i],
        start: makeStart(n, i, m.seed, opts.stage, opts.rules),
        localIntent: (target) => m.script(i, target),
        ...extra,
      });
      const drift = opts.drift?.[i] ?? 0;
      const period = 1000 / 60;
      const off = opts.startOffset?.[i] ?? 0;
      m.peers.push({ slot: i, id: `p${i}`, channel: channels[i], transport: transports[i], session, nextAt: m.net.now + off, lastAt: m.net.now + off, period, rate: 1 + drift, paused: false });
      m.events.push([]);
    }
    return m;
  }

  /** Advance simulated real time by `ms` (1 ms resolution): the network clock and every peer's update loop. */
  run(ms: number, until?: () => boolean): void {
    for (let t = 0; t < ms; t++) {
      this.net.advance(1);
      for (const p of this.peers) {
        if (p.paused) continue;
        if (this.net.now >= p.nextAt) {
          const dt = Math.max(0, (this.net.now - p.lastAt) / 1000);
          p.lastAt = this.net.now;
          p.nextAt += p.period;
          if (p.nextAt < this.net.now) p.nextAt = this.net.now + p.period;
          p.session.update(dt * p.rate);
          for (const e of p.session.drainEvents()) this.events[p.slot].push({ type: e.type, frame: p.session.frame });
        }
      }
      if (until !== undefined && until()) return;
    }
  }

  /** Run until every (non-ended) session has simulated at least `frames` frames, or give up after `maxMs`. */
  runFrames(frames: number, maxMs = 400000): void {
    this.run(maxMs, () => this.peers.every((p) => p.session.ended || p.session.frame >= frames));
  }

  /** Let in-flight packets land and every session settle (all peers keep updating). */
  settle(ms = 600): void {
    this.run(ms);
  }
}

export function truthFor(delay: number, script: (slot: number, frame: number) => BrawlIntent): (slot: number, frame: number) => PackedInput {
  return (slot, frame) => (frame < delay ? 0 : packIntent(script(slot, frame)));
}

export interface ScriptedRun {
  checksums: Map<number, number>;
  hits: number;
  kos: number;
  moveStarts: number;
  /** v1.6 dynamic stages: counted platform hits, destroyed platforms and the frame the final form began (−1 = never). */
  platHits: number;
  platBreaks: number;
  finalFrame: number;
  frames: number;
  over: boolean;
  winner: number;
}

/** Play a scripted match on a fresh world, recording the checksum at the checkpoint frames. */
export function playScripted(stage: StageId, n: number, seed: number, frames: number, checkpoints: readonly number[]): ScriptedRun {
  const w = new BrawlWorld(makeConfig(n, stage), seed);
  const want = new Set(checkpoints);
  const run: ScriptedRun = { checksums: new Map(), hits: 0, kos: 0, moveStarts: 0, platHits: 0, platBreaks: 0, finalFrame: -1, frames: 0, over: false, winner: -1 };
  const intent = unpackIntent(0);
  for (let f = 0; f < frames; f++) {
    if (want.has(w.frame)) run.checksums.set(w.frame, w.checksum());
    for (let p = 0; p < n; p++) w.setIntent(p, quantizeIntent(scriptIntent(seed, p, f), intent));
    w.step();
    for (const e of w.drainEvents()) {
      if (e.type === 'hit') run.hits++;
      else if (e.type === 'ko') run.kos++;
      else if (e.type === 'moveStart') run.moveStarts++;
      else if (e.type === 'platformHit') run.platHits++;
      else if (e.type === 'platformBreak') run.platBreaks++;
      else if (e.type === 'stageFinal') run.finalFrame = w.frame;
    }
    if (w.isOver) break;
  }
  if (want.has(w.frame)) run.checksums.set(w.frame, w.checksum());
  run.frames = w.frame;
  run.over = w.isOver;
  run.winner = w.snapshot().winnerId;
  return run;
}
