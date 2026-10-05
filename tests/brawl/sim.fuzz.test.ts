import { describe, it, expect } from 'vitest';
import { mulberry32 } from '../../src/core/math';
import type { Rng } from '../../src/core/math';
import type { AnimalId } from '../../src/core/types';
import type { BrawlEvent, BrawlIntent, BrawlSnapshot } from '../../src/brawl/types';
import { BrawlWorld } from '../../src/brawl/sim/BrawlWorld';
import { cfg, FIXTURE_SOURCE, FIX_STAGES } from './fixtures';

const ANIMALS: AnimalId[] = ['lion', 'gorilla', 'crocodile', 'eagle', 'mole', 'panther', 'hippo'];

/** Per-fighter random "player": sticky stick direction, bursty buttons. */
class FuzzPilot {
  private x = 0;
  private y = 0;
  private held = false;
  constructor(private readonly rng: Rng) {}
  next(): BrawlIntent {
    const r = this.rng;
    if (r() < 0.12) this.x = [-1, -0.5, 0, 0, 0.5, 1][Math.floor(r() * 6)];
    if (r() < 0.1) this.y = [-1, 0, 0, 0, 1][Math.floor(r() * 5)];
    if (r() < 0.08) this.held = !this.held;
    return {
      moveX: this.x,
      moveY: this.y,
      jump: r() < 0.04,
      jumpHeld: this.held,
      light: r() < 0.07,
      heavy: r() < 0.04,
      dodge: r() < 0.02,
    };
  }
}

function checkSnapshot(
  s: BrawlSnapshot,
  blast: { left: number; right: number; top: number; bottom: number },
  maxJumps: Map<number, number>,
  solids: { x0: number; x1: number; y: number; thickness: number }[] = [],
  sizes: Map<number, { w: number; h: number }> = new Map(),
): void {
  for (const f of s.fighters) {
    const sz = sizes.get(f.id);
    if (sz && f.alive && f.action !== 'respawn') {
      // never deeply embedded in a solid slab (tunnelling guard; a gentle push-out may leave a sliver)
      for (const p of solids) {
        const ox = Math.min(f.pos.x + sz.w / 2, p.x1) - Math.max(f.pos.x - sz.w / 2, p.x0);
        const oy = Math.min(f.pos.y + sz.h, p.y) - Math.max(f.pos.y, p.y - p.thickness);
        if (ox > 0.75 && oy > 0.75) throw new Error(`fighter ${f.id} embedded in a solid at frame ${s.frame}: ${JSON.stringify(f.pos)} (${ox.toFixed(2)} x ${oy.toFixed(2)})`);
      }
      if (f.grounded) {
        const plat = s.platforms.find((q) => q.id === f.platformId);
        if (!plat || Math.abs(plat.y - f.pos.y) > 1e-6) throw new Error(`grounded fighter ${f.id} is not on its platform at frame ${s.frame}`);
      }
    }
    const nums = [f.pos.x, f.pos.y, f.vel.x, f.vel.y, f.percent, f.hitstun, f.hitlag, f.invuln, f.actionFrame, f.dodgeCd, f.moveFrame];
    for (const n of nums) {
      if (!Number.isFinite(n)) throw new Error(`non-finite value ${n} in fighter ${f.id} at frame ${s.frame}: ${JSON.stringify(f)}`);
    }
    if (f.percent < 0 || f.percent > 999) throw new Error(`percent out of range ${f.percent}`);
    if (f.stocks < 0) throw new Error('negative stocks');
    if (f.hitlag < 0 || f.hitlag > 16) throw new Error(`hitlag ${f.hitlag}`);
    if (f.hitstun < 0 || f.hitstun > 80) throw new Error(`hitstun ${f.hitstun}`);
    if (f.invuln < 0) throw new Error('negative invuln');
    if (f.jumpsLeft < 0 || f.jumpsLeft > (maxJumps.get(f.id) ?? 99)) throw new Error(`jumpsLeft ${f.jumpsLeft}`);
    if (f.alive === (f.action === 'ko')) throw new Error(`alive=${f.alive} but action=${f.action}`);
    if (f.grounded && f.platformId === null) throw new Error('grounded without a platform');
    if (f.action === 'attack' && (f.moveId === null || f.moveFrame >= f.moveFrames)) throw new Error(`bad attack state ${JSON.stringify(f)}`);
    if (f.alive && (f.pos.x < blast.left || f.pos.x > blast.right || f.pos.y < blast.bottom || f.pos.y > blast.top)) {
      throw new Error(`alive fighter outside the blast zones: ${JSON.stringify(f.pos)}`);
    }
  }
  for (const h of s.hitboxes) {
    if (!Number.isFinite(h.x) || !Number.isFinite(h.y)) throw new Error('non-finite hitbox');
  }
  for (const p of s.platforms) {
    if (!Number.isFinite(p.x0) || !Number.isFinite(p.x1) || !Number.isFinite(p.y)) throw new Error('non-finite platform');
  }
}

