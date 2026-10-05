import { describe, expect, it } from 'vitest';
import type { AnimalId } from '../../src/core/types';
import type { BrawlIntent, StageId } from '../../src/brawl/types';
import { idleIntent } from '../../src/brawl/types';
import { PHYS } from '../../src/brawl/config';
import { BrawlWorld } from '../../src/brawl/sim/BrawlWorld';
import { DEFAULT_DATA_SOURCE } from '../../src/brawl/sim/dataSource';
import type { BrawlDataSource } from '../../src/brawl/sim/dataSource';
import { MOVESETS } from '../../src/brawl/data';

/**
 * v1.6: the crocodile's base (ground) jump HEIGHT is doubled (jumpVel 12.5 -> 12.5 x sqrt 2; apex = v^2 / (2 g gravityMult)). The air jump is
 * unchanged. These tests run the real data in the real sim: the apex really doubles, and the crocodile can now reach the 4.2 m / 4.6 m side
 * platforms of both stages with ground jump + air jump (it could not before).
 */

const OLD_JUMP_VEL = 12.5;

/** The shipped data, but with the crocodile's pre-v1.6 jump (for the before / after comparison). */
const OLD_CROC: BrawlDataSource = {
  ...DEFAULT_DATA_SOURCE,
  getMoveset: (a: AnimalId) => (a === 'crocodile' ? { ...MOVESETS.crocodile, stats: { ...MOVESETS.crocodile.stats, jumpVel: OLD_JUMP_VEL } } : MOVESETS[a]),
};

function world(stage: StageId, src: BrawlDataSource): BrawlWorld {
  const w = new BrawlWorld({ stage, roster: [{ animal: 'crocodile', isPlayer: false }, { animal: 'lion', isPlayer: false }], difficulty: 1, stocks: 3, timeLimitS: 0 }, 3, src);
  w.skipCountdown();
  return w;
}

const press = (over: Partial<BrawlIntent>): BrawlIntent => ({ ...idleIntent(), ...over });

/** Full-height ground jump (jump held); optionally an air jump at the apex. Returns the highest feet y reached and where it ended up. */
function jumpFrom(stage: StageId, src: BrawlDataSource, x: number, airJump: boolean, frames = 170): { apex: number; platformId: string | null; grounded: boolean } {
  const w = world(stage, src);
  w.debugPlace(1, x > 0 ? -25 : 25, 0); // the lion falls out of the way
  w.debugPlace(0, x, 0);
  for (let i = 0; i < 2; i++) w.step();
  let apex = 0;
  let used = false;
  for (let f = 0; f < frames; f++) {
    const s = w.snapshot().fighters[0];
    let i = press({ jumpHeld: true });
    if (f === 0) i = press({ jump: true, jumpHeld: true });
    else if (airJump && !used && !s.grounded && s.vel.y <= 0.3 && s.jumpsLeft > 0) {
      used = true;
      i = press({ jump: true, jumpHeld: true });
    }
    w.setIntent(0, i);
    w.step();
    apex = Math.max(apex, w.snapshot().fighters[0].pos.y);
  }
  const e = w.snapshot().fighters[0];
  return { apex, platformId: e.platformId, grounded: e.grounded };
}

