import { describe, expect, it } from 'vitest';
import { smoothRtt } from '../../src/online/room/rtt';

describe('smoothRtt (QA: a frozen page must not poison the ping for ten seconds)', () => {
  it('starts from the first sample and holds a constant RTT exactly', () => {
    let r = smoothRtt(0, 50);
    expect(r).toBe(50);
    for (let i = 0; i < 20; i++) r = smoothRtt(r, 50);
    expect(r).toBeCloseTo(50, 9);
  });

  it('one multi-second stall (late pong) barely registers and is gone within a few samples', () => {
    let r = 40;
    r = smoothRtt(r, 4000); // the page was frozen while the match scene compiled
    expect(r).toBeLessThan(100); // plain EWMA would say 832 ms
    for (let i = 0; i < 6; i++) r = smoothRtt(r, 40);
    expect(r).toBeLessThan(60);
  });

  it('a real, sustained latency jump still converges quickly', () => {
    let r = 40;
    for (let i = 0; i < 12; i++) r = smoothRtt(r, 300);
    expect(r).toBeGreaterThan(250);
  });
});
