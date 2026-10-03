/**
 * Champions League — the DOM-free match loop core used by {@link BrawlMatchController}.
 *
 * `advance(frameDt)` is called once per animation frame. It runs the sim at a fixed 60 Hz with an
 * accumulator (frame time clamped to 0.25 s, at most `maxSteps` catch-up steps — no spiral of death), per step:
 * poll the player's input → `world.setIntent`, every bot updates from the latest snapshot → `world.setIntent`,
 * `world.step()`, drain events, keep the previous + current snapshot. Then it calls `view.render(prev, cur,
 * alpha, events, dt)` once. Paused: the sim does not step and the view keeps drawing a static frame.
 * When the sim reports the match over, `onMatchOver` fires once, and after a short celebration `onResults`
 * fires once.
 */

import { BRAWL_DT } from '../types';
import type { BrawlBotApi, BrawlEvent, BrawlInputApi, BrawlSnapshot, BrawlViewApi, BrawlWorldApi } from '../types';

export const SESSION_MAX_FRAME_DT = 0.25;
export const SESSION_MAX_STEPS = 5;
/** Seconds between the sim declaring the match over and the results screen. */
export const SESSION_CELEBRATION_S = 2.6;

const NO_EVENTS: readonly BrawlEvent[] = Object.freeze([]);

export interface BrawlSessionDeps {
  world: BrawlWorldApi;
  view: Pick<BrawlViewApi, 'render'>;
  input: Pick<BrawlInputApi, 'poll'>;
  /** One entry per non-player fighter (fighter id = roster index). */
  bots: ReadonlyArray<{ id: number; bot: BrawlBotApi }>;
  /** Fighter id the keyboard drives (default 0). */
  playerId?: number;
  /** Per sim step, with the events of that step (audio / HUD). */
  onEvents?: (events: readonly BrawlEvent[], cur: BrawlSnapshot) => void;
  /** After each view.render (HUD sync). */
  onRender?: (cur: BrawlSnapshot, events: readonly BrawlEvent[], dt: number) => void;
  /** Once, the frame the sim reports matchOver. */
  onMatchOver?: (cur: BrawlSnapshot) => void;
  /** Once, `celebrationS` after matchOver. */
  onResults?: (cur: BrawlSnapshot) => void;
  celebrationS?: number;
  maxSteps?: number;
}

export class BrawlSession {
  private readonly d: BrawlSessionDeps;
  private readonly playerId: number;
  private readonly maxSteps: number;
  private readonly celebrationS: number;

  private cur: BrawlSnapshot;
  private prev: BrawlSnapshot;
  private acc = 0;
  private pending: BrawlEvent[] = [];
  private paused = false;
  private disposed = false;
  private overSeen = false;
  private overElapsed = 0;
  private resultsFired = false;
  private steps = 0;

  constructor(deps: BrawlSessionDeps) {
    this.d = deps;
    this.playerId = deps.playerId ?? 0;
    this.maxSteps = Math.max(1, deps.maxSteps ?? SESSION_MAX_STEPS);
    this.celebrationS = deps.celebrationS ?? SESSION_CELEBRATION_S;
    this.cur = deps.world.snapshot();
    this.prev = this.cur;
  }

  get snapshot(): BrawlSnapshot {
    return this.cur;
  }

  get previousSnapshot(): BrawlSnapshot {
    return this.prev;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get matchOver(): boolean {
    return this.overSeen;
  }

  get resultsDelivered(): boolean {
    return this.resultsFired;
  }

  /** Number of sim steps executed so far. */
  get stepCount(): number {
    return this.steps;
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.acc = 0; // no lurch when resuming
  }

  dispose(): void {
    this.disposed = true;
    this.pending = [];
  }

  /** One animation frame of `frameDt` seconds (clamped). */
  advance(frameDt: number): void {
    if (this.disposed) return;
    let dt = Number.isFinite(frameDt) ? frameDt : 0;
    if (dt > SESSION_MAX_FRAME_DT) dt = SESSION_MAX_FRAME_DT;
    if (dt < 0) dt = 0;

    if (this.paused) {
      this.d.view.render(this.cur, this.cur, 1, NO_EVENTS, 0);
      this.d.onRender?.(this.cur, NO_EVENTS, 0);
      return;
    }

    if (!this.overSeen) {
      this.acc += dt;
      let n = 0;
      while (this.acc >= BRAWL_DT - 1e-9) {
        this.stepOnce();
        this.acc -= BRAWL_DT;
        if (this.overSeen) {
          this.acc = 0;
          break;
        }
        if (++n >= this.maxSteps) {
          this.acc = 0; // drop the backlog we cannot catch up on
          break;
        }
      }
      if (this.acc < 0) this.acc = 0;
    }

    const alpha = this.overSeen ? 1 : Math.min(1, this.acc / BRAWL_DT);
    const events = this.pending.length > 0 ? this.pending : NO_EVENTS;
    this.pending = [];
    this.d.view.render(this.prev, this.cur, alpha, events, dt);
    this.d.onRender?.(this.cur, events, dt);

    if (this.overSeen && !this.resultsFired) {
      this.overElapsed += dt;
      if (this.overElapsed >= this.celebrationS) {
        this.resultsFired = true;
        this.d.onResults?.(this.cur);
      }
    }
  }

  /** Exactly one sim step (also callable directly by tests / tools). */
  stepOnce(): void {
    const { world, input, bots } = this.d;
    world.setIntent(this.playerId, input.poll());
    for (let i = 0; i < bots.length; i++) {
      const b = bots[i];
      world.setIntent(b.id, b.bot.update(this.cur));
    }
    world.step();
    this.steps++;
    const ev = world.drainEvents();
    this.prev = this.cur;
    this.cur = world.snapshot();
    if (ev.length > 0) {
      for (let i = 0; i < ev.length; i++) this.pending.push(ev[i]);
      this.d.onEvents?.(ev, this.cur);
    }
    if (this.cur.matchOver && !this.overSeen) {
      this.overSeen = true;
      this.d.onMatchOver?.(this.cur);
    }
  }
}
