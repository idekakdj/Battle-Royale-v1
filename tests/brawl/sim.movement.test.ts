import { describe, it, expect } from 'vitest';
import { PHYS } from '../../src/brawl/config';
import { cfg, FIXTURE_SOURCE, FIX_STAGES, intent, liveWorld, run } from './fixtures';
import { BrawlWorld } from '../../src/brawl/sim/BrawlWorld';

const fighter = (w: BrawlWorld, id: number) => w.snapshot().fighters[id];

describe('sim: setup & countdown', () => {
  it('starts in a 3 s countdown with fighters standing on their spawns', () => {
    const w = new BrawlWorld(cfg(['lion', 'gorilla', 'eagle', 'mole']), 7, FIXTURE_SOURCE);
    const s = w.snapshot();
    expect(s.frame).toBe(0);
    expect(s.countdown).toBeCloseTo(3, 6);
    expect(s.time).toBeLessThan(0);
    expect(s.matchOver).toBe(false);
    expect(s.winnerId).toBe(-1);
    expect(s.fighters).toHaveLength(4);
    const stage = FIX_STAGES.brokenColosseum;
    s.fighters.forEach((f, i) => {
      expect(f.pos).toEqual(stage.spawns[i]);
      expect(f.grounded).toBe(true);
      expect(f.platformId).toBe('main');
      expect(f.stocks).toBe(3);
      expect(f.jumpsLeft).toBe(f.animal === 'eagle' ? 4 : 2);
    });
    // spawns face the centre
    expect(s.fighters[0].facing).toBe(1);
    expect(s.fighters[3].facing).toBe(-1);
  });

  it('ignores control during the countdown and goes live at frame 180', () => {
    const w = new BrawlWorld(cfg(['lion', 'lion']), 1, FIXTURE_SOURCE);
    for (let i = 0; i < 179; i++) {
      w.setIntent(0, intent({ moveX: 1, jump: true, jumpHeld: true, light: true }));
      w.step();
    }
    let s = w.snapshot();
    expect(s.countdown).toBeCloseTo(1 / 60, 6);
    expect(s.fighters[0].pos.x).toBe(-7);
    expect(s.fighters[0].action).toBe('idle');
    w.step();
    s = w.snapshot();
    expect(s.countdown).toBe(0);
    expect(s.time).toBe(0);
    expect(s.timeLeft).toBeCloseTo(300, 6);
    w.setIntent(0, intent({ moveX: 1 }));
    w.step();
    expect(w.snapshot().fighters[0].pos.x).toBeGreaterThan(-7);
  });

  it('timeLeft is null without a time limit', () => {
    const w = liveWorld(['lion', 'lion'], { timeLimitS: 0 });
    expect(w.snapshot().timeLeft).toBeNull();
  });

  it('snapshot() returns a fresh independent object each call', () => {
    const w = liveWorld(['lion', 'lion']);
    const a = w.snapshot();
    a.fighters[0].pos.x = 999;
    a.fighters[0].percent = 123;
    a.platforms[0].y = 77;
    const b = w.snapshot();
    expect(b.fighters[0].pos.x).toBe(-7);
    expect(b.fighters[0].percent).toBe(0);
    expect(b.platforms[0].y).toBe(0);
    expect(b).not.toBe(a);
    expect(b.fighters[0]).not.toBe(a.fighters[0]);
    expect(b.fighters[0].pos).not.toBe(a.fighters[0].pos);
  });
});

