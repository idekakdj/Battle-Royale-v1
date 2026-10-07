import { describe, it, expect } from 'vitest';
import { liveWorld, neutral, disablePickups, DT } from '../helpers';
import { ANIMALS } from '../../../src/config/animals';
import { PYTHON, PYTHON_STAGE } from '../../../src/config/ultimates/python';
import { PILLARS } from '../../../src/config/arena';
import type { AnimalId, GameEvent, GameEventOf } from '../../../src/core/types';
import type { World } from '../../../src/sim/World';
import type { Fighter } from '../../../src/sim/Fighter';
import { dealDamage } from '../../../src/sim/CombatSystem';
import { groundHeightAt } from '../../../src/sim/MovementSystem';
import { pythonUltScript } from '../../../src/ai/ultScripts/python';

const SPEC = ANIMALS.python.ultimate;
const HP0 = ANIMALS.hippo.hp;

interface Fx {
  world: World;
  events: GameEvent[];
  c: Fighter;
  t: Fighter;
}

function ofType<T extends GameEvent['type']>(events: GameEvent[], type: T): GameEventOf<T>[] {
  return events.filter((e): e is GameEventOf<T> => e.type === type);
}

/** `bystander` adds a third fighter parked far away so a death does not end the match (the sim freezes on matchOver). */
function fixture(targetDist: number, targetDeg = 0, victim: AnimalId = 'hippo', seed = 7, bystander = false): Fx {
  const events: GameEvent[] = [];
  const { world } = liveWorld(bystander ? ['python', victim, 'lion'] : ['python', victim], seed, events);
  disablePickups(world);
  const c = world.fighters[0];
  const t = world.fighters[1];
  if (bystander) world.fighters[2].state.pos = { x: -22, y: 0, z: -3 };
  c.state.pos = { x: 0, y: 0, z: 0 };
  c.state.yaw = 0;
  const a = (targetDeg * Math.PI) / 180;
  t.state.pos = { x: Math.sin(a) * targetDist, y: 0, z: Math.cos(a) * targetDist };
  t.state.yaw = Math.PI;
  return { world, events, c, t };
}

function step(fx: Fx, n: number, hook?: (i: number) => void): void {
  for (let i = 0; i < n; i++) {
    if (hook !== undefined) hook(i);
    fx.world.setIntent(fx.c.id, neutral());
    fx.world.setIntent(fx.t.id, neutral());
    fx.world.step(DT);
  }
}

function cast(fx: Fx, aimYaw = 0): void {
  fx.c.state.ultCharge = 100;
  const press = neutral();
  press.ultimate = true;
  press.aimYaw = aimYaw;
  fx.world.setIntent(fx.c.id, press);
  fx.world.setIntent(fx.t.id, neutral());
  fx.world.step(DT);
}

const stages = (fx: Fx): number[] => ofType(fx.events, 'ultimateStage').map((e) => e.stage);

function untilDone(fx: Fx, max = 800): number {
  let n = 0;
  while (fx.c.ability !== null && n < max) {
    step(fx, 1);
    n++;
  }
  return n;
}

describe('python Coil Snare — config / targeting / fizzle', () => {
  it('is a lock ultimate: 9 m, 60° cone, requireTarget, dodge opt-in, new name', () => {
    expect(SPEC.name).toBe('Coil Snare');
    expect(SPEC.description).toMatch(/tether/i);
    const tg = SPEC.targeting!;
    expect(tg.kind).toBe('lock');
    expect(tg.range).toBe(9);
    expect(tg.coneDeg).toBe(60);
    expect(tg.requireTarget).toBe(true);
    expect(tg.dodge?.mode).toBe('fixed');
    expect(SPEC.damageReduction).toBe(0.3);
  });

  it('fizzles (charge kept, no cast) with nobody in the cone, out of range, or airborne', () => {
    const cases: [string, (fx: Fx) => void][] = [
      ['out of range', (fx) => (fx.t.state.pos = { x: 0, y: 0, z: 14 })],
      ['outside the 60° cone', (fx) => (fx.t.state.pos = { x: 6, y: 0, z: 3 })],
      ['airborne', (fx) => (fx.t.state.pos = { x: 0, y: 4, z: 6 })],
    ];
    for (const [name, setup] of cases) {
      const fx = fixture(6);
      setup(fx);
      cast(fx);
      expect(ofType(fx.events, 'ultimateFizzle'), name).toHaveLength(1);
      expect(fx.c.state.ultCharge, name).toBe(100);
      expect(fx.c.ability, name).toBeNull();
    }
  });

  it('casts on a target 9 m away: lock event, 0.6 s windup', () => {
    const fx = fixture(8.5);
    cast(fx);
    const te = ofType(fx.events, 'ultimateTarget');
    expect(te).toHaveLength(1);
    expect(te[0]).toMatchObject({ kind: 'lock', targetId: 1, windup: 0.6, range: 9 });
    const snap = fx.world.snapshot().fighters[0];
    expect(snap.ultPhase).toBe('windup');
    expect(snap.ultTargetId).toBe(1);
  });

  it('the bot script is a ranged (Veteran window) lock ult that likes runners and helpless foes', () => {
    expect(pythonUltScript.ranged).toBe(true);
    const base = { tdist: 6, targetFleeing: false, targetHelpless: false, targetRooted: false, targetBlocking: false, targetCommitted: false, tHpFrac: 0.9 };
    expect(pythonUltScript.gate({ ...base } as never)).toBe(true);
    expect(pythonUltScript.gate({ ...base, tdist: 9.2 } as never)).toBe(false);
    const out = { special: false, ult: false, aimYaw: 0 };
    pythonUltScript.apex({ ...base } as never, out);
    expect(out.ult).toBe(false);
    pythonUltScript.apex({ ...base, targetFleeing: true } as never, out);
    expect(out.ult).toBe(true);
  });
});

