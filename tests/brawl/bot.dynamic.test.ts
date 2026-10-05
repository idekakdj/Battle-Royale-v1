/**
 * v1.6 bots on the two dynamic maps (Clockwork Heights, Crumbling Amphitheatre): per-frame stage awareness (active platforms, ledge
 * exposure, drifting platforms), recovery onto ledges that exist, the moving core, breakable behaviours, the stall breaker, and the
 * guarantee that the original stages and the low levels keep their exact outputs.
 */
import { describe, it, expect } from 'vitest';
import type { AnimalId } from '../../src/core/types';
import type { BrawlDifficulty, BrawlIntent, BrawlSnapshot, StageId } from '../../src/brawl/types';
import { BrawlWorld } from '../../src/brawl/sim/BrawlWorld';
import { BrawlBot } from '../../src/brawl/ai/BrawlBot';
import { StageInfo, stageFromSnapshot } from '../../src/brawl/ai/stageInfo';
import { STAGES } from '../../src/brawl/data';
import { platformAt } from '../../src/brawl/data/stages';

const IDLE: BrawlIntent = { moveX: 0, moveY: 0, jump: false, jumpHeld: false, light: false, heavy: false, dodge: false };

function world(stage: StageId, animals: AnimalId[], seed: number, stocks = 3, timeS = 120): BrawlWorld {
  const w = new BrawlWorld({ stage, roster: animals.map((animal) => ({ animal, isPlayer: false })), difficulty: 4, stocks, timeLimitS: timeS }, seed);
  w.skipCountdown();
  return w;
}

function infoOf(w: BrawlWorld): StageInfo {
  const s = w.snapshot();
  const info = stageFromSnapshot(s);
  info.sync(s.platforms, s.frame);
  return info;
}

const idx = (info: StageInfo, id: string): number => info.plats.findIndex((p) => p.id === id);
const ledgeOf = (info: StageInfo, id: string, side: -1 | 1) => info.ledges.find((l) => info.plats[l.plat].id === id && l.side === side)!;

