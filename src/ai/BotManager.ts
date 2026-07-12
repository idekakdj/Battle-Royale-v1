/**
 * BotManager — WP-C public entry point (BLUEPRINT §10 / §14).
 *
 * WP-I usage per tick:
 *   const bots = new BotManager(bus, difficulty, seed);  // same bus as World
 *   bots.update(world.snapshot(), FIXED_DT);             // once per tick
 *   for (const id of botIds) world.setIntent(id, bots.getIntent(id));
 *
 * Brains are created for every non-player roster entry on the first update.
 * Determinism: a single mulberry32 stream seeds one child stream per bot; no
 * Math.random anywhere in `ai/`.
 *
 * Perception buffering: the manager keeps a ring of recent snapshots so each
 * brain reads the snapshot from ~reactionMs ago (its perceived world), while
 * events are stamped `now + reactionMs` before release (see Perception).
 */

import type { Difficulty, FighterIntent, WorldSnapshot } from '../core/types';
import type { EventBus } from '../core/EventBus';
import { BOT_PROFILES } from '../config/botProfiles';
import { mulberry32, type Rng } from '../core/math';
import { BotBrain } from './BotBrain';

const RING_CAP = 64; // > 600 ms at 60 Hz

const NEUTRAL_INTENT: Readonly<FighterIntent> = {
  moveX: 0,
  moveZ: 0,
  aimYaw: 0,
  attack: false,
  block: false,
  special: false,
  ultimate: false,
  jump: false,
};

export class BotManager {
  private readonly difficulty: Difficulty;
  private readonly rootRng: Rng;
  private readonly brains: (BotBrain | null)[] = [];
  private readonly overrides = new Map<number, Difficulty>();

  private readonly ring: (WorldSnapshot | null)[] = new Array<WorldSnapshot | null>(RING_CAP).fill(null);
  private ringHead = -1;
  private ringCount = 0;

  private now = 0;
  private lastDt = 1 / 60;
  private initialized = false;

  constructor(bus: EventBus, difficulty: Difficulty, seed: number) {
    this.difficulty = difficulty;
    this.rootRng = mulberry32(seed);
    bus.onAny((ev) => {
      if (!this.initialized) return; // pre-match events (countdown emits none)
      for (let i = 0; i < this.brains.length; i++) {
        const b = this.brains[i];
        if (b !== null) b.perception.pushEvent(ev, this.now + b.perception.reactionS);
      }
    });
  }

  /**
   * Per-fighter difficulty override (e.g. mixed-skill lobbies in tests).
   * Call before the first update for a clean start; later calls swap the
   * profile live.
   */
  setDifficulty(fighterId: number, difficulty: Difficulty): void {
    this.overrides.set(fighterId, difficulty);
    const b = this.brains[fighterId];
    if (b !== undefined && b !== null) {
      const profile = BOT_PROFILES[difficulty];
      b.profile = profile;
      b.perception.reactionS = profile.reactionMs / 1000;
    }
  }

  /** Feed the latest snapshot; drives every bot brain. Call once per sim tick. */
  update(snapshot: WorldSnapshot, dt: number): void {
    this.now += dt;
    this.lastDt = dt;

    if (!this.initialized) {
      for (let i = 0; i < snapshot.fighters.length; i++) {
        const f = snapshot.fighters[i];
        // Child seed drawn in roster order — deterministic.
        const childSeed = Math.floor(this.rootRng() * 0xffffffff) >>> 0;
        if (f.isPlayer) {
          this.brains.push(null);
        } else {
          const d = this.overrides.get(i) ?? this.difficulty;
          this.brains.push(new BotBrain(i, f.animal, BOT_PROFILES[d], childSeed));
        }
      }
      this.initialized = true;
    }

    // Push into the snapshot ring.
    this.ringHead = (this.ringHead + 1) % RING_CAP;
    this.ring[this.ringHead] = snapshot;
    if (this.ringCount < RING_CAP) this.ringCount++;

    for (let i = 0; i < this.brains.length; i++) {
      const b = this.brains[i];
      if (b === null) continue;
      const lagTicks = Math.min(this.ringCount - 1, Math.round(b.perception.reactionS / this.lastDt));
      const idx = (this.ringHead - lagTicks + RING_CAP) % RING_CAP;
      const delayed = this.ring[idx];
      b.update(this.now, dt, snapshot, delayed !== null ? delayed : snapshot);
    }
  }

  /** The (reused) intent for a bot fighter; neutral for players/unknown ids. */
  getIntent(fighterId: number): FighterIntent {
    const b = this.brains[fighterId];
    return b !== undefined && b !== null ? b.intent : NEUTRAL_INTENT;
  }
}
