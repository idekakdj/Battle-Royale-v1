/**
 * v1.6 dynamic stages, view side (WP-M3): Clockwork Heights + Crumbling Amphitheatre scenes, camera extents over the whole loop and the
 * final form, crack-stage mapping, active / finalOnly visibility derived from the snapshot, event FX pooling, the F3 overlay, the stage
 * card view-model and the online stage picker. Node-safe (no WebGL).
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { getStage, STAGES } from '../../src/brawl/data';
import { platformAt } from '../../src/brawl/data/stages';
import { BrawlCamera, makeCamTarget } from '../../src/brawl/render/BrawlCamera';
import { DebugBoxes } from '../../src/brawl/render/debugBoxes';
import { buildStageVisual } from '../../src/brawl/render/stages';
import { ChunkPool } from '../../src/brawl/render/stages/chunkPool';
import { CRACK_STAGES, crackStage, finalFormReached, isActive, platformExtent, stageExtent, stageTraits } from '../../src/brawl/render/stages/dynamic';
import { tickAngle } from '../../src/brawl/render/stages/gears';
import { Vfx } from '../../src/brawl/render/vfx/Vfx';
import { BrawlWorld } from '../../src/brawl/sim/BrawlWorld';
import { stageBadges, stageBadgesHtml, stageCards, stageThumbSvg } from '../../src/brawl/ui/stageThumb';
import { stagePickerItems } from '../../src/online/ui/viewModel';
import { STAGE_IDS, type BrawlEvent, type BrawlMatchConfig, type PlatformState, type StageId } from '../../src/brawl/types';

const cfg = (stage: StageId): BrawlMatchConfig => ({
  stage,
  roster: [
    { animal: 'lion', isPlayer: true },
    { animal: 'gorilla', isPlayer: false },
  ],
  difficulty: 3,
  stocks: 3,
  timeLimitS: 0,
});

function cam(): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(28, 16 / 9, 1, 700);
  c.position.set(0, 5, 30);
  return c;
}

function liveWorld(stage: StageId): BrawlWorld {
  const w = new BrawlWorld(cfg(stage), 5);
  w.skipCountdown();
  return w;
}

/** A fake FX context that records what the stage asked for. */
function fakeCtx(): { vfx: Vfx; rumbles: number[]; ctx: { vfx: Vfx; rumble(a: number): void } } {
  const vfx = new Vfx(400, 200);
  const rumbles: number[] = [];
  return { vfx, rumbles, ctx: { vfx, rumble: (a: number): void => void rumbles.push(a) } };
}

