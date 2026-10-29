/**
 * Host load shedding (v1.10.1, WP-L2): when the online Battle Royale host's own frames are slow, send fewer snapshots.
 *
 * The host runs the sim, the bots, snapshot encoding/sending and rendering in one loop. Encoding + sending a snapshot is real work
 * (it happens inside the sim tick), so a host whose frames average above {@link SHED_ABOVE_MS} for {@link SHED_AFTER_S} seconds
 * drops from 30 Hz to 20 Hz snapshots, and goes back once it has been comfortably fast ({@link RESTORE_BELOW_MS}) for
 * {@link RESTORE_AFTER_S} seconds (hysteresis, so it does not flap around the threshold). Clients measure the snapshot spacing
 * themselves (BrNetClient adapts `intervalMs` from the host's sim timestamps), so nothing has to be announced to them.
 *
 * Pure (no DOM, no timers): `sample(dtS)` takes the wall-clock seconds between two drawn frames.
 */

/** Normal snapshot rate (Hz) - the BrNetHost default. */
export const NORMAL_SNAPSHOT_HZ = 30;
/** Rate while the host is overloaded (Hz). */
export const SHED_SNAPSHOT_HZ = 20;
/** Average frame time (ms) of a 1 s bucket above which the host counts as overloaded. */
export const SHED_ABOVE_MS = 30;
/** Average frame time (ms) of a 1 s bucket below which the host counts as recovered. */
export const RESTORE_BELOW_MS = 22;
/** Consecutive overloaded 1 s buckets before shedding. */
export const SHED_AFTER_S = 2;
/** Consecutive recovered 1 s buckets before restoring the full rate. */
export const RESTORE_AFTER_S = 6;
/** 1 s buckets ignored at the start of a match (first-frame JIT, texture uploads). */
export const WARMUP_BUCKETS = 2;
/** Frames longer than this (seconds) are stalls (alt-tab, debugger), not sustained load: ignored. */
export const MAX_FRAME_S = 0.5;

export interface LoadShedOptions {
  shedAboveMs?: number;
  restoreBelowMs?: number;
  shedAfterS?: number;
  restoreAfterS?: number;
  normalHz?: number;
  shedHz?: number;
  warmupBuckets?: number;
}

export class HostLoadShedder {
  private readonly shedAboveMs: number;
  private readonly restoreBelowMs: number;
  private readonly shedAfterS: number;
  private readonly restoreAfterS: number;
  private readonly normalHz: number;
  private readonly shedHz: number;

  private current: number;
  private warmup: number;
  private bucketT = 0;
  private bucketFrames = 0;
  private overBuckets = 0;
  private okBuckets = 0;

  constructor(opts: LoadShedOptions = {}) {
    this.shedAboveMs = opts.shedAboveMs ?? SHED_ABOVE_MS;
    this.restoreBelowMs = opts.restoreBelowMs ?? RESTORE_BELOW_MS;
    this.shedAfterS = opts.shedAfterS ?? SHED_AFTER_S;
    this.restoreAfterS = opts.restoreAfterS ?? RESTORE_AFTER_S;
    this.normalHz = opts.normalHz ?? NORMAL_SNAPSHOT_HZ;
    this.shedHz = opts.shedHz ?? SHED_SNAPSHOT_HZ;
    this.current = this.normalHz;
    this.warmup = opts.warmupBuckets ?? WARMUP_BUCKETS;
  }

  /** The snapshot rate the host should currently use (Hz). */
  get hz(): number {
    return this.current;
  }

  /** True while the reduced rate is in force. */
  get shedding(): boolean {
    return this.current === this.shedHz;
  }

  /**
   * Record one drawn frame of `dtS` seconds. Returns the NEW snapshot rate (Hz) when it should change, otherwise null.
   */
  sample(dtS: number): number | null {
    if (!(dtS > 0) || dtS >= MAX_FRAME_S) return null;
    this.bucketT += dtS;
    this.bucketFrames++;
    if (this.bucketT < 1) return null;
    const avgMs = (this.bucketT / this.bucketFrames) * 1000;
    this.bucketT = 0;
    this.bucketFrames = 0;
    if (this.warmup > 0) {
      this.warmup--;
      return null;
    }

    if (this.current === this.normalHz) {
      this.okBuckets = 0;
      this.overBuckets = avgMs > this.shedAboveMs ? this.overBuckets + 1 : 0;
      if (this.overBuckets >= this.shedAfterS) {
        this.overBuckets = 0;
        this.current = this.shedHz;
        return this.current;
      }
      return null;
    }
    this.overBuckets = 0;
    this.okBuckets = avgMs < this.restoreBelowMs ? this.okBuckets + 1 : 0;
    if (this.okBuckets >= this.restoreAfterS) {
      this.okBuckets = 0;
      this.current = this.normalHz;
      return this.current;
    }
    return null;
  }

  /** Forget the current bucket and streaks (rate unchanged). */
  reset(): void {
    this.bucketT = 0;
    this.bucketFrames = 0;
    this.overBuckets = 0;
    this.okBuckets = 0;
  }
}
