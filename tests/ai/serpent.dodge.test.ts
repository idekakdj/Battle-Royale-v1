/**
 * v1.9 WP-O2: bots dodge the sea-serpent strike (src/ai/SerpentSense.ts, hooks in BotBrain).
 *
 * - Unit tests pin the knobs (reaction ladder, no-op off the Ocean Dome, strip geometry, the exit heading, `repel`).
 * - The dodge-rate test runs isolated trials on the real Ocean Dome (scripts/serpentTrial.ts: a fighter at a random point of the strip,
 *   real World physics, the bot's own SerpentSense steering) and pins the targets: Apex >= 90 %, Veteran >= 75 %, Fighter >= 50 %,
 *   Cub 25-40 % (asserted with a little slack for the finite sample).
 * - Bot-state tests run a real BotBrain through BotManager on the Ocean Dome: after its reaction time the bot stops swinging, drops
 *   ability starts, leaves the strip and survives; a Cub that never reacts is hit.
 */

import { describe, it, expect } from 'vitest';
import { World } from '../../src/sim/World';
import { EventBus } from '../../src/core/EventBus';
import { BotManager } from '../../src/ai/BotManager';
import { SERPENT_AI, SerpentSense, stripDistance } from '../../src/ai/SerpentSense';
import { BOT_PROFILES } from '../../src/config/botProfiles';
import { ANIMALS, ANIMAL_IDS } from '../../src/config/animals';
import { COLOSSEUM_ARENA, JUNGLE_ARENA, OCEAN_ARENA, arenaGroundHeight } from '../../src/config/arenas';
import { SERPENT } from '../../src/config/serpent';
import { mulberry32 } from '../../src/core/math';
import type { AnimalId, Difficulty, FighterIntent, FighterState, GameEvent, MatchConfig, SerpentState } from '../../src/core/types';
import type { Move2 } from '../../src/ai/Steering';
import { trial } from '../../scripts/serpentTrial';
import { DT } from './helpers';

const IDLE: FighterIntent = { moveX: 0, moveZ: 0, aimYaw: 0, attack: false, block: false, special: false, ultimate: false, jump: false };

function fighterAt(x: number, z: number, animal: AnimalId = 'lion'): FighterState {
  return { pos: { x, y: arenaGroundHeight(OCEAN_ARENA, x, z), z }, animal } as unknown as FighterState;
}

function warn(angleDeg: number, t = 0): SerpentState {
  return { phase: 'warn', angleDeg, t, headR: 30 };
}