describe('crocodile jump (v1.6)', () => {
  it('data: jumpVel = 12.5 x sqrt(2) so the apex height is exactly doubled; the air jump is unchanged', () => {
    const st = MOVESETS.crocodile.stats;
    expect(st.jumpVel).toBeCloseTo(OLD_JUMP_VEL * Math.SQRT2, 3);
    const apex = (v: number): number => (v * v) / (2 * PHYS.gravity * st.gravityMult);
    expect(apex(st.jumpVel) / apex(OLD_JUMP_VEL)).toBeCloseTo(2, 3);
    expect(st.airJumpVel).toBe(11.5);
    expect(st.maxJumps).toBe(2);
  });

  it('sim: the measured ground-jump apex is ~2x the old one (and close to v^2 / 2g)', () => {
    const now = jumpFrom('brokenColosseum', DEFAULT_DATA_SOURCE, 0, false, 80).apex;
    const old = jumpFrom('brokenColosseum', OLD_CROC, 0, false, 80).apex;
    expect(old).toBeGreaterThan(1.4);
    expect(now / old).toBeGreaterThan(1.95);
    expect(now / old).toBeLessThan(2.1);
    const st = MOVESETS.crocodile.stats;
    const analytic = (st.jumpVel * st.jumpVel) / (2 * PHYS.gravity * st.gravityMult);
    expect(now).toBeGreaterThan(analytic - 0.25);
    expect(now).toBeLessThanOrEqual(analytic + 0.01);
  });

  it('short hop (jump released early) still works: it is lower than the full jump', () => {
    const w = world('brokenColosseum', DEFAULT_DATA_SOURCE);
    w.debugPlace(1, 25, 0);
    w.debugPlace(0, 0, 0);
    for (let i = 0; i < 2; i++) w.step();
    let apex = 0;
    for (let f = 0; f < 70; f++) {
      w.setIntent(0, f === 0 ? press({ jump: true, jumpHeld: true }) : press({ jumpHeld: false }));
      w.step();
      apex = Math.max(apex, w.snapshot().fighters[0].pos.y);
    }
    expect(apex).toBeGreaterThan(0.8);
    expect(apex).toBeLessThan(jumpFrom('brokenColosseum', DEFAULT_DATA_SOURCE, 0, false, 80).apex * 0.5);
  });

  it('reaches the Broken Colosseum side platforms (4.2 m) with ground jump + air jump; it could not before, nor with the ground jump alone', () => {
    for (const [x, id] of [[-6.5, 'left'], [6.5, 'right']] as const) {
      const now = jumpFrom('brokenColosseum', DEFAULT_DATA_SOURCE, x, true);
      expect(now.platformId, `${id} reached`).toBe(id);
      expect(now.grounded).toBe(true);
      expect(jumpFrom('brokenColosseum', OLD_CROC, x, true).platformId, `${id} (old jump)`).toBe('main');
      expect(jumpFrom('brokenColosseum', DEFAULT_DATA_SOURCE, x, false).platformId, `${id} (ground jump alone)`).toBe('main');
    }
  });

  it('reaches the Sky Aqueduct small platforms (4.6 m) with ground jump + air jump', () => {
    for (const [x, id] of [[-10, 'smallL'], [10, 'smallR']] as const) {
      const now = jumpFrom('skyAqueduct', DEFAULT_DATA_SOURCE, x, true);
      expect(now.platformId, `${id} reached`).toBe(id);
      expect(jumpFrom('skyAqueduct', OLD_CROC, x, true).platformId, `${id} (old jump)`).not.toBe(id);
    }
  });

  it('the ledge jump (full jumpVel) now climbs about twice as high and puts the crocodile on the stage', () => {
    const hangJump = (src: BrawlDataSource): { apex: number; platformId: string | null; grounded: boolean } => {
      const w = world('brokenColosseum', src);
      w.debugPlace(1, 25, 0);
      w.debugPlace(0, -12, -1.0, 0, -2);
      for (let i = 0; i < 3; i++) w.step();
      expect(w.snapshot().fighters[0].action).toBe('ledgeHang');
      for (let i = 0; i < 8; i++) w.step();
      const y0 = w.snapshot().fighters[0].pos.y;
      let apex = y0;
      for (let f = 0; f < 140; f++) {
        w.setIntent(0, f === 0 ? press({ jump: true, jumpHeld: true, moveX: 1 }) : press({ jumpHeld: true, moveX: 1 }));
        w.step();
        apex = Math.max(apex, w.snapshot().fighters[0].pos.y);
      }
      const e = w.snapshot().fighters[0];
      return { apex: apex - y0, platformId: e.platformId, grounded: e.grounded };
    };
    const now = hangJump(DEFAULT_DATA_SOURCE);
    const old = hangJump(OLD_CROC);
    expect(now.apex / old.apex).toBeGreaterThan(1.9);
    expect(now.platformId).toBe('main');
    expect(now.grounded).toBe(true);
  });
});
