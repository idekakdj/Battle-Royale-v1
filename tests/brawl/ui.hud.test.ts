import { describe, expect, it } from 'vitest';
import {
  PERCENT_STOPS,
  bumpScale,
  countdownStep,
  edgeMarker,
  formatPercent,
  formatTimer,
  koBannerText,
  percentColor,
  percentRgb,
} from '../../src/brawl/ui/hudMath';

describe('HUD percent colour ramp', () => {
  it('hits the stops: white 0, yellow 60, orange 100, red 150, dark red 200+', () => {
    expect(percentRgb(0)).toEqual([255, 255, 255]);
    expect(percentRgb(60)).toEqual([...PERCENT_STOPS[1].rgb]);
    expect(percentRgb(100)).toEqual([...PERCENT_STOPS[2].rgb]);
    expect(percentRgb(150)).toEqual([...PERCENT_STOPS[3].rgb]);
    expect(percentRgb(200)).toEqual([...PERCENT_STOPS[4].rgb]);
    expect(percentRgb(999)).toEqual([...PERCENT_STOPS[4].rgb]);
    expect(percentColor(0)).toBe('rgb(255, 255, 255)');
  });

  it('is a continuous interpolation between stops (green never increases past 60%)', () => {
    const mid = percentRgb(30);
    expect(mid[0]).toBe(255);
    expect(mid[1]).toBeLessThan(255);
    expect(mid[1]).toBeGreaterThan(226);
    let prevG = 256;
    for (let p = 60; p <= 220; p += 5) {
      const g = percentRgb(p)[1];
      expect(g).toBeLessThanOrEqual(prevG);
      prevG = g;
    }
  });

  it('is robust to junk', () => {
    expect(percentRgb(-50)).toEqual([255, 255, 255]);
    expect(percentRgb(Number.NaN)).toEqual([255, 255, 255]);
  });
});

describe('HUD formatting', () => {
  it('formatPercent shows the floor, clamped to 0..999', () => {
    expect(formatPercent(0)).toBe('0');
    expect(formatPercent(47.9)).toBe('47');
    expect(formatPercent(-3)).toBe('0');
    expect(formatPercent(5000)).toBe('999');
    expect(formatPercent(Number.NaN)).toBe('0');
  });

  it('formatTimer: infinity for no limit, m:ss otherwise (ceil so 0:00 means time up)', () => {
    expect(formatTimer(null)).toBe('∞');
    expect(formatTimer(300)).toBe('5:00');
    expect(formatTimer(61)).toBe('1:01');
    expect(formatTimer(59.2)).toBe('1:00');
    expect(formatTimer(9.01)).toBe('0:10');
    expect(formatTimer(0)).toBe('0:00');
    expect(formatTimer(-5)).toBe('0:00');
  });

  it('countdownStep: 3 / 2 / 1 while the countdown runs, FIGHT briefly after, then nothing', () => {
    expect(countdownStep(3, -3)).toBe(3);
    expect(countdownStep(2.5, -2.5)).toBe(3);
    expect(countdownStep(2.0, -2)).toBe(2);
    expect(countdownStep(1.01, -1)).toBe(2);
    expect(countdownStep(1.0, -1)).toBe(1);
    expect(countdownStep(0.02, 0)).toBe(1);
    expect(countdownStep(0, 0)).toBe('FIGHT');
    expect(countdownStep(0, 0.5)).toBe('FIGHT');
    expect(countdownStep(0, 2)).toBeNull();
  });

  it('bumpScale grows with damage and is capped', () => {
    expect(bumpScale(2)).toBeLessThan(bumpScale(12));
    expect(bumpScale(1000)).toBeCloseTo(1.62, 5);
    expect(bumpScale(Number.NaN)).toBeCloseTo(1.12, 5);
  });

  it('KO banner text', () => {
    expect(koBannerText('Lion', 'Gorilla')).toBe("Lion was KO'd by Gorilla");
    expect(koBannerText('Lion', null)).toBe('Lion fell');
  });
});

describe('off-screen markers', () => {
  it('clamps to the inset rectangle and points toward the target', () => {
    const e = edgeMarker(2000, 300, 1280, 720, 46, 110);
    expect(e.x).toBe(1280 - 46);
    expect(e.y).toBe(300);
    expect(Math.abs(e.angle)).toBeLessThan(0.5); // pointing right
    const below = edgeMarker(640, 5000, 1280, 720, 46, 110);
    expect(below.y).toBe(720 - 46 - 110);
    expect(below.angle).toBeCloseTo(Math.PI / 2, 5);
    const above = edgeMarker(640, -400, 1280, 720, 46, 110);
    expect(above.y).toBe(46);
    expect(above.angle).toBeCloseTo(-Math.PI / 2, 5);
  });
});
