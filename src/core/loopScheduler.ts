/**
 * Loop scheduling logic, pure (no DOM, no timers) so it can be unit-tested with a fake clock (v1.10.1, WP-L2).
 *
 * Two pieces:
 *
 *  - {@link FixedStepper}: the fixed 60 Hz accumulator that used to live inside `GameLoop.tick`. It is TIME-driven: it is told
 *    "the clock now reads `nowMs`" and runs however many fixed steps that wall-clock time is worth (capped by the spiral-of-death
 *    guard). Because it only looks at elapsed time, it does not matter WHO calls it - the `requestAnimationFrame` callback or a
 *    Worker-driven timer - so a hand-over between the two can neither step twice for the same wall-clock time nor lurch.
 *  - {@link shouldDriveFromWorker}: when a hidden page must keep stepping (the online Battle Royale host, whose sim + bots +
 *    snapshots + pongs live in the same loop as rendering) instead of freezing together with `requestAnimationFrame`.
 *
 * Offline matches never ask for the keep-alive, so they keep pausing while the page is hidden, exactly as before.
 */

/** Fixed simulation timestep: 60 Hz. */
export const FIXED_DT = 1 / 60;

/** Max sim steps executed per pump - guards the spiral of death. */
export const MAX_STEPS_PER_FRAME = 5;

/** Longest wall-clock gap (seconds) one pump will try to catch up on; a stalled page does not produce a huge dt. */
export const MAX_FRAME_DT = 0.25;

/** Period of the Worker tick that drives a hidden page (ms). Slightly under one 60 Hz step; the accumulator absorbs the jitter. */
export const HIDDEN_TICK_MS = 16;

/** While hidden nothing is drawn, so the (non-draw) frame work - rig poses, effects, client snapshot pulls - runs at this slower pace (ms). */
export const HIDDEN_RENDER_MS = 50;

export type StepCallback = (dt: number) => void;

/** The fixed-timestep accumulator (BLUEPRINT section 5). Identical arithmetic to the pre-1.10.1 `GameLoop`, plus a monotonic clock guard. */
export class FixedStepper {
  private accumulator = 0;
  private lastTime = 0;
  private _alpha = 0;

  constructor(
    readonly fixedDt: number = FIXED_DT,
    readonly maxSteps: number = MAX_STEPS_PER_FRAME,
    readonly maxFrameDt: number = MAX_FRAME_DT,
  ) {}

  /** Start a fresh timeline at `nowMs` (no backlog). */
  reset(nowMs: number): void {
    this.accumulator = 0;
    this.lastTime = nowMs;
    this._alpha = 0;
  }

  /**
   * Run the fixed steps that `nowMs` is worth. Returns the (clamped) seconds since the previous call. A timestamp older than the
   * previous one (a `requestAnimationFrame` frame-start stamp racing a `performance.now()` read from a Worker tick) is treated as
   * "no time passed", never as negative time, and never moves the clock backwards.
   *
   * @param paused when true nothing is stepped (the clock still advances so a later resume has no backlog)
   */
  advance(nowMs: number, paused: boolean, step: StepCallback): number {
    if (nowMs < this.lastTime) nowMs = this.lastTime;
    let frameDt = (nowMs - this.lastTime) / 1000;
    this.lastTime = nowMs;
    if (frameDt > this.maxFrameDt) frameDt = this.maxFrameDt;
    if (!paused) {
      this.accumulator += frameDt;
      let steps = 0;
      while (this.accumulator >= this.fixedDt) {
        step(this.fixedDt);
        this.accumulator -= this.fixedDt;
        if (++steps >= this.maxSteps) {
          // Spiral-of-death guard: drop the backlog we cannot catch up on.
          this.accumulator = 0;
          break;
        }
      }
    }
    // `alpha` is how far we are into the next pending step, for view lerp.
    this._alpha = paused ? 1 : this.accumulator / this.fixedDt;
    return frameDt;
  }

  /** Interpolation factor of the last {@link advance}. */
  get alpha(): number {
    return this._alpha;
  }

  /** The clock reading of the last {@link advance} / {@link reset} (ms). */
  get clock(): number {
    return this.lastTime;
  }
}

export interface DriveInputs {
  /** The page is hidden (`document.visibilityState === 'hidden'`: minimised, other tab, covered by the OS). */
  hidden: boolean;
  /** The match must not freeze while hidden (online Battle Royale: the host serves everybody, a client keeps its seat). */
  keepAlive: boolean;
}

/** True while a Worker timer (not `requestAnimationFrame`) has to drive the loop. */
export function shouldDriveFromWorker(inputs: DriveInputs): boolean {
  return inputs.hidden && inputs.keepAlive;
}

/**
 * Rate limiter for the non-draw frame work of a hidden page: accumulate the elapsed seconds and say when a frame is due.
 * `take()` returns the accumulated dt to render with (and zeroes it), or 0 when it is not yet time.
 */
export class HiddenRenderGate {
  private acc = 0;

  constructor(private readonly periodS: number = HIDDEN_RENDER_MS / 1000) {}

  add(dtS: number): void {
    this.acc += dtS;
  }

  take(): number {
    if (this.acc < this.periodS) return 0;
    const dt = this.acc;
    this.acc = 0;
    return dt;
  }

  reset(): void {
    this.acc = 0;
  }
}