describe('stageInfo: dynamic platforms', () => {
  it('knows which platforms exist: final-form platforms are inactive until the final form, broken pieces vanish', () => {
    const w = world('crumblingAmphitheatre', ['lion', 'gorilla'], 3);
    let info = infoOf(w);
    for (const id of ['sunL', 'sunR', 'core', 'halo', 'span']) expect(info.plats[idx(info, id)].active, id).toBe(false);
    for (const id of ['tileL', 'tileC', 'tileR', 'archL', 'archR', 'crown']) expect(info.plats[idx(info, id)].active, id).toBe(true);
    expect(info.plats[idx(info, 'tileC')].hp).toBe(6);
    expect(info.platformBelow(0, 0.1, 1.2, 0.3)).toBe(idx(info, 'tileC'));
    w.debugHitPlatform('tileC', 0, 6);
    w.step();
    info = infoOf(w);
    expect(info.plats[idx(info, 'tileC')].active).toBe(false);
    // nothing to stand on at the centre any more (the crown / arches are above)
    expect(info.platformBelow(0, 0.1, 1.2, 0.3)).toBe(-1);
    expect(info.overSolid(0)).toBe(false);
    // the whole arena breaks: the final form's platforms become the world
    for (const id of ['tileL', 'tileR', 'archL', 'archR', 'crown']) w.debugHitPlatform(id, 0, 6);
    w.step();
    info = infoOf(w);
    for (const id of ['sunL', 'sunR', 'core', 'halo', 'span']) expect(info.plats[idx(info, id)].active, id).toBe(true);
    // v1.7: the soft span (y 3.0) now hangs over the pedestal: from above it catches first, from underneath (y 2.4) the core is the floor
    expect(info.platformBelow(0, 3, 1.2, 0.3)).toBe(idx(info, 'span'));
    expect(info.platformBelow(0, 2.4, 1.2, 0.3)).toBe(idx(info, 'core'));
  });

  it('exposes a ledge only while its corner is not covered (the sim rule), and rebuilds it every frame', () => {
    const w = world('crumblingAmphitheatre', ['lion', 'gorilla'], 5);
    let info = infoOf(w);
    // outer ledges are always open; the inner ones are covered by the tiles
    expect(ledgeOf(info, 'floorL', -1).open).toBe(true);
    expect(ledgeOf(info, 'floorR', 1).open).toBe(true);
    expect(ledgeOf(info, 'floorL', 1).open).toBe(false);
    expect(ledgeOf(info, 'tileC', -1).open).toBe(false);
    expect(ledgeOf(info, 'tileC', 1).open).toBe(false);
    // the final-form core has ledges but does not exist yet
    expect(ledgeOf(info, 'core', -1).open).toBe(false);
    w.debugHitPlatform('tileL', 0, 6);
    w.step();
    info = infoOf(w);
    expect(ledgeOf(info, 'floorL', 1).open).toBe(true);
    expect(ledgeOf(info, 'tileC', -1).open).toBe(true);
    expect(ledgeOf(info, 'tileC', 1).open).toBe(false);
    // a destroyed piece's ledges are gone
    w.debugHitPlatform('tileC', 0, 6);
    w.step();
    info = infoOf(w);
    expect(ledgeOf(info, 'tileC', -1).open).toBe(false);
    expect(info.nearestLedge(0, -1)).not.toBeNull();
    expect(info.plats[info.nearestLedge(0, -1)!.plat].active).toBe(true);
  });

  it('follows the drifting core: current ledge corners, a velocity estimate and an exact look-ahead', () => {
    const w = world('clockworkHeights', ['lion', 'gorilla'], 7);
    for (let i = 0; i < 400; i++) w.step();
    const def = STAGES.clockworkHeights;
    const s0 = w.snapshot();
    const info = stageFromSnapshot(s0);
    info.sync(s0.platforms, s0.frame);
    w.step();
    const s1 = w.snapshot();
    info.sync(s1.platforms, s1.frame);
    const core = idx(info, 'core');
    expect(info.plats[core].x0).toBeCloseTo(s1.platforms[core].x0, 9);
    expect(ledgeOf(info, 'core', -1).x).toBeCloseTo(s1.platforms[core].x0, 9);
    expect(ledgeOf(info, 'core', 1).x).toBeCloseTo(s1.platforms[core].x1, 9);
    const vx = ((s1.platforms[core].x0 - s0.platforms[core].x0) / 1) * 60;
    expect(info.plats[core].vx).toBeCloseTo(vx, 6);
    expect(Math.abs(vx)).toBeGreaterThan(0.01);
    // look-ahead = the shared evaluator = the sim's own number
    const out = { x0: 0, x1: 0, y: 0 };
    info.rectAt(core, 90, out);
    const ref = platformAt(def.platforms[core], s1.frame + 90);
    expect(out.x0).toBeCloseTo(ref.x0, 9);
    for (let i = 0; i < 90; i++) w.step();
    expect(w.snapshot().platforms[core].x0).toBeCloseTo(out.x0, 9);
    // the stage centre follows the core
    expect(info.centerX).toBeCloseTo((s1.platforms[core].x0 + s1.platforms[core].x1) * 0.5, 9);
  });

  it('static stages keep their numbers: nothing is dynamic, ledges never close', () => {
    for (const id of ['brokenColosseum', 'skyAqueduct'] as StageId[]) {
      const w = world(id, ['lion', 'gorilla'], 1);
      for (let i = 0; i < 300; i++) w.step();
      const info = infoOf(w);
      expect(info.dyn).toBe(false);
      expect(info.ledges.every((l) => l.open)).toBe(true);
      expect(info.centerX).toBeCloseTo(0, 9);
    }
  });
});

