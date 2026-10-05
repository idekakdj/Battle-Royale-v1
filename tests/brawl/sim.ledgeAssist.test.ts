import { describe, expect, it } from 'vitest';
import type { AnimalId } from '../../src/core/types';
import type { MovesetDef, PlatformDef, StageDef } from '../../src/brawl/types';
import { PHYS } from '../../src/brawl/config';
import { BrawlWorld } from '../../src/brawl/sim/BrawlWorld';
import type { BrawlDataSource } from '../../src/brawl/sim/dataSource';
import { MOVESETS } from '../../src/brawl/data';
import { FIXTURE_SOURCE, FIX_STAGES, cfg, fixtureMoveset, liveWorld, run } from './fixtures';

/**
 * v1.6 ledge AUTO-GRAB ASSIST (PHYS.ledgeAssist*). The original grab box (1.1 out / 1.3 down / 0.5 up, falling only) is unchanged
 * (tests/brawl/sim.movement.test.ts); the assist adds a zone under / beside the ledge that grabs while moving or holding toward the
 * stage, also while still rising. Fixture lion: width 1.1 (half 0.55), height 1.5 (hand = feet + 1.425). Main platform: x -11..11, y 0.
 */

const fighter = (w: BrawlWorld, id: number) => w.snapshot().fighters[id];
const HW = 0.55;
const HAND = 1.5 * PHYS.ledgeHandFrac;
/** Feet y that puts the lion's hand `dy` above the corner height (y 0). */
const feetFor = (dy: number): number => dy - HAND;
/** Feet x that puts the lion's body edge nearest the LEFT corner (x -11) `out` metres outside the platform end. */
const leftX = (out: number): number => -11 - out - HW;

describe('ledge assist: grabs the original box would refuse', () => {
  it('grabs from underneath while still RISING (hand under the corner, holding toward the stage)', () => {
    const w = liveWorld(['lion', 'lion']);
    w.debugPlace(0, leftX(0.9), feetFor(-1.3), 0, 9);
    run(w, 2, 0, () => ({ moveX: 1 }));
    const f = fighter(w, 0);
    expect(f.action).toBe('ledgeHang');
    expect(f.platformId).toBe('main');
    // snapped into the normal hang pose
    expect(f.pos.x).toBeCloseTo(-11 - HW - PHYS.ledgeHangOffset, 6);
    expect(f.pos.y).toBeCloseTo(-HAND, 6);
    expect(f.vel).toEqual({ x: 0, y: 0 });
    expect(f.facing).toBe(1);
    expect(f.invuln).toBeGreaterThan(30);
    expect(f.jumpsLeft).toBe(1);
    expect(w.drainEvents().some((e) => e.type === 'ledgeGrab' && e.fighterId === 0)).toBe(true);
  });

  it('also works on the right ledge (mirrored) and moving toward the stage without holding the stick', () => {
    const w = liveWorld(['lion', 'lion']);
    // right corner at x +11: body edge nearest the corner is the LEFT edge of the body (x - 0.55), 1.4 m outside the end
    w.debugPlace(0, 11 + 1.4 + HW, feetFor(-1.0), -3, 8); // drifting toward the stage (-x) with no input
    run(w, 2, 0);
    const f = fighter(w, 0);
    expect(f.action).toBe('ledgeHang');
    expect(f.pos.x).toBeCloseTo(11 + HW + PHYS.ledgeHangOffset, 6);
    expect(f.facing).toBe(-1);
  });

  it('grabs when falling BESIDE the ledge, further out than the original box allows', () => {
    // out 1.5 m: outside the 1.1 m original box, inside the 2.0 m assist zone
    const noAssist = liveWorld(['lion', 'lion']);
    noAssist.debugPlace(0, leftX(1.5), feetFor(-0.4), 0, -3);
    run(noAssist, 3, 0); // no input: nothing happens (also no grab from the original box)
    expect(fighter(noAssist, 0).action).not.toBe('ledgeHang');
    const w = liveWorld(['lion', 'lion']);
    w.debugPlace(0, leftX(1.5), feetFor(-0.4), 0, -3);
    run(w, 3, 0, () => ({ moveX: 1 }));
    expect(fighter(w, 0).action).toBe('ledgeHang');
  });

  it('every shipped animal gets the assist from underneath (real stats)', () => {
    for (const a of Object.keys(MOVESETS) as AnimalId[]) {
      const st = MOVESETS[a].stats;
      const w = new BrawlWorld(cfg([a, a]), 5);
      w.skipCountdown();
      const hand = st.height * PHYS.ledgeHandFrac;
      w.debugPlace(0, -11 - 1.0 - st.width / 2, -1.5 - hand, 0, 8);
      for (let i = 0; i < 3; i++) {
        w.setIntent(0, { moveX: 1, moveY: 0, jump: false, jumpHeld: false, light: false, heavy: false, dodge: false });
        w.step();
      }
      expect(w.snapshot().fighters[0].action, a).toBe('ledgeHang');
    }
  });
});

