/**
 * HostSimDriver (WP-N6): the host machine's {@link SimDriver} for an online Battle Royale. It is the offline sim (one `World`
 * + `BotManager`) with the room's FIXED roster, plus a {@link BrNetHost}:
 *
 *   per 60 Hz tick:  local intent → host seat · remote humans' queued intents (`host.remoteIntent`, exactly once per slot) ·
 *                    bots for everything else (a departed player's slot simply falls through to its bot brain) ·
 *                    `world.step` · `host.afterStep(snapshot, events)` (snapshots at 30 Hz, events, final results)
 *
 * The match controller wants the local player at fighter 0; the host normally IS slot 0 (the room puts it there), but when it is
 * not, everything the controller sees (snapshot, events, roster, names) is remapped with the 0 ↔ hostSlot transposition while
 * the World, the bots and the network keep using real slot ids.
 *
 * START GATE. The 3-2-1 countdown only runs once every connected remote human has sent its first intent (i.e. its match screen is
 * up and ticking) — or after `gateTimeoutS` — so nobody loads in half-way through it. While gating, nothing is simulated or
 * broadcast.
 */

import { EventBus } from '../../core/EventBus';
import type { FighterIntent, GameEvent, RosterEntry, WorldSnapshot } from '../../core/types';
import { ANIMALS } from '../../config/animals';
import { World } from '../../sim/World';
import { BotManager } from '../../ai/BotManager';
import type { SimDriver } from '../../match/SimDriver';
import type { GameChannel, OnlineStart } from '../types';
import { BrNetHost, type BrHostClientStats, type BrNetHostOptions } from './BrNetHost';
import { swapEventIds, swapIds } from './idSwap';
import type { BrResults } from './miscCodec';
import { buildNetRoster, controllerNames, controllerRoster, orderedSlots, slotLabel } from './netRoster';

export interface HostDriverOptions {
  start: OnlineStart;
  channel: GameChannel;
  /** Snapshots per second to the clients (20 / 30 / 60). Default 30. */
  snapshotHz?: number;
  /** Monotonic ms clock for the network layer (tests inject the loopback clock). Default `performance.now`. */
  now?: () => number;
  /** Longest wait (seconds of ticks) for the remote humans' match screens before starting anyway. Default 8; 0 = no gate. */
  gateTimeoutS?: number;
  /** Extra BrNetHost options (tests). */
  hostOpts?: Partial<BrNetHostOptions>;
}

export interface PeerLeftInfo {
  /** The real slot (fighter id in the World). */
  slot: number;
  name: string;
  reason: string;
}

export class HostSimDriver implements SimDriver {
  readonly kind = 'host' as const;
  readonly stepsSim = true;
  readonly pausable = false;
  readonly roster: readonly RosterEntry[];
  readonly names: readonly (string | null)[];
  readonly bus: EventBus;
  readonly net: BrNetHost;
  /** This machine's real slot. */
  readonly hostSlot: number;

  private readonly simBus = new EventBus();
  private readonly world: World;
  private readonly bots: BotManager;
  private readonly start: OnlineStart;
  private readonly tickEvents: GameEvent[] = [];
  private readonly leftCbs: Array<(info: PeerLeftInfo) => void> = [];
  private readonly unsubLeft: () => void;
  private simSnap: WorldSnapshot;
  private viewSnap: WorldSnapshot;
  private gateOpen: boolean;
  private waited = 0;
  private readonly gateTimeoutS: number;
  private readonly count: number;