describe('dynamic helpers', () => {
  it('maps hp / maxHp to crack stages 0..3 (4-hit: 1,2,3; 6-hit: 1,1,2,2,3)', () => {
    expect(CRACK_STAGES).toBe(3);
    expect([4, 3, 2, 1].map((hp) => crackStage(hp, 4))).toEqual([0, 1, 2, 3]);
    expect([6, 5, 4, 3, 2, 1].map((hp) => crackStage(hp, 6))).toEqual([0, 1, 1, 2, 2, 3]);
    expect(crackStage(0, 6)).toBe(0); // destroyed: not drawn at all
    expect(crackStage(undefined, undefined)).toBe(0);
    for (const max of [4, 5, 6, 8]) {
      let last = 0;
      for (let hp = max; hp >= 1; hp--) {
        const s = crackStage(hp, max);
        expect(s).toBeGreaterThanOrEqual(last);
        last = s;
      }
      expect(last).toBe(3);
    }
  });

  it('treats an undefined `active` as existing and detects the final form from any active finalOnly platform', () => {
    const def = getStage('crumblingAmphitheatre');
    expect(isActive({ id: 'a', x0: 0, x1: 1, y: 0 })).toBe(true);
    expect(isActive({ id: 'a', x0: 0, x1: 1, y: 0, active: false })).toBe(false);
    const w = liveWorld('crumblingAmphitheatre');
    expect(finalFormReached(def.platforms, w.snapshot().platforms)).toBe(false);
    w.debugHitPlatform('tileC', 0, 6);
    expect(finalFormReached(def.platforms, w.snapshot().platforms)).toBe(false);
    for (const p of def.platforms) if (p.breakable !== undefined) w.debugHitPlatform(p.id, 0, p.breakable.hits);
    expect(finalFormReached(def.platforms, w.snapshot().platforms)).toBe(true);
  });

  it('stage traits / extents see paths and final-only platforms', () => {
    expect(stageTraits(getStage('clockworkHeights'))).toEqual({ moving: true, breakable: false });
    expect(stageTraits(getStage('crumblingAmphitheatre'))).toEqual({ moving: false, breakable: true });
    expect(stageTraits(getStage('brokenColosseum'))).toEqual({ moving: false, breakable: false });
    const e = stageExtent(getStage('crumblingAmphitheatre'));
    expect(e.yMax).toBeCloseTo(7.8, 5);
    expect(e.x0).toBeCloseTo(-13, 5);
    const core = getStage('clockworkHeights').platforms.find((p) => p.id === 'core')!;
    const ce = platformExtent(core);
    expect(ce.x1).toBeGreaterThan(core.x1 + 3);
    expect(ce.yMin).toBeLessThan(core.y);
  });

  it('tickAngle holds, then advances one step per tick with a quick ease (monotone across ticks)', () => {
    const step = 0.5;
    expect(tickAngle(0, 1, step)).toBeCloseTo(0, 6);
    expect(tickAngle(0.5, 1, step)).toBeCloseTo(step, 6);
    expect(tickAngle(0.99, 1, step)).toBeCloseTo(step, 6);
    expect(tickAngle(1.0, 1, step)).toBeCloseTo(step, 6);
    expect(tickAngle(2.6, 1, step)).toBeCloseTo(3 * step, 6);
    // continuous at the end of each ease
    const a = tickAngle(0.2199, 1, step);
    const b = tickAngle(0.2201, 1, step);
    expect(Math.abs(a - b)).toBeLessThan(0.01);
  });
});

describe('camera extents (v1.6)', () => {
  it('covers every path position and every finalOnly platform over the whole loop', () => {
    for (const id of ['clockworkHeights', 'crumblingAmphitheatre'] as const) {
      const st = getStage(id);
      const c = new BrawlCamera(st);
      const priv = c as unknown as { pfL: number; pfR: number; pfT: number; pfB: number };
      for (let f = 0; f < 40 * 60; f += 15) {
        for (const p of st.platforms) {
          const r = platformAt(p, f);
          expect(r.y + 2.3).toBeLessThanOrEqual(c.viewTop + 1e-6);
          expect(r.y).toBeGreaterThanOrEqual(c.viewBot);
          expect(r.x0).toBeGreaterThan(priv.pfL);
          expect(r.x1).toBeLessThan(priv.pfR);
          expect(r.y).toBeLessThan(priv.pfT);
          expect(r.y).toBeGreaterThan(priv.pfB);
        }
      }
    }
    // the old stages keep their framing
    const old = new BrawlCamera(getStage('brokenColosseum'));
    expect(old.viewTop).toBeCloseTo(7.6 + 2.4, 6);
    expect(old.viewBot).toBe(-3);
  });

  it('a fighter riding the drifting core never leaves the view and the zoom does not pump over the loop', () => {
    const st = getStage('clockworkHeights');
    const core = st.platforms.find((p) => p.id === 'core')!;
    const c = new BrawlCamera(st);
    c.setAspect(16 / 9);
    const t = makeCamTarget();
    const ts = [t];
    let minW = Infinity;
    let maxW = 0;
    for (let f = 0; f < 40 * 60; f++) {
      const r = platformAt(core, f);
      const x = (r.x0 + r.x1) / 2 + Math.sin(f * 0.01) * 4;
      t.alive = true;
      t.x = x;
      t.y = r.y;
      t.vx = 0;
      t.vy = 0;
      c.update(1 / 60, ts, 1);
      if (f > 120) {
        const v = c.visibleRect();
        expect(x).toBeGreaterThan(v.l + 0.5);
        expect(x).toBeLessThan(v.r - 0.5);
        expect(r.y + 2).toBeLessThan(v.t);
        expect(r.y).toBeGreaterThan(v.b);
        minW = Math.min(minW, c.halfW);
        maxW = Math.max(maxW, c.halfW);
      }
    }
    expect(maxW - minW).toBeLessThan(1.5);
  });

  it('a fighter on a far satellite (layout B, x = -14) stays in the view', () => {
    const st = getStage('clockworkHeights');
    const sat = st.platforms.find((p) => p.id === 'satL')!;
    const c = new BrawlCamera(st);
    c.setAspect(16 / 9);
    const t = makeCamTarget();
    const r = platformAt(sat, 15 * 60);
    t.alive = true;
    t.x = (r.x0 + r.x1) / 2;
    t.y = r.y;
    for (let i = 0; i < 240; i++) c.update(1 / 60, [t], 1);
    const v = c.visibleRect();
    expect(t.x).toBeGreaterThan(v.l);
    expect(t.x).toBeLessThan(v.r);
  });
});

