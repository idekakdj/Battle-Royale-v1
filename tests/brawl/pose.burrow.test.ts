/**
 * v1.6 mole Burrow Strike, pose + visibility (WP-B2):
 *  - the ground heavyD timeline follows the data's burrow window: dig-in f0-5 (the body sinks, depth grows monotonically), a hidden
 *    tunnel pose, the surfacing, and the strike peak EXACTLY on the first active frame; smooth (<= 0.5 / 0.9 rad per frame), tip in
 *    the eruption hitbox on every active frame, both facings;
 *  - the AIR form is the drill-down (archetype 'dive', no burrow window, never sinks);
 *  - `rigHiddenUnderground` / `BrawlRig.hiddenUnderground`: hidden exactly while the continuous move frame is inside [from, to), no flash
 *    at either boundary at any render rate, and no way to stay hidden after a rollback / teleport / KO.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { getMoveBody } from '../../src/brawl/data';
import { BrawlWorld } from '../../src/brawl/sim/BrawlWorld';
import { idleIntent, type BrawlFighterState, type BrawlMatchConfig } from '../../src/brawl/types';
import { BrawlRig } from '../../src/brawl/render/pose/BrawlRig';
import { getBuilt, STEP_NORMAL, STEP_STRIKE } from '../../src/brawl/render/pose/build';
import { DOF, newVec } from '../../src/brawl/render/pose/dof';
import { disposeSolvers } from '../../src/brawl/render/pose/solver';
import { rigHiddenUnderground } from '../../src/brawl/render/pose/underground';
import { mkState, runMove, tipToHitbox } from './poseHelpers';

const EPS = 1e-4;
const rigs: BrawlRig[] = [];
function rig(): BrawlRig {
  const r = new BrawlRig('mole');
  rigs.push(r);
  return r;
}
afterAll(() => {
  for (const r of rigs) r.dispose();
  disposeSolvers();
});

const body = getMoveBody('mole', 'heavyD', false, 0);
const win = body.burrow as { from: number; to: number };
const strike = Math.min(...body.hitboxes.map((h) => h.from));
const activeEnd = Math.max(...body.hitboxes.map((h) => h.to));

/** A snapshot of the mole inside heavyD at move frame `k` (underground derived from the data window, like the sim does). */
function atFrame(k: number, o: Partial<BrawlFighterState> = {}): BrawlFighterState {
  return mkState('mole', {
    action: 'attack',
    moveId: 'heavyD',
    moveFrame: k,
    moveFrames: 48,
    actionFrame: k,
    actionFrames: 48,
    underground: k >= win.from && k < win.to,
    ...o,
  });
}

