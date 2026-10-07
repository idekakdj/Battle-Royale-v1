/**
 * JungleScene builder tests (v1.8 WP-J3), node-safe: no GL, a tiny `document` stub (canvas contexts are null, so the procedural
 * textures fall back to flat ones) and a fake SceneManager. Checks that the scene builds from the ARENA DATA (trees exactly at
 * their collider positions / radii, crates / pads / moss counts), instance counts stay within the per-tier budgets, the
 * draw-call proxy stays small, the per-tier knobs move, the trunk fade stays in range, crates break / reset, and — the leak
 * check that stands in for `renderer.info.memory` — that every geometry / material / texture the scene made is disposed by
 * `dispose()`, over five create/dispose cycles.
 */

import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { JUNGLE_ARENA } from '../../src/config/arenas';
import { JUNGLE_LOOK } from '../../src/render/SceneManager';
import type { SceneManager } from '../../src/render/SceneManager';
import { JungleScene, jungleBudget } from '../../src/render/jungle/JungleScene';
import { TRUNK_FADE_MIN } from '../../src/render/jungle/treeFade';
import { getQualitySetting, setQualitySetting } from '../../src/render/quality';

const fakeDoc = {
  createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => null }),
};

function fakeSceneManager(): SceneManager {
  return {
    camera: new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 400),
    getLook: () => JUNGLE_LOOK,
  } as unknown as SceneManager;
}

/** Renderable objects that would each cost (at least) one draw call. */
function renderables(root: THREE.Object3D): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  root.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    if (!(m.isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine || (o as THREE.Sprite).isSprite)) return;
    const inst = o as THREE.InstancedMesh;
    if (inst.isInstancedMesh && inst.count === 0) return;
    out.push(o);
  });
  return out;
}

function trianglesOf(o: THREE.Object3D): number {
  const m = o as THREE.Mesh;
  const g = m.geometry as THREE.BufferGeometry | undefined;
  if (g === undefined) return 0;
  const per = g.index !== null ? g.index.count / 3 : (g.getAttribute('position')?.count ?? 0) / 3;
  const inst = o as THREE.InstancedMesh;
  return inst.isInstancedMesh ? per * inst.count : per;
}

/** Every disposable resource reachable from `root` (geometries, materials, textures in maps and uniforms). */
function collectResources(root: THREE.Object3D): Set<THREE.EventDispatcher<{ dispose: object }>> {
  const set = new Set<THREE.EventDispatcher<{ dispose: object }>>();
  const addTex = (v: unknown): void => {
    if (v !== null && typeof v === 'object' && (v as THREE.Texture).isTexture) set.add(v as unknown as THREE.EventDispatcher<{ dispose: object }>);
  };
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    // (THREE.Sprite shares one module-level quad geometry; it is never ours to dispose.)
    if (m.geometry !== undefined && !(o as THREE.Sprite).isSprite) set.add(m.geometry as unknown as THREE.EventDispatcher<{ dispose: object }>);
    const mats = m.material === undefined ? [] : Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) {
      set.add(mat as unknown as THREE.EventDispatcher<{ dispose: object }>);
      const rec = mat as unknown as Record<string, unknown>;
      for (const k of Object.keys(rec)) addTex(rec[k]);
      const uniforms = (mat as THREE.ShaderMaterial).uniforms;
      if (uniforms !== undefined) for (const u of Object.values(uniforms)) addTex(u.value);
    }
  });
  return set;
}

beforeAll(() => {
  vi.stubGlobal('document', fakeDoc);
});
afterAll(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  setQualitySetting('high');
});

