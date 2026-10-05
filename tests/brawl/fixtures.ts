/**
 * Test fixtures for the Champions League simulation: tiny hand-made movesets and stages so the
 * sim tests never depend on the shipped balance data (src/brawl/data).
 */

import type { AnimalId } from '../../src/core/types';
import type {
  BrawlIntent,
  BrawlMatchConfig,
  CharacterStats,
  HitboxDef,
  MoveBody,
  MoveData,
  MoveId,
  MovesetDef,
  PlatformDef,
  StageDef,
  StageId,
} from '../../src/brawl/types';
import { MOVE_IDS } from '../../src/brawl/types';
import type { BrawlDataSource } from '../../src/brawl/sim/dataSource';
import { BrawlWorld } from '../../src/brawl/sim/BrawlWorld';
import { PHYS } from '../../src/brawl/config';
import { STAGE_DEFS } from '../../src/brawl/data/stages';

// ── stats ────────────────────────────────────────────────────────────────────

function stats(over: Partial<CharacterStats> = {}): CharacterStats {
  return {
    weight: 100,
    walkSpeed: 4.6,
    runSpeed: 8.6,
    airSpeed: 6.6,
    airAccel: 30,
    jumpVel: 14.5,
    airJumpVel: 13,
    maxJumps: 2,
    gravityMult: 1,
    fallSpeed: 18,
    fastFallSpeed: 26,
    width: 1.1,
    height: 1.5,
    dodgeInvuln: 14,
    dodgeFrames: 26,
    ...over,
  };
}

const STATS: Partial<Record<AnimalId, CharacterStats>> = {
  lion: stats(),
  gorilla: stats({ weight: 125, walkSpeed: 3.8, runSpeed: 7.2, airSpeed: 5.4, width: 1.5, height: 2, gravityMult: 1.1, dodgeFrames: 28 }),
  crocodile: stats({ weight: 115, width: 2, height: 1, gravityMult: 1.15 }),
  eagle: stats({ weight: 78, maxJumps: 4, gravityMult: 0.8, fallSpeed: 14, fastFallSpeed: 24, glideFall: 6.5, width: 1, height: 1.2, dodgeFrames: 24 }),
  mole: stats({ weight: 72, width: 0.8, height: 0.8, dodgeFrames: 24 }),
  panther: stats({ weight: 90, width: 1.1, height: 1.3 }),
  hippo: stats({ weight: 140, width: 1.8, height: 1.5, gravityMult: 1.2 }),
};

// ── move builders ────────────────────────────────────────────────────────────

export function circle(
  x: number,
  y: number,
  r: number,
  from: number,
  to: number,
  damage: number,
  baseKb: number,
  kbGrowth: number,
  angle: number,
  extra: Partial<HitboxDef> = {},
): HitboxDef {
  return { shape: 'circle', x, y, r, w: 0, h: 0, from, to, damage, baseKb, kbGrowth, angle, ...extra };
}

export function rect(
  x: number,
  y: number,
  w: number,
  h: number,
  from: number,
  to: number,
  damage: number,
  baseKb: number,
  kbGrowth: number,
  angle: number,
  extra: Partial<HitboxDef> = {},
): HitboxDef {
  return { shape: 'rect', x, y, r: 0, w, h, from, to, damage, baseKb, kbGrowth, angle, ...extra };
}

export function mkBody(name: string, t: [number, number, number], hitboxes: HitboxDef[], extra: Partial<MoveBody> = {}): MoveBody {
  return { name, archetype: 'swipe', startup: t[0], active: t[1], recovery: t[2], hitboxes, ...extra };
}

function air(body: MoveBody, lag: number): Partial<MoveBody> {
  const total = body.startup + body.active + body.recovery;
  return { landingLag: lag, autoCancel: { from: total - 6, to: total }, cancels: [] };
}

