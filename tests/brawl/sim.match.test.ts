import { describe, it, expect } from 'vitest';
import type { BrawlEvent } from '../../src/brawl/types';
import { BrawlWorld } from '../../src/brawl/sim/BrawlWorld';
import { PHYS } from '../../src/brawl/config';
import { cfg, FIXTURE_SOURCE, FIX_STAGES, intent, liveWorld, run } from './fixtures';

type KoEvent = Extract<BrawlEvent, { type: 'ko' }>;

const fighter = (w: BrawlWorld, id: number) => w.snapshot().fighters[id];
const koOf = (events: BrawlEvent[]): KoEvent[] => events.filter((e): e is KoEvent => e.type === 'ko');

describe('sim: KO on every blast side', () => {
  const cases: { side: KoEvent['side']; x: number; y: number; vx: number; vy: number }[] = [
    { side: 'left', x: -29.8, y: 3, vx: -20, vy: 0 },
    { side: 'right', x: 29.8, y: 3, vx: 20, vy: 0 },
    { side: 'top', x: 0, y: 21.8, vx: 0, vy: 20 },
    { side: 'bottom', x: 20, y: -15.5, vx: 0, vy: -20 },
  ];
  for (const c of cases) {
    it(`${c.side}: ko event with the right side, stock lost, percent reset`, () => {
      const w = liveWorld(['lion', 'gorilla']);
      w.debugSetPercent(1, 80);
      w.debugPlace(1, c.x, c.y, c.vx, c.vy);
      let ko: KoEvent | undefined;
      for (let i = 0; i < 10 && !ko; i++) {
        w.step();
        ko = koOf(w.drainEvents())[0];
      }
      expect(ko).toBeDefined();
      expect(ko!.side).toBe(c.side);
      expect(ko!.fighterId).toBe(1);
      expect(ko!.killerId).toBe(-1);
      expect(ko!.stocksLeft).toBe(2);
      const f = fighter(w, 1);
      expect(f.alive).toBe(false);
      expect(f.action).toBe('ko');
      expect(f.stocks).toBe(2);
      expect(f.falls).toBe(1);
      expect(f.percent).toBe(0);
    });
  }

  it('walking off the stage is a self-destruct on the bottom blast line', () => {
    const w = liveWorld(['lion', 'lion']);
    w.debugPlace(0, 14, -2);
    let ko: KoEvent | undefined;
    for (let i = 0; i < 120 && !ko; i++) {
      w.setIntent(0, intent({ moveY: -1 }));
      w.step();
      ko = koOf(w.drainEvents())[0];
    }
    expect(ko?.side).toBe('bottom');
    expect(fighter(w, 0).falls).toBe(1);
  });

  it('the gap of Sky Aqueduct is a KO', () => {
    const w = new BrawlWorld(cfg(['lion', 'lion'], { stage: 'skyAqueduct' }), 1, FIXTURE_SOURCE);
    w.skipCountdown();
    w.debugPlace(0, 0, -2); // under the drifter, between the islands
    let ko: KoEvent | undefined;
    for (let i = 0; i < 200 && !ko; i++) {
      w.step();
      ko = koOf(w.drainEvents())[0];
    }
    expect(ko?.side).toBe('bottom');
  });

  it('credits the last attacker within 4 s, not after', () => {
    const credit = (wait: number) => {
      const w = liveWorld(['lion', 'lion']);
      w.debugPlace(0, 0, 0);
      w.debugPlace(1, 1.2, 0);
      w.debugSetFacing(0, 1);
      run(w, 1, 0, () => ({ light: true, moveX: 0.6 }));
      let hit = false;
      for (let i = 0; i < 30 && !hit; i++) {
        w.step();
        hit = w.drainEvents().some((e) => e.type === 'hit');
      }
      expect(hit).toBe(true);
      run(w, wait, 1);
      w.debugPlace(1, 31, 3, 20, 0);
      let ko: KoEvent | undefined;
      for (let i = 0; i < 5 && !ko; i++) {
        w.step();
        ko = koOf(w.drainEvents())[0];
      }
      return { ko: ko!, kos: fighter(w, 0).kos };
    };
    const quick = credit(100);
    expect(quick.ko.killerId).toBe(0);
    expect(quick.kos).toBe(1);
    const late = credit(260);
    expect(late.ko.killerId).toBe(-1);
    expect(late.kos).toBe(0);
  });
});

