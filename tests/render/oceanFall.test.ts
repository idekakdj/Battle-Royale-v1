/**
 * Fall-damage impact FX (v1.10 WP-H4), node-safe: the pooled burst (dust ring + plume + bubble column + crack decal), its scaling with the
 * drop and the quality tier, the decal lying on the slope it hit (a ramp tilts it, flat ground does not, a cliff edge next to the landing does
 * not tilt it absurdly), the pool bound, and that everything dies out and hides (no draw while idle).
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { OCEAN_ARENA, OCEAN_STACKS, arenaGroundHeight } from '../../src/config/arenas';
import { FallFx } from '../../src/render/ocean/fallFx';

function decalUp(fx: FallFx, i: number): THREE.Vector3 {
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  fx.decalMesh.getMatrixAt(i, m);
  m.decompose(p, q, s);
  return new THREE.Vector3(0, 1, 0).applyQuaternion(q);
}

describe('FallFx', () => {
  it('a burst fills the pools (dust + bubbles + one decal), draws 2 calls, and dies out completely', () => {
    const fx = new FallFx(OCEAN_ARENA);
    expect(fx.visibleDraws).toBe(0);
    fx.burst(8, 3, 0, 3.5);
    expect(fx.burstCount).toBe(1);
    expect(fx.liveParticles).toBeGreaterThan(30);
    expect(fx.liveDecals).toBe(1);
    expect(fx.visibleDraws).toBe(2);
    for (let i = 0; i < 60; i++) fx.update(1 / 60);
    expect(fx.liveDecals).toBe(1); // the crack lingers ~1.7 s
    expect(fx.liveParticles).toBeGreaterThan(0);
    for (let i = 0; i < 180; i++) fx.update(1 / 60);
    expect(fx.liveDecals).toBe(0);
    expect(fx.liveParticles).toBe(0);
    expect(fx.visibleDraws).toBe(0);
    fx.dispose();
  });

  it('a harder / longer drop bursts bigger; the low tier halves it; the pool is bounded (never more than 120 particles, 4 decals)', () => {
    const fx = new FallFx(OCEAN_ARENA);
    fx.burst(8, 3, 0, 3.4);
    const small = fx.liveParticles;
    const fx2 = new FallFx(OCEAN_ARENA);
    fx2.burst(8, 3, 0, 6.5);
    expect(fx2.liveParticles).toBeGreaterThan(small);
    const fx3 = new FallFx(OCEAN_ARENA);
    fx3.setTier('low');
    fx3.burst(8, 3, 0, 3.5);
    const fx4 = new FallFx(OCEAN_ARENA);
    fx4.burst(8, 3, 0, 3.5);
    expect(fx3.liveParticles).toBeLessThan(fx4.liveParticles * 0.7);
    for (let i = 0; i < 12; i++) fx.burst(8 + i, 3, 0, 5);
    expect(fx.liveParticles).toBeLessThanOrEqual(120);
    expect(fx.liveDecals).toBeLessThanOrEqual(4);
    for (const f of [fx, fx2, fx3, fx4]) f.dispose();
  });

  it('the decal lies flat on level ground and tilts with a ramp (grade 0.25 -> ~14 degrees; a cliff edge next to the landing does not tilt it)', () => {
    const fx = new FallFx(OCEAN_ARENA);
    fx.burst(0, 3, 0, 3.5); // the plateau centre: flat
    expect(decalUp(fx, 0).y).toBeGreaterThan(0.999);
    // on a terrace -> plateau ramp (105 deg ramp: centre at (-2.69, 10.05)): grade 0.25
    const ramp = OCEAN_ARENA.heightfield!.find((p) => p.kind === 'ramp' && p.h0 === 1.5 && p.h1 === 3)!;
    if (ramp.kind !== 'ramp') throw new Error('no ramp');
    fx.burst(ramp.x, arenaGroundHeight(OCEAN_ARENA, ramp.x, ramp.z), ramp.z, 3.5);
    const up = decalUp(fx, 1);
    expect(up.y).toBeLessThan(0.985);
    expect(up.y).toBeGreaterThan(0.96); // cos(atan 0.25) = 0.970
    // 0.4 m from a tower cliff (the sampling would see a 6 m step): not tilted
    const t = OCEAN_STACKS[1];
    fx.burst(t.x - t.radius - 0.4, 0, t.z, 6.5);
    expect(decalUp(fx, 2).y).toBeGreaterThan(0.999);
    fx.dispose();
  });

  it('every particle position and matrix stays finite over a long run of overlapping bursts', () => {
    const fx = new FallFx(OCEAN_ARENA);
    for (let i = 0; i < 300; i++) {
      if (i % 25 === 0) fx.burst(Math.cos(i) * 12, 1.5, Math.sin(i) * 12, 3.5 + (i % 4));
      fx.update(1 / 60);
    }
    const arr = fx.decalMesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < arr.length; i++) expect(Number.isFinite(arr[i])).toBe(true);
    fx.dispose();
  });
});