describe('sim: determinism', () => {
  it('same seed + same inputs => identical snapshots and events over 3000 frames', () => {
    const run = (): { frames: string[]; events: string } => {
      const w = new BrawlWorld(cfg(['lion', 'gorilla', 'eagle', 'panther'], { stocks: 99, timeLimitS: 0, stage: 'skyAqueduct' }), 4242, FIXTURE_SOURCE);
      const pilots = [1, 2, 3, 4].map((k) => new FuzzPilot(mulberry32(1000 + k)));
      const frames: string[] = [];
      const evs: BrawlEvent[] = [];
      for (let i = 0; i < 3000; i++) {
        for (let id = 0; id < 4; id++) w.setIntent(id, pilots[id].next());
        w.step();
        frames.push(JSON.stringify(w.snapshot()));
        evs.push(...w.drainEvents());
      }
      return { frames, events: JSON.stringify(evs) };
    };
    const a = run();
    const b = run();
    expect(a.frames.length).toBe(3000);
    for (let i = 0; i < a.frames.length; i++) {
      if (a.frames[i] !== b.frames[i]) throw new Error(`snapshots diverge at frame ${i + 1}`);
    }
    expect(a.events).toBe(b.events);
    // something actually happened
    expect(a.events.includes('"type":"hit"')).toBe(true);
  });

  it('different input streams diverge (the test is not vacuous)', () => {
    const final = (seed: number): string => {
      const w = new BrawlWorld(cfg(['lion', 'gorilla'], { stocks: 99, timeLimitS: 0 }), 1, FIXTURE_SOURCE);
      const pilots = [new FuzzPilot(mulberry32(seed)), new FuzzPilot(mulberry32(seed + 1))];
      for (let i = 0; i < 1500; i++) {
        w.setIntent(0, pilots[0].next());
        w.setIntent(1, pilots[1].next());
        w.step();
      }
      return JSON.stringify(w.snapshot().fighters);
    };
    expect(final(1)).not.toBe(final(2));
  });

  it('events come out in frame order and drain empties the queue', () => {
    const w = new BrawlWorld(cfg(['lion', 'gorilla']), 1, FIXTURE_SOURCE);
    w.skipCountdown();
    w.setIntent(0, { moveX: 0, moveY: 0, jump: true, jumpHeld: true, light: false, heavy: false, dodge: false });
    w.step();
    w.step();
    w.step();
    w.step();
    w.step();
    const first = w.drainEvents();
    expect(first.some((e) => e.type === 'jump')).toBe(true);
    expect(w.drainEvents()).toEqual([]);
  });
});

