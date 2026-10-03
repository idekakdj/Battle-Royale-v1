import { describe, it, expect } from 'vitest';
import type { AnimalId } from '../../src/core/types';
import type { BrawlEvent, BrawlIntent, MoveBody } from '../../src/brawl/types';
import { BrawlWorld } from '../../src/brawl/sim/BrawlWorld';
import type { BrawlDataSource } from '../../src/brawl/sim/dataSource';
import { PHYS } from '../../src/brawl/config';
import { circle, cfg, FIXTURE_SOURCE, intent, liveWorld, run } from './fixtures';

type HitEvent = Extract<BrawlEvent, { type: 'hit' }>;

const fighter = (w: BrawlWorld, id: number) => w.snapshot().fighters[id];
const hitsOf = (w: BrawlWorld): HitEvent[] => w.drainEvents().filter((e): e is HitEvent => e.type === 'hit');

/** Fighter 0 at the origin facing +x, fighter 1 `dist` metres in front facing back. */
function duel(a: AnimalId, b: AnimalId, dist = 1.2): BrawlWorld {
  const w = liveWorld([a, b]);
  w.debugPlace(0, 0, 0);
  w.debugPlace(1, dist, 0);
  w.debugSetFacing(0, 1);
  w.debugSetFacing(1, -1);
  return w;
}

/** Press an attack with fighter 0 and step until the first hit event (returns it). */
function swingUntilHit(w: BrawlWorld, press: Partial<BrawlIntent>, max = 40): HitEvent {
  run(w, 1, 0, () => press);
  let got = hitsOf(w);
  for (let i = 0; i < max && got.length === 0; i++) {
    run(w, 1, 0);
    got = hitsOf(w);
  }
  expect(got.length).toBeGreaterThan(0);
  return got[0];
}

const SIDE_LIGHT = { light: true, moveX: 0.6 };
const SIDE_HEAVY = { heavy: true, moveX: 0.6 };

