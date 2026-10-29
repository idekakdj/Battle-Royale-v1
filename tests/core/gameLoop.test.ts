/**
 * v1.10.1 (WP-L2): GameLoop with a fake browser (rAF queue, clock, visibility, Worker ticker). Proves the hidden-page keep-alive:
 * the online host keeps stepping from the Worker timer while hidden (no drawing), hands back to rAF without double stepping, and an
 * offline match still freezes with the page.
 */

import { describe, expect, it } from 'vitest';
import { GameLoop, type LoopEnv } from '../../src/core/GameLoop';
import type { Ticker } from '../../src/core/WorkerTicker';

class FakeTicker implements Ticker {
  cb: (() => void) | null = null;
  intervalMs = 0;
  starts = 0;
  stops = 0;
  kind: Ticker['kind'] = 'none';
  start(cb: () => void, intervalMs: number): void {
    this.cb = cb;
    this.intervalMs = intervalMs;
    this.starts++;
    this.kind = 'worker';
  }
  stop(): void {
    this.cb = null;
    this.stops++;
    this.kind = 'none';
  }
}

class FakeBrowser {
  clock = 0;
  hidden = false;
  rafCb: ((t: number) => void) | null = null;
  rafCancelled = 0;
  tickers: FakeTicker[] = [];
  private visListener: (() => void) | null = null;
  unsubscribed = 0;

  readonly env: LoopEnv = {
    raf: (cb) => {
      this.rafCb = cb;
      return 1;
    },
    caf: () => {
      this.rafCb = null;
      this.rafCancelled++;
    },
    now: () => this.clock,
    isHidden: () => this.hidden,
    onVisibilityChange: (cb) => {
      this.visListener = cb;
      return () => {
        this.visListener = null;
        this.unsubscribed++;
      };
    },
    createTicker: () => {
      const t = new FakeTicker();
      this.tickers.push(t);
      return t;
    },
  };

  /** One display frame: only fires if rAF is live (a hidden page gets none). */
  frame(ms = 1000 / 60, stampLagMs = 0): void {
    this.clock += ms;
    const cb = this.rafCb;
    if (cb !== null && !this.hidden) cb(this.clock - stampLagMs);
  }

  /** The Worker timer fires `n` times, 16 ms apart. */
  workerTicks(n: number, ms = 16): void {
    for (let i = 0; i < n; i++) {
      this.clock += ms;
      const t = this.tickers[this.tickers.length - 1];
      t?.cb?.();
    }
  }

  setHidden(h: boolean): void {
    this.hidden = h;
    this.visListener?.();
  }
}

interface Rec {
  steps: number;
  renders: Array<{ draw: boolean; dt: number }>;
}

function makeLoop(b: FakeBrowser, keepAlive: boolean | undefined): { loop: GameLoop; rec: Rec } {
  const rec: Rec = { steps: 0, renders: [] };
  const loop = new GameLoop({
    step: () => {
      rec.steps++;
    },
    render: (_a, dt, draw) => {
      rec.renders.push({ draw: draw !== false, dt });
    },
    ...(keepAlive === undefined ? {} : { keepAliveWhenHidden: () => keepAlive }),
    env: b.env,
  });
  return { loop, rec };
}

describe('GameLoop - visible', () => {
  it('steps at 60 Hz and draws every frame, like before', () => {
    const b = new FakeBrowser();
    const { loop, rec } = makeLoop(b, undefined);
    loop.start();
    for (let i = 0; i < 120; i++) b.frame();
    expect(rec.steps).toBeGreaterThanOrEqual(118);
    expect(rec.steps).toBeLessThanOrEqual(120);
    expect(rec.renders.length).toBe(120);
    expect(rec.renders.every((r) => r.draw)).toBe(true);
    expect(loop.isWorkerDriven).toBe(false);
    expect(b.tickers.length).toBe(0);
  });

  it('pause freezes stepping, resume leaves no backlog', () => {
    const b = new FakeBrowser();
    const { loop, rec } = makeLoop(b, undefined);
    loop.start();
    for (let i = 0; i < 10; i++) b.frame();
    const before = rec.steps;
    loop.pause();
    for (let i = 0; i < 60; i++) b.frame();
    expect(rec.steps).toBe(before);
    loop.resume();
    b.frame();
    expect(rec.steps - before).toBeLessThanOrEqual(1);
  });
});

