/**
 * WP-P (animation polish) acceptance:
 *  (a) the generic wind-up layer: every move with a startup >= 8 frames has a visible coil in the first ~55 % of its startup,
 *      scaled by weight (heavy > light), and the layer is derived from the move data only;
 *  (b) transitions: run -> attack, attack -> idle / run, fall -> aerial -> landing, attack -> hitstun -> idle never pop. Beyond the
 *      joint-rotation budget of the other pose tests this also bounds the per-frame TRANSLATION of every joint (m), the joint scale
 *      and the root squash;
 *  (c) follow-through: the overshoot is held / eased, never snapped back to the idle pose in one frame.
 * Set P_REPORT=1 to print the worst offenders.
 */

import { afterAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { AnimalId } from '../../src/core/types';
import { MOVE_IDS, type BrawlAction, type BrawlFighterState, type MoveId } from '../../src/brawl/types';
import { getMoveBody, getMoveset } from '../../src/brawl/data';
import { BrawlRig } from '../../src/brawl/render/pose/BrawlRig';
import { getBuilt, STEP_NORMAL, STEP_STRIKE } from '../../src/brawl/render/pose/build';
import { DOF, DOF_N, newVec } from '../../src/brawl/render/pose/dof';
import { disposeSolvers } from '../../src/brawl/render/pose/solver';
import { moveWeight } from '../../src/brawl/render/pose/windup';
import { hasNaN, mkState, nodesOf } from './poseHelpers';
import { ANIMAL_IDS } from '../../src/config/animals';

const REPORT = process.env.P_REPORT === '1';
/** Largest tolerated per-frame joint translation (m) and joint scale change at a transition. */
const MAX_DPOS = 0.3;
const MAX_DSCALE = 0.15;
/** Root squash change per frame. */
const MAX_DSQUASH = 0.09;
const EPS = 1e-4;

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
  moveId?: MoveId;
  air?: boolean;
  chain?: number;
  vx?: number;
  vy?: number;
  grounded?: boolean;
  /** Start the segment this many frames into the move (for interrupted moves). */
  from?: number;
}

interface Sample {
  seg: number;
  k: number;
  rot: number;
  pos: number;
  scale: number;
  squash: number;
}

/** Drive one rig through the segments (60 Hz, one display frame per sim frame) and measure every frame step. */
function drive(rig: BrawlRig, animal: AnimalId, segs: Seg[], facing: 1 | -1 = 1): { samples: Sample[]; nan: boolean } {
  const nodes = nodesOf(rig);
  // The python's tongue is hidden (scale 0) in its idle pose and simply shows while attacking: not a body pop.
  const exempt = new Set<THREE.Object3D>();
  for (const [n, j] of rig.rig.brawlJoints()) if (n === 'tongue') exempt.add(j.node);
  let prevQ: THREE.Quaternion[] | null = null;
  let prevP: THREE.Vector3[] | null = null;
  let prevS: THREE.Vector3[] | null = null;
  let prevSq = 0;
  let prevState: BrawlFighterState | null = null;
  const samples: Sample[] = [];
  let nan = false;
  segs.forEach((seg, si) => {
    for (let i = 0; i < seg.frames; i++) {
      const grounded = seg.grounded ?? !seg.air;
      const k = (seg.from ?? 0) + i;
      let cur: BrawlFighterState;
      if (seg.action === 'attack' && seg.moveId !== undefined) {
        const body = getMoveBody(animal, seg.moveId, seg.air ?? false, seg.chain ?? 0);
        const total = body.startup + body.active + body.recovery;
        cur = mkState(animal, {
          facing,
          action: 'attack',
          moveId: seg.moveId,
          moveAir: seg.air ?? false,
          moveChain: seg.chain ?? 0,
          moveFrame: k,
          moveFrames: total,
          actionFrame: k,
          actionFrames: total,
          grounded,
          pos: { x: 0, y: grounded ? 0 : 3 },
          vel: { x: (seg.vx ?? 0) * facing, y: seg.vy ?? (grounded ? 0 : -1) },
        });
      } else {
        cur = mkState(animal, {
          facing,
          action: seg.action,
          actionFrame: i,
          actionFrames: seg.action === 'idle' || seg.action === 'run' || seg.action === 'walk' ? 0 : seg.frames,
          grounded,
          pos: { x: 0, y: grounded ? 0 : 3 },
          vel: { x: (seg.vx ?? 0) * facing, y: seg.vy ?? (grounded ? 0 : -2) },
          hitstunTotal: seg.action === 'hitstun' ? seg.frames : 0,
          hitstun: seg.action === 'hitstun' ? seg.frames - i : 0,
          lastLaunch: seg.action === 'hitstun' || seg.action === 'tumble' ? { angle: facing === 1 ? 30 : 150, speed: 22 } : null,
        });
      }
      rig.update(cur, prevState, 1, 1 / 60);
      prevState = cur;
      if (hasNaN(rig)) nan = true;
      let rot = 0;
      let pos = 0;
      let scale = 0;
      if (prevQ !== null && prevP !== null && prevS !== null) {
        for (let n = 0; n < nodes.length; n++) {
          const d = Math.min(1, Math.abs(nodes[n].quaternion.dot(prevQ[n])));
          rot = Math.max(rot, 2 * Math.acos(d));
          pos = Math.max(pos, nodes[n].position.distanceTo(prevP[n]));
          if (!exempt.has(nodes[n])) scale = Math.max(scale, nodes[n].scale.distanceTo(prevS[n]));
        }
      }
      prevQ = nodes.map((n) => n.quaternion.clone());
      prevP = nodes.map((n) => n.position.clone());
      prevS = nodes.map((n) => n.scale.clone());
      const sq = rig.squashNow;
      samples.push({ seg: si, k, rot, pos, scale, squash: Math.abs(sq - prevSq) });
      prevSq = sq;
    }
  });
  return { samples, nan };
}

