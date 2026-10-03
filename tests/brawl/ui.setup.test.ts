import { describe, expect, it } from 'vitest';
import { ANIMAL_IDS } from '../../src/config/animals';
import {
  BRAWL_DIFFICULTY_OPTIONS,
  buildMatchConfig,
  buildRoster,
  defaultBrawlSetup,
  parseBrawlSetup,
  timeLabel,
} from '../../src/brawl/ui/setup';
import { parseBrawlParams } from '../../src/brawl/ui/urlParams';
import { stageThumbSvg } from '../../src/brawl/ui/stageThumb';
import { STAGES } from '../../src/brawl/data';
import { STAGE_IDS } from '../../src/brawl/types';
import type { BrawlFighterResult } from '../../src/brawl/ui/BrawlResults';
import { buildResultsData, formatMatchTime } from '../../src/brawl/ui/BrawlResults';
import type { BrawlFighterState, BrawlSnapshot } from '../../src/brawl/types';

describe('roster builder', () => {
  it('slot 0 is the player; bots are unique, never the player animal, and the count matches', () => {
    for (let seed = 1; seed <= 60; seed++) {
      for (const n of [1, 2, 3]) {
        const animal = ANIMAL_IDS[seed % ANIMAL_IDS.length];
        const r = buildRoster(animal, n, seed * 7919);
        expect(r).toHaveLength(n + 1);
        expect(r[0]).toEqual({ animal, isPlayer: true });
        expect(r.slice(1).every((e) => !e.isPlayer)).toBe(true);
        const names = r.map((e) => e.animal);
        expect(new Set(names).size).toBe(names.length);
        expect(names.every((a) => (ANIMAL_IDS as readonly string[]).includes(a))).toBe(true);
      }
    }
  });

  it('is deterministic per seed and varies across seeds', () => {
    expect(buildRoster('lion', 3, 123)).toEqual(buildRoster('lion', 3, 123));
    const seen = new Set<string>();
    for (let s = 0; s < 40; s++) seen.add(buildRoster('lion', 3, s).map((e) => e.animal).join(','));
    expect(seen.size).toBeGreaterThan(10);
  });

  it('clamps the opponent count to 1..3', () => {
    expect(buildRoster('lion', 0, 1)).toHaveLength(2);
    expect(buildRoster('lion', 9, 1)).toHaveLength(4);
    expect(buildRoster('lion', Number.NaN, 1)).toHaveLength(2);
  });

  it('buildMatchConfig carries stage, difficulty, stocks and the time limit in seconds', () => {
    const cfg = buildMatchConfig({ ...defaultBrawlSetup('gorilla'), stage: 'skyAqueduct', difficulty: 4, stocks: 5, timeMin: 8, opponents: 2 }, 99);
    expect(cfg.stage).toBe('skyAqueduct');
    expect(cfg.difficulty).toBe(4);
    expect(cfg.stocks).toBe(5);
    expect(cfg.timeLimitS).toBe(480);
    expect(cfg.roster).toHaveLength(3);
    expect(cfg.roster[0].animal).toBe('gorilla');
    expect(buildMatchConfig({ ...defaultBrawlSetup(), timeMin: 0 }, 1).timeLimitS).toBe(0);
  });
});

describe('stored setup parsing (gk-brawl)', () => {
  const fallback = defaultBrawlSetup('panther');

  it('missing / empty / junk storage gives the defaults with the fallback animal', () => {
    for (const raw of [null, undefined, '', 'not json', '{', '[]', '123', '"x"', 'null', 'true']) {
      expect(parseBrawlSetup(raw, 'panther')).toEqual(fallback);
    }
  });

  it('keeps valid values and replaces each invalid field independently', () => {
    const good = JSON.stringify({ animal: 'mole', stage: 'skyAqueduct', opponents: 2, difficulty: 4, stocks: 5, timeMin: 8 });
    expect(parseBrawlSetup(good)).toEqual({ animal: 'mole', stage: 'skyAqueduct', opponents: 2, difficulty: 4, stocks: 5, timeMin: 8 });
    const bad = JSON.stringify({ animal: 'dragon', stage: 'moon', opponents: 7, difficulty: 0, stocks: '3', timeMin: 4 });
    expect(parseBrawlSetup(bad, 'eagle')).toEqual(defaultBrawlSetup('eagle'));
    const partial = JSON.stringify({ animal: 'hippo', stocks: 1, difficulty: 'x' });
    expect(parseBrawlSetup(partial)).toEqual({ ...defaultBrawlSetup('hippo'), stocks: 1 });
  });

  it('never throws on wrong types / prototype junk', () => {
    expect(() => parseBrawlSetup('{"animal":{"a":1},"stage":[],"opponents":null,"__proto__":{"x":1}}')).not.toThrow();
    expect(parseBrawlSetup('{"timeMin":0}').timeMin).toBe(0);
    expect(parseBrawlSetup('{"timeMin":NaN}')).toEqual(defaultBrawlSetup('lion'));
  });

  it('defaults: 3 stocks, 5 minutes, 3 bots, Broken Colosseum', () => {
    const d = defaultBrawlSetup();
    expect(d).toMatchObject({ stocks: 3, timeMin: 5, opponents: 3, stage: 'brokenColosseum' });
    expect(BRAWL_DIFFICULTY_OPTIONS).toEqual([1, 2, 3, 4]);
    expect(timeLabel(0)).toBe('∞');
    expect(timeLabel(5)).toBe('5 min');
  });
});

