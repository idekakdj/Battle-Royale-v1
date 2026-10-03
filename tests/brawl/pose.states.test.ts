/**
 * Pose layer: generic states (plan §6.7) for every animal, facing flips, subframe purity, hidden-when-KO,
 * run -> attack entry continuity and the 120 Hz == 60 Hz purity of the move pose.
 */

import { afterAll, describe, expect, it } from 'vitest';
import type { AnimalId } from '../../src/core/types';
import { ANIMAL_IDS } from '../../src/config/animals';
import type { BrawlAction, BrawlFighterState } from '../../src/brawl/types';
import { getMoveBody } from '../../src/brawl/data';
import { BrawlRig, FACE_YAW } from '../../src/brawl/render/pose/BrawlRig';
import { disposeSolvers } from '../../src/brawl/render/pose/solver';
import { Recorder, hasNaN, mkState, nodesOf, runMove, tipToHitbox } from './poseHelpers';

const rigs = new Map<AnimalId, BrawlRig>();
function rigOf(a: AnimalId): BrawlRig {
  let r = rigs.get(a);
  if (r === undefined) {
    r = new BrawlRig(a);
    rigs.set(a, r);
  }
  return r;
}
afterAll(() => {
  for (const r of rigs.values()) r.dispose();
  disposeSolvers();
});

interface Seg {
  action: BrawlAction;
  frames: number;
  grounded: boolean;
  vx?: number;
  vy?: number;
  lastLaunch?: { angle: number; speed: number };
  /** Largest allowed joint step on entering / inside this segment (rad per 60 Hz frame). */
  cap?: number;
}

const SEQUENCE: Seg[] = [
  { action: 'idle', frames: 10, grounded: true },
  { action: 'run', frames: 14, grounded: true, vx: 8 },
  { action: 'walk', frames: 8, grounded: true, vx: 4 },
  { action: 'jumpSquat', frames: 4, grounded: true },
  { action: 'rise', frames: 14, grounded: false, vy: 12 },
  { action: 'fall', frames: 14, grounded: false, vy: -8 },
  { action: 'fastFall', frames: 8, grounded: false, vy: -24 },
  { action: 'landing', frames: 8, grounded: true },
  { action: 'crouch', frames: 8, grounded: true },
  { action: 'dodgeSpot', frames: 26, grounded: true, cap: 0.9 },
  { action: 'dodgeRoll', frames: 26, grounded: true, vx: 6, cap: 0.9 },
  { action: 'idle', frames: 6, grounded: true },
  { action: 'fall', frames: 4, grounded: false, vy: -4 },
  { action: 'dodgeAir', frames: 26, grounded: false, cap: 0.9 },
  { action: 'fall', frames: 4, grounded: false, vy: -4 },
  { action: 'hitstun', frames: 20, grounded: false, lastLaunch: { angle: 30, speed: 30 }, cap: 1.15 },
  { action: 'tumble', frames: 40, grounded: false, lastLaunch: { angle: 30, speed: 40 }, cap: 1.15 },
  { action: 'fall', frames: 6, grounded: false, vy: -10 },
  { action: 'landing', frames: 6, grounded: true },
  { action: 'knockdown', frames: 30, grounded: true },
  { action: 'getup', frames: 22, grounded: true },
  { action: 'idle', frames: 6, grounded: true },
  { action: 'fall', frames: 4, grounded: false, vy: -3 },
  { action: 'ledgeHang', frames: 30, grounded: false },
  { action: 'ledgeClimb', frames: 22, grounded: false },
  { action: 'respawn', frames: 20, grounded: true },
  { action: 'idle', frames: 10, grounded: true },
];

describe('pose states: all animals', () => {
  for (const animal of ANIMAL_IDS) {
    it(`${animal}: every state is finite, smooth and returns upright`, () => {
      const rig = rigOf(animal);
      const rec = new Recorder(rig);
      let prev: BrawlFighterState | null = null;
      let worst = 0;
      for (const seg of SEQUENCE) {
        for (let i = 0; i < seg.frames; i++) {
          const cur = mkState(animal, {
            facing: 1,
            action: seg.action,
            actionFrame: i,
            actionFrames: seg.action === 'idle' || seg.action === 'run' || seg.action === 'walk' || seg.action === 'fall' || seg.action === 'rise' || seg.action === 'fastFall' ? 0 : seg.frames,
            grounded: seg.grounded,
            pos: { x: 0, y: seg.grounded ? 0 : 3 },
            vel: { x: seg.vx ?? 0, y: seg.vy ?? 0 },
            lastLaunch: seg.lastLaunch ?? null,
            hitstunTotal: seg.action === 'hitstun' ? 20 : 0,
          });
          rig.update(cur, prev, 1, 1 / 60);
          expect(hasNaN(rig), `${animal} ${seg.action} frame ${i}`).toBe(false);
          const e = rec.sample(-1, false);
          if (prev !== null) {
            expect(e.step, `${animal}: ${seg.action} frame ${i} step ${e.step.toFixed(3)}`).toBeLessThanOrEqual((seg.cap ?? 0.5) + 1e-4);
            worst = Math.max(worst, e.step);
          }
          prev = cur;
        }
      }
      expect(worst).toBeGreaterThan(0);
      // After the whole sequence the body is upright and unsquashed again.
      expect(Math.abs(rig.squashNow)).toBeLessThan(0.05);
      expect(rig.root.visible).toBe(true);
    });
  }
});

