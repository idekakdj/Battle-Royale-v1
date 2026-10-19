/**
 * v1.10 FALL DAMAGE (docs/OCEAN-HEIGHTS-PLAN.md section 1.5): landing after a drop of at least `hazards.fallDamage.minDrop` (3.4 m) from the
 * height where the fighter last stood costs exactly `damage` (50) TRUE damage, once per landing, through the environment-damage path
 * (no block / guard / armour / buff effect, no credit, no ult charge); a death is `killerId -1, cause 'fall'`. Flyers and burrowed /
 * untargetable fighters are exempt; ramps never hurt. Runs on the synthetic two-height dome (tests/sim/heightsFixture.ts), so it does
 * not depend on the real Ocean Dome layout.
 */
import { describe, it, expect } from 'vitest';
import { World } from '../../src/sim/World';
import { EventBus } from '../../src/core/EventBus';
import { ANIMALS } from '../../src/config/animals';
import { arenaGroundHeight, type ElevationPiece } from '../../src/config/arenas';
import type { AnimalId, GameEvent, MatchConfig } from '../../src/core/types';
import {
  DT,
  FALL_RULE,
  HEIGHTS_ARENA,
  HEIGHTS_FIELD,
  LEDGE,
  PLATFORM,
  SHELF,
  heightsArena,
  heightsWorld,
  neutralIntent,
  ofType,
  parkOthers,
  standAt,
  stepN,
} from './heightsFixture';

const ROSTER: AnimalId[] = ['lion', 'gorilla', 'rhino', 'hippo'];
const falls = (events: readonly GameEvent[]) => ofType(events, 'fall');

/** A world with the subject fighter 0 standing at (x, z); everybody else parked far away. */
function setup(animal: AnimalId, x: number, z: number, opts?: Parameters<typeof heightsWorld>[2]) {
  const hw = heightsWorld([animal, ...ROSTER.filter((a) => a !== animal).slice(0, 3)], 7, opts);
  parkOthers(hw.world, [0]);
  standAt(hw.world, 0, x, z);
  stepN(hw.world, 2);
  hw.events.length = 0;
  return hw;
}

function walk(world: World, id: number, mx: number, mz: number, ticks: number): void {
  world.setIntent(id, { ...neutralIntent(), moveX: mx, moveZ: mz, aimYaw: Math.atan2(mx, mz) });
  stepN(world, ticks);
  world.setIntent(id, neutralIntent());
}

/** Walks along (mx, mz) until `stop` is true (at most `maxTicks`), then stops the fighter and lets it settle for 20 ticks. */
function walkUntil(world: World, id: number, mx: number, mz: number, stop: () => boolean, maxTicks = 900): void {
  world.setIntent(id, { ...neutralIntent(), moveX: mx, moveZ: mz, aimYaw: Math.atan2(mx, mz) });
  for (let i = 0; i < maxTicks && !stop(); i++) world.step(DT);
  world.setIntent(id, neutralIntent());
  stepN(world, 20);
}

describe('fixture sanity', () => {
  it('has the heights the tests rely on', () => {
    expect(arenaGroundHeight(HEIGHTS_ARENA, PLATFORM.x, PLATFORM.z)).toBe(6.5);
    expect(arenaGroundHeight(HEIGHTS_ARENA, SHELF.x, SHELF.z)).toBe(3);
    expect(arenaGroundHeight(HEIGHTS_ARENA, LEDGE.x, LEDGE.z)).toBe(3);
    expect(arenaGroundHeight(HEIGHTS_ARENA, 0, 0)).toBe(0);
    expect(arenaGroundHeight(HEIGHTS_ARENA, 14, -19)).toBeCloseTo(6.5 * (3 / 19), 6);
    expect(arenaGroundHeight(HEIGHTS_ARENA, 14, -3.1)).toBeGreaterThan(6.4);
    expect(HEIGHTS_ARENA.hazards?.fallDamage).toEqual(FALL_RULE);
  });
});