function buildMoves(animal: AnimalId): Record<MoveId, MoveData> {
  // light-neutral string: a true combo from 0 %
  const n1 = mkBody('n1', [4, 2, 10], [circle(1, 0.9, 0.5, 4, 6, 3, 4, 3, 40, { hitstunScale: 5 })], {
    cancels: [{ into: ['lightN'], from: 6, to: 14, onHitOnly: false }],
  });
  const n2 = mkBody('n2', [3, 2, 10], [circle(1, 0.9, 0.5, 3, 5, 3, 4, 3, 40, { hitstunScale: 5 })], {
    cancels: [{ into: ['lightN'], from: 5, to: 13, onHitOnly: true }],
  });
  const n3 = mkBody('n3', [4, 3, 12], [circle(1.1, 0.9, 0.55, 4, 7, 4, 7, 8, 50, { hitstunScale: 1 })]);
  const lightS = mkBody('lightS', [6, 3, 14], [circle(1.2, 0.9, 0.5, 6, 9, 7, 6, 9, 35)]);
  const lightD = mkBody('lightD', [5, 3, 12], [rect(1.1, 0.3, 1, 0.5, 5, 8, 6, 5, 7, 68)]);
  const lightU = mkBody('lightU', [6, 3, 14], [circle(0.9, 1.1, 0.55, 6, 9, 7, 6, 9, 85)]);
  let heavyN = mkBody(
    'heavyN',
    [14, 4, 24],
    [rect(1, 1, 2, 1.6, 14, 18, 11, 9, 16, 40, { group: 1 }), rect(-1, 1, 2, 1.6, 14, 18, 11, 9, 16, 140, { group: 1 })],
  );
  let heavyS = mkBody('heavyS', [16, 4, 28], [circle(1.5, 1, 0.5, 16, 20, 16, 9, 19, 38, { hitlag: 3, sweet: { x: 1.8, y: 1, r: 0.3, damageMult: 1.25, kbMult: 1.2 } })]);
  const heavyD = mkBody('heavyD', [14, 4, 26], [rect(0.9, 0.4, 1.6, 0.8, 14, 18, 13, 9, 15, 75)]);
  const heavyU = mkBody('heavyU', [8, 14, 24], [circle(0.9, 1.2, 0.65, 8, 22, 9, 9, 16, 80)], {
    motion: [{ from: 6, to: 16, vx: 4, vy: 13.5, set: true }],
  });
  const heavyDAir: Partial<MoveBody> = {
    ...air(heavyD, 22),
    hitboxes: [circle(0.55, -0.15, 0.6, 14, 18, 14, 9, 16, 270, { effect: 'spike' })],
  };
  if (animal === 'gorilla') {
    heavyS = { ...heavyS, armor: { from: 4, to: 16, hits: 1, dmgScale: 0.5 } };
  }
  if (animal === 'crocodile') {
    heavyN = mkBody('deathRoll', [10, 24, 12], [circle(1, 0.5, 0.9, 10, 34, 2, 3, 2, 60, { multiHitInterval: 6, effect: 'pull' })]);
  }
  const heavyUPanther: MoveBody =
    animal === 'panther' ? { ...heavyU, invuln: { from: 0, to: 12 } } : heavyU;
  const mv = (id: MoveId, ground: MoveBody, airForm: Partial<MoveBody> | null, chain?: MoveBody[]): MoveData => {
    const m: MoveData = { id, ground, air: airForm };
    if (chain) m.chain = chain;
    return m;
  };
  return {
    lightN: mv('lightN', n1, air(n1, 6), [n2, n3]),
    lightS: mv('lightS', lightS, air(lightS, 8)),
    lightD: mv('lightD', lightD, air(lightD, 8)),
    lightU: mv('lightU', lightU, air(lightU, 8)),
    heavyN: mv('heavyN', heavyN, air(heavyN, 18)),
    heavyS: mv('heavyS', heavyS, air(heavyS, 22)),
    heavyD: mv('heavyD', heavyD, heavyDAir),
    heavyU: mv('heavyU', heavyUPanther, air(heavyUPanther, 16)),
  };
}

const movesets = new Map<AnimalId, MovesetDef>();

export function fixtureMoveset(animal: AnimalId): MovesetDef {
  let m = movesets.get(animal);
  if (!m) {
    m = { animal, tagline: 'fixture', stats: STATS[animal] ?? stats(), moves: buildMoves(animal) };
    movesets.set(animal, m);
  }
  return m;
}

// ── stages ───────────────────────────────────────────────────────────────────

const COLOSSEUM_PLATS: PlatformDef[] = [
  { id: 'main', kind: 'solid', x0: -11, x1: 11, y: 0, thickness: 3.5, ledgeLeft: true, ledgeRight: true },
  { id: 'left', kind: 'soft', x0: -9, x1: -4, y: 4.2, thickness: 0.4 },
  { id: 'right', kind: 'soft', x0: 4, x1: 9, y: 4.2, thickness: 0.4 },
  { id: 'top', kind: 'soft', x0: -2.5, x1: 2.5, y: 7.6, thickness: 0.4 },
];

