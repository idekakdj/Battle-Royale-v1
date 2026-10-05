/**
 * v1.6 burrow visuals (WP-B2): the mound + pooled VFX that stand in for the hidden rig of a burrowing fighter (BurrowFx), the quality
 * tiers, and the debug overlay's ledge-assist zone. No WebGL needed (pure scene graph + the CPU side of the quad pools).
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { getMoveBody } from '../../src/brawl/data';
import { getStage } from '../../src/brawl/data';
import { BrawlWorld } from '../../src/brawl/sim/BrawlWorld';
import { DebugBoxes } from '../../src/brawl/render/debugBoxes';
import { BurrowFx, animalHasBurrow } from '../../src/brawl/render/burrowFx';
import { Vfx } from '../../src/brawl/render/vfx/Vfx';
import type { BrawlFighterState, BrawlMatchConfig } from '../../src/brawl/types';
import { mkState } from './poseHelpers';

const win = (getMoveBody('mole', 'heavyD', false, 0).burrow as { from: number; to: number });

function frameState(k: number, o: Partial<BrawlFighterState> = {}): BrawlFighterState {
  return mkState('mole', {
    action: 'attack',
    moveId: 'heavyD',
    moveFrame: k,
    moveFrames: 48,
    underground: k >= win.from && k < win.to,
    pos: { x: 0.18 * Math.max(0, Math.min(k, win.to) - win.from), y: 0 },
    ...o,
  });
}

function setup(scale = 1) {
  const vfx = new Vfx(600, 300);
  vfx.scale = scale;
  const parent = new THREE.Group();
  const fx = new BurrowFx(parent, vfx, 0.68);
  return { vfx, parent, fx };
}

/** Run frames 0..n of a heavyD at `sub` render frames per sim frame; returns the frames at which the eruption fired. */
function play(fx: BurrowFx, vfx: Vfx, n: number, sub = 1, pos?: (k: number) => { x: number; y: number }): { erupted: number[]; live: number[] } {
  const erupted: number[] = [];
  const live: number[] = [];
  for (let k = 0; k <= n; k++) {
    const st = frameState(k);
    if (pos) st.pos = pos(k);
    for (let i = 1; i <= sub; i++) {
      const a = i / sub;
      const dt = 1 / 60 / sub;
      if (fx.update(st, a, st.pos.x, st.pos.y, dt, k / 60)) erupted.push(k);
      vfx.update(dt);
    }
    live.push(vfx.live);
  }
  return { erupted, live };
}