describe('the drop that costs 50', () => {
  it('walking off the 6.5 m platform onto the 3.0 m shelf (a 3.5 m drop): exactly one fall event, exactly 50 hp, once', () => {
    const { world, events } = setup('lion', 14, 1);
    const f = world.fighters[0];
    const hp0 = f.state.hp;
    expect(f.state.pos.y).toBe(6.5);
    walk(world, 0, 0, 1, 70); // over the edge, down onto the shelf, a little further
    const fs = falls(events);
    expect(fs).toHaveLength(1);
    expect(fs[0]).toMatchObject({ type: 'fall', fighterId: 0, damage: 50 });
    expect(fs[0].drop).toBeCloseTo(3.5, 6);
    expect(fs[0].pos.y).toBeCloseTo(3, 6); // it landed on the shelf
    expect(f.state.hp).toBe(hp0 - 50);
    expect(f.state.alive).toBe(true);
    // standing still afterwards, and later walking along the shelf, never charges it again
    stepN(world, 180);
    expect(falls(events)).toHaveLength(1);
    expect(f.state.hp).toBe(hp0 - 50);
  });

  it('a platform -> floor fall (6.5 m) is the same fixed 50, not more', () => {
    const { world, events } = setup('gorilla', 14 + 3.0, 0); // the platform's +x rim, away from the ramp and the shelf
    const f = world.fighters[0];
    expect(f.state.pos.y).toBe(6.5);
    const hp0 = f.state.hp;
    walk(world, 0, 1, 0, 90); // east, off the rim onto the floor
    const fs = falls(events);
    expect(fs).toHaveLength(1);
    expect(fs[0].damage).toBe(50);
    expect(fs[0].drop).toBeCloseTo(6.5, 6);
    expect(fs[0].pos.y).toBe(0);
    expect(f.state.hp).toBe(hp0 - 50);
  });

  it('the threshold is minDrop: a 3.4 m drop costs 50, a 3.39 m drop does not (the 3.5 and 3.0 m drops of the plan are on either side)', () => {
    const cases: Array<[number, boolean]> = [
      [3.5, true],
      [3.4, true],
      [3.39, false],
      [3.0, false],
      [1.5, false],
    ];
    for (const [drop, want] of cases) {
      const shelfH = 6.5 - drop;
      const field: ElevationPiece[] = HEIGHTS_FIELD.map((p) => (p.kind === 'plateau' && p.x === SHELF.x && p.z === SHELF.z ? { ...p, height: shelfH } : p));
      const arena = { ...HEIGHTS_ARENA, heightfield: field };
      const { world, events } = setup('lion', 14, 1, { arena });
      walk(world, 0, 0, 1, 70);
      expect(falls(events).length, `drop ${drop}`).toBe(want ? 1 : 0);
      expect(world.fighters[0].state.hp).toBe(world.fighters[0].def.hp - (want ? 50 : 0));
      if (want) expect(falls(events)[0].drop).toBeCloseTo(drop, 6);
    }
  });

  it('plateau (3.0 m) -> floor is a 3.0 m drop: no damage', () => {
    const { world, events } = setup('lion', -14, 1);
    expect(world.fighters[0].state.pos.y).toBe(3);
    walk(world, 0, -1, 0, 90); // west, off the ledge onto the floor
    expect(world.fighters[0].state.pos.y).toBe(0);
    expect(falls(events)).toHaveLength(0);
    expect(world.fighters[0].state.hp).toBe(world.fighters[0].def.hp);
  });

  it('a jump off the platform edge (not only a walk) counts, measured from where the fighter stood, not from the jump apex', () => {
    const { world, events } = setup('lion', 14, 3.0);
    world.setIntent(0, { ...neutralIntent(), moveZ: 1, jump: true, aimYaw: 0 });
    stepN(world, 3);
    world.setIntent(0, { ...neutralIntent(), moveZ: 1 });
    stepN(world, 80);
    expect(falls(events)).toHaveLength(1);
    // measured from the 6.5 m it stood on to wherever it came down (shelf or floor), never from the apex of the jump
    expect(falls(events)[0].drop).toBeCloseTo(6.5 - falls(events)[0].pos.y, 6);
    expect(falls(events)[0].damage).toBe(50);
    // jumping on the spot and landing at the same height costs nothing, however high the apex
    const b = setup('lion', 14, 0);
    b.world.setIntent(0, { ...neutralIntent(), jump: true });
    stepN(b.world, 2);
    b.world.setIntent(0, neutralIntent());
    stepN(b.world, 90);
    expect(b.world.fighters[0].state.airborne).toBe(false);
    expect(falls(b.events)).toHaveLength(0);
  });

  it('knockback over the edge is a fall (any fall counts); the shover gets no credit', () => {
    const { world, events } = setup('hippo', 14, 2);
    world.fighters[0].setKnockback(0, 1, 6); // shoved 6 m toward +z: off the platform
    stepN(world, 80);
    const fs = falls(events);
    expect(fs).toHaveLength(1);
    expect(fs[0].fighterId).toBe(0);
    expect(world.fighters[0].state.hp).toBe(world.fighters[0].def.hp - 50);
    expect(world.fighters[0].lastAttackerId).toBe(-1);
  });

  it('a giraffe Thunder Kick shoving another fighter off the platform: the victim takes the fall, the kicker gets no kill credit', () => {
    const hw = heightsWorld(['giraffe', 'lion', 'rhino', 'gorilla'], 7);
    parkOthers(hw.world, [0, 1]);
    standAt(hw.world, 0, 14, 0.6);
    standAt(hw.world, 1, 14, 1.8);
    hw.world.fighters[0].state.yaw = 0;
    stepN(hw.world, 2);
    hw.events.length = 0;
    hw.world.setIntent(0, { ...neutralIntent(), special: true, aimYaw: 0 });
    stepN(hw.world, 2);
    hw.world.setIntent(0, { ...neutralIntent(), aimYaw: 0 });
    stepN(hw.world, 120);
    const fs = falls(hw.events).filter((e) => e.fighterId === 1);
    expect(fs).toHaveLength(1);
    expect(hw.world.fighters[0].state.kills).toBe(0);
    expect(hw.world.fighters[1].lastAttackerId).toBe(-1); // the fall cleared the credit, like a trap
  });

  it('a lion leaping off the platform (Pounce special) lands as a fall', () => {
    const { world, events } = setup('lion', 14, 2.8);
    world.setIntent(0, { ...neutralIntent(), special: true, aimYaw: 0, moveZ: 1 });
    stepN(world, 3);
    world.setIntent(0, { ...neutralIntent(), aimYaw: 0 });
    stepN(world, 150);
    expect(world.fighters[0].state.airborne).toBe(false);
    expect(world.fighters[0].state.pos.y).toBeLessThan(3.01); // came down off the platform
    expect(falls(events)).toHaveLength(1);
    expect(falls(events)[0].damage).toBe(50);
    expect(falls(events)[0].drop).toBeGreaterThanOrEqual(3.4);
  });

  it('a charge driving off the edge under an ability (rhino Lockdown: it owns the position and drops 0.3 m per tick) is charged on arrival', () => {
    const { world, events } = setup('rhino', 14 + 2.4, -2.4);
    world.setIntent(0, { ...neutralIntent(), special: true, aimYaw: Math.PI / 2, moveX: 1 }); // charge east, off the rim
    stepN(world, 3);
    world.setIntent(0, { ...neutralIntent(), aimYaw: Math.PI / 2 });
    stepN(world, 240);
    expect(world.fighters[0].state.pos.y).toBe(0);
    expect(world.fighters[0].state.airborne).toBe(false);
    expect(falls(events)).toHaveLength(1);
    expect(falls(events)[0].drop).toBeCloseTo(6.5, 6);
    expect(falls(events)[0].damage).toBe(50);
    expect(world.fighters[0].state.hp).toBe(world.fighters[0].def.hp - 50);
  });
});

