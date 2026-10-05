/**
 * Champions League online — GGPO-style rollback session (v1.5, WP-N2; plan §4).
 *
 * One `RollbackSession` runs on every human's machine over a {@link GameChannel} (full mesh, 2–4 humans, no bots). Only
 * INPUTS cross the network; every machine runs the same deterministic `BrawlWorld`:
 *
 *   • Frame f of the sim is computed from the inputs of ALL fighters for frame f. The local player's input is sampled
 *     (quantised, see inputCodec.ts) and assigned to frame `simFrame + inputDelay`; it is broadcast immediately and
 *     redundantly (everything the peer has not acknowledged, ≤ 48 frames) in unreliable `CL_INPUTS` packets.
 *   • Remote inputs that have not arrived yet are PREDICTED (repeat the last known input, edge flags cleared) so the
 *     sim never waits. When the real input arrives and differs from what was simulated, the session rolls back
 *     (`loadState` of the saved state of that frame) and re-simulates up to the present with the corrected inputs.
 *   • The sim may run at most `maxRollback` (8) frames past the last FULLY CONFIRMED frame, then it stalls ("waiting for
 *     player"); `CL_SYNC` carries ping/pong and each peer's frame so the clocks are nudged (≤ ±5 %) to stay level.
 *   • Every `checksumInterval` (30) confirmed frames the 32-bit state checksum is exchanged (`CL_CHECKSUM`); a mismatch
 *     calls `onDesync`. A peer that leaves is forfeited by a host-authored, frame-stamped `CL_CONTROL`, applied at the
 *     same frame on every machine (rolling back if that frame has been simulated already).
 *
 * Frame numbering. `state[f]` is the world when `world.frame === f`, saved BEFORE the controls and inputs of frame f are
 * applied; stepping with them produces `state[f + 1]`. "Frame f's input" is the one applied at `world.frame === f`.
 *
 * Usage (WP-N5):  `const s = new RollbackSession({channel, start, localIntent: (t) => input.poll()})`, then every animation
 * frame `s.update(dt)`, render `s.snapshots()`, feed `s.drainEvents()` to audio / VFX, read `s.stats`.
 */

import { BRAWL_DT } from '../types';
import type { BrawlEvent, BrawlIntent, BrawlMatchConfig, BrawlSnapshot, BrawlDifficulty } from '../types';
import { BrawlWorld } from '../sim/BrawlWorld';
import { checksumOfSaved, createSavedState } from '../sim/stateIO';
import type { BrawlSavedState } from '../sim/stateIO';
import { MSG } from '../../online/types';
import { smoothRtt } from '../../online/room/rtt';
import type { GameChannel, NetEndReason } from '../../online/types';
import { IDLE_PACKED, clearEdges, edgesOf, packIntent, unpackIntent } from './inputCodec';
import type { PackedInput } from './inputCodec';
import {
  CTL_FORFEIT,
  NO_ECHO,
  decodeChecksum,
  decodeControl,
  decodeInputs,
  decodeSync,
  encodeChecksum,
  encodeControl,
  encodeInputs,
  encodeSync,
} from './protocol';
import type { ControlMsg } from './protocol';
import type {
  RollbackDesync,
  RollbackEnd,
  RollbackForfeit,
  RollbackSessionOptions,
  RollbackStats,
  RollbackView,
  RollbackWorld,
} from './types';

const FRAME_MS = 1000 * BRAWL_DT;
/** Per-slot input ring (frames). */
const HIST = 512;
const HM = HIST - 1;
/** Saved-state ring (frames); must exceed the deepest possible rewind (control events). */
const RING = 128;
const RM = RING - 1;
/** Most inputs one packet repeats. */
const MAX_REDUNDANT = 48;
/** Re-send inputs at least this often even when the sim is stalled (ms). */
const KEEPALIVE_MS = 33;
const SYNC_MS = 100;
const NO_FRAME = Number.POSITIVE_INFINITY;
const NEVER = -1;

/** The known inputs of one fighter slot (ring), plus what the sim actually used. */
class InputTrack {
  readonly val = new Int32Array(HIST);
  readonly tag = new Int32Array(HIST).fill(NEVER);
  readonly used = new Int32Array(HIST);
  readonly usedTag = new Int32Array(HIST).fill(NEVER);
  /** Highest f such that frames 0…f are all known (−1 = none). */
  last = -1;
  /** From this frame on the fighter is gone and its inputs are void (forfeit). */
  voidFrom = NO_FRAME;

  has(f: number): boolean {
    return f >= 0 && this.tag[f & HM] === f;
  }

  get(f: number): number {
    return this.val[f & HM];
  }

  set(f: number, v: number): void {
    this.val[f & HM] = v;
    this.tag[f & HM] = f;
    while (this.has(this.last + 1)) this.last++;
  }
}

interface ControlEvent {
  slot: number;
  frame: number;
  seq: number;
}

interface SumRecord {
  checksum: number;
  ctl: number;
}