describe('Clockwork Heights scene', () => {
  it('follows the snapshot positions of the core and all four satellites (no recomputed motion)', () => {
    const def = getStage('clockworkHeights');
    const v = buildStageVisual(def, 'high');
    const w = liveWorld('clockworkHeights');
    for (let i = 0; i < 6 * 60; i++) w.step();
    const snap = w.snapshot();
    v.update(snap.platforms, 1 / 60, 0, cam());
    for (const s of snap.platforms) {
      const g = v.group.getObjectByName(`plat-${s.id}`)!;
      expect(g.position.x).toBeCloseTo((s.x0 + s.x1) / 2, 5);
      expect(g.position.y).toBeCloseTo(s.y, 5);
    }
    // a hand-edited state moves the group, widths included
    const states: PlatformState[] = snap.platforms.map((p) => ({ ...p }));
    const sat = states.find((p) => p.id === 'satR')!;
    sat.x0 += 2;
    sat.x1 += 2;
    sat.y += 1.5;
    v.update(states, 1 / 60, 1 / 60, cam());
    const g = v.group.getObjectByName('plat-satR')!;
    expect(g.position.x).toBeCloseTo((sat.x0 + sat.x1) / 2, 5);
    expect(g.position.y).toBeCloseTo(sat.y, 5);
    v.dispose();
  });

  it('stays within the draw-call budget at every tier and exposes no lighting hook (static look)', () => {
    for (const tier of ['low', 'medium', 'high'] as const) {
      const v = buildStageVisual(getStage('clockworkHeights'), tier);
      expect(v.countDrawables()).toBeLessThanOrEqual(60);
      expect(v.updateLights).toBeUndefined();
      v.dispose();
    }
  });
});