describe('BurrowFx: dirt mound + burrow VFX', () => {
  it('is only built for animals that have a burrow move', () => {
    expect(animalHasBurrow('mole')).toBe(true);
    for (const a of ['lion', 'gorilla', 'crocodile', 'hippo', 'rhino', 'eagle', 'panther', 'python', 'giraffe'] as const) expect(animalHasBurrow(a)).toBe(false);
  });

  it('dig-in burst once near the sink, mound shown while tunnelling, ONE eruption burst on the surfacing frame, mound gone shortly after', () => {
    const { fx, vfx } = setup();
    let digSpawned = -1;
    let eruptions = 0;
    let shownDuringTunnel = true;
    let shownAfter = false;
    for (let k = 0; k <= 48; k++) {
      const st = frameState(k);
      for (let i = 1; i <= 4; i++) {
        const before = vfx.live;
        const e = fx.update(st, i / 4, st.pos.x, st.pos.y, 1 / 240, k / 60);
        if (e) {
          eruptions++;
          expect(k, 'eruption fires when the continuous frame reaches `to`').toBeGreaterThanOrEqual(win.to);
          expect(k).toBeLessThanOrEqual(win.to + 1);
        }
        if (digSpawned < 0 && vfx.live > before && !e) digSpawned = k;
        vfx.update(1 / 240);
      }
      if (k >= win.from + 3 && k < win.to - 1) shownDuringTunnel = shownDuringTunnel && fx.shown;
      if (k >= 45) shownAfter = shownAfter || fx.shown;
    }
    expect(eruptions).toBe(1);
    expect(digSpawned, 'dig-in puffs spawn around frames 4-6').toBeGreaterThanOrEqual(win.from - 3);
    expect(digSpawned).toBeLessThanOrEqual(win.from);
    expect(shownDuringTunnel).toBe(true);
    expect(shownAfter).toBe(false);
  });

  it('the mound follows the interpolated position and the platform height (moving platforms)', () => {
    const { fx, vfx, parent } = setup();
    const group = parent.children[0] as THREE.Group;
    let checked = 0;
    for (let k = 0; k <= 30; k++) {
      const st = frameState(k);
      const y = 2.6 + 0.4 * Math.sin(k * 0.3); // a platform bobbing up and down
      fx.update(st, 1, st.pos.x, y, 1 / 60, k / 60);
      vfx.update(1 / 60);
      if (k > win.from + 3 && k < win.to - 2) {
        expect(group.visible).toBe(true);
        expect(group.position.x).toBeCloseTo(st.pos.x + 0.04, 5);
        expect(group.position.y).toBeCloseTo(y - 0.03, 5);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(8);
  });

  it('keeps the heap on the platform when the tunnel ends at an edge', () => {
    const { fx, vfx, parent } = setup();
    const group = parent.children[0] as THREE.Group;
    for (let k = 0; k <= 20; k++) {
      const st = frameState(k, { vel: { x: 0, y: 0 } });
      fx.update(st, 1, -3.0, 0, 1 / 60, k / 60, -13, -3);
      vfx.update(1 / 60);
    }
    expect(group.visible).toBe(true);
    // the fighter is exactly at the platform end (x = -3): the heap is nudged inward so most of it stays on the platform
    expect(group.position.x).toBeLessThan(-3.3);
    expect(group.position.x).toBeGreaterThan(-3.6);
    // an unbounded call (no platform known) leaves it at the fighter
    const free = setup();
    const g2 = free.parent.children[0] as THREE.Group;
    for (let k = 0; k <= 20; k++) free.fx.update(frameState(k, { vel: { x: 0, y: 0 } }), 1, -3.0, 0, 1 / 60, k / 60);
    expect(g2.position.x).toBeCloseTo(-3.0 + 0.04, 5);
  });

  it('the facing sets the side the tunnel heads for and the ridge trails behind', () => {
    for (const facing of [1, -1] as const) {
      const { fx, vfx, parent } = setup();
      const group = parent.children[0] as THREE.Group;
      for (let k = 0; k <= 16; k++) {
        const st = frameState(k, { facing, pos: { x: 0.18 * Math.max(0, k - 6) * facing, y: 0 }, vel: { x: 11 * facing, y: 0 } });
        fx.update(st, 1, st.pos.x, st.pos.y, 1 / 60, k / 60);
        vfx.update(1 / 60);
      }
      const ridge = group.children[1];
      expect(ridge.visible).toBe(true);
      expect(Math.sign(ridge.position.x), 'the ridge trails behind the head').toBe(-facing);
    }
  });

  it('no trailing ridge while the tunnel is stopped at a platform edge (vx = 0)', () => {
    const { fx, vfx, parent } = setup();
    const group = parent.children[0] as THREE.Group;
    for (let k = 0; k <= 20; k++) {
      const st = frameState(k, { vel: { x: k < 10 ? 11 : 0, y: 0 } });
      fx.update(st, 1, 1.0, 0, 1 / 60, k / 60);
      vfx.update(1 / 60);
    }
    expect(group.visible).toBe(true);
    expect(group.children[1].visible).toBe(false);
  });

  it('never fires for a non-burrow move, the air form, or a different fighter state, and a rollback resets it', () => {
    const { fx, vfx } = setup();
    // lightN: nothing
    for (let k = 0; k < 20; k++) {
      expect(fx.update(frameState(k, { moveId: 'lightN', underground: false }), 1, 0, 0, 1 / 60, k / 60)).toBe(false);
      vfx.update(1 / 60);
    }
    expect(vfx.live).toBe(0);
    expect(fx.shown).toBe(false);
    // the air form of heavyD (drill-down) has no burrow window
    for (let k = 0; k < 30; k++) {
      expect(fx.update(frameState(k, { moveAir: true, underground: false, grounded: false }), 1, 0, 3, 1 / 60, k / 60)).toBe(false);
      vfx.update(1 / 60);
    }
    expect(fx.phaseNow).toBe(0);
    expect(vfx.live).toBe(0);
    // a burrow cut short (rolled back to idle in the middle of the tunnel): the mound shrinks away, the phase resets
    for (let k = 0; k <= 12; k++) fx.update(frameState(k), 1, 0.18 * Math.max(0, k - 6), 0, 1 / 60, k / 60);
    expect(fx.shown).toBe(true);
    for (let i = 0; i < 30; i++) {
      fx.update(mkState('mole'), 1, 0, 0, 1 / 60, 1 + i / 60);
      vfx.update(1 / 60);
    }
    expect(fx.shown).toBe(false);
    expect(fx.phaseNow).toBe(0);
    // KO resets at once
    for (let k = 0; k <= 12; k++) fx.update(frameState(k), 1, 0, 0, 1 / 60, k / 60);
    fx.update(frameState(13, { alive: false }), 1, 0, 0, 1 / 60, 1);
    expect(fx.shown).toBe(false);
  });

  it('a rollback / a second burrow in a row fires the bursts again (time going backwards re-derives the phases)', () => {
    const { fx, vfx } = setup();
    const run = (from: number, to: number): number => {
      let n = 0;
      for (let k = from; k <= to; k++) {
        const st = frameState(k);
        if (fx.update(st, 1, st.pos.x, st.pos.y, 1 / 60, k / 60)) n++;
        vfx.update(1 / 60);
      }
      return n;
    };
    expect(run(0, 30)).toBe(1);
    expect(fx.phaseNow).toBe(2);
    // the second one starts without any non-attack frame in between (the render skipped them)
    expect(run(0, 30)).toBe(1);
    // rolled back from the eruption into the middle of the tunnel: it erupts again when the replay gets there
    run(0, 14);
    run(10, 12); // (time went backwards inside the tunnel)
    expect(fx.phaseNow).toBe(1);
    expect(run(13, 30)).toBe(1);
  });

  it('honours the quality tiers: fewer particles on low, the same single eruption, bounded pools', () => {
    const lo = setup(0.35);
    const hi = setup(1);
    const a = play(lo.fx, lo.vfx, 48, 1);
    const b = play(hi.fx, hi.vfx, 48, 1);
    expect(a.erupted).toEqual(b.erupted);
    expect(Math.max(...a.live)).toBeLessThan(Math.max(...b.live));
    expect(Math.max(...b.live)).toBeLessThan(120);
    // many burrows in a row keep the pools inside their caps (round-robin recycling, no growth)
    for (let r = 0; r < 12; r++) play(hi.fx, hi.vfx, 48, 1);
    expect(hi.vfx.alpha.n).toBeLessThanOrEqual(hi.vfx.alpha.cap);
    expect(hi.vfx.add.n).toBeLessThanOrEqual(hi.vfx.add.cap);
  });

  it('is frame-rate independent: 60 and 240 renders per second fire the same single eruption and show the mound for the same frames', () => {
    const r60 = setup();
    const r240 = setup();
    const a = play(r60.fx, r60.vfx, 48, 1);
    const b = play(r240.fx, r240.vfx, 48, 4);
    expect(a.erupted.length).toBe(1);
    expect(b.erupted.length).toBe(1);
    expect(Math.abs(a.erupted[0] - b.erupted[0])).toBeLessThanOrEqual(1);
  });

  it('dispose removes the mound from its parent', () => {
    const { fx, parent } = setup();
    expect(parent.children.length).toBe(1);
    fx.dispose();
    expect(parent.children.length).toBe(0);
  });
});

describe('Vfx burrow emitters / camera rumble hook', () => {
  it('the eruption burst is bigger than the dig-in puff, and every emitter stays inside the pools', () => {
    const v = new Vfx(600, 300);
    v.burrowDig(0, 0, 1);
    const dig = v.live;
    v.clear();
    v.burrowErupt(0, 0, 1, 1);
    const eruption = v.live;
    expect(eruption).toBeGreaterThan(dig);
    v.clear();
    for (let i = 0; i < 40; i++) v.burrowTrail(0, 0, -1);
    v.dirtSpray(0, 0, 40);
    expect(v.alpha.n).toBeLessThanOrEqual(v.alpha.cap);
    v.update(2);
    expect(v.live).toBe(0); // everything is short-lived
    v.dispose();
  });
});

describe('DebugBoxes: ledge auto-grab assist zone + underground hurtbox', () => {
  const cfg: BrawlMatchConfig = {
    stage: 'brokenColosseum',
    roster: [
      { animal: 'mole', isPlayer: true },
      { animal: 'lion', isPlayer: false },
    ],
    difficulty: 3,
    stocks: 3,
    timeLimitS: 0,
  };

  it('draws a faint dashed zone at every grabbable ledge on top of the grab boxes', () => {
    const w = new BrawlWorld(cfg, 1);
    w.skipCountdown();
    const snap = { ...w.snapshot(), hitboxes: [] };
    const dbg = new DebugBoxes(getStage('brokenColosseum'));
    dbg.setEnabled(true);
    dbg.update(snap);
    // 4 blast + platforms + 2 ledges x 4 (grab boxes) + 2 hurtboxes x 4; the assist zones are extra (dashes: ~18 per ledge)
    const base = 4 + snap.platforms.length + 2 * 4 + 2 * 4;
    expect(dbg.segments).toBeGreaterThan(base + 2 * 8);
    dbg.dispose();
  });

  it('an underground fighter is drawn as a dashed hurtbox (more, shorter segments than the solid box)', () => {
    const w = new BrawlWorld(cfg, 1);
    w.skipCountdown();
    const snap = w.snapshot();
    const dbg = new DebugBoxes(getStage('brokenColosseum'));
    dbg.setEnabled(true);
    dbg.update(snap);
    const solid = dbg.segments;
    const buried = { ...snap, fighters: snap.fighters.map((f, i) => (i === 0 ? { ...f, underground: true } : f)) };
    dbg.update(buried);
    expect(dbg.segments).toBeGreaterThan(solid);
    dbg.dispose();
  });
});