interface FinalRecord {
  checksum: number;
  winner: number;
}

function eventKey(e: BrawlEvent, frame: number): string {
  switch (e.type) {
    case 'moveStart':
      return `${frame}|ms|${e.fighterId}|${e.moveId}|${e.chain}`;
    case 'hit':
      return `${frame}|hit|${e.attackerId}|${e.targetId}|${e.moveId}`;
    case 'jump':
      return `${frame}|jump|${e.fighterId}|${e.air ? 1 : 0}`;
    case 'land':
      return `${frame}|land|${e.fighterId}`;
    case 'dodge':
      return `${frame}|dodge|${e.fighterId}|${e.kind}`;
    case 'ledgeGrab':
      return `${frame}|ledge|${e.fighterId}`;
    case 'ko':
      return `${frame}|ko|${e.fighterId}`;
    case 'respawn':
      return `${frame}|resp|${e.fighterId}`;
    case 'matchEnd':
      return `${frame}|end`;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export class RollbackSession {
  readonly config: BrawlMatchConfig;
  /** The simulation (read-only use: snapshots, tools). Never step it from outside. */
  readonly world: RollbackWorld;
  readonly localSlot: number;
  readonly hostSlot: number;
  readonly isHost: boolean;
  readonly slotCount: number;

  private readonly o: RollbackSessionOptions;
  private readonly channel: GameChannel;
  private readonly peerIds: string[];
  private readonly slotOfPeer = new Map<string, number>();
  private readonly tracks: InputTrack[] = [];
  private readonly ring: BrawlSavedState[] = [];
  private readonly ringTag = new Int32Array(RING).fill(NEVER);
  private readonly maxRollback: number;
  private readonly interval: number;
  private readonly stallTimeoutMs: number;
  private readonly agreementTimeoutMs: number;
  private readonly adaptive: boolean;
  private readonly scratchIntent: BrawlIntent = unpackIntent(IDLE_PACKED);
  private readonly unsubscribe: Array<() => void> = [];

  // time
  private nowMs = 0;
  private acc = 0;
  private timeScale = 1;
  private smoothAdv = 0;
  private lastSendMs = -1000;
  private lastSyncMs = -1000;

  // local input
  private delay: number;
  private nextLocal: number;
  private pendingEdges: PackedInput = 0;
  private delayVotes = 0;

  // per-peer
  private readonly peerAck: number[];
  private readonly gone: boolean[];
  private readonly rtt: number[];
  private readonly syncFrame: number[];
  private readonly syncAt: number[];
  private readonly syncConfirmed: number[];
  private readonly lastSeqFrom: number[];
  private readonly lastSeqAt: number[];
  private readonly pingSent = new Float64Array(64);
  private readonly pingSeqTag = new Int32Array(64).fill(NEVER);
  private syncSeq = 0;

  // rollback / confirmation
  private rollbackTo = NO_FRAME;
  private confirmedFrame = 0;

  // controls
  private readonly controls: ControlEvent[] = [];
  private ctlSeq = 0;

  // checksums
  private nextCk: number;
  private readonly mySums = new Map<number, SumRecord>();
  private readonly remoteSums: Array<Map<number, SumRecord>> = [];
  private desynced = false;

  // match end
  private finalSent = false;
  private myFinal: FinalRecord | null = null;
  private endFrame = 0;
  private finalDeadline = 0;
  private readonly finals = new Map<number, FinalRecord>();
  private endInfo: RollbackEnd | null = null;
  private pendingMatchEnd: { frame: number; event: BrawlEvent } | null = null;
  private matchEndDelivered = false;

  // events
  private out: BrawlEvent[] = [];
  private readonly delivered = new Map<string, number>();
  private pruneAt = 0;

  // view
  private prevSnap: BrawlSnapshot;
  private curSnap: BrawlSnapshot;
  private alpha = 0;
  private snapDirty = false;
  private lastAdaptFrame = -1;

  // stall tracking
  private stalledNow = false;
  private lastProgressMs = 0;
  private progressSeen = false;
  private blockers: number[] = [];

  // optional recording (tests / tools)
  private readonly rec: boolean;
  private readonly recInputs: PackedInput[][] = [];
  private readonly recSums = new Map<number, number>();

  private readonly st: RollbackStats;

  constructor(opts: RollbackSessionOptions) {
    this.o = opts;
    this.channel = opts.channel;
    const { start } = opts;
    const cl = start.cl;
    if (start.mode !== 'championsLeague' || cl === undefined) throw new Error('RollbackSession: start.mode must be championsLeague with start.cl');
    const slots = start.slots;
    const n = slots.length;
    if (n < 2 || n > 4) throw new Error(`RollbackSession: 2-4 humans required (got ${n})`);
    this.slotCount = n;
    this.localSlot = start.localSlot;
    if (this.localSlot < 0 || this.localSlot >= n) throw new Error('RollbackSession: bad localSlot');
    this.peerIds = [];
    for (let i = 0; i < n; i++) {
      const s = slots[i];
      if (s.kind !== 'human' || s.peerId === null) throw new Error('RollbackSession: online Champions League is humans-only');
      this.peerIds.push(s.peerId);
      this.slotOfPeer.set(s.peerId, i);
    }
    if (this.peerIds[this.localSlot] !== opts.channel.localPeerId) throw new Error('RollbackSession: start.slots[localSlot] is not this channel');
    const hs = this.slotOfPeer.get(start.hostPeerId);
    if (hs === undefined) throw new Error('RollbackSession: host is not a slot');
    this.hostSlot = hs;
    this.isHost = hs === this.localSlot;

    this.config = {
      stage: cl.stage,
      roster: slots.map((s, i) => ({ animal: s.animal, isPlayer: i === this.localSlot })),
      difficulty: clamp(Math.round(cl.botLevel), 1, 4) as BrawlDifficulty,
      stocks: cl.stocks,
      timeLimitS: cl.timeLimitS,
    };
    this.world = (opts.createWorld ?? ((c, s) => new BrawlWorld(c, s)))(this.config, start.seed);

    this.maxRollback = Math.max(1, Math.min(opts.maxRollback ?? 8, 24));
    this.interval = Math.max(1, Math.floor(opts.checksumInterval ?? 30));
    this.stallTimeoutMs = opts.stallTimeoutMs ?? 12000;
    this.agreementTimeoutMs = opts.agreementTimeoutMs ?? 2000;
    this.adaptive = opts.adaptiveDelay ?? true;
    this.rec = opts.record === true;
    this.delay = clamp(Math.round(opts.inputDelay ?? 2), 1, 8);
    this.nextCk = this.interval;

    for (let i = 0; i < n; i++) {
      this.tracks.push(new InputTrack());
      this.remoteSums.push(new Map());
      if (this.rec) this.recInputs.push([]);
    }
    for (let i = 0; i < RING; i++) this.ring.push(createSavedState(512));
    this.peerAck = new Array<number>(n).fill(0);
    this.gone = new Array<boolean>(n).fill(false);
    this.rtt = new Array<number>(n).fill(0);
    this.syncFrame = new Array<number>(n).fill(NEVER);
    this.syncAt = new Array<number>(n).fill(0);
    this.syncConfirmed = new Array<number>(n).fill(0);
    this.lastSeqFrom = new Array<number>(n).fill(NO_ECHO);
    this.lastSeqAt = new Array<number>(n).fill(0);

    // Frames before the first real input are idle everywhere (the local player's own, by construction).
    const me = this.tracks[this.localSlot];
    for (let f = 0; f < this.delay; f++) me.set(f, IDLE_PACKED);
    this.nextLocal = this.delay;

    this.curSnap = this.world.snapshot();
    this.prevSnap = this.curSnap;

    this.st = {
      rollbacks: 0,
      maxRollbackDepth: 0,
      resimulatedFrames: 0,
      stalls: 0,
      stalledFrames: 0,
      pingMs: 0,
      pingBySlot: new Array<number>(n).fill(0),
      remoteAdvantage: 0,
      inputDelay: this.delay,
      simFrame: 0,
      confirmedFrame: 0,
      timeScale: 1,
      packetsSent: 0,
      packetsReceived: 0,
      bytesSent: 0,
      checksumsCompared: 0,
    };

    this.unsubscribe.push(opts.channel.onMessage((peer, kind, payload) => this.onMessage(peer, kind, payload)));
    this.unsubscribe.push(opts.channel.onPeerLeft((peer, reason) => this.onPeerLeft(peer, reason)));
  }

  // ── public API ─────────────────────────────────────────────────────────────

  /** Current simulated (possibly still speculative) frame. */
  get frame(): number {
    return this.world.frame;
  }

  /** Every input of every fighter is known for all frames below this one. */
  get confirmed(): number {
    return this.confirmedFrame;
  }

  /** True while the sim cannot advance because it is `maxRollback` frames past the confirmed frame. */
  get stalled(): boolean {
    return this.stalledNow;
  }

  /** Fighter slots whose missing inputs are holding the confirmation back (while stalled). */
  get waitingFor(): readonly number[] {
    return this.blockers;
  }

  get ended(): boolean {
    return this.endInfo !== null;
  }

  get result(): RollbackEnd | null {
    return this.endInfo;
  }

  get inputDelay(): number {
    return this.delay;
  }

  /** True once a state-checksum mismatch has been detected. */
  get isDesynced(): boolean {
    return this.desynced;
  }

  /** True when `slot` has been removed from the match (a peer that left). */
  isForfeited(slot: number): boolean {
    return this.tracks[slot].voidFrom !== NO_FRAME;
  }

  get stats(): RollbackStats {
    const s = this.st;
    s.simFrame = this.world.frame;
    s.confirmedFrame = this.confirmedFrame;
    s.inputDelay = this.delay;
    s.timeScale = this.timeScale;
    s.remoteAdvantage = this.smoothAdv;
    let max = 0;
    for (let i = 0; i < this.slotCount; i++) {
      s.pingBySlot[i] = i === this.localSlot ? 0 : this.pingOf(i);
      if (s.pingBySlot[i] > max) max = s.pingBySlot[i];
    }
    s.pingMs = max;
    return s;
  }

  /** The two newest sim snapshots and the interpolation factor for the renderer. */
  snapshots(): RollbackView {
    return { prev: this.prevSnap, cur: this.curSnap, alpha: this.alpha };
  }

  /** Events since the last call, each (frame, type, ids) at most once — a rollback never replays a sound / VFX. */
  drainEvents(): BrawlEvent[] {
    const e = this.out;
    this.out = [];
    return e;
  }

  /** Per-slot record of the confirmed inputs (only with `record: true`). */
  recordedInputs(slot: number): readonly PackedInput[] {
    return this.recInputs[slot] ?? [];
  }

  /** Confirmed checksums at multiples of `checksumInterval` (only with `record: true`). */
  recordedChecksums(): ReadonlyMap<number, number> {
    return this.recSums;
  }

  /**
   * Advance the session by `dtSeconds` of wall-clock time: runs as many sim frames as the (peer-synchronised) clock
   * allows, re-simulating first if a corrected input arrived. Call once per animation frame.
   */
  update(dtSeconds: number): void {
    if (this.endInfo !== null) return;
    let dt = Number.isFinite(dtSeconds) ? dtSeconds : 0;
    dt = clamp(dt, 0, 0.25);
    this.nowMs += dt * 1000;

    this.processRollback();
    if (this.endInfo !== null) return;
    this.updateConfirmed();

    this.acc += dt * this.timeScale;
    this.updateClockScale();

    const world = this.world;
    const canStep = Math.max(0, this.maxRollback - (world.frame - this.confirmedFrame));
    const want = Math.floor(this.acc / BRAWL_DT + 1e-9);
    const cap = this.smoothAdv < -6 ? 10 : 4;
    const steps = world.isOver ? 0 : Math.min(want, cap, canStep);

    const stalledNow = !world.isOver && canStep === 0;
    if (stalledNow) {
      if (!this.stalledNow) this.st.stalls++;
      this.st.stalledFrames += want;
      this.acc = Math.min(this.acc, BRAWL_DT);
      this.computeBlockers();
    } else {
      this.blockers = [];
    }
    this.stalledNow = stalledNow;

    let stepped = false;
    if (steps > 0) {
      for (let i = 0; i < steps; i++) {
        if (i === steps - 1) this.prevSnap = world.snapshot();
        this.forwardStep();
        this.acc -= BRAWL_DT;
        stepped = true;
        if (world.isOver) break;
      }
      if (this.acc > cap * BRAWL_DT) this.acc = 2 * BRAWL_DT;
      if (this.acc < 0) this.acc = 0;
    }
    if (stepped) {
      this.curSnap = world.snapshot();
    } else if (this.snapDirty) {
      this.curSnap = world.snapshot();
      this.prevSnap = this.curSnap;
    }
    this.snapDirty = false;
    this.alpha = world.isOver ? 1 : clamp(this.acc / BRAWL_DT, 0, 1);

    this.updateConfirmed();
    this.pumpChecksums();
    if (this.finalSent) this.evaluateFinal();
    else this.checkMatchEnd();
    this.flushMatchEnd();
    this.sendPeriodic();
    this.watchStall();
    this.maybeAdaptDelay();
    this.prune();
  }

  /** Stop listening and release resources. Idempotent. */
  dispose(): void {
    for (const u of this.unsubscribe) u();
    this.unsubscribe.length = 0;
    if (this.endInfo === null) this.endInfo = this.makeEnd('error', false);
  }

  // ── stepping ───────────────────────────────────────────────────────────────

  /** One fresh sim frame at the frontier: sample + send the local input, save the state, step. */
  private forwardStep(): void {
    const world = this.world;
    const s = world.frame;
    this.assignLocal(s);
    const slot = s & RM;
    world.saveState(this.ring[slot]);
    this.ringTag[slot] = s;
    this.broadcastInputs();
    this.stepFrame(s);
  }

  /** Apply the controls + inputs of frame `f` (= `world.frame`) and step once. */
  private stepFrame(f: number): void {
    const world = this.world;
    for (let i = 0; i < this.controls.length; i++) {
      const c = this.controls[i];
      if (c.frame === f) world.forfeit(c.slot);
    }
    for (let p = 0; p < this.slotCount; p++) {
      const t = this.tracks[p];
      let v: number;
      if (f >= t.voidFrom) v = IDLE_PACKED;
      else if (t.has(f)) v = t.get(f);
      else v = this.predict(t, f);
      t.used[f & HM] = v;
      t.usedTag[f & HM] = f;
      world.setIntent(p, unpackIntent(v, this.scratchIntent));
    }
    world.step();
    this.ingestEvents(world.drainEvents(), world.frame);
  }

  /** Repeat the newest known input before `f` with the edge flags cleared. */
  private predict(t: InputTrack, f: number): PackedInput {
    const lo = Math.max(t.last, f - 32, 0);
    for (let g = f - 1; g >= lo; g--) {
      if (t.has(g)) return clearEdges(t.get(g));
    }
    return t.last >= 0 ? clearEdges(t.get(t.last)) : IDLE_PACKED;
  }

  private assignLocal(s: number): void {
    const me = this.tracks[this.localSlot];
    const target = s + this.delay;
    const intent = this.o.localIntent(target);
    let p = packIntent(intent);
    if (this.nextLocal > target) {
      // The delay shrank: this frame already has an input. Keep any press for the next one.
      this.pendingEdges |= edgesOf(p);
      return;
    }
    p |= this.pendingEdges;
    this.pendingEdges = 0;
    // The delay grew: fill the gap with the held state repeated.
    while (this.nextLocal < target) {
      const prev = this.nextLocal > 0 ? me.get(this.nextLocal - 1) : IDLE_PACKED;
      me.set(this.nextLocal, clearEdges(prev));
      this.nextLocal++;
    }
    me.set(target, p);
    this.nextLocal = target + 1;
  }

  // ── rollback ───────────────────────────────────────────────────────────────

  private requestRollback(frame: number): void {
    if (frame < this.rollbackTo) this.rollbackTo = frame;
  }

  private processRollback(): void {
    if (this.rollbackTo === NO_FRAME) return;
    const target = this.rollbackTo;
    this.rollbackTo = NO_FRAME;
    const world = this.world;
    const end = world.frame;
    if (target >= end) return;
    const slot = target & RM;
    if (this.ringTag[slot] !== target || end - target >= RING) {
      this.abort('desync');
      return;
    }
    const depth = end - target;
    this.st.rollbacks++;
    this.st.resimulatedFrames += depth;
    if (depth > this.st.maxRollbackDepth) this.st.maxRollbackDepth = depth;
    world.loadState(this.ring[slot]);
    if (this.pendingMatchEnd !== null && this.pendingMatchEnd.frame > target) this.pendingMatchEnd = null; // regenerated if still true
    for (let f = target; f < end; f++) {
      if (world.isOver) break;
      if (f > target) {
        const s = f & RM;
        world.saveState(this.ring[s]);
        this.ringTag[s] = f;
      }
      this.stepFrame(f);
    }
    this.snapDirty = true;
  }

  // ── confirmation, checksums ────────────────────────────────────────────────

  private computeConfirmed(): number {
    let c = this.world.frame;
    for (let p = 0; p < this.slotCount; p++) {
      const t = this.tracks[p];
      if (t.last >= t.voidFrom - 1) continue;
      const lim = t.last + 1;
      if (lim < c) c = lim;
    }
    return c;
  }

  private updateConfirmed(): void {
    const c = this.computeConfirmed();
    if (c > this.confirmedFrame) {
      this.confirmedFrame = c;
      this.lastProgressMs = this.nowMs;
      this.progressSeen = true;
      if (this.rec) this.recordConfirmed();
    }
  }

  private recordConfirmed(): void {
    for (let p = 0; p < this.slotCount; p++) {
      const t = this.tracks[p];
      const list = this.recInputs[p];
      for (let f = list.length; f < this.confirmedFrame; f++) list.push(f >= t.voidFrom ? IDLE_PACKED : t.has(f) ? t.get(f) : IDLE_PACKED);
    }
  }

  private ctlCountBefore(frame: number): number {
    let n = 0;
    for (const c of this.controls) if (c.frame < frame) n++;
    return n;
  }

  private checksumAt(f: number): number | undefined {
    if (f === this.world.frame) return this.world.checksum();
    const s = f & RM;
    if (this.ringTag[s] === f) return checksumOfSaved(this.ring[s]);
    return undefined;
  }

  private pumpChecksums(): void {
    while (this.nextCk <= this.confirmedFrame && this.nextCk <= this.world.frame) {
      const f = this.nextCk;
      this.nextCk += this.interval;
      const sum = this.checksumAt(f);
      if (sum === undefined) continue;
      const ctl = this.ctlCountBefore(f);
      this.mySums.set(f, { checksum: sum, ctl });
      if (this.rec) this.recSums.set(f, sum);
      const payload = encodeChecksum({ frame: f, checksum: sum, ctlCount: ctl, final: false, winner: -1 });
      for (let p = 0; p < this.slotCount; p++) {
        if (p === this.localSlot || this.gone[p]) continue;
        this.send(p, 'reliable', MSG.CL_CHECKSUM, payload);
        this.compareSums(p, f);
      }
    }
  }

  private compareSums(slot: number, frame: number): void {
    const mine = this.mySums.get(frame);
    const theirs = this.remoteSums[slot].get(frame);
    if (mine === undefined || theirs === undefined) return;
    if (mine.ctl !== theirs.ctl) return; // one side has not seen a forfeit that the other has applied: not comparable
    this.st.checksumsCompared++;
    this.remoteSums[slot].delete(frame);
    if (mine.checksum === theirs.checksum) return;
    this.flagDesync({
      frame,
      slot,
      peerId: this.peerIds[slot],
      localChecksum: mine.checksum,
      remoteChecksum: theirs.checksum,
      atMatchEnd: false,
    });
  }

  private flagDesync(info: RollbackDesync): void {
    this.desynced = true;
    this.o.onDesync?.(info);
  }

  // ── match end ──────────────────────────────────────────────────────────────

  private checkMatchEnd(): void {
    const world = this.world;
    if (this.finalSent || !world.isOver || this.confirmedFrame < world.frame) return;
    this.finalSent = true;
    this.endFrame = world.frame;
    const winner = world.snapshot().winnerId;
    this.myFinal = { checksum: world.checksum(), winner };
    this.finalDeadline = this.nowMs + this.agreementTimeoutMs;
    const payload = encodeChecksum({ frame: this.endFrame, checksum: this.myFinal.checksum, ctlCount: this.ctlCountBefore(this.endFrame), final: true, winner });
    for (let p = 0; p < this.slotCount; p++) {
      if (p !== this.localSlot && !this.gone[p]) this.send(p, 'reliable', MSG.CL_CHECKSUM, payload);
    }
    this.evaluateFinal();
  }

  private evaluateFinal(): void {
    if (!this.finalSent || this.endInfo !== null || this.myFinal === null) return;
    let pending = false;
    let agreed = true;
    for (let p = 0; p < this.slotCount; p++) {
      if (p === this.localSlot || this.gone[p] || this.isForfeited(p)) continue;
      const f = this.finals.get(p);
      if (f === undefined) {
        pending = true;
        continue;
      }
      if (f.winner !== this.myFinal.winner || f.checksum !== this.myFinal.checksum) {
        agreed = false;
        this.flagDesync({
          frame: this.endFrame,
          slot: p,
          peerId: this.peerIds[p],
          localChecksum: this.myFinal.checksum,
          remoteChecksum: f.checksum,
          atMatchEnd: true,
        });
        this.finals.delete(p);
      }
    }
    if (pending && this.nowMs < this.finalDeadline) return;
    this.endInfo = this.makeEnd('finished', agreed && !pending);
    this.flushMatchEnd();
    this.o.onEnded?.(this.endInfo);
  }

  private makeEnd(reason: RollbackEnd['reason'], agreed: boolean): RollbackEnd {
    const world = this.world;
    return {
      reason,
      winnerId: this.myFinal !== null ? this.myFinal.winner : world.isOver ? world.snapshot().winnerId : -1,
      frame: world.frame,
      checksum: this.myFinal !== null ? this.myFinal.checksum : world.checksum(),
      agreed,
    };
  }

  private abort(reason: NetEndReason): void {
    if (this.endInfo !== null) return;
    this.endInfo = this.makeEnd(reason, false);
    this.o.onEnded?.(this.endInfo);
  }

  /** The `matchEnd` event is held back until its frame is confirmed (a rollback could still change the winner). */
  private flushMatchEnd(): void {
    const p = this.pendingMatchEnd;
    if (p === null || this.matchEndDelivered) return;
    if (this.confirmedFrame >= p.frame || this.endInfo !== null) {
      this.matchEndDelivered = true;
      this.out.push(p.event);
    }
  }

  // ── events ─────────────────────────────────────────────────────────────────

  private ingestEvents(events: BrawlEvent[], frame: number): void {
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.type === 'matchEnd') {
        if (!this.matchEndDelivered) this.pendingMatchEnd = { frame, event: e };
        continue;
      }
      const key = eventKey(e, frame);
      if (this.delivered.has(key)) continue;
      this.delivered.set(key, frame);
      this.out.push(e);
    }
  }

  private prune(): void {
    if (this.confirmedFrame < this.pruneAt) return;
    this.pruneAt = this.confirmedFrame + 120;
    const cutoff = this.confirmedFrame - 240;
    for (const [k, f] of this.delivered) if (f < cutoff) this.delivered.delete(k);
    for (const m of this.remoteSums) for (const f of m.keys()) if (f < cutoff) m.delete(f);
    for (const f of this.mySums.keys()) if (f < cutoff) this.mySums.delete(f);
  }

  // ── network: sending ───────────────────────────────────────────────────────

  private send(slot: number, ch: 'reliable' | 'unreliable', kind: number, payload: Uint8Array): void {
    this.st.packetsSent++;
    this.st.bytesSent += payload.length + 1;
    this.channel.send(this.peerIds[slot], ch, kind, payload);
  }

  private broadcastInputs(): void {
    for (let p = 0; p < this.slotCount; p++) this.sendInputsTo(p);
    this.lastSendMs = this.nowMs;
  }

  private sendInputsTo(p: number): void {
    if (p === this.localSlot || this.gone[p]) return;
    const me = this.tracks[this.localSlot];
    const newest = this.nextLocal - 1;
    let from = Math.max(this.peerAck[p], newest - MAX_REDUNDANT + 1, 0);
    if (from > newest) from = newest;
    const inputs: PackedInput[] = [];
    for (let f = from; f <= newest; f++) inputs.push(me.get(f));
    this.send(p, 'unreliable', MSG.CL_INPUTS, encodeInputs({ frame: this.world.frame, ack: this.tracks[p].last + 1, start: from, inputs }));
  }

  private sendPeriodic(): void {
    if (this.nowMs - this.lastSendMs >= KEEPALIVE_MS) this.broadcastInputs();
    if (this.nowMs - this.lastSyncMs >= SYNC_MS) {
      this.lastSyncMs = this.nowMs;
      const seq = this.syncSeq++ & 0xffff;
      const si = seq & 63;
      this.pingSent[si] = this.nowMs;
      this.pingSeqTag[si] = seq;
      for (let p = 0; p < this.slotCount; p++) {
        if (p === this.localSlot || this.gone[p]) continue;
        const echo = this.lastSeqFrom[p];
        this.send(
          p,
          'unreliable',
          MSG.CL_SYNC,
          encodeSync({
            frame16: Math.floor((this.world.frame + this.acc / BRAWL_DT) * 16),
            confirmed: this.confirmedFrame,
            seq,
            echoSeq: echo,
            holdMs: echo === NO_ECHO ? 0 : this.nowMs - this.lastSeqAt[p],
          }),
        );
      }
    }
  }

  // ── network: receiving ─────────────────────────────────────────────────────

  private onMessage(peerId: string, kind: number, payload: Uint8Array): void {
    if (this.endInfo !== null && kind !== MSG.CL_CHECKSUM) return;
    const slot = this.slotOfPeer.get(peerId);
    if (slot === undefined || slot === this.localSlot) return;
    try {
      switch (kind) {
        case MSG.CL_INPUTS:
          this.onInputs(slot, payload);
          break;
        case MSG.CL_SYNC:
          this.onSync(slot, payload);
          break;
        case MSG.CL_CHECKSUM:
          this.onChecksum(slot, payload);
          break;
        case MSG.CL_CONTROL:
          if (slot === this.hostSlot) this.onControl(decodeControl(payload));
          break;
        default:
          break;
      }
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
    }
  }

  private onInputs(slot: number, payload: Uint8Array): void {
    const m = decodeInputs(payload);
    this.st.packetsReceived++;
    if (m.ack > this.peerAck[slot]) this.peerAck[slot] = Math.min(m.ack, this.nextLocal);
    const t = this.tracks[slot];
    for (let i = 0; i < m.inputs.length; i++) {
      const f = m.start + i;
      if (f >= t.voidFrom || f <= t.last || t.has(f) || f > t.last + 256) continue;
      const v = m.inputs[i];
      t.set(f, v);
      if (t.usedTag[f & HM] === f && t.used[f & HM] !== v && f < this.world.frame) this.requestRollback(f);
    }
  }

  private onSync(slot: number, payload: Uint8Array): void {
    const m = decodeSync(payload);
    this.syncFrame[slot] = m.frame16 / 16;
    this.syncAt[slot] = this.nowMs;
    this.syncConfirmed[slot] = m.confirmed;
    this.lastSeqFrom[slot] = m.seq;
    this.lastSeqAt[slot] = this.nowMs;
    if (m.echoSeq !== NO_ECHO && this.pingSeqTag[m.echoSeq & 63] === m.echoSeq) {
      const sample = this.nowMs - this.pingSent[m.echoSeq & 63] - m.holdMs;
      if (sample >= 0 && sample < 10000) this.rtt[slot] = this.rtt[slot] === 0 ? sample : smoothRtt(this.rtt[slot], sample);
    }
  }

  private onChecksum(slot: number, payload: Uint8Array): void {
    const m = decodeChecksum(payload);
    if (m.final) {
      this.finals.set(slot, { checksum: m.checksum, winner: m.winner });
      this.evaluateFinal();
      return;
    }
    this.remoteSums[slot].set(m.frame, { checksum: m.checksum, ctl: m.ctlCount });
    this.compareSums(slot, m.frame);
  }

  private onControl(m: ControlMsg): void {
    if (m.type !== CTL_FORFEIT || m.slot >= this.slotCount || m.slot === this.hostSlot) return;
    this.applyForfeit(m);
  }

  private onPeerLeft(peerId: string, _reason: string): void {
    const slot = this.slotOfPeer.get(peerId);
    if (slot === undefined || slot === this.localSlot) return;
    this.gone[slot] = true;
    if (this.endInfo !== null) {
      this.evaluateFinal();
      return;
    }
    if (slot === this.hostSlot) {
      this.abort('host-left');
      return;
    }
    if (this.isHost) this.hostForfeit(slot);
    this.evaluateFinal();
  }

  /** Host only: decide the forfeit frame from the inputs we have, tell everyone, apply locally. */
  private hostForfeit(slot: number): void {
    const t = this.tracks[slot];
    if (t.voidFrom !== NO_FRAME) return;
    const frame = t.last + 1;
    const tailStart = Math.max(0, frame - 48);
    const tail: PackedInput[] = [];
    for (let f = tailStart; f < frame; f++) tail.push(t.get(f));
    const msg: ControlMsg = { type: CTL_FORFEIT, seq: ++this.ctlSeq & 0xff, slot, frame, tailStart, tail };
    const payload = encodeControl(msg);
    for (let p = 0; p < this.slotCount; p++) {
      if (p !== this.localSlot && p !== slot && !this.gone[p]) this.send(p, 'reliable', MSG.CL_CONTROL, payload);
    }
    this.applyForfeit(msg);
  }

  private applyForfeit(m: ControlMsg): void {
    const t = this.tracks[m.slot];
    if (t.voidFrom !== NO_FRAME) return;
    for (let i = 0; i < m.tail.length; i++) {
      const f = m.tailStart + i;
      if (f < m.frame && f > t.last && !t.has(f) && f <= t.last + 256) t.set(f, m.tail[i]);
    }
    t.voidFrom = m.frame;
    this.controls.push({ slot: m.slot, frame: m.frame, seq: m.seq });
    if (m.frame < this.world.frame) this.requestRollback(m.frame);
    if (m.frame < this.confirmedFrame) this.confirmedFrame = m.frame;
    // Checksums of states that include the forfeit are stale now.
    for (const f of [...this.mySums.keys()]) if (f > m.frame) this.mySums.delete(f);
    for (const f of [...this.recSums.keys()]) if (f > m.frame) this.recSums.delete(f);
    const firstAbove = (Math.floor(m.frame / this.interval) + 1) * this.interval;
    if (firstAbove < this.nextCk) this.nextCk = firstAbove;
    if (this.rec) for (const list of this.recInputs) if (list.length > this.confirmedFrame) list.length = this.confirmedFrame;
    this.gone[m.slot] = true;
    this.o.onForfeit?.({ slot: m.slot, frame: m.frame } satisfies RollbackForfeit);
  }

  // ── clock sync, ping, adaptive delay ───────────────────────────────────────

  private pingOf(slot: number): number {
    const own = this.rtt[slot];
    if (own > 0) return own;
    return this.channel.rttMs(this.peerIds[slot]);
  }

  private updateClockScale(): void {
    let sum = 0;
    let cnt = 0;
    const local = this.world.frame + this.acc / BRAWL_DT;
    for (let p = 0; p < this.slotCount; p++) {
      if (p === this.localSlot || this.gone[p] || this.syncFrame[p] === NEVER) continue;
      if (this.tracks[p].voidFrom !== NO_FRAME) continue;
      const est = this.syncFrame[p] + (this.nowMs - this.syncAt[p]) / FRAME_MS + this.pingOf(p) / 2 / FRAME_MS;
      sum += local - est;
      cnt++;
    }
    if (cnt === 0) {
      this.timeScale = 1;
      return;
    }
    const adv = sum / cnt;
    this.smoothAdv += (adv - this.smoothAdv) * 0.1;
    this.timeScale = 1 - 0.05 * clamp(this.smoothAdv / 2, -1, 1);
  }

  private maybeAdaptDelay(): void {
    const fr = this.world.frame;
    if (!this.adaptive || fr % 60 !== 0 || fr === 0 || fr === this.lastAdaptFrame) return;
    this.lastAdaptFrame = fr;
    let rtt = 0;
    for (let p = 0; p < this.slotCount; p++) {
      if (p === this.localSlot || this.gone[p]) continue;
      const r = this.rtt[p];
      if (r > rtt) rtt = r;
    }
    if (rtt <= 0) return;
    const target = clamp(Math.ceil(rtt / 50), 1, 4);
    if (target === this.delay) {
      this.delayVotes = 0;
      return;
    }
    this.delayVotes++;
    if (this.delayVotes >= 2) {
      this.delay += target > this.delay ? 1 : -1;
      this.delayVotes = 0;
    }
  }

  // ── stall bookkeeping ──────────────────────────────────────────────────────

  private computeBlockers(): void {
    const out: number[] = [];
    for (let p = 0; p < this.slotCount; p++) {
      const t = this.tracks[p];
      if (p === this.localSlot || t.last >= t.voidFrom - 1) continue;
      if (t.last + 1 <= this.confirmedFrame) out.push(p);
    }
    this.blockers = out;
  }

  private watchStall(): void {
    if (!this.stalledNow) {
      this.lastProgressMs = Math.max(this.lastProgressMs, this.nowMs - 0);
      return;
    }
    const limit = this.progressSeen ? this.stallTimeoutMs : Math.max(this.stallTimeoutMs, 30000);
    if (this.nowMs - this.lastProgressMs > limit) this.abort('timeout');
  }
}