describe('python Coil Snare — tether, yank, bind, crush', () => {
  it('runs the full beat sequence: commit, lash, snare, 4 wrap pulses, crush', () => {
    const fx = fixture(7);
    cast(fx);
    untilDone(fx);
    expect(stages(fx)).toEqual([
      PYTHON_STAGE.COMMIT,
      PYTHON_STAGE.LASH,
      PYTHON_STAGE.SNARE,
      PYTHON_STAGE.WRAP1,
      PYTHON_STAGE.WRAP2,
      PYTHON_STAGE.WRAP3,
      PYTHON_STAGE.WRAP4,
      PYTHON_STAGE.CRUSH,
    ]);
    expect(fx.c.ability).toBeNull();
    expect(fx.c.incomingDamageReduction).toBe(0);
    expect(fx.c.state.grabTargetId).toBe(-1);
    expect(fx.t.state.grabbedById).toBe(-1);
  });

  it('the tether flies in about 0.3 s (fast, but not instant)', () => {
    const fx = fixture(8);
    cast(fx);
    let lashAt = -1;
    let snareAt = -1;
    for (let i = 0; i < 200 && snareAt < 0; i++) {
      step(fx, 1);
      const ev = ofType(fx.events, 'ultimateStage');
      if (lashAt < 0 && ev.some((e) => e.stage === PYTHON_STAGE.LASH)) lashAt = i;
      if (snareAt < 0 && ev.some((e) => e.stage === PYTHON_STAGE.SNARE)) snareAt = i;
    }
    expect(snareAt).toBeGreaterThan(lashAt);
    const flight = (snareAt - lashAt) * DT;
    expect(flight).toBeGreaterThan(0.12);
    expect(flight).toBeLessThan(0.36);
  });

  it('yanks the victim ALL the way in: a 8 m victim is pulled 5+ m to the python and held there', () => {
    const fx = fixture(8);
    cast(fx);
    let at: { x: number; z: number } | null = null;
    for (let i = 0; i < 300 && at === null; i++) {
      step(fx, 1);
      if (stages(fx).includes(PYTHON_STAGE.WRAP1)) at = { x: fx.t.state.pos.x, z: fx.t.state.pos.z };
    }
    expect(at).not.toBeNull();
    const dist = Math.hypot(at!.x - fx.c.state.pos.x, at!.z - fx.c.state.pos.z);
    const expected = fx.c.def.radius + fx.t.def.radius + PYTHON.bindGap;
    expect(dist).toBeCloseTo(expected, 1);
    expect(8 - dist).toBeGreaterThan(5); // pulled more than 5 m
  });

  it('holds + stuns the victim during the bind, python takes 30% less, victim goes nowhere', () => {
    const fx = fixture(6);
    cast(fx);
    for (let i = 0; i < 300 && !stages(fx).includes(PYTHON_STAGE.WRAP2); i++) step(fx, 1);
    const x0 = fx.t.state.pos.x;
    const z0 = fx.t.state.pos.z;
    expect(fx.t.state.grabbedById).toBe(0);
    expect(fx.c.incomingDamageReduction).toBe(0.3);
    for (let i = 0; i < 60; i++) {
      step(fx, 1);
      expect(fx.t.state.action).toBe('grabbed');
      expect(fx.t.staggerTimer).toBeGreaterThan(0);
      expect(fx.t.movementOwned).toBe(true);
      expect(fx.t.state.pos.x).toBeCloseTo(x0, 6);
      expect(fx.t.state.pos.z).toBeCloseTo(z0, 6);
      expect(fx.world.snapshot().fighters[0].ultTargetId).toBe(1);
    }
  });

  it('deals ~260 total (snare + unblockable squeeze + crush), block or not', () => {
    for (const block of [false, true]) {
      const fx = fixture(6);
      fx.t.state.guard = 10000;
      cast(fx);
      step(fx, 1400, () => {
        if (block && fx.t.state.grabbedById === -1 && fx.t.ability === null) fx.t.blocking = true;
      });
      const dealt = HP0 - fx.t.state.hp;
      expect(dealt, `block=${block}`).toBeGreaterThan(SPEC.damage! - 12);
      expect(dealt, `block=${block}`).toBeLessThan(SPEC.damage! + 12);
    }
  });

  it('halves... 30%: damage taken by the python is reduced only while it holds someone', () => {
    const fx = fixture(6);
    const probe = (): number => {
      const hp = fx.c.state.hp;
      dealDamage(fx.world, fx.t, fx.c, 100, { blockable: false, heavy: true, reaction: 'none', isBasic: false, allowBackstab: false });
      return hp - fx.c.state.hp;
    };
    const before = probe();
    cast(fx);
    for (let i = 0; i < 300 && !stages(fx).includes(PYTHON_STAGE.WRAP1); i++) step(fx, 1);
    const during = probe();
    expect(during).toBeCloseTo(before * 0.7, 5);
    untilDone(fx);
    fx.c.state.hp = ANIMALS.python.hp;
    expect(probe()).toBeCloseTo(before, 5);
  });

  it('ends with the crush and a short stagger on the released victim', () => {
    const fx = fixture(6);
    cast(fx);
    for (let i = 0; i < 700 && !stages(fx).includes(PYTHON_STAGE.CRUSH); i++) step(fx, 1);
    expect(stages(fx).at(-1)).toBe(PYTHON_STAGE.CRUSH);
    expect(fx.t.state.grabbedById).toBe(-1);
    expect(fx.t.staggerTimer).toBeGreaterThan(0);
    expect(fx.t.staggerTimer).toBeLessThanOrEqual(PYTHON.crushStagger);
    expect(fx.c.ability!.phase).toBeDefined();
    expect(fx.world.snapshot().fighters[0].ultPhase).toBe('recovery');
  });
});

