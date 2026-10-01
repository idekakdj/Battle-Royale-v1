import { describe, it, expect } from 'vitest';
import { liveWorld, makeFighter, makeSim, neutral, disablePickups, DT } from '../helpers';
import { ANIMALS } from '../../../src/config/animals';
import type { AnimalDef } from '../../../src/config/animals';
import type { AnimalId, GameEvent, GameEventOf, UltTargetKind } from '../../../src/core/types';
import type { World } from '../../../src/sim/World';
import type { Fighter } from '../../../src/sim/Fighter';
import { ULTIMATES, startUlt } from '../../../src/sim/ultimates';
import type { UltimateImpl } from '../../../src/sim/ultimates';
import { blink, emitUltimateStage, emitCastEvents, emitUltimateTarget, toRecovery } from '../../../src/sim/ultimates/common';
import { PILLARS, WALL_RADIUS } from '../../../src/config/arena';
import { LION_T_LAND } from '../../../src/config/ultimates/lion';

const ANIMAL_LIST = Object.keys(ANIMALS) as AnimalId[];

/** Give a fighter a private copy of its def with a test-only ultimate spec (the shared ANIMALS stay untouched). */
function withUltSpec(f: Fighter, patch: Partial<AnimalDef['ultimate']>): void {
  const def: AnimalDef = { ...f.def, ultimate: { ...f.def.ultimate, ...patch } };
  (f as unknown as { def: AnimalDef }).def = def;
}

function ofType<T extends GameEvent['type']>(events: GameEvent[], type: T): GameEventOf<T>[] {
  return events.filter((e): e is GameEventOf<T> => e.type === type);
}

interface Fx {
  world: World;
  events: GameEvent[];
  c: Fighter;
  t: Fighter;
}

function fixture(caster: AnimalId, target: AnimalId, targetDist: number, targetDeg = 0): Fx {
  const events: GameEvent[] = [];
  const { world } = liveWorld([caster, target], 7, events);
  disablePickups(world);
  const c = world.fighters[0];
  const t = world.fighters[1];
  c.state.pos = { x: 0, y: 0, z: 0 };
  c.state.yaw = 0;
  c.state.vel = { x: 0, y: 0, z: 0 };
  const a = (targetDeg * Math.PI) / 180;
  t.state.pos = { x: Math.sin(a) * targetDist, y: 0, z: Math.cos(a) * targetDist };
  t.state.yaw = Math.PI;
  t.state.vel = { x: 0, y: 0, z: 0 };
  return { world, events, c, t };
}

function pressUlt(fx: Fx, aimYaw = 0): void {
  fx.c.state.ultCharge = 100;
  const press = neutral();
  press.ultimate = true;
  press.aimYaw = aimYaw;
  fx.world.setIntent(fx.c.id, press);
  fx.world.setIntent(fx.t.id, neutral());
  fx.world.step(DT);
}

function idle(fx: Fx, steps: number, aimYaw = 0): void {
  for (let i = 0; i < steps; i++) {
    const n = neutral();
    n.aimYaw = aimYaw;
    fx.world.setIntent(fx.c.id, n);
    fx.world.setIntent(fx.t.id, neutral());
    fx.world.step(DT);
  }
}

