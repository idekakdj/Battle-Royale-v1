/**
 * Champions League stage visuals + VFX pools + debug overlay (WP-R). Node-safe: no WebGL context needed.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { getStage, STAGES } from '../../src/brawl/data';
import { buildStageVisual } from '../../src/brawl/render/stages';
import { QuadPool, Spec } from '../../src/brawl/render/vfx/QuadPool';
import { Vfx } from '../../src/brawl/render/vfx/Vfx';
import { DebugBoxes } from '../../src/brawl/render/debugBoxes';
import { BrawlWorld } from '../../src/brawl/sim/BrawlWorld';
import { STAGE_IDS, type BrawlMatchConfig, type PlatformState } from '../../src/brawl/types';
import type { QualityTier } from '../../src/render/quality';

const TIERS: QualityTier[] = ['low', 'medium', 'high'];

function platformsOf(id: (typeof STAGE_IDS)[number]): PlatformState[] {
  return getStage(id).platforms.map((p) => ({ id: p.id, x0: p.x0, x1: p.x1, y: p.y }));
}

describe('stage visuals', () => {
  for (const id of STAGE_IDS) {
    for (const tier of TIERS) {
      it(`${id} builds, updates and disposes at ${tier} without throwing`, () => {
        const def = getStage(id);
        const v = buildStageVisual(def, tier);
        expect(v.group.children.length).toBeGreaterThan(5);
        expect(v.countDrawables()).toBeGreaterThan(5);
        // Draw-call budget for the scenery alone (fighters + vfx add < 20): well under the 150 total.
        expect(v.countDrawables()).toBeLessThanOrEqual(80);
        const cam = new THREE.PerspectiveCamera(28, 16 / 9, 1, 700);
        cam.position.set(0, 5, 30);
        for (let i = 0; i < 5; i++) v.update(platformsOf(id), 1 / 60, i / 60, cam);
        v.setTier('low');
        v.setTier('high');
        v.dispose();
      });
    }

    it(`${id} follows the platform states from the snapshot (moving platform never recomputed)`, () => {
      const def = getStage(id);
      const v = buildStageVisual(def, 'high');
      const cam = new THREE.PerspectiveCamera(28, 16 / 9, 1, 700);
      const states = platformsOf(id);
      const moving = def.platforms.find((p) => p.moving !== undefined);
      if (moving !== undefined) {
        const st = states.find((s) => s.id === moving.id)!;
        st.x0 += 1.7;
        st.x1 += 1.7;
        st.y += 0.4;
        v.update(states, 1 / 60, 0, cam);
        const g = v.group.getObjectByName(`plat-${moving.id}`)!;
        expect(g.position.x).toBeCloseTo((moving.x0 + moving.x1) / 2 + 1.7, 5);
        expect(g.position.y).toBeCloseTo(moving.y + 0.4, 5);
      }
      v.dispose();
    });

    it(`${id} disposes every geometry, material and texture it created`, () => {
      const v = buildStageVisual(getStage(id), 'high');
      const geos = new Set<THREE.BufferGeometry>();
      const mats = new Set<THREE.Material>();
      v.group.traverse((o) => {
        const m = o as THREE.Mesh;
        // Sprites share one global quad geometry that no stage owns.
        if (m.geometry && !(o as THREE.Sprite).isSprite) geos.add(m.geometry);
        if (m.material) for (const mm of Array.isArray(m.material) ? m.material : [m.material]) mats.add(mm);
      });
      let gd = 0;
      let md = 0;
      for (const g of geos) g.addEventListener('dispose', () => gd++);
      for (const m of mats) m.addEventListener('dispose', () => md++);
      v.dispose();
      expect(gd).toBe(geos.size);
      expect(md).toBe(mats.size);
    });
  }

  it('the soft and solid platforms of a stage are separate visual groups with the right ids', () => {
    for (const id of STAGE_IDS) {
      const def = getStage(id);
      const v = buildStageVisual(def, 'medium');
      for (const p of def.platforms) {
        const g = v.group.getObjectByName(`plat-${p.id}`);
        expect(g).toBeDefined();
        expect(g!.position.y).toBeCloseTo(p.y, 5);
        if (p.kind === 'soft') expect(g!.children.length).toBeGreaterThan(0);
      }
      v.dispose();
    }
    expect(Object.keys(STAGES).length).toBe(STAGE_IDS.length);
  });
});

describe('QuadPool / Vfx', () => {
  it('spawns, expires and recycles without growing', () => {
    const p = new QuadPool(8, true);
    const s = new Spec().reset();
    s.life = 0.2;
    for (let i = 0; i < 20; i++) p.spawn(s);
    expect(p.n).toBe(8); // capped: oldest recycled
    p.update(0.1);
    expect(p.n).toBe(8);
    p.update(0.15);
    expect(p.n).toBe(0);
    expect(p.mesh.visible).toBe(false);
    p.dispose();
  });

  it('emitters create particles; KO sets the screen flash; scale thins the counts', () => {
    const v = new Vfx(400, 200);
    v.hit(0, 3, 40, 12, false, 30, 0xd9a441);
    expect(v.live).toBeGreaterThan(5);
    const normal = v.live;
    v.clear();
    v.hit(0, 3, 40, 12, true, 30, 0xd9a441);
    expect(v.live).toBeGreaterThan(normal - 1); // sweetspot is bigger / more sparks
    v.clear();
    v.scale = 0.2;
    v.hit(0, 3, 40, 12, false, 30, 0xd9a441);
    const thin = v.live;
    expect(thin).toBeLessThanOrEqual(normal);
    v.clear();
    v.scale = 1;
    v.ko(30, 5, 'right', 0xffffff);
    expect(v.flash).toBeGreaterThan(0.5);
    expect(v.live).toBeGreaterThan(30);
    for (let i = 0; i < 120; i++) v.update(1 / 60);
    expect(v.live).toBe(0);
    v.dispose();
  });

  it('steady-state frames reuse the typed arrays (no per-frame allocation in the pool)', () => {
    const p = new QuadPool(64, false);
    const s = new Spec().reset();
    s.life = 0.5;
    const ref = (p as unknown as { px: Float32Array }).px;
    for (let f = 0; f < 200; f++) {
      p.spawn(s);
      p.update(1 / 60);
    }
    expect((p as unknown as { px: Float32Array }).px).toBe(ref);
    expect(p.n).toBeLessThanOrEqual(64);
    p.dispose();
  });
});

describe('DebugBoxes', () => {
  it('draws hurtboxes, hitboxes, ledge boxes and blast zones only when enabled', () => {
    const cfg: BrawlMatchConfig = {
      stage: 'brokenColosseum',
      roster: [
        { animal: 'lion', isPlayer: true },
        { animal: 'gorilla', isPlayer: false },
      ],
      difficulty: 3,
      stocks: 3,
      timeLimitS: 0,
    };
    const w = new BrawlWorld(cfg, 1);
    w.skipCountdown();
    // Put them side by side and have the lion attack so there is an active hitbox.
    w.debugPlace(0, 0, 0);
    w.debugPlace(1, 1.2, 0);
    for (let i = 0; i < 3; i++) w.step();
    w.setIntent(0, { moveX: 0, moveY: 0, jump: false, jumpHeld: false, light: true, heavy: false, dodge: false });
    let snap = w.snapshot();
    for (let i = 0; i < 12 && snap.hitboxes.length === 0; i++) {
      w.step();
      snap = w.snapshot();
    }
    const dbg = new DebugBoxes(getStage('brokenColosseum'));
    dbg.update(snap);
    expect(dbg.segments).toBe(0); // disabled
    dbg.setEnabled(true);
    dbg.update(snap);
    const base = 4 /*blast*/ + snap.platforms.length /*surfaces*/ + 2 * 4 /*ledges*/ + 2 * 4 /*hurtboxes*/;
    expect(dbg.segments).toBeGreaterThanOrEqual(base);
    if (snap.hitboxes.length > 0) expect(dbg.segments).toBeGreaterThan(base);
    expect(dbg.lines.visible).toBe(true);
    dbg.setEnabled(false);
    expect(dbg.lines.visible).toBe(false);
    dbg.dispose();
  });
});