describe('sim: respawn', () => {
  /** Fighter 1 is KO'd; returns the world and the frame index (steps since live) of the ko event. */
  function koed() {
    const w = liveWorld(['lion', 'lion']);
    w.debugPlace(1, 31, 3, 20, 0);
    let n = 0;
    let ko = false;
    while (!ko && n < 10) {
      w.step();
      n++;
      ko = koOf(w.drainEvents()).length > 0;
    }
    return w;
  }

  it('is out for 90 frames, then materialises on the respawn platform, invulnerable', () => {
    const w = koed();
    let respawnAt = -1;
    for (let i = 1; i <= 100 && respawnAt < 0; i++) {
      w.step();
      if (w.drainEvents().some((e) => e.type === 'respawn' && e.fighterId === 1)) respawnAt = i;
      else expect(fighter(w, 1).alive).toBe(false);
    }
    expect(respawnAt).toBe(PHYS.koOutFrames);
    const f = fighter(w, 1);
    expect(f.alive).toBe(true);
    expect(f.pos).toEqual(FIX_STAGES.brokenColosseum.respawn);
    expect(f.action).toBe('respawn');
    expect(f.invuln).toBe(180);
    expect(f.percent).toBe(0);
    expect(f.lastHitBy).toBe(-1);
    expect(f.stocks).toBe(2);
  });

  it('cannot be hit while on the respawn platform', () => {
    const w = koed();
    run(w, 90, 1);
    const f1 = fighter(w, 1);
    expect(f1.action).toBe('respawn');
    w.debugPlace(0, f1.pos.x - 1.2, f1.pos.y);
    w.debugSetFacing(0, 1);
    run(w, 1, 0, () => ({ light: true, moveX: 0.6 }));
    let hits = 0;
    for (let i = 0; i < 20; i++) {
      w.step();
      hits += w.drainEvents().filter((e) => e.type === 'hit').length;
    }
    expect(hits).toBe(0);
  });

  it('ends early (after >= 40 frames) on jump, attack, dodge or dropping off; otherwise lasts 180', () => {
    const base = () => {
      const w = koed();
      run(w, 90, 1);
      return w;
    };
    // pressing too early is ignored
    let w = base();
    run(w, 30, 1);
    run(w, 1, 1, () => ({ dodge: true }));
    run(w, 8, 1);
    expect(fighter(w, 1).action).toBe('respawn');
    // jump after 40 frames
    w = base();
    run(w, 44, 1);
    run(w, 1, 1, () => ({ jump: true, jumpHeld: true }));
    expect(fighter(w, 1).action).not.toBe('respawn');
    expect(fighter(w, 1).invuln).toBe(0);
    expect(fighter(w, 1).vel.y).toBeGreaterThan(5);
    // attack
    w = base();
    run(w, 44, 1);
    run(w, 1, 1, () => ({ light: true }));
    expect(fighter(w, 1).action).toBe('attack');
    // dodge
    w = base();
    run(w, 44, 1);
    run(w, 1, 1, () => ({ dodge: true }));
    expect(fighter(w, 1).action).toBe('dodgeAir');
    // drop with Down
    w = base();
    run(w, 44, 1);
    run(w, 3, 1, () => ({ moveY: -1 }));
    expect(fighter(w, 1).action).not.toBe('respawn');
    expect(fighter(w, 1).pos.y).toBeLessThan(12);
    // walk off the edge of the hover platform
    w = base();
    run(w, 44, 1);
    run(w, 90, 1, () => ({ moveX: 1 }));
    expect(fighter(w, 1).action).not.toBe('respawn');
    // idle until the 180-frame timer expires
    w = base();
    run(w, 170, 1);
    expect(fighter(w, 1).action).toBe('respawn');
    run(w, 15, 1);
    expect(fighter(w, 1).action).not.toBe('respawn');
  });

  it('the last stock does not respawn', () => {
    const w = liveWorld(['lion', 'lion', 'lion'], { stocks: 1 });
    w.debugPlace(1, 31, 3, 20, 0);
    run(w, 5, 1);
    expect(fighter(w, 1).stocks).toBe(0);
    run(w, 300, 1);
    expect(fighter(w, 1).alive).toBe(false);
    expect(fighter(w, 1).action).toBe('ko');
  });
});

