/**
 * Serialisable mulberry32 for the Champions League simulation (online rollback needs to save and restore the RNG).
 * Produces EXACTLY the same stream as `mulberry32(seed)` from `src/core/math.ts` (tests/brawl/determinism.rng.test.ts
 * pins this), but the single 32-bit state word is observable via {@link SimRng.getState} / {@link SimRng.setState}.
 */
export class SimRng {
  private a: number;

  constructor(seed: number) {
    this.a = seed | 0;
  }

  /** Float in [0, 1). */
  next(): number {
    let a = this.a;
    a = (a + 0x6d2b79f5) | 0;
    this.a = a;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** The complete generator state (always a signed 32-bit integer, so the value is canonical). */
  getState(): number {
    return this.a;
  }

  setState(state: number): void {
    this.a = state | 0;
  }
}
