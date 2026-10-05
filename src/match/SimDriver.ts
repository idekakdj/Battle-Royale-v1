/**
 * SimDriver (v1.5 online, WP-N6) — the seam between {@link MatchController} and "where the simulation lives".
 *
 * The controller used to talk to `World` + `BotManager` directly in exactly four places (construct, first snapshot,
 * per-tick intents + step, per-tick snapshot). Those four uses now go through this interface:
 *
 *  - {@link LocalSimDriver}  (default, offline): World + BotManager exactly as before — byte-for-byte the same calls in the
 *    same order, so single-player behaviour is unchanged.
 *  - `HostSimDriver`  (src/online/br/hostDriver.ts): World + BotManager + BrNetHost; remote humans' intents come from the
 *    network, bots take over departed players, snapshots/events are broadcast after each step.
 *  - `ClientSimDriver` (src/online/br/clientDriver.ts): no sim at all; the local intent goes to the host every tick and the
 *    controller PULLS interpolated host snapshots (+ the events that are due) once per render frame.
 *
 * Fighter ids are CONTROLLER ids: the local player is always fighter 0 (online drivers remap with the id swap), so nothing in
 * the controller (HUD, lock-on, spectate, first person, ult previews …) needs to know about slots.
 */

import { EventBus } from '../core/EventBus';
import type { Difficulty, FighterIntent, GameEvent, AnimalId, RosterEntry, WorldSnapshot } from '../core/types';
import { World } from '../sim/World';
import { BotManager } from '../ai/BotManager';
import { seatRoster } from './seating';

/** One frame's worth of state delivered by a pull-style driver (the online client). */
export interface SimPull {
  /** Interpolated state to draw / feed the HUD. */
  snapshot: WorldSnapshot;
  /** Gameplay events that are now due, in order (the controller emits them on {@link SimDriver.bus}). */
  events: readonly GameEvent[];
}

export interface SimDriver {
  readonly kind: 'local' | 'host' | 'client';
  /**
   * True when {@link tick} advances a simulation and `snapshot()` is fresh after it (local + host). False for the client,
   * whose snapshots arrive through {@link pull} once per render frame.
   */
  readonly stepsSim: boolean;
  /** False online: Esc opens the menu but the match keeps running. */
  readonly pausable: boolean;
  /** Roster in controller id order (id 0 = the local player). */
  readonly roster: readonly RosterEntry[];
  /** Display name per controller id; `null` = show the animal name (bots, offline). */
  readonly names: readonly (string | null)[];
  /** The bus the controller wires audio / HUD / VFX to. Sims emit on it (or, for the client, the controller does). */
  readonly bus: EventBus;
  /** The latest completed snapshot (spawn poses before the first tick). */
  snapshot(): WorldSnapshot;
  /**
   * One fixed 60 Hz step. `intent` is the local player's intent this tick (already aim-assisted), or `null` while the player
   * is dead / spectating.
   */
  tick(dt: number, intent: FighterIntent | null): void;
  /** Pull-style drivers: the freshest renderable state, or `null` when nothing new/yet. Called once per render frame. */
  pull?(): SimPull | null;
  /** Release listeners / network objects. The controller calls it from `unmount`. */
  dispose(): void;
}

export interface LocalSimConfig {
  animal: AnimalId;
  difficulty: Difficulty;
  seed: number;
}

/** The offline sim: the player at fighter 0, nine seeded bots, one shared bus. */
export class LocalSimDriver implements SimDriver {
  readonly kind = 'local' as const;
  readonly stepsSim = true;
  readonly pausable = true;
  readonly roster: readonly RosterEntry[];
  readonly names: readonly (string | null)[];
  readonly bus = new EventBus();

  private readonly world: World;
  private readonly bots: BotManager;
  private snap: WorldSnapshot;

  constructor(cfg: LocalSimConfig) {
    // Roster: player's pick at index 0, the other nine seated by a seeded shuffle (fresh neighbours every match / REMATCH).
    const roster = seatRoster(cfg.animal, cfg.seed);
    this.roster = roster;
    this.names = roster.map(() => null);
    this.world = new World({ roster, difficulty: cfg.difficulty }, cfg.seed, this.bus);
    // BotManager MUST share the bus and exist before the first step.
    this.bots = new BotManager(this.bus, cfg.difficulty, cfg.seed);
    this.snap = this.world.snapshot();
  }

  snapshot(): WorldSnapshot {
    return this.snap;
  }

  tick(dt: number, intent: FighterIntent | null): void {
    if (intent !== null) this.world.setIntent(0, intent);
    // Bots read the last completed snapshot, then hand intents to the sim.
    this.bots.update(this.snap, dt);
    const n = this.roster.length;
    for (let id = 1; id < n; id++) this.world.setIntent(id, this.bots.getIntent(id));
    this.world.step(dt);
    this.snap = this.world.snapshot();
  }

  dispose(): void {
    // The controller clears the bus itself; nothing else to release.
  }
}