describe('SerpentSense: knobs and geometry', () => {
  it('is inactive on the colosseum and the jungle (no serpent hazard): every call is a no-op', () => {
    for (const arena of [COLOSSEUM_ARENA, JUNGLE_ARENA]) {
      const s = new SerpentSense(arena, 'lion', 4);
      expect(s.active).toBe(false);
      const out: Move2 = { x: 0.2, z: 0.3 };
      expect(s.update(1, fighterAt(10, 0), warn(0), 150, false, mulberry32(1), out)).toBe(false);
      s.repel(out, 1, 10, 0);
      expect(out).toEqual({ x: 0.2, z: 0.3 });
    }
  });

  it('reaction ladder: the mean reaction grows from Apex to Cub and sits at the profile reaction time plus a decision lag', () => {
    const means: number[] = [];
    for (const lvl of [4, 3, 2, 1] as Difficulty[]) {
      const rng = mulberry32(100 + lvl);
      let sum = 0;
      let n = 0;
      for (let i = 0; i < 600; i++) {
        const s = new SerpentSense(OCEAN_ARENA, 'lion', lvl);
        s.update(10, fighterAt(10, 0), warn(0), BOT_PROFILES[lvl].reactionMs, false, rng, { x: 0, z: 0 });
        const d = s.reactAfterS;
        if (Number.isFinite(d)) {
          sum += d;
          n++;
          expect(d).toBeGreaterThanOrEqual(SERPENT_AI[lvl].minMs / 1000 - 1e-9);
        }
      }
      means.push((1000 * sum) / n);
      const expected = BOT_PROFILES[lvl].reactionMs + SERPENT_AI[lvl].extraMs;
      expect(means[means.length - 1]).toBeGreaterThan(expected * 0.9);
      expect(means[means.length - 1]).toBeLessThan(expected * 1.25 + 40); // the min clamp lifts the mean a little
    }
    expect(means[0]).toBeLessThan(means[1]);
    expect(means[1]).toBeLessThan(means[2]);
    expect(means[2]).toBeLessThan(means[3]);
    // the Apex notice time is faster than the sim's escape budget at any spot; the Cub's is slower than the head
    expect(means[0]).toBeLessThan(260);
    expect(means[3]).toBeGreaterThan(700);
  });

  it('stripDistance: zero on the line, grows sideways, measured to the centre cap behind the middle and the wall end', () => {
    expect(stripDistance(10, 0, 1, 0, 30)).toBeCloseTo(0, 9);
    expect(stripDistance(10, 3, 1, 0, 30)).toBeCloseTo(3, 9);
    expect(stripDistance(-4, 0, 1, 0, 30)).toBeCloseTo(4, 9); // behind the centre: the round cap
    expect(stripDistance(34, 0, 1, 0, 30)).toBeCloseTo(4, 9); // beyond the wall end
  });

  it('after its reaction time a bot standing ON the line steers perpendicular to it (either side); before, it does nothing', () => {
    for (const lvl of [3, 4] as Difficulty[]) {
      const s = new SerpentSense(OCEAN_ARENA, 'lion', lvl);
      const rng = mulberry32(7);
      const out: Move2 = { x: 0, z: 0 };
      const f = fighterAt(24, 0.2);
      // t = 0: just appeared - the delay has not elapsed
      expect(s.update(100, f, warn(0, 0), BOT_PROFILES[lvl].reactionMs, false, rng, out)).toBe(false);
      const after = s.reactAfterS;
      if (!Number.isFinite(after)) continue; // a miss draw: covered by the Cub/miss test
      const r = s.update(100 + after + 0.02, f, warn(0, after + 0.02), BOT_PROFILES[lvl].reactionMs, false, rng, out);
      expect(r).toBe(true);
      expect(s.dodging).toBe(true);
      expect(Math.abs(out.z)).toBeGreaterThan(0.9); // across the line (the line runs along +x)
      expect(Math.abs(out.x)).toBeLessThan(0.45);
    }
  });

  it('a bot already clear of the strip does not dodge', () => {
    const s = new SerpentSense(OCEAN_ARENA, 'lion', 4);
    const rng = mulberry32(3);
    const out: Move2 = { x: 0, z: 0 };
    const f = fighterAt(10, 8); // 8 m off the line
    s.update(100, f, warn(0, 0), 150, false, rng, out);
    expect(s.update(101, f, warn(0, 1), 150, false, rng, out)).toBe(false);
  });

  it('only warn and strike matter: hold / retreat phases are harmless and end the dodge', () => {
    const s = new SerpentSense(OCEAN_ARENA, 'lion', 4);
    const rng = mulberry32(3);
    const out: Move2 = { x: 0, z: 0 };
    const f = fighterAt(10, 0);
    s.update(100, f, warn(0, 0), 150, false, rng, out);
    const hold: SerpentState = { phase: 'hold', angleDeg: 0, t: 0.1, headR: 0 };
    expect(s.update(101.5, f, hold, 150, false, rng, out)).toBe(false);
  });

  it('a fighter more than 3 m above the ground (a soaring eagle) never dodges', () => {
    const s = new SerpentSense(OCEAN_ARENA, 'eagle', 4);
    const rng = mulberry32(3);
    const out: Move2 = { x: 0, z: 0 };
    const f = fighterAt(10, 0, 'eagle');
    f.pos.y += 5;
    s.update(100, f, warn(0, 0), 150, false, rng, out);
    expect(s.update(101, f, warn(0, 1), 150, false, rng, out)).toBe(false);
  });

  it('Veteran / Apex never walk INTO the strip after noticing it (repel); Fighter / Cub do not bother', () => {
    for (const lvl of [1, 2, 3, 4] as Difficulty[]) {
      const s = new SerpentSense(OCEAN_ARENA, 'lion', lvl);
      const rng = mulberry32(9);
      const out: Move2 = { x: 0, z: 0 };
      const f = fighterAt(10, 3.1); // clear (the strip + margin ends at 2.85 m), 3.1 m off the line
      s.update(100, f, warn(0, 0), BOT_PROFILES[lvl].reactionMs, false, rng, out);
      const t = Number.isFinite(s.reactAfterS) ? s.reactAfterS + 0.05 : 0.9;
      s.update(100 + t, f, warn(0, t), BOT_PROFILES[lvl].reactionMs, false, rng, out);
      const move: Move2 = { x: 0, z: -1 }; // straight at the line
      s.repel(move, 100 + t, 10, 3.1);
      if (lvl >= 3 && Number.isFinite(s.reactAfterS)) {
        expect(move.z, `L${lvl}`).toBeGreaterThanOrEqual(-0.3); // the inward component is gone (or the bot halts)
      } else {
        expect(move).toEqual({ x: 0, z: -1 });
      }
    }
  });
});

