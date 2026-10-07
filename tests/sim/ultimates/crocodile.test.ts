import { describe, it, expect } from 'vitest';
import { liveWorld, neutral, disablePickups, DT } from '../helpers';
import { ANIMALS } from '../../../src/config/animals';
import { CROC, CROC_STAGE, crocRollAngle } from '../../../src/config/ultimates/crocodile';
import type { AnimalId, GameEvent, GameEventOf } from '../../../src/core/types';
import type { World } from '../../../src/sim/World';
import type { Fighter } from '../../../src/sim/Fighter';
import { dealDamage } from '../../../src/sim/CombatSystem';
import { groundHeightAt } from '../../../src/sim/MovementSystem';
import { previewUltTarget } from '../../../src/sim/ultimates/targeting';
import { crocodileUltScript } from '../../../src/ai/ultScripts/crocodile';

const SPEC = ANIMALS.crocodile.ultimate;
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
  const { world } = liveWorld(bystander ? ['crocodile', victim, 'lion'] : ['crocodile', victim], seed, events);
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

/** Step until the ultimate runtime is gone (or `max` ticks). */
function untilDone(fx: Fx, max = 700): number {
  let n = 0;
  while (fx.c.ability !== null && n < max) {
    step(fx, 1);
    n++;
  }
  return n;
}

describe('crocodile Death Roll — config / targeting / fizzle', () => {
  it('is a lock ultimate with a 7 m reach, requireTarget and a bot dodge opt-in', () => {
    expect(SPEC.name).toBe('Death Roll');
    expect(SPEC.description).toMatch(/lock/i);
    const tg = SPEC.targeting!;
    expect(tg.kind).toBe('lock');
    expect(tg.range).toBe(7);
    expect(tg.requireTarget).toBe(true);
    expect(tg.dodge?.mode).toBe('fixed');
    expect(SPEC.damage).toBe(300);
    expect(SPEC.damageReduction).toBe(0.5);
    expect(SPEC.recovery).toBe(1);
  });

  it('fizzles (charge kept, no cast) with nobody in the cone, out of range, or airborne', () => {
    const cases: [string, (fx: Fx) => void][] = [
      ['out of range', (fx) => (fx.t.state.pos = { x: 0, y: 0, z: 12 })],
      ['outside the cone', (fx) => (fx.t.state.pos = { x: 5, y: 0, z: 0 })],
      ['airborne', (fx) => (fx.t.state.pos = { x: 0, y: 4, z: 5 })],
    ];
    for (const [name, setup] of cases) {
      const fx = fixture(5);
      setup(fx);
      cast(fx);
      expect(ofType(fx.events, 'ultimateFizzle'), name).toHaveLength(1);
      expect(fx.c.state.ultCharge, name).toBe(100);
      expect(fx.c.ability, name).toBeNull();
      expect(fx.c.state.ultsUsed, name).toBe(0);
    }
  });

  it('casts on a target inside the cone: lock event + windup + targetId in the snapshot', () => {
    const fx = fixture(6, 20);
    cast(fx, (20 * Math.PI) / 180);
    expect(fx.c.state.ultCharge).toBe(0);
    const te = ofType(fx.events, 'ultimateTarget');
    expect(te).toHaveLength(1);
    expect(te[0]).toMatchObject({ kind: 'lock', targetId: 1, windup: SPEC.windup, range: 7 });
    const snap = fx.world.snapshot().fighters[0];
    expect(snap.action).toBe('ultimate');
    expect(snap.ultPhase).toBe('windup');
    expect(snap.ultTargetId).toBe(1);
  });

  it('the bot script only wants a target it can reach and is not running away from', () => {
    const base = {
      animal: 'crocodile', tdist: 5, targetFleeing: false, targetHelpless: false, targetRooted: false, targetBlocking: false,
      tHpFrac: 0.9, targetIsolated: false,
    } as never;
    expect(crocodileUltScript.gate({ ...(base as object), tdist: 6 } as never)).toBe(true);
    expect(crocodileUltScript.gate({ ...(base as object), tdist: 8 } as never)).toBe(false);
    const out = { special: false, ult: false, aimYaw: 0 };
    crocodileUltScript.apex({ ...(base as object), targetHelpless: true } as never, out);
    expect(out.ult).toBe(true);
    out.ult = false;
    crocodileUltScript.apex({ ...(base as object), targetHelpless: true, targetFleeing: true } as never, out);
    expect(out.ult).toBe(false);
  });

  it('roll angle helper: eased ends, exactly 3 turns', () => {
    expect(crocRollAngle(0)).toBe(0);
    expect(crocRollAngle(1)).toBeCloseTo(6 * Math.PI, 9);
    expect(crocRollAngle(0.5)).toBeCloseTo(3 * Math.PI, 9);
    let prev = 0;
    for (let i = 1; i <= 100; i++) {
      const a = crocRollAngle(i / 100);
      expect(a).toBeGreaterThan(prev);
      prev = a;
    }
  });
});