const AQUEDUCT_PLATS: PlatformDef[] = [
  { id: 'islandL', kind: 'solid', x0: -13, x1: -3, y: 0, thickness: 3, ledgeLeft: true, ledgeRight: true },
  { id: 'islandR', kind: 'solid', x0: 3, x1: 13, y: 0, thickness: 3, ledgeLeft: true, ledgeRight: true },
  { id: 'drifter', kind: 'soft', x0: -2.5, x1: 2.5, y: 2.6, thickness: 0.4, moving: { axis: 'x', amplitude: 3.2, periodS: 9, phase: 0 } },
  { id: 'high', kind: 'soft', x0: -3, x1: 3, y: 7.8, thickness: 0.4 },
];

export const FIX_STAGES: Record<StageId, StageDef> = {
  brokenColosseum: {
    id: 'brokenColosseum',
    name: 'fixture colosseum',
    blurb: '',
    blast: { left: -30, right: 30, top: 22, bottom: -16 },
    platforms: COLOSSEUM_PLATS,
    spawns: [
      { x: -7, y: 0 },
      { x: -2.5, y: 0 },
      { x: 2.5, y: 0 },
      { x: 7, y: 0 },
    ],
    respawn: { x: 0, y: 12 },
    cameraFocus: { x: 0, y: 4 },
    camera: { minHalfW: 11, maxHalfW: 19 },
  },
  skyAqueduct: {
    id: 'skyAqueduct',
    name: 'fixture aqueduct',
    blurb: '',
    blast: { left: -30, right: 30, top: 22, bottom: -18 },
    platforms: AQUEDUCT_PLATS,
    spawns: [
      { x: -10, y: 0 },
      { x: -6, y: 0 },
      { x: 6, y: 0 },
      { x: 10, y: 0 },
    ],
    respawn: { x: 0, y: 12 },
    cameraFocus: { x: 0, y: 4 },
    camera: { minHalfW: 12, maxHalfW: 21 },
  },
  // v1.6 dynamic stages: the sim tests exercise the SHIPPED geometry (an independent copy, so a test may mutate it freely)
  clockworkHeights: structuredClone(STAGE_DEFS.clockworkHeights),
  crumblingAmphitheatre: structuredClone(STAGE_DEFS.crumblingAmphitheatre),
};

/** Mirrors the shipped registry's body resolution (air partial over ground; chain > 0 = chain[chain − 1]). */
export const FIXTURE_SOURCE: BrawlDataSource = {
  getMoveset: fixtureMoveset,
  getMoveBody(animal, id, air, chain = 0) {
    const data = fixtureMoveset(animal).moves[id];
    if (chain > 0) return data.chain?.[chain - 1] ?? data.ground;
    if (air && data.air && !data.groundOnly) return { ...data.ground, ...data.air };
    return data.ground;
  },
  getStage: (id) => FIX_STAGES[id],
};

// ── world helpers ────────────────────────────────────────────────────────────

export function cfg(animals: AnimalId[], over: Partial<BrawlMatchConfig> = {}): BrawlMatchConfig {
  return {
    stage: 'brokenColosseum',
    roster: animals.map((animal, i) => ({ animal, isPlayer: i === 0 })),
    difficulty: 3,
    stocks: 3,
    timeLimitS: 300,
    ...over,
  };
}

/** A live world (countdown skipped) on the fixture data. */
export function liveWorld(animals: AnimalId[], over: Partial<BrawlMatchConfig> = {}, seed = 1): BrawlWorld {
  const w = new BrawlWorld(cfg(animals, over), seed, FIXTURE_SOURCE);
  w.skipCountdown();
  return w;
}

export function intent(over: Partial<BrawlIntent> = {}): BrawlIntent {
  return { moveX: 0, moveY: 0, jump: false, jumpHeld: false, light: false, heavy: false, dodge: false, ...over };
}

/** Step `n` frames, setting `fn(frameIndex)` as the intent for fighter `id` before every step. */
export function run(w: BrawlWorld, n: number, id: number, fn: (i: number) => Partial<BrawlIntent> = () => ({})): void {
  for (let i = 0; i < n; i++) {
    w.setIntent(id, intent(fn(i)));
    w.step();
  }
}

/** Step `n` idle frames. */
export function idle(w: BrawlWorld, n: number): void {
  for (let i = 0; i < n; i++) w.step();
}

export const FRAME = PHYS.dt;
export { MOVE_IDS };
