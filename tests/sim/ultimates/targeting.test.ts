import { describe, it, expect } from 'vitest';
import { makeFighter, makeSim } from '../helpers';
import { ANIMALS } from '../../../src/config/animals';
import type { UltTargeting } from '../../../src/config/animals';
import type { AnimalId, FighterState } from '../../../src/core/types';
import { DEG2RAD } from '../../../src/core/math';
import { WALL_RADIUS } from '../../../src/config/arena';
import {
  selectLockTarget,
  previewUltTarget,
  resolveGroundPoint,
  resolveUltTarget,
  lineEndPoint,
  clipRayToArena,
  bodyInLine,
  distToSegment2D,
  isStateUntargetable,
  DEFAULT_LOCK_CONE_DEG,
} from '../../../src/sim/ultimates/targeting';
import { aimPointDist } from '../../../src/sim/ultimates/common';

/** State of `animal` at polar offset from the origin: `dist` m away, `deg` degrees off +Z (toward +X). */
function at(id: number, animal: AnimalId, dist: number, deg = 0, y = 0): FighterState {
  const a = deg * DEG2RAD;
  const f = makeFighter(id, animal, Math.sin(a) * dist, Math.cos(a) * dist, 0);
  f.state.pos.y = y;
  return f.state;
}

const LOCK12: UltTargeting = { kind: 'lock', range: 12 };

describe('selectLockTarget — range and cone', () => {
  const me = at(0, 'lion', 0);

  it('locks a foe inside range and the default 70° cone', () => {
    expect(DEFAULT_LOCK_CONE_DEG).toBe(70);
    expect(selectLockTarget(me, [me, at(1, 'hippo', 8)], LOCK12, { aimYaw: 0 })).toBe(1);
    expect(selectLockTarget(me, [me, at(1, 'hippo', 8, 30)], LOCK12, { aimYaw: 0 })).toBe(1);
  });

  it('rejects foes beyond range (measured to the body edge) and outside the cone', () => {
    const r = ANIMALS.hippo.radius;
    expect(selectLockTarget(me, [me, at(1, 'hippo', 12 + r - 0.01)], LOCK12, { aimYaw: 0 })).toBe(1);
    expect(selectLockTarget(me, [me, at(1, 'hippo', 12 + r + 0.05)], LOCK12, { aimYaw: 0 })).toBe(-1);
    expect(selectLockTarget(me, [me, at(1, 'hippo', 8, 60)], LOCK12, { aimYaw: 0 })).toBe(-1); // 60° off > 35° half-cone
    expect(selectLockTarget(me, [me, at(1, 'hippo', 8, 180)], LOCK12, { aimYaw: 0 })).toBe(-1); // behind
  });

  it('honours a custom coneDeg', () => {
    const wide: UltTargeting = { kind: 'lock', range: 12, coneDeg: 180 };
    expect(selectLockTarget(me, [me, at(1, 'hippo', 8, 80)], wide, { aimYaw: 0 })).toBe(1);
    const narrow: UltTargeting = { kind: 'lock', range: 12, coneDeg: 20 };
    expect(selectLockTarget(me, [me, at(1, 'hippo', 8, 25)], narrow, { aimYaw: 0 })).toBe(-1);
  });

  it('uses the aim yaw, not the body facing, when given', () => {
    const t = at(1, 'hippo', 8, 90); // due +X
    expect(selectLockTarget(me, [me, t], LOCK12, { aimYaw: 0 })).toBe(-1);
    expect(selectLockTarget(me, [me, t], LOCK12, { aimYaw: Math.PI / 2 })).toBe(1);
    // Without aimYaw it falls back to the attacker's yaw (facing +Z here).
    expect(selectLockTarget(me, [me, t], LOCK12)).toBe(-1);
  });

  it('never selects the attacker or the dead', () => {
    const dead = at(1, 'hippo', 5);
    dead.alive = false;
    expect(selectLockTarget(me, [me, dead], LOCK12, { aimYaw: 0 })).toBe(-1);
  });
});

