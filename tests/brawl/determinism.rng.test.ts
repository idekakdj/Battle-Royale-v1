import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../src/core/math';
import { SimRng } from '../../src/brawl/sim/rng';

describe('SimRng', () => {
  it('produces exactly the mulberry32 stream for any seed', () => {
    for (const seed of [0, 1, 7, 12345, 0x7fffffff, 0x80000000, 0xdeadbeef, 0xffffffff, 4294967296 + 5, -3]) {
      const a = mulberry32(seed);
      const b = new SimRng(seed);
      for (let i = 0; i < 500; i++) expect(b.next()).toBe(a());
    }
  });

  it('can be saved and restored mid-stream, and the state is canonical', () => {
    const r = new SimRng(0xdeadbeef);
    expect(r.getState()).toBe(0xdeadbeef | 0);
    for (let i = 0; i < 37; i++) r.next();
    const s = r.getState();
    expect(Number.isInteger(s)).toBe(true);
    expect(s | 0).toBe(s);
    const ahead = [r.next(), r.next(), r.next()];
    const r2 = new SimRng(1);
    r2.setState(s);
    expect([r2.next(), r2.next(), r2.next()]).toEqual(ahead);
    // restoring an unsigned representation of the same word gives the same state
    const r3 = new SimRng(0);
    r3.setState(s >>> 0);
    expect(r3.getState()).toBe(s);
  });
});
