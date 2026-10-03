import { describe, it, expect } from 'vitest';
import type { BrawlEvent, HitboxDef, MoveBody } from '../../src/brawl/types';
import { BrawlWorld } from '../../src/brawl/sim/BrawlWorld';
import type { BrawlDataSource } from '../../src/brawl/sim/dataSource';
import { PHYS } from '../../src/brawl/config';
import { cfg, circle, FIXTURE_SOURCE, liveWorld, mkBody, run } from './fixtures';

type HitEvent = Extract<BrawlEvent, { type: 'hit' }>;
const fighter = (w: BrawlWorld, id: number) => w.snapshot().fighters[id];
const hitsOf = (w: BrawlWorld): HitEvent[] => w.drainEvents().filter((e): e is HitEvent => e.type === 'hit');

/** The fixture data with lion's lightS replaced by a one-hitbox move. */
function withLightS(hb: HitboxDef): BrawlDataSource {
  const body: MoveBody = mkBody('probe', [4, 2, 10], [hb]);
  return {
    ...FIXTURE_SOURCE,
    getMoveBody: (animal, id, air, chain) => (animal === 'lion' && id === 'lightS' ? body : FIXTURE_SOURCE.getMoveBody(animal, id, air, chain)),
  };
}

function duelWith(src: BrawlDataSource, victimY = 0, victimPercent = 0): BrawlWorld {
  const w = new BrawlWorld(cfg(['lion', 'lion']), 1, src);
  w.skipCountdown();
  w.debugPlace(0, 0, 0);
  w.debugPlace(1, 1.2, victimY);
  w.debugSetFacing(0, 1);
  w.debugSetFacing(1, -1);
  w.debugSetPercent(1, victimPercent);
  return w;
}

function hitOnce(w: BrawlWorld): HitEvent {
  run(w, 1, 0, () => ({ light: true, moveX: 0.6 }));
  for (let i = 0; i < 20; i++) {
    run(w, 1, 0);
    const h = hitsOf(w);
    if (h.length) return h[0];
  }
  throw new Error('no hit');
}

describe('sim: hit effects', () => {
  it("'stun' adds 12 frames of hitstun and never tumbles", () => {
    const base = duelWith(withLightS(circle(1.2, 0.9, 0.5, 4, 6, 6, 30, 30, 40)), 0, 100);
    const hb = hitOnce(base);
    expect(hb.kbSpeed).toBeGreaterThan(20);
    const stunned = duelWith(withLightS(circle(1.2, 0.9, 0.5, 4, 6, 6, 30, 30, 40, { effect: 'stun' })), 0, 100);
    hitOnce(stunned);
    expect(fighter(stunned, 1).hitstunTotal).toBe(fighter(base, 1).hitstunTotal + PHYS.stunBonusFrames);
    run(stunned, 20, 1);
    run(base, 20, 1);
    expect(fighter(stunned, 1).action).toBe('hitstun');
    expect(fighter(base, 1).action).toBe('tumble');
  });

  it("'flinch' caps hitstun and never tumbles", () => {
    const w = duelWith(withLightS(circle(1.2, 0.9, 0.5, 4, 6, 6, 30, 30, 40, { effect: 'flinch' })), 0, 100);
    const h = hitOnce(w);
    expect(h.kbSpeed).toBeGreaterThan(20);
    expect(fighter(w, 1).hitstunTotal).toBeLessThanOrEqual(PHYS.flinchHitstunMax);
    run(w, h.hitlag + 1, 1);
    expect(fighter(w, 1).action).toBe('hitstun');
  });

  it("'bury' holds a grounded victim in knockdown instead of launching it, but still launches airborne ones", () => {
    const grounded = duelWith(withLightS(circle(1.2, 0.9, 0.5, 4, 6, 8, 6, 10, 90, { effect: 'bury' })));
    hitOnce(grounded);
    const v = fighter(grounded, 1);
    expect(v.action).toBe('knockdown');
    expect(v.actionFrames).toBe(PHYS.buryFrames);
    expect(v.vel.y).toBe(0);
    expect(v.grounded).toBe(true);
    run(grounded, PHYS.buryFrames + PHYS.getupFrames + 20, 1);
    expect(fighter(grounded, 1).action).toBe('idle');
    const air = duelWith(withLightS(circle(1.2, 0.9, 0.5, 4, 6, 8, 6, 10, 90, { effect: 'bury' })), 0.8);
    const ha = hitOnce(air);
    run(air, ha.hitlag + 1, 1);
    expect(fighter(air, 1).action).not.toBe('knockdown');
    expect(fighter(air, 1).vel.y).toBeGreaterThan(5);
  });

  it('a grounded victim hit along the floor slides instead of lifting off', () => {
    const w = duelWith(withLightS(circle(1.2, 0.9, 0.5, 4, 6, 6, 8, 0, 0)));
    const h = hitOnce(w);
    run(w, h.hitlag + 1, 1);
    const v = fighter(w, 1);
    expect(v.grounded).toBe(true);
    expect(v.vel.x).toBeGreaterThan(0);
    run(w, 40, 1);
    expect(fighter(w, 1).action).toBe('idle');
    expect(fighter(w, 1).pos.x).toBeGreaterThan(1.2);
  });

  it('a grounded victim with a downward launch is bounced up', () => {
    const w = duelWith(withLightS(circle(1.2, 0.9, 0.5, 4, 6, 6, 10, 0, 300)));
    const h = hitOnce(w);
    run(w, h.hitlag + 1, 1);
    expect(fighter(w, 1).vel.y).toBeGreaterThan(0);
    expect(fighter(w, 1).grounded).toBe(false);
  });
});