describe('sim: hit resolution (plan §2.2 formulas)', () => {
  it('lightS at 0 %: damage, knockback, hitlag per the formulas', () => {
    const w = duel('lion', 'lion');
    const h = swingUntilHit(w, SIDE_LIGHT);
    expect(h.attackerId).toBe(0);
    expect(h.targetId).toBe(1);
    expect(h.moveId).toBe('lightS');
    expect(h.damage).toBeCloseTo(7, 9);
    expect(h.percentAfter).toBeCloseTo(7, 9);
    expect(h.kbSpeed).toBeCloseTo(6 + (9 * 7) / 100, 9);
    expect(h.angle).toBeCloseTo(35, 9);
    expect(h.hitlag).toBe(Math.round(7 * 0.4) + 4);
    expect(h.sweetspot).toBe(false);
    expect(fighter(w, 0).damageDealt).toBeCloseTo(7, 9);
    expect(fighter(w, 1).percent).toBeCloseTo(7, 9);
    expect(fighter(w, 1).lastHitBy).toBe(0);
  });

  it('knockback grows with the victim percent', () => {
    const kb: number[] = [];
    for (const pct of [0, 50, 100, 200]) {
      const w = duel('lion', 'lion');
      w.debugSetPercent(1, pct);
      kb.push(swingUntilHit(w, SIDE_LIGHT).kbSpeed);
    }
    expect(kb[1]).toBeGreaterThan(kb[0]);
    expect(kb[2]).toBeGreaterThan(kb[1]);
    expect(kb[3]).toBeGreaterThan(kb[2]);
    expect(kb[2]).toBeCloseTo(6 + (9 * 107) / 100, 9);
  });

  it('knockback scales inversely with weight (100 / weight)', () => {
    const light = swingUntilHit(duel('lion', 'mole'), SIDE_LIGHT).kbSpeed; // weight 72
    const mid = swingUntilHit(duel('lion', 'lion'), SIDE_LIGHT).kbSpeed; // 100
    const heavy = swingUntilHit(duel('lion', 'gorilla'), SIDE_LIGHT).kbSpeed; // 125
    expect(mid / heavy).toBeCloseTo(125 / 100, 9);
    expect(light / mid).toBeCloseTo(100 / 72, 9);
    expect(light).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(heavy);
  });

  it('knockback is capped at 62 m/s and percent at 999', () => {
    const w = duel('lion', 'mole');
    w.debugSetPercent(1, 990);
    const h = swingUntilHit(w, SIDE_HEAVY, 60);
    expect(h.kbSpeed).toBe(62);
    expect(h.percentAfter).toBe(999);
  });

  it('freezes attacker and victim for the hitlag, then launches', () => {
    const w = duel('lion', 'lion');
    const h = swingUntilHit(w, SIDE_LIGHT);
    expect(h.hitlag).toBe(7);
    const a0 = fighter(w, 0);
    const v0 = fighter(w, 1);
    expect(a0.hitlag).toBe(7);
    expect(v0.hitlag).toBe(7);
    expect(v0.action).toBe('hitstun');
    for (let i = 0; i < 7; i++) {
      run(w, 1, 0);
      const a = fighter(w, 0);
      const v = fighter(w, 1);
      expect(a.moveFrame).toBe(a0.moveFrame);
      expect(v.pos.x).toBe(v0.pos.x);
      expect(v.pos.y).toBe(v0.pos.y);
    }
    run(w, 1, 0);
    expect(fighter(w, 1).pos.x).toBeGreaterThan(v0.pos.x);
    expect(fighter(w, 0).moveFrame).toBe(a0.moveFrame + 1);
  });

  it('hitstun = clamp(floor(kb * PHYS.hitstunPerKb * scale), 6, 60); tumble above 20 m/s', () => {
    const w = duel('lion', 'lion');
    swingUntilHit(w, SIDE_LIGHT);
    expect(fighter(w, 1).hitstunTotal).toBe(6);
    expect(fighter(w, 1).hitstun).toBe(6);
    run(w, 7, 0); // hitlag
    expect(fighter(w, 1).action).toBe('hitstun');
    run(w, 7, 0);
    expect(['fall', 'idle']).toContain(fighter(w, 1).action);

    const w2 = duel('lion', 'lion');
    w2.debugSetPercent(1, 150);
    const h = swingUntilHit(w2, SIDE_HEAVY, 60);
    expect(h.kbSpeed).toBeGreaterThan(20);
    expect(fighter(w2, 1).hitstunTotal).toBe(Math.floor(h.kbSpeed * PHYS.hitstunPerKb));
    run(w2, 1 + h.hitlag, 0);
    expect(fighter(w2, 1).action).toBe('tumble');
    expect(fighter(w2, 1).lastLaunch?.speed).toBeCloseTo(h.kbSpeed, 9);
  });

  it('launch direction is mirrored by the attacker facing', () => {
    const w = liveWorld(['lion', 'lion']);
    w.debugPlace(0, 3, 0);
    w.debugPlace(1, 1.8, 0);
    w.debugSetFacing(0, -1);
    const h = swingUntilHit(w, { light: true, moveX: -0.6 });
    expect(h.angle).toBeCloseTo(180 - 35, 9);
    run(w, 1 + h.hitlag, 0);
    expect(fighter(w, 1).vel.x).toBeLessThan(0);
    expect(fighter(w, 1).vel.y).toBeGreaterThan(0);
  });

  it('sweetspot multiplies damage and knockback', () => {
    const w = duel('lion', 'lion', 1.8); // victim centre (1.8, 0.75) is inside the sweet circle (1.8, 1.0, 0.3)
    const h = swingUntilHit(w, SIDE_HEAVY, 60);
    expect(h.moveId).toBe('heavyS');
    expect(h.sweetspot).toBe(true);
    expect(h.damage).toBeCloseTo(16 * 1.25, 9);
    expect(h.kbSpeed).toBeCloseTo((9 + (19 * (16 * 1.25)) / 100) * 1.2, 9);
    const w2 = duel('lion', 'lion', 1.2);
    const h2 = swingUntilHit(w2, SIDE_HEAVY, 60);
    expect(h2.sweetspot).toBe(false);
    expect(h2.damage).toBeCloseTo(16, 9);
  });

  it('misses just outside the hitbox, hits just inside', () => {
    // lightS circle: centre (1.2, 0.9), r 0.5; victim hurtbox half width 0.55 → reach to x = 1.2 + 0.5 + 0.55
    const inside = duel('lion', 'lion', 2.24);
    const outside = duel('lion', 'lion', 2.26);
    run(inside, 1, 0, () => SIDE_LIGHT);
    run(outside, 1, 0, () => SIDE_LIGHT);
    let a = 0;
    let b = 0;
    for (let i = 0; i < 20; i++) {
      run(inside, 1, 0);
      run(outside, 1, 0);
      a += hitsOf(inside).length;
      b += hitsOf(outside).length;
    }
    expect(a).toBe(1);
    expect(b).toBe(0);
  });

  it('stale-move queue: -3 % per recent use of the same move, max -15 %', () => {
    const w = duel('lion', 'lion');
    const dmg: number[] = [];
    for (let k = 0; k < 8; k++) {
      w.debugPlace(0, 0, 0);
      w.debugPlace(1, 1.2, 0);
      w.debugSetFacing(0, 1);
      w.debugSetPercent(1, 0);
      run(w, 40, 0, (i) => (i === 0 ? SIDE_LIGHT : {}));
      const h = hitsOf(w);
      expect(h).toHaveLength(1);
      dmg.push(h[0].damage);
    }
    const expected = [1, 0.97, 0.94, 0.91, 0.88, 0.85, 0.85, 0.85].map((m) => 7 * m);
    dmg.forEach((d, i) => expect(d).toBeCloseTo(expected[i], 9));
  });

  it('only connected moves stale; a different move is unaffected', () => {
    const w = duel('lion', 'lion');
    // whiff lightS three times
    for (let k = 0; k < 3; k++) {
      w.debugPlace(1, 6, 0);
      run(w, 30, 0, (i) => (i === 0 ? SIDE_LIGHT : {}));
    }
    w.drainEvents();
    w.debugPlace(0, 0, 0);
    w.debugPlace(1, 1.2, 0);
    const h = swingUntilHit(w, SIDE_LIGHT);
    expect(h.damage).toBeCloseTo(7, 9);
  });

  it('highest-damage hitbox wins when two hitboxes of one move overlap; same group hits once', () => {
    const w = duel('lion', 'lion', 0); // victim stands inside both halves of the Roar burst
    const hits: HitEvent[] = [];
    run(w, 1, 0, () => ({ heavy: true }));
    for (let i = 0; i < 30; i++) {
      run(w, 1, 0);
      hits.push(...hitsOf(w));
    }
    expect(hits).toHaveLength(1);
    expect(hits[0].moveId).toBe('heavyN');
    expect(hits[0].damage).toBeCloseTo(11, 9);
  });
});

