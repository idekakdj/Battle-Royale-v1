/**
 * Round-trip estimate from the BR_SYNC ping/pong (v1.10.1), shared by BrNetClient and BrNetHost.
 *
 * The raw samples are honest but not all equally useful: a ping that sat in a send queue for seconds (a stalled path, an
 * uplink saturated by another upload) says "that ONE packet was late", not "the connection is now 3 s slow". A plain EMA would let
 * one such sample drag the shown ping up by ~1 s for several seconds. So:
 *   - a sample may raise the estimate by at most 3x + 100 ms per update (a real latency step still converges in a few samples);
 *   - a healthy link (estimate < 1 s) ignores up to 2 consecutive samples above 2 s (queued pings released by a stall); a third
 *     one in a row is believed (a link that is really that slow must not show a stale low number forever);
 *   - the raw peak of the last 10 s is kept separately ({@link peakMs}) so the HUD can still flag the spike.
 */

const ALPHA = 0.3;
const GROWTH_X = 3;
const GROWTH_PLUS_MS = 100;
/** Samples above this on a healthy link are treated as queued pings. */
export const STALE_PONG_MS = 2000;
const HEALTHY_MS = 1000;
const MAX_IGNORED_IN_A_ROW = 2;
const PEAK_WINDOW_MS = 10000;
const MAX_SAMPLE_MS = 30000;

export class PingEstimator {
  private ema = 0;
  private ignored = 0;
  private samples: Array<{ at: number; rtt: number }> = [];
  /** Samples discarded as queued pings. */
  ignoredTotal = 0;

  /** Smoothed round trip (ms), 0 until the first sample. */
  get value(): number {
    return this.ema;
  }

  /** Largest raw sample in the last 10 s (ms), 0 when there is none. */
  peakMs(now: number): number {
    let m = 0;
    for (const s of this.samples) if (now - s.at <= PEAK_WINDOW_MS && s.rtt > m) m = s.rtt;
    return m;
  }

  add(rtt: number, now: number): void {
    if (!(rtt >= 0 && rtt < MAX_SAMPLE_MS)) return;
    this.samples.push({ at: now, rtt });
    while (this.samples.length > 0 && now - this.samples[0].at > PEAK_WINDOW_MS) this.samples.shift();
    if (this.ema === 0) {
      this.ema = rtt;
      return;
    }
    if (rtt > STALE_PONG_MS && this.ema < HEALTHY_MS && this.ignored < MAX_IGNORED_IN_A_ROW) {
      this.ignored++;
      this.ignoredTotal++;
      return;
    }
    this.ignored = 0;
    const capped = Math.min(rtt, this.ema * GROWTH_X + GROWTH_PLUS_MS);
    this.ema = this.ema * (1 - ALPHA) + capped * ALPHA;
  }
}