describe('bots on the dynamic maps: recovery', () => {
  it('after the tiles are gone, a bot below the pit edge comes back to a ledge / floor that exists (>= 80 % of trials, levels 3 and 4)', () => {
    for (const level of [3, 4] as BrawlDifficulty[]) {
      let ok = 0;
      let n = 0;
      for (const animal of ['lion', 'eagle', 'panther', 'python', 'giraffe', 'mole', 'gorilla', 'rhino'] as AnimalId[]) {
        for (const side of [-1, 1]) {
          const w = world('crumblingAmphitheatre', [animal, 'lion'], 40 + n);
          w.debugPlace(1, -side * 11, 0);
          for (const id of ['tileL', 'tileC', 'tileR']) w.debugHitPlatform(id, 1, 6);
          w.step();
          w.debugPlace(0, side * 9.5, -2.5, 0, 0);
          const bot = new BrawlBot(0, level, 77 + n);
          let back = false;
          let snap = w.snapshot();
          for (let f = 0; f < 420 && !back; f++) {
            w.setIntent(0, bot.update(snap));
            w.step();
            snap = w.snapshot();
            const me = snap.fighters[0];
            if (!me.alive) break;
            if (me.action === 'ledgeHang' || (me.grounded && me.platformId !== null)) {
              back = true;
              const plat = snap.platforms.find((p) => p.id === me.platformId);
              // never "standing" on something that is not there
              if (me.grounded) expect(plat === undefined || plat.active !== false).toBe(true);
            }
          }
          n++;
          if (back) ok++;
        }
      }
      expect(ok / n, `level ${level}`).toBeGreaterThanOrEqual(0.8);
    }
  });

  it('a bot never aims at a platform that is not there: recovery targets are active platforms and open ledges only', () => {
    const w = world('crumblingAmphitheatre', ['lion', 'gorilla'], 9);
    // tileL is gone: its ledge is not a target, the floor's inner ledge is
    w.debugHitPlatform('tileL', 0, 6);
    w.step();
    const snap = w.snapshot();
    const info = infoOf(w);
    const open = info.ledges.filter((l) => l.open).map((l) => `${info.plats[l.plat].id}:${l.side}`);
    expect(open).toContain('floorL:1');
    expect(open).not.toContain('tileL:1');
    expect(open).not.toContain('core:-1');
    expect(snap.platforms.find((p) => p.id === 'tileL')!.active).toBe(false);
  });
});

describe('bots on the dynamic maps: moving core and stalls', () => {
  function hashRun(stage: StageId, animals: AnimalId[], level: BrawlDifficulty, seed: number, frames: number): string {
    const w = world(stage, animals, seed);
    const bots = animals.map((_, i) => new BrawlBot(i, level, (seed + i * 7919) >>> 0));
    let snap = w.snapshot();
    let h = 2166136261 >>> 0;
    for (let f = 0; f < frames && !snap.matchOver; f++) {
      for (let i = 0; i < animals.length; i++) {
        const it = bots[i].update(snap);
        h = Math.imul(h ^ ((it.moveX * 100) | 0) ^ ((it.moveY * 100) << 8) ^ (it.jump ? 1 << 20 : 0) ^ (it.light ? 1 << 21 : 0) ^ (it.heavy ? 1 << 22 : 0) ^ (it.dodge ? 1 << 23 : 0), 16777619) >>> 0;
        w.setIntent(i, it);
      }
      w.step();
      w.drainEvents();
      snap = w.snapshot();
    }
    return `${snap.frame}:${h.toString(16)}`;
  }

  it('bot decisions on the dynamic stages are deterministic (same snapshots + seed = same inputs)', () => {
    for (const stage of ['clockworkHeights', 'crumblingAmphitheatre'] as StageId[]) {
      const a = hashRun(stage, ['lion', 'mole'], 4, 11, 1500);
      const b = hashRun(stage, ['lion', 'mole'], 4, 11, 1500);
      expect(a).toBe(b);
    }
  });

  it('Clockwork Heights: level 4 bots do not walk or fall off the drifting core (self-destructs stay a minority of KOs)', () => {
    let kos = 0;
    let sd = 0;
    const pairs: [AnimalId, AnimalId][] = [
      ['lion', 'gorilla'],
      ['rhino', 'mole'],
      ['hippo', 'eagle'],
      ['python', 'giraffe'],
      ['crocodile', 'panther'],
      ['gorilla', 'lion'],
    ];
    for (const [g, [a, b]] of pairs.entries()) {
      const w = world('clockworkHeights', [a, b], 100 + g, 3, 90);
      const bots = [new BrawlBot(0, 4, 100 + g), new BrawlBot(1, 4, 5000 + g)];
      let snap = w.snapshot();
      while (!snap.matchOver && snap.frame < 90 * 60 + 300) {
        for (let i = 0; i < 2; i++) w.setIntent(i, bots[i].update(snap));
        w.step();
        for (const e of w.drainEvents()) {
          if (e.type === 'ko') {
            kos++;
            if (e.killerId < 0) sd++;
          }
        }
        snap = w.snapshot();
      }
    }
    expect(kos).toBeGreaterThan(8);
    expect(sd / kos).toBeLessThan(0.4);
  });

  /** Longest run of frames a grounded bot does nothing (no attack / jump / hit, moves < 0.5 m on its platform). */
  function longestStill(stage: StageId, animals: AnimalId[], level: BrawlDifficulty, seed: number, timeS: number): number {
    const w = world(stage, animals, seed, 3, timeS);
    const bots = animals.map((_, i) => new BrawlBot(i, level, (seed * 31 + i * 7919) >>> 0));
    const t = animals.map(() => ({ ax: 0, ap: '', streak: 0, max: 0 }));
    let snap = w.snapshot();
    while (!snap.matchOver && snap.frame < timeS * 60 + 300) {
      for (let i = 0; i < animals.length; i++) w.setIntent(i, bots[i].update(snap));
      const anyoneElse = (i: number): boolean => snap.fighters.some((f, k) => k !== i && f.alive && f.action !== 'ko' && f.action !== 'respawn');
      for (let i = 0; i < animals.length; i++) {
        const f = snap.fighters[i];
        const tr = t[i];
        const calm = f.alive && f.grounded && f.platformId !== null && (f.action === 'idle' || f.action === 'walk' || f.action === 'run' || f.action === 'crouch') && anyoneElse(i);
        if (!calm) {
          tr.streak = 0;
          tr.ap = '';
          continue;
        }
        const pl = snap.platforms.find((q) => q.id === f.platformId);
        const rel = pl ? f.pos.x - (pl.x0 + pl.x1) * 0.5 : f.pos.x;
        if (tr.ap !== f.platformId || Math.abs(rel - tr.ax) > 0.5) {
          tr.ap = f.platformId as string;
          tr.ax = rel;
          tr.streak = 0;
        }
        tr.streak++;
        if (tr.streak > tr.max) tr.max = tr.streak;
      }
      w.step();
      w.drainEvents();
      snap = w.snapshot();
    }
    return Math.max(...t.map((x) => x.max));
  }

  for (const stage of ['brokenColosseum', 'skyAqueduct', 'clockworkHeights', 'crumblingAmphitheatre'] as StageId[]) {
    it(`${stage}: no bot stands still for 300 frames (levels 3 and 4, seeded matches)`, () => {
      const pairs: [AnimalId, AnimalId][] = [
        ['lion', 'gorilla'],
        ['rhino', 'mole'],
        ['hippo', 'eagle'],
        ['python', 'giraffe'],
        ['crocodile', 'panther'],
      ];
      let worst = 0;
      for (const [g, [a, b]] of pairs.entries()) {
        const lv = (g % 2 === 0 ? 4 : 3) as BrawlDifficulty;
        worst = Math.max(worst, longestStill(stage, [a, b], lv, 300 + g, 100));
      }
      expect(worst).toBeLessThan(300);
    });
  }
});