describe('Crumbling Amphitheatre scene', () => {
  const def = getStage('crumblingAmphitheatre');
  const vis = (v: ReturnType<typeof buildStageVisual>, id: string): boolean => v.group.getObjectByName(`plat-${id}`)!.visible;

  it('draws only the active pieces: breakables intact, final-form platforms hidden', () => {
    const v = buildStageVisual(def, 'high');
    const w = liveWorld('crumblingAmphitheatre');
    v.update(w.snapshot().platforms, 1 / 60, 0, cam());
    for (const p of def.platforms) expect(vis(v, p.id)).toBe(p.finalOnly !== true);
    expect(v.dynamicState?.().finalK).toBe(0);
    v.dispose();
  });

  it('hides a destroyed breakable and swaps its geometry by crack stage (more cracks = more triangles)', () => {
    const v = buildStageVisual(def, 'high');
    const w = liveWorld('crumblingAmphitheatre');
    const mesh = (): THREE.Mesh => v.group.getObjectByName('body-tileL') as THREE.Mesh;
    const tris = (): number => mesh().geometry.getAttribute('position').count / 3;
    v.update(w.snapshot().platforms, 1 / 60, 0, cam());
    const t0 = tris();
    const geos = new Set<THREE.BufferGeometry>([mesh().geometry]);
    const seen: number[] = [t0];
    for (let hit = 1; hit <= 5; hit++) {
      w.debugHitPlatform('tileL', 0, 1);
      v.update(w.snapshot().platforms, 1 / 60, hit / 60, cam());
      geos.add(mesh().geometry);
      seen.push(tris());
      expect(vis(v, 'tileL')).toBe(true);
    }
    expect(geos.size).toBe(4); // stage 0,1,2,3 (hp 6 -> 1)
    expect(seen[1]).toBeGreaterThan(seen[0]);
    expect(seen[5]).toBeGreaterThan(seen[1]);
    w.debugHitPlatform('tileL', 0, 1); // destroyed
    v.update(w.snapshot().platforms, 1 / 60, 0.2, cam());
    expect(vis(v, 'tileL')).toBe(false);
    expect(vis(v, 'tileC')).toBe(true);
    expect(v.dynamicState?.().pieces).toBe(7); // 2 floors + 5 breakables left
    v.dispose();
  });

  it('final form: pieces gone, finalOnly platforms present, look persists; a LATE JOIN snaps straight to it', () => {
    const w = liveWorld('crumblingAmphitheatre');
    for (const p of def.platforms) if (p.breakable !== undefined) w.debugHitPlatform(p.id, 0, p.breakable.hits);
    const snap = w.snapshot();
    // a scene that sees the final form on its very first frame (late join / reload / rollback) shows it at once
    const late = buildStageVisual(def, 'high');
    late.update(snap.platforms, 1 / 60, 0, cam());
    expect(late.dynamicState?.().finalK).toBe(1);
    for (const p of def.platforms) {
      expect(vis(late, p.id)).toBe(p.breakable === undefined);
      if (p.finalOnly === true) expect(late.group.getObjectByName(`plat-${p.id}`)!.position.y).toBeCloseTo(p.y, 5);
    }
    late.dispose();
    // a scene that WATCHES the transition rises over time: first the finals start low, then settle on their y
    const live = buildStageVisual(def, 'high');
    const w2 = liveWorld('crumblingAmphitheatre');
    live.update(w2.snapshot().platforms, 1 / 60, 0, cam());
    for (const p of def.platforms) if (p.breakable !== undefined) w2.debugHitPlatform(p.id, 0, p.breakable.hits);
    live.update(w2.snapshot().platforms, 1 / 60, 0.1, cam());
    const sun = live.group.getObjectByName('plat-sunL')!;
    expect(sun.position.y).toBeLessThan(def.platforms.find((p) => p.id === 'sunL')!.y - 0.5);
    const early = live.dynamicState!().finalK;
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(0.1);
    for (let i = 0; i < 300; i++) live.update(w2.snapshot().platforms, 1 / 60, 0.1 + i / 60, cam());
    expect(sun.position.y).toBeCloseTo(def.platforms.find((p) => p.id === 'sunL')!.y, 3);
    expect(live.dynamicState!().finalK).toBe(1);
    live.dispose();
  });

  it('v1.7 span: ghosted in the intact arena (hint edges drawn once), rises with the sun slabs at the same timing and settles on y 3.0', () => {
    const spanDef = def.platforms.find((p) => p.id === 'span')!;
    const sunDef = def.platforms.find((p) => p.id === 'sunL')!;
    expect(spanDef.finalOnly).toBe(true);
    const v = buildStageVisual(def, 'high');
    const w = liveWorld('crumblingAmphitheatre');
    v.update(w.snapshot().platforms, 1 / 60, 0, cam());
    expect(vis(v, 'span')).toBe(false);
    // the dashed-ghost hint: 4 edges per final-form platform, minus the two seams where the span abuts the sun slabs (coincident edges are not doubled)
    const ghost = v.group.getObjectByName('final-form-ghost') as THREE.LineSegments;
    expect(ghost.visible).toBe(true);
    const finals = def.platforms.filter((p) => p.finalOnly === true);
    expect(ghost.geometry.getAttribute('position').count).toBe((finals.length * 4 - 2) * 2);
    // body + glow meshes exist and the glow is the gold material that flares on the rise
    expect(v.group.getObjectByName('body-span')).toBeDefined();
    expect(v.group.getObjectByName('glow-span')).toBeDefined();
    // break everything: both slabs and the span start the rise together (same delay) from the same depth, then settle on their heights
    for (const p of def.platforms) if (p.breakable !== undefined) w.debugHitPlatform(p.id, 0, p.breakable.hits);
    v.update(w.snapshot().platforms, 1 / 60, 0.1, cam());
    expect(vis(v, 'span')).toBe(true);
    const span = v.group.getObjectByName('plat-span')!;
    const sun = v.group.getObjectByName('plat-sunL')!;
    expect(span.position.y - spanDef.y).toBeCloseTo(sun.position.y - sunDef.y, 9);
    expect(span.position.y).toBeLessThan(spanDef.y - 0.5);
    expect(span.position.x).toBeCloseTo(0, 9);
    for (let i = 0; i < 300; i++) v.update(w.snapshot().platforms, 1 / 60, 0.1 + i / 60, cam());
    expect(span.position.y).toBeCloseTo(spanDef.y, 3);
    expect(span.scale.x).toBeCloseTo(1, 3);
    expect(ghost.visible).toBe(false);
    // the span joins the others on dispose: nothing of it is left in the scene
    v.dispose();
    expect(v.group.parent).toBeNull();
  });

  it('a rollback that un-breaks the stage reverts the look (derived from the snapshot, not events)', () => {
    const v = buildStageVisual(def, 'high');
    const w = liveWorld('crumblingAmphitheatre');
    const before = w.saveState();
    for (const p of def.platforms) if (p.breakable !== undefined) w.debugHitPlatform(p.id, 0, p.breakable.hits);
    for (let i = 0; i < 400; i++) v.update(w.snapshot().platforms, 1 / 60, i / 60, cam());
    expect(v.dynamicState!().finalK).toBe(1);
    w.loadState(before);
    for (let i = 0; i < 120; i++) v.update(w.snapshot().platforms, 1 / 60, 7 + i / 60, cam());
    expect(v.dynamicState!().finalK).toBe(0);
    for (const p of def.platforms) expect(vis(v, p.id)).toBe(p.finalOnly !== true);
    v.dispose();
  });

  it('the lighting hook re-tints the scene lights toward the dawn and reports changes only when something moved', () => {
    const v = buildStageVisual(def, 'high');
    const lights = {
      hemi: new THREE.HemisphereLight(),
      key: new THREE.DirectionalLight(),
      rim: new THREE.DirectionalLight(),
      fog: new THREE.Fog(0x000000, 10, 100),
      exposure: 1,
      gradeTint: [1, 1, 1] as [number, number, number],
      gradeVignette: 0.3,
      gradeSat: 1,
    };
    const w = liveWorld('crumblingAmphitheatre');
    v.update(w.snapshot().platforms, 1 / 60, 0, cam());
    expect(v.updateLights!(lights)).toBe(true);
    expect(v.updateLights!(lights)).toBe(false);
    const night = lights.key.color.getHex();
    const nightI = lights.key.intensity;
    for (const p of def.platforms) if (p.breakable !== undefined) w.debugHitPlatform(p.id, 0, p.breakable.hits);
    for (let i = 0; i < 300; i++) v.update(w.snapshot().platforms, 1 / 60, i / 60, cam());
    expect(v.updateLights!(lights)).toBe(true);
    expect(lights.key.color.getHex()).not.toBe(night);
    expect(lights.key.intensity).toBeGreaterThan(nightI);
    expect(v.updateLights!(lights)).toBe(false);
    v.dispose();
  });

  it('event effects: dust + chips on a hit, chunks + rumble on a break, shockwave + flash + big rumble on the final form', () => {
    const v = buildStageVisual(def, 'high');
    const { vfx, rumbles, ctx } = fakeCtx();
    const hit: BrawlEvent = { type: 'platformHit', platformId: 'tileC', attackerId: 0, hpLeft: 5, maxHp: 6, pos: { x: 0, y: 0 } };
    v.onEvents!([hit], ctx);
    expect(vfx.live).toBeGreaterThan(4);
    expect(rumbles.length).toBe(1);
    const live1 = vfx.live;
    v.onEvents!([{ type: 'platformBreak', platformId: 'tileC', pos: { x: 0, y: -1.7 }, x0: -3, x1: 3, y: 0 }], ctx);
    expect(vfx.live).toBeGreaterThan(live1);
    expect(v.dynamicState!().chunks).toBeGreaterThan(8);
    expect(Math.max(...rumbles)).toBeGreaterThanOrEqual(0.2);
    vfx.clear();
    v.onEvents!([{ type: 'stageFinal' }], ctx);
    expect(vfx.flash).toBeGreaterThan(0.5);
    expect(Math.max(...rumbles)).toBeGreaterThanOrEqual(0.7);
    expect(vfx.live).toBeGreaterThan(20);
    v.dispose();
  });

  it('pooling: a storm of hits / breaks never exceeds the pool capacities and reuses its typed arrays', () => {
    const v = buildStageVisual(def, 'high');
    const { vfx, ctx } = fakeCtx();
    const evs: BrawlEvent[] = [];
    for (let i = 0; i < 80; i++) evs.push({ type: 'platformHit', platformId: 'tileL', attackerId: 0, hpLeft: 3, maxHp: 6, pos: { x: -5, y: 0 } });
    for (let i = 0; i < 12; i++) evs.push({ type: 'platformBreak', platformId: 'tileL', pos: { x: -5, y: -1 }, x0: -8.5, x1: -3, y: 0 });
    v.onEvents!(evs, ctx);
    expect(v.dynamicState!().chunks).toBeLessThanOrEqual(72);
    expect(vfx.add.n).toBeLessThanOrEqual(vfx.add.cap);
    expect(vfx.alpha.n).toBeLessThanOrEqual(vfx.alpha.cap);
    v.dispose();

    const pool = new ChunkPool(16);
    const ref = (pool as unknown as { px: Float32Array }).px;
    for (let f = 0; f < 300; f++) {
      pool.burst(-3, 3, 0, 2, 1, 4, 0.5, [0x888888, 0x666666]);
      pool.update(1 / 60, -20);
      expect(pool.n).toBeLessThanOrEqual(16);
      expect(pool.mesh.count).toBe(pool.n);
    }
    expect((pool as unknown as { px: Float32Array }).px).toBe(ref);
    for (let f = 0; f < 600; f++) pool.update(1 / 60, -20);
    expect(pool.n).toBe(0);
    expect(pool.mesh.visible).toBe(false);
    pool.dispose();
  });

  it('stays within the draw-call budget at every tier and rebuilds / disposes cleanly five times', () => {
    for (const tier of ['low', 'medium', 'high'] as const) {
      const v = buildStageVisual(def, tier);
      expect(v.countDrawables()).toBeLessThanOrEqual(60);
      v.dispose();
    }
    for (let i = 0; i < 5; i++) {
      const v = buildStageVisual(def, 'high');
      const geos = new Set<THREE.BufferGeometry>();
      v.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry && !(o as THREE.Sprite).isSprite) geos.add(m.geometry);
      });
      let d = 0;
      for (const g of geos) g.addEventListener('dispose', () => d++);
      v.dispose();
      expect(d).toBe(geos.size);
      expect(v.group.parent).toBeNull();
    }
  });
});