describe('sim: ground movement', () => {
  it('reaches run speed in <= 6 frames and stops in <= 4', () => {
    const w = liveWorld(['lion', 'lion']);
    let reached = -1;
    for (let i = 1; i <= 8; i++) {
      run(w, 1, 0, () => ({ moveX: 1 }));
      if (reached < 0 && fighter(w, 0).vel.x >= 8.6 - 1e-9) reached = i;
    }
    expect(reached).toBeGreaterThan(0);
    expect(reached).toBeLessThanOrEqual(6);
    expect(fighter(w, 0).action).toBe('run');
    expect(fighter(w, 0).facing).toBe(1);
    let stopped = -1;
    for (let i = 1; i <= 6; i++) {
      run(w, 1, 0, () => ({ moveX: 0 }));
      if (stopped < 0 && Math.abs(fighter(w, 0).vel.x) < 1e-9) stopped = i;
    }
    expect(stopped).toBeGreaterThan(0);
    expect(stopped).toBeLessThanOrEqual(4);
    expect(fighter(w, 0).action).toBe('idle');
  });

  it('walks when |moveX| < 0.6 and turns immediately', () => {
    const w = liveWorld(['lion', 'lion']);
    run(w, 10, 0, () => ({ moveX: 0.5 }));
    let f = fighter(w, 0);
    expect(f.action).toBe('walk');
    expect(f.vel.x).toBeCloseTo(4.6, 6);
    run(w, 1, 0, () => ({ moveX: -1 }));
    f = fighter(w, 0);
    expect(f.facing).toBe(-1);
  });

  it('crouches on Down', () => {
    const w = liveWorld(['lion', 'lion']);
    run(w, 3, 0, () => ({ moveY: -1 }));
    expect(fighter(w, 0).action).toBe('crouch');
  });

  it('walks off a ledge and falls (spends the ground jump)', () => {
    const w = liveWorld(['lion', 'lion']);
    w.debugPlace(0, 10, 0);
    run(w, 60, 0, () => ({ moveX: 1 }));
    const f = fighter(w, 0);
    expect(f.grounded).toBe(false);
    expect(f.pos.x).toBeGreaterThan(11);
    expect(f.jumpsLeft).toBe(1);
  });
});

describe('sim: jumping', () => {
  it('jump squat then full hop vs short hop', () => {
    const w = liveWorld(['lion', 'lion']);
    const squat: string[] = [];
    let top = 0;
    for (let i = 0; i < 70; i++) {
      w.setIntent(0, intent({ jump: i === 0, jumpHeld: true }));
      w.step();
      const f = fighter(w, 0);
      if (i < 6) squat.push(f.action);
      top = Math.max(top, f.pos.y);
    }
    expect(squat.slice(0, 4).every((a) => a === 'jumpSquat')).toBe(true);
    expect(squat[5]).toBe('rise');
    expect(top).toBeGreaterThan(2.4);
    expect(top).toBeLessThan(3.2);

    const w2 = liveWorld(['lion', 'lion']);
    let top2 = 0;
    for (let i = 0; i < 70; i++) {
      w2.setIntent(0, intent({ jump: i === 0, jumpHeld: i < 2 }));
      w2.step();
      top2 = Math.max(top2, fighter(w2, 0).pos.y);
    }
    expect(top2).toBeGreaterThan(0.5);
    expect(top2).toBeLessThan(top * 0.55);
  });

  it('a bot that never reports jumpHeld still gets a full hop', () => {
    const w = liveWorld(['lion', 'lion']);
    let top = 0;
    for (let i = 0; i < 70; i++) {
      w.setIntent(0, intent({ jump: i === 0 }));
      w.step();
      top = Math.max(top, fighter(w, 0).pos.y);
    }
    expect(top).toBeGreaterThan(2.4);
  });

  it('counts jumps: lion has ground + 1 air jump; landing resets them', () => {
    const w = liveWorld(['lion', 'lion']);
    const jumps: boolean[] = [];
    for (let n = 0; n < 4; n++) {
      run(w, 12, 0, (i) => ({ jump: i === 0, jumpHeld: true }));
      for (const e of w.drainEvents()) if (e.type === 'jump' && e.fighterId === 0) jumps.push(e.air);
    }
    expect(jumps).toEqual([false, true]);
    expect(fighter(w, 0).jumpsLeft).toBe(0);
    run(w, 200, 0);
    expect(fighter(w, 0).grounded).toBe(true);
    expect(fighter(w, 0).jumpsLeft).toBe(2);
  });

  it('eagle gets four jumps in total', () => {
    const w = liveWorld(['eagle', 'lion']);
    const jumps: boolean[] = [];
    for (let n = 0; n < 8; n++) {
      run(w, 14, 0, (i) => ({ jump: i === 0, jumpHeld: true }));
      for (const e of w.drainEvents()) if (e.type === 'jump' && e.fighterId === 0) jumps.push(e.air);
    }
    expect(jumps).toEqual([false, true, true, true]);
  });

  it('fast fall reaches fastFallSpeed, normal fall is capped at fallSpeed', () => {
    const w = liveWorld(['lion', 'lion']);
    w.debugPlace(0, 20, 20, 0, -5);
    w.debugPlace(1, 25, 20, 0, -5);
    let slow = 0;
    let fast = 0;
    for (let i = 0; i < 40; i++) {
      w.setIntent(1, intent({ moveY: -1 }));
      w.step();
      slow = Math.min(slow, fighter(w, 0).vel.y);
      fast = Math.min(fast, fighter(w, 1).vel.y);
    }
    expect(slow).toBeCloseTo(-18, 6);
    expect(fast).toBeCloseTo(-26, 6);
    expect(fighter(w, 1).action).toBe('fastFall');
  });

  it('eagle glides while jump is held', () => {
    const w = liveWorld(['eagle', 'lion']);
    w.debugPlace(0, 20, 20, 0, -2);
    let minV = 0;
    for (let i = 0; i < 40; i++) {
      w.setIntent(0, intent({ jumpHeld: true }));
      w.step();
      minV = Math.min(minV, fighter(w, 0).vel.y);
    }
    expect(minV).toBeGreaterThanOrEqual(-6.5 - 1e-9);
    const w2 = liveWorld(['eagle', 'lion']);
    w2.debugPlace(0, 20, 20, 0, -2);
    let minV2 = 0;
    for (let i = 0; i < 40; i++) {
      w2.step();
      minV2 = Math.min(minV2, fighter(w2, 0).vel.y);
    }
    expect(minV2).toBeLessThan(-12);
  });

  it('air control accelerates toward airSpeed', () => {
    const w = liveWorld(['lion', 'lion']);
    w.debugPlace(0, 20, 20, 0, 0);
    run(w, 30, 0, () => ({ moveX: 1 }));
    expect(fighter(w, 0).vel.x).toBeCloseTo(6.6, 6);
  });
});