describe('dodge rates of standing bots (isolated trials on the real Ocean Dome)', () => {
  const N = 12; // per animal and level
  const rates: Record<number, number> = {};
  const animals = ANIMAL_IDS as readonly AnimalId[];
  for (const lvl of [1, 2, 3, 4] as Difficulty[]) {
    it(`L${lvl} ${BOT_PROFILES[lvl].displayName}`, () => {
      let ok = 0;
      let tot = 0;
      for (const a of animals) {
        for (let i = 0; i < N; i++) {
          const r = trial(a, lvl, 70000 + lvl * 1000 + i * 17 + (a.charCodeAt(0) + a.length) * 131);
          tot++;
          if (!r.hit) ok++;
        }
      }
      rates[lvl] = ok / tot;
      if (process.env.SERPENT_REPORT === '1') console.log(`L${lvl} dodge ${(100 * rates[lvl]).toFixed(1)} % (${ok}/${tot})`);
      if (lvl === 4) expect(rates[lvl]).toBeGreaterThanOrEqual(0.88);
      if (lvl === 3) expect(rates[lvl]).toBeGreaterThanOrEqual(0.74);
      if (lvl === 2) {
        expect(rates[lvl]).toBeGreaterThanOrEqual(0.48);
        expect(rates[lvl]).toBeLessThanOrEqual(0.8);
      }
      if (lvl === 1) {
        expect(rates[lvl]).toBeGreaterThanOrEqual(0.22);
        expect(rates[lvl]).toBeLessThanOrEqual(0.45);
      }
    });
  }
  it('the ladder is monotone: Apex > Veteran > Fighter > Cub', () => {
    expect(rates[4]).toBeGreaterThan(rates[3]);
    expect(rates[3]).toBeGreaterThan(rates[2]);
    expect(rates[2]).toBeGreaterThan(rates[1]);
  });
});

/**
 * A real BotBrain (via BotManager) beside an idle dummy, standing ON the strike line: returns what it did around the warning.
 */