const worst: { label: string; what: string; v: number }[] = [];
function check(label: string, samples: Sample[], segs: Seg[], first: number, end: number): void {
  // Skip the very first frames (the rig starts from its construction pose).
  for (let i = 4; i < samples.length; i++) {
    const s = samples[i];
    const sg = segs[s.seg];
    const strike = sg.action === 'attack' && s.k >= first - 2 && s.k <= end - 1;
    const rotLim = sg.action === 'hitstun' || sg.action === 'tumble' ? 1.15 : strike ? STEP_STRIKE : STEP_NORMAL;
    // Getting hit / touching the ground is an impact: the first two frames of those states may move faster than a voluntary action.
    const impact = (sg.action === 'hitstun' || sg.action === 'landing') && s.k < 2;
    const posLim = impact ? 0.55 : strike ? 0.36 : MAX_DPOS;
    const sqLim = impact ? 0.22 : MAX_DSQUASH;
    worst.push({ label: `${label} f${i} (${sg.action} k${s.k})`, what: 'rot', v: s.rot / (rotLim + EPS) });
    worst.push({ label: `${label} f${i} (${sg.action} k${s.k})`, what: 'pos', v: s.pos / posLim });
    worst.push({ label: `${label} f${i} (${sg.action} k${s.k})`, what: 'scale', v: s.scale / MAX_DSCALE });
    worst.push({ label: `${label} f${i} (${sg.action} k${s.k})`, what: 'squash', v: s.squash / sqLim });
    expect(s.rot, `${label}: rotation step at frame ${i} (${sg.action}, move frame ${s.k})`).toBeLessThanOrEqual(rotLim + EPS);
    expect(s.pos, `${label}: joint translation step at frame ${i} (${sg.action}, move frame ${s.k})`).toBeLessThanOrEqual(posLim);
    // (the python's Constrict squeeze pulses scale the coil on purpose inside the active window)
    expect(s.scale, `${label}: joint scale step at frame ${i} (${sg.action}, move frame ${s.k})`).toBeLessThanOrEqual(strike ? 0.4 : MAX_DSCALE);
    expect(s.squash, `${label}: squash step at frame ${i} (${sg.action}, move frame ${s.k})`).toBeLessThanOrEqual(sqLim);
  }
}

afterAll(() => {
  if (!REPORT) return;
  worst.sort((a, b) => b.v - a.v);
  // eslint-disable-next-line no-console
  console.log('\nWORST\n' + worst.slice(0, 40).map((w) => `${w.v.toFixed(2)} ${w.what} ${w.label}`).join('\n'));
});

function bodyOf(animal: AnimalId, id: MoveId, air: boolean, chain = 0) {
  const body = getMoveBody(animal, id, air, chain);
  const first = Math.min(...body.hitboxes.map((h) => h.from));
  const end = Math.max(...body.hitboxes.map((h) => h.to));
  return { body, first, end, total: body.startup + body.active + body.recovery };
}