describe('sim: platforms', () => {
  it('soft platforms: pass through from below, land from above', () => {
    const w = liveWorld(['lion', 'lion']);
    w.debugPlace(0, 0, 5.5, 0, 16); // under the top platform (y 7.6, x -2.5..2.5)
    let rose = 0;
    for (let i = 0; i < 120; i++) {
      w.step();
      rose = Math.max(rose, fighter(w, 0).pos.y);
    }
    expect(rose).toBeGreaterThan(7.7);
    const f = fighter(w, 0);
    expect(f.grounded).toBe(true);
    expect(f.platformId).toBe('top');
    expect(f.pos.y).toBeCloseTo(7.6, 6);
  });

  it('holding Down on a soft platform drops through it', () => {
    const w = liveWorld(['lion', 'lion']);
    w.debugPlace(0, 0, 7.6);
    expect(fighter(w, 0).platformId).toBe('top');
    run(w, 5, 0);
    run(w, 60, 0, () => ({ moveY: -1 }));
    const f = fighter(w, 0);
    expect(f.platformId).toBe('main');
    expect(f.pos.y).toBeCloseTo(0, 6);
    expect(f.grounded).toBe(true);
  });

  it('solid platforms stop head bumps and block from the side', () => {
    const w = liveWorld(['lion', 'lion']);
    w.debugPlace(0, 0, -7, 0, 20); // below the main slab (bottom at y -3.5)
    run(w, 14, 0);
    const f = fighter(w, 0);
    expect(f.pos.y + 1.5).toBeLessThanOrEqual(-3.5 + 1e-6);
    expect(f.vel.y).toBeLessThanOrEqual(0);
    const w2 = liveWorld(['lion', 'lion']);
    w2.debugPlace(0, -14, -1, 8, 0);
    w2.debugFighter(0).ledgeRegrab = 1000; // keep it from grabbing the corner
    run(w2, 24, 0, () => ({ moveX: 1 }));
    const g = fighter(w2, 0);
    expect(g.pos.x).toBeCloseTo(-11 - 0.55, 3);
    expect(g.vel.x).toBe(0);
  });

  it('moving platform is a pure function of the frame and carries riders without slingshot', () => {
    const w = new BrawlWorld(cfg(['lion', 'lion'], { stage: 'skyAqueduct' }), 3, FIXTURE_SOURCE);
    w.skipCountdown();
    w.debugPlace(0, 0.5, 2.6);
    expect(fighter(w, 0).platformId).toBe('drifter');
    const plat0 = w.snapshot().platforms.find((q) => q.id === 'drifter')!;
    const rel0 = fighter(w, 0).pos.x - (plat0.x0 + plat0.x1) / 2;
    let moved = 0;
    const startX = fighter(w, 0).pos.x;
    for (let i = 0; i < 300; i++) {
      w.step();
      const s = w.snapshot();
      const p = s.platforms.find((q) => q.id === 'drifter')!;
      const expected = 3.2 * Math.sin((2 * Math.PI * s.frame) / 60 / 9);
      expect(p.x0).toBeCloseTo(-2.5 + expected, 9);
      expect(p.x1).toBeCloseTo(2.5 + expected, 9);
      const f = s.fighters[0];
      const center = (p.x0 + p.x1) / 2;
      expect(f.pos.x - center).toBeCloseTo(rel0, 6);
      expect(f.platformId).toBe('drifter');
      moved = Math.max(moved, Math.abs(f.pos.x - startX));
    }
    expect(moved).toBeGreaterThan(1);
    // jump off while the platform moves: no inherited velocity
    run(w, 6, 0, (i) => ({ jump: i === 0, jumpHeld: true }));
    expect(Math.abs(fighter(w, 0).vel.x)).toBeLessThan(1e-9);
  });
});