describe('GameLoop - hidden page', () => {
  it('OFFLINE (no keep-alive): hiding the page starts no Worker; nothing steps while hidden (it pauses as today)', () => {
    const b = new FakeBrowser();
    const { loop, rec } = makeLoop(b, false);
    loop.start();
    for (let i = 0; i < 30; i++) b.frame();
    b.setHidden(true);
    expect(loop.isWorkerDriven).toBe(false);
    expect(b.tickers.length).toBe(0);
    const frozenAt = rec.steps;
    for (let i = 0; i < 300; i++) b.frame(); // the browser delivers no frames
    expect(rec.steps).toBe(frozenAt);
  });

  it('ONLINE: hiding starts the Worker timer, which keeps stepping (without drawing) and renders at a relaxed pace', () => {
    const b = new FakeBrowser();
    const { loop, rec } = makeLoop(b, true);
    loop.start();
    for (let i = 0; i < 60; i++) b.frame();
    const stepsVisible = rec.steps;
    const rendersVisible = rec.renders.length;
    b.setHidden(true);
    expect(loop.isWorkerDriven).toBe(true);
    expect(loop.tickerKind).toBe('worker');
    expect(b.tickers.length).toBe(1);
    expect(b.tickers[0].intervalMs).toBeLessThanOrEqual(1000 / 60);
    b.workerTicks(625); // 10 s at 16 ms
    const hiddenSteps = rec.steps - stepsVisible;
    expect(hiddenSteps).toBeGreaterThanOrEqual(10 * 60 - 3); // sim time kept up with the wall clock
    expect(hiddenSteps).toBeLessThanOrEqual(10 * 60 + 3);
    const hiddenRenders = rec.renders.slice(rendersVisible);
    expect(hiddenRenders.length).toBeGreaterThan(0);
    expect(hiddenRenders.every((r) => !r.draw)).toBe(true); // nothing is drawn while hidden
    expect(hiddenRenders.length).toBeLessThan(625 / 2); // relaxed pace, not every tick
    expect(hiddenRenders.reduce((a, r) => a + r.dt, 0)).toBeGreaterThan(9); // but no time is lost
  });

  it('ONLINE: becoming visible stops the Worker and rAF takes over the same clock - no double stepping, no lurch', () => {
    const b = new FakeBrowser();
    const { loop, rec } = makeLoop(b, true);
    loop.start();
    for (let i = 0; i < 30; i++) b.frame();
    b.setHidden(true);
    b.workerTicks(125); // 2 s hidden
    const stepsBefore = rec.steps;
    const clockBefore = b.clock;
    b.setHidden(false);
    expect(loop.isWorkerDriven).toBe(false);
    expect(b.tickers[0].stops).toBe(1);
    // a leftover Worker tick that was already queued must not step again
    b.tickers[0].cb?.();
    // first rAF frame after the hand-back carries a stamp that lags the Worker's last clock read by a few ms
    b.frame(1000 / 60, 9);
    for (let i = 0; i < 59; i++) b.frame();
    const wall = (b.clock - clockBefore) / 1000;
    const stepsAfter = rec.steps - stepsBefore;
    expect(stepsAfter).toBeLessThanOrEqual(Math.ceil(wall * 60) + 1); // time is consumed once, never twice
    expect(stepsAfter).toBeGreaterThanOrEqual(Math.floor(wall * 60) - 2); // and no lurch / stall either
    expect(rec.renders[rec.renders.length - 1].draw).toBe(true);
  });

  it('ONLINE: the page may already be hidden when the match starts', () => {
    const b = new FakeBrowser();
    b.hidden = true;
    const { loop, rec } = makeLoop(b, true);
    loop.start();
    expect(loop.isWorkerDriven).toBe(true);
    b.workerTicks(63);
    expect(rec.steps).toBeGreaterThanOrEqual(58);
  });

  it('ONLINE: if rAF keeps firing while hidden (an un-throttled shell) the page is still not drawn, and time is not counted twice', () => {
    const b = new FakeBrowser();
    const { loop, rec } = makeLoop(b, true);
    loop.start();
    b.setHidden(true); // the shell keeps delivering frames although hidden
    // emulate: rAF callbacks continue, plus Worker ticks - interleaved on one clock
    const start = rec.steps;
    for (let i = 0; i < 60; i++) {
      b.clock += 16.67;
      b.rafCb?.(b.clock);
      b.tickers[b.tickers.length - 1]?.cb?.();
    }
    expect(rec.steps - start).toBeLessThanOrEqual(61);
    expect(rec.renders.filter((r) => !r.draw).length).toBeGreaterThan(0);
    expect(rec.renders.filter((r) => r.draw).length).toBe(0);
  });

  it('stop() cancels rAF, stops the Worker, unsubscribes, and ignores late ticks', () => {
    const b = new FakeBrowser();
    const { loop, rec } = makeLoop(b, true);
    loop.start();
    b.setHidden(true);
    const ticker = b.tickers[0];
    const cb = ticker.cb;
    loop.stop();
    expect(ticker.stops).toBe(1);
    expect(b.unsubscribed).toBe(1);
    expect(loop.isRunning).toBe(false);
    const n = rec.steps;
    cb?.(); // a message that was already in flight
    expect(rec.steps).toBe(n);
  });
});
