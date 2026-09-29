import { describe, expect, it } from 'vitest';
import {
  AIM_ASSIST,
  assistAimYaw,
  cycleLockTarget,
  pickLockTarget,
  yawTo,
  type AimTarget,
} from '../../src/match/aimAssist';

const DEG = Math.PI / 180;

function at(id: number, x: number, z: number, valid = true): AimTarget {
  return { id, x, z, valid };
}

/** Target at polar (yaw, dist) around the origin. */
function polar(id: number, yawDeg: number, dist: number, valid = true): AimTarget {
  const y = yawDeg * DEG;
  return at(id, Math.sin(y) * dist, Math.cos(y) * dist, valid);
}

describe('yawTo', () => {
  it('matches the sim convention: yaw faces (sin y, cos y)', () => {
    expect(yawTo(0, 0, 0, 5)).toBeCloseTo(0);
    expect(yawTo(0, 0, 5, 0)).toBeCloseTo(Math.PI / 2);
    expect(yawTo(0, 0, -5, 0)).toBeCloseTo(-Math.PI / 2);
    expect(Math.abs(yawTo(0, 0, 0, -5))).toBeCloseTo(Math.PI);
  });
});

describe('assistAimYaw', () => {
  const range = 2.2; // lion reach → assist reach 3.08 m

  it('snaps fully onto a target inside the nudge limit', () => {
    const t = [polar(1, 15, 2.5)];
    expect(assistAimYaw(0, 0, 0, t, 1, range)).toBeCloseTo(15 * DEG, 5);
  });

  it('caps the correction at 25 degrees for a target at 35 degrees', () => {
    const t = [polar(1, 35, 2.5)];
    expect(assistAimYaw(0, 0, 0, t, 1, range)).toBeCloseTo(AIM_ASSIST.maxNudge, 5);
    const left = [polar(1, -35, 2.5)];
    expect(assistAimYaw(0, 0, 0, left, 1, range)).toBeCloseTo(-AIM_ASSIST.maxNudge, 5);
  });

  it('ignores targets outside the 40 degree cone', () => {
    const t = [polar(1, 45, 2)];
    expect(assistAimYaw(0, 0, 0, t, 1, range)).toBe(0);
    // Same target, aim turned to 0.3 rad (~17°): now 28° off → assisted.
    expect(assistAimYaw(0.3, 0, 0, t, 1, range)).toBeCloseTo(0.3 + AIM_ASSIST.maxNudge, 5);
    const behind = [polar(1, 180, 1.5)];
    expect(assistAimYaw(0, 0, 0, behind, 1, range)).toBe(0);
  });

  it('ignores targets beyond 1.4x the attack range', () => {
    const t = [polar(1, 10, range * 1.4 + 0.05)];
    expect(assistAimYaw(0, 0, 0, t, 1, range)).toBe(0);
    const inside = [polar(1, 10, range * 1.4 - 0.05)];
    expect(assistAimYaw(0, 0, 0, inside, 1, range)).toBeCloseTo(10 * DEG, 5);
  });

  it('skips invalid (dead / hidden) targets and respects count', () => {
    const t = [polar(1, 10, 2, false), polar(2, -20, 2)];
    expect(assistAimYaw(0, 0, 0, t, 2, range)).toBeCloseTo(-20 * DEG, 5);
    expect(assistAimYaw(0, 0, 0, t, 1, range)).toBe(0);
  });

  it('prefers the target closest to the aim line', () => {
    const t = [polar(1, 30, 2), polar(2, 5, 2.4)];
    expect(assistAimYaw(0, 0, 0, t, 2, range)).toBeCloseTo(5 * DEG, 5);
  });

  it('works relative to the fighter position and across the ±π seam', () => {
    // Fighter at (10, -4) aiming ~south (179°); target 6° further round (−175°).
    const aim = 179 * DEG;
    const ty = -175 * DEG;
    const t = [at(1, 10 + Math.sin(ty) * 2, -4 + Math.cos(ty) * 2)];
    const out = assistAimYaw(aim, 10, -4, t, 1, range);
    expect(out).toBeCloseTo(ty, 5);
    expect(out).toBeGreaterThanOrEqual(-Math.PI);
    expect(out).toBeLessThanOrEqual(Math.PI);
  });

  it('never moves the aim by more than maxNudge', () => {
    for (let deg = -40; deg <= 40; deg += 5) {
      const out = assistAimYaw(1, 0, 0, [polar(1, deg + 1 / DEG, 2)], 1, range);
      const delta = Math.abs(Math.atan2(Math.sin(out - 1), Math.cos(out - 1)));
      expect(delta).toBeLessThanOrEqual(AIM_ASSIST.maxNudge + 1e-9);
    }
  });
});

describe('pickLockTarget', () => {
  it('prefers an enemy in front over a nearer one behind', () => {
    const t = [polar(1, 180, 3), polar(2, 10, 9)];
    expect(pickLockTarget(0, 0, 0, t, 2)).toBe(2);
  });

  it('falls back to a target behind when nothing is in front', () => {
    const t = [polar(1, 170, 6)];
    expect(pickLockTarget(0, 0, 0, t, 1)).toBe(1);
  });

  it('returns -1 when every target is out of range or invalid', () => {
    const t = [polar(1, 0, 25), polar(2, 0, 5, false)];
    expect(pickLockTarget(0, 0, 0, t, 2)).toBe(-1);
  });
});

describe('cycleLockTarget', () => {
  const t = [polar(1, 0, 4), polar(2, 90, 8), polar(3, -90, 12), polar(4, 0, 30), polar(5, 45, 6, false)];

  it('steps to the next nearest enemy and wraps to the nearest', () => {
    expect(cycleLockTarget(1, 0, 0, t, t.length)).toBe(2);
    expect(cycleLockTarget(2, 0, 0, t, t.length)).toBe(3);
    expect(cycleLockTarget(3, 0, 0, t, t.length)).toBe(1); // 4 is beyond 20 m
  });

  it('picks the nearest when the current lock is gone', () => {
    expect(cycleLockTarget(-1, 0, 0, t, t.length)).toBe(1);
    expect(cycleLockTarget(5, 0, 0, t, t.length)).toBe(1);
  });

  it('keeps the only candidate and returns -1 with none', () => {
    const one = [polar(7, 0, 5)];
    expect(cycleLockTarget(7, 0, 0, one, 1)).toBe(7);
    expect(cycleLockTarget(7, 0, 0, [], 0)).toBe(-1);
  });

  it('breaks equal-distance ties by id without looping', () => {
    const ring = [polar(1, 0, 5), polar(2, 120, 5), polar(3, -120, 5)];
    expect(cycleLockTarget(1, 0, 0, ring, 3)).toBe(2);
    expect(cycleLockTarget(2, 0, 0, ring, 3)).toBe(3);
    expect(cycleLockTarget(3, 0, 0, ring, 3)).toBe(1);
  });
});