describe('crocodile Death Roll — lunge, clamp, drag, roll, toss', () => {
  it('runs the full beat sequence and ends with a toss + recovery', () => {
    const fx = fixture(5);
    cast(fx);
    untilDone(fx);
    expect(stages(fx)).toEqual([
      CROC_STAGE.COMMIT,
      CROC_STAGE.LUNGE,
      CROC_STAGE.CLAMP,
      CROC_STAGE.DRAG,
      CROC_STAGE.ROLL1,
      CROC_STAGE.ROLL2,
      CROC_STAGE.ROLL3,
      CROC_STAGE.TOSS,
    ]);
    expect(fx.c.ability).toBeNull();
    expect(fx.c.state.action).not.toBe('ultimate');
    expect(fx.c.incomingDamageReduction).toBe(0);
    expect(fx.c.state.grabTargetId).toBe(-1);
    expect(fx.t.state.grabbedById).toBe(-1);
  });

  it('the lunge is a fast burst: it reaches a target 6 m away in well under half a second', () => {
    const fx = fixture(6);
    cast(fx);
    let lungeAt = -1;
    let clampAt = -1;
    for (let i = 0; i < 120 && clampAt < 0; i++) {
      step(fx, 1);
      const ev = ofType(fx.events, 'ultimateStage');
      if (lungeAt < 0 && ev.some((e) => e.stage === CROC_STAGE.LUNGE)) lungeAt = i;
      if (clampAt < 0 && ev.some((e) => e.stage === CROC_STAGE.CLAMP)) clampAt = i;
    }
    expect(lungeAt).toBeGreaterThan(0);
    expect(clampAt).toBeGreaterThan(lungeAt);
    expect((clampAt - lungeAt) * DT).toBeLessThan(0.3);
  });

  it('deals ~300 total (bite + unblockable drain + toss); a blocking victim still takes it all', () => {
    for (const block of [false, true]) {
      const fx = fixture(4);
      fx.t.state.guard = 10000;
      cast(fx);
      step(fx, 1500, () => {
        if (block && fx.t.state.grabbedById === -1 && fx.t.ability === null) fx.t.blocking = true;
      });
      const dealt = HP0 - fx.t.state.hp;
      expect(dealt, `block=${block}`).toBeGreaterThan(SPEC.damage! - 12);
      expect(dealt, `block=${block}`).toBeLessThan(SPEC.damage! + 12);
    }
  });

  it('holds and stuns the victim from the clamp to the toss, at the jaws, croc takes 50% less', () => {
    const fx = fixture(4);
    cast(fx);
    let sawRoll = false;
    let closest = 99;
    let farthest = 0;
    for (let i = 0; i < 600 && fx.c.ability !== null; i++) {
      step(fx, 1);
      const snap = fx.world.snapshot();
      if (fx.c.ability !== null && fx.c.ability.didHit && fx.t.state.grabbedById === 0 && snap.fighters[0].ultStage! >= CROC_STAGE.ROLL1) {
        sawRoll = true;
        expect(fx.t.state.action).toBe('grabbed');
        expect(fx.t.staggerTimer).toBeGreaterThan(0);
        expect(fx.c.state.grabTargetId).toBe(1);
        expect(fx.c.incomingDamageReduction).toBe(0.5);
        expect(fx.t.movementOwned).toBe(true);
        const d = Math.hypot(fx.t.state.pos.x - fx.c.state.pos.x, fx.t.state.pos.z - fx.c.state.pos.z);
        closest = Math.min(closest, d);
        farthest = Math.max(farthest, d);
        expect(fx.t.state.pos.y).toBeGreaterThanOrEqual(0);
        expect(snap.fighters[0].ultTargetId).toBe(1);
      }
    }
    expect(sawRoll).toBe(true);
    expect(closest).toBeGreaterThan(1.0);
    expect(farthest).toBeLessThan(3.6);
  });

  it('halves the damage the croc takes while holding, and only while holding', () => {
    const fx = fixture(4);
    const probe = (): number => {
      const hp = fx.c.state.hp;
      dealDamage(fx.world, fx.t, fx.c, 100, { blockable: false, heavy: true, reaction: 'none', isBasic: false, allowBackstab: false });
      return hp - fx.c.state.hp;
    };
    const before = probe();
    cast(fx);
    step(fx, 90); // windup over, clamped/dragging
    expect(fx.c.state.grabTargetId).toBe(1);
    const during = probe();
    expect(during).toBeCloseTo(before * 0.5, 5);
    untilDone(fx);
    fx.c.state.hp = ANIMALS.crocodile.hp;
    expect(probe()).toBeCloseTo(before, 5);
  });

  it('tosses the victim about 3 m along the lunge line with a short stagger', () => {
    const fx = fixture(4);
    cast(fx);
    let tossPos: { x: number; z: number } | null = null;
    for (let i = 0; i < 700 && tossPos === null; i++) {
      step(fx, 1);
      if (stages(fx).includes(CROC_STAGE.TOSS)) tossPos = { x: fx.t.state.pos.x, z: fx.t.state.pos.z };
    }
    expect(tossPos).not.toBeNull();
    const sx = fx.t.state.pos.x;
    const sz = fx.t.state.pos.z;
    step(fx, 30);
    const moved = Math.hypot(fx.t.state.pos.x - sx, fx.t.state.pos.z - sz);
    expect(moved).toBeGreaterThan(SPEC.knockback! * 0.6);
    expect(moved).toBeLessThan(SPEC.knockback! * 1.3);
    expect(fx.t.state.pos.z - sz).toBeGreaterThan(0); // along +Z (the lunge line)
    expect(fx.t.state.grabbedById).toBe(-1);
    expect(fx.t.state.pos.y).toBeCloseTo(groundHeightAt(fx.t.state.pos.x, fx.t.state.pos.z, fx.t.arena), 6);
    expect(fx.t.staggerTimer).toBeLessThanOrEqual(CROC.tossStagger);
  });

  it('whiff: a target that leaves the committed line escapes; ~1 s slide recovery', () => {
    const fx = fixture(5);
    cast(fx);
    let committedAt = -1;
    let done = -1;
    for (let i = 0; i < 400 && done < 0; i++) {
      step(fx, 1);
      if (committedAt < 0 && stages(fx).includes(CROC_STAGE.COMMIT)) {
        committedAt = i;
        fx.t.state.pos = { x: 6, y: 0, z: 5 }; // sidestepped off the frozen line
      }
      if (fx.c.ability === null) done = i;
    }
    expect(committedAt).toBeGreaterThan(0);
    expect(stages(fx)).toContain(CROC_STAGE.WHIFF);
    expect(stages(fx)).not.toContain(CROC_STAGE.CLAMP);
    expect(fx.t.state.hp).toBe(HP0);
    expect(fx.t.state.grabbedById).toBe(-1);
    // Lunge + slide + recovery: the whiff costs about 1 s after the lunge ends.
    const lungeIdx = ofType(fx.events, 'ultimateStage').findIndex((e) => e.stage === CROC_STAGE.WHIFF);
    expect(lungeIdx).toBeGreaterThanOrEqual(0);
    expect(done).toBeGreaterThan(committedAt);
    const afterWhiff = ((done - committedAt) * DT);
    expect(afterWhiff).toBeGreaterThan(1.0);
    expect(afterWhiff).toBeLessThan(2.2);
  });

  it('a foe hopping above the low lunge is jumped over', () => {
    const fx = fixture(5);
    cast(fx);
    step(fx, 400, () => {
      fx.t.state.pos.y = 1.1; // held in the air (above CROC.hopClearance) until the lunge is over
      fx.t.state.airborne = true;
      fx.t.state.vel.y = 0;
    });
    expect(stages(fx)).toContain(CROC_STAGE.WHIFF);
    expect(stages(fx)).not.toContain(CROC_STAGE.CLAMP);
    expect(fx.t.state.hp).toBe(HP0);
  });

  it('the lunge stops at the first foe in the way (not only the locked one)', () => {
    const events: GameEvent[] = [];
    const { world } = liveWorld(['crocodile', 'hippo', 'lion'], 7, events);
    disablePickups(world);
    const c = world.fighters[0];
    c.state.pos = { x: 0, y: 0, z: 0 };
    world.fighters[1].state.pos = { x: 0, y: 0, z: 6 }; // locked target (dead ahead)
    world.fighters[2].state.pos = { x: 0, y: 0, z: 3.5 }; // stands in the path
    const press = neutral();
    press.ultimate = true;
    c.state.ultCharge = 100;
    world.setIntent(0, press);
    world.step(DT);
    for (let i = 0; i < 60; i++) {
      world.setIntent(0, neutral());
      world.step(DT);
    }
    expect(c.state.grabTargetId).toBe(2);
    expect(world.fighters[2].state.grabbedById).toBe(0);
    expect(world.fighters[1].state.grabbedById).toBe(-1);
  });

  it("cancels what the victim was casting when it is clamped (windup of its own special)", () => {
    const fx = fixture(5, 0, 'hippo');
    cast(fx);
    step(fx, 24); // croc still winding up
    const press = neutral();
    press.special = true;
    press.aimYaw = Math.PI;
    fx.t.state.specialCd = 0;
    fx.world.setIntent(1, press);
    fx.world.setIntent(0, neutral());
    fx.world.step(DT);
    expect(fx.t.ability).not.toBeNull();
    let seized = false;
    for (let i = 0; i < 60 && !seized; i++) {
      step(fx, 1);
      seized = fx.c.state.grabTargetId === 1;
    }
    expect(seized).toBe(true);
    expect(fx.t.ability).toBeNull();
    expect(fx.t.state.grabbedById).toBe(0);
  });
});