describe('URL shortcut', () => {
  const base = defaultBrawlSetup('lion');
  it('is null unless brawl=1', () => {
    expect(parseBrawlParams(new URLSearchParams('animal=lion'), base)).toBeNull();
    expect(parseBrawlParams(new URLSearchParams('brawl=0'), base)).toBeNull();
  });

  it('parses the documented query', () => {
    const s = parseBrawlParams(new URLSearchParams('brawl=1&animal=eagle&stage=skyAqueduct&bots=2&level=3&stocks=4&time=3'), base);
    expect(s).toEqual({ animal: 'eagle', stage: 'skyAqueduct', opponents: 2, difficulty: 3, stocks: 4, timeMin: 3 });
  });

  it('validates every field, falling back to the base', () => {
    const s = parseBrawlParams(new URLSearchParams('brawl=1&animal=unicorn&stage=nope&bots=9&level=x&stocks=&time=4'), base);
    expect(s).toEqual(base);
    expect(parseBrawlParams(new URLSearchParams('brawl=1&time=0'), base)?.timeMin).toBe(0);
  });
});

describe('stage thumbnails', () => {
  it('draws every platform of the real StageDef (solid blocks, soft planks, travel range of the moving one)', () => {
    for (const id of STAGE_IDS) {
      const def = STAGES[id];
      const svg = stageThumbSvg(def);
      const solids = def.platforms.filter((p) => p.kind === 'solid').length;
      const softs = def.platforms.filter((p) => p.kind === 'soft').length;
      expect((svg.match(/class="bs-solid"/g) ?? []).length).toBe(solids);
      expect((svg.match(/class="bs-soft"/g) ?? []).length).toBe(softs);
      expect((svg.match(/class="bs-spawn"/g) ?? []).length).toBe(def.spawns.length);
      expect((svg.match(/class="bs-travel"/g) ?? []).length).toBe(def.platforms.filter((p) => p.moving).length);
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg).toContain(def.name);
    }
  });
});

function fighter(id: number, over: Partial<BrawlFighterState>): BrawlFighterState {
  return {
    id,
    animal: ANIMAL_IDS[id],
    isPlayer: id === 0,
    alive: true,
    pos: { x: 0, y: 0 },
    vel: { x: 0, y: 0 },
    facing: 1,
    grounded: true,
    platformId: null,
    action: 'idle',
    actionFrame: 0,
    actionFrames: 0,
    moveId: null,
    moveChain: 0,
    moveAir: false,
    moveFrame: 0,
    moveFrames: 0,
    movePhase: null,
    dodgeCd: 0,
    hitstunTotal: 0,
    lastHitBy: -1,
    percent: 0,
    stocks: 3,
    jumpsLeft: 2,
    hitstun: 0,
    hitlag: 0,
    invuln: 0,
    lastLaunch: null,
    kos: 0,
    falls: 0,
    damageDealt: 0,
    ...over,
  };
}

describe('results data', () => {
  const setup = defaultBrawlSetup('lion');
  const config = buildMatchConfig(setup, 5);
  const snap = (winnerId: number, fighters: BrawlFighterState[], timeLeft: number | null = 120): BrawlSnapshot => ({
    frame: 5000,
    time: 83.4,
    countdown: 0,
    timeLeft,
    fighters,
    platforms: [],
    hitboxes: [],
    matchOver: true,
    winnerId,
  });

  it('winner first, then stocks, KOs, falls, damage; the player place and flags follow', () => {
    const fighters = [
      fighter(0, { stocks: 0, kos: 1, falls: 3, damageDealt: 90.4 }),
      fighter(1, { stocks: 2, kos: 3, falls: 1, damageDealt: 210.6 }),
      fighter(2, { stocks: 1, kos: 2, falls: 2, damageDealt: 150 }),
      fighter(3, { stocks: 0, kos: 0, falls: 3, damageDealt: 20 }),
    ];
    const r = buildResultsData(setup, config, snap(1, fighters));
    expect(r.winnerId).toBe(1);
    expect(r.draw).toBe(false);
    expect(r.playerWon).toBe(false);
    expect(r.fighters.map((f: BrawlFighterResult) => f.id)).toEqual([1, 2, 0, 3]);
    expect(r.fighters.map((f) => f.place)).toEqual([1, 2, 3, 4]);
    expect(r.playerPlace).toBe(3);
    expect(r.fighters[0].damageDealt).toBe(211);
    expect(r.stageName).toBe(STAGES[config.stage].name);
    expect(r.matchTimeS).toBeCloseTo(83.4, 5);
    expect(r.timeUp).toBe(false);
  });

  it('player win, draw and time-up', () => {
    const fighters = [fighter(0, { stocks: 1 }), fighter(1, { stocks: 0 })];
    const win = buildResultsData(setup, config, snap(0, fighters));
    expect(win.playerWon).toBe(true);
    expect(win.playerPlace).toBe(1);
    const draw = buildResultsData(setup, config, snap(-1, fighters, 0));
    expect(draw.draw).toBe(true);
    expect(draw.playerWon).toBe(false);
    expect(draw.timeUp).toBe(true);
  });

  it('formats the match time', () => {
    expect(formatMatchTime(0)).toBe('0:00');
    expect(formatMatchTime(83.4)).toBe('1:23');
    expect(formatMatchTime(-4)).toBe('0:00');
  });
});