  constructor(opts: HostDriverOptions) {
    const { start, channel } = opts;
    this.start = start;
    this.hostSlot = start.localSlot;
    this.gateTimeoutS = opts.gateTimeoutS ?? 8;
    const slots = orderedSlots(start);
    this.count = slots.length;
    const simRoster = buildNetRoster(start, this.hostSlot);
    this.roster = controllerRoster(simRoster, this.hostSlot);
    this.names = controllerNames(start, this.hostSlot);
    const difficulty = start.br?.difficulty ?? 3;

    // The sim's bus (real slot ids). The controller's bus is the same object unless the host is not slot 0.
    if (this.hostSlot === 0) {
      this.bus = this.simBus;
    } else {
      const outer = new EventBus();
      const me = this.hostSlot;
      this.simBus.onAny((e) => outer.emit(swapEventIds(e, 0, me)));
      this.bus = outer;
    }
    this.world = new World({ roster: simRoster, difficulty }, start.seed, this.simBus);
    // BotManager MUST share the sim bus and exist before the first step.
    this.bots = new BotManager(this.simBus, difficulty, start.seed);
    this.simBus.onAny((e) => this.tickEvents.push(e));
    this.net = new BrNetHost({ channel, start, snapshotHz: opts.snapshotHz, now: opts.now, ...opts.hostOpts });
    this.unsubLeft = this.net.onPeerLeft((slot, reason) => {
      const s = slots[slot];
      const info: PeerLeftInfo = { slot, name: s !== undefined ? slotLabel(s) : `Player ${slot}`, reason };
      for (const cb of [...this.leftCbs]) cb(info);
    });

    this.simSnap = this.world.snapshot();
    this.viewSnap = this.toView(this.simSnap);
    this.gateOpen = this.gateTimeoutS <= 0 || this.waitingFor().length === 0;
  }

  snapshot(): WorldSnapshot {
    return this.viewSnap;
  }

  /** The sim's own snapshot (REAL slot ids, not remapped) — QA / tests. */
  simSnapshot(): WorldSnapshot {
    return this.simSnap;
  }

  /** True while the countdown is held back for the remote players' screens. */
  get waiting(): boolean {
    return !this.gateOpen;
  }

  /** Names of the connected remote humans whose match screen has not reported in yet. */
  waitingFor(): string[] {
    const slots = orderedSlots(this.start);
    const out: string[] = [];
    for (const st of this.net.allStats()) {
      if (st.connected && st.intent.packets === 0) out.push(slotLabel(slots[st.slot]));
    }
    return out;
  }

  /** A remote human's link dropped: the slot is bot-driven from the next tick on. */
  onPeerLeft(cb: (info: PeerLeftInfo) => void): () => void {
    this.leftCbs.push(cb);
    return () => {
      const i = this.leftCbs.indexOf(cb);
      if (i >= 0) this.leftCbs.splice(i, 1);
    };
  }

  tick(dt: number, intent: FighterIntent | null): void {
    if (!this.gateOpen) {
      this.waited += dt;
      if (this.waited >= this.gateTimeoutS || this.waitingFor().length === 0) this.gateOpen = true;
      if (!this.gateOpen) return;
    }
    const world = this.world;
    const me = this.hostSlot;
    if (intent !== null) world.setIntent(me, intent);
    // Bots read the last completed snapshot (real ids), then hand intents to the sim. A slot with a connected remote human
    // takes that human's intent instead; `remoteIntent` is null for bots and for players who left, so those stay bot-driven.
    this.bots.update(this.simSnap, dt);
    for (let id = 0; id < this.count; id++) {
      if (id === me) continue;
      world.setIntent(id, this.net.remoteIntent(id) ?? this.bots.getIntent(id));
    }
    this.tickEvents.length = 0;
    world.step(dt);
    this.simSnap = world.snapshot();
    this.net.afterStep(this.simSnap, this.tickEvents);
    this.viewSnap = this.toView(this.simSnap);
  }

  /** Final standings in SLOT order (null until the match-over snapshot went through `tick`). */
  results(): BrResults | null {
    return this.net.results();
  }

  /** Per-client network stats (rtt, kB/s, …) for the debug HUD. */
  clientStats(): BrHostClientStats[] {
    return this.net.allStats();
  }

  /** Display name of a real slot. */
  slotName(slot: number): string {
    const s = orderedSlots(this.start)[slot];
    return s !== undefined ? slotLabel(s) : ANIMALS.lion.displayName;
  }

  dispose(): void {
    this.unsubLeft();
    this.leftCbs.length = 0;
    this.net.dispose();
    this.simBus.clear();
    this.bus.clear();
  }

  private toView(s: WorldSnapshot): WorldSnapshot {
    return this.hostSlot === 0 ? s : swapIds(s, 0, this.hostSlot);
  }
}
