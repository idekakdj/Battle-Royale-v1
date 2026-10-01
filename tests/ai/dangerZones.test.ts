/**
 * v1.3 danger zones (src/ai/dangerZones.ts) + brain integration (ultDodge policy,
 * ultTargetValid). The placeholder ultimates never opt in (`targeting.dodge`), so
 * zone tests flip the flag on a spec temporarily.
 */

import { describe, it, expect } from 'vitest';
import { EventBus } from '../../src/core/EventBus';
import { BotManager } from '../../src/ai/BotManager';
import {
  DangerZones,
  makeExit,
  zoneDist,
  avoidDangerZones,
  LOCK_ZONE_RADIUS,
  LAZY_MAX_EXIT_M,
} from '../../src/ai/dangerZones';
import { decideAbilities, type Situation, type AbilityWish } from '../../src/ai/scripts';
import { BOT_PROFILES } from '../../src/config/botProfiles';
import { ANIMALS, ANIMAL_IDS } from '../../src/config/animals';
import type { UltDodge } from '../../src/config/animals';
import { mulberry32 } from '../../src/core/math';
import type { AnimalId, Difficulty, FighterState, GameEvent, TrapState, WorldSnapshot } from '../../src/core/types';
import { DT } from './helpers';

// ── helpers ──────────────────────────────────────────────────────────────────

function withDodge<T>(animal: AnimalId, dodge: UltDodge, fn: () => T): T {
  const tg = ANIMALS[animal].ultimate.targeting!;
  tg.dodge = dodge;
  try {
    return fn();
  } finally {
    delete tg.dodge;
  }
}

type TargetEv = Extract<GameEvent, { type: 'ultimateTarget' }>;

function targetEv(over: Partial<TargetEv> = {}): TargetEv {
  return {
    type: 'ultimateTarget',
    fighterId: 1,
    animal: 'mole',
    kind: 'ground',
    targetId: -1,
    from: { x: 0, y: 0, z: 0 },
    to: { x: 10, y: 0, z: 22 },
    range: 10,
    width: 4,
    windup: 1,
    ...over,
  };
}

const NOW = 5;
const REACT = 0.25;
const noAnimal = (): AnimalId | undefined => undefined;

function ingest(zs: DangerZones, ev: GameEvent, now = NOW, react = REACT, self = 0, animalOf: (id: number) => AnimalId | undefined = noAnimal): void {
  zs.ingest(ev, now, react, self, animalOf);
}

function trap(x: number, z: number, phase: TrapState['phase'], radius = 1.2): TrapState {
  return { id: 0, kind: 'fire', pos: { x, y: 0, z }, radius, phase, timeLeft: 1, triggeredBy: -1 };
}

const DODGE_FIXED: UltDodge = { mode: 'fixed', activeS: 0.5 };

// ── zone construction from events ────────────────────────────────────────────

describe('ingest: opt-in only', () => {
  it('only ultimates that declare `targeting.dodge` create a zone (placeholders stay unchanged)', () => {
    for (const animal of ANIMAL_IDS) {
      const optedIn = ANIMALS[animal].ultimate.targeting!.dodge !== undefined;
      const zs = new DangerZones();
      ingest(zs, targetEv({ animal, fighterId: 1 }));
      ingest(zs, { type: 'telegraph', fighterId: 1, kind: 'ultimate', pos: { x: 1, y: 0, z: 1 }, radius: 4, yaw: 0, arcDeg: 360, windup: 1 }, NOW, REACT, 0, () => animal);
      // One zone per caster (the telegraph is replaced by the target event's zone); none without opt-in.
      expect(zs.count, animal).toBe(optedIn ? 1 : 0);
    }
  });

  it('ignores the bot\'s own ultimate and specials', () => {
    withDodge('mole', DODGE_FIXED, () => {
      const zs = new DangerZones();
      ingest(zs, targetEv({ fighterId: 0 }), NOW, REACT, 0);
      ingest(zs, { type: 'telegraph', fighterId: 1, kind: 'special', pos: { x: 1, y: 0, z: 1 }, radius: 4, yaw: 0, arcDeg: 360, windup: 1 }, NOW, REACT, 0, () => 'mole');
      expect(zs.count).toBe(0);
    });
  });
});

