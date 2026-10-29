/**
 * v1.10.1 (WP-L2): WorkerTicker's fallback path. Node has no global `Worker`, so this exercises the "Workers unavailable / blocked by
 * a CSP" branch: a plain main-thread interval (throttled in a hidden browser tab, but never worse than no keep-alive at all).
 * The real Blob Worker path was checked in the browser (see docs/ONLINE-NOTES.md).
 */

import { describe, expect, it } from 'vitest';
import { createWorkerTicker } from '../../src/core/WorkerTicker';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('createWorkerTicker (no Worker available)', () => {
  it('falls back to an interval, ticks, and stops cleanly', async () => {
    const t = createWorkerTicker();
    expect(t.kind).toBe('none');
    let n = 0;
    t.start(() => n++, 5);
    expect(t.kind).toBe('interval');
    await sleep(60);
    expect(n).toBeGreaterThan(3);
    t.stop();
    expect(t.kind).toBe('none');
    const after = n;
    await sleep(40);
    expect(n).toBe(after);
  });

  it('start() again replaces the previous timer (no double ticking)', async () => {
    const t = createWorkerTicker();
    let a = 0;
    let b = 0;
    t.start(() => a++, 5);
    t.start(() => b++, 5);
    await sleep(50);
    t.stop();
    expect(a).toBe(0);
    expect(b).toBeGreaterThan(2);
  });
});