describe('mole Burrow Strike: pose timeline', () => {
  it('the ground form is a burrow with the expected window and the strike peak on the first active frame', () => {
    expect(body.archetype).toBe('burrow');
    expect(win).toEqual({ from: 6, to: 24 });
    expect(strike).toBe(24);
    const b = getBuilt('mole', body, false, 0);
    expect(b.strikeFrame).toBe(strike);
    const v = newVec();
    b.timeline.evalAt(strike, v);
    for (let i = 0; i < v.length; i++) if (b.timeline.lag[i] === 0) expect(v[i]).toBeCloseTo(b.peak[i], 6);
  });

  it('dig-in: the body sinks monotonically over f0-5, is (almost) fully below the floor at f6 and stays deep while hidden', () => {
    const b = getBuilt('mole', body, false, 0);
    const v = newVec();
    let prev = -1;
    for (let f = 0; f <= win.from + 2; f += 0.5) {
      b.timeline.evalAt(f, v);
      const d = v[DOF.neckExt]; // burrow depth (m)
      expect(d, `depth at f${f}`).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = d;
    }
    b.timeline.evalAt(0, v);
    expect(v[DOF.neckExt]).toBeCloseTo(0, 6);
    b.timeline.evalAt(win.from, v);
    expect(v[DOF.neckExt], 'sunk by the first hidden frame').toBeGreaterThan(0.65);
    for (let f = win.from; f <= strike - 4; f++) {
      b.timeline.evalAt(f, v);
      expect(v[DOF.neckExt], `deep at f${f}`).toBeGreaterThan(0.65);
    }
    // the nose dives (pitch down) while sinking, then comes up to the strike pose
    b.timeline.evalAt(win.from - 0.5, v);
    expect(v[DOF.bodyPitch]).toBeLessThan(-0.5);
    b.timeline.evalAt(strike, v);
    expect(v[DOF.bodyPitch]).toBeGreaterThan(0.2);
    expect(v[DOF.neckExt], 'half out of the hole at the strike frame').toBeLessThan(0.3);
  });

  for (const facing of [1, -1] as const) {
    it(`facing ${facing}: every frame is finite and smooth (0.5 / 0.9 rad), the tip is in the eruption hitbox on every active frame`, () => {
      const r = rig();
      const run = runMove(r, 'mole', 'heavyD', false, 0, { facing });
      expect(run.nan).toBe(false);
      for (let k = strike; k < activeEnd; k++) {
        const e = run.rec.log[run.moveStart + k];
        expect(e.tip).not.toBeNull();
        expect(tipToHitbox(body, k, e.tip as { x: number; y: number }), `tip at f${k}`).toBeLessThanOrEqual(0.5);
      }
      for (let i = 1; i < run.rec.log.length; i++) {
        const k = run.rec.log[i].k;
        const lim = (k >= strike - 2 && k <= activeEnd - 1 ? STEP_STRIKE : STEP_NORMAL) + EPS;
        expect(run.rec.log[i].step, `step at log ${i} (move frame ${k})`).toBeLessThanOrEqual(lim);
      }
    });
  }

  it('the built timeline itself (no entry blend, no cap) fits the angular budgets', () => {
    const b = getBuilt('mole', body, false, 0);
    expect(b.maxStep).toBeLessThanOrEqual(STEP_NORMAL + EPS);
    expect(b.maxStrikeStep).toBeLessThanOrEqual(STEP_STRIKE + EPS);
  });

  it('the AIR form is the drill-down: archetype dive, no burrow window, never sinks, smooth', () => {
    const air = getMoveBody('mole', 'heavyD', true, 0);
    expect(air.archetype).toBe('dive');
    expect(air.burrow).toBeUndefined();
    expect(air.invuln).toBeUndefined();
    expect(air.name).toBe('Drill Down');
    const b = getBuilt('mole', air, true, 0);
    const v = newVec();
    for (let f = 0; f < b.total; f++) {
      b.timeline.evalAt(f, v);
      expect(v[DOF.neckExt], `no burrow depth at f${f}`).toBe(0);
    }
    expect(b.maxStep).toBeLessThanOrEqual(STEP_NORMAL + EPS);
    expect(b.maxStrikeStep).toBeLessThanOrEqual(STEP_STRIKE + EPS);
    // nose down at the strike (the drill), nose up / claws back in the wind-up
    expect(b.peak[DOF.bodyPitch]).toBeLessThan(-1);
    const r = rig();
    const run = runMove(r, 'mole', 'heavyD', true, 0, { facing: 1 });
    expect(run.nan).toBe(false);
    const first = Math.min(...air.hitboxes.map((h) => h.from));
    const end = Math.max(...air.hitboxes.map((h) => h.to));
    for (let k = first; k < end; k++) expect(tipToHitbox(air, k, run.rec.log[run.moveStart + k].tip as { x: number; y: number })).toBeLessThanOrEqual(0.5);
  });
});

describe('rigHiddenUnderground: interpolating the underground flag between snapshots', () => {
  const subs = [0, 0.25, 0.5, 0.75, 1];

  it('is false for a fighter that is not underground, with or without a previous snapshot', () => {
    expect(rigHiddenUnderground(mkState('mole'), null, 0.5)).toBe(false);
    expect(rigHiddenUnderground(atFrame(3), atFrame(2), 0.5)).toBe(false);
    expect(rigHiddenUnderground(atFrame(30), atFrame(29), 1)).toBe(false);
  });

  it('hides exactly while the continuous move frame is inside [from, to): the boundaries do not flash at any alpha', () => {
    // continuous time t = cur.moveFrame - (1 - alpha); hidden <=> from <= t < to
    for (let k = 1; k <= 40; k++) {
      for (const a of subs) {
        const t = k - (1 - a);
        const expected = t >= win.from && t < win.to;
        expect(rigHiddenUnderground(atFrame(k), atFrame(k - 1), a), `frame ${k} alpha ${a} (t=${t})`).toBe(expected);
      }
    }
  });

  it('follows `cur` without a usable `prev`: no prev, a dead prev, a teleport, or another move', () => {
    const ug = atFrame(10);
    expect(rigHiddenUnderground(ug, null, 0.3)).toBe(true);
    expect(rigHiddenUnderground(ug, atFrame(9, { alive: false }), 0.3)).toBe(true);
    expect(rigHiddenUnderground(ug, atFrame(9, { pos: { x: 40, y: 0 } }), 0.3)).toBe(true);
    // a rollback: prev says "underground" but cur is something else entirely -> visible
    expect(rigHiddenUnderground(mkState('mole'), atFrame(10), 0.3)).toBe(false);
    expect(rigHiddenUnderground(atFrame(3), atFrame(12), 0.3)).toBe(false);
    // prev from a different move: only cur counts
    expect(rigHiddenUnderground(ug, atFrame(9, { moveId: 'lightN' }), 0.3)).toBe(true);
    expect(rigHiddenUnderground(atFrame(30), atFrame(10), 0.3)).toBe(false);
  });
});