describe('what never hurts', () => {
  it('walking up and down the ramp, onto the platform and back: no fall, no damage, even running at the grade limit', () => {
    for (const animal of ['panther', 'rhino', 'lion'] as AnimalId[]) {
      const { world, events } = setup(animal, 14, -19);
      const f = world.fighters[0];
      walkUntil(world, 0, 0, 1, () => f.state.pos.z > -0.5); // the whole ramp and onto the platform
      expect(f.state.pos.y, animal).toBe(6.5);
      walkUntil(world, 0, 0, -1, () => f.state.pos.z < -21.5); // and back down to the floor
      expect(f.state.pos.y, animal).toBeLessThan(0.3);
      expect(falls(events), animal).toHaveLength(0);
      expect(f.state.hp, animal).toBe(f.def.hp);
    }
  });

  it('standing on the platform, jumping in place, spawning, and teleports (blink / placement) to other heights never count', () => {
    const { world, events } = setup('lion', 14, 0);
    stepN(world, 60);
    standAt(world, 0, 0, 0); // teleported from 6.5 m to the floor: a teleport, not a fall
    stepN(world, 60);
    standAt(world, 0, 14, 0); // ... and back up
    stepN(world, 60);
    expect(falls(events)).toHaveLength(0);
    expect(world.fighters[0].state.hp).toBe(world.fighters[0].def.hp);
  });

  it('flyers are exempt: an eagle walking off the platform, gliding, or soaring and dropping is never charged', () => {
    for (const mode of ['walk', 'glide', 'soar'] as const) {
      const { world, events } = setup('eagle', 14, 1);
      expect(ANIMALS.eagle.perks.soar).toBeDefined();
      if (mode === 'walk') {
        walk(world, 0, 0, 1, 180);
      } else {
        world.setIntent(0, { ...neutralIntent(), moveZ: 1, jump: true, aimYaw: 0 });
        stepN(world, mode === 'glide' ? 70 : 150);
        world.setIntent(0, { ...neutralIntent(), moveZ: 1 });
        stepN(world, 240); // released: the controlled descent, far below the platform
      }
      expect(world.fighters[0].state.airborne, mode).toBe(false);
      expect(world.fighters[0].state.pos.y, mode).toBeLessThan(6.4); // it did come down off the platform
      expect(falls(events), mode).toHaveLength(0);
      expect(world.fighters[0].state.hp, mode).toBe(world.fighters[0].def.hp);
    }
  });

  it('an untargetable fighter (or a burrowed mole) is exempt, and the exemption restarts the measurement instead of charging later', () => {
    for (const how of ['untargetable', 'burrowed'] as const) {
      const { world, events } = setup('mole', 14, 1);
      const f = world.fighters[0];
      if (how === 'untargetable') f.untargetable = true;
      else f.state.burrowT = 5;
      walk(world, 0, 0, 1, 80); // off the platform
      expect(f.state.pos.y, how).toBeLessThan(6.4);
      f.untargetable = false;
      f.state.burrowT = 0;
      stepN(world, 120);
      expect(falls(events), how).toHaveLength(0);
      expect(f.state.hp, how).toBe(f.def.hp);
    }
  });

  it('arenas without hazards.fallDamage never charge a fall (same geometry, serpent hazards only)', () => {
    const arena = heightsArena({ serpent: true, serpentSplitY: 4.5 });
    const { world, events } = setup('lion', 14, 1, { arena });
    walk(world, 0, 0, 1, 70);
    expect(world.fighters[0].state.pos.y).toBe(3);
    expect(falls(events)).toHaveLength(0);
    expect(world.fighters[0].state.hp).toBe(world.fighters[0].def.hp);
  });
});