describe('sim: light-neutral string (chain)', () => {
  it('is a true combo from 0 %: three hits, the victim never leaves hitstun', () => {
    const w = duel('lion', 'lion', 1.0);
    const hits: HitEvent[] = [];
    const starts: number[] = [];
    let free = 0;
    for (let i = 0; i < 90; i++) {
      w.setIntent(0, intent({ light: true })); // mash
      w.step();
      for (const e of w.drainEvents()) {
        if (e.type === 'hit') hits.push(e);
        if (e.type === 'moveStart' && e.fighterId === 0) starts.push(e.chain);
      }
      if (hits.length >= 1 && hits.length < 3) {
        const v = fighter(w, 1);
        if (!(v.action === 'hitstun' || v.action === 'tumble')) free++;
      }
    }
    expect(starts.slice(0, 3)).toEqual([0, 1, 2]);
    expect(hits.slice(0, 3).map((h) => h.moveId)).toEqual(['lightN', 'lightN', 'lightN']);
    expect(free).toBe(0);
    // chain bodies 2 and 3 use their own damage (3 and 4), staled once (-3 %)
    expect(hits[1].damage).toBeCloseTo(3 * 0.97, 9);
    expect(hits[2].damage).toBeCloseTo(4 * 0.97, 9);
  });

  it('first link can whiff and still continue; later links need a hit', () => {
    const w = duel('lion', 'lion', 8); // out of reach
    const starts: number[] = [];
    for (let i = 0; i < 60; i++) {
      w.setIntent(0, intent({ light: true }));
      w.step();
      for (const e of w.drainEvents()) if (e.type === 'moveStart' && e.fighterId === 0) starts.push(e.chain);
    }
    // 2nd body is reachable on a whiff (onHitOnly false), the 3rd is not (it needs a hit)
    expect(starts).toContain(1);
    expect(starts).not.toContain(2);
  });
});

