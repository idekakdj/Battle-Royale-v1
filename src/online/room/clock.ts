/**
 * Time source for the room layer. Production uses real timers; tests drive a `LoopbackNetwork`'s manual clock so
 * heartbeats, silence timeouts and handshakes are fully deterministic (`loopbackClock(net)`; advance with `net.advance`).
 */

import type { LoopbackNetwork } from '../transport/loopback';

export interface RoomClock {
  /** Monotonic milliseconds. */
  now(): number;
  /** One-shot timer; returns a cancel function. */
  after(ms: number, fn: () => void): () => void;
  /** Repeating timer; returns a cancel function. */
  every(ms: number, fn: () => void): () => void;
}

export const realClock: RoomClock = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  after(ms, fn) {
    const h = setTimeout(fn, ms);
    return () => clearTimeout(h);
  },
  every(ms, fn) {
    const h = setInterval(fn, ms);
    return () => clearInterval(h);
  },
};

/** A clock that runs on the loopback network's manual time (`net.now`, `net.advance`). */
export function loopbackClock(net: LoopbackNetwork): RoomClock {
  return {
    now: () => net.now,
    after(ms, fn) {
      let live = true;
      net.schedule(ms, () => {
        if (live) fn();
      });
      return () => {
        live = false;
      };
    },
    every(ms, fn) {
      let live = true;
      const arm = (): void => {
        net.schedule(ms, () => {
          if (!live) return;
          fn();
          if (live) arm();
        });
      };
      arm();
      return () => {
        live = false;
      };
    },
  };
}