describe('true damage: nothing reduces it, nobody is credited', () => {
  /** Walks fighter 0 off the platform with `prep` applied first. */
  function fallWith(prep: (w: World) => void, animal: AnimalId = 'lion') {
    const hw = setup(animal, 14, 1);
    prep(hw.world);
    walk(hw.world, 0, 0, 1, 70);
    return hw;
  }

  it('a BLOCKING fighter loses exactly 50; guard, damageBlocked, ult charge and the blocked event are untouched', () => {
    const hw = setup('lion', 14, 1);
    hw.world.setIntent(0, { ...neutralIntent(), block: true, moveZ: 1, aimYaw: 0 }); // the block is held all the way down
    stepN(hw.world, 90);
    const f = hw.world.fighters[0];
    expect(falls(hw.events)).toHaveLength(1);
    expect(f.state.hp).toBe(f.def.hp - 50);
    expect(f.state.damageBlocked).toBe(0);
    expect(f.state.ultCharge).toBe(0);
    expect(f.state.guard).toBe(f.state.maxGuard);
    expect(ofType(hw.events, 'blocked')).toHaveLength(0);
    expect(ofType(hw.events, 'hit')).toHaveLength(0);
    expect(f.hitstunTimer).toBe(0);
    expect(f.staggerTimer).toBe(0);
    expect(f.knockdownTimer).toBe(0);
  });

  it('armour, damage-reduction buffs and incomingDamageReduction never change it: exactly 50', () => {
    const { world, events } = fallWith((w) => {
      w.fighters[0].state.buffs.push({ kind: 'armorUp', t: 20, dur: 20, mag: 0.8 });
      w.fighters[0].state.buffs.push({ kind: 'dmgTakenUp', t: 20, dur: 20, mag: -0.5 });
      w.fighters[0].incomingDamageReduction = 0.7;
    });
    expect(falls(events)).toHaveLength(1);
    expect(world.fighters[0].state.hp).toBe(world.fighters[0].def.hp - 50);
    expect(falls(events)[0].damage).toBe(50);
  });

  it('nobody gains ult charge or damage credit from it (not even the victim)', () => {
    const { world } = fallWith(() => undefined);
    for (const f of world.fighters) {
      expect(f.state.ultCharge).toBe(0);
      expect(f.state.damageDealt).toBe(0);
      expect(f.state.kills).toBe(0);
    }
  });

  it('a lethal fall: killerId -1, death.cause "fall", hp actually removed is reported, the previous attacker loses the credit', () => {
    const hw = setup('lion', 14, 1);
    const f = hw.world.fighters[0];
    f.state.hp = 30;
    f.lastAttackerId = 2; // the rhino had been hitting it
    walk(hw.world, 0, 0, 1, 70);
    expect(f.state.alive).toBe(false);
    const fs = falls(hw.events);
    expect(fs).toHaveLength(1);
    expect(fs[0].damage).toBe(30); // hp actually removed
    const deaths = ofType(hw.events, 'death');
    expect(deaths).toHaveLength(1);
    expect(deaths[0]).toEqual({ type: 'death', targetId: 0, killerId: -1, placement: 10, cause: 'fall' });
    expect(hw.world.fighters[2].state.kills).toBe(0);
    // the fall is reported before the death
    const order = hw.events.map((e) => e.type).filter((t) => t === 'fall' || t === 'death');
    expect(order).toEqual(['fall', 'death']);
  });

  it('exactly 50 hp is a survivable fall (the fighter keeps 0 < hp), 51 hp is not lethal either, 50 is: hp 50 dies with cause fall', () => {
    for (const [hp, alive] of [[51, true], [50, false], [49, false]] as const) {
      const hw = setup('lion', 14, 1);
      hw.world.fighters[0].state.hp = hp;
      walk(hw.world, 0, 0, 1, 70);
      expect(hw.world.fighters[0].state.alive, `hp ${hp}`).toBe(alive);
      if (!alive) expect(ofType(hw.events, 'death')[0]).toMatchObject({ targetId: 0, killerId: -1, cause: 'fall' });
    }
  });

  it('two fighters landing on the same tick are both charged, in id order', () => {
    const hw = heightsWorld(['lion', 'gorilla', 'rhino', 'hippo'], 7);
    parkOthers(hw.world, [0, 1]);
    standAt(hw.world, 0, 13, 1);
    standAt(hw.world, 1, 15, 1);
    stepN(hw.world, 2);
    hw.events.length = 0;
    hw.world.setIntent(0, { ...neutralIntent(), moveZ: 1 });
    hw.world.setIntent(1, { ...neutralIntent(), moveZ: 1 });
    stepN(hw.world, 120);
    const fs = falls(hw.events);
    expect(fs.map((e) => e.fighterId).sort()).toEqual([0, 1]);
    for (const e of fs) expect(e.damage).toBe(50);
  });

  it('once per landing: a second drop later is a second 50', () => {
    const { world, events } = setup('lion', 14, 1);
    walk(world, 0, 0, 1, 70); // first fall (platform -> shelf)
    standAt(world, 0, 14, 1); // put it back up on the platform (a teleport: free)
    stepN(world, 2);
    walk(world, 0, 0, 1, 70); // second fall
    expect(falls(events)).toHaveLength(2);
    expect(world.fighters[0].state.hp).toBe(world.fighters[0].def.hp - 100);
  });
});

