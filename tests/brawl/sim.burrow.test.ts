import { describe, expect, it } from 'vitest';
import type { BrawlIntent, MoveBody, MoveId, MovesetDef, StageId } from '../../src/brawl/types';
import { IDLE_INTENT, idleIntent } from '../../src/brawl/types';
import type { AnimalId } from '../../src/core/types';
import { BrawlWorld } from '../../src/brawl/sim/BrawlWorld';
import type { BrawlDataSource } from '../../src/brawl/sim/dataSource';
import { MOVESETS, getMoveBody } from '../../src/brawl/data';
import { BrawlBot } from '../../src/brawl/ai';
import { mulberry32 } from '../../src/core/math';
import { FIXTURE_SOURCE, cfg, circle, fixtureMoveset, mkBody, rect } from './fixtures';

/**
 * v1.6 BURROW (`MoveBody.burrow`, `MoveMotion.stopAtEdge`, `BrawlFighterState.underground`): the mole's ground Burrow Strike.
 * Real data / real stages for the travel + edge tests; a tiny fixture source for the "hits bypass it" tests (so the attacker's
 * hitbox timing is exact); the save / load round trip proves the new behaviour needs no extra state.
 */

const BURROW = getMoveBody('mole', 'heavyD', false);
const HEAVY: BrawlIntent = { ...IDLE_INTENT, heavy: true, moveY: -1 };

function world(stage: StageId, animals: AnimalId[], seed = 11): BrawlWorld {
  const w = new BrawlWorld({ stage, roster: animals.map((animal) => ({ animal, isPlayer: false })), difficulty: 1, stocks: 3, timeLimitS: 0 }, seed);
  w.skipCountdown();
  return w;
}

/** Mole alone-ish on `stage`, standing at (x, y) facing `facing`; fires Burrow Strike on the next step. */
function burrowFrom(stage: StageId, x: number, y: number, facing: 1 | -1, foe: { x: number; y: number } = { x: -25, y: 0 }) {
  const w = world(stage, ['mole', 'lion']);
  w.debugPlace(0, x, y);
  w.debugPlace(1, foe.x, foe.y); // far away (falls out of play harmlessly if it is off the stage)
  w.debugSetFacing(0, facing);
  for (let i = 0; i < 2; i++) w.step();
  w.debugSetFacing(0, facing);
  w.setIntent(0, { ...HEAVY, moveY: -1, moveX: 0 });
  w.step();
  w.setIntent(0, idleIntent());
  return w;
}

describe('Burrow Strike data', () => {
  it('is the mole ground heavyD: archetype burrow, underground + invulnerable f6-24, tunnelling 3.3 m with stopAtEdge, then an upward eruption', () => {
    const b = BURROW;
    expect(b.name).toBe('Burrow Strike');
    expect(b.archetype).toBe('burrow');
    expect(String(b.anim?.look)).toMatch(/under the floor/i);
    expect(b.burrow).toEqual({ from: 6, to: 24 });
    expect(b.invuln).toEqual({ from: 6, to: 24 });
    expect(b.startup).toBe(24);
    expect(b.startup + b.active + b.recovery).toBeLessThanOrEqual(62);
    expect(b.motion).toHaveLength(1);
    expect(b.motion![0]).toMatchObject({ from: 6, to: 24, vx: 11, set: true, stopAtEdge: true });
    expect(((b.motion![0].vx ?? 0) * (b.motion![0].to - b.motion![0].from)) / 60).toBeCloseTo(3.3, 6);
    expect(b.hitboxes).toHaveLength(1);
    const h = b.hitboxes[0];
    expect(h.from).toBe(b.burrow!.to); // erupts the frame the tunnel ends
    expect(h.to - h.from).toBe(b.active);
    expect(h.angle).toBeGreaterThanOrEqual(80);
    expect(h.angle).toBeLessThanOrEqual(100); // straight up
    expect(h.effect ?? 'none').not.toBe('bury');
  });

  it('the air form is the plain drill-down: no burrow window, no invulnerability, no tunnelling motion', () => {
    const a = getMoveBody('mole', 'heavyD', true);
    expect(a.burrow).toBeUndefined();
    expect(a.invuln).toBeUndefined();
    expect(a.motion).toBeUndefined();
    expect(a.name).toBe('Drill Down');
    expect(a.startup).toBeLessThan(BURROW.startup);
  });

  it('nobody else has a burrow window or stopAtEdge', () => {
    for (const a of Object.keys(MOVESETS) as AnimalId[]) {
      for (const id of Object.keys(MOVESETS[a].moves) as MoveId[]) {
        for (const air of [false, true]) {
          const b = getMoveBody(a, id, air);
          const label = `${a}.${id}${air ? '(air)' : ''}`;
          if (a === 'mole' && id === 'heavyD' && !air) continue;
          expect(b.burrow, label).toBeUndefined();
          expect((b.motion ?? []).some((m) => m.stopAtEdge), label).toBe(false);
        }
      }
    }
  });
});

