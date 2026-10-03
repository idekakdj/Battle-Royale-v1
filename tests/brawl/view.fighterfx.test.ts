/**
 * Per-fighter feedback (WP-R): percent rim/steam/embers, invulnerability pulse, dodge ghosts, launch trails, hit/armor flashes,
 * material isolation between fighters and clean disposal. Uses the real pose rig (no WebGL needed).
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FighterFx } from '../../src/brawl/render/fighterFx';
import { createBrawlRig } from '../../src/brawl/render/pose';
import { Vfx } from '../../src/brawl/render/vfx/Vfx';
import { mkState } from './poseHelpers';

function setup(animal: 'lion' | 'gorilla' = 'lion') {
  const rig = createBrawlRig(animal);
  const vfx = new Vfx(600, 300);
  const parent = new THREE.Group();
  const fx = new FighterFx(rig, animal, vfx, parent, 1.1, 1.5);
  return { rig, vfx, parent, fx };
}

function emissiveSum(rig: ReturnType<typeof createBrawlRig>): number {
  let s = 0;
  rig.root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (m && !Array.isArray(m) && m.emissive && m.side !== THREE.BackSide && m.colorWrite) s += m.emissive.r + m.emissive.g + m.emissive.b;
  });
  return s;
}

function run(fx: FighterFx, vfx: Vfx, st: ReturnType<typeof mkState>, seconds: number): void {
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    fx.update(st, 0, 0, 1 / 60, i / 60);
    vfx.update(1 / 60);
  }
}

describe('FighterFx', () => {
  it('has no percent feedback below 100 %, steam at ≥ 100 %, embers at ≥ 150 %', () => {
    const a = setup();
    run(a.fx, a.vfx, mkState('lion', { percent: 60 }), 1);
    expect(a.vfx.live).toBe(0);
    expect(emissiveSum(a.rig)).toBeCloseTo(0, 5);

    const b = setup();
    const st = mkState('lion', { percent: 120 });
    let alphaSeen = 0;
    for (let i = 0; i < 60; i++) {
      b.fx.update(st, 0, 0, 1 / 60, i / 60);
      alphaSeen = Math.max(alphaSeen, b.vfx.alpha.n);
    }
    expect(alphaSeen).toBeGreaterThan(0); // steam puffs (alpha pool)
    expect(b.vfx.add.n).toBe(0); // no embers yet
    expect(emissiveSum(b.rig)).toBeGreaterThan(0.05); // red rim

    const c = setup();
    const st2 = mkState('lion', { percent: 200 });
    let addSeen = 0;
    for (let i = 0; i < 90; i++) {
      c.fx.update(st2, 0, 0, 1 / 60, i / 60);
      addSeen = Math.max(addSeen, c.vfx.add.n);
    }
    expect(addSeen).toBeGreaterThan(0); // embers (additive pool)
    expect(emissiveSum(c.rig)).toBeGreaterThan(emissiveSum(b.rig)); // the rim grows with the percent
    for (const s of [a, b, c]) {
      s.fx.dispose();
      s.rig.dispose();
    }
  });

  it('pulses while invulnerable, flashes on hit / armor and decays', () => {
    const s = setup();
    const st = mkState('lion', { invuln: 40 });
    run(s.fx, s.vfx, st, 0.3);
    expect(emissiveSum(s.rig)).toBeGreaterThan(0.05);
    st.invuln = 0;
    run(s.fx, s.vfx, st, 0.2);
    expect(emissiveSum(s.rig)).toBeCloseTo(0, 5);
    s.fx.onHit();
    s.fx.update(st, 0, 0, 1 / 60, 0);
    const hit = emissiveSum(s.rig);
    expect(hit).toBeGreaterThan(1);
    run(s.fx, s.vfx, st, 0.5);
    expect(emissiveSum(s.rig)).toBeLessThan(hit * 0.2);
    s.fx.onArmor();
    s.fx.update(st, 0, 0, 1 / 60, 0);
    expect(emissiveSum(s.rig)).toBeGreaterThan(1);
    s.fx.dispose();
    s.rig.dispose();
  });

  it('emits dodge ghosts, launch trails (> 25 m/s) and tumble dust; respawn shows the hover pad', () => {
    const s = setup();
    run(s.fx, s.vfx, mkState('lion', { action: 'dodgeRoll', invuln: 14, grounded: true }), 0.3);
    expect(s.vfx.add.n).toBeGreaterThan(0);
    s.vfx.clear();

    const slow = mkState('lion', { action: 'tumble', vel: { x: 12, y: 4 }, grounded: false, hitlag: 0 });
    run(s.fx, s.vfx, slow, 0.3);
    const slowCount = s.vfx.add.n + s.vfx.alpha.n;
    s.vfx.clear();
    const fast = mkState('lion', { action: 'tumble', vel: { x: 40, y: 12 }, grounded: false, hitlag: 0 });
    run(s.fx, s.vfx, fast, 0.1);
    expect(s.vfx.add.n).toBeGreaterThan(slowCount === 0 ? 0 : 1); // streak trail + glow + speed lines
    s.vfx.clear();

    s.fx.padX = 3;
    s.fx.padY = 12;
    run(s.fx, s.vfx, mkState('lion', { action: 'respawn', invuln: 170, pos: { x: 3, y: 12 }, grounded: true }), 0.1);
    const pad = s.parent.children[0];
    expect(pad.visible).toBe(true);
    expect(pad.position.x).toBeCloseTo(3, 5);
    run(s.fx, s.vfx, mkState('lion', { action: 'idle' }), 0.05);
    expect(pad.visible).toBe(false);
    s.fx.dispose();
    s.rig.dispose();
  });

  it('gives each fighter its own materials (no tint bleed between two rigs of the same animal)', () => {
    const a = setup();
    const b = setup();
    a.fx.onHit();
    a.fx.update(mkState('lion'), 0, 0, 1 / 60, 0);
    b.fx.update(mkState('lion'), 0, 0, 1 / 60, 0);
    expect(emissiveSum(a.rig)).toBeGreaterThan(1);
    expect(emissiveSum(b.rig)).toBeCloseTo(0, 5);
    for (const s of [a, b]) {
      s.fx.dispose();
      s.rig.dispose();
    }
  });

  it('disposes its pad and cloned materials', () => {
    const s = setup('gorilla');
    let disposed = 0;
    s.rig.root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m && !Array.isArray(m)) m.addEventListener('dispose', () => disposed++);
    });
    s.fx.dispose();
    expect(disposed).toBeGreaterThan(0);
    expect(s.parent.children.length).toBe(0);
    s.rig.dispose();
  });
});