describe('ingest: zone shapes and lifetime', () => {
  it('ground → circle at `to`, radius width/2; lives windup + activeS from the EMISSION time', () => {
    withDodge('mole', DODGE_FIXED, () => {
      const zs = new DangerZones();
      ingest(zs, targetEv({ kind: 'ground', to: { x: 3, y: 0, z: 4 }, width: 9, windup: 1 }));
      const z = zs.list[0];
      expect(z).toMatchObject({ key: 1, sourceId: 1, shape: 'circle', ax: 3, az: 4, r: 4.5, committed: true, mode: 'fixed' });
      expect(z.knownAt).toBe(NOW);
      expect(z.expiresAt).toBeCloseTo(NOW - REACT + 1 + 0.5, 9);
      zs.prune(z.expiresAt - 0.01);
      expect(zs.count).toBe(1);
      zs.prune(z.expiresAt + 0.01);
      expect(zs.count).toBe(0);
    });
  });

  it('line → capsule from→to with half-width width/2', () => {
    withDodge('rhino', DODGE_FIXED, () => {
      const zs = new DangerZones();
      ingest(zs, targetEv({ animal: 'rhino', kind: 'line', from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 10 }, width: 3 }));
      const z = zs.list[0];
      expect(z).toMatchObject({ shape: 'capsule', ax: 0, az: 0, bx: 0, bz: 10, r: 1.5 });
      expect(zoneDist(z, 1, 5)).toBeCloseTo(-0.5, 9); // inside the ribbon
      expect(zoneDist(z, 3, 5)).toBeCloseTo(1.5, 9);
      expect(zoneDist(z, 0, 12)).toBeCloseTo(0.5, 9); // past the rounded end
    });
  });

  it('lock → circle at the victim, default radius 1.6 (or the spec radius); self → circle at the caster', () => {
    withDodge('eagle', { mode: 'fixed' }, () => {
      const zs = new DangerZones();
      ingest(zs, targetEv({ animal: 'eagle', kind: 'lock', targetId: 0, to: { x: 6, y: 0, z: 7 }, width: 0 }));
      expect(zs.list[0]).toMatchObject({ shape: 'circle', ax: 6, az: 7, r: LOCK_ZONE_RADIUS });
    });
    withDodge('eagle', { mode: 'fixed', radius: 2.2 }, () => {
      const zs = new DangerZones();
      ingest(zs, targetEv({ animal: 'eagle', kind: 'lock', to: { x: 6, y: 0, z: 7 }, width: 0 }));
      expect(zs.list[0].r).toBe(2.2);
    });
    withDodge('lion', DODGE_FIXED, () => {
      const zs = new DangerZones();
      ingest(zs, targetEv({ animal: 'lion', kind: 'self', from: { x: 2, y: 0, z: 3 }, to: { x: 2, y: 0, z: 3 }, width: 16 }));
      expect(zs.list[0]).toMatchObject({ shape: 'circle', ax: 2, az: 3, r: 8 });
    });
  });

  it('a caster has one zone: a new event replaces it; death removes it', () => {
    withDodge('mole', DODGE_FIXED, () => {
      const zs = new DangerZones();
      ingest(zs, targetEv({ to: { x: 1, y: 0, z: 1 } }));
      ingest(zs, targetEv({ to: { x: 8, y: 0, z: 8 } }));
      expect(zs.count).toBe(1);
      expect(zs.list[0].ax).toBe(8);
      ingest(zs, { type: 'death', targetId: 1, killerId: 0, placement: 5 });
      expect(zs.count).toBe(0);
    });
  });

  it('a telegraph creates a provisional circle that the following ultimateTarget replaces', () => {
    withDodge('mole', DODGE_FIXED, () => {
      const zs = new DangerZones();
      ingest(zs, { type: 'telegraph', fighterId: 1, kind: 'ultimate', pos: { x: 5, y: 0, z: 5 }, radius: 4, yaw: 0, arcDeg: 0, windup: 1 }, NOW, REACT, 0, () => 'mole');
      expect(zs.list[0]).toMatchObject({ ax: 5, az: 5, r: 4 });
      ingest(zs, targetEv({ to: { x: 9, y: 0, z: 9 }, width: 6 }));
      expect(zs.count).toBe(1);
      expect(zs.list[0]).toMatchObject({ ax: 9, az: 9, r: 3 });
    });
  });
});