describe('Burrow Strike in the simulation', () => {
  it('underground is true exactly while move frames 6..23 run (ground form), false before / after and in the air form', () => {
    const w = burrowFrom('brokenColosseum', -6, 0, 1);
    const seen: Array<[number, boolean]> = [];
    for (let i = 0; i < 52; i++) {
      const s = w.snapshot().fighters[0];
      if (s.action === 'attack') seen.push([s.moveFrame, s.underground === true]);
      w.step();
    }
    expect(seen.length).toBeGreaterThan(40);
    for (const [mf, ug] of seen) expect(ug, `move frame ${mf}`).toBe(mf >= 6 && mf < 24);
    expect(w.snapshot().fighters[0].underground).toBe(false);
    // the air form (mole in the air) is never underground and can be hit
    const a = world('brokenColosseum', ['mole', 'lion']);
    a.debugPlace(0, -3, 8);
    a.debugPlace(1, 9, 0);
    a.step();
    a.setIntent(0, HEAVY);
    a.step();
    a.setIntent(0, idleIntent());
    for (let i = 0; i < 30; i++) {
      a.step();
      const s = a.snapshot().fighters[0];
      expect(s.underground, `air frame ${i}`).toBe(false);
    }
  });

  it('tunnels 3.3 m over the 18 underground frames and surfaces standing still (no slide)', () => {
    const w = burrowFrom('brokenColosseum', -6, 0, 1);
    const x0 = w.snapshot().fighters[0].pos.x;
    let xAtSurface = NaN;
    for (let i = 0; i < 60; i++) {
      const s = w.snapshot().fighters[0];
      if (s.action === 'attack' && s.moveFrame === 24) xAtSurface = s.pos.x;
      if (s.action === 'attack' && s.moveFrame === 24) expect(s.vel.x).toBe(0);
      w.step();
    }
    expect(xAtSurface - x0).toBeGreaterThan(3.15);
    expect(xAtSurface - x0).toBeLessThan(3.45);
    expect(w.snapshot().fighters[0].pos.x).toBeCloseTo(xAtSurface, 6); // never slid after surfacing
    expect(w.snapshot().fighters[0].grounded).toBe(true);
    // facing left mirrors
    const l = burrowFrom('brokenColosseum', 6, 0, -1);
    for (let i = 0; i < 60; i++) l.step();
    expect(l.snapshot().fighters[0].pos.x).toBeLessThan(6 - 3.15);
  });

  it('stopAtEdge: the mole stops at the platform end and surfaces there, never carried off a ledge (both ends, both stages)', () => {
    const cases: Array<[StageId, number, 1 | -1, number]> = [
      ['brokenColosseum', 10.0, 1, 11], // 1 m from the right end of the 22 m main platform
      ['brokenColosseum', -10.4, -1, -11],
      ['brokenColosseum', 11, 1, 11], // standing exactly on the edge
      ['skyAqueduct', 12.5, 1, 13],
      ['skyAqueduct', 3.2, -1, 3],
    ];
    for (const [stage, x, facing, edge] of cases) {
      const w = burrowFrom(stage, x, 0, facing);
      for (let i = 0; i < 70; i++) {
        const s = w.snapshot().fighters[0];
        expect(s.grounded, `${stage} x${x}: grounded at frame ${i}`).toBe(true);
        expect(facing === 1 ? s.pos.x <= edge + 1e-9 : s.pos.x >= edge - 1e-9, `${stage} x${x}: past the edge at frame ${i} (${s.pos.x})`).toBe(true);
        w.step();
      }
      const end = w.snapshot().fighters[0];
      expect(end.action, `${stage} x${x}`).not.toBe('fall');
      expect(end.pos.x, `${stage} x${x} ends at the edge`).toBeCloseTo(edge, 6);
    }
  });

  it('stopAtEdge also holds on a MOVING platform (the centre of the feet stays inside its current span every frame)', () => {
    for (const facing of [1, -1] as const) {
      // Sky Aqueduct "drifter": x -2.5..2.5 (home) sliding +-3.2 m, y 2.6. Stand near the end the mole will tunnel toward.
      const w = world('skyAqueduct', ['mole', 'lion']);
      w.debugPlace(1, -25, 0);
      for (let i = 0; i < 40; i++) w.step();
      const p0 = w.snapshot().platforms.find((q) => q.id === 'drifter')!;
      w.debugPlace(0, facing === 1 ? p0.x1 - 0.8 : p0.x0 + 0.8, 2.6);
      for (let i = 0; i < 2; i++) w.step();
      expect(w.snapshot().fighters[0].platformId).toBe('drifter');
      w.debugSetFacing(0, facing);
      w.setIntent(0, HEAVY);
      w.step();
      w.setIntent(0, idleIntent());
      for (let i = 0; i < 70; i++) {
        const s = w.snapshot();
        const p = s.platforms.find((q) => q.id === 'drifter')!;
        const f = s.fighters[0];
        expect(f.grounded, `facing ${facing} frame ${i}`).toBe(true);
        expect(f.platformId).toBe('drifter');
        expect(f.pos.x, `facing ${facing} frame ${i}`).toBeGreaterThanOrEqual(p.x0 - 1e-9);
        expect(f.pos.x, `facing ${facing} frame ${i}`).toBeLessThanOrEqual(p.x1 + 1e-9);
        w.step();
      }
    }
  });

  it('erupts under a standing target and launches it straight up (once, at the surfacing point)', () => {
    const w = world('brokenColosseum', ['mole', 'lion']);
    w.debugPlace(0, -6, 0);
    w.debugPlace(1, -2.7, 0); // 3.3 m ahead: right where the tunnel ends
    for (let i = 0; i < 2; i++) w.step();
    w.debugSetFacing(0, 1);
    w.debugSetFacing(1, -1);
    w.setIntent(0, HEAVY);
    w.step();
    w.setIntent(0, idleIntent());
    let hits = 0;
    let launchFrame = -1;
    for (let i = 0; i < 60; i++) {
      w.step();
      for (const e of w.drainEvents()) {
        if (e.type === 'hit' && e.attackerId === 0) {
          hits++;
          expect(e.angle).toBeGreaterThan(80);
          expect(e.angle).toBeLessThan(100);
          launchFrame = w.snapshot().fighters[0].moveFrame;
        }
      }
    }
    expect(hits).toBe(1);
    expect(launchFrame).toBeGreaterThanOrEqual(24);
    expect(launchFrame).toBeLessThan(28);
    expect(w.snapshot().fighters[1].percent).toBeGreaterThanOrEqual(BURROW.hitboxes[0].damage - 1e-9);
  });

  it('is saved / loaded / checksummed exactly (rollback): mid-burrow state round-trips', () => {
    const w = burrowFrom('brokenColosseum', 9.5, 0, 1);
    for (let i = 0; i < 12; i++) w.step(); // inside the underground window
    const s = w.snapshot().fighters[0];
    expect(s.underground).toBe(true);
    const saved = w.saveState();
    const sum = w.checksum();
    const run = (): string => {
      const out: string[] = [];
      for (let i = 0; i < 45; i++) {
        w.step();
        const f = w.snapshot().fighters[0];
        out.push(`${f.moveFrame}:${f.underground}:${f.pos.x.toFixed(9)}:${w.checksum()}`);
      }
      return out.join('|');
    };
    const first = run();
    w.loadState(saved);
    expect(w.checksum()).toBe(sum);
    expect(w.snapshot().fighters[0].underground).toBe(true);
    expect(run()).toBe(first);
  });
});

