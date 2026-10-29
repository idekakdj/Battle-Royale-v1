/**
 * WorkerTicker (v1.10.1, WP-L2): a periodic tick that keeps firing while the page is hidden.
 *
 * A hidden tab stops `requestAnimationFrame` and throttles main-thread timers to 1 Hz (and to one per minute after a few minutes).
 * A dedicated Worker's `setInterval` is not throttled that way, and a `postMessage` from it is an ordinary task, so an inline Blob
 * Worker that posts a message every ~16 ms is a reliable heartbeat for the online Battle Royale host (its sim, bots, snapshots and pongs
 * run in the render loop). Falls back to a main-thread `setInterval` when Workers or Blob URLs are unavailable (or blocked by a
 * CSP): throttled when hidden, but never worse than having no keep-alive at all.
 *
 * The Blob worker needs `worker-src blob:` where a CSP is set (the packaged desktop app already allows it).
 */

export interface Ticker {
  /** Call `cb` roughly every `intervalMs`. Restarts if already running. */
  start(cb: () => void, intervalMs: number): void;
  stop(): void;
  /** Which mechanism is live (QA / diagnostics). */
  readonly kind: 'worker' | 'interval' | 'none';
}

const WORKER_SOURCE = `let id = 0;
onmessage = (e) => {
  if (id) clearInterval(id);
  id = 0;
  if (e.data > 0) id = setInterval(() => postMessage(0), e.data);
};`;

export function createWorkerTicker(): Ticker {
  let worker: Worker | null = null;
  let url: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let kind: Ticker['kind'] = 'none';

  const release = (): void => {
    if (worker !== null) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      worker = null;
    }
    if (url !== null) {
      URL.revokeObjectURL(url);
      url = null;
    }
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    kind = 'none';
  };

  const startInterval = (cb: () => void, intervalMs: number): void => {
    release();
    timer = setInterval(cb, intervalMs);
    kind = 'interval';
  };

  return {
    start(cb, intervalMs) {
      release();
      try {
        if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') throw new Error('no worker support');
        url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
        const w = new Worker(url);
        worker = w;
        w.onmessage = () => cb();
        // A CSP block or a failed spawn is reported asynchronously: degrade to the throttled main-thread timer.
        w.onerror = () => startInterval(cb, intervalMs);
        w.postMessage(intervalMs);
        kind = 'worker';
      } catch {
        startInterval(cb, intervalMs);
      }
    },
    stop() {
      release();
    },
    get kind() {
      return kind;
    },
  };
}