describe('commit-mode reticle (ultimateStage protocol)', () => {
  it('stage 0 = tracking (not dodged), stage 1 = committed at pos, stage >= 2 = over', () => {
    withDodge('eagle', { mode: 'commit', commitS: 0.5 }, () => {
      const zs = new DangerZones();
      ingest(zs, targetEv({ animal: 'eagle', kind: 'lock', targetId: 0, to: { x: 10, y: 0, z: 22 }, width: 0, windup: 0.8 }));
      const z = zs.list[0];
      expect(z.committed).toBe(false);
      expect(zs.zonesAt(10, 22, NOW, 0.5)).toHaveLength(0); // tracking: not live
      expect(zs.insideAny(10, 22, 0.5, NOW)).toBe(false);

      // Reticle follows the victim.
      ingest(zs, { type: 'ultimateStage', fighterId: 1, animal: 'eagle', stage: 0, targetId: 0, pos: { x: 11, y: 0, z: 23 } }, NOW + 0.5);
      expect(zs.list[0]).toMatchObject({ ax: 11, az: 23, committed: false });

      // Commit: fixed at pos, live for commitS from the emission time.
      ingest(zs, { type: 'ultimateStage', fighterId: 1, animal: 'eagle', stage: 1, targetId: 0, pos: { x: 12, y: 0, z: 24 } }, NOW + 1.0);
      expect(zs.list[0]).toMatchObject({ ax: 12, az: 24, committed: true });
      expect(zs.insideAny(12, 24, 0.5, NOW + 1.0)).toBe(true);
      expect(zs.list[0].expiresAt).toBeCloseTo(NOW + 1.0 - REACT + 0.5, 9);
      zs.prune(NOW + 1.0 - REACT + 0.6);
      expect(zs.count).toBe(0);

      // Over-beat removes a live one.
      ingest(zs, targetEv({ animal: 'eagle', kind: 'lock', to: { x: 1, y: 0, z: 1 }, width: 0 }));
      ingest(zs, { type: 'ultimateStage', fighterId: 1, animal: 'eagle', stage: 2, targetId: 0, pos: { x: 1, y: 0, z: 1 } });
      expect(zs.count).toBe(0);
    });
  });

  it('stage beats do not touch fixed-mode zones', () => {
    withDodge('mole', DODGE_FIXED, () => {
      const zs = new DangerZones();
      ingest(zs, targetEv({ to: { x: 4, y: 0, z: 4 } }));
      ingest(zs, { type: 'ultimateStage', fighterId: 1, animal: 'mole', stage: 1, targetId: -1, pos: { x: 99, y: 0, z: 99 } });
      expect(zs.list[0]).toMatchObject({ ax: 4, az: 4 });
    });
  });
});

// ── queries ──────────────────────────────────────────────────────────────────

describe('registerZone / zonesAt / expiry', () => {
  it('registers by hand, queries with body padding and honours expiry', () => {
    const zs = new DangerZones();
    zs.registerZone({ key: 7, shape: 'circle', ax: 0, az: 0, r: 2, knownAt: 0, expiresAt: 3 });
    expect(zs.zonesAt(2.4, 0, 1, 0)).toHaveLength(0);
    expect(zs.zonesAt(2.4, 0, 1, 0.5)).toHaveLength(1); // body radius 0.5 overlaps the rim
    expect(zs.zonesAt(1, 0, 3.5, 0)).toHaveLength(0); // expired
    zs.registerZone({ key: 7, shape: 'circle', ax: 50, az: 0, r: 1, knownAt: 0, expiresAt: 3 }); // replaces
    expect(zs.count).toBe(1);
    expect(zs.zonesAt(1, 0, 1, 0)).toHaveLength(0);
    zs.removeZone(7);
    expect(zs.count).toBe(0);
  });
});