describe('crocodile Death Roll — interruption, cleanup, determinism', () => {
  it('the windup is interruptible; after the lunge starts the runtime resists interrupt()', () => {
    const a = fixture(5);
    cast(a);
    step(a, 10);
    a.c.interrupt();
    expect(a.c.ability).toBeNull();

    const b = fixture(5);
    cast(b);
    step(b, 80); // through windup + lunge, holding
    expect(b.c.ability).not.toBeNull();
    b.c.interrupt();
    expect(b.c.ability).not.toBeNull();
    expect(b.c.ability!.isGrab).toBe(true);
  });

  it('caster dies mid-roll: victim released, standing on the ground, hold flags clear', () => {
    const fx = fixture(4, 0, 'hippo', 7, true);
    cast(fx);
    for (let i = 0; i < 400 && !stages(fx).includes(CROC_STAGE.ROLL2); i++) step(fx, 1);
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

  it('victim dies mid-roll: the croc lets go and recovers (no stuck runtime, reduction cleared)', () => {
    const fx = fixture(4, 0, 'hippo', 7, true);
    cast(fx);
    for (let i = 0; i < 400 && !stages(fx).includes(CROC_STAGE.ROLL2); i++) step(fx, 1);
    fx.t.state.hp = 1;
    step(fx, 3);
    expect(fx.t.state.alive).toBe(false);
    const n = untilDone(fx, 200);
    expect(n).toBeLessThan(150);
    expect(fx.c.ability).toBeNull();
    expect(fx.c.state.grabTargetId).toBe(-1);
    expect(fx.c.incomingDamageReduction).toBe(0);
  });

  it('is deterministic: identical runs give identical traces', () => {
    const run = (): string => {
      const fx = fixture(5, 10);
      cast(fx, (10 * Math.PI) / 180);
      const trace: number[] = [];
      for (let i = 0; i < 400; i++) {
        step(fx, 1);
        if (i % 7 === 0) trace.push(fx.c.state.pos.x, fx.c.state.pos.z, fx.t.state.pos.x, fx.t.state.pos.z, fx.t.state.pos.y, fx.t.state.hp);
      }
      return JSON.stringify([trace, stages(fx)]);
    };
    expect(run()).toBe(run());
  });

  it('previewUltTarget agrees with the sim (same selection)', () => {
    const fx = fixture(6, 15);
    fx.c.intent.aimYaw = (15 * Math.PI) / 180;
    const pv = previewUltTarget(SPEC, fx.c.state, fx.world.snapshot().fighters, { aimYaw: fx.c.intent.aimYaw });
    expect(pv.valid).toBe(true);
    expect(pv.targetId).toBe(1);
    expect(pv.kind).toBe('lock');
  });
});
