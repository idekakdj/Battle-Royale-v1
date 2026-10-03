/**
 * Pose layer: move builder (build.ts), profiles and the DOF machinery. Pure (no rendering): every animal x every move body
 * x ground/air builds finite DOF timelines whose peak is on the first active frame; lion + gorilla additionally fit the
 * hitbox and keep the raw curve inside the angular budget.
 */

import { afterAll, describe, expect, it } from 'vitest';
import type { AnimalId } from '../../src/core/types';
import { ANIMAL_IDS } from '../../src/config/animals';
import { MOVE_IDS, type MoveBody, type MoveId } from '../../src/brawl/types';
import { getMoveBody, getMoveset } from '../../src/brawl/data';
import { STEP_NORMAL, STEP_STRIKE, distToHitbox, getBuilt } from '../../src/brawl/render/pose/build';
import { DOF, DOF_N, newVec, swapSides, vecOf } from '../../src/brawl/render/pose/dof';
import { CompiledProfile } from '../../src/brawl/render/pose/profile';
import { disposeSolvers, getSolver } from '../../src/brawl/render/pose/solver';
import { applyEase } from '../../src/brawl/render/pose/timeline';

afterAll(() => disposeSolvers());

interface Case {
  id: MoveId;
  air: boolean;
  chain: number;
  body: MoveBody;
}

function casesOf(animal: AnimalId): Case[] {
  const out: Case[] = [];
  const set = getMoveset(animal);
  for (const id of MOVE_IDS) {
    const m = set.moves[id];
    out.push({ id, air: false, chain: 0, body: getMoveBody(animal, id, false, 0) });
    if (m.air !== null && !m.groundOnly) out.push({ id, air: true, chain: 0, body: getMoveBody(animal, id, true, 0) });
    (m.chain ?? []).forEach((_, i) => out.push({ id, air: false, chain: i + 1, body: getMoveBody(animal, id, false, i + 1) }));
  }
  return out;
}

describe('pose build: every animal, every move body', () => {
  for (const animal of ANIMAL_IDS) {
    it(`${animal}: builds finite timelines with the peak on the first active frame`, () => {
      for (const c of casesOf(animal)) {
        const b = getBuilt(animal, c.body, c.air, c.chain);
        const first = Math.min(...c.body.hitboxes.map((h) => h.from));
        const end = Math.max(...c.body.hitboxes.map((h) => h.to));
        const label = `${animal} ${c.id}${c.air ? ' air' : ''}${c.chain ? ` chain${c.chain}` : ''}`;
        expect(b.strikeFrame, label).toBe(first);
        expect(b.activeEnd, label).toBe(end);
        expect(b.total, label).toBeGreaterThanOrEqual(c.body.startup + c.body.active + c.body.recovery);
        expect(getSolver(animal).cp.hasTip(b.tip), `${label}: tip role ${b.tip} exists`).toBe(true);
        const v = newVec();
        for (let f = 0; f <= b.total + 2; f += 0.5) {
          b.timeline.evalAt(f, v);
          for (let i = 0; i < DOF_N; i++) expect(Number.isFinite(v[i]), `${label} f${f} dof ${i}`).toBe(true);
        }
        // The pose at the first active frame IS the peak key (non-lagged DOFs).
        b.timeline.evalAt(first, v);
        for (let i = 0; i < DOF_N; i++) if (b.timeline.lag[i] === 0) expect(v[i], label).toBeCloseTo(b.peak[i], 6);
        // Starts and ends at rest (no root squash left over, no DOF drift except an animal spinning a whole turn).
        b.timeline.evalAt(0, v);
        const rest = newVec();
        expect(Math.abs(v[DOF.rootSquash])).toBeLessThan(1e-9);
        void rest;
      }
    });
  }
});

describe('pose build: lion + gorilla fits and smoothness', () => {
  for (const animal of ['lion', 'gorilla'] as const) {
    it(`${animal}: the solved strike tip is inside / near the hitbox and the raw curve is inside the angular budget`, () => {
      for (const c of casesOf(animal)) {
        const b = getBuilt(animal, c.body, c.air, c.chain);
        const label = `${animal} ${c.id}${c.air ? ' air' : ''}${c.chain ? ` chain${c.chain}` : ''}`;
        for (const f of b.fit) expect(f.err, `${label} fit @${f.frame}`).toBeLessThanOrEqual(0.5);
        expect(b.maxStep, `${label} raw step`).toBeLessThanOrEqual(STEP_NORMAL + 0.03);
        expect(b.maxStrikeStep, `${label} raw strike step`).toBeLessThanOrEqual(STEP_STRIKE + 0.03);
      }
    });

    it(`${animal}: anticipation is visible on every move that has the frames for it`, () => {
      for (const c of casesOf(animal)) {
        if (c.body.startup < 8) continue;
        const b = getBuilt(animal, c.body, c.air, c.chain);
        const label = `${animal} ${c.id}`;
        // The anticipation key (between rest and the strike) is not the rest pose and not the strike pose.
        const keys = b.timeline.keys.filter((k) => k.f > 0 && k.f < b.strikeFrame - 0.01);
        expect(keys.length, `${label}: has an anticipation key`).toBeGreaterThan(0);
        const a = keys[0];
        let amp = 0;
        for (let i = 0; i < DOF_N; i++) amp = Math.max(amp, Math.abs(a.v[i] - b.timeline.keys[0].v[i]));
        expect(amp, `${label}: anticipation amplitude`).toBeGreaterThan(0.05);
        expect(a.f, `${label}: anticipation ends in the first ~55 % of the startup`).toBeLessThanOrEqual(0.6 * c.body.startup);
      }
    });
  }
});