describe('sim: hanging on a ledge', () => {
  function hangerWorld() {
    const w = liveWorld(['lion', 'lion']);
    w.debugPlace(0, -12, -1.5, 0, -2);
    run(w, 3, 0);
    expect(fighter(w, 0).action).toBe('ledgeHang');
    w.debugPlace(1, -13.2, -1.425, 0, 0); // beside the hanger, in the air
    w.debugSetFacing(1, 1);
    return w;
  }

  it('is invulnerable while the grab grace lasts, vulnerable afterwards', () => {
    const early = hangerWorld();
    early.debugFighter(1).ledgeRegrab = 999;
    run(early, 1, 1, () => ({ light: true, moveX: 0.6 }));
    let n = 0;
    for (let i = 0; i < 12; i++) {
      run(early, 1, 1);
      n += hitsOf(early).length;
    }
    expect(n).toBe(0);

    const late = hangerWorld();
    late.debugFighter(1).ledgeRegrab = 999;
    run(late, 45, 0); // grace is over
    expect(fighter(late, 0).invuln).toBe(0);
    expect(fighter(late, 0).action).toBe('ledgeHang');
    late.debugPlace(1, -13.2, -1.425, 0, 0);
    late.debugSetFacing(1, 1);
    late.debugFighter(1).ledgeRegrab = 999;
    run(late, 1, 1, () => ({ light: true, moveX: 0.6 }));
    let hits = 0;
    for (let i = 0; i < 12; i++) {
      run(late, 1, 1);
      hits += hitsOf(late).length;
    }
    expect(hits).toBe(1);
    const f = fighter(late, 0);
    expect(f.action).toBe('hitstun');
    expect(f.platformId).toBeNull();
    // the ledge is free again, but cannot be regrabbed for 30 frames
    expect(late.debugFighter(0).ledgeIdx).toBe(-1);
  });
});

describe('sim: aerial recovery details', () => {
  it('air jump does not require ground; jumps are not refilled by being hit', () => {
    const w = liveWorld(['lion', 'lion']);
    w.debugPlace(0, 0, 8);
    run(w, 1, 0, () => ({ jump: true, jumpHeld: true }));
    expect(fighter(w, 0).jumpsLeft).toBe(0); // placed in the air = ground jump spent; the one air jump was just used
    w.debugPlace(1, -1.2, 8);
    w.debugSetFacing(1, 1);
    run(w, 1, 1, () => ({ light: true, moveX: 0.6 }));
    for (let i = 0; i < 20; i++) run(w, 1, 1);
    expect(fighter(w, 0).jumpsLeft).toBe(0);
  });

  it('heavy-up resets when the fighter is hit mid-air', () => {
    const w = liveWorld(['lion', 'lion']);
    w.debugPlace(0, 0, 12);
    run(w, 1, 0, () => ({ heavy: true, moveY: 1 }));
    expect(fighter(w, 0).recoveryUsed).toBe(true);
    run(w, 47, 0);
    expect(fighter(w, 0).recoveryUsed).toBe(true);
    // fighter 1 hits it
    const f0 = fighter(w, 0);
    w.debugPlace(1, f0.pos.x - 1.2, f0.pos.y);
    w.debugSetFacing(1, 1);
    run(w, 1, 1, () => ({ light: true, moveX: 0.6 }));
    for (let i = 0; i < 12; i++) run(w, 1, 1);
    expect(fighter(w, 0).percent).toBeGreaterThan(0);
    expect(fighter(w, 0).recoveryUsed).toBe(false);
  });

  it('inactive code paths: unknown fighter ids are ignored', () => {
    const w = liveWorld(['lion', 'lion']);
    expect(() => w.setIntent(-1, { moveX: 0, moveY: 0, jump: true, jumpHeld: false, light: false, heavy: false, dodge: false })).not.toThrow();
    expect(() => w.debugPlace(9, 0, 0)).not.toThrow();
  });
});