describe('python Coil Snare — dodging and blocking the tether', () => {
  it('a target that leaves the tether line before it lands escapes (whiff, no damage)', () => {
    const fx = fixture(8);
    cast(fx);
    let lashed = false;
    step(fx, 400, () => {
      if (stages(fx).includes(PYTHON_STAGE.LASH)) lashed = true;
      if (lashed && fx.c.ability !== null) fx.t.state.pos.x += 8 * DT; // strafing at ~8 m/s
    });
    expect(stages(fx)).toContain(PYTHON_STAGE.WHIFF);
    expect(stages(fx)).not.toContain(PYTHON_STAGE.SNARE);
    expect(fx.t.state.hp).toBe(HP0);
    expect(fx.t.state.grabbedById).toBe(-1);
    expect(fx.c.ability).toBeNull();
  });

  it('stepping off the line after the aim commits works too; recovery ~0.85 s in total after the lash', () => {
    const fx = fixture(6);
    cast(fx);
    let done = -1;
    let whiffAt = -1;
    for (let i = 0; i < 400 && done < 0; i++) {
      step(fx, 1);
      if (whiffAt < 0 && stages(fx).includes(PYTHON_STAGE.COMMIT) && !stages(fx).includes(PYTHON_STAGE.LASH)) {
        fx.t.state.pos = { x: 5, y: 0, z: 6 };
      }
      if (whiffAt < 0 && stages(fx).includes(PYTHON_STAGE.WHIFF)) whiffAt = i;
      if (fx.c.ability === null) done = i;
    }
    expect(whiffAt).toBeGreaterThan(0);
    const after = (done - whiffAt) * DT;
    expect(after).toBeGreaterThan(0.75);
    expect(after).toBeLessThan(1.1);
  });

  it('a foe jumping the tether (above the hop clearance) is missed', () => {
    const fx = fixture(6);
    cast(fx);
    step(fx, 400, () => {
      fx.t.state.pos.y = 1.0;
      fx.t.state.airborne = true;
      fx.t.state.vel.y = 0;
    });
    expect(stages(fx)).toContain(PYTHON_STAGE.WHIFF);
    expect(stages(fx)).not.toContain(PYTHON_STAGE.SNARE);
    expect(fx.t.state.hp).toBe(HP0);
  });

  it('a pillar between the python and the victim blocks the tether', () => {
    const p = PILLARS[0];
    const len = Math.hypot(p.x, p.z);
    const ux = p.x / len;
    const uz = p.z / len;
    const fx = fixture(8);
    fx.c.state.pos = { x: p.x - ux * 4, y: 0, z: p.z - uz * 4 };
    fx.c.state.yaw = Math.atan2(ux, uz);
    fx.t.state.pos = { x: p.x + ux * 4, y: 0, z: p.z + uz * 4 };
    cast(fx, Math.atan2(ux, uz));
    expect(ofType(fx.events, 'ultimateTarget')).toHaveLength(1);
    untilDone(fx);
    expect(stages(fx)).toContain(PYTHON_STAGE.WHIFF);
    expect(stages(fx)).not.toContain(PYTHON_STAGE.SNARE);
    expect(fx.t.state.hp).toBe(HP0);
  });

  it('the tether snares the FIRST foe on the line, not necessarily the locked one', () => {
    const events: GameEvent[] = [];
    const { world } = liveWorld(['python', 'hippo', 'lion'], 7, events);
    disablePickups(world);
    const c = world.fighters[0];
    c.state.pos = { x: 0, y: 0, z: 0 };
    world.fighters[1].state.pos = { x: 0, y: 0, z: 8 };
    world.fighters[2].state.pos = { x: 0, y: 0, z: 4 };
    c.state.ultCharge = 100;
    const press = neutral();
    press.ultimate = true;
    world.setIntent(0, press);
    world.step(DT);
    for (let i = 0; i < 80; i++) {
      world.setIntent(0, neutral());
      world.step(DT);
    }
    expect(c.state.grabTargetId).toBe(2);
    expect(world.fighters[2].state.grabbedById).toBe(0);
    expect(world.fighters[1].state.grabbedById).toBe(-1);
  });
});