describe('sim: armor', () => {
  it('absorbs `hits` hits (damage x dmgScale, no knockback), then breaks', () => {
    // gorilla starts its armored heavy-side; two lions hit it on the same frame inside the armor window
    const w = liveWorld(['gorilla', 'lion', 'lion']);
    w.debugPlace(0, 0, 0);
    w.debugPlace(1, 1.2, 0);
    w.debugPlace(2, -1.2, 0);
    w.debugSetFacing(0, 1);
    w.debugSetFacing(1, -1);
    w.debugSetFacing(2, 1);
    w.setIntent(0, intent({ heavy: true, moveX: 0.6 }));
    w.setIntent(1, intent({ light: true, moveX: -0.6 }));
    w.setIntent(2, intent({ light: true, moveX: 0.6 }));
    w.step();
    const hits: HitEvent[] = [];
    for (let i = 0; i < 12; i++) {
      w.step();
      hits.push(...hitsOf(w));
      if (hits.length >= 2) break;
    }
    expect(hits).toHaveLength(2);
    // first (attacker 1): absorbed
    expect(hits[0].attackerId).toBe(1);
    expect(hits[0].kbSpeed).toBe(0);
    expect(hits[0].damage).toBeCloseTo(3.5, 9); // 7 x 0.5
    // second (attacker 2): armor spent -> real hit
    expect(hits[1].attackerId).toBe(2);
    expect(hits[1].kbSpeed).toBeGreaterThan(0);
    const g = fighter(w, 0);
    expect(g.percent).toBeCloseTo(3.5 + 7 * 0.97 * 0 + hits[1].damage, 9);
    expect(g.action).toBe('hitstun');
  });

  it('an armored hit leaves the move running and the fighter unmoved', () => {
    const w = liveWorld(['gorilla', 'lion']);
    w.debugPlace(0, 0, 0);
    w.debugPlace(1, 1.2, 0);
    w.debugSetFacing(0, 1);
    w.debugSetFacing(1, -1);
    w.setIntent(0, intent({ heavy: true, moveX: 0.6 }));
    w.setIntent(1, intent({ light: true, moveX: -0.6 }));
    w.step();
    let h: HitEvent | undefined;
    for (let i = 0; i < 12 && !h; i++) {
      w.step();
      h = hitsOf(w)[0];
    }
    expect(h).toBeDefined();
    const g = fighter(w, 0);
    expect(g.action).toBe('attack');
    expect(g.moveId).toBe('heavyS');
    expect(g.hitstun).toBe(0);
    expect(g.vel.x).toBeCloseTo(0, 6);
    expect(h!.kbSpeed).toBe(0);
  });

  it('armored (armor-locked) side moves do not turn toward the stick; unarmored ones do', () => {
    const w = liveWorld(['gorilla', 'lion']);
    w.debugSetFacing(0, 1);
    run(w, 1, 0, () => ({ heavy: true, moveX: -1 }));
    expect(fighter(w, 0).moveId).toBe('heavyS');
    expect(fighter(w, 0).facing).toBe(1);
    const w2 = liveWorld(['lion', 'lion']);
    w2.debugSetFacing(0, 1);
    run(w2, 1, 0, () => ({ light: true, moveX: -1 }));
    expect(fighter(w2, 0).moveId).toBe('lightS');
    expect(fighter(w2, 0).facing).toBe(-1);
  });
});