describe('bots on the Crumbling Amphitheatre: breakables', () => {
  it('never breaks the floor under its own feet: a nearly broken tile is not broken by a level 3/4 bot standing on it', () => {
    for (const level of [3, 4] as BrawlDifficulty[]) {
      for (const animal of ['lion', 'mole', 'gorilla', 'giraffe', 'crocodile', 'hippo'] as AnimalId[]) {
        const w = world('crumblingAmphitheatre', [animal, 'rhino'], 21);
        w.debugHitPlatform('tileC', 1, 5); // one hit left
        w.debugPlace(0, -1.2, 0);
        w.debugPlace(1, 1.0, 0);
        w.drainEvents();
        const bot = new BrawlBot(0, level, 31);
        let snap = w.snapshot();
        let ownBreaks = 0;
        for (let f = 0; f < 600; f++) {
          w.setIntent(0, bot.update(snap));
          w.setIntent(1, IDLE);
          const me = snap.fighters[0];
          w.step();
          for (const e of w.drainEvents()) {
            // breaking a piece the bot is standing on (as seen just before the step) would drop it into the pit
            if (e.type === 'platformBreak' && me.grounded && me.platformId === e.platformId && STAGES.crumblingAmphitheatre.platforms.find((p) => p.id === e.platformId)!.kind === 'solid') ownBreaks++;
          }
          snap = w.snapshot();
        }
        expect(ownBreaks, `${animal} L${level}`).toBe(0);
      }
    }
  });

  it('uses downtime to hit nearby pieces at level 3/4 (an idle opponent far away): counted platform hits by the bot', () => {
    let withHits = 0;
    let n = 0;
    for (const level of [3, 4] as BrawlDifficulty[]) {
      for (const animal of ['lion', 'gorilla', 'crocodile', 'hippo', 'rhino', 'eagle', 'panther', 'python', 'giraffe', 'mole'] as AnimalId[]) {
        const w = world('crumblingAmphitheatre', [animal, 'lion'], 60 + n);
        w.debugPlace(1, 11.5, 0);
        const bot = new BrawlBot(0, level, 200 + n);
        let snap = w.snapshot();
        let hits = 0;
        for (let f = 0; f < 60 * 25; f++) {
          w.setIntent(0, bot.update(snap));
          w.setIntent(1, IDLE);
          w.step();
          for (const e of w.drainEvents()) if (e.type === 'platformHit' && e.attackerId === 0) hits++;
          snap = w.snapshot();
        }
        n++;
        if (hits > 0) withHits++;
      }
    }
    expect(withHits / n).toBeGreaterThanOrEqual(0.7);
  });

  it('level 1 bots do not smash (no appetite), the original stages are untouched by the breakable logic', () => {
    const w = world('crumblingAmphitheatre', ['lion', 'lion'], 8);
    w.debugPlace(1, 11.5, 0);
    const bot = new BrawlBot(0, 1, 5);
    let snap = w.snapshot();
    let smashModes = 0;
    for (let f = 0; f < 600; f++) {
      w.setIntent(0, bot.update(snap));
      w.setIntent(1, IDLE);
      w.step();
      w.drainEvents();
      snap = w.snapshot();
      if (bot.mode.startsWith('smash')) smashModes++;
    }
    expect(smashModes).toBe(0);
  });
});