describe('fizzle rule (requireTarget)', () => {
  it('no valid target: no cast, charge NOT spent, ultimateFizzle emitted', () => {
    const fx = fixture('hippo', 'hippo', 30); // far outside the 12 m lock range
    withUltSpec(fx.c, { targeting: { kind: 'lock', range: 12, requireTarget: true } });
    pressUlt(fx);
    expect(fx.c.state.ultCharge).toBe(100);
    expect(fx.c.state.ultsUsed).toBe(0);
    expect(fx.c.ability).toBeNull();
    expect(fx.c.state.action).not.toBe('ultimate');
    expect(ofType(fx.events, 'ultimateFizzle')).toEqual([{ type: 'ultimateFizzle', fighterId: 0, reason: 'noTarget' }]);
    expect(ofType(fx.events, 'ultimate')).toHaveLength(0);
    expect(ofType(fx.events, 'telegraph')).toHaveLength(0);
    expect(ofType(fx.events, 'ultimateTarget')).toHaveLength(0);
    // Not casting => the optional snapshot fields stay absent.
    const st = fx.world.snapshot().fighters[0];
    expect(st.ultPhase).toBeUndefined();
    expect(st.ultStage).toBeUndefined();
    expect(st.ultTargetId).toBeUndefined();
  });

  it('startUlt reports the fizzle (false) and spends nothing; a valid target then casts normally', () => {
    const fx = fixture('hippo', 'hippo', 30);
    withUltSpec(fx.c, { targeting: { kind: 'lock', range: 12, requireTarget: true } });
    fx.c.state.ultCharge = 100;
    fx.c.intent.aimYaw = 0;
    expect(startUlt(fx.world, fx.c)).toBe(false);
    expect(fx.c.state.ultCharge).toBe(100);
    // A foe walks into the cone: same charge, cast starts and locks it.
    fx.t.state.pos = { x: 0, y: 0, z: 9 };
    expect(startUlt(fx.world, fx.c)).toBe(true);
    expect(fx.c.state.ultCharge).toBe(0);
    expect(fx.c.state.ultsUsed).toBe(1);
    expect(fx.c.ability).not.toBeNull();
    expect(fx.c.ability!.lockId).toBe(1);
  });

  it('lock target outside the aim cone / untargetable / airborne still fizzles', () => {
    for (const setup of [
      (fx: Fx) => (fx.t.state.pos = { x: 9, y: 0, z: 0 }), // 90° off the aim
      (fx: Fx) => (fx.t.untargetable = true),
      (fx: Fx) => (fx.t.state.pos = { x: 0, y: 4, z: 8 }), // above ground reach
    ]) {
      const fx = fixture('hippo', 'hippo', 8);
      withUltSpec(fx.c, { targeting: { kind: 'lock', range: 12, requireTarget: true } });
      setup(fx);
      pressUlt(fx);
      expect(ofType(fx.events, 'ultimateFizzle')).toHaveLength(1);
      expect(fx.c.state.ultCharge).toBe(100);
    }
  });

  it('hitsAir lets the lock reach a flier', () => {
    const fx = fixture('hippo', 'hippo', 8);
    withUltSpec(fx.c, { targeting: { kind: 'lock', range: 12, requireTarget: true, hitsAir: true } });
    fx.t.state.pos = { x: 0, y: 4, z: 8 };
    pressUlt(fx);
    expect(ofType(fx.events, 'ultimateFizzle')).toHaveLength(0);
    expect(fx.c.state.ultCharge).toBe(0);
  });

  it('a fizzled press does not eat the same tick: an edge special still fires', () => {
    const fx = fixture('hippo', 'hippo', 30);
    withUltSpec(fx.c, { targeting: { kind: 'lock', range: 12, requireTarget: true } });
    fx.c.state.ultCharge = 100;
    fx.c.state.specialCd = 0;
    const both = neutral();
    both.ultimate = true;
    both.special = true;
    fx.world.setIntent(0, both);
    fx.world.setIntent(1, neutral());
    fx.world.step(DT);
    expect(ofType(fx.events, 'ultimateFizzle')).toHaveLength(1);
    expect(fx.c.ability).not.toBeNull();
    expect(fx.c.ability!.kind).toBe('special');
  });

  it('ultimates without requireTarget never fizzle (even with nobody around); requireTarget ones fizzle and spend nothing', () => {
    for (const animal of ANIMAL_LIST) {
      const fx = fixture(animal, 'hippo', 30);
      pressUlt(fx);
      if (ANIMALS[animal].ultimate.targeting?.requireTarget === true) {
        expect(ofType(fx.events, 'ultimateFizzle'), animal).toHaveLength(1);
        expect(fx.c.state.ultCharge, animal).toBe(100);
      } else {
        expect(ofType(fx.events, 'ultimateFizzle'), animal).toHaveLength(0);
        expect(fx.c.state.ultCharge, animal).toBe(0);
      }
    }
  });
});