describe('BrawlRig: the rig is hidden while underground and restored cleanly', () => {
  it('a full move at 60 Hz and at 240 Hz: visible except for t in [6, 24), never hidden outside it', () => {
    for (const sub of [1, 4]) {
      const r = rig();
      let prev: BrawlFighterState | null = null;
      for (let k = 0; k < 48; k++) {
        const cur = atFrame(k, { pos: { x: 0.18 * Math.max(0, Math.min(k, 24) - 6), y: 0 } });
        for (let i = 1; i <= sub; i++) {
          const a = i / sub;
          r.update(cur, prev, a, 1 / 60 / sub);
          const t = k - (1 - a);
          const hidden = t >= win.from && t < win.to;
          expect(r.hiddenUnderground, `k=${k} alpha=${a}`).toBe(hidden);
          expect(r.root.visible, `visible k=${k} alpha=${a}`).toBe(!hidden);
        }
        prev = cur;
      }
    }
  });

  it('a rollback / restart / teleport can not leave the rig hidden, and KO hides it without the underground flag', () => {
    const r = rig();
    const ug = atFrame(12);
    r.update(ug, atFrame(11), 0.5, 1 / 60);
    expect(r.root.visible).toBe(false);
    // rollback to a state long before the burrow (prev is the stale underground snapshot)
    r.update(mkState('mole'), ug, 0.5, 1 / 60);
    expect(r.root.visible).toBe(true);
    expect(r.hiddenUnderground).toBe(false);
    // a fresh start with a stale hidden state and no prev
    r.update(ug, null, 1, 1 / 60);
    expect(r.root.visible).toBe(false);
    r.update(mkState('mole'), null, 1, 1 / 60);
    expect(r.root.visible).toBe(true);
    // KO while (somehow) flagged underground: hidden as KO, the underground flag is not reported
    r.update(atFrame(12, { alive: false }), atFrame(11), 0.5, 1 / 60);
    expect(r.root.visible).toBe(false);
    expect(r.hiddenUnderground).toBe(false);
    r.update(mkState('mole', { action: 'respawn' }), atFrame(11, { alive: false }), 0.5, 1 / 60);
    expect(r.root.visible).toBe(true);
  });

  it('the pose keeps running while hidden: the first visible frame is exactly the strike pose (no pop)', () => {
    const r = rig();
    let prev: BrawlFighterState | null = null;
    let tipAtStrike: { x: number; y: number } | null = null;
    for (let k = 0; k <= strike + 1; k++) {
      const cur = atFrame(k);
      r.update(cur, prev, 1, 1 / 60);
      if (k === strike) tipAtStrike = r.tipFighterLocal('strike');
      prev = cur;
    }
    expect(tipAtStrike).not.toBeNull();
    expect(tipToHitbox(body, strike, tipAtStrike as { x: number; y: number })).toBeLessThanOrEqual(0.5);
  });
});

describe('pose x REAL sim: the rig is hidden exactly while the sim says underground', () => {
  function config(): BrawlMatchConfig {
    return { stage: 'brokenColosseum', roster: [{ animal: 'mole', isPlayer: true }, { animal: 'gorilla', isPlayer: false }], difficulty: 1, stocks: 3, timeLimitS: 0 };
  }

  it('heavyD on the ground (both facings): hidden for moveFrame 6..23 (alpha 1), visible otherwise, mound target follows the position', () => {
    for (const facing of [1, -1] as const) {
      const w = new BrawlWorld(config(), 11);
      w.skipCountdown();
      w.debugPlace(0, -2 * facing, 0);
      w.debugPlace(1, 14 * facing, 0);
      w.debugFighter(1).ledgeRegrab = 9999;
      w.setIntent(0, { ...idleIntent(), moveX: facing * 0.8 });
      w.step();
      w.step();
      w.setIntent(0, idleIntent());
      for (let i = 0; i < 12; i++) w.step();
      expect(w.snapshot().fighters[0].facing).toBe(facing);
      w.setIntent(0, { ...idleIntent(), heavy: true, moveY: -1 });
      w.step();
      w.setIntent(0, idleIntent());
      const r = rig();
      let prev = w.snapshot();
      let seen = 0;
      const x0 = prev.fighters[0].pos.x;
      for (let i = 0; i < 70; i++) {
        const cur = w.snapshot();
        const f = cur.fighters[0];
        r.update(f, prev.fighters[0], 1, 1 / 60);
        if (f.action === 'attack' && f.moveId === 'heavyD') {
          seen++;
          const ug = f.moveFrame >= win.from && f.moveFrame < win.to;
          expect(f.underground === true, `sim underground flag at frame ${f.moveFrame}`).toBe(ug);
          expect(r.root.visible, `rig visible at frame ${f.moveFrame}`).toBe(!ug);
          // the rig root sits at the fighter's feet (the mound is placed from the same position)
          expect(r.root.position.x).toBeCloseTo(f.pos.x, 5);
        }
        prev = cur;
        w.step();
      }
      expect(seen).toBeGreaterThan(40);
      const end = prev.fighters[0].pos.x;
      expect((end - x0) * facing, 'tunnelled forward').toBeGreaterThan(2);
    }
  });
});