describe('nearestExit', () => {
  const PAD = 0.7;

  it('is false outside a zone, otherwise the shortest way out of a circle', () => {
    const zs = new DangerZones();
    zs.registerZone({ key: 1, shape: 'circle', ax: 10, az: 22, r: 2, knownAt: 0, expiresAt: 9 });
    const ex = makeExit();
    expect(zs.nearestExit(0, 0, PAD, 1, ex)).toBe(false);
    expect(zs.nearestExit(10.5, 22, PAD, 1, ex)).toBe(true);
    expect(ex.dx).toBeCloseTo(1, 9); // straight away from the centre (+X)
    expect(ex.dz).toBeCloseTo(0, 9);
    expect(ex.dist).toBeGreaterThan(2.2);
    expect(ex.dist).toBeLessThan(2.8);
    expect(zs.insideAny(ex.x, ex.z, PAD, 1)).toBe(false);
  });

  it('exits a capsule sideways, never along its axis', () => {
    const zs = new DangerZones();
    zs.registerZone({ key: 1, shape: 'capsule', ax: 10, az: 18, bx: 10, bz: 26, r: 1.5, knownAt: 0, expiresAt: 9 });
    const ex = makeExit();
    expect(zs.nearestExit(10.2, 22, PAD, 1, ex)).toBe(true);
    expect(ex.dx).toBeGreaterThan(0.9);
    expect(ex.dist).toBeGreaterThan(2);
    expect(ex.dist).toBeLessThan(2.6);
  });

  it('never exits into another live zone', () => {
    const zs = new DangerZones();
    zs.registerZone({ key: 1, shape: 'circle', ax: 10, az: 22, r: 2, knownAt: 0, expiresAt: 9 });
    zs.registerZone({ key: 2, shape: 'circle', ax: 14.5, az: 22, r: 2, knownAt: 0, expiresAt: 9 }); // right next to the +X exit
    const ex = makeExit();
    expect(zs.nearestExit(10.5, 22, PAD, 1, ex)).toBe(true);
    expect(zs.insideAny(ex.x, ex.z, PAD, 1)).toBe(false);
    expect(ex.dx).toBeLessThan(0.5); // did not run east into zone 2
    expect(ex.dist).toBeLessThan(5);
  });

  it('never exits onto an armed/active trap, but a spent plate is fine', () => {
    const zs = new DangerZones();
    zs.registerZone({ key: 1, shape: 'circle', ax: 10, az: 22, r: 2, knownAt: 0, expiresAt: 9 });
    const ex = makeExit();
    for (const phase of ['armed', 'active'] as const) {
      const t = trap(13.2, 22, phase);
      expect(zs.nearestExit(10.5, 22, PAD, 1, ex, [t])).toBe(true);
      expect(Math.hypot(ex.x - t.pos.x, ex.z - t.pos.z)).toBeGreaterThanOrEqual(t.radius + PAD + 0.3 - 1e-9);
      expect(ex.dist).toBeLessThan(5);
    }
    expect(zs.nearestExit(10.5, 22, PAD, 1, ex, [trap(13.2, 22, 'cooldown')])).toBe(true);
    expect(ex.dx).toBeCloseTo(1, 9);
  });

  it('never exits through the arena wall', () => {
    const zs = new DangerZones();
    zs.registerZone({ key: 1, shape: 'circle', ax: 0, az: 29, r: 2, knownAt: 0, expiresAt: 9 });
    const ex = makeExit();
    expect(zs.nearestExit(0, 27.5, PAD, 1, ex)).toBe(true);
    expect(ex.dz).toBeLessThan(0);
    expect(Math.hypot(ex.x, ex.z)).toBeLessThanOrEqual(30 - PAD);
  });
});

describe('avoidDangerZones (Apex: never walk into an active zone)', () => {
  it('a bot heading into a live zone never enters it; tracking / expired zones are ignored', () => {
    const zs = new DangerZones();
    const z = zs.registerZone({ key: 1, shape: 'circle', ax: 10, az: 26, r: 1.5, knownAt: 0, expiresAt: 100 });
    const PAD = 0.7;
    for (const startX of [10, 9.3, 10.8]) {
      let x = startX;
      let zc = 19;
      for (let i = 0; i < 120; i++) {
        const mv = { x: 0, z: 1 };
        avoidDangerZones(mv, x, zc, PAD, zs, 1);
        x += mv.x * 0.12;
        zc += mv.z * 0.12;
        expect(zoneDist(z, x, zc), `start ${startX} step ${i}`).toBeGreaterThan(PAD - 0.05);
      }
    }
    const straight = { x: 0, z: 1 };
    z.committed = false; // tracking reticle: not an active zone yet
    expect(avoidDangerZones(straight, 10, 22, PAD, zs, 1)).toBe(false);
    expect(straight).toEqual({ x: 0, z: 1 });
    z.committed = true;
    expect(avoidDangerZones({ x: 0, z: 1 }, 10, 22, PAD, zs, 200)).toBe(false); // expired
  });
});

// ── brain integration ────────────────────────────────────────────────────────

function fighter(id: number, animal: AnimalId, x: number, z: number, yaw: number): FighterState {
  return {
    id,
    animal,
    isPlayer: false,
    alive: true,
    pos: { x, y: 0, z },
    vel: { x: 0, y: 0, z: 0 },
    yaw,
    hp: 1000,
    maxHp: 1000,
    guard: 100,
    maxGuard: 100,
    guardRegenDelay: 0,
    ultCharge: 0,
    specialCd: 5,
    action: 'idle',
    actionT: 0,
    actionDur: 0,
    comboIndex: 0,
    comboWindow: 0,
    buffs: [],
    kills: 0,
    damageDealt: 0,
    damageBlocked: 0,
    ultsUsed: 0,
    grabTargetId: -1,
    grabbedById: -1,
    airborne: false,
    glideT: 0,
    burrowT: 0,
  };
}