describe('sim: ledges', () => {
  /** A lion falling beside the left ledge of the main platform (corner at x -11, y 0). */
  function hanging() {
    const w = liveWorld(['lion', 'lion']);
    w.debugPlace(0, -12, -1.5, 0, -2);
    run(w, 3, 0);
    return w;
  }

  it('grabs a free ledge: hang pose, invulnerable 40 f, event, jumps refilled', () => {
    const w = hanging();
    const f = fighter(w, 0);
    expect(f.action).toBe('ledgeHang');
    expect(f.facing).toBe(1);
    expect(f.pos.x).toBeCloseTo(-11 - 0.55 - 0.05, 6);
    expect(f.pos.y).toBeCloseTo(-1.5 * 0 - 1.5 * PHYS.ledgeHandFrac, 6);
    expect(f.platformId).toBe('main');
    expect(f.invuln).toBeGreaterThan(30);
    expect(f.jumpsLeft).toBe(1);
    expect(w.drainEvents().some((e) => e.type === 'ledgeGrab' && e.fighterId === 0)).toBe(true);
  });

  it('does not grab when holding Down, or when moving up fast', () => {
    const w = liveWorld(['lion', 'lion']);
    w.debugPlace(0, -12, -1.5, 0, -2);
    run(w, 3, 0, () => ({ moveY: -1 }));
    expect(fighter(w, 0).action).not.toBe('ledgeHang');
    const w2 = liveWorld(['lion', 'lion']);
    w2.debugPlace(0, -12, -2.2, 0, 6);
    run(w2, 1, 0);
    expect(fighter(w2, 0).action).not.toBe('ledgeHang');
  });

  it('hang lasts at most 180 frames, then releases; no regrab for 30 frames', () => {
    const w = hanging();
    run(w, 100, 0);
    expect(fighter(w, 0).action).toBe('ledgeHang');
    expect(fighter(w, 0).invuln).toBe(0);
    run(w, 90, 0);
    expect(fighter(w, 0).action).not.toBe('ledgeHang');
    expect(fighter(w, 0).grounded).toBe(false);
  });

  it('a ledge can only be held by one fighter', () => {
    const w = liveWorld(['lion', 'gorilla']);
    w.debugPlace(0, -12, -1.5, 0, -2);
    w.debugPlace(1, -12.2, -1.5, 0, -2);
    run(w, 3, 0);
    const s = w.snapshot();
    expect(s.fighters[0].action).toBe('ledgeHang');
    expect(s.fighters[1].action).not.toBe('ledgeHang');
  });

  it('ledge jump: full jump height, leaves the ledge', () => {
    const w = hanging();
    run(w, 8, 0);
    run(w, 1, 0, () => ({ jump: true }));
    const f = fighter(w, 0);
    expect(f.action).toBe('rise');
    expect(f.vel.y).toBeGreaterThan(13);
    expect(f.grounded).toBe(false);
  });

  it('climb: 22 frames, ends standing on the stage', () => {
    const w = hanging();
    run(w, 8, 0);
    run(w, 1, 0, () => ({ moveY: 1 }));
    expect(fighter(w, 0).action).toBe('ledgeClimb');
    expect(fighter(w, 0).invuln).toBeGreaterThan(0);
    run(w, 25, 0);
    const f = fighter(w, 0);
    expect(f.action).toBe('idle');
    expect(f.grounded).toBe(true);
    expect(f.pos.y).toBeCloseTo(0, 6);
    expect(f.pos.x).toBeGreaterThan(-11);
    expect(f.pos.x).toBeLessThan(-9.5);
  });

  it('roll-up (dodge): 28 frames and invulnerable throughout', () => {
    const w = hanging();
    run(w, 8, 0);
    run(w, 1, 0, () => ({ dodge: true }));
    expect(fighter(w, 0).action).toBe('ledgeClimb');
    expect(fighter(w, 0).actionFrames).toBe(28);
    for (let i = 0; i < 27; i++) {
      run(w, 1, 0);
      expect(fighter(w, 0).invuln).toBeGreaterThan(0);
    }
    run(w, 2, 0);
    const f = fighter(w, 0);
    expect(f.grounded).toBe(true);
    expect(f.pos.x).toBeGreaterThan(-10);
  });

  it('drop (Down) releases the ledge', () => {
    const w = hanging();
    run(w, 8, 0);
    run(w, 1, 0, () => ({ moveY: -1 }));
    const f = fighter(w, 0);
    expect(f.action).toBe('fall');
    expect(f.grounded).toBe(false);
  });

  it('anti-stall: each grab inside 4 s costs 8 invulnerable frames', () => {
    const w = liveWorld(['lion', 'lion']);
    const invs: number[] = [];
    for (let k = 0; k < 4; k++) {
      w.debugPlace(0, -12, -1.5, 0, -2);
      run(w, 1, 0);
      invs.push(fighter(w, 0).invuln);
      run(w, 8, 0);
      run(w, 1, 0, () => ({ moveY: -1 }));
      run(w, 31, 0);
    }
    expect(invs).toEqual([40, 32, 24, 16].map((v) => v - 0)); // grab frame: invuln set, no decrement yet
  });

  it('no ledge grab right after releasing (30 f)', () => {
    const w = hanging();
    run(w, 8, 0);
    run(w, 1, 0, () => ({ moveY: -1 }));
    w.debugPlace(0, -12, -1.5, 0, -2);
    // debugPlace keeps the regrab timer; within 30 frames of release the fighter must not re-grab
    run(w, 2, 0);
    expect(fighter(w, 0).action).not.toBe('ledgeHang');
  });
});

