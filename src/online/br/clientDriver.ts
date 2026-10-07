/**
 * ClientSimDriver (WP-N6): the {@link SimDriver} of a remote player in an online Battle Royale. There is no simulation here:
 *
 *   per 60 Hz tick     the local intent goes to the host (`BrNetClient.sendIntent`; a neutral one while dead / spectating)
 *   per render frame   `pull()` → the interpolated host snapshot (`view`) + the events that are now due, with the local player
 *                      remapped to fighter 0 (the id swap), so HUD / camera / first person / lock-on / ultimate previews /
 *                      spectate / nameplates / audio / VFX all work from snapshots exactly like offline
 *
 * Before the first keyframe arrives (< 0.3 s) the controller shows the spawn-pose snapshot of a never-stepped `World` built from
 * the same roster and seed (this one `World` is only asked for `snapshot()`; it is never stepped).
 */

import { EventBus } from '../../core/EventBus';
import type { ArenaId, FighterIntent, GameEvent, RosterEntry, WorldSnapshot } from '../../core/types';
import { World } from '../../sim/World';
import type { SimDriver, SimPull } from '../../match/SimDriver';
import type { GameChannel, OnlineStart } from '../types';
import { BrNetClient, type BrClientStats, type BrNetClientOptions } from './BrNetClient';
import { swapEventIds, swapIds } from './idSwap';
import type { BrResults } from './miscCodec';
import { buildNetRoster, controllerNames, controllerRoster, netMatchConfig, startArena } from './netRoster';

export interface ClientDriverOptions {
  start: OnlineStart;
  channel: GameChannel;
  /** Monotonic ms clock (tests inject the loopback clock). Default `performance.now`. */
  now?: () => number;
  /** Extra BrNetClient options (tests). */
  clientOpts?: Partial<BrNetClientOptions>;
}

export class ClientSimDriver implements SimDriver {
  readonly kind = 'client' as const;
  readonly stepsSim = false;
  readonly pausable = false;
  /** The host's map (v1.8): the controller builds the matching scene from it. */
  readonly arena: ArenaId;
  readonly roster: readonly RosterEntry[];
  readonly names: readonly (string | null)[];
  readonly bus = new EventBus();
  readonly net: BrNetClient;
  readonly localSlot: number;

  private snap: WorldSnapshot;
  private gotSnapshot = false;
  private matchEndSeen = false;
  private starved = false;
  private readonly neutral: FighterIntent = {
    moveX: 0,
    moveZ: 0,
    aimYaw: 0,
    attack: false,
    block: false,
    special: false,
    ultimate: false,
    jump: false,
  };

  constructor(opts: ClientDriverOptions) {
    const { start, channel } = opts;
    this.localSlot = start.localSlot;
    const simRoster = buildNetRoster(start, null);
    this.roster = controllerRoster(simRoster, this.localSlot);
    this.names = controllerNames(start, this.localSlot);
    this.arena = startArena(start);
    const spawn = new World(netMatchConfig(start, simRoster, start.br?.difficulty ?? 3), start.seed, new EventBus()).snapshot();
    this.snap = this.localSlot === 0 ? spawn : swapIds(spawn, 0, this.localSlot);
    this.net = new BrNetClient({ channel, start, now: opts.now, ...opts.clientOpts });
  }

  snapshot(): WorldSnapshot {
    return this.snap;
  }

  /** True once the first host snapshot has been rendered. */
  get connected(): boolean {
    return this.gotSnapshot;
  }

  /** True once the match-over state has been delivered (the host then stops streaming; silence is expected). */
  get matchOver(): boolean {
    return this.matchEndSeen;
  }

  /** True while the view is extrapolating / holding because snapshots stopped arriving. */
  get isStarved(): boolean {
    return this.starved;
  }

  tick(_dt: number, intent: FighterIntent | null): void {
    this.net.sendIntent(intent ?? this.neutral);
  }

  pull(): SimPull | null {
    const s = this.net.sample();
    if (s === null) return null;
    this.gotSnapshot = true;
    this.starved = s.starved;
    const swap = this.localSlot !== 0;
    // Interpolated views take their discrete fields (matchOver, winnerId, kills, …) from the EARLIER bracketing snapshot, so the
    // very last tick's changes would never show. Once render time has reached the final snapshot the exact newest state IS the
    // view (alpha = 1), so use it: the controller then sees the real winner / kill counts.
    const final = s.finished ? this.net.latest() : null;
    const view = final ?? s.view;
    this.snap = swap ? swapIds(view, 0, this.localSlot) : view;
    const events: GameEvent[] = [];
    for (const raw of s.events) {
      const e = swap ? swapEventIds(raw, 0, this.localSlot) : raw;
      if (e.type === 'matchEnd') {
        if (this.matchEndSeen) continue; // exactly one matchEnd, whichever source got there first
        this.matchEndSeen = true;
      }
      events.push(e);
    }
    // `matchEnd` is a reliable event, but the final snapshot is the ground truth: never leave the controller waiting.
    if (!this.matchEndSeen && s.finished) {
      this.matchEndSeen = true;
      events.push({ type: 'matchEnd', winnerId: this.snap.winnerId });
    }
    return { snapshot: this.snap, events };
  }

  /** Final standings in SLOT order (the host's message), or null before they arrive. */
  results(): BrResults | null {
    return this.net.results();
  }

  onResults(cb: (r: BrResults) => void): () => void {
    return this.net.onResults(cb);
  }

  onHostLeft(cb: (reason: string) => void): () => void {
    return this.net.onHostLeft(cb);
  }

  stats(): BrClientStats {
    return this.net.stats();
  }

  dispose(): void {
    this.net.dispose();
    this.bus.clear();
  }
}