describe('F3 overlay (v1.6)', () => {
  it('draws a destroyed / not-yet-risen platform dashed (no surface line, no ledge boxes) and one tick per hit remaining', () => {
    const def = getStage('crumblingAmphitheatre');
    const w = liveWorld('crumblingAmphitheatre');
    const dbg = new DebugBoxes(def);
    dbg.setEnabled(true);
    dbg.update(w.snapshot());
    const intact = dbg.segments;
    w.debugHitPlatform('tileC', 0, 6); // destroyed: its two ledge boxes + surface go away, a dashed outline appears
    dbg.update(w.snapshot());
    expect(dbg.segments).not.toBe(intact);
    const snap = w.snapshot();
    expect(snap.platforms.find((p) => p.id === 'tileC')!.active).toBe(false);
    // the ticks: hits remaining of tileR (6) are drawn
    const w2 = liveWorld('crumblingAmphitheatre');
    const dbg2 = new DebugBoxes(def);
    dbg2.setEnabled(true);
    dbg2.update(w2.snapshot());
    const full = dbg2.segments;
    w2.debugHitPlatform('tileR', 0, 2); // 4 ticks left instead of 6
    dbg2.update(w2.snapshot());
    expect(dbg2.segments).toBe(full - 2);
    dbg.dispose();
    dbg2.dispose();
  });
});