describe('selectLockTarget — tie-breaks', () => {
  const me = at(0, 'lion', 0);

  it('smallest angle wins over a nearer, more off-axis foe', () => {
    const near = at(1, 'hippo', 4, 20);
    const far = at(2, 'hippo', 9, 3);
    expect(selectLockTarget(me, [me, near, far], LOCK12, { aimYaw: 0 })).toBe(2);
  });

  it('equal angle: the nearer foe wins', () => {
    const far = at(1, 'hippo', 9, 0);
    const near = at(2, 'hippo', 5, 0);
    expect(selectLockTarget(me, [me, far, near], LOCK12, { aimYaw: 0 })).toBe(2);
  });

  it('equal angle and distance: the lowest id wins regardless of array order', () => {
    const a = at(1, 'hippo', 7, 20);
    const b = at(2, 'hippo', 7, -20);
    expect(selectLockTarget(me, [me, b, a], LOCK12, { aimYaw: 0 })).toBe(1);
    expect(selectLockTarget(me, [me, a, b], LOCK12, { aimYaw: 0 })).toBe(1);
  });

  it('is deterministic across repeated calls', () => {
    const list = [me, at(1, 'gorilla', 6, 12), at(2, 'rhino', 6, -12), at(3, 'mole', 3, 30)];
    const first = selectLockTarget(me, list, LOCK12, { aimYaw: 0 });
    for (let i = 0; i < 20; i++) expect(selectLockTarget(me, list, LOCK12, { aimYaw: 0 })).toBe(first);
  });
});

describe('selectLockTarget — untargetable and altitude', () => {
  const me = at(0, 'lion', 0);

  it('skips a burrowed mole (state-derived) and honours an explicit predicate', () => {
    const mole = at(1, 'mole', 6);
    mole.action = 'burrowed';
    mole.burrowT = 2;
    expect(isStateUntargetable(mole)).toBe(true);
    expect(selectLockTarget(me, [me, mole], LOCK12, { aimYaw: 0 })).toBe(-1);

    const ok = at(2, 'hippo', 6);
    expect(selectLockTarget(me, [me, ok], LOCK12, { aimYaw: 0, isUntargetable: (s) => s.id === 2 })).toBe(-1);
    expect(selectLockTarget(me, [me, ok], LOCK12, { aimYaw: 0, isUntargetable: () => false })).toBe(2);
  });

  it('skips an eagle mid Death-From-Above soar', () => {
    const eagle = at(1, 'eagle', 6);
    eagle.action = 'ultimate';
    eagle.ultPhase = 'windup';
    expect(isStateUntargetable(eagle)).toBe(true);
    expect(selectLockTarget(me, [me, eagle], { ...LOCK12, hitsAir: true }, { aimYaw: 0 })).toBe(-1);
  });

  it('ignores high flyers unless hitsAir (altitude above the ground-reach limit)', () => {
    const eagle = at(1, 'eagle', 6, 0, 4);
    expect(selectLockTarget(me, [me, eagle], LOCK12, { aimYaw: 0 })).toBe(-1);
    expect(selectLockTarget(me, [me, eagle], { ...LOCK12, hitsAir: true }, { aimYaw: 0 })).toBe(1);
    const low = at(2, 'eagle', 6, 0, 1.6); // gliding height is still reachable
    expect(selectLockTarget(me, [me, low], LOCK12, { aimYaw: 0 })).toBe(2);
  });
});