describe('sim: multi-hit, effects and spikes', () => {
  it('multiHitInterval re-hits the same victim every interval frames', () => {
    const w = duel('crocodile', 'lion', 1.2);
    run(w, 1, 0, () => ({ heavy: true }));
    const hits: HitEvent[] = [];
    for (let i = 0; i < 80; i++) {
      run(w, 1, 0);
      hits.push(...hitsOf(w));
    }
    expect(hits.length).toBeGreaterThanOrEqual(3);
    expect(hits.length).toBeLessThanOrEqual(4);
    expect(new Set(hits.map((h) => h.moveId))).toEqual(new Set(['heavyN']));
  });

  it("'pull' drags the victim toward the attacker", () => {
    const w = duel('crocodile', 'lion', 1.4);
    run(w, 1, 0, () => ({ heavy: true }));
    let h: HitEvent | undefined;
    for (let i = 0; i < 40 && !h; i++) {
      run(w, 1, 0);
      h = hitsOf(w)[0];
    }
    expect(h).toBeDefined();
    run(w, 1 + h!.hitlag, 0);
    expect(fighter(w, 1).vel.x).toBeLessThan(0);
  });

  it('spike: bounces a grounded victim up, meteors an airborne victim down', () => {
    // attacker in the air above the front of the victim doing the aerial heavy-down
    const run1 = (victimY: number) => {
      const w = liveWorld(['lion', 'lion']);
      w.debugPlace(0, 0, victimY + 1.4);
      w.debugPlace(1, 0.55, victimY);
      w.debugSetFacing(0, 1);
      run(w, 1, 0, () => ({ heavy: true, moveY: -1 }));
      let h: HitEvent | undefined;
      for (let i = 0; i < 25 && !h; i++) {
        run(w, 1, 0);
        h = hitsOf(w)[0];
      }
      expect(h).toBeDefined();
      expect(h!.moveId).toBe('heavyD');
      expect(h!.angle).toBeCloseTo(270, 9);
      run(w, 1 + h!.hitlag, 0);
      return fighter(w, 1);
    };
    const grounded = run1(0);
    expect(grounded.vel.y).toBeGreaterThan(0);
    const airborne = run1(12);
    expect(airborne.vel.y).toBeLessThan(0);
  });
});

describe('sim: directional influence', () => {
  it('holding perpendicular to the launch rotates it, at most 12 deg in total', () => {
    const angleAfter = (diY: number) => {
      const w = duel('lion', 'lion');
      w.debugSetPercent(1, 100);
      const h = swingUntilHit(w, SIDE_HEAVY, 60);
      run(w, h.hitlag, 0);
      for (let i = 0; i < 14; i++) {
        w.setIntent(1, intent({ moveY: diY }));
        w.step();
      }
      const v = fighter(w, 1);
      expect(w.debugFighter(1).diUsed).toBeLessThanOrEqual(12 + 1e-9);
      expect(w.debugFighter(1).diUsed).toBeGreaterThanOrEqual(-12 - 1e-9);
      return (Math.atan2(v.vel.y, v.vel.x) * 180) / Math.PI;
    };
    const none = angleAfter(0);
    const up = angleAfter(1);
    const down = angleAfter(-1);
    expect(up).toBeGreaterThan(none + 5);
    expect(down).toBeLessThan(none - 5);
    expect(up - down).toBeLessThan(2 * 13 + 4);
  });
});