describe('Burrow Strike: hits bypass the underground fighter (fixture hitboxes with exact timing)', () => {
  /** Mole-like fixture with a burrow heavyD; the lion fixture gets a huge hitbox on lightN that is active on move frames [from, to). */
  function source(lightFrom: number, lightTo: number): BrawlDataSource {
    const moles = new Map<AnimalId, MovesetDef>();
    const patch = (animal: AnimalId): MovesetDef => {
      let m = moles.get(animal);
      if (m) return m;
      const base = fixtureMoveset(animal);
      const moves = { ...base.moves };
      if (animal === 'mole') {
        const burrowBody: MoveBody = mkBody('burrow', [24, 4, 20], [circle(0.5, 0.7, 0.95, 24, 28, 9, 11, 16, 88)], {
          archetype: 'burrow',
          burrow: { from: 6, to: 24 },
          invuln: { from: 6, to: 24 },
          motion: [{ from: 6, to: 24, vx: 11, set: true, stopAtEdge: true }],
        });
        moves.heavyD = { id: 'heavyD', ground: burrowBody, air: null };
      }
      if (animal === 'lion') {
        // a wall of claws around the lion, active exactly on [lightFrom, lightTo)
        const wall = mkBody('wall', [lightFrom, lightTo - lightFrom, 6], [rect(0, 1, 16, 3, lightFrom, lightTo, 5, 4, 3, 40)]);
        moves.lightN = { id: 'lightN', ground: wall, air: null };
      }
      m = { ...base, moves };
      moles.set(animal, m);
      return m;
    };
    return {
      getMoveset: patch,
      getMoveBody: (a, id, air, chain = 0) => {
        const data = patch(a).moves[id];
        if (chain > 0) return data.chain?.[chain - 1] ?? data.ground;
        if (air && data.air) return { ...data.ground, ...data.air };
        return data.ground;
      },
      getStage: FIXTURE_SOURCE.getStage,
    };
  }

  function duel(src: BrawlDataSource, moleBurrows: boolean): { percent: number; hits: number; hitlagSeen: boolean; moleHitlag: boolean } {
    const w = new BrawlWorld(cfg(['mole', 'lion']), 4, src);
    w.skipCountdown();
    w.debugPlace(0, -2.0, 0);
    w.debugPlace(1, 0, 0);
    for (let i = 0; i < 2; i++) w.step();
    w.debugSetFacing(0, 1);
    w.debugSetFacing(1, -1);
    // both start their move on the same step, so frame n of the mole = frame n of the lion's wall
    w.setIntent(0, moleBurrows ? HEAVY : idleIntent());
    w.setIntent(1, { ...idleIntent(), light: true });
    w.step();
    w.setIntent(0, idleIntent());
    w.setIntent(1, idleIntent());
    let hits = 0;
    let hitlagSeen = false;
    let moleHitlag = false;
    for (let i = 0; i < 45; i++) {
      w.step();
      const s = w.snapshot();
      if (s.fighters[1].hitlag > 0) hitlagSeen = true;
      if (s.fighters[0].hitlag > 0) moleHitlag = true;
      for (const e of w.drainEvents()) if (e.type === 'hit' && e.attackerId === 1) hits++;
    }
    return { percent: w.snapshot().fighters[0].percent, hits, hitlagSeen, moleHitlag };
  }

  it('a hitbox active while the mole is underground (frames 8-20) does not hit: no damage, no hitlag, no hit event', () => {
    const r = duel(source(8, 20), true);
    expect(r.hits).toBe(0);
    expect(r.percent).toBe(0);
    expect(r.hitlagSeen).toBe(false);
    expect(r.moleHitlag).toBe(false);
  });

  it('control: the same hitbox DOES hit a mole that is not burrowing', () => {
    const r = duel(source(8, 20), false);
    expect(r.hits).toBeGreaterThan(0);
    expect(r.percent).toBeGreaterThan(0);
  });

  it('still vulnerable while digging in (frames 0-5) and while surfacing (frame 24 on)', () => {
    const early = duel(source(2, 5), true);
    expect(early.hits).toBe(1);
    const late = duel(source(24, 30), true);
    expect(late.hits).toBeGreaterThanOrEqual(1);
  });
});

