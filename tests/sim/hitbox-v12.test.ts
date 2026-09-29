/**
 * v1.2 hitbox fidelity (UPGRADE-PLAN-v1.2 §5b): the basic melee test is a
 * sector–circle overlap — any body that pokes into the swing sector is hit —
 * and every basic swing publishes the exact tested sector as `swingImpact`.
 */
import { describe, it, expect } from 'vitest';
import { meleeArcHit, coneHit, sectorCircleOverlap } from '../../src/sim/hitbox';
import { ANIMALS } from '../../src/config/animals';
import { MOVE } from '../../src/config/balance';
import { DEG2RAD } from '../../src/core/math';
import type { AnimalId, GameEvent, GameEventOf } from '../../src/core/types';
import { DT, makeFighter, liveWorld, neutral, disablePickups } from './helpers';

const H = MOVE.heightOverlap;

/** Target of `animal` at polar (dist, angle from +Z toward +X) around the origin. */
function at(animal: AnimalId, dist: number, angleDeg: number) {
  const a = angleDeg * DEG2RAD;
  return makeFighter(1, animal, Math.sin(a) * dist, Math.cos(a) * dist, 0);
}

/**
 * Brute force: does the body disc truly intersect the sector (sampled)? Disc
 * and sector are shrunk by 1e-6 so exact-boundary float ties don't count.
 */
function trulyOverlaps(rangeIn: number, arcDeg: number, tx: number, tz: number, rIn: number): boolean {
  const half = (arcDeg * DEG2RAD) / 2 - 1e-6;
  const range = rangeIn - 1e-6;
  const r = rIn * (1 - 1e-6);
  for (let i = 0; i <= 12; i++) {
    const rr = (r * i) / 12;
    for (let k = 0; k < 48; k++) {
      const th = (k / 48) * Math.PI * 2;
      const px = tx + Math.cos(th) * rr;
      const pz = tz + Math.sin(th) * rr;
      const d = Math.hypot(px, pz);
      if (d > range) continue;
      if (d < 1e-9) return true;
      if (Math.abs(Math.atan2(px, pz)) <= half) return true;
    }
  }
  return false;
}

function ofType<T extends GameEvent['type']>(events: GameEvent[], type: T): GameEventOf<T>[] {
  return events.filter((e): e is GameEventOf<T> => e.type === type);
}

describe('sector–circle melee test (§5b)', () => {
  const lion = makeFighter(0, 'lion', 0, 0, 0); // faces +Z
  const range = 1.5;
  const arc = 120;

  for (const [animal, r] of [
    ['mole', 0.5],
    ['lion', 0.7],
    ['hippo', 1.2],
  ] as [AnimalId, number][]) {
    it(`reach is measured to the body: ${animal} (r=${r}) hit at the edge, missed just outside`, () => {
      expect(ANIMALS[animal].radius).toBe(r);
      expect(meleeArcHit(lion, at(animal, range + r - 0.01, 0), range, arc, H)).toBe(true);
      expect(meleeArcHit(lion, at(animal, range + r + 0.01, 0), range, arc, H)).toBe(false);
    });

    it(`the arc edge is padded by the body: ${animal} (r=${r})`, () => {
      const d = 1.6;
      const pad = Math.asin(Math.min(1, r / d)) / DEG2RAD;
      expect(meleeArcHit(lion, at(animal, d, arc / 2 + pad - 0.5), range, arc, H)).toBe(true);
      expect(meleeArcHit(lion, at(animal, d, arc / 2 + pad + 0.5), range, arc, H)).toBe(false);
      // Without the padding a body half inside the arc edge used to be missed.
      expect(meleeArcHit(lion, at(animal, d, arc / 2 + pad * 0.5), range, arc, H)).toBe(true);
    });
  }

  it('a body overlapping the attacker centre is always hit, even behind', () => {
    expect(meleeArcHit(lion, at('hippo', 1.0, 180), range, arc, H)).toBe(true);
  });

  it('keeps the height tolerance and targetability', () => {
    const t = at('mole', 1.2, 0);
    t.state.pos.y = H + 0.1;
    expect(meleeArcHit(lion, t, range, arc, H)).toBe(false);
    const u = at('mole', 1.2, 0);
    u.untargetable = true;
    expect(meleeArcHit(lion, u, range, arc, H)).toBe(false);
  });

  for (const attacker of ['lion', 'mole'] as AnimalId[]) {
    it(`${attacker} regression: never misses a body that visibly overlaps its real sector (all sizes, angles)`, () => {
      const def = ANIMALS[attacker];
      const a = makeFighter(0, attacker, 0, 0, 0);
      let hits = 0;
      for (const target of ['mole', 'eagle', 'lion', 'gorilla', 'crocodile', 'hippo'] as AnimalId[]) {
        const r = ANIMALS[target].radius;
        for (let k = 2; k <= Math.round((def.range + r + 0.6) * 20); k++) {
          const d = k / 20;
          for (let ang = -180; ang < 180; ang += 7.5) {
            const t = at(target, d, ang);
            const truth = trulyOverlaps(def.range, def.arcDeg, t.state.pos.x, t.state.pos.z, r);
            const got = meleeArcHit(a, t, def.range, def.arcDeg, H);
            if (truth) expect(got, `${attacker}→${target} d=${d.toFixed(1)} ang=${ang}`).toBe(true);
            // Straight ahead the test is exact: hit iff the body reaches the sector.
            if (ang === 0 && Math.abs(d - r - def.range) > 1e-6) expect(got).toBe(d - r < def.range);
            if (got) hits++;
          }
        }
      }
      expect(hits).toBeGreaterThan(0);
    });
  }

  it('ability cones get the same angular padding', () => {
    const t = at('hippo', 2.0, 45 + 30); // outside a 90° cone by centre, body pokes in
    expect(coneHit(0, 0, 0, 0, 5, 90, t, H)).toBe(true);
    expect(coneHit(0, 0, 0, 0, 5, 90, at('hippo', 2.0, 45 + 40), H)).toBe(false);
  });

  it('sectorCircleOverlap: 360° sectors are radial only', () => {
    expect(sectorCircleOverlap(0, 0, 0, 2.5, 360, 0, -3.2, 0.8)).toBe(true);
    expect(sectorCircleOverlap(0, 0, 0, 2.5, 360, 0, -3.4, 0.8)).toBe(false);
  });
});