describe('sim: aerials, landing lag and recovery', () => {
  it('landing during an aerial costs landingLag; the autoCancel window lands free', () => {
    const lag = (height: number) => {
      const w = liveWorld(['lion', 'lion']);
      w.debugPlace(0, -3, height);
      w.debugPlace(1, 8, 0);
      run(w, 1, 0, () => ({ light: true, moveX: 0.6 }));
      let frames = 0;
      while (!fighter(w, 0).grounded && frames < 80) {
        run(w, 1, 0);
        frames++;
      }
      const f = fighter(w, 0);
      return { action: f.action, actionFrames: f.actionFrames, moveFrame: f.moveFrame, frames };
    };
    const early = lag(1.0); // lands while the aerial is still in startup/active
    expect(early.action).toBe('landing');
    expect(early.actionFrames).toBe(8);
    const late = lag(2.0); // lands inside the autoCancel window [17, 23)
    expect(late.action).toBe('idle');
  });

  it('landing lag locks actions until it is over', () => {
    const w = liveWorld(['lion', 'lion']);
    w.debugPlace(0, -3, 1.0);
    w.debugPlace(1, 8, 0);
    run(w, 1, 0, () => ({ light: true, moveX: 0.6 }));
    while (!fighter(w, 0).grounded) run(w, 1, 0);
    expect(fighter(w, 0).action).toBe('landing');
    run(w, 3, 0, () => ({ light: true }));
    expect(fighter(w, 0).action).toBe('landing');
    run(w, 10, 0);
    expect(fighter(w, 0).action).not.toBe('landing');
  });

  it('heavy-up (recovery) once per airtime; usable on the ground; reset by landing', () => {
    const w = liveWorld(['lion', 'lion']);
    w.debugPlace(0, 0, 12);
    run(w, 1, 0, () => ({ heavy: true, moveY: 1 }));
    expect(fighter(w, 0).moveId).toBe('heavyU');
    expect(fighter(w, 0).moveAir).toBe(true);
    run(w, 47, 0); // the whole move (8 + 14 + 24 frames), still airborne
    expect(fighter(w, 0).action).not.toBe('attack');
    expect(fighter(w, 0).grounded).toBe(false);
    // second use in the same airtime is refused
    run(w, 1, 0, () => ({ heavy: true, moveY: 1 }));
    expect(fighter(w, 0).action).not.toBe('attack');
    // land, then it is back (and works on the ground as a launcher)
    run(w, 200, 0);
    expect(fighter(w, 0).grounded).toBe(true);
    run(w, 1, 0, () => ({ heavy: true, moveY: 1 }));
    expect(fighter(w, 0).moveId).toBe('heavyU');
    expect(fighter(w, 0).moveAir).toBe(false);
  });

  it('heavy-up recovery travels upward', () => {
    const w = liveWorld(['lion', 'lion']);
    w.debugPlace(0, 0, 6, 0, -8);
    const y0 = fighter(w, 0).pos.y;
    let top = y0;
    run(w, 1, 0, () => ({ heavy: true, moveY: 1 }));
    for (let i = 0; i < 40; i++) {
      run(w, 1, 0);
      top = Math.max(top, fighter(w, 0).pos.y);
    }
    expect(top).toBeGreaterThan(y0 + 2.5);
  });

  it('move invulnerability windows skip the victim like a dodge', () => {
    const mk = (animal: AnimalId) => {
      const w = liveWorld([animal, 'lion']);
      w.debugPlace(0, 0, 0);
      w.debugPlace(1, 1.2, 0);
      w.debugSetFacing(0, 1);
      w.debugSetFacing(1, -1);
      w.setIntent(0, intent({ heavy: true, moveY: 1 })); // panther heavyU: invulnerable frames 0..11
      w.setIntent(1, intent({ light: true, moveX: -0.6 }));
      w.step();
      let n = 0;
      for (let i = 0; i < 8; i++) {
        w.step();
        n += hitsOf(w).filter((h) => h.targetId === 0).length;
      }
      return n;
    };
    expect(mk('lion')).toBe(1);
    expect(mk('panther')).toBe(0);
  });
});

