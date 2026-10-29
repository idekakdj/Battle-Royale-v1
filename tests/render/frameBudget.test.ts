/**
 * v1.10.1 (WP-L2): the pure frame-time watchdog behind automatic quality lowering, and the per-match quality ceiling
 * (`lowerForSession`) it drives for online matches.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  AUTO_SLOW_FRAME_MS,
  FrameBudgetMonitor,
  MAX_SAMPLE_S,
  ONLINE_SLOW_FRAME_MS,
  SLOW_SECONDS,
  WARMUP_BUCKETS,
} from '../../src/render/frameBudget';
import {
  autoDowngrade,
  clearSessionCap,
  getQualitySetting,
  getQualityTier,
  getSessionCap,
  lowerForSession,
  minTier,
  onQualityChange,
  setQualitySetting,
  type QualityChangeReason,
  type QualityTier,
} from '../../src/render/quality';

// Frame times chosen so 1 s buckets close on exact frame counts (powers of two are exact in floating point).
const FAST = 1 / 128; // 7.8 ms, 128 per bucket
const SLOW = 1 / 32; // 31.25 ms, 32 per bucket (well above 22 ms)

/** Feed `n` frames of `dtS` seconds; returns how many times the monitor said "lower the tier". */
function feedN(m: FrameBudgetMonitor, n: number, dtS: number, armed = true): number {
  let triggers = 0;
  for (let i = 0; i < n; i++) if (m.sample(dtS, armed)) triggers++;
  return triggers;
}
const fastSeconds = (m: FrameBudgetMonitor, sec: number): number => feedN(m, sec * 128, FAST);
const slowSeconds = (m: FrameBudgetMonitor, sec: number): number => feedN(m, sec * 32, SLOW);

describe('FrameBudgetMonitor', () => {
  it('stays quiet at a healthy frame rate, however long it runs', () => {
    const m = new FrameBudgetMonitor({ slowFrameMs: ONLINE_SLOW_FRAME_MS });
    expect(fastSeconds(m, 60)).toBe(0);
    expect(m.fps).toBeCloseTo(128, 0);
    expect(m.avgMs).toBeCloseTo(7.8, 0);
  });

  it('a start-up hitch (the first-frames shader compile) is absorbed by the warm-up', () => {
    const m = new FrameBudgetMonitor({ slowFrameMs: ONLINE_SLOW_FRAME_MS });
    expect(slowSeconds(m, 3)).toBe(0); // the first 3 buckets are never judged
    expect(fastSeconds(m, 20)).toBe(0);
  });

  it('triggers once when the average frame time stays above 22 ms for 3 s (after the warm-up)', () => {
    const m = new FrameBudgetMonitor({ slowFrameMs: ONLINE_SLOW_FRAME_MS });
    fastSeconds(m, 3); // warm-up buckets
    expect(slowSeconds(m, SLOW_SECONDS)).toBe(1); // exactly one verdict, not one per slow frame
  });

  it('does not trigger for slow stretches shorter than 3 s, and a fast second resets the streak', () => {
    const m = new FrameBudgetMonitor({ slowFrameMs: ONLINE_SLOW_FRAME_MS });
    fastSeconds(m, 3);
    expect(slowSeconds(m, 2)).toBe(0);
    expect(fastSeconds(m, 1)).toBe(0);
    expect(slowSeconds(m, 2)).toBe(0);
  });

  it('after a verdict it warms up again before judging the new tier (never lowers twice in a burst)', () => {
    const m = new FrameBudgetMonitor({ slowFrameMs: ONLINE_SLOW_FRAME_MS });
    fastSeconds(m, 3);
    expect(slowSeconds(m, 3)).toBe(1);
    // still slow right after the change: 3 warm-up buckets + 3 slow buckets must pass before the next verdict
    expect(slowSeconds(m, 5)).toBe(0);
    expect(slowSeconds(m, 1)).toBe(1);
  });

  it('restartWarmup() (a tier change) skips the next buckets and drops the streak', () => {
    const m = new FrameBudgetMonitor({ slowFrameMs: ONLINE_SLOW_FRAME_MS });
    fastSeconds(m, 3);
    slowSeconds(m, 2);
    m.restartWarmup();
    expect(slowSeconds(m, 3)).toBe(0); // all three buckets are warm-up
    expect(slowSeconds(m, 3)).toBe(1);
  });

  it('is silent when not armed (a fixed quality setting offline) but still measures fps', () => {
    const m = new FrameBudgetMonitor({ slowFrameMs: ONLINE_SLOW_FRAME_MS });
    expect(feedN(m, 32 * 30, SLOW, false)).toBe(0);
    expect(m.fps).toBeCloseTo(32, 0);
  });

  it('ignores stalls (>= 0.5 s: a hidden tab, a debugger) and bad samples', () => {
    const m = new FrameBudgetMonitor({ slowFrameMs: ONLINE_SLOW_FRAME_MS });
    fastSeconds(m, 3);
    for (let i = 0; i < 20; i++) expect(m.sample(MAX_SAMPLE_S, true)).toBe(false);
    expect(m.sample(0, true)).toBe(false);
    expect(m.sample(-1, true)).toBe(false);
    expect(m.sample(Number.NaN, true)).toBe(false);
    expect(fastSeconds(m, 5)).toBe(0);
  });

  it('thresholds: ~22 ms (online) is a little stricter than the 45 fps of the auto setting', () => {
    expect(ONLINE_SLOW_FRAME_MS).toBe(22);
    expect(AUTO_SLOW_FRAME_MS).toBeCloseTo(22.22, 2);
    const online = new FrameBudgetMonitor({ slowFrameMs: ONLINE_SLOW_FRAME_MS });
    const auto = new FrameBudgetMonitor({ slowFrameMs: AUTO_SLOW_FRAME_MS });
    for (const m of [online, auto]) fastSeconds(m, 3);
    // 22.1 ms frames: 46 per 1 s bucket, 3 judged seconds
    expect(feedN(online, 46 * 3, 0.0221)).toBe(1);
    expect(feedN(auto, 46 * 3, 0.0221)).toBe(0); // 45.2 fps: fine for the auto setting
  });

  it('the threshold can be tightened on a live monitor (SceneManager.setOnlineGuard)', () => {
    const m = new FrameBudgetMonitor();
    expect(m.slowFrameMs).toBeCloseTo(AUTO_SLOW_FRAME_MS, 5);
    m.slowFrameMs = ONLINE_SLOW_FRAME_MS;
    fastSeconds(m, 3);
    expect(feedN(m, 46 * 3, 0.0221)).toBe(1);
  });

  it('warm-up constant matches the old inline logic (2.5 buckets = 3 ignored seconds)', () => {
    expect(WARMUP_BUCKETS).toBe(2.5);
    expect(SLOW_SECONDS).toBe(3);
  });
});