function brainScenario(level: Difficulty, seed: number, opts: { armUltAfterS?: number } = {}) {
  const cfg: MatchConfig = {
    roster: [
      { animal: 'lion', isPlayer: false },
      { animal: 'rhino', isPlayer: true },
    ],
    difficulty: level,
    arena: 'ocean',
  };
  const bus = new EventBus();
  const events: GameEvent[] = [];
  bus.onAny((e) => events.push(e));
  const world = new World(cfg, seed, bus, { traps: false });
  const bots = new BotManager(bus, level, seed, world.arena);
  // bot at (10, 0) on the strike line (angle 0, i.e. +x), a rhino dummy 2 m beside it so the bot is swinging when the warning appears
  const bot = world.fighters[0].state;
  const dummy = world.fighters[1].state;
  bot.pos.x = 10;
  bot.pos.z = 0;
  bot.pos.y = arenaGroundHeight(OCEAN_ARENA, 10, 0);
  dummy.pos.x = 10;
  dummy.pos.z = 2;
  dummy.pos.y = bot.pos.y;
  dummy.hp = dummy.maxHp = 1e6;
  const log: { t: number; attack: boolean; special: boolean; ultimate: boolean; block: boolean; lat: number; speed: number }[] = [];
  let warned = -1;
  for (let tick = 0; tick < 800; tick++) {
    if (warned < 0 && world.time > 0.5) {
      world.debugTriggerSerpent(0);
      warned = world.time;
    }
    if (warned >= 0 && opts.armUltAfterS !== undefined && world.time - warned >= opts.armUltAfterS) bot.ultCharge = 100;
    bots.update(world.snapshot(), DT);
    const intent = bots.getIntent(0);
    world.setIntent(0, intent);
    world.setIntent(1, IDLE);
    world.step(DT);
    if (warned >= 0) {
      log.push({
        t: world.time - warned,
        attack: intent.attack,
        special: intent.special,
        ultimate: intent.ultimate,
        block: intent.block,
        lat: Math.abs(bot.pos.z),
        speed: Math.hypot(bot.vel.x, bot.vel.z),
      });
      if (log.length > 300) break;
    }
  }
  const hit = events.some((e) => e.type === 'serpentHit' && e.fighterId === 0);
  return { log, hit, bot, events };
}

describe('BotBrain wiring (real brain, real World)', () => {
  it('an Apex bot standing in the strip while swinging at a dummy stops swinging, leaves the strip and is not hit', () => {
    let escaped = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const r = brainScenario(4, seed, { armUltAfterS: 0.3 });
      const need = SERPENT.headRadius + ANIMALS.lion.radius;
      // from 0.5 s after the warning on (reaction ~0.17 s) it holds no attack / ability / block intent while inside the strip
      // (the ultimate was armed 0.3 s after the warning: a noticed strike cancels the cast it would otherwise make)
      for (const e of r.log) {
        if (e.t > 0.5 && e.t < SERPENT.warnS + SERPENT.strikeS && e.lat < need) {
          expect(e.attack, `seed ${seed} t=${e.t.toFixed(2)}`).toBe(false);
          expect(e.special).toBe(false);
          expect(e.ultimate).toBe(false);
          expect(e.block).toBe(false);
        }
      }
      if (!r.hit) escaped++;
    }
    expect(escaped).toBeGreaterThanOrEqual(4); // Apex dodges ~94 % (a swing in progress slows the first steps)
  });

  it('a Cub that does not react (or reacts late) is caught by the strike; the same strike on an Apex is dodged: both brains differ', () => {
    let cubHits = 0;
    let apexHits = 0;
    for (let seed = 1; seed <= 10; seed++) {
      if (brainScenario(1, seed).hit) cubHits++;
      if (brainScenario(4, seed).hit) apexHits++;
    }
    expect(cubHits).toBeGreaterThanOrEqual(4);
    expect(apexHits).toBeLessThanOrEqual(2);
    expect(cubHits).toBeGreaterThan(apexHits);
  });

  it('the hit costs the Cub 300 true damage (the serpent numbers are untouched by the AI)', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const r = brainScenario(1, seed);
      if (!r.hit) continue;
      const h = r.events.find((e) => e.type === 'serpentHit' && e.fighterId === 0);
      expect(h && h.type === 'serpentHit' ? h.damage : 0).toBe(SERPENT.damage);
      return;
    }
    throw new Error('no Cub was hit in 10 seeds');
  });
});
