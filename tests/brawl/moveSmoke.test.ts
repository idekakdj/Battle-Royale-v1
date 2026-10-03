import { describe, expect, it } from 'vitest';
import type { AnimalId } from '../../src/core/types';
import type { BrawlIntent, MoveId } from '../../src/brawl/types';
import { MOVE_IDS, idleIntent } from '../../src/brawl/types';
import { BrawlWorld } from '../../src/brawl/sim/BrawlWorld';
import { MOVESETS, bodyReach, getMoveBody } from '../../src/brawl/data';

/**
 * Data x simulation smoke tests: the shipped move data actually works in the real `BrawlWorld`
 * (every ground move can connect, light strings are real combos, effects do what they claim, the
 * best KO move kills a mid-weight target in the plan's band). Lenient on purpose — the exact balance
 * is the balance script's job; these catch data that the sim cannot execute.
 */

const ANIMALS: AnimalId[] = ['lion', 'gorilla', 'crocodile', 'hippo', 'rhino', 'eagle', 'panther', 'python', 'giraffe', 'mole'];

function world(att: AnimalId, vic: AnimalId): BrawlWorld {
  const w = new BrawlWorld({ stage: 'brokenColosseum', roster: [{ animal: att, isPlayer: false }, { animal: vic, isPlayer: false }], difficulty: 1, stocks: 3, timeLimitS: 0 }, 7);
  w.skipCountdown();
  return w;
}

/** Attacker at (x0 - spacing), victim at x0, both on the floor, facing each other. */
function setup(att: AnimalId, vic: AnimalId, spacing: number, x0 = 0): BrawlWorld {
  const w = world(att, vic);
  w.debugPlace(0, x0 - spacing, 0);
  w.debugPlace(1, x0, 0);
  for (let i = 0; i < 3; i++) w.step();
  w.debugSetFacing(0, 1);
  w.debugSetFacing(1, -1);
  return w;
}

function pressFor(move: MoveId): BrawlIntent {
  const i = idleIntent();
  if (move.endsWith('S')) i.moveX = 1;
  if (move.endsWith('D')) i.moveY = -1;
  if (move.endsWith('U')) i.moveY = 1;
  if (move.startsWith('heavy')) i.heavy = true;
  else i.light = true;
  return i;
}

/** Fire `move` once and report whether it hits the victim within `frames`. */
function connects(att: AnimalId, vic: AnimalId, move: MoveId, spacing: number, frames = 70): boolean {
  const w = setup(att, vic, spacing);
  w.setIntent(0, pressFor(move));
  w.step();
  w.setIntent(0, idleIntent());
  for (let f = 0; f < frames; f++) {
    w.step();
    for (const e of w.drainEvents()) if (e.type === 'hit' && e.attackerId === 0) return true;
  }
  return false;
}

function anySpacing(att: AnimalId, vic: AnimalId, move: MoveId): number | null {
  for (let s = 0.2; s <= 5.0; s += 0.2) if (connects(att, vic, move, +s.toFixed(1))) return +s.toFixed(1);
  return null;
}