describe('ultimateTarget event for the placeholder ultimates', () => {
  const kinds: Record<AnimalId, UltTargetKind> = {
    lion: 'lock', // v1.3 phase 2 (Royal Hunt locks a victim)
    gorilla: 'line', // v1.3 phase 2 (Boulder Hurl is a lock-assisted line)
    crocodile: 'lock', // v1.3 phase 2 (Death Roll locks a victim)
    hippo: 'line', // v1.3 phase 2 (Riverlord's Flood: 11 m x 3.4 m path)
    rhino: 'line', // v1.3 phase 2 (Seismic Stampede: lock-assisted homing charge)
    eagle: 'lock', // v1.3 phase 2 (Death From Above locks a victim)
    panther: 'lock', // v1.3 phase 2 (Shadow Execution locks a victim)
    python: 'lock', // v1.3 phase 2 (Coil Snare locks a victim)
    giraffe: 'lock', // v1.3 phase 2 (Timber Fall locks a victim)
    mole: 'ground',
  };
  for (const animal of ANIMAL_LIST) {
    it(`${animal}: emitted once at cast start with kind ${kinds[animal]}`, () => {
      const fx = fixture(animal, 'hippo', 5);
      pressUlt(fx);
      const evs = ofType(fx.events, 'ultimateTarget');
      expect(evs).toHaveLength(1);
      const e = evs[0];
      const spec = ANIMALS[animal].ultimate;
      expect(e.fighterId).toBe(0);
      expect(e.animal).toBe(animal);
      expect(e.kind).toBe(kinds[animal]);
      expect(e.from).toMatchObject({ x: 0, z: 0 });
      expect(e.range).toBe(spec.targeting!.range);
      // `windup` = the lead time until the hit lands (eagle: soar; lion: coil + pounce flight = LION_T_LAND).
      expect(e.windup).toBeCloseTo(animal === 'eagle' ? spec.untargetableT! : animal === 'lion' ? LION_T_LAND : spec.windup, 9);
      expect(Number.isFinite(e.to.x) && Number.isFinite(e.to.z) && Number.isFinite(e.width)).toBe(true);
      // Ordering: the telegraph/ultimate events come first, ultimateTarget right after.
      const types = fx.events.map((x) => x.type);
      expect(types.indexOf('ultimateTarget')).toBeGreaterThan(types.indexOf('ultimate'));
    });
  }

  it('ground kinds report the aimed (snapped) point; line kinds run along the aim', () => {
    const mole = fixture('mole', 'hippo', 5);
    pressUlt(mole);
    const g = ofType(mole.events, 'ultimateTarget')[0];
    expect(g.to.z).toBeCloseTo(5, 6); // snapped onto the foe on the line
    expect(g.to.x).toBeCloseTo(0, 6);
    expect(g.width).toBe(9); // Sinkhole Vortex radius 4.5 × 2
    // Lock kinds (crocodile Death Roll, python Coil Snare) report the locked victim's point and no width.
    const croc = fixture('crocodile', 'hippo', 5);
    pressUlt(croc);
    const l = ofType(croc.events, 'ultimateTarget')[0];
    expect(l.kind).toBe('lock');
    expect(l.targetId).toBe(1);
    expect(l.to.x).toBeCloseTo(0, 6);
    expect(l.to.z).toBeCloseTo(5, 6);
    expect(l.width).toBe(0);
  });
});