describe('ledge assist: when it must NOT trigger', () => {
  const none = (w: BrawlWorld, x: number, y: number, vx: number, vy: number, input: { moveX?: number; moveY?: number } = {}, n = 3): string => {
    w.debugPlace(0, x, y, vx, vy);
    run(w, n, 0, () => input);
    return fighter(w, 0).action;
  };

  it('holding Down prevents it', () => {
    const w = liveWorld(['lion', 'lion']);
    expect(none(w, leftX(0.9), feetFor(-1.3), 0, 9, { moveX: 1, moveY: -1 })).not.toBe('ledgeHang');
  });

  it('needs the fighter to move / hold TOWARD the stage (neither, or holding away, does nothing)', () => {
    expect(none(liveWorld(['lion', 'lion']), leftX(1.5), feetFor(-1.3), 0, 9)).not.toBe('ledgeHang');
    expect(none(liveWorld(['lion', 'lion']), leftX(1.5), feetFor(-1.3), 0, 9, { moveX: -1 })).not.toBe('ledgeHang');
    expect(none(liveWorld(['lion', 'lion']), leftX(1.5), feetFor(-1.3), -3, 9, { moveX: 0 })).not.toBe('ledgeHang');
  });

  it('no grab from far away (too far out, too far below, or above the corner)', () => {
    expect(none(liveWorld(['lion', 'lion']), leftX(PHYS.ledgeAssistOut + 0.6), feetFor(-1.0), 0, 6, { moveX: 1 })).not.toBe('ledgeHang');
    expect(none(liveWorld(['lion', 'lion']), leftX(0.8), feetFor(-PHYS.ledgeAssistDown - 1.2), 0, 8, { moveX: 1 }, 1)).not.toBe('ledgeHang');
    expect(none(liveWorld(['lion', 'lion']), leftX(0.8), feetFor(PHYS.ledgeAssistUp + 1.5), 0, 6, { moveX: 1 }, 1)).not.toBe('ledgeHang');
  });

  it('not while attacking, in hitstun, in an air dodge or in a jump squat', () => {
    // attacking: start an aerial first, then the fighter is in the zone
    const w = liveWorld(['lion', 'lion']);
    w.debugPlace(0, leftX(0.9), feetFor(-1.3), 0, 9);
    run(w, 1, 0, () => ({ light: true }));
    expect(fighter(w, 0).action).toBe('attack');
    run(w, 3, 0, () => ({ moveX: 1 }));
    expect(fighter(w, 0).action).not.toBe('ledgeHang');
    // hitstun (white-box: the state machine never reaches the grab code)
    const h = liveWorld(['lion', 'lion']);
    h.debugPlace(0, leftX(0.9), feetFor(-1.3), 0, 9);
    const f0 = h.debugFighter(0);
    f0.action = 'hitstun';
    f0.hitstun = 20;
    f0.actionFrames = 20;
    run(h, 3, 0, () => ({ moveX: 1 }));
    expect(fighter(h, 0).action).not.toBe('ledgeHang');
    // air dodge
    const d = liveWorld(['lion', 'lion']);
    d.debugPlace(0, leftX(0.9), feetFor(-1.3), 0, 0);
    run(d, 1, 0, () => ({ dodge: true }));
    expect(fighter(d, 0).action).toBe('dodgeAir');
    run(d, 4, 0, () => ({ moveX: 1 }));
    expect(fighter(d, 0).action).toBe('dodgeAir');
  });

  it('an occupied ledge is not grabbed (and the other fighter keeps it)', () => {
    const w = liveWorld(['lion', 'gorilla']);
    w.debugPlace(1, -12, -1.5, 0, -2);
    run(w, 3, 1);
    expect(fighter(w, 1).action).toBe('ledgeHang');
    w.debugPlace(0, leftX(0.9), feetFor(-1.3), 0, 9);
    run(w, 3, 0, () => ({ moveX: 1 }));
    expect(fighter(w, 0).action).not.toBe('ledgeHang');
    expect(fighter(w, 1).action).toBe('ledgeHang');
  });

  it('the assist cannot re-grab a ledge just left for PHYS.ledgeAssistRegrabCd frames (the original box still can after 30 f)', () => {
    const w = liveWorld(['lion', 'lion']);
    w.debugPlace(0, leftX(0.9), feetFor(-1.3), 0, 9);
    run(w, 2, 0, () => ({ moveX: 1 }));
    expect(fighter(w, 0).action).toBe('ledgeHang');
    run(w, 8, 0);
    run(w, 1, 0, () => ({ moveY: -1 })); // drop
    expect(fighter(w, 0).action).toBe('fall');
    w.debugPlace(0, 0, 0); // stand safely on the stage while the cooldowns run (a KO would freeze them)
    // 40 frames after the release: the 30 f regrab cooldown is over, the assist lock (75 f) is not
    run(w, 40, 0);
    w.debugPlace(0, leftX(1.5), feetFor(-1.0), 0, -3);
    run(w, 3, 0, () => ({ moveX: 1 }));
    expect(fighter(w, 0).action).not.toBe('ledgeHang');
    // after the lock has run out the same spot grabs
    w.debugPlace(0, 0, 0);
    run(w, PHYS.ledgeAssistRegrabCd, 0);
    w.debugPlace(0, leftX(1.5), feetFor(-1.0), 0, -3);
    run(w, 3, 0, () => ({ moveX: 1 }));
    expect(fighter(w, 0).action).toBe('ledgeHang');
  });

  it('keeps the anti-stall rules: invulnerability decays per grab inside 4 s, 180 f maximum hang', () => {
    const w = liveWorld(['lion', 'lion']);
    const invs: number[] = [];
    for (let k = 0; k < 3; k++) {
      w.debugPlace(0, leftX(0.9), feetFor(-1.3), 0, 9);
      run(w, 2, 0, () => ({ moveX: 1 }));
      expect(fighter(w, 0).action).toBe('ledgeHang');
      invs.push(fighter(w, 0).invuln);
      run(w, 8, 0);
      run(w, 1, 0, () => ({ moveY: -1 }));
      w.debugPlace(0, 0, 0);
      run(w, PHYS.ledgeAssistRegrabCd + 2, 0);
    }
    expect(invs[0]).toBeGreaterThan(invs[1]);
    expect(invs[1]).toBeGreaterThan(invs[2]);
    // max hang
    const h = liveWorld(['lion', 'lion']);
    h.debugPlace(0, leftX(0.9), feetFor(-1.3), 0, 9);
    run(h, 2, 0, () => ({ moveX: 1 }));
    run(h, PHYS.ledgeMaxHang + 5, 0);
    expect(fighter(h, 0).action).not.toBe('ledgeHang');
  });
});