describe('pose polish: transitions never pop', () => {
  for (const animal of ANIMAL_IDS) {
    it(`${animal}: idle / run -> attack -> idle / run`, () => {
      const rig = rigOf(animal);
      for (const id of ['lightS', 'heavyS', 'heavyN', 'heavyD'] as const) {
        for (const pre of ['idle', 'run'] as const) {
          const { first, end, total } = bodyOf(animal, id, false);
          const segs: Seg[] = [
            { action: pre, frames: 14, vx: pre === 'run' ? 7 : 0 },
            { action: 'attack', moveId: id, frames: total },
            { action: pre, frames: 12, vx: pre === 'run' ? 7 : 0 },
          ];
          const r = drive(rig, animal, segs);
          expect(r.nan).toBe(false);
          check(`${animal} ${pre}->${id}->${pre}`, r.samples, segs, first, end);
        }
      }
    });

    it(`${animal}: fall / rise -> aerial -> landing / fall`, () => {
      const rig = rigOf(animal);
      for (const id of ['lightN', 'heavyS', 'heavyD'] as const) {
        const m = getMoveset(animal).moves[id];
        if (m.groundOnly) continue;
        const { first, end, total } = bodyOf(animal, id, true);
        for (const pre of ['fall', 'rise'] as const) {
          const segs: Seg[] = [
            { action: pre, frames: 12, air: true, vy: pre === 'rise' ? 8 : -9 },
            { action: 'attack', moveId: id, air: true, frames: total },
            { action: 'fall', frames: 8, air: true },
          ];
          const r = drive(rig, animal, segs);
          expect(r.nan).toBe(false);
          check(`${animal} ${pre}->${id}(air)->fall`, r.samples, segs, first, end);
        }
        // Landing in the middle of the recovery: the attack is replaced by the landing state.
        const cut = Math.max(first + 2, Math.round(first + (total - first) * 0.5));
        const segs: Seg[] = [
          { action: 'fall', frames: 10, air: true, vy: -9 },
          { action: 'attack', moveId: id, air: true, frames: cut },
          { action: 'landing', frames: 10, grounded: true },
          { action: 'idle', frames: 10 },
        ];
        const r = drive(rig, animal, segs);
        expect(r.nan).toBe(false);
        check(`${animal} ${id}(air) -> landing`, r.samples, segs, first, end);
      }
    });

    it(`${animal}: attack interrupted by hitstun -> idle`, () => {
      const rig = rigOf(animal);
      for (const id of ['heavyS', 'lightS'] as const) {
        const { first, end, total } = bodyOf(animal, id, false);
        for (const frac of [0.25, 0.55, 0.9]) {
          const cut = Math.max(2, Math.round(total * frac));
          const segs: Seg[] = [
            { action: 'idle', frames: 10 },
            { action: 'attack', moveId: id, frames: cut },
            { action: 'hitstun', frames: 18, grounded: true },
            { action: 'idle', frames: 14 },
          ];
          const r = drive(rig, animal, segs);
          expect(r.nan).toBe(false);
          check(`${animal} ${id}@${cut} -> hitstun -> idle`, r.samples, segs, first, end);
        }
      }
    });
  }
});

describe('pose polish: generic wind-up layer', () => {
  for (const animal of ANIMAL_IDS) {
    it(`${animal}: long-startup moves coil visibly early in the startup; heavier moves coil more`, () => {
      const set = getMoveset(animal);
      let heavy = 0;
      let light = 0;
      let nHeavy = 0;
      let nLight = 0;
      for (const id of MOVE_IDS) {
        const m = set.moves[id];
        const forms: { air: boolean; chain: number }[] = [{ air: false, chain: 0 }];
        if (m.air !== null) forms.push({ air: true, chain: 0 });
        for (const f of forms) {
          const body = getMoveBody(animal, id, f.air, f.chain);
          if (body.startup < 8) continue;
          const b = getBuilt(animal, body, f.air, f.chain);
          const w = moveWeight(body, b.strikeFrame);
          expect(b.weight).toBeCloseTo(w, 9);
          // Visible anticipation: the pose halfway through the first 55 % of the startup differs from the start (DOF space).
          const v = newVec();
          b.timeline.evalAt(b.strikeFrame * 0.55, v);
          const v0 = newVec();
          b.timeline.evalAt(0, v0);
          let d = 0;
          for (let i = 0; i < DOF_N; i++) {
            const k = i === DOF.bodyFwd || i === DOF.bodyUp ? 2.5 : i === DOF.rootSquash ? 3 : 1;
            d = Math.max(d, Math.abs(v[i] - v0[i]) * k);
          }
          expect(d, `${animal} ${id}${f.air ? ' air' : ''}: wind-up amplitude at 55 % of the startup`).toBeGreaterThan(0.12);
          if (id.startsWith('heavy')) {
            heavy += b.windupAmp;
            nHeavy++;
          } else {
            light += b.windupAmp;
            nLight++;
          }
        }
      }
      if (nHeavy > 0 && nLight > 0) expect(heavy / nHeavy, `${animal}: heavy moves wind up harder than light ones`).toBeGreaterThan(light / nLight);
    });
  }
});
