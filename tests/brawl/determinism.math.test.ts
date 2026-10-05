import { describe, expect, it } from 'vitest';
import { datan, datan2, dcos, dhypot, dsin, dtan } from '../../src/brawl/sim/dmath';

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('dmath: deterministic replacements for Math.*', () => {
  it('sin / cos agree with Math within 1e-12 over +-6000 rad (budget: 1e-9)', () => {
    let es = 0;
    let ec = 0;
    for (let i = -200000; i <= 200000; i++) {
      const x = i * 0.0317;
      es = Math.max(es, Math.abs(dsin(x) - Math.sin(x)));
      ec = Math.max(ec, Math.abs(dcos(x) - Math.cos(x)));
    }
    expect(es).toBeLessThan(1e-12);
    expect(ec).toBeLessThan(1e-12);
  });

  it('is exact where it matters: symmetry, quadrants, identities', () => {
    for (const x of [0, 0.1, 0.5, 1, 1.5707963267948966, 2, 3.141592653589793, 4.5, 6.283185307179586, 100.25, 1234.5]) {
      expect(dsin(-x) + dsin(x)).toBe(0);
      expect(dcos(-x)).toBe(dcos(x));
      expect(Math.abs(dsin(x) * dsin(x) + dcos(x) * dcos(x) - 1)).toBeLessThan(1e-15);
    }
    expect(dsin(0)).toBe(0);
    expect(dcos(0)).toBe(1);
    expect(Math.abs(dsin(Math.PI / 2) - 1)).toBeLessThan(1e-15);
    expect(dcos(Math.PI)).toBeCloseTo(-1, 14);
    expect(Math.abs(dsin(Math.PI))).toBeLessThan(1e-15);
  });

  it('non-finite input gives NaN, huge input stays finite and bounded', () => {
    expect(dsin(NaN)).toBeNaN();
    expect(dcos(Infinity)).toBeNaN();
    for (const x of [1e7, -3e8, 1e12]) {
      expect(Math.abs(dsin(x))).toBeLessThanOrEqual(1.0000001);
      expect(Math.abs(dcos(x))).toBeLessThanOrEqual(1.0000001);
    }
    expect(Math.abs(dsin(1e5) - Math.sin(1e5))).toBeLessThan(1e-9);
  });

  it('atan / atan2 / tan / hypot agree with Math', () => {
    const r = lcg(99);
    let ea = 0;
    for (let i = -100000; i <= 100000; i++) ea = Math.max(ea, Math.abs(datan(i * 0.01) - Math.atan(i * 0.01)));
    expect(ea).toBeLessThan(1e-12);
    let e2 = 0;
    let eh = 0;
    let et = 0;
    for (let i = 0; i < 100000; i++) {
      const y = (r() - 0.5) * 40;
      const x = (r() - 0.5) * 40;
      e2 = Math.max(e2, Math.abs(datan2(y, x) - Math.atan2(y, x)));
      eh = Math.max(eh, Math.abs(dhypot(x, y) - Math.hypot(x, y)));
      const t = (r() - 0.5) * 2.8;
      et = Math.max(et, Math.abs(dtan(t) - Math.tan(t)) / Math.max(1, Math.abs(Math.tan(t))));
    }
    expect(e2).toBeLessThan(1e-12);
    expect(eh).toBeLessThan(1e-12);
    expect(et).toBeLessThan(1e-12);
    expect(datan2(0, 0)).toBe(0);
    expect(datan2(1, 0)).toBeCloseTo(Math.PI / 2, 14);
    expect(datan2(-1, 0)).toBeCloseTo(-Math.PI / 2, 14);
    expect(datan2(0, -1)).toBeCloseTo(Math.PI, 14);
  });

  it('the angles the sim actually uses (whole degrees) match Math to 1e-15', () => {
    let worst = 0;
    for (let deg = 0; deg < 360; deg++) {
      const rad = (deg * Math.PI) / 180;
      worst = Math.max(worst, Math.abs(dcos(rad) - Math.cos(rad)), Math.abs(dsin(rad) - Math.sin(rad)));
    }
    expect(worst).toBeLessThan(1e-15);
  });
});
