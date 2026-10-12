/**
 * OceanScene builder tests (v1.9 WP-O3), node-safe: no GL, no DOM. A fake SceneManager supplies the look. Checks that the scene builds
 * from the ARENA DATA (coral / rocks / arches / pads / crates / ramps counts), instance budgets stay within the per-tier numbers, the
 * draw-call proxy stays small, the tier knobs move, crates break / reset on their levels, the serpent set piece hides when idle and
 * shows from a snapshot block, and every geometry / material / texture the scene made is disposed (5 create/dispose cycles stay flat).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { OCEAN_ARENA, arenaGroundHeight } from '../../src/config/arenas';
import { OCEAN_LOOK } from '../../src/render/SceneManager';
import type { SceneManager } from '../../src/render/SceneManager';
import { OceanScene, oceanBudget } from '../../src/render/ocean/OceanScene';
import { arenaShake } from '../../src/render/arenaContext';
import { setQualitySetting } from '../../src/render/quality';
import type { WorldSnapshot } from '../../src/core/types';

const fakeDoc = {
  createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => null }),
};

beforeAll(() => {
  vi.stubGlobal('document', fakeDoc);
});
afterAll(() => {
  vi.unstubAllGlobals();
});

function fakeSceneManager(): SceneManager {
  return {
    camera: new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 400),
    getLook: () => OCEAN_LOOK,
  } as unknown as SceneManager;
}

function renderables(root: THREE.Object3D): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  root.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    if (!(m.isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine || (o as THREE.Sprite).isSprite)) return;
    const inst = o as THREE.InstancedMesh;
    if (inst.isInstancedMesh && inst.count === 0) return;
    const ibg = m.geometry as THREE.InstancedBufferGeometry | undefined;
    if (ibg !== undefined && ibg.isInstancedBufferGeometry && ibg.instanceCount === 0) return;
    out.push(o);
  });
  return out;
}

function trianglesOf(o: THREE.Object3D): number {
  const m = o as THREE.Mesh;
  const g = m.geometry as THREE.BufferGeometry | undefined;
  if (g === undefined) return 0;
  let per = g.index !== null ? g.index.count / 3 : (g.getAttribute('position')?.count ?? 0) / 3;
  if (g.drawRange.count !== Infinity && g.index !== null) per = Math.min(per, g.drawRange.count / 3);
  const inst = o as THREE.InstancedMesh;
  if (inst.isInstancedMesh) return per * inst.count;
  const ibg = g as THREE.InstancedBufferGeometry;
  return ibg.isInstancedBufferGeometry ? per * ibg.instanceCount : per;
}

function collectResources(root: THREE.Object3D): Set<THREE.EventDispatcher<{ dispose: object }>> {
  const set = new Set<THREE.EventDispatcher<{ dispose: object }>>();
  const addTex = (v: unknown): void => {
    if (v !== null && typeof v === 'object' && (v as THREE.Texture).isTexture) set.add(v as unknown as THREE.EventDispatcher<{ dispose: object }>);
  };
  root.traverse((o) => {
    const m = o as THREE.Mesh;
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

function snap(serpent?: { phase: 'warn' | 'strike' | 'hold' | 'retreat'; angleDeg: number; t: number; headR: number }): WorldSnapshot {
  return { time: 1, fighters: [], pickups: [], crates: [], traps: [], bloodlustMult: 1, matchOver: false, winnerId: -1, ...(serpent !== undefined ? { serpent } : {}) } as unknown as WorldSnapshot;
}

afterEach(() => {
  setQualitySetting('high');
  arenaShake.amount = 0;
});

describe('OceanScene (built from the arena data)', () => {
  it('draws coral / rocks / arches / pads / crates / ramps exactly as the arena lists them', () => {
    const scene = new OceanScene(fakeSceneManager(), OCEAN_ARENA);
    const st = scene.getStats();
    expect(st.coral).toBe(OCEAN_ARENA.circles.filter((c) => c.kind === 'coral').length);
    expect(st.rocks).toBe(OCEAN_ARENA.circles.filter((c) => c.kind === 'rock').length);
    expect(st.arches).toBe(OCEAN_ARENA.segments.filter((s) => s.kind === 'arch').length);
    expect(st.pads).toBe(OCEAN_ARENA.pickupPads.length);
    expect(st.crates).toBe(OCEAN_ARENA.crates.length);
    expect(st.ramps).toBe(OCEAN_ARENA.heightfield!.filter((p) => p.kind === 'ramp').length);
    expect(st.ramps).toBe(9);
    expect(st.bulbs).toBeGreaterThan(50);
    scene.dispose();
  });

  it('crates stand on their level (baseY) and break / reset like the other arenas', () => {
    const scene = new OceanScene(fakeSceneManager(), OCEAN_ARENA);
    const crate = scene.root.children.find((o) => (o as THREE.InstancedMesh).isInstancedMesh && o.name === 'ocean-crates') as THREE.InstancedMesh;
    expect(crate).toBeDefined();
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    OCEAN_ARENA.crates.forEach((c, i) => {
      crate.getMatrixAt(i, m);
      m.decompose(p, q, s);
      expect(p.x).toBeCloseTo(c.x, 5);
      expect(p.z).toBeCloseTo(c.z, 5);
      expect(p.y).toBeCloseTo((c.baseY ?? 0) + c.height / 2, 5);
    });
    // at least one cluster is on the terrace (raised)
    expect(OCEAN_ARENA.crates.some((c) => (c.baseY ?? 0) > 1)).toBe(true);
    expect(scene.isCrateAlive(0)).toBe(true);
    scene.breakCrate(0);
    scene.breakCrate(0);
    expect(scene.isCrateAlive(0)).toBe(false);
    for (let id = 0; id < OCEAN_ARENA.crates.length; id++) scene.breakCrate(id);
    for (let i = 0; i < 400; i++) scene.update(1 / 60, 0);
    scene.resetCrates();
    for (let id = 0; id < OCEAN_ARENA.crates.length; id++) expect(scene.isCrateAlive(id)).toBe(true);
    scene.breakCrate(-1);
    scene.breakCrate(999);
    scene.dispose();
  });

  it('pickup icons show / hide on the six pads, which sit on their own levels', () => {
    const scene = new OceanScene(fakeSceneManager(), OCEAN_ARENA);
    for (let i = 0; i < OCEAN_ARENA.pickupPads.length; i++) scene.setPickupVisible(i, 'heal', true);
    scene.setPickupVisible(2, 'speed', true);
    scene.setPickupVisible(2, 'rage', false);
    scene.setPickupVisible(99, 'heal', true);
    scene.update(0.5, 0);
    const ys = OCEAN_ARENA.pickupPads.map((p) => arenaGroundHeight(OCEAN_ARENA, p.x, p.z));
    expect(Math.max(...ys)).toBe(3); // the centre plateau pad
    expect(ys.filter((y) => y === 1.5).length).toBe(2); // the terrace pads
    expect(ys.filter((y) => y === 0).length).toBe(3); // the seabed pads
    scene.dispose();
  });

  it('keeps instance counts within the per-tier budgets and the draw-call proxy small', () => {
    const scene = new OceanScene(fakeSceneManager(), OCEAN_ARENA);
    const high = scene.getStats().life;
    expect(high.fish).toBeLessThanOrEqual(146);
    expect(high.sharks).toBe(3);
    expect(high.whales).toBe(2);
    expect(high.mantas).toBeGreaterThanOrEqual(3);
    expect(high.turtles).toBeGreaterThanOrEqual(3);
    expect(high.jellies).toBeGreaterThan(10);
    const calls = renderables(scene.root);
    expect(calls.length).toBeGreaterThan(18);
    expect(calls.length).toBeLessThanOrEqual(50); // scene only (the 10 rigs + effects are on top); the 110 total budget leaves room
    const tris = calls.reduce((n, o) => n + trianglesOf(o), 0);
    expect(tris).toBeLessThan(135_000);
    scene.dispose();
  });

  it('lower tiers cut sea life, snow, shafts, the surface and the reef', () => {
    const scene = new OceanScene(fakeSceneManager(), OCEAN_ARENA);
    const countsHigh = renderables(scene.root).length;
    const trisHigh = renderables(scene.root).reduce((n, o) => n + trianglesOf(o), 0);
    const lifeHigh = scene.getStats().life;
    setQualitySetting('medium');
    expect(scene.getTier()).toBe('medium');
    const mid = renderables(scene.root);
    const lifeMid = scene.getStats().life;
    setQualitySetting('low');
    expect(scene.getTier()).toBe('low');
    const low = renderables(scene.root);
    const trisLow = low.reduce((n, o) => n + trianglesOf(o), 0);
    const lifeLow = scene.getStats().life;
    expect(low.length).toBeLessThan(countsHigh);
    expect(low.length).toBeLessThanOrEqual(mid.length);
    expect(trisLow).toBeLessThan(trisHigh * 0.8);
    expect(lifeLow.fish).toBeLessThan(lifeMid.fish);
    expect(lifeMid.fish).toBeLessThan(lifeHigh.fish);
    expect(lifeLow.jellies).toBe(0); // no jellyfish (and no glow) on low
    expect(lifeLow.sharks).toBeGreaterThanOrEqual(2);
    expect(lifeLow.kelp).toBeLessThan(lifeHigh.kelp);
    expect(oceanBudget('low').snow).toBe(0);
    expect(oceanBudget('high').snow).toBeGreaterThan(oceanBudget('medium').snow);
    setQualitySetting('high');
    expect(scene.getTier()).toBe('high');
    expect(renderables(scene.root).length).toBe(countsHigh);
    scene.dispose();
  });

  it('the serpent set piece is hidden when idle, shows from a snapshot block and hides again (with a short withdrawal)', () => {
    const scene = new OceanScene(fakeSceneManager(), OCEAN_ARENA);
    scene.setPickupFocus(0, -20);
    scene.setSnapshot(snap());
    scene.update(1 / 60, 0);
    expect(scene.serpentModel.root.visible).toBe(false);
    expect(scene.serpentFx.strip.mesh.visible).toBe(false);
    expect(arenaShake.amount).toBe(0);
    scene.setSnapshot(snap({ phase: 'warn', angleDeg: 200, t: 0.2, headR: 30 }), 1);
    scene.update(1 / 60, 0);
    expect(scene.serpentModel.root.visible).toBe(true);
    expect(scene.serpentFx.strip.mesh.visible).toBe(true);
    expect(scene.getVisual().phase).toBe('warn');
    expect(arenaShake.amount).toBeGreaterThan(0);
    scene.setSnapshot(snap({ phase: 'strike', angleDeg: 200, t: 0.1, headR: 23 }), 1);
    scene.onEvent({ type: 'serpentStrike', angleDeg: 200 });
    scene.update(1 / 60, 0);
    expect(scene.serpentFx.liveShards).toBeGreaterThan(10);
    expect(scene.getGlass().uniforms.uHole.value).toBeGreaterThan(0);
    // the event ends: the sim drops the block; the serpent withdraws for ~1.5 s, then everything is hidden
    scene.setSnapshot(snap());
    scene.update(1 / 60, 0);
    expect(scene.getVisual().phase).toBe('exit');
    for (let i = 0; i < 120; i++) scene.update(1 / 60, 0);
    expect(scene.serpentModel.root.visible).toBe(false);
    expect(scene.getVisual().active).toBe(false);
    expect(scene.getGlass().uniforms.uCrack.value).toBe(0);
    scene.dispose();
    expect(arenaShake.amount).toBe(0);
  });

  it('dispose() releases every geometry / material / texture (5 create/dispose cycles stay flat)', () => {
    const counts: number[] = [];
    for (let cycle = 0; cycle < 5; cycle++) {
      const scene = new OceanScene(fakeSceneManager(), OCEAN_ARENA);
      scene.setPickupFocus(0, -24);
      scene.setSnapshot(snap({ phase: 'strike', angleDeg: 40, t: 0.1, headR: 23 }), 1);
      scene.onEvent({ type: 'serpentStrike', angleDeg: 40 });
      scene.update(0.016, 0);
      const resources = collectResources(scene.root);
      const disposed = new Set<unknown>();
      for (const r of resources) r.addEventListener('dispose', () => disposed.add(r));
      counts.push(resources.size);
      scene.dispose();
      const leaked = [...resources].filter((r) => !disposed.has(r));
      expect(leaked.map((r) => `${(r as { type?: string }).type}:${(r as unknown as THREE.BufferGeometry).getAttribute?.('position')?.count ?? ''}`), `cycle ${cycle}`).toEqual([]);
      expect(scene.root.parent).toBeNull();
    }
    expect(new Set(counts).size).toBe(1);
  });

  it('is deterministic: two builds are identical', () => {
    const a = new OceanScene(fakeSceneManager(), OCEAN_ARENA);
    const b = new OceanScene(fakeSceneManager(), OCEAN_ARENA);
    expect(a.getStats()).toEqual(b.getStats());
    const ta = renderables(a.root).reduce((n, o) => n + trianglesOf(o), 0);
    const tb = renderables(b.root).reduce((n, o) => n + trianglesOf(o), 0);
    expect(ta).toBe(tb);
    a.dispose();
    b.dispose();
  });
});
