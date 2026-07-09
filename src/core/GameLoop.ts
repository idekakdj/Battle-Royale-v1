/**
 * Fixed-timestep game loop with render interpolation (BLUEPRINT §5).
 *
 * The sim advances in fixed `1/60 s` steps via an accumulator; rendering happens
 * once per `requestAnimationFrame` with an `alpha` interpolation factor so the
 * view can lerp between the last two sim states. A spiral-of-death guard caps
 * the number of catch-up steps per frame.
 */

export type StepFn = (dt: number) => void;
export type RenderFn = (alpha: number, dtRender: number) => void;

/** Fixed simulation timestep: 60 Hz. */
export const FIXED_DT = 1 / 60;

/** Max sim steps executed per animation frame — guards the spiral of death. */
export const MAX_STEPS_PER_FRAME = 5;

export interface GameLoopOptions {
  step: StepFn;
  render: RenderFn;
  /** Fixed timestep in seconds. Defaults to {@link FIXED_DT} (1/60). */
  fixedDt?: number;
  /** Max catch-up steps per frame. Defaults to {@link MAX_STEPS_PER_FRAME}. */
  maxSteps?: number;
}

export class GameLoop {
  private readonly stepFn: StepFn;
  private readonly renderFn: RenderFn;
  private readonly fixedDt: number;
  private readonly maxSteps: number;

  private accumulator = 0;
  private lastTime = 0;
  private rafId = 0;
  private running = false;
  private paused = false;

  private readonly tick = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.tick);

    // Seconds since the previous frame, clamped so a hidden/stalled tab does not
    // produce an enormous dt that would require huge catch-up.
    let frameDt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (frameDt > 0.25) frameDt = 0.25;
    if (frameDt < 0) frameDt = 0;

    if (!this.paused) {
      this.accumulator += frameDt;

      let steps = 0;
      while (this.accumulator >= this.fixedDt) {
        this.stepFn(this.fixedDt);
        this.accumulator -= this.fixedDt;
        if (++steps >= this.maxSteps) {
          // Spiral-of-death guard: drop the backlog we cannot catch up on.
          this.accumulator = 0;
          break;
        }
      }
    }

    // `alpha` is how far we are into the next pending step, for view lerp.
    const alpha = this.paused ? 1 : this.accumulator / this.fixedDt;
    this.renderFn(alpha, frameDt);
  };

  constructor(options: GameLoopOptions) {
    this.stepFn = options.step;
    this.renderFn = options.render;
    this.fixedDt = options.fixedDt ?? FIXED_DT;
    this.maxSteps = options.maxSteps ?? MAX_STEPS_PER_FRAME;
  }

  /** Begin the rAF loop. No-op if already running. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this.accumulator = 0;
    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  /** Stop the loop entirely and cancel the pending frame. */
  stop(): void {
    this.running = false;
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  /** Freeze sim stepping (render still runs each frame with alpha = 1). */
  pause(): void {
    this.paused = true;
  }

  /** Resume sim stepping; discards accumulated backlog to avoid a lurch. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.accumulator = 0;
    this.lastTime = performance.now();
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isPaused(): boolean {
    return this.paused;
  }
}