describe('sim: match end', () => {
  it('last fighter with stocks wins; events are ko then matchEnd; the sim then stops', () => {
    const w = liveWorld(['lion', 'gorilla'], { stocks: 1 });
    w.debugPlace(1, 31, 3, 20, 0);
    run(w, 3, 1);
    const ev = w.drainEvents();
    const kinds = ev.map((e) => e.type).filter((t) => t === 'ko' || t === 'matchEnd');
    expect(kinds).toEqual(['ko', 'matchEnd']);
    const end = ev.find((e) => e.type === 'matchEnd');
    expect(end).toMatchObject({ winnerId: 0 });
    const s = w.snapshot();
    expect(s.matchOver).toBe(true);
    expect(s.winnerId).toBe(0);
    const frame = s.frame;
    run(w, 50, 0);
    expect(w.snapshot().frame).toBe(frame);
    expect(w.drainEvents()).toEqual([]);
  });

  it('3 fighters: ends when only one still has stocks', () => {
    const w = liveWorld(['lion', 'gorilla', 'eagle'], { stocks: 1 });
    w.debugPlace(1, 31, 3, 20, 0);
    run(w, 3, 1);
    expect(w.snapshot().matchOver).toBe(false);
    w.debugPlace(2, -31, 3, -20, 0);
    run(w, 3, 1);
    const s = w.snapshot();
    expect(s.matchOver).toBe(true);
    expect(s.winnerId).toBe(0);
  });

  it('stock count: 3 stocks need 3 KOs', () => {
    const w = liveWorld(['lion', 'lion'], { stocks: 3 });
    for (let k = 0; k < 2; k++) {
      w.debugPlace(1, 31, 3, 20, 0);
      run(w, 3, 1);
      run(w, 95, 1); // respawn
      expect(fighter(w, 1).stocks).toBe(2 - k);
      expect(w.snapshot().matchOver).toBe(false);
    }
    w.debugPlace(1, 31, 3, 20, 0);
    run(w, 3, 1);
    expect(fighter(w, 1).stocks).toBe(0);
    expect(w.snapshot().matchOver).toBe(true);
    expect(w.snapshot().winnerId).toBe(0);
  });

  it('losing the last stock of everyone on the same frame is a draw', () => {
    const w = liveWorld(['lion', 'lion'], { stocks: 1 });
    w.debugPlace(0, 31, 3, 20, 0);
    w.debugPlace(1, -31, 3, -20, 0);
    run(w, 3, 0);
    const s = w.snapshot();
    expect(s.matchOver).toBe(true);
    expect(s.winnerId).toBe(-1);
  });

  describe('time limit', () => {
    const limited = (secs: number) => liveWorld(['lion', 'gorilla'], { timeLimitS: secs });

    it('ends exactly at the limit; reports timeLeft', () => {
      const w = limited(10);
      run(w, 300, 0);
      expect(w.snapshot().timeLeft).toBeCloseTo(5, 6);
      expect(w.snapshot().matchOver).toBe(false);
      run(w, 299, 0);
      expect(w.snapshot().matchOver).toBe(false);
      run(w, 1, 0);
      expect(w.snapshot().matchOver).toBe(true);
      expect(w.snapshot().timeLeft).toBe(0);
    });

    it('no limit: never times out', () => {
      const w = liveWorld(['lion', 'gorilla'], { timeLimitS: 0 });
      run(w, 5000, 0);
      expect(w.snapshot().matchOver).toBe(false);
    });

    it('equal stocks and percent: draw', () => {
      const w = limited(5);
      run(w, 300, 0);
      expect(w.snapshot().matchOver).toBe(true);
      expect(w.snapshot().winnerId).toBe(-1);
    });

    it('tie on stocks: lowest percent wins', () => {
      const w = limited(5);
      w.debugSetPercent(0, 60);
      w.debugSetPercent(1, 35);
      run(w, 300, 0);
      expect(w.snapshot().winnerId).toBe(1);
    });

    it('most stocks wins, regardless of percent', () => {
      const w = limited(5);
      w.debugSetStocks(1, 2);
      w.debugSetPercent(0, 400);
      w.debugSetPercent(1, 0);
      run(w, 300, 0);
      expect(w.snapshot().winnerId).toBe(0);
    });

    it('percent tie among 3 on the lead -> draw only when the best percent is shared', () => {
      const w = liveWorld(['lion', 'gorilla', 'eagle'], { timeLimitS: 5 });
      w.debugSetStocks(2, 1);
      w.debugSetPercent(0, 20);
      w.debugSetPercent(1, 20);
      run(w, 300, 0);
      expect(w.snapshot().winnerId).toBe(-1);
    });
  });

  it('a solo roster ends when its stocks are gone', () => {
    const w = liveWorld(['lion'], { stocks: 1 });
    run(w, 100, 0);
    expect(w.snapshot().matchOver).toBe(false);
    w.debugPlace(0, 31, 3, 20, 0);
    run(w, 3, 0);
    expect(w.snapshot().matchOver).toBe(true);
    expect(w.snapshot().winnerId).toBe(-1);
  });
});

describe('sim: knockdown after a hard launch into the floor', () => {
  it('a tumbling fighter that hits the floor is knocked down, then gets up invulnerable', () => {
    const w = liveWorld(['lion', 'lion']);
    w.debugPlace(0, 0, 4.4);
    w.debugPlace(1, 0.55, 3.0);
    w.debugSetFacing(0, 1);
    w.debugSetPercent(1, 100);
    run(w, 1, 0, () => ({ heavy: true, moveY: -1 }));
    const seq: string[] = [];
    let getupInvuln = 0;
    for (let i = 0; i < 160; i++) {
      w.step();
      const a = fighter(w, 1).action;
      if (seq[seq.length - 1] !== a) seq.push(a);
      if (a === 'getup') getupInvuln = Math.max(getupInvuln, fighter(w, 1).invuln);
    }
    const i0 = seq.indexOf('hitstun');
    expect(i0).toBeGreaterThanOrEqual(0);
    expect(seq.slice(i0, i0 + 5)).toEqual(['hitstun', 'tumble', 'knockdown', 'getup', 'idle']);
    expect(getupInvuln).toBeGreaterThan(5);
  });
});