describe('a fall and a serpent strike on the same tick', () => {
  /** Walks fighter 0 (hp `hp`) off the platform; a LOW serpent is triggered `lead` ticks before the landing tick `landTick`. */
  function run(hp: number, trigAt: number | null) {
    const hw = setup('lion', 14, 1);
    hw.world.fighters[0].state.hp = hp;
    const perTick: GameEvent[][] = [];
    for (let t = 0; t < 320; t++) {
      if (t === 120) hw.world.setIntent(0, { ...neutralIntent(), moveZ: 1, aimYaw: 0 }); // stands still for 2 s, then walks off
      if (trigAt !== null && t === trigAt) hw.world.debugTriggerSerpent(27.7, 'low'); // through the spot it lands on, about (14, 7.3)
      hw.events.length = 0;
      hw.world.step(DT);
      perTick.push([...hw.events]);
      if (hw.world.matchOver) break;
    }
    return { ...hw, perTick };
  }
  const landTick = (perTick: GameEvent[][]): number => perTick.findIndex((evs) => evs.some((e) => e.type === 'fall'));

  /** The trigger tick for which the strike's hit and the landing share one tick (searched, the timing is a few ticks wide). */
  function findSharedTick(hp: number): { trig: number; res: ReturnType<typeof run>; at: number } | null {
    const dry = run(1000, null);
    const T = landTick(dry.perTick);
    expect(T).toBeGreaterThan(10);
    for (let lead = 100; lead >= 50; lead--) {
      const res = run(hp, T - lead);
      const at = landTick(res.perTick);
      if (at < 0) continue;
      if (res.perTick[at].some((e) => e.type === 'serpentHit' && e.fighterId === 0)) return { trig: T - lead, res, at };
    }
    return null;
  }

  it('survives the fall but not the strike (hp 100): both events, the death is credited to the serpent, credit-free', () => {
    const found = findSharedTick(100);
    expect(found, 'a shared tick exists').not.toBeNull();
    const evs = (found as NonNullable<typeof found>).res.perTick[(found as NonNullable<typeof found>).at];
    const names = evs.map((e) => e.type).filter((t) => t === 'fall' || t === 'serpentHit' || t === 'death');
    expect(names).toEqual(['fall', 'serpentHit', 'death']);
    const death = evs.find((e) => e.type === 'death') as Extract<GameEvent, { type: 'death' }>;
    expect(death).toEqual({ type: 'death', targetId: 0, killerId: -1, placement: 10, cause: 'serpent' });
    expect((evs.find((e) => e.type === 'fall') as Extract<GameEvent, { type: 'fall' }>).damage).toBe(50);
    expect((evs.find((e) => e.type === 'serpentHit') as Extract<GameEvent, { type: 'serpentHit' }>).damage).toBe(50); // the 50 hp left
  });

  it('with hp 50 the death is a fall death when the fall comes first and a serpent death when the strike does; never both, never a double kill', () => {
    const dry = run(50, null);
    const T = landTick(dry.perTick);
    expect(T).toBeGreaterThan(10);
    let fallFirst = 0;
    let strikeFirst = 0;
    for (let lead = 100; lead >= 50; lead--) {
      const res = run(50, T - lead);
      const all = res.perTick.flat();
      const falls = all.filter((e) => e.type === 'fall');
      const hits = all.filter((e) => e.type === 'serpentHit' && e.fighterId === 0);
      const deaths = all.filter((e) => e.type === 'death');
      expect(deaths, `lead ${lead}`).toHaveLength(1);
      if (falls.length === 1) {
        // the fall killed it (50 hp): the strike, wherever it was, found nobody left to hit
        expect(hits, `lead ${lead}`).toHaveLength(0);
        expect(deaths[0], `lead ${lead}`).toEqual({ type: 'death', targetId: 0, killerId: -1, placement: 10, cause: 'fall' });
        fallFirst++;
      } else {
        // the strike came first (while it was still in the air): no landing was ever charged
        expect(falls, `lead ${lead}`).toHaveLength(0);
        expect(hits, `lead ${lead}`).toHaveLength(1);
        expect(deaths[0], `lead ${lead}`).toEqual({ type: 'death', targetId: 0, killerId: -1, placement: 10, cause: 'serpent' });
        strikeFirst++;
      }
    }
    expect(fallFirst).toBeGreaterThan(5);
    expect(strikeFirst).toBeGreaterThan(0);
  });
});

describe('World wiring', () => {
  it('the World option `arena` replaces the registry lookup and nothing else; hazards.fallDamage switches the pass on', () => {
    const cfg: MatchConfig = { roster: ROSTER.map((a, i) => ({ animal: a, isPlayer: i === 0 })), difficulty: 1, arena: 'ocean' };
    const w = new World(cfg, 1, new EventBus(), { traps: false, arena: HEIGHTS_ARENA });
    expect(w.arena).toBe(HEIGHTS_ARENA);
    // the colosseum has no fall rule: a fighter forced into the air above it never takes fall damage
    const col = new World({ roster: cfg.roster, difficulty: 1, arena: 'colosseum' }, 1, new EventBus(), { traps: false });
    const events: GameEvent[] = [];
    col.bus.onAny((e) => events.push(e));
    for (let i = 0; i < 190; i++) col.step(DT);
    col.fighters[0].state.pos.y = 9;
    col.fighters[0].state.airborne = true;
    stepN(col, 120);
    expect(falls(events)).toHaveLength(0);
  });
});
