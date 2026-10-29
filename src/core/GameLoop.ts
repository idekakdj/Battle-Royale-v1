/**
 * Fixed-timestep game loop with render interpolation (BLUEPRINT section 5).
 *
 * The sim advances in fixed `1/60 s` steps via an accumulator; rendering happens
 * once per `requestAnimationFrame` with an `alpha` interpolation factor so the
 * view can lerp between the last two sim states. A spiral-of-death guard caps
 * the number of catch-up steps per frame.
 *
 * v1.10.1 (WP-L2) - hidden-page keep-alive. In an online Battle Royale the host runs the sim, the bots, the snapshot sends and the
 * pongs inside this loop, so a page that stops getting animation frames (minimised, other tab, covered window) used to freeze
 * the game for every player. When `keepAliveWhenHidden()` is true and the page is hidden, a Worker-driven timer
 * ({@link WorkerTicker}) pumps the SAME time-driven stepper ({@link FixedStepper}) every ~16 ms and the render callback is told
 * `draw = false` (and called at a slower pace): the sim keeps stepping, nothing is drawn. When the page is visible again the timer
 * stops and `requestAnimationFrame` takes over the same clock - no double stepping (time is only consumed once) and no lurch.
 * Offline matches pass no `keepAliveWhenHidden`, so they pause with the page exactly as before.
 */

import {
  FIXED_DT,
  FixedStepper,
  HIDDEN_RENDER_MS,
  HIDDEN_TICK_MS,
  HiddenRenderGate,
  MAX_STEPS_PER_FRAME,
  shouldDriveFromWorker,
} from './loopScheduler';
import { createWorkerTicker, type Ticker } from './WorkerTicker';

export { FIXED_DT, MAX_STEPS_PER_FRAME };

export type StepFn = (dt: number) => void;
/** `draw` is false while a hidden page is being kept alive: do the per-frame bookkeeping, skip anything that only matters on screen. */
export type RenderFn = (alpha: number, dtRender: number, draw?: boolean) => void;

/** Everything the loop needs from the browser; injectable so the scheduling can be tested with fakes. */
export interface LoopEnv {
  raf(cb: (timeMs: number) => void): number;
  caf(id: number): void;
  /** Monotonic ms clock (same time origin as the rAF timestamps). */
  now(): number;
  isHidden(): boolean;
  /** Subscribe to visibility changes; returns the unsubscribe. */
  onVisibilityChange(cb: () => void): () => void;
  createTicker(): Ticker;
}

const browserEnv: LoopEnv = {
  raf: (cb) => requestAnimationFrame(cb),
  caf: (id) => cancelAnimationFrame(id),
  now: () => performance.now(),
  isHidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  onVisibilityChange: (cb) => {
    if (typeof document === 'undefined') return () => undefined;
    document.addEventListener('visibilitychange', cb);
    return () => document.removeEventListener('visibilitychange', cb);
  },
  createTicker: createWorkerTicker,
};

export interface GameLoopOptions {
  step: StepFn;
  render: RenderFn;
  /** Fixed timestep in seconds. Defaults to {@link FIXED_DT} (1/60). */
  fixedDt?: number;
  /** Max catch-up steps per frame. Defaults to {@link MAX_STEPS_PER_FRAME}. */
  maxSteps?: number;
  /**
   * Keep stepping from a Worker timer while the page is hidden when this returns true (queried on every visibility change).
   * Omitted = never (the loop simply freezes with the page, as offline matches do).
   */
  keepAliveWhenHidden?: () => boolean;
  /** Period of the hidden-page Worker tick (ms). */
  hiddenTickMs?: number;
  /** Pace of the non-draw render callback while hidden (ms). */
  hiddenRenderMs?: number;
  /** Test seam: replace the browser APIs. */
  env?: Partial<LoopEnv>;
}

export class GameLoop {
  private readonly stepFn: StepFn;
  private readonly renderFn: RenderFn;
  private readonly stepper: FixedStepper;
  private readonly env: LoopEnv;
  private readonly keepAlive: () => boolean;
  private readonly hiddenTickMs: number;
  private readonly hiddenGate: HiddenRenderGate;