describe('JungleScene (built from the arena data)', () => {
  it('draws the 14 trees exactly at their collider positions / radii, plus crates, moss, pads', () => {
    const scene = new JungleScene(fakeSceneManager(), JUNGLE_ARENA);
    const stats = scene.getStats();
    const trees = JUNGLE_ARENA.circles.filter((c) => c.kind === 'tree');
    expect(stats.trees).toBe(14);
    expect(trees.length).toBe(14);
    expect(stats.crates).toBe(JUNGLE_ARENA.crates.length);
    expect(stats.moss).toBe(7);
    // Instance matrices of the trunk mesh: translation = collider centre, X/Z scale = collider radius.
    const trunk = scene.root.children.find((o) => (o as THREE.InstancedMesh).isInstancedMesh && (o as THREE.InstancedMesh).count === 14 && (o as THREE.InstancedMesh).geometry.getAttribute('aFade') !== undefined) as THREE.InstancedMesh;
    expect(trunk).toBeDefined();
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    trees.forEach((t, i) => {
      trunk.getMatrixAt(i, m);
      m.decompose(p, q, s);
      expect(p.x).toBeCloseTo(t.x, 5);
      expect(p.z).toBeCloseTo(t.z, 5);
      expect(s.x).toBeCloseTo(t.radius, 5);
      expect(s.z).toBeCloseTo(t.radius, 5);
    });
    // The canopy sits above 9 m (never hides the third-person camera); the bounding trunk geometry reaches past the collider.
    const canopy = scene.root.children.find((o) => (o as THREE.InstancedMesh).isInstancedMesh && (o as THREE.InstancedMesh).count === stats.canopyClumps && o !== trunk && (o as THREE.InstancedMesh).count > 20) as THREE.InstancedMesh;
    expect(canopy).toBeDefined();
    for (let i = 0; i < stats.canopyClumps; i++) {
      canopy.getMatrixAt(i, m);
      m.decompose(p, q, s);
      expect(p.y - 0.92 * s.y).toBeGreaterThan(9); // lowest point of every clump (displaced icosphere: |y| ≤ 0.92 × scale)
    }
    scene.dispose();
  });

  it('keeps instance counts within the per-tier budgets and the draw-call proxy small', () => {
    const scene = new JungleScene(fakeSceneManager(), JUNGLE_ARENA);
    const high = jungleBudget('high');
    const st = scene.getStats();
    expect(st.ferns).toBeLessThanOrEqual(high.ferns);
    expect(st.reeds).toBeLessThanOrEqual(high.reeds);
    expect(st.vines).toBeLessThan(60);
    const calls = renderables(scene.root);
    expect(calls.length).toBeGreaterThan(15);
    expect(calls.length).toBeLessThanOrEqual(40); // the whole arena scene (incl. 6 pickup beacons) stays far below the 110 budget
    const tris = calls.reduce((n, o) => n + trianglesOf(o), 0);
    expect(tris).toBeLessThan(110_000);
    scene.dispose();
  });

  it('lower tiers cut foliage, mist, shafts, backdrop and motes', () => {
    const scene = new JungleScene(fakeSceneManager(), JUNGLE_ARENA);
    const countsHigh = renderables(scene.root).length;
    const trisHigh = renderables(scene.root).reduce((n, o) => n + trianglesOf(o), 0);
    setQualitySetting('medium');
    expect(scene.getTier()).toBe('medium');
    const mid = renderables(scene.root);
    setQualitySetting('low');
    expect(scene.getTier()).toBe('low');
    const low = renderables(scene.root);
    const trisLow = low.reduce((n, o) => n + trianglesOf(o), 0);
    expect(low.length).toBeLessThan(countsHigh);
    expect(low.length).toBeLessThanOrEqual(mid.length);
    expect(trisLow).toBeLessThan(trisHigh);
    expect(scene.getStats().ferns).toBeLessThanOrEqual(jungleBudget('low').ferns);
    expect(scene.getStats().canopyClumps).toBeLessThan(
      14 * 5 + jungleBudget('high').ceiling,
    );
    setQualitySetting('high');
    expect(scene.getTier()).toBe('high');
    expect(renderables(scene.root).length).toBe(countsHigh);
    scene.dispose();
  });

  it('updates with a focus without throwing; trunk fades stay within [min, 1] and recover', () => {
    const sm = fakeSceneManager();
    const scene = new JungleScene(sm, JUNGLE_ARENA);
    // Camera east of the big tree at (-9.5, -0.3), focus west of it: that trunk must fade, the rest stay solid.
    sm.camera.position.set(-3.5, 4, -0.3);
    scene.setPickupFocus(-14, -0.3);
    for (let i = 0; i < 90; i++) scene.update(1 / 60, 0);
    const fades = scene.getTrunkFades();
    for (const f of fades) {
      expect(f).toBeGreaterThanOrEqual(TRUNK_FADE_MIN - 1e-6);
      expect(f).toBeLessThanOrEqual(1);
    }
    const trees = JUNGLE_ARENA.circles.filter((c) => c.kind === 'tree');
    const idx = trees.findIndex((t) => Math.abs(t.x + 9.5) < 0.01);
    expect(fades[idx]).toBeLessThan(0.2);
    // The fade never jumps by more than a bounded amount per frame.
    sm.camera.position.set(-14, 4, 6);
    scene.setPickupFocus(-14, 0);
    let prev = fades[idx];
    for (let i = 0; i < 240; i++) {
      scene.update(1 / 60, 0);
      const v = scene.getTrunkFades()[idx];
      expect(Math.abs(v - prev)).toBeLessThan(0.06);
      prev = v;
    }
    expect(prev).toBeGreaterThan(0.95);
    scene.dispose();
  });

  it('breaks and restores crates (same ids as the arena data), debris stays pooled', () => {
    const scene = new JungleScene(fakeSceneManager(), JUNGLE_ARENA);
    expect(scene.isCrateAlive(0)).toBe(true);
    scene.breakCrate(0);
    scene.breakCrate(0);
    expect(scene.isCrateAlive(0)).toBe(false);
    for (let id = 0; id < JUNGLE_ARENA.crates.length; id++) scene.breakCrate(id);
    for (let i = 0; i < 400; i++) scene.update(1 / 60, 0);
    scene.resetCrates();
    for (let id = 0; id < JUNGLE_ARENA.crates.length; id++) expect(scene.isCrateAlive(id)).toBe(true);
    scene.breakCrate(-1);
    scene.breakCrate(999);
    scene.dispose();
  });

  it('pickup icons show and hide on the jungle pads', () => {
    const scene = new JungleScene(fakeSceneManager(), JUNGLE_ARENA);
    for (let i = 0; i < JUNGLE_ARENA.pickupPads.length; i++) scene.setPickupVisible(i, 'heal', true);
    scene.setPickupVisible(2, 'speed', true);
    scene.setPickupVisible(2, 'rage', false);
    scene.setPickupVisible(99, 'heal', true);
    scene.update(0.5, 0);
    scene.dispose();
  });

  it('dispose() releases every geometry / material / texture (5 create/dispose cycles stay flat)', () => {
    const counts: number[] = [];
    for (let cycle = 0; cycle < 5; cycle++) {
      const scene = new JungleScene(fakeSceneManager(), JUNGLE_ARENA);
      scene.setPickupFocus(0, -19);
      scene.update(0.016, 0);
      const resources = collectResources(scene.root);
      const disposed = new Set<unknown>();
      for (const r of resources) r.addEventListener('dispose', () => disposed.add(r));
      counts.push(resources.size);
      scene.dispose();
      const leaked = [...resources].filter((r) => !disposed.has(r));
      expect(leaked.map((r) => `${(r as { type?: string }).type}:${(r as unknown as THREE.BufferGeometry).getAttribute?.('position')?.count ?? ''}:${(r as unknown as THREE.BufferGeometry).index?.count ?? ''}`), `cycle ${cycle}`).toEqual([]);
      expect(scene.root.parent).toBeNull();
    }
    expect(new Set(counts).size).toBe(1); // identical resource count every cycle: nothing accumulates
  });

  it('is deterministic: two builds are identical', () => {
    const a = new JungleScene(fakeSceneManager(), JUNGLE_ARENA);
    const b = new JungleScene(fakeSceneManager(), JUNGLE_ARENA);
    expect(a.getStats()).toEqual(b.getStats());
    const ta = renderables(a.root).reduce((n, o) => n + trianglesOf(o), 0);
    const tb = renderables(b.root).reduce((n, o) => n + trianglesOf(o), 0);
    expect(ta).toBe(tb);
    a.dispose();
    b.dispose();
    expect(getQualitySetting()).toBe('high');
  });
});