// Lane x = -12 has no pillars/crates/columns; bot at z=-6, foe well ahead at z=+3.
function snapshot(time: number): WorldSnapshot {
  return {
    time,
    fighters: [fighter(0, 'lion', -12, -6, 0), fighter(1, 'mole', -12, 3, Math.PI)],
    pickups: [],
    crates: [],
    traps: [],
    bloodlustMult: 1,
    matchOver: false,
    winnerId: -1,
  };
}

/** Run a treatment manager (gets the zone event) against an identical control; return per-tick intents. */
function run(level: Difficulty, ticks: number, zoneEvent: GameEvent, eventTick: number): { treat: { z: number; x: number }[]; ctrl: { z: number; x: number }[]; releaseTick: number } {
  const seed = 9001;
  const busA = new EventBus();
  const busB = new EventBus();
  const treat = new BotManager(busA, level, seed);
  const ctrl = new BotManager(busB, level, seed);
  const outT: { z: number; x: number }[] = [];
  const outC: { z: number; x: number }[] = [];
  for (let t = 0; t < ticks; t++) {
    const snap = snapshot(5 + t * DT);
    treat.update(snap, DT);
    ctrl.update(snap, DT);
    const a = treat.getIntent(0);
    const b = ctrl.getIntent(0);
    outT.push({ x: a.moveX, z: a.moveZ });
    outC.push({ x: b.moveX, z: b.moveZ });
    if (t === eventTick - 1) busA.emit(zoneEvent);
  }
  const reactionTicks = Math.round(BOT_PROFILES[level].reactionMs / 1000 / DT);
  return { treat: outT, ctrl: outC, releaseTick: eventTick - 1 + reactionTicks };
}

const ZONE_EVENT_BIG = targetEv({ kind: 'ground', to: { x: -12, y: 0, z: -4.5 }, width: 6, windup: 3 }); // r=3 around the bot's front
const ZONE_EVENT_SMALL = targetEv({ kind: 'ground', to: { x: -12, y: 0, z: -4.5 }, width: 4, windup: 3 }); // r=2: exit ~1.4 m away

function differsFrom(a: { x: number; z: number }[], b: { x: number; z: number }[], from: number): number {
  for (let i = from; i < a.length; i++) if (Math.abs(a[i].x - b[i].x) > 1e-9 || Math.abs(a[i].z - b[i].z) > 1e-9) return i;
  return -1;
}

describe('brain: ultimate danger-zone dodging by difficulty', () => {
  const WARM = 30;

  it('L1 (Cub) never dodges — intents identical to a bot that never saw the zone', () => {
    withDodge('mole', DODGE_FIXED, () => {
      const r = run(1, 140, ZONE_EVENT_SMALL, WARM);
      expect(differsFrom(r.treat, r.ctrl, 0)).toBe(-1);
    });
  });

  it('nothing changes for any level while the ultimate has not opted in (placeholder specs)', () => {
    for (const level of [1, 2, 3, 4] as Difficulty[]) {
      const r = run(level, 140, ZONE_EVENT_BIG, WARM);
      expect(differsFrom(r.treat, r.ctrl, 0), `L${level}`).toBe(-1);
    }
  });

  for (const level of [3, 4] as Difficulty[]) {
    it(`L${level} steps out of a zone it stands in, but only after its reaction delay`, () => {
      withDodge('mole', DODGE_FIXED, () => {
        const r = run(level, 140, ZONE_EVENT_BIG, WARM);
        const first = differsFrom(r.treat, r.ctrl, 0);
        expect(first).toBeGreaterThanOrEqual(r.releaseTick);
        expect(first).toBeLessThanOrEqual(r.releaseTick + 12);
        // Away from the centre (-Z), not toward the foe waiting at +Z.
        expect(r.treat[first + 5].z).toBeLessThan(-0.5);
      });
    });
  }

  it('L2 (lazy) needs a second reaction time and an exit under 2 m: dodges the small zone late, ignores the big one', () => {
    withDodge('mole', DODGE_FIXED, () => {
      const react = Math.round(BOT_PROFILES[2].reactionMs / 1000 / DT); // 24 ticks
      const small = run(2, 200, ZONE_EVENT_SMALL, WARM);
      const first = differsFrom(small.treat, small.ctrl, 0);
      expect(first).toBeGreaterThanOrEqual(small.releaseTick + react - 1); // two reaction times after the emission
      expect(small.treat[first + 5].z).toBeLessThan(-0.5);
      const big = run(2, 200, ZONE_EVENT_BIG, WARM);
      expect(differsFrom(big.treat, big.ctrl, 0)).toBe(-1); // exit 2.6 m >= LAZY_MAX_EXIT_M
      expect(LAZY_MAX_EXIT_M).toBe(2);
    });
  });
});