describe('Burrow Strike: random-input fuzz', () => {
  it('four fighters (three moles) mashing random inputs for 2 x 6000 frames: a ground burrow never leaves the platform, underground implies the window, save / load replays exactly', () => {
    for (const stage of ['brokenColosseum', 'skyAqueduct'] as StageId[]) {
      const rnd = mulberry32(2026 + (stage === 'skyAqueduct' ? 1 : 0));
      const FRAMES = 6000;
      // the whole input script up front, so a rewound world can be fed the very same inputs again
      const script: BrawlIntent[][] = [];
      for (let f = 0; f < FRAMES; f++) {
        const row: BrawlIntent[] = [];
        for (let i = 0; i < 4; i++) {
          const heavy = rnd() < 0.12;
          row.push({
            moveX: rnd() < 0.3 ? 0 : rnd() * 2 - 1,
            moveY: rnd() < 0.35 ? -1 : rnd() < 0.1 ? 1 : 0, // plenty of Down: heavy + Down is the burrow
            jump: rnd() < 0.03,
            jumpHeld: rnd() < 0.5,
            light: !heavy && rnd() < 0.06,
            heavy,
            dodge: rnd() < 0.02,
          });
        }
        script.push(row);
      }
      const w = world(stage, ['mole', 'mole', 'lion', 'mole'], 31);
      const feed = (f: number): void => {
        for (let i = 0; i < 4; i++) w.setIntent(i, script[f][i]);
        w.step();
        w.drainEvents();
      };
      let bursts = 0;
      let saved: ReturnType<BrawlWorld['saveState']> | null = null;
      const SAVE_AT = 2500;
      const SPAN = 400;
      const first: number[] = [];
      for (let f = 0; f < FRAMES; f++) {
        if (f === SAVE_AT) saved = w.saveState();
        feed(f);
        if (f >= SAVE_AT && f < SAVE_AT + SPAN) first.push(w.checksum());
        for (const s of w.snapshot().fighters) {
          if (!s.alive) continue;
          expect(Number.isFinite(s.pos.x) && Number.isFinite(s.pos.y), `${stage} frame ${f}`).toBe(true);
          const inBurrow = s.action === 'attack' && s.moveId === 'heavyD' && !s.moveAir && s.animal === 'mole';
          if (inBurrow) {
            if (s.moveFrame === 1) bursts++;
            expect(s.grounded, `${stage} frame ${f}: fighter ${s.id} carried off the platform`).toBe(true);
          }
          if (s.underground) expect(inBurrow && s.moveFrame >= 6 && s.moveFrame < 24, `${stage} frame ${f}: underground outside the window`).toBe(true);
        }
      }
      expect(bursts, `${stage}: the fuzz never burrowed`).toBeGreaterThan(20);
      // rewind to the save and replay the same inputs: identical checksums frame by frame
      const w2frames: number[] = [];
      w.loadState(saved!);
      for (let f = SAVE_AT; f < SAVE_AT + SPAN; f++) {
        feed(f);
        w2frames.push(w.checksum());
      }
      expect(w2frames).toEqual(first);
    }
  });
});

