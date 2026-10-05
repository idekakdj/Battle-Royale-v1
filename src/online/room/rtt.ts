/**
 * Round-trip-time smoothing shared by the room heartbeat and the Champions League rollback session.
 *
 * A plain EWMA lets ONE huge sample poison the estimate for ten seconds: when a page freezes for a second or two (the first
 * rendered frame of a match compiles shaders; the pong is simply answered late) the lobby showed "855 ms" and the rollback
 * session asked for the maximum input delay long after the freeze was over. So an established estimate can grow by at most
 * 3x + 100 ms per sample — a real latency jump still converges within a handful of samples, a one-off stall barely registers.
 */

export const RTT_ALPHA = 0.2;

/** `prev` = current estimate (0 = none yet), `sample` = new measurement in ms. Returns the new estimate. */
export function smoothRtt(prev: number, sample: number): number {
  if (!(prev > 0)) return sample;
  const capped = Math.min(sample, prev * 3 + 100);
  return prev * (1 - RTT_ALPHA) + capped * RTT_ALPHA;
}