describe('bots: the original stages and the low levels keep their exact behaviour', () => {
  // intent-stream hashes recorded on the pre-v1.6 bot (same helper as `hashRunBaseline` below): levels 1 and 2 never use the new code paths
  function baseline(stage: StageId, animals: AnimalId[], level: BrawlDifficulty, seed: number): string {
    const w = new BrawlWorld({ stage, roster: animals.map((animal) => ({ animal, isPlayer: false })), difficulty: 4, stocks: 2, timeLimitS: 120 }, seed);
    w.skipCountdown();
    const bots = animals.map((_, i) => new BrawlBot(i, level, (seed * 31 + i * 7919) >>> 0));
    let snap: BrawlSnapshot = w.snapshot();
    let h = 2166136261 >>> 0;
    while (!snap.matchOver && snap.frame < 120 * 60 + 300) {
      for (let i = 0; i < animals.length; i++) {
        const it = bots[i].update(snap);
        h =
          Math.imul(
            h ^ (((it.moveX * 100) | 0) + 1000 + ((it.moveY * 100) | 0) * 7 + (it.jump ? 1 : 0) * 3 + (it.light ? 1 : 0) * 5 + (it.heavy ? 1 : 0) * 11 + (it.dodge ? 1 : 0) * 13 + (it.jumpHeld ? 1 : 0) * 17),
            16777619,
          ) >>> 0;
        w.setIntent(i, it);
      }
      w.step();
      w.drainEvents();
      snap = w.snapshot();
    }
    return `f${snap.frame} w${snap.winnerId} ${h.toString(16)}`;
  }

  it('level 2 on Broken Colosseum / Sky Aqueduct: identical intent streams to the pre-v1.6 bot', () => {
    expect(baseline('brokenColosseum', ['lion', 'rhino'], 2, 900)).toBe('f3562 w1 6135cb23');
    expect(baseline('brokenColosseum', ['gorilla', 'python'], 2, 901)).toBe('f4832 w0 408fe003');
    expect(baseline('skyAqueduct', ['lion', 'rhino'], 2, 900)).toBe('f861 w0 aa57054');
    expect(baseline('skyAqueduct', ['gorilla', 'python'], 2, 901)).toBe('f4287 w0 66f53bbd');
  });

  it('level 1 on the original stages: identical intent streams to the pre-v1.6 bot', () => {
    expect(baseline('brokenColosseum', ['lion', 'rhino'], 1, 900)).toBe('f4487 w0 f6a76d8e');
    expect(baseline('brokenColosseum', ['gorilla', 'python'], 1, 901)).toBe('f3919 w1 3c2746cc');
  });
});