describe('snapshot ultPhase / ultStage / ultTargetId', () => {
  it('walks windup -> active -> (gone) for a running ultimate and is absent otherwise', () => {
    const fx = fixture('rhino', 'hippo', 20, 180); // foe behind the charge: nobody to hit
    const before = fx.world.snapshot().fighters[0];
    expect(before.ultPhase).toBeUndefined();
    expect('ultPhase' in before).toBe(false);
    pressUlt(fx);
    const s0 = fx.world.snapshot().fighters[0];
    expect(s0.action).toBe('ultimate');
    expect(s0.ultPhase).toBe('windup');
    expect(s0.ultStage).toBe(0);
    expect(s0.ultTargetId).toBe(-1);
    idle(fx, 60); // the 0.8 s paw windup (v1.3 Seismic Stampede) has elapsed
    const s1 = fx.world.snapshot().fighters[0];
    expect(s1.ultPhase).toBe('active');
    // The other fighter never shows the fields.
    expect(fx.world.snapshot().fighters[1].ultPhase).toBeUndefined();
    idle(fx, 400);
    const s2 = fx.world.snapshot().fighters[0];
    expect(s2.ultPhase).toBeUndefined();
    expect(fx.c.ability).toBeNull();
  });

  it('reports recovery and the grabbed victim as ultTargetId (crocodile)', () => {
    const fx = fixture('crocodile', 'hippo', 3);
    pressUlt(fx);
    let sawTarget = false;
    let sawRecovery = false;
    for (let i = 0; i < 260; i++) {
      idle(fx, 1);
      const st = fx.world.snapshot().fighters[0];
      if (st.ultPhase === 'active' && st.ultTargetId === 1) sawTarget = true;
      if (st.ultPhase === 'recovery') sawRecovery = true;
    }
    expect(sawTarget).toBe(true);
    expect(sawRecovery).toBe(true);
  });

  it('a lock ultimate reports its locked victim during the windup', () => {
    const fx = fixture('hippo', 'hippo', 6);
    withUltSpec(fx.c, { targeting: { kind: 'lock', range: 12 } });
    pressUlt(fx);
    const st = fx.world.snapshot().fighters[0];
    expect(st.ultPhase).toBe('windup');
    expect(st.ultTargetId).toBe(1);
    const te = ofType(fx.events, 'ultimateTarget')[0];
    expect(te.kind).toBe('lock');
    expect(te.targetId).toBe(1);
    expect(te.to.z).toBeCloseTo(6, 6);
  });
});

describe('ultimateStage helper + registry hook points (test-only ultimate)', () => {
  it('emits ultimateStage, updates rt.stage / snapshot ultStage, honours windupDuration/recoveryDuration/abort', () => {
    const original = ULTIMATES.lion;
    const log: string[] = [];
    let ticks = 0;
    const impl: UltimateImpl = {
      start(sim, f, rt, target) {
        emitCastEvents(sim, f, rt, f.state.pos.x, f.state.pos.z, 2, 360, 0.2);
        emitUltimateTarget(sim, f, rt, target, 0.2);
      },
      windupDuration: () => 0.2,
      activate(sim, f, rt) {
        log.push('activate');
        emitUltimateStage(sim, f, rt, 0, { x: 1, y: 0, z: 2 });
      },
      activeTick(sim, f, rt) {
        ticks++;
        if (ticks === 5) emitUltimateStage(sim, f, rt, 1);
        if (ticks === 10) {
          emitUltimateStage(sim, f, rt, 2);
          toRecovery(rt);
        }
      },
      recoveryDuration: () => 0.1,
      abort() {
        log.push('abort');
      },
    };
    (ULTIMATES as Record<AnimalId, UltimateImpl>).lion = impl;
    try {
      const fx = fixture('lion', 'hippo', 30);
      withUltSpec(fx.c, { targeting: undefined }); // the swapped-in test impl needs no target (the real lion's is a lock)
      pressUlt(fx);
      const stages: number[] = [];
      const snapStages: (number | undefined)[] = [];
      for (let i = 0; i < 60; i++) {
        idle(fx, 1);
        snapStages.push(fx.world.snapshot().fighters[0].ultStage);
      }
      for (const e of ofType(fx.events, 'ultimateStage')) stages.push(e.stage);
      expect(stages).toEqual([0, 1, 2]);
      const first = ofType(fx.events, 'ultimateStage')[0];
      expect(first).toMatchObject({ fighterId: 0, animal: 'lion', targetId: -1, pos: { x: 1, y: 0, z: 2 } });
      // The snapshot mirrored the beats while casting, and the runtime ended after the 0.1 s recovery.
      expect(snapStages).toContain(1);
      expect(snapStages).toContain(2);
      expect(fx.c.ability).toBeNull();
      expect(log).toEqual(['activate']);

      // abort() runs if the caster dies mid-ultimate.
      const fy = fixture('lion', 'hippo', 30);
      withUltSpec(fy.c, { targeting: undefined });
      pressUlt(fy);
      idle(fy, 20);
      expect(fy.c.ability).not.toBeNull();
      fy.c.state.hp = 0;
      idle(fy, 1);
      expect(log).toEqual(['activate', 'activate', 'abort']);
      expect(fy.c.state.alive).toBe(false);
      expect(fy.c.ability).toBeNull();
    } finally {
      (ULTIMATES as Record<AnimalId, UltimateImpl>).lion = original;
    }
  });

  it('the registry has one implementation per animal', () => {
    for (const animal of ANIMAL_LIST) {
      expect(ULTIMATES[animal], animal).toBeDefined();
      expect(typeof ULTIMATES[animal].start).toBe('function');
      expect(typeof ULTIMATES[animal].activate).toBe('function');
    }
  });
});

