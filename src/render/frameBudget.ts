/**
 * FrameBudgetMonitor (v1.10.1, WP-L2): the pure frame-time watchdog behind automatic quality lowering.
 *
 * It is fed the wall-clock interval between two drawn frames (seconds) and groups them into 1 s buckets. A bucket whose average
 * frame time is above `slowFrameMs` is "slow"; `slowSeconds` slow buckets in a row (after a warm-up that skips the first-frames
 * shader/texture hitches) means the budget is blown and the caller should step the quality tier down ONE level. After a trigger
 * (and after any tier change) the monitor warms up again so the new tier gets a fair chance before it is judged.
 *
 * This is the logic `SceneManager` used inline for the 'auto' graphics setting (fps < 45 for 3 s, 2.5 s warm-up) lifted out so
 * it can be unit-tested; it is also what lowers the tier during an ONLINE match for a player who picked a fixed tier (threshold
 * {@link ONLINE_SLOW_FRAME_MS} = 22 ms). It never raises the tier - that is not its job.
 */

/** The 'auto' graphics setting's threshold: below 45 fps. */
export const AUTO_SLOW_FRAME_MS = 1000 / 45;
/** Online matches: an average frame time above ~22 ms (about 45 fps) for 3 s lowers the tier. */
export const ONLINE_SLOW_FRAME_MS = 22;
/** Consecutive slow 1 s buckets that trigger a downgrade. */
export const SLOW_SECONDS = 3;
/** 1 s buckets ignored after a start / tier change (the shader compile and texture upload frames). */
export const WARMUP_BUCKETS = 2.5;
/** Frames longer than this (seconds) are tab stalls or hidden pages, not performance: ignored. */
export const MAX_SAMPLE_S = 0.5;

export interface FrameBudgetOptions {
  slowFrameMs?: number;
  slowSeconds?: number;
  warmupBuckets?: number;
}

export class FrameBudgetMonitor {
  /** Average frame time (ms) above which a 1 s bucket counts as slow. Mutable: online matches tighten it. */
  slowFrameMs: number;
  readonly slowSeconds: number;
  readonly warmupBuckets: number;

  private warmup: number;
  private bucketT = 0;
  private bucketFrames = 0;
  private slowBuckets = 0;
  private _fps = 60;
  private _avgMs = 1000 / 60;

  constructor(opts: FrameBudgetOptions = {}) {
    this.slowFrameMs = opts.slowFrameMs ?? AUTO_SLOW_FRAME_MS;
    this.slowSeconds = opts.slowSeconds ?? SLOW_SECONDS;
    this.warmupBuckets = opts.warmupBuckets ?? WARMUP_BUCKETS;
    this.warmup = this.warmupBuckets;
  }

  /** Frames per second over the last full 1 s bucket. */
  get fps(): number {
    return this._fps;
  }

  /** Average frame time (ms) over the last full 1 s bucket. */
  get avgMs(): number {
    return this._avgMs;
  }

  /** Throw away the current bucket and the slow streak and skip the next buckets again (a tier change just happened). */
  restartWarmup(): void {
    this.warmup = this.warmupBuckets;
    this.slowBuckets = 0;
    this.bucketT = 0;
    this.bucketFrames = 0;
  }

  /**
   * Record one drawn frame of `dtS` seconds. `armed` = the caller wants a verdict (auto setting, or an online match); when it is
   * false the monitor only measures fps. Returns true exactly when the budget has been blown long enough to lower the tier.
   */
  sample(dtS: number, armed: boolean): boolean {
    if (!(dtS > 0) || dtS >= MAX_SAMPLE_S) return false;
    this.bucketT += dtS;
    this.bucketFrames++;
    if (this.bucketT < 1) return false;
    this._fps = this.bucketFrames / this.bucketT;
    this._avgMs = (this.bucketT / this.bucketFrames) * 1000;
    this.bucketT = 0;
    this.bucketFrames = 0;
    if (this.warmup > 0) {
      this.warmup -= 1;
      this.slowBuckets = 0;
      return false;
    }
    if (!armed) {
      this.slowBuckets = 0;
      return false;
    }
    this.slowBuckets = this._avgMs > this.slowFrameMs ? this.slowBuckets + 1 : 0;
    if (this.slowBuckets >= this.slowSeconds) {
      this.slowBuckets = 0;
      this.warmup = this.warmupBuckets; // let the new tier settle before judging again
      return true;
    }
    return false;
  }
}
