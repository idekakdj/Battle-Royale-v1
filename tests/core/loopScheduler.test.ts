/**
 * v1.10.1 (WP-L2): the pure loop-scheduling logic - the time-driven fixed stepper, the hidden-page drive policy and the relaxed
 * render pace of a hidden page. No DOM, no timers: a fake clock is just numbers.
 */

import { describe, expect, it } from 'vitest';
import {
  FIXED_DT,
  FixedStepper,
  HIDDEN_RENDER_MS,
  HIDDEN_TICK_MS,
  HiddenRenderGate,
  MAX_STEPS_PER_FRAME,
  shouldDriveFromWorker,
} from '../../src/core/loopScheduler';

const DT_MS = 1000 / 60;

function run(stepper: FixedStepper, times: number[], paused = false): number {
  let steps = 0;
  for (const t of times) stepper.advance(t, paused, () => steps++);
  return steps;
}

describe('FixedStepper', () => {
  it('runs one step per 60 Hz frame and keeps alpha in [0,1)', () => {
    const s = new FixedStepper();
    s.reset(0);
    let steps = 0;
    for (let i = 1; i <= 60; i++) {
      s.advance(i * DT_MS, false, () => steps++);
      expect(s.alpha).toBeGreaterThanOrEqual(0);
      expect(s.alpha).toBeLessThan(1.0001);
    }
    // 60 frames of exactly 1/60 s is one second of sim time (floating point may leave the last step pending).
    expect(steps).toBeGreaterThanOrEqual(59);
    expect(steps).toBeLessThanOrEqual(60);
  });

  it('accumulates sub-step gaps (a 144 Hz display steps only when a full tick is due)', () => {
    const s = new FixedStepper();
    s.reset(0);
    const times: number[] = [];
    for (let t = 1000 / 144; t <= 1000.0001; t += 1000 / 144) times.push(t);
    const steps = run(s, times);
    expect(steps).toBeGreaterThanOrEqual(59);
    expect(steps).toBeLessThanOrEqual(60);
  });

  it('spiral-of-death guard: a long stall runs at most maxSteps and drops the backlog', () => {
    const s = new FixedStepper();
    s.reset(0);
    expect(run(s, [200])).toBe(MAX_STEPS_PER_FRAME);
    expect(s.alpha).toBe(0);
    // the backlog is gone: the very next normal frame is a normal frame
    expect(run(s, [200 + DT_MS + 0.01])).toBe(1);
  });

  it('clamps one gap to 0.25 s of catch-up (a hidden page does not produce a huge dt)', () => {
    const s = new FixedStepper(FIXED_DT, 1000);
    s.reset(0);
    const dt = s.advance(60_000, false, () => undefined);
    expect(dt).toBeCloseTo(0.25, 6);
  });

  it('paused: nothing steps, alpha is 1, the clock still advances (no backlog on resume)', () => {
    const s = new FixedStepper();
    s.reset(0);
    expect(run(s, [100, 200, 300], true)).toBe(0);
    expect(s.alpha).toBe(1);
    // resume: only the time since the last (paused) advance counts
    expect(run(s, [300 + DT_MS + 0.01])).toBe(1);
  });

  it('an older timestamp is "no time passed", never negative time, and never moves the clock back', () => {
    const s = new FixedStepper();
    s.reset(1000);
    expect(run(s, [1000 + DT_MS + 0.01])).toBe(1);
    const before = s.clock;
    const dt = s.advance(before - 5, false, () => {
      throw new Error('must not step');
    });
    expect(dt).toBe(0);
    expect(s.clock).toBe(before);
  });

  it('hand-over rAF -> worker -> rAF consumes each wall-clock moment once (no double steps, no lurch)', () => {
    // Reference: one source ticking every 16.67 ms for 3 s.
    const ref = new FixedStepper();
    ref.reset(0);
    const refSteps = run(ref, Array.from({ length: 180 }, (_, i) => (i + 1) * DT_MS));

    // Mixed: visible rAF frames until t = 1 s, hidden (Worker ticks every 16 ms, performance.now() reads) until t = 2 s, then rAF
    // again with frame-start stamps that lag the worker's last read by a few ms (the real-world race).
    const mixed = new FixedStepper();
    mixed.reset(0);
    let steps = 0;
    const adv = (t: number): void => {
      mixed.advance(t, false, () => steps++);
    };
    for (let t = DT_MS; t <= 1000; t += DT_MS) adv(t); // rAF
    for (let t = 1000 + 16; t <= 2000; t += 16) adv(t); // Worker (hidden)
    adv(2000 - 7); // first rAF frame after the hand-back carries an OLDER stamp
    for (let t = 2000 + DT_MS; t <= 3000; t += DT_MS) adv(t); // rAF again
    // Same wall-clock span, so the same number of steps (+/- one pending tick), never more.
    expect(Math.abs(steps - refSteps)).toBeLessThanOrEqual(2);
    expect(steps).toBeLessThanOrEqual(refSteps + 1);
  });

  it('no catch-up lurch on the first rAF frame after a worker-driven stretch', () => {
    const s = new FixedStepper();
    s.reset(0);
    let t = 0;
    for (let i = 0; i < 300; i++) {
      t += 16;
      s.advance(t, false, () => undefined); // 4.8 s hidden, worker-pumped
    }
    let steps = 0;
    s.advance(t + 17, false, () => steps++); // first visible frame
    expect(steps).toBeLessThanOrEqual(2);
  });
});

describe('shouldDriveFromWorker', () => {
  it('only a hidden page that must be kept alive is driven from the Worker', () => {
    expect(shouldDriveFromWorker({ hidden: true, keepAlive: true })).toBe(true);
    expect(shouldDriveFromWorker({ hidden: true, keepAlive: false })).toBe(false); // offline: pauses with the page, as before
    expect(shouldDriveFromWorker({ hidden: false, keepAlive: true })).toBe(false); // visible: rAF
    expect(shouldDriveFromWorker({ hidden: false, keepAlive: false })).toBe(false);
  });
});

describe('HiddenRenderGate', () => {
  it('releases accumulated time only once the relaxed period has passed', () => {
    const g = new HiddenRenderGate(0.05);
    g.add(0.016);
    expect(g.take()).toBe(0);
    g.add(0.016);
    g.add(0.016);
    g.add(0.016);
    const dt = g.take();
    expect(dt).toBeCloseTo(0.064, 6);
    expect(g.take()).toBe(0);
  });

  it('constants are sane: the Worker tick is under one sim step and the hidden render pace is slower than 30 Hz', () => {
    expect(HIDDEN_TICK_MS).toBeLessThanOrEqual(1000 / 60);
    expect(HIDDEN_RENDER_MS).toBeGreaterThanOrEqual(1000 / 30);
  });
});