describe('pose root transform', () => {
  it('turns the yaw to +-(90 - 22) degrees within ~4-6 frames and starts there', () => {
    const rig = new BrawlRig('lion');
    let prev: BrawlFighterState | null = null;
    const feed = (facing: 1 | -1): void => {
      const cur = mkState('lion', { facing, action: 'idle' });
      rig.update(cur, prev, 1, 1 / 60);
      prev = cur;
    };
    feed(1);
    expect(rig.yawAngle).toBeCloseTo(FACE_YAW, 6);
    feed(-1);
    const first = rig.yawAngle;
    expect(first).toBeLessThan(FACE_YAW);
    expect(first).toBeGreaterThan(-FACE_YAW);
    let frames = 1;
    while (Math.abs(rig.yawAngle + FACE_YAW) > 0.02 && frames < 20) {
      feed(-1);
      frames++;
    }
    expect(frames).toBeGreaterThanOrEqual(3);
    expect(frames).toBeLessThanOrEqual(7);
    rig.dispose();
  });

  it('is hidden while the fighter is KO\'d and shows again on respawn', () => {
    const rig = rigOf('gorilla');
    rig.update(mkState('gorilla', { alive: false, action: 'ko' }), null, 1, 1 / 60);
    expect(rig.root.visible).toBe(false);
    rig.update(mkState('gorilla', { action: 'respawn' }), null, 1, 1 / 60);
    expect(rig.root.visible).toBe(true);
  });

  it('interpolates the position between snapshots and snaps on a teleport', () => {
    const rig = rigOf('lion');
    const a = mkState('lion', { pos: { x: 0, y: 0 } });
    const b = mkState('lion', { pos: { x: 1, y: 0.5 } });
    rig.update(b, a, 0.5, 1 / 60);
    expect(rig.root.position.x).toBeCloseTo(0.5, 6);
    expect(rig.root.position.y).toBeCloseTo(0.25, 6);
    const c = mkState('lion', { pos: { x: 12, y: 8 } });
    rig.update(c, b, 0.5, 1 / 60);
    expect(rig.root.position.x).toBeCloseTo(12, 6);
  });
});

describe('pose purity and continuity', () => {
  it('a move pose does not depend on the display rate: 120 Hz sub-frames land on the 60 Hz pose', () => {
    for (const animal of ['lion', 'gorilla'] as const) {
      const a = new BrawlRig(animal);
      const b = new BrawlRig(animal);
      const body = getMoveBody(animal, 'heavyS', false, 0);
      const first = Math.min(...body.hitboxes.map((h) => h.from));
      const ra = runMove(a, animal, 'heavyS', false, 0, { substeps: 1 });
      const rb = runMove(b, animal, 'heavyS', false, 0, { substeps: 2 });
      for (let k = first; k < first + body.active; k++) {
        const ta = ra.rec.log[ra.moveStart + k].tip as { x: number; y: number };
        const tb = rb.rec.log[rb.moveStart + k].tip as { x: number; y: number };
        expect(Math.abs(ta.x - tb.x)).toBeLessThan(0.05);
        expect(Math.abs(ta.y - tb.y)).toBeLessThan(0.05);
      }
      // The two rigs end in the same joint pose (up to the cross-fade tails).
      const na = nodesOf(a);
      const nb = nodesOf(b);
      let worst = 0;
      for (let i = 0; i < na.length; i++) worst = Math.max(worst, 2 * Math.acos(Math.min(1, Math.abs(na[i].quaternion.dot(nb[i].quaternion)))));
      expect(worst).toBeLessThan(0.05);
      a.dispose();
      b.dispose();
    }
  });

  it('attacks that start from a full run stay smooth and still reach the hitbox on the first active frame', () => {
    for (const animal of ['lion', 'gorilla'] as const) {
      const rig = rigOf(animal);
      for (const id of ['lightN', 'lightS', 'heavyS', 'heavyD'] as const) {
        const run = runMove(rig, animal, id, false, 0, { preAction: 'run', preVx: 8 });
        const body = run.body;
        const first = Math.min(...body.hitboxes.map((h) => h.from));
        const end = Math.max(...body.hitboxes.map((h) => h.to));
        for (let i = 1; i < run.rec.log.length; i++) {
          const k = run.rec.log[i].k;
          const strike = k >= first - 2 && k <= end - 1;
          expect(run.rec.log[i].step, `${animal} ${id} from run: step at log ${i}`).toBeLessThanOrEqual((strike ? 0.9 : 0.5) + 1e-4);
        }
        const tip = run.rec.log[run.moveStart + first].tip as { x: number; y: number };
        expect(tipToHitbox(body, first, tip), `${animal} ${id}: tip on the first active frame after a run`).toBeLessThanOrEqual(0.5);
      }
    }
  });
});