describe('blink helper', () => {
  it('relocates instantly, emits a blink event with from/to and clears motion', () => {
    const events: GameEvent[] = [];
    const f = makeFighter(0, 'panther', 2, 3, 0);
    f.state.vel = { x: 4, y: 0, z: 4 };
    f.knockVX = 3;
    f.knockTimer = 0.2;
    const sim = makeSim([f], events);
    blink(sim, f, -6, 8, { yaw: 1.25 });
    expect(f.state.pos.x).toBeCloseTo(-6, 9);
    expect(f.state.pos.z).toBeCloseTo(8, 9);
    expect(f.state.yaw).toBe(1.25);
    expect(f.state.vel.x).toBe(0);
    expect(f.knockTimer).toBe(0);
    const evs = ofType(events, 'blink');
    expect(evs).toHaveLength(1);
    expect(evs[0].fighterId).toBe(0);
    expect(evs[0].from).toEqual({ x: 2, y: 0, z: 3 });
    expect(evs[0].to).toEqual({ x: -6, y: 0, z: 8 });
  });

  it('keeps the arena wall and solid obstacles honoured', () => {
    const events: GameEvent[] = [];
    const f = makeFighter(0, 'panther', 0, 0, 0);
    const sim = makeSim([f], events, PILLARS);
    blink(sim, f, 100, 0);
    expect(Math.hypot(f.state.pos.x, f.state.pos.z)).toBeLessThanOrEqual(WALL_RADIUS - f.def.radius + 1e-9);
    const pillar = PILLARS[0];
    blink(sim, f, pillar.x, pillar.z);
    const d = Math.hypot(f.state.pos.x - pillar.x, f.state.pos.z - pillar.z);
    expect(d).toBeGreaterThanOrEqual(pillar.radius + f.def.radius - 1e-6);
    // `to` reports the resolved spot, not the request.
    const last = ofType(events, 'blink')[1];
    expect(last.to.x).toBeCloseTo(f.state.pos.x, 9);
    expect(last.to.z).toBeCloseTo(f.state.pos.z, 9);
  });

  it('preserves altitude above the ground (airborne blinks stay airborne)', () => {
    const events: GameEvent[] = [];
    const f = makeFighter(0, 'eagle', 10, 10, 0);
    f.state.pos.y = 1.6;
    const sim = makeSim([f], events);
    blink(sim, f, 12, 5);
    expect(f.state.pos.y).toBeCloseTo(1.6, 9);
  });
});