describe('Burrow Strike and the bots', () => {
  it('mole bots (all levels) never leave the platform while a ground Burrow Strike runs, and use it at all', () => {
    let uses = 0;
    for (const stage of ['brokenColosseum', 'skyAqueduct'] as StageId[]) {
      for (const level of [2, 3, 4] as const) {
        const roster: AnimalId[] = ['mole', 'mole', 'lion', 'gorilla'];
        const w = new BrawlWorld({ stage, roster: roster.map((animal) => ({ animal, isPlayer: false })), difficulty: level, stocks: 4, timeLimitS: 0 }, 100 + level);
        const bots = roster.map((_, i) => new BrawlBot(i, level, 900 + i));
        let prevMove: boolean[] = roster.map(() => false);
        for (let f = 0; f < 4200 && !w.isOver; f++) {
          const snap = w.snapshot();
          for (let i = 0; i < roster.length; i++) w.setIntent(i, bots[i].update(snap));
          w.step();
          const after = w.snapshot();
          after.fighters.forEach((s, i) => {
            const inBurrow = s.action === 'attack' && s.moveId === 'heavyD' && !s.moveAir && s.animal === 'mole';
            if (inBurrow) {
              expect(s.grounded, `${stage} L${level} fighter ${i} frame ${f}: carried off the platform by Burrow Strike`).toBe(true);
              if (!prevMove[i]) uses++;
            }
            prevMove[i] = inBurrow;
          });
        }
      }
    }
    expect(uses, 'the mole bots never used Burrow Strike').toBeGreaterThan(0);
  });
});