// ── ultTargetValid ───────────────────────────────────────────────────────────

function situation(animal: AnimalId, lvl: Difficulty, over: Partial<Situation>): Situation {
  return {
    animal,
    profile: BOT_PROFILES[lvl],
    rng: mulberry32(1),
    now: 10,
    hpFrac: 1,
    guardFrac: 1,
    specialReady: false,
    ultReady: true,
    ultHeldS: 0,
    retreating: false,
    hasTarget: true,
    tdist: 3,
    tHpFrac: 1,
    tGuardFrac: 1,
    targetHelpless: false,
    targetRooted: false,
    targetBlocking: false,
    targetCommitted: false,
    targetFleeing: false,
    targetIsolated: false,
    nearestEnemyDist: 3,
    enemiesNearSelf5: 1,
    enemiesNearSelf8: 1,
    enemiesNearTarget8: 1,
    wallBehindTarget: false,
    recentFinisher: false,
    aimYawToTarget: 0,
    aimYawAway: Math.PI,
    aimYawNearest: 0,
    ...over,
  };
}

function wantsUlt(s: Situation): boolean {
  const out: AbilityWish = { special: false, ult: false, aimYaw: 0 };
  decideAbilities(s, out);
  return out.ult;
}

describe('ultTargetValid: bots never cast into a fizzle', () => {
  it('decideUltimate is blocked by ultTargetValid === false at every level, unchanged when true/undefined', () => {
    for (const level of [1, 2, 3, 4] as Difficulty[]) {
      for (const animal of ANIMAL_IDS) {
        // A situation each level's script casts in: melee range, target helpless + blocking, isolated.
        const base = { tdist: 3, targetHelpless: true, targetBlocking: true, targetIsolated: true, recentFinisher: true, ultHeldS: 20, tHpFrac: 0.3, enemiesNearSelf5: 1, enemiesNearSelf8: 1 };
        const open = wantsUlt(situation(animal, level, base));
        expect(wantsUlt(situation(animal, level, { ...base, ultTargetValid: true })), `${animal} L${level}`).toBe(open);
        expect(wantsUlt(situation(animal, level, { ...base, ultTargetValid: undefined })), `${animal} L${level}`).toBe(open);
        expect(wantsUlt(situation(animal, level, { ...base, ultTargetValid: false })), `${animal} L${level}`).toBe(false);
      }
    }
  });

  it('a brain with a requireTarget lock ultimate fires only when the sim would find a target (test-only spec)', () => {
    const tg = ANIMALS.lion.ultimate.targeting!;
    const saved = { ...tg };
    // Foe distance d ahead of the bot; helpless so Apex takes any in-range window (lion gate: tdist <= 7).
    const fires = (d: number): boolean => {
      const bus = new EventBus();
      const bots = new BotManager(bus, 4, 77);
      for (let t = 0; t < 240; t++) {
        const snap = snapshot(5 + t * DT);
        snap.fighters[0] = fighter(0, 'lion', -12, -6, 0);
        snap.fighters[0].ultCharge = 100;
        snap.fighters[1] = fighter(1, 'gorilla', -12, -6 + d, Math.PI);
        snap.fighters[1].action = 'stagger';
        bots.update(snap, DT);
        if (bots.getIntent(0).ultimate) return true;
      }
      return false;
    };
    try {
      // Today's spec (no requireTarget): fires at 5 m (unchanged behaviour).
      expect(fires(5)).toBe(true);
      // Lock spec with a 3 m reach: the 5 m foe is not lockable, so the bot must not press Q...
      Object.assign(tg, { kind: 'lock', range: 3, requireTarget: true });
      expect(fires(5)).toBe(false);
      // ...but does cast when the foe is inside the lock range.
      expect(fires(2)).toBe(true);
    } finally {
      for (const k of Object.keys(tg)) delete (tg as unknown as Record<string, unknown>)[k];
      Object.assign(tg, saved);
    }
  });
});