describe('swingImpact event (§5b)', () => {
  it('fires at the impact tick of every basic swing with the exact tested sector', () => {
    const { world, events } = liveWorld(['lion', 'mole'], 5);
    disablePickups(world);
    const lionF = world.fighters[0];
    const moleF = world.fighters[1];
    lionF.state.pos = { x: 0, y: 0, z: -18 };
    moleF.state.pos = { x: 0.4, y: 0, z: -18 + ANIMALS.lion.range + ANIMALS.mole.radius - 0.1 };
    const press = { ...neutral(), attack: true, aimYaw: 0 };
    world.setIntent(0, press);
    world.setIntent(1, neutral());
    world.step(DT);
    let impactTick = -1;
    for (let i = 0; i < 90 && impactTick < 0; i++) {
      world.setIntent(0, { ...neutral(), aimYaw: 0 });
      world.step(DT);
      if (ofType(events, 'swingImpact').length > 0) impactTick = i;
    }
    const imp = ofType(events, 'swingImpact');
    expect(imp).toHaveLength(1);
    const e = imp[0];
    expect(e.fighterId).toBe(0);
    expect(e.step).toBe(0);
    expect(e.range).toBe(ANIMALS.lion.range);
    expect(e.arcDeg).toBe(ANIMALS.lion.arcDeg);
    expect(e.yaw).toBeCloseTo(lionF.state.yaw, 9);
    expect(e.pos.x).toBeCloseTo(lionF.state.pos.x, 1);
    expect(e.pos.z).toBeCloseTo(lionF.state.pos.z, 1);
    // The hit agrees with the published sector.
    const hit = ofType(events, 'hit').some((h) => h.attackerId === 0 && h.targetId === 1);
    const blocked = ofType(events, 'blocked').some((h) => h.attackerId === 0 && h.targetId === 1);
    const predicted = sectorCircleOverlap(e.pos.x, e.pos.z, e.yaw, e.range, e.arcDeg, moleF.state.pos.x, moleF.state.pos.z, ANIMALS.mole.radius);
    expect(predicted).toBe(true);
    expect(hit || blocked).toBe(predicted);
    expect(impactTick).toBeGreaterThan(0);
  });

  it("gorilla's finisher slam publishes a 360° sector with the slam radius", () => {
    const { world, events } = liveWorld(['gorilla', 'lion'], 5);
    disablePickups(world);
    world.fighters[0].state.pos = { x: 0, y: 0, z: -18 };
    world.fighters[1].state.pos = { x: -20, y: 0, z: 10 };
    // Three chained presses → hit1, hit2, finisher.
    for (let i = 0; i < 240; i++) {
      world.setIntent(0, { ...neutral(), attack: i % 8 === 0, aimYaw: 0 });
      world.setIntent(1, neutral());
      world.step(DT);
    }
    const imps = ofType(events, 'swingImpact').filter((e) => e.fighterId === 0);
    expect(imps.map((e) => e.step).slice(0, 3)).toEqual([0, 1, 2]);
    expect(imps[0].range).toBe(ANIMALS.gorilla.range);
    expect(imps[0].arcDeg).toBe(ANIMALS.gorilla.arcDeg);
    const fin = imps[2];
    expect(fin.arcDeg).toBe(360);
    expect(fin.range).toBe(ANIMALS.gorilla.finisher.radius);
  });
});