describe('python Coil Snare — interruption, cleanup, determinism', () => {
  it('the windup is interruptible; after the lash starts the runtime resists interrupt()', () => {
    const a = fixture(6);
    cast(a);
    step(a, 10);
    a.c.interrupt();
    expect(a.c.ability).toBeNull();

    const b = fixture(6);
    cast(b);
    step(b, 60);
    expect(b.c.ability).not.toBeNull();
    b.c.interrupt();
    expect(b.c.ability).not.toBeNull();
    expect(b.c.ability!.isGrab).toBe(true);
  });

  it('caster dies mid-bind: victim released on the ground, hold flags clear', () => {
    const fx = fixture(6, 0, 'hippo', 7, true);
    cast(fx);
    for (let i = 0; i < 400 && !stages(fx).includes(PYTHON_STAGE.WRAP2); i++) step(fx, 1);
    expect(fx.t.state.grabbedById).toBe(0);
    fx.c.state.hp = 0;
    step(fx, 2);
    expect(fx.c.state.alive).toBe(false);
    expect(fx.t.state.grabbedById).toBe(-1);
    expect(fx.t.state.pos.y).toBeCloseTo(groundHeightAt(fx.t.state.pos.x, fx.t.state.pos.z, fx.t.arena), 5);
    step(fx, 20);
    expect(fx.t.state.action).not.toBe('grabbed');
    expect(fx.t.movementOwned).toBe(false);
  });

  it('victim dies mid-bind: the python lets go and recovers (no stuck runtime)', () => {
    const fx = fixture(6, 0, 'hippo', 7, true);
    cast(fx);
    for (let i = 0; i < 400 && !stages(fx).includes(PYTHON_STAGE.WRAP2); i++) step(fx, 1);
    fx.t.state.hp = 1;
    step(fx, 3);
    expect(fx.t.state.alive).toBe(false);
    const n = untilDone(fx, 200);
    expect(n).toBeLessThan(120);
    expect(fx.c.ability).toBeNull();
    expect(fx.c.state.grabTargetId).toBe(-1);
    expect(fx.c.incomingDamageReduction).toBe(0);
  });

  it('victim dies during the yank: no stuck hold either', () => {
    const fx = fixture(8, 0, 'hippo', 7, true);
    cast(fx);
    for (let i = 0; i < 300 && !stages(fx).includes(PYTHON_STAGE.SNARE); i++) step(fx, 1);
    fx.t.state.hp = 0;
    step(fx, 2);
    expect(fx.t.state.alive).toBe(false);
    untilDone(fx, 200);
    expect(fx.c.ability).toBeNull();
    expect(fx.c.state.grabTargetId).toBe(-1);
  });

  it('is deterministic: identical runs give identical traces', () => {
    const run = (): string => {
      const fx = fixture(7, 12);
      cast(fx, (12 * Math.PI) / 180);
      const trace: number[] = [];
      for (let i = 0; i < 500; i++) {
        step(fx, 1);
        if (i % 7 === 0) trace.push(fx.c.state.pos.x, fx.c.state.pos.z, fx.t.state.pos.x, fx.t.state.pos.z, fx.t.state.pos.y, fx.t.state.hp);
      }
      return JSON.stringify([trace, stages(fx)]);
    };
    expect(run()).toBe(run());
  });
});