describe('ledge assist: moving platforms', () => {
  /** A stage whose only solid platform (with both ledges) slides left and right (the sim supports it; shipped stages only move soft ones). */
  function movingStage(): StageDef {
    const plat: PlatformDef = {
      id: 'slider',
      kind: 'solid',
      x0: -5,
      x1: 5,
      y: 0,
      thickness: 3,
      ledgeLeft: true,
      ledgeRight: true,
      moving: { axis: 'x', amplitude: 3, periodS: 6, phase: 0 },
    };
    return { ...FIX_STAGES.brokenColosseum, platforms: [plat], spawns: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }] };
  }
  const source: BrawlDataSource = {
    getMoveset: (a): MovesetDef => fixtureMoveset(a),
    getMoveBody: (a, id, air, chain) => FIXTURE_SOURCE.getMoveBody(a, id, air, chain),
    getStage: () => movingStage(),
  };

  it('uses the platform\'s CURRENT position: the grab works at the moved ledge and the hang follows the platform', () => {
    const w = new BrawlWorld(cfg(['lion', 'lion']), 3, source);
    w.skipCountdown();
    for (let i = 0; i < 100; i++) w.step(); // the slider has moved well away from its home position
    const p = w.snapshot().platforms[0];
    expect(Math.abs(p.x0 + 5)).toBeGreaterThan(1.0);
    w.debugPlace(0, p.x0 - 1.0 - HW, feetFor(-1.3), 0, 9);
    for (let i = 0; i < 2; i++) {
      w.setIntent(0, { moveX: 1, moveY: 0, jump: false, jumpHeld: false, light: false, heavy: false, dodge: false });
      w.step();
    }
    let f = fighter(w, 0);
    expect(f.action).toBe('ledgeHang');
    w.setIntent(0, { moveX: 0, moveY: 0, jump: false, jumpHeld: false, light: false, heavy: false, dodge: false });
    const rel0 = f.pos.x - w.snapshot().platforms[0].x0;
    expect(rel0).toBeCloseTo(-HW - PHYS.ledgeHangOffset, 6);
    for (let i = 0; i < 20; i++) {
      w.step();
      f = fighter(w, 0);
      expect(f.action).toBe('ledgeHang');
      expect(f.pos.x - w.snapshot().platforms[0].x0).toBeCloseTo(rel0, 6);
    }
  });
});