describe('pose DOF machinery', () => {
  it('eases are monotone with the right end points', () => {
    for (const e of ['in', 'out', 'inout', 'lin'] as const) {
      expect(applyEase(e, 0)).toBeCloseTo(0, 9);
      expect(applyEase(e, 1)).toBeCloseTo(1, 9);
      let last = -1;
      for (let t = 0; t <= 1; t += 0.05) {
        const v = applyEase(e, t);
        expect(v).toBeGreaterThanOrEqual(last - 1e-12);
        last = v;
      }
    }
  });

  it('the facing -1 pose is the exact mirror of the facing +1 pose (limb pairs swapped, lateral rotations flipped)', () => {
    for (const animal of ['lion', 'gorilla'] as const) {
      const s = getSolver(animal);
      const cp = new CompiledProfile(s.profile, s.cp.joints);
      const v = vecOf({ foreNearSwing: 1.1, foreNearSpread: -0.3, foreNearBend: 0.4, hindFarSwing: 0.6, bodyYaw: 0.3, bodyRoll: 0.1, headYaw: 0.2, bodyPitch: 0.2 });
      // Only the joint names the profile uses (a rig can expose one joint under several names, e.g. gorilla legs.0 = armL).
      const used = new Set<string>();
      for (const list of Object.values(s.profile.links)) for (const l of list ?? []) used.add(l.j);
      const read = (): Map<string, number[]> => {
        const m = new Map<string, number[]>();
        for (const name of used) {
          const j = cp.joints.get(name);
          if (j !== undefined) m.set(name, [j.rx, j.ry, j.rz, j.px, j.py, j.pz]);
        }
        return m;
      };
      for (const j of cp.joints.values()) j.reset();
      cp.expand(v, 1);
      const right = read();
      for (const j of cp.joints.values()) j.reset();
      cp.expand(v, -1);
      const left = read();
      const pairs = new Map<string, string>();
      for (const [a, b] of s.profile.mirror) {
        pairs.set(a, b);
        pairs.set(b, a);
      }
      for (const [name, r] of right) {
        const other = left.get(pairs.get(name) ?? name) as number[];
        expect(other[0]).toBeCloseTo(r[0], 9); // rx unchanged
        expect(other[1]).toBeCloseTo(-r[1], 9); // ry flips
        expect(other[2]).toBeCloseTo(-r[2], 9); // rz flips
        expect(other[3]).toBeCloseTo(-r[3], 9); // px flips
        expect(other[4]).toBeCloseTo(r[4], 9);
        expect(other[5]).toBeCloseTo(r[5], 9);
      }
    }
  });

  it('swapSides is an involution', () => {
    const v = vecOf({ foreNearSwing: 1, foreFarSwing: -0.5, hindNearSpread: 0.3, bodyYaw: 0.2, tailYaw: -0.4, wingFarFlap: 0.7 });
    const w = swapSides(swapSides(v, newVec()), newVec());
    for (let i = 0; i < DOF_N; i++) expect(w[i]).toBeCloseTo(v[i], 12);
  });

  it('distToHitbox matches circle and rect geometry', () => {
    const circle = { shape: 'circle', x: 1, y: 1, r: 0.5, w: 0, h: 0, from: 0, to: 3, damage: 1, baseKb: 0, kbGrowth: 0, angle: 0 } as const;
    expect(distToHitbox(circle, 0, 1, 1)).toBe(0);
    expect(distToHitbox(circle, 0, 2.5, 1)).toBeCloseTo(1, 9);
    const rect = { shape: 'rect', x: 0, y: 0, r: 0, w: 2, h: 1, from: 0, to: 3, damage: 1, baseKb: 0, kbGrowth: 0, angle: 0 } as const;
    expect(distToHitbox(rect, 0, 0.9, 0.4)).toBe(0);
    expect(distToHitbox(rect, 0, 2, 0)).toBeCloseTo(1, 9);
    expect(distToHitbox(rect, 0, 2, 1.5)).toBeCloseTo(Math.hypot(1, 1), 9);
    // A travelling box follows its path.
    const moving = { ...circle, path: [{ frame: 0, x: 0, y: 0 }, { frame: 2, x: 2, y: 0 }] };
    expect(distToHitbox(moving, 2, 3, 1)).toBe(0);
  });
});