describe('move data in the real simulation', () => {
  it('every ground move connects with a standing mid-size target at some spacing', () => {
    for (const a of ANIMALS) {
      for (const id of MOVE_IDS) {
        expect(anySpacing(a, 'lion', id), `${a}.${id} never connects with a lion`).not.toBeNull();
      }
    }
  });

  it('every aerial form runs to completion without errors and returns control', () => {
    for (const a of ANIMALS) {
      for (const id of MOVE_IDS) {
        const w = world(a, 'lion');
        w.debugPlace(0, -3, 9);
        w.debugPlace(1, 3, 0);
        for (let i = 0; i < 3; i++) w.step();
        w.setIntent(0, pressFor(id));
        w.step();
        w.setIntent(0, idleIntent());
        let moveStarts = 0;
        for (let f = 0; f < 120; f++) {
          w.step();
          for (const e of w.drainEvents()) if (e.type === 'moveStart' && e.fighterId === 0) moveStarts++;
        }
        const s = w.snapshot().fighters[0];
        expect(Number.isFinite(s.pos.x) && Number.isFinite(s.pos.y), `${a}.${id} air`).toBe(true);
        expect(s.action, `${a}.${id} air form finished`).not.toBe('attack');
        expect(moveStarts, `${a}.${id} air form started`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('light-neutral strings are true combos from 0 % (3 hits: lion/eagle/panther/mole, 2 hits: the rest)', () => {
    for (const a of ANIMALS) {
      const m = MOVESETS[a].moves.lightN;
      const expected = 1 + (m.chain?.length ?? 0);
      const spacing = Math.max(0.6, 0.75 * bodyReach(m.ground));
      for (const vic of ['lion', 'hippo'] as const) {
        const w = setup(a, vic, spacing);
        let hits = 0;
        for (let f = 0; f < 40; f++) {
          const i = idleIntent();
          if (f % 3 === 0) i.light = true;
          w.setIntent(0, i);
          w.step();
          for (const e of w.drainEvents()) if (e.type === 'hit' && e.attackerId === 0) hits++;
          if (hits >= expected) break;
        }
        expect(hits, `${a} lightN string vs ${vic}`).toBeGreaterThanOrEqual(expected);
      }
    }
  });

  it('the best KO move kills a weight-100 target near the ledge (steering back toward the stage like a level-4 bot) at 60-150 % (plan: ~85-135 %)', () => {
    const ko = (att: AnimalId, move: MoveId, spacing: number, pct: number): boolean => {
      const w = setup(att, 'lion', spacing, 10);
      w.debugSetPercent(1, pct);
      w.setIntent(0, pressFor(move));
      w.step();
      w.setIntent(0, idleIntent());
      for (let f = 0; f < 200; f++) {
        w.step();
        // once airborne the victim holds toward the stage centre (DI + air steering), as a level-4 bot does
        w.setIntent(1, w.snapshot().fighters[1].grounded ? idleIntent() : { ...idleIntent(), moveX: -1 });
        for (const e of w.drainEvents()) if (e.type === 'ko' && e.fighterId === 1) return e.side !== 'bottom' && e.pos.y > -8; // a real launch, not a slow fall past the edge
      }
      return false;
    };
    for (const a of ANIMALS) {
      let best = Infinity;
      for (const move of ['heavyN', 'heavyS'] as const) {
        for (let s = 0.6; s <= 4.2; s += 0.4) {
          if (!connects(a, 'lion', move, +s.toFixed(1))) continue;
          for (let pct = 50; pct <= 200 && pct < best; pct += 5) {
            if (ko(a, move, +s.toFixed(1), pct)) {
              best = Math.min(best, pct);
              break;
            }
          }
        }
      }
      expect(best, `${a} best KO percent in the sim`).toBeGreaterThanOrEqual(60);
      expect(best, `${a} best KO percent in the sim`).toBeLessThanOrEqual(150);
    }
  });

  it('effects behave: pull drags victims in, stun and flinch cap hitstun, bury holds grounded victims', () => {
    // crocodile Death Roll: a victim 1.4 m away ends up closer to the crocodile
    {
      const w = setup('crocodile', 'lion', 1.4);
      w.setIntent(0, pressFor('heavyN'));
      w.step();
      w.setIntent(0, idleIntent());
      let minGap = 99;
      for (let f = 0; f < 60; f++) {
        w.step();
        const [a, v] = w.snapshot().fighters;
        if (v.action === 'hitstun' || v.action === 'tumble') minGap = Math.min(minGap, Math.abs(v.pos.x - a.pos.x));
      }
      expect(minGap, 'crocodile pull').toBeLessThan(1.3);
    }
    // lion Roar Wave: flinch = no tumble
    {
      const w = setup('lion', 'lion', 1.2);
      w.setIntent(0, pressFor('heavyN'));
      w.step();
      w.setIntent(0, idleIntent());
      let tumbled = false;
      let hit = false;
      for (let f = 0; f < 70; f++) {
        w.step();
        if (w.snapshot().fighters[1].action === 'tumble') tumbled = true;
        for (const e of w.drainEvents()) if (e.type === 'hit') hit = true;
      }
      expect(hit, 'roar hits').toBe(true);
      expect(tumbled, 'flinch never tumbles').toBe(false);
    }
    // mole Burrow Strike on a grounded lion at 0 %: knockdown (buried), not launched
    {
      const w = setup('mole', 'lion', 0.9);
      w.setIntent(0, pressFor('heavyD'));
      w.step();
      w.setIntent(0, idleIntent());
      let buried = false;
      for (let f = 0; f < 60; f++) {
        w.step();
        if (w.snapshot().fighters[1].action === 'knockdown') buried = true;
      }
      expect(buried, 'mole bury').toBe(true);
    }
    // python Constrict ends with a stun (long hitstun, no tumble)
    {
      const w = setup('python', 'lion', 1.0);
      w.setIntent(0, pressFor('heavyN'));
      w.step();
      w.setIntent(0, idleIntent());
      let maxStun = 0;
      let tumbled = false;
      for (let f = 0; f < 80; f++) {
        w.step();
        const v = w.snapshot().fighters[1];
        maxStun = Math.max(maxStun, v.hitstun);
        if (v.action === 'tumble') tumbled = true;
      }
      expect(maxStun, 'python stun').toBeGreaterThanOrEqual(15);
      expect(tumbled).toBe(false);
    }
  });

  it('armored heavies absorb a hit during their armor window; the panther is untouchable while dashing', () => {
    // gorilla Silverback Swing (armor 6..22) vs a lion light attack landing at move frame ~12: no hitstun, damage scaled
    {
      const w = setup('gorilla', 'lion', 1.5);
      w.setIntent(0, pressFor('heavyS'));
      w.step();
      w.setIntent(0, idleIntent());
      for (let i = 0; i < 9; i++) w.step();
      w.drainEvents();
      w.setIntent(1, { ...idleIntent(), light: true });
      w.step();
      w.setIntent(1, idleIntent());
      let gorillaStunned = false;
      for (let f = 0; f < 14; f++) {
        w.step();
        if (w.snapshot().fighters[0].action === 'hitstun') gorillaStunned = true;
      }
      expect(gorillaStunned, 'gorilla armor').toBe(false);
    }
    // panther Shadow Dash: invulnerable frames 4..19, a lion attack aimed at it during the dash does nothing
    {
      const w = setup('panther', 'lion', 1.2);
      w.setIntent(0, pressFor('heavyS'));
      w.step();
      w.setIntent(0, idleIntent());
      for (let i = 0; i < 6; i++) w.step();
      const before = w.snapshot().fighters[0].percent;
      w.setIntent(1, { ...idleIntent(), heavy: true });
      w.step();
      w.setIntent(1, idleIntent());
      for (let f = 0; f < 8; f++) w.step();
      expect(w.snapshot().fighters[0].percent, 'panther invulnerable').toBe(before);
    }
  });

  it('recovery moves actually gain height in the sim (and the eagle gains the most)', () => {
    const rise = (a: AnimalId): number => {
      const w = world(a, 'lion');
      w.debugPlace(0, -3, 12);
      w.debugPlace(1, 8, 0);
      for (let i = 0; i < 2; i++) w.step();
      const y0 = w.snapshot().fighters[0].pos.y;
      w.setIntent(0, { ...idleIntent(), moveY: 1, heavy: true });
      w.step();
      w.setIntent(0, idleIntent());
      let peak = y0;
      for (let f = 0; f < 90; f++) {
        w.step();
        peak = Math.max(peak, w.snapshot().fighters[0].pos.y);
      }
      return peak - y0;
    };
    const r = Object.fromEntries(ANIMALS.map((a) => [a, rise(a)])) as Record<AnimalId, number>;
    for (const a of ANIMALS) expect(r[a], `${a} recovery rise`).toBeGreaterThan(1.0);
    expect(r.eagle).toBeGreaterThan(Math.max(r.lion, r.panther, r.giraffe, r.mole, r.python, r.gorilla, r.rhino, r.crocodile, r.hippo));
    expect(r.hippo).toBeLessThan(Math.min(r.lion, r.panther, r.giraffe, r.mole, r.python, r.gorilla, r.rhino, r.crocodile));
    expect(getMoveBody('eagle', 'heavyU', true).motion?.length).toBeGreaterThan(0);
  });
});