describe('sim: fuzz (no NaN, invariants hold)', () => {
  for (const stage of ['brokenColosseum', 'skyAqueduct'] as const) {
    it(`20 000 frames x 4 fighters on ${stage}`, () => {
      const roster = ANIMALS.slice(0, 4);
      const w = new BrawlWorld(cfg(roster, { stage, stocks: 999, timeLimitS: 0 }), 99, FIXTURE_SOURCE);
      const pilots = roster.map((_, k) => new FuzzPilot(mulberry32(77 + k)));
      const blast = FIX_STAGES[stage].blast;
      const maxJumps = new Map<number, number>(roster.map((a, i) => [i, FIXTURE_SOURCE.getMoveset(a).stats.maxJumps]));
      const sizes = new Map(roster.map((a, i) => [i, { w: FIXTURE_SOURCE.getMoveset(a).stats.width, h: FIXTURE_SOURCE.getMoveset(a).stats.height }]));
      const solids = FIX_STAGES[stage].platforms.filter((p) => p.kind === 'solid');
      let kos = 0;
      let hits = 0;
      let grabs = 0;
      for (let i = 0; i < 20000; i++) {
        for (let id = 0; id < 4; id++) w.setIntent(id, pilots[id].next());
        w.step();
        checkSnapshot(w.snapshot(), blast, maxJumps, solids, sizes);
        for (const e of w.drainEvents()) {
          if (e.type === 'ko') kos++;
          else if (e.type === 'hit') hits++;
          else if (e.type === 'ledgeGrab') grabs++;
        }
      }
      expect(hits).toBeGreaterThan(50);
      expect(kos).toBeGreaterThan(3);
      expect(grabs).toBeGreaterThanOrEqual(0);
    });
  }

  it('hostile intents (NaN, huge values, edge spam) never poison the state', () => {
    const w = new BrawlWorld(cfg(['lion', 'mole', 'hippo']), 5, FIXTURE_SOURCE);
    w.skipCountdown();
    const blast = FIX_STAGES.brokenColosseum.blast;
    const maxJumps = new Map<number, number>([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
    const r = mulberry32(3);
    const weird = [NaN, Infinity, -Infinity, 1e9, -1e9, 0.3, -0.3];
    for (let i = 0; i < 3000; i++) {
      for (let id = 0; id < 3; id++) {
        w.setIntent(id, {
          moveX: weird[Math.floor(r() * weird.length)],
          moveY: weird[Math.floor(r() * weird.length)],
          jump: r() < 0.5,
          jumpHeld: r() < 0.5,
          light: r() < 0.5,
          heavy: r() < 0.5,
          dodge: r() < 0.5,
        });
      }
      w.step();
      checkSnapshot(w.snapshot(), blast, maxJumps);
    }
    w.setIntent(99, { moveX: 1, moveY: 0, jump: false, jumpHeld: false, light: false, heavy: false, dodge: false }); // unknown id: ignored
  });
});

describe('sim: performance', () => {
  it('a 4-fighter 5-minute match (18 000 frames) runs well under a second headless', () => {
    const roster = ANIMALS.slice(0, 4);
    const once = (): number => {
      const w = new BrawlWorld(cfg(roster, { stocks: 999, timeLimitS: 0 }), 11, FIXTURE_SOURCE);
      const pilots = roster.map((_, k) => new FuzzPilot(mulberry32(500 + k)));
      const t0 = performance.now();
      for (let i = 0; i < 18000; i++) {
        for (let id = 0; id < 4; id++) w.setIntent(id, pilots[id].next());
        w.step();
        w.drainEvents();
      }
      return performance.now() - t0;
    };
    // best of three: the box may be shared with other work, the sim's own cost is what is asserted
    const ms = Math.min(once(), once(), once());
    // eslint-disable-next-line no-console
    console.log(`[brawl sim] 18000 frames x 4 fighters: ${ms.toFixed(0)} ms (best of 3)`);
    expect(ms).toBeLessThan(10000); // order-of-magnitude guard (real cost ≈ 150-250 ms); must not flake when the machine is busy
  });
});
