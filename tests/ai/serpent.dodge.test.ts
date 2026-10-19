/**
 * v1.9 WP-O2: bots dodge the sea-serpent strike (src/ai/SerpentSense.ts, hooks in BotBrain).
 *
 * - Unit tests pin the knobs (reaction ladder, no-op off the Ocean Dome, strip geometry, the exit heading, `repel`).
 * - The dodge-rate test runs isolated trials on the real Ocean Dome (scripts/serpentTrial.ts: a fighter at a random point of the strip,
 *   real World physics, the bot's own SerpentSense steering) and pins the targets: Apex >= 90 %, Veteran >= 75 %, Fighter >= 50 %,
 *   Cub 25-40 % (asserted with a little slack for the finite sample). v1.10: one table per LANE - the LOW serpent's trial starts the
 *   fighter on low ground in a strip drawn like the sim draws it, the HIGH serpent's on a tower top / the upper part of a tower ramp.
 *   (The v1.9 trial drew the angle uniformly and the point anywhere in the strip, so with the towers a "low" event could put the
 *   fighter on a tower top, where the low serpent cannot hurt it: Cub 0.467 against the 0.45 bound. Lane-aware, N = 400 per level:
 *   Cub 36.8, Fighter 56.5, Veteran 81.5, Apex 94.5 % - the v1.9.1 numbers, unchanged.)
 * - Two-lane tests: a bot reacts only to the serpent of the band it stands in, leaves a tower top without stepping off the rim, takes
 *   the 50-HP fall on purpose only when no safe cell is reachable in time and only when healthy, and does not walk up a ramp into a live
 *   strip of the high serpent.
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
import { COLOSSEUM_ARENA, JUNGLE_ARENA, OCEAN_ARENA, OCEAN_STACKS, arenaGroundHeight, arenaSerpentBand } from '../../src/config/arenas';
import { deadlyEdgeAhead, getNavGrid } from '../../src/ai/NavGrid';
import { SERPENT } from '../../src/config/serpent';
import { mulberry32 } from '../../src/core/math';
import type { AnimalId, Difficulty, FighterIntent, FighterState, GameEvent, MatchConfig, SerpentState, SerpentTier } from '../../src/core/types';
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

describe('dodge rates of standing bots (isolated trials on the real Ocean Dome, per lane)', () => {
  const N = 14; // per animal and level
  const animals = ANIMAL_IDS as readonly AnimalId[];
  for (const tier of ['low', 'high'] as SerpentTier[]) {
    const rates: Record<number, number> = {};
    const falls: Record<number, number> = {};
    describe(`${tier} serpent`, () => {
      for (const lvl of [1, 2, 3, 4] as Difficulty[]) {
        it(`L${lvl} ${BOT_PROFILES[lvl].displayName}`, () => {
          let ok = 0;
          let tot = 0;
          let fell = 0;
          for (const a of animals) {
            for (let i = 0; i < N; i++) {
              const r = trial(a, lvl, 70000 + lvl * 1000 + i * 17 + (a.charCodeAt(0) + a.length) * 131, tier);
              tot++;
              if (!r.hit) ok++;
              if (r.fell) fell++;
              if (tier === 'low') expect(r.startY).toBeLessThan(4.5); // a low event never starts a trial on high ground
              else expect(r.startY).toBeGreaterThanOrEqual(4.5);
            }
          }
          rates[lvl] = ok / tot;
          falls[lvl] = fell / tot;
          if (process.env.SERPENT_REPORT === '1') console.log(`${tier} L${lvl} dodge ${(100 * rates[lvl]).toFixed(1)} % (${ok}/${tot}), fell ${(100 * falls[lvl]).toFixed(1)} %`);
          if (lvl === 4) expect(rates[lvl]).toBeGreaterThanOrEqual(0.86);
          if (lvl === 3) expect(rates[lvl]).toBeGreaterThanOrEqual(0.74);
          if (lvl === 2) {
            expect(rates[lvl]).toBeGreaterThanOrEqual(0.46);
            expect(rates[lvl]).toBeLessThanOrEqual(0.8);
          }
          if (lvl === 1) {
            expect(rates[lvl]).toBeGreaterThanOrEqual(0.2);
            expect(rates[lvl]).toBeLessThanOrEqual(0.5);
          }
        });
      }
      it('the ladder is monotone: Apex > Veteran > Fighter > Cub', () => {
        expect(rates[4]).toBeGreaterThan(rates[3]);
        expect(rates[3]).toBeGreaterThan(rates[2]);
        expect(rates[2]).toBeGreaterThan(rates[1]);
      });
      if (tier === 'high') {
        it('Cub / Fighter fall off the tower now and then (50 HP, not 300); Veteran / Apex rarely', () => {
          expect(falls[1] + falls[2]).toBeGreaterThan(0);
          expect(falls[3]).toBeLessThan(0.3);
          expect(falls[4]).toBeLessThan(0.2);
        });
      } else {
        it('the low lane never makes anyone fall', () => {
          expect(falls[1] + falls[2] + falls[3] + falls[4]).toBe(0);
        });
      }
    });
  }
});

describe('two lanes: the lane of the band a bot stands in (SerpentSense unit tests)', () => {
  const tower = OCEAN_STACKS[1]; // 180 deg: centre (-19, 0), top 6.5 m; its causeway runs along the x axis towards the plateau
  const deadly = getNavGrid(OCEAN_ARENA, 0.7, 0).deadly;

  function me(x: number, z: number, animal: AnimalId = 'lion', hpFrac = 1): FighterState {
    return { pos: { x, y: arenaGroundHeight(OCEAN_ARENA, x, z), z }, animal, hp: 1000 * hpFrac, maxHp: 1000, vel: { x: 0, y: 0, z: 0 } } as unknown as FighterState;
  }
  /** Warn at t = 0, then ask again 0.5 s later with a seed whose reaction draw is fast and not a miss. */
  function seeded(level: Difficulty, f: FighterState, low: SerpentState | undefined, high: SerpentState | undefined, animal: AnimalId = 'lion') {
    for (let seed = 1; seed < 60; seed++) {
      const s = new SerpentSense(OCEAN_ARENA, animal, level);
      const rng = mulberry32(seed);
      const out: Move2 = { x: 0, z: 0 };
      s.update(100, f, low, 150, false, rng, out, high);
      if (!Number.isFinite(s.reactAfterS) || s.reactAfterS > 0.45) continue;
      const tl = low === undefined ? undefined : { ...low, t: low.t + 0.5 };
      const th = high === undefined ? undefined : { ...high, t: high.t + 0.5 };
      const r = s.update(100.5, f, tl, 150, false, rng, out, th);
      return { r, s, out, rng };
    }
    throw new Error('no usable seed');
  }

  it('a bot on the seabed ignores a HIGH strike across its spot; a bot on a tower top ignores a LOW strike across its spot', () => {
    const seabed = me(-24, 1.0);
    expect(arenaSerpentBand(OCEAN_ARENA, seabed.pos.x, seabed.pos.z)).toBe('low');
    expect(seeded(4, seabed, undefined, warn(180)).r).toBe(false);
    const top = me(tower.x + 0.3, 1.0);
    expect(arenaSerpentBand(OCEAN_ARENA, top.pos.x, top.pos.z)).toBe('high');
    expect(seeded(4, top, warn(180), undefined).r).toBe(false);
  });

  it('a bot on a tower top steps out of a HIGH strike; a bot on the seabed steps out of a LOW one', () => {
    const top = me(tower.x + 0.3, 0.3);
    const a = seeded(4, top, undefined, warn(180));
    expect(a.r).toBe(true);
    expect(a.s.dodging).toBe(true);
    const seabed = me(-24, 0.3);
    const b = seeded(4, seabed, warn(180), undefined);
    expect(b.r).toBe(true);
    expect(Math.abs(b.out.z)).toBeGreaterThan(0.9); // across the line
  });

  it('the way out of a tower top never leads over the rim: the first 1.2 m of every Veteran / Apex exit are free of a deadly edge', () => {
    for (const animal of ['lion', 'hippo', 'mole'] as AnimalId[]) {
      for (const lateral of [-2.5, -1.2, -0.3, 0.4, 1.5, 2.8]) {
        for (const level of [3, 4] as Difficulty[]) {
          // a strike along the x axis (angle 180) shifted by `lateral`: stand on the tower at (centre.x + 0.5, lateral)
          const f = me(tower.x + 0.5, lateral, animal);
          if (arenaSerpentBand(OCEAN_ARENA, f.pos.x, f.pos.z) !== 'high') continue;
          const r = seeded(level, f, undefined, warn(180), animal);
          if (!r.r || r.s.diving) continue; // already clear of the strip, or no safe cell in time (covered below)
          expect(deadlyEdgeAhead(OCEAN_ARENA, f.pos.x, f.pos.z, r.out.x, r.out.z, 1.2, deadly), `${animal} L${level} lateral ${lateral}`).toBeLessThan(0);
        }
      }
    }
  });

  it('no safe cell in time (a rhino at the centre of a tower, a strike through it, late in the warning): a healthy Apex dives, a hurt one does not, a Fighter never does', () => {
    const late = { phase: 'warn', angleDeg: 180, t: 0.8, headR: 30 } as SerpentState;
    const centre = me(tower.x, 0, 'rhino', 1);
    for (let seed = 1; seed < 40; seed++) {
      const s = new SerpentSense(OCEAN_ARENA, 'rhino', 4);
      const out: Move2 = { x: 0, z: 0 };
      s.update(100, centre, undefined, 150, false, mulberry32(seed), out, { ...late, t: 0.2 });
      if (!Number.isFinite(s.reactAfterS) || s.reactAfterS > 0.5) continue;
      const rng = mulberry32(seed);
      const s1 = new SerpentSense(OCEAN_ARENA, 'rhino', 4);
      s1.update(100, centre, undefined, 150, false, rng, out, { ...late, t: 0.2 });
      expect(s1.update(100.6, centre, undefined, 150, false, rng, out, late)).toBe(true);
      expect(s1.diving, `seed ${seed}`).toBe(true);
      // the dive heads for the nearest rim
      expect(deadlyEdgeAhead(OCEAN_ARENA, centre.pos.x, centre.pos.z, out.x, out.z, 4, deadly)).toBeGreaterThan(0);
      // a hurt Apex (40 %) takes its chances instead
      const hurt = me(tower.x, 0, 'rhino', 0.4);
      const rng2 = mulberry32(seed);
      const s2 = new SerpentSense(OCEAN_ARENA, 'rhino', 4);
      s2.update(100, hurt, undefined, 150, false, rng2, out, { ...late, t: 0.2 });
      expect(s2.update(100.6, hurt, undefined, 150, false, rng2, out, late)).toBe(true);
      expect(s2.diving).toBe(false);
      // a Fighter never dives
      const rng3 = mulberry32(seed);
      const s3 = new SerpentSense(OCEAN_ARENA, 'rhino', 2);
      s3.update(100, centre, undefined, 150, false, rng3, out, { ...late, t: 0.2 });
      s3.update(101.5, centre, undefined, 150, false, rng3, out, { ...late, t: 1.5 });
      expect(s3.diving).toBe(false);
      return;
    }
    throw new Error('no usable seed');
  });

  it('Veteran / Apex hold at the foot of the tower ramp rather than walk up into a live HIGH strip; a Cub walks on', () => {
    // the causeway of the 180 deg tower runs along z = 0: find the spot where the ground reaches the high band (4.5 m)
    let x = -8;
    while (arenaGroundHeight(OCEAN_ARENA, x, 0) < 4.35 && x > -17) x -= 0.05;
    const foot = me(x, 0);
    expect(arenaSerpentBand(OCEAN_ARENA, x, 0)).toBe('low');
    for (const level of [1, 2, 3, 4] as Difficulty[]) {
      const r = seeded(level, foot, undefined, warn(180));
      const move: Move2 = { x: -1, z: 0 }; // up the ramp, into the strip
      r.s.repel(move, 100.5, foot.pos.x, foot.pos.z);
      if (level >= 3) expect(move, `L${level}`).toEqual({ x: 0, z: 0 });
      else expect(move, `L${level}`).toEqual({ x: -1, z: 0 });
    }
    // a LOW strike along the same line cannot hurt the high ground: walking up is fine
    const r = seeded(4, foot, warn(180), undefined);
    const move: Move2 = { x: -1, z: 0 };
    r.s.repel(move, 100.5, foot.pos.x, foot.pos.z);
    expect(move).toEqual({ x: -1, z: 0 });
  });

  it('with both lanes live, a Veteran on a tower top still leaves the HIGH strip over the platform (the LOW strip is another band)', () => {
    const t2 = OCEAN_STACKS[2];
    const f = me(t2.x, t2.z + 0.2, 'lion');
    const r = seeded(3, f, warn(t2.deg + 40), warn(t2.deg));
    expect(r.r).toBe(true);
    expect(arenaSerpentBand(OCEAN_ARENA, f.pos.x, f.pos.z)).toBe('high');
    expect(r.s.diving).toBe(false);
    expect(deadlyEdgeAhead(OCEAN_ARENA, f.pos.x, f.pos.z, r.out.x, r.out.z, 1.2, deadly)).toBeLessThan(0);
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

/** A real BotBrain on the 180 deg tower top beside an idle dummy, a HIGH strike along the x axis (through the tower) at t = 0.5 s. */
function towerScenario(level: Difficulty, seed: number) {
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
  const world = new World(cfg, seed, bus, { traps: false, serpent: { chance: 0, intervalS: 1e9 } });
  const bots = new BotManager(bus, level, seed, world.arena);
  const t = OCEAN_STACKS[1];
  const bot = world.fighters[0].state;
  const dummy = world.fighters[1].state;
  bot.pos.x = t.x + 0.6;
  bot.pos.z = 0.4;
  bot.pos.y = arenaGroundHeight(OCEAN_ARENA, bot.pos.x, bot.pos.z);
  world.fighters[0].lastGroundY = bot.pos.y;
  dummy.pos.x = t.x - 1.4;
  dummy.pos.z = -0.4;
  dummy.pos.y = bot.pos.y;
  world.fighters[1].lastGroundY = bot.pos.y;
  dummy.hp = dummy.maxHp = 1e6;
  let warned = false;
  for (let tick = 0; tick < 60 * 6; tick++) {
    if (!warned && world.time > 0.5) {
      world.debugTriggerSerpent(180, 'high');
      warned = true;
    }
    bots.update(world.snapshot(), DT);
    world.setIntent(0, bots.getIntent(0));
    world.setIntent(1, IDLE);
    world.step(DT);
  }
  const hit = events.some((e) => e.type === 'serpentHit' && e.fighterId === 0);
  const fell = events.some((e) => e.type === 'fall' && e.fighterId === 0);
  return { hit, fell, events };
}

describe('BotBrain on a tower top under the HIGH serpent (real brain, real World)', () => {
  it('an Apex usually sidesteps along the platform or takes the 50-HP fall, an Apex does better than a Cub, and a hit is the 300-damage one', () => {
    let apexHit = 0;
    let cubHit = 0;
    for (let seed = 1; seed <= 12; seed++) {
      if (towerScenario(4, seed).hit) apexHit++;
      if (towerScenario(1, seed).hit) cubHit++;
    }
    expect(apexHit).toBeLessThanOrEqual(3);
    expect(cubHit).toBeGreaterThanOrEqual(4);
    expect(cubHit).toBeGreaterThan(apexHit);
  });

  it('the LOW serpent along the same line cannot touch a bot on the tower: nobody is hit, nobody dodges into the rim', () => {
    for (let seed = 1; seed <= 4; seed++) {
      const cfg: MatchConfig = {
        roster: [
          { animal: 'lion', isPlayer: false },
          { animal: 'rhino', isPlayer: true },
        ],
        difficulty: 4,
        arena: 'ocean',
      };
      const bus = new EventBus();
      const events: GameEvent[] = [];
      bus.onAny((e) => events.push(e));
      const world = new World(cfg, seed, bus, { traps: false, serpent: { chance: 0, intervalS: 1e9 } });
      const bots = new BotManager(bus, 4, seed, world.arena);
      const t = OCEAN_STACKS[1];
      const bot = world.fighters[0].state;
      bot.pos.x = t.x + 0.6;
      bot.pos.z = 0.4;
      bot.pos.y = arenaGroundHeight(OCEAN_ARENA, bot.pos.x, bot.pos.z);
      world.fighters[0].lastGroundY = bot.pos.y;
      world.fighters[1].state.pos.x = 0;
      world.fighters[1].state.pos.z = 0;
      world.fighters[1].state.pos.y = arenaGroundHeight(OCEAN_ARENA, 0, 0);
      let warned = false;
      for (let tick = 0; tick < 60 * 5; tick++) {
        if (!warned && world.time > 0.5) {
          world.debugTriggerSerpent(180, 'low');
          warned = true;
        }
        bots.update(world.snapshot(), DT);
        world.setIntent(0, bots.getIntent(0));
        world.setIntent(1, IDLE);
        world.step(DT);
      }
      expect(events.some((e) => e.type === 'serpentHit' && e.fighterId === 0), `seed ${seed}`).toBe(false);
      expect(events.some((e) => e.type === 'fall' && e.fighterId === 0), `seed ${seed}`).toBe(false);
    }
  });
});