describe('bots on the Crumbling Amphitheatre: stalemates and the final form', () => {
  it('a standoff over unreachable pieces ends: a bot sacrifices a stock, the respawn reaches the crown and the arena flips to its final form', () => {
    let finals = 0;
    let dives = 0;
    const pairs: [AnimalId, AnimalId][] = [
      ['lion', 'gorilla'],
      ['rhino', 'python'],
      ['panther', 'hippo'],
      ['crocodile', 'eagle'],
    ];
    for (const [g, [a, b]] of pairs.entries()) {
      const w = world('crumblingAmphitheatre', [a, b], 80 + g, 3, 300);
      // everything but the crown is gone: floors on both sides, the crown unreachable from either
      for (const id of ['tileL', 'tileC', 'tileR', 'archL', 'archR']) w.debugHitPlatform(id, 0, 6);
      w.step();
      w.debugPlace(0, -10, 0);
      w.debugPlace(1, 10, 0);
      w.drainEvents();
      const bots = [new BrawlBot(0, 4, 90 + g), new BrawlBot(1, 4, 190 + g)];
      let snap = w.snapshot();
      let final = false;
      let kos = 0;
      for (let f = 0; f < 60 * 150 && !final; f++) {
        for (let i = 0; i < 2; i++) w.setIntent(i, bots[i].update(snap));
        w.step();
        for (const e of w.drainEvents()) {
          if (e.type === 'stageFinal') final = true;
          if (e.type === 'ko') kos++;
        }
        snap = w.snapshot();
      }
      if (final) finals++;
      dives += kos;
    }
    expect(finals).toBeGreaterThanOrEqual(3);
    expect(dives).toBeGreaterThanOrEqual(1);
  });

  it('level 3/4 duels reach the final form in most matches, never in the first 25 s (seeded sample)', () => {
    let finals = 0;
    let early = 0;
    let n = 0;
    const pairs: [AnimalId, AnimalId][] = [
      ['lion', 'gorilla'],
      ['rhino', 'mole'],
      ['hippo', 'eagle'],
      ['python', 'giraffe'],
      ['crocodile', 'panther'],
      ['gorilla', 'lion'],
    ];
    for (const [g, [a, b]] of pairs.entries()) {
      const w = world('crumblingAmphitheatre', [a, b], 300 + g, 3, 240);
      const bots = [new BrawlBot(0, (g % 2 === 0 ? 4 : 3) as BrawlDifficulty, 300 + g), new BrawlBot(1, 4, 900 + g)];
      let snap = w.snapshot();
      let at = -1;
      while (!snap.matchOver && snap.frame < 240 * 60 + 300 && at < 0) {
        for (let i = 0; i < 2; i++) w.setIntent(i, bots[i].update(snap));
        w.step();
        for (const e of w.drainEvents()) if (e.type === 'stageFinal') at = snap.time;
        snap = w.snapshot();
      }
      n++;
      if (at >= 0) finals++;
      if (at >= 0 && at < 25) early++;
    }
    expect(finals / n).toBeGreaterThanOrEqual(0.66);
    expect(early).toBe(0);
  });
});

describe('bots on the dynamic maps: legal intents at every level', () => {
  for (const stage of ['clockworkHeights', 'crumblingAmphitheatre'] as StageId[]) {
    for (const level of [1, 2, 3, 4] as BrawlDifficulty[]) {
      it(`${stage}, level ${level}: finite in-range intents through breaks, the final form and respawns (4-fighter FFA)`, () => {
        const animals: AnimalId[] = ['lion', 'mole', 'eagle', 'hippo'];
        const w = world(stage, animals, 17 + level, 3, 90);
        const bots = animals.map((_, i) => new BrawlBot(i, level, 40 + i));
        let snap = w.snapshot();
        let bad = 0;
        for (let f = 0; f < 60 * 40 && !snap.matchOver; f++) {
          if (stage === 'crumblingAmphitheatre' && f === 900) for (const id of ['tileL', 'tileC', 'tileR', 'archL', 'archR', 'crown']) w.debugHitPlatform(id, 0, 6);
          for (let i = 0; i < animals.length; i++) {
            const it = bots[i].update(snap);
            if (![it.moveX, it.moveY].every((v) => Number.isFinite(v) && Math.abs(v) <= 1) || typeof it.jump !== 'boolean' || typeof it.light !== 'boolean' || typeof it.heavy !== 'boolean') bad++;
            w.setIntent(i, it);
          }
          w.step();
          w.drainEvents();
          snap = w.snapshot();
        }
        expect(bad).toBe(0);
        // the stage snapshot never reports a NaN platform
        expect(snap.platforms.every((p) => Number.isFinite(p.x0) && Number.isFinite(p.x1) && Number.isFinite(p.y))).toBe(true);
      });
    }
  }
});