describe('per-match quality ceiling (lowerForSession)', () => {
  beforeEach(() => {
    clearSessionCap();
    setQualitySetting('high');
  });

  it('steps a fixed tier down one level at a time, never below low, and never touches the setting', () => {
    expect(getQualityTier()).toBe('high');
    expect(lowerForSession()).toBe(true);
    expect(getQualityTier()).toBe('medium');
    expect(getQualitySetting()).toBe('high'); // the player's choice is untouched
    expect(lowerForSession()).toBe(true);
    expect(getQualityTier()).toBe('low');
    expect(lowerForSession()).toBe(false);
    expect(getQualityTier()).toBe('low');
    expect(getSessionCap()).toBe('low');
  });

  it('tells listeners it was automatic (the toast), and a user change is not', () => {
    const seen: Array<{ tier: QualityTier; reason: QualityChangeReason | undefined }> = [];
    const off = onQualityChange((tier, _s, reason) => seen.push({ tier, reason }));
    lowerForSession();
    setQualitySetting('low');
    off();
    expect(seen[0]).toEqual({ tier: 'medium', reason: 'auto' });
    expect(seen[1]).toEqual({ tier: 'low', reason: 'user' });
  });

  it('ends with the match: clearSessionCap() restores the player\'s tier', () => {
    lowerForSession();
    expect(getQualityTier()).toBe('medium');
    clearSessionCap();
    expect(getSessionCap()).toBeNull();
    expect(getQualityTier()).toBe('high');
  });

  it('picking a setting (even the same one) wins over the ceiling', () => {
    lowerForSession();
    setQualitySetting('high');
    expect(getQualityTier()).toBe('high');
    expect(getSessionCap()).toBeNull();
  });

  it('works on top of the auto tier too, and autoDowngrade still reports "auto"', () => {
    setQualitySetting('auto');
    const reasons: Array<QualityChangeReason | undefined> = [];
    const off = onQualityChange((_t, _s, r) => reasons.push(r));
    expect(autoDowngrade()).toBe(true);
    expect(getQualityTier()).toBe('medium');
    off();
    expect(reasons).toEqual(['auto']);
    clearSessionCap();
    setQualitySetting('high'); // leave the module in a neutral state for other tests in this process
  });

  it('minTier picks the lower tier', () => {
    expect(minTier('high', 'medium')).toBe('medium');
    expect(minTier('low', 'high')).toBe('low');
    expect(minTier('medium', 'medium')).toBe('medium');
  });
});