describe('sim: dodge', () => {
  it('spot dodge: invulnerable for dodgeInvuln frames, then vulnerable', () => {
    // fighter 1 swings lightS at fighter 0 (hit on move frame 6) while 0 dodges
    const mk = (dodge: boolean) => {
      const w = liveWorld(['lion', 'lion']);
      w.debugPlace(0, 1.2, 0);
      w.debugPlace(1, 0, 0);
      w.debugSetFacing(1, 1);
      w.setIntent(1, intent({ light: true, moveX: 0.5 }));
      w.setIntent(0, intent({ dodge }));
      w.step();
      w.setIntent(1, intent({ moveX: 0.5 }));
      w.setIntent(0, intent());
      let hits = 0;
      for (let i = 0; i < 40; i++) {
        w.step();
        hits += w.drainEvents().filter((e) => e.type === 'hit').length;
      }
      return hits;
    };
    expect(mk(false)).toBe(1);
    expect(mk(true)).toBe(0);
  });

  it('dodge frames/invuln/cooldown', () => {
    const w = liveWorld(['lion', 'lion']);
    run(w, 1, 0, () => ({ dodge: true }));
    let f = fighter(w, 0);
    expect(f.action).toBe('dodgeSpot');
    expect(f.actionFrames).toBe(26);
    expect(f.invuln).toBe(14);
    expect(f.dodgeCd).toBe(26 + PHYS.dodgeCd);
    run(w, 13, 0);
    expect(fighter(w, 0).invuln).toBe(1);
    run(w, 1, 0);
    expect(fighter(w, 0).invuln).toBe(0);
    run(w, 20, 0);
    expect(fighter(w, 0).action).toBe('idle');
    // pressing again while on cooldown does nothing (buffer expires)
    run(w, 1, 0, () => ({ dodge: true }));
    run(w, 10, 0);
    expect(fighter(w, 0).action).toBe('idle');
    run(w, 40, 0);
    run(w, 1, 0, () => ({ dodge: true }));
    expect(fighter(w, 0).action).toBe('dodgeSpot');
    f = fighter(w, 0);
    expect(f.invuln).toBe(14);
  });

  it('roll: directional, moves the fighter, invulnerable', () => {
    const w = liveWorld(['lion', 'lion']);
    const x0 = fighter(w, 0).pos.x;
    run(w, 1, 0, () => ({ dodge: true, moveX: 1 }));
    expect(fighter(w, 0).action).toBe('dodgeRoll');
    run(w, 30, 0);
    expect(fighter(w, 0).pos.x - x0).toBeGreaterThan(2.5);
    expect(fighter(w, 0).facing).toBe(1);
  });

  it('air dodge: once per airtime, leaves the fighter in free-fall until landing', () => {
    const w = liveWorld(['lion', 'lion']);
    w.debugPlace(0, 0, 18);
    run(w, 1, 0, () => ({ dodge: true }));
    expect(fighter(w, 0).action).toBe('dodgeAir');
    expect(fighter(w, 0).invuln).toBe(14);
    run(w, 26, 0);
    expect(fighter(w, 0).action).toBe('fall');
    expect(w.debugFighter(0).freeFall).toBe(true);
    expect(fighter(w, 0).freeFall).toBe(true); // visible to bots through the snapshot
    expect(fighter(w, 0).airDodgeUsed).toBe(true);
    // no jumping / attacking / second air dodge in free-fall
    const jl = fighter(w, 0).jumpsLeft;
    run(w, 1, 0, () => ({ jump: true, light: true, dodge: true }));
    const f = fighter(w, 0);
    expect(f.jumpsLeft).toBe(jl);
    expect(f.action).toBe('fall');
    // landing resets
    run(w, 120, 0);
    expect(fighter(w, 0).grounded).toBe(true);
    expect(w.debugFighter(0).freeFall).toBe(false);
    expect(w.debugFighter(0).airDodgeUsed).toBe(false);
  });

  it('air dodge is not available during hitstun', () => {
    const w = liveWorld(['lion', 'lion']);
    w.debugPlace(0, 0, 10, 0, 0);
    w.debugPlace(1, -1.2, 10, 0, 0);
    w.debugSetFacing(1, 1);
    // fighter 1 lightS at fighter 0 in the air
    run(w, 1, 1, () => ({ light: true, moveX: 0.6 }));
    for (let i = 0; i < 30; i++) {
      w.step();
      if (fighter(w, 0).action === 'hitstun' || fighter(w, 0).action === 'tumble') break;
    }
    expect(['hitstun', 'tumble']).toContain(fighter(w, 0).action);
    run(w, 2, 0, () => ({ dodge: true }));
    expect(['hitstun', 'tumble']).toContain(fighter(w, 0).action);
    expect(w.debugFighter(0).airDodgeUsed).toBe(false);
  });
});

describe('sim: input buffer', () => {
  it('a press shortly before the fighter can act is not lost', () => {
    const w = liveWorld(['lion', 'lion']);
    // dodge, then press jump during the dodge: the jump happens right after the dodge ends
    run(w, 1, 0, () => ({ dodge: true }));
    run(w, 20, 0);
    run(w, 1, 0, () => ({ jump: true, jumpHeld: true }));
    run(w, 10, 0, () => ({ jumpHeld: true }));
    expect(fighter(w, 0).grounded).toBe(false);
  });
});