describe('previewUltTarget', () => {
  const me = at(0, 'lion', 0);

  it('lock: valid with a target (to = its position), invalid otherwise (to = end of range along aim)', () => {
    const t = at(1, 'hippo', 8, 10);
    const p = previewUltTarget({ targeting: LOCK12 }, me, [me, t], { aimYaw: 0 });
    expect(p.kind).toBe('lock');
    expect(p.valid).toBe(true);
    expect(p.targetId).toBe(1);
    expect(p.to.x).toBeCloseTo(t.pos.x, 6);
    expect(p.to.z).toBeCloseTo(t.pos.z, 6);
    expect(p.range).toBe(12);
    const none = previewUltTarget({ targeting: LOCK12 }, me, [me], { aimYaw: 0 });
    expect(none.valid).toBe(false);
    expect(none.targetId).toBe(-1);
    expect(none.to.z).toBeCloseTo(12, 6);
    expect(none.to.x).toBeCloseTo(0, 6);
  });

  it('self / missing targeting: always valid, from = to = caster', () => {
    const s = previewUltTarget({ targeting: { kind: 'self', range: 8, radius: 8 } }, me, [me]);
    expect(s).toMatchObject({ kind: 'self', valid: true, targetId: -1, range: 8, width: 16 });
    expect(s.to).toEqual(s.from);
    const none = previewUltTarget({}, me, [me]);
    expect(none.kind).toBe('self');
    expect(none.valid).toBe(true);
  });

  it('line: runs along the aim yaw at full range and is clipped by the arena wall', () => {
    const spec = { targeting: { kind: 'line', range: 10, width: 2 } as UltTargeting };
    const p = previewUltTarget(spec, me, [me], { aimYaw: Math.PI / 2 });
    expect(p.kind).toBe('line');
    expect(p.valid).toBe(true);
    expect(p.width).toBe(2);
    expect(p.to.x).toBeCloseTo(10, 6);
    expect(p.to.z).toBeCloseTo(0, 6);

    const edge = at(0, 'lion', 27.5);
    const clipped = previewUltTarget(spec, edge, [edge], { aimYaw: 0 });
    expect(clipped.to.z).toBeCloseTo(WALL_RADIUS - 0.5, 4);
    expect(clipped.range).toBe(10); // the requested range is still reported
  });

  it('line with coneDeg is lock-assisted; requireTarget without a candidate is invalid', () => {
    const assisted: UltTargeting = { kind: 'line', range: 18, width: 1.6, coneDeg: 30 };
    const t = at(1, 'hippo', 10, 8);
    const p = previewUltTarget({ targeting: assisted }, me, [me, t], { aimYaw: 0 });
    expect(p.targetId).toBe(1);
    expect(p.to.x).toBeCloseTo(t.pos.x, 6);
    expect(p.valid).toBe(true);
    // No candidate: line still valid (unassisted) ...
    expect(previewUltTarget({ targeting: assisted }, me, [me], { aimYaw: 0 }).valid).toBe(true);
    // ... unless it requires a target.
    const strict: UltTargeting = { ...assisted, requireTarget: true };
    expect(previewUltTarget({ targeting: strict }, me, [me], { aimYaw: 0 }).valid).toBe(false);
    expect(previewUltTarget({ targeting: strict }, me, [me, t], { aimYaw: 0 }).valid).toBe(true);
  });

  it('ground: snaps onto the foe on the aim line, else max range; zone width = 2 × radius', () => {
    const tg: UltTargeting = { kind: 'ground', range: 10, radius: 4.5 };
    const t = at(1, 'hippo', 6.5, 5);
    const p = previewUltTarget({ targeting: tg }, me, [me, t], { aimYaw: 0 });
    expect(p.kind).toBe('ground');
    expect(p.targetId).toBe(1);
    expect(p.width).toBe(9);
    expect(Math.hypot(p.to.x, p.to.z)).toBeCloseTo(Math.hypot(t.pos.x, t.pos.z) * 1, 0); // along the aim line at ~its range
    const empty = previewUltTarget({ targeting: tg }, me, [me], { aimYaw: 0 });
    expect(empty.targetId).toBe(-1);
    expect(empty.to.z).toBeCloseTo(10, 6);
    const strict = { ...tg, requireTarget: true };
    expect(previewUltTarget({ targeting: strict }, me, [me], { aimYaw: 0 }).valid).toBe(false);
    expect(previewUltTarget({ targeting: strict }, me, [me, t], { aimYaw: 0 }).valid).toBe(true);
  });
});