  private rafId = 0;
  private running = false;
  private paused = false;
  /** True while the Worker timer (not rAF) is the primary driver of a hidden page. */
  private workerDrive = false;
  private ticker: Ticker | null = null;
  private unsubVisibility: (() => void) | null = null;

  private readonly tick = (now: number): void => {
    if (!this.running) return;
    this.rafId = this.env.raf(this.tick);
    this.frame(now);
  };

  private readonly onWorkerTick = (): void => {
    if (!this.running || !this.workerDrive) return;
    this.frame(this.env.now());
  };

  private readonly onVisibility = (): void => {
    this.syncDrive();
  };

  constructor(options: GameLoopOptions) {
    this.stepFn = options.step;
    this.renderFn = options.render;
    this.stepper = new FixedStepper(options.fixedDt ?? FIXED_DT, options.maxSteps ?? MAX_STEPS_PER_FRAME);
    this.env = { ...browserEnv, ...options.env };
    this.keepAlive = options.keepAliveWhenHidden ?? (() => false);
    this.hiddenTickMs = options.hiddenTickMs ?? HIDDEN_TICK_MS;
    this.hiddenGate = new HiddenRenderGate((options.hiddenRenderMs ?? HIDDEN_RENDER_MS) / 1000);
  }

  /** One pump of the shared clock: fixed steps, then a (possibly non-draw) render. */
  private frame(now: number): void {
    // The stepper clamps the gap, so a hidden/stalled page does not produce an enormous dt that would require huge catch-up.
    const frameDt = this.stepper.advance(now, this.paused, this.stepFn);
    if (this.workerDrive) {
      // Hidden and kept alive: no drawing, and the bookkeeping render at a relaxed pace.
      this.hiddenGate.add(frameDt);
      const dt = this.hiddenGate.take();
      if (dt > 0) this.renderFn(this.paused ? 1 : this.stepper.alpha, dt, false);
      return;
    }
    this.renderFn(this.stepper.alpha, frameDt, true);
  }

  /** Re-evaluate who drives the loop (called at start and on every visibility change). */
  private syncDrive(): void {
    if (!this.running) return;
    const want = shouldDriveFromWorker({ hidden: this.env.isHidden(), keepAlive: this.keepAlive() });
    if (want === this.workerDrive) return;
    this.workerDrive = want;
    this.hiddenGate.reset();
    if (want) {
      this.ticker = this.env.createTicker();
      this.ticker.start(this.onWorkerTick, this.hiddenTickMs);
    } else if (this.ticker !== null) {
      this.ticker.stop();
      this.ticker = null;
    }
  }

  /** Begin the rAF loop. No-op if already running. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this.stepper.reset(this.env.now());
    this.rafId = this.env.raf(this.tick);
    this.unsubVisibility = this.env.onVisibilityChange(this.onVisibility);
    this.syncDrive();
  }

  /** Stop the loop entirely and cancel the pending frame (and the hidden-page timer). */
  stop(): void {
    this.running = false;
    if (this.rafId !== 0) {
      this.env.caf(this.rafId);
      this.rafId = 0;
    }
    if (this.unsubVisibility !== null) {
      this.unsubVisibility();
      this.unsubVisibility = null;
    }
    if (this.ticker !== null) {
      this.ticker.stop();
      this.ticker = null;
    }
    this.workerDrive = false;
  }

  /** Freeze sim stepping (render still runs each frame with alpha = 1). */
  pause(): void {
    this.paused = true;
  }

  /** Resume sim stepping; discards accumulated backlog to avoid a lurch. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.stepper.reset(this.env.now());
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** True while the Worker timer is driving a hidden page (QA / tests). */
  get isWorkerDriven(): boolean {
    return this.workerDrive;
  }

  /** Which tick mechanism is live while worker-driven ('none' otherwise); QA / diagnostics. */
  get tickerKind(): Ticker['kind'] {
    return this.ticker !== null ? this.ticker.kind : 'none';
  }
}