describe('sim: hitboxes in the snapshot & move data conventions', () => {
  it('exposes active hitboxes in world space (mirrored by facing)', () => {
    const w = duel('lion', 'lion', 8);
    run(w, 1, 0, () => SIDE_LIGHT);
    let seen = false;
    for (let i = 0; i < 12; i++) {
      run(w, 1, 0);
      const s = w.snapshot();
      if (s.hitboxes.length) {
        seen = true;
        const hb = s.hitboxes[0];
        expect(hb.fighterId).toBe(0);
        expect(hb.moveId).toBe('lightS');
        expect(hb.shape).toBe('circle');
        expect(hb.r).toBeCloseTo(0.5, 9);
        expect(hb.x).toBeCloseTo(s.fighters[0].pos.x + 1.2, 6);
        expect(hb.y).toBeCloseTo(s.fighters[0].pos.y + 0.9, 6);
      }
    }
    expect(seen).toBe(true);
    const w2 = liveWorld(['lion', 'lion']);
    w2.debugPlace(0, 0, 0);
    w2.debugPlace(1, -8, 0);
    run(w2, 1, 0, () => ({ light: true, moveX: -0.6 }));
    for (let i = 0; i < 12; i++) {
      run(w2, 1, 0);
      const s = w2.snapshot();
      if (s.hitboxes.length) expect(s.hitboxes[0].x).toBeCloseTo(s.fighters[0].pos.x - 1.2, 6);
    }
  });

  it('path keyframes move the hitbox over the active window (move-relative frames, interpolated)', () => {
    const swept: MoveBody = {
      name: 'sweep',
      archetype: 'swipe',
      startup: 4,
      active: 4,
      recovery: 10,
      hitboxes: [circle(0.5, 1, 0.4, 4, 8, 5, 5, 5, 40, { path: [{ frame: 4, x: 0, y: 0 }, { frame: 8, x: 2, y: 0 }] })],
    };
    const src: BrawlDataSource = {
      ...FIXTURE_SOURCE,
      getMoveBody: (animal, id, air, chain) => (animal === 'lion' && id === 'lightS' ? swept : FIXTURE_SOURCE.getMoveBody(animal, id, air, chain)),
    };
    const w = new BrawlWorld(cfg(['lion', 'lion']), 1, src);
    w.skipCountdown();
    w.debugPlace(0, 0, 0);
    w.debugPlace(1, 9, 0);
    run(w, 1, 0, () => SIDE_LIGHT);
    const xs: number[] = [];
    for (let i = 0; i < 10; i++) {
      run(w, 1, 0);
      for (const hb of w.snapshot().hitboxes) xs.push(hb.x);
    }
    expect(xs.length).toBe(4);
    expect(xs[0]).toBeCloseTo(0.5, 6);
    expect(xs[1]).toBeCloseTo(0.5 + 0.5, 6);
    expect(xs[3]).toBeCloseTo(0.5 + 1.5, 6);
  });

  it('simultaneous hits trade: both fighters are hit on the same frame', () => {
    const w = duel('lion', 'lion', 1.2);
    w.setIntent(0, intent({ light: true, moveX: 0.6 }));
    w.setIntent(1, intent({ light: true, moveX: -0.6 }));
    w.step();
    const hits: HitEvent[] = [];
    for (let i = 0; i < 15; i++) {
      w.step();
      hits.push(...hitsOf(w));
    }
    expect(hits.map((h) => h.targetId).sort()).toEqual([0, 1]);
    expect(fighter(w, 0).percent).toBeGreaterThan(0);
    expect(fighter(w, 1).percent).toBeGreaterThan(0);
  });

  it('hit events carry the PHYS-derived hitlag clamp', () => {
    expect(PHYS.hitlagMin).toBe(4);
    expect(PHYS.hitlagMax).toBe(16);
    const w = duel('lion', 'lion');
    w.debugSetPercent(1, 0);
    const h = swingUntilHit(w, SIDE_HEAVY, 60);
    expect(h.hitlag).toBeGreaterThanOrEqual(4);
    expect(h.hitlag).toBeLessThanOrEqual(16);
  });
});