describe('ground-point snap matches the sim aimPointDist', () => {
  const cases: { name: string; foes: [AnimalId, number, number][]; aim: number; range: number }[] = [
    { name: 'nobody', foes: [], aim: 0.3, range: 8 },
    { name: 'one on the line', foes: [['hippo', 5, 0]], aim: 0, range: 8 },
    { name: 'one slightly off-line', foes: [['gorilla', 6, 12]], aim: 0, range: 10 },
    { name: 'too close (min snap)', foes: [['rhino', 1, 0]], aim: 0, range: 8 },
    { name: 'beyond range + slack', foes: [['hippo', 9.6, 0]], aim: 0, range: 8 },
    { name: 'two on the line: nearest wins', foes: [['hippo', 7, 0], ['mole', 4, 3]], aim: 0, range: 10 },
    { name: 'lateral miss', foes: [['mole', 6, 45]], aim: 0, range: 10 },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const fighters = [makeFighter(0, 'eagle', 0, 0, 0)];
      c.foes.forEach(([animal, dist, deg], i) => {
        const a = deg * DEG2RAD;
        fighters.push(makeFighter(i + 1, animal, Math.sin(a) * dist, Math.cos(a) * dist, 0));
      });
      fighters[0].intent.aimYaw = c.aim;
      const sim = makeSim(fighters);
      const simDist = aimPointDist(sim, fighters[0], c.range);
      const gp = resolveGroundPoint(fighters[0].state, fighters.map((f) => f.state), { kind: 'ground', range: c.range }, { aimYaw: c.aim });
      expect(gp.dist).toBeCloseTo(simDist, 9);
    });
  }

  it('the sim-side resolver (real untargetable flag) agrees with the pure one', () => {
    const me = makeFighter(0, 'mole', 0, 0, 0);
    const foe = makeFighter(1, 'hippo', 0, 6, 0);
    foe.untargetable = true; // e.g. mid-burrow
    const sim = makeSim([me, foe]);
    me.intent.aimYaw = 0;
    const spec = ANIMALS.mole.ultimate;
    const r = resolveUltTarget(sim, me, spec);
    expect(r.targetId).toBe(-1);
    expect(r.to.z).toBeCloseTo(spec.targeting!.range, 6);
    foe.untargetable = false;
    expect(resolveUltTarget(sim, me, spec).targetId).toBe(1);
  });
});

describe('geometry helpers', () => {
  it('clipRayToArena / lineEndPoint stop inside the wall', () => {
    expect(clipRayToArena(0, 0, 0, 1, 100)).toBeCloseTo(WALL_RADIUS - 0.5, 6);
    expect(clipRayToArena(0, 0, 0, 1, 5)).toBe(5);
    expect(clipRayToArena(WALL_RADIUS, 0, 1, 0, 5)).toBe(0); // already outside
    const me = at(0, 'lion', 0);
    const e = lineEndPoint(me, 0, 100);
    expect(e.z).toBeCloseTo(WALL_RADIUS - 0.5, 6);
  });

  it('distToSegment2D / bodyInLine', () => {
    expect(distToSegment2D(1, 1, 0, 0, 4, 0)).toBeCloseTo(1, 9);
    expect(distToSegment2D(-3, 0, 0, 0, 4, 0)).toBeCloseTo(3, 9); // clamps to the end
    const from = { x: 0, y: 0, z: 0 };
    const to = { x: 0, y: 0, z: 10 };
    expect(bodyInLine(from, to, 2, 1.4, 5, 0.5)).toBe(true); // 1.4 <= 1 + 0.5
    expect(bodyInLine(from, to, 2, 1.6, 5, 0.5)).toBe(false);
  });
});

describe('placeholder targeting in config (v1.3 R0)', () => {
  const expected: Record<AnimalId, string> = {
    lion: 'lock', // v1.3 phase 2: Royal Hunt locks a victim
    gorilla: 'line', // v1.3 phase 2: Boulder Hurl is a lock-assisted line (never required)
    crocodile: 'lock', // v1.3 phase 2: Death Roll locks a victim
    hippo: 'line', // v1.3 phase 2: Riverlord's Flood is an 11 m x 3.4 m line (never required)
    rhino: 'line', // v1.3 phase 2: Seismic Stampede is a lock-assisted (homing) line (never required)
    eagle: 'lock', // v1.3 phase 2: Death From Above locks a victim
    panther: 'lock', // v1.3 phase 2: Shadow Execution locks a victim
    python: 'lock', // v1.3 phase 2: Coil Snare locks a victim
    giraffe: 'lock', // v1.3 phase 2: Timber Fall locks a victim
    mole: 'ground',
  };
  for (const id of Object.keys(expected) as AnimalId[]) {
    it(`${id} ultimate declares ${expected[id]} targeting${expected[id] === 'lock' ? ' and requires a target (fizzles without one)' : ' and never requires a target yet'}`, () => {
      const tg = ANIMALS[id].ultimate.targeting;
      expect(tg).toBeDefined();
      expect(tg!.kind).toBe(expected[id]);
      if (expected[id] === 'lock') expect(tg!.requireTarget).toBe(true);
      else expect(tg!.requireTarget).toBeUndefined();
    });
  }
});