describe('stage cards, thumbnails and the online stage picker', () => {
  it('stageCards lists all four stages in STAGE_IDS order with badges for the two new maps', () => {
    const cards = stageCards(STAGE_IDS, STAGES);
    expect(cards.map((c) => c.id)).toEqual([...STAGE_IDS]);
    expect(cards).toHaveLength(4);
    expect(cards.map((c) => c.name)).toEqual(['Broken Colosseum', 'Sky Aqueduct', 'Clockwork Heights', 'Crumbling Amphitheatre']);
    expect(stageBadges(STAGES.brokenColosseum)).toEqual([]);
    expect(stageBadges(STAGES.skyAqueduct)).toEqual([]);
    expect(stageBadges(STAGES.clockworkHeights).map((b) => b.id)).toEqual(['moving']);
    expect(stageBadges(STAGES.crumblingAmphitheatre).map((b) => b.id)).toEqual(['breakable']);
    expect(stageBadgesHtml(STAGES.clockworkHeights)).toContain('Moving platforms');
    expect(stageBadgesHtml(STAGES.crumblingAmphitheatre)).toContain('Breakable');
    expect(stageBadgesHtml(STAGES.brokenColosseum)).toBe('');
  });

  it('Clockwork thumbnail: layout A, ghosts of the other layouts, a dashed route and an arrow per path platform', () => {
    const def = STAGES.clockworkHeights;
    const svg = stageThumbSvg(def);
    expect((svg.match(/class="bs-solid"/g) ?? []).length).toBe(1);
    expect((svg.match(/class="bs-soft"/g) ?? []).length).toBe(4);
    expect((svg.match(/class="bs-ghost"/g) ?? []).length).toBeGreaterThanOrEqual(8); // 4 satellites x 2 other layouts (+ core extremes)
    expect((svg.match(/class="bs-route"/g) ?? []).length).toBe(5);
    expect((svg.match(/class="bs-arrow"/g) ?? []).length).toBe(5);
    // layout A: the satellite rect sits at its defined x
    const satL = def.platforms.find((p) => p.id === 'satL')!;
    expect(svg).toContain(`class="bs-soft" x="${Math.round(satL.x0 * 100) / 100}"`);
  });

  it('Amphitheatre thumbnail: breakables outlined + cracked, the final form as dashed gold ghosts', () => {
    const def = STAGES.crumblingAmphitheatre;
    const svg = stageThumbSvg(def);
    expect((svg.match(/class="bs-breakable"/g) ?? []).length).toBe(6);
    expect((svg.match(/class="bs-crack"/g) ?? []).length).toBe(6);
    const finals = def.platforms.filter((p) => p.finalOnly === true);
    expect(finals.length).toBe(5); // sunL, sunR, core, halo + the v1.7 span
    expect((svg.match(/stroke-dasharray="0.45 0.35"/g) ?? []).length).toBe(finals.length);
  });

  it('the online room stage picker lists every stage (4), in order, exactly one selected, with badges', () => {
    const items = stagePickerItems('crumblingAmphitheatre');
    expect(items.map((i) => i.id)).toEqual([...STAGE_IDS]);
    expect(items).toHaveLength(4);
    expect(items.filter((i) => i.selected).map((i) => i.id)).toEqual(['crumblingAmphitheatre']);
    expect(items.find((i) => i.id === 'clockworkHeights')!.badges.map((b) => b.id)).toEqual(['moving']);
    expect(stagePickerItems('brokenColosseum').filter((i) => i.selected)).toHaveLength(1);
  });
});
