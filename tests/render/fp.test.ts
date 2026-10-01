/**
 * First-person mode (v1.3 WP-Q): pure logic — eye maths, pitch clamp, FOV
 * conversion, mode-switch easing, view kick, arena clamp — plus the CameraRig
 * guarantee that the FP camera is driven ONLY by yaw / pitch (never by the
 * body it follows) and the profile registry's completeness.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ANIMAL_IDS } from '../../src/config/animals';
import { PILLARS, WALL_RADIUS } from '../../src/config/arena';
import { CameraRig } from '../../src/render/CameraRig';
import { getFpProfile } from '../../src/render/animals/fp';
import type { FpEyeSample } from '../../src/render/animals/fp/types';
import {
  FP_FOV_DEFAULT,
  FP_FOV_MAX,
  FP_FOV_MIN,
  FP_PITCH_LIMIT,
  FP_SWITCH_SECONDS,
  ViewKick,
  angleDiff,
  clampEyeToArena,
  clampFpFov,
  clampFpPitch,
  clampLength3,
  easeAngle,
  eyeWorldOffset,
  fpVerticalFov,
  lookDirection,
  runBob,
  smoothStep01,
  stepBlend,
} from '../../src/render/animals/fp/math';

const DEG = Math.PI / 180;

describe('pitch clamp', () => {
  it('clamps to +-80 degrees and passes small angles through', () => {
    expect(clampFpPitch(2)).toBeCloseTo(80 * DEG, 10);
    expect(clampFpPitch(-2)).toBeCloseTo(-80 * DEG, 10);
    expect(clampFpPitch(0.3)).toBe(0.3);
    expect(FP_PITCH_LIMIT).toBeCloseTo(80 * DEG, 10);
  });
});

describe('field of view', () => {
  it('clamps the setting to 60-110 and defaults NaN', () => {
    expect(clampFpFov(30)).toBe(FP_FOV_MIN);
    expect(clampFpFov(200)).toBe(FP_FOV_MAX);
    expect(clampFpFov(Number.NaN)).toBe(FP_FOV_DEFAULT);
    expect(FP_FOV_DEFAULT).toBe(85);
  });
  it('converts a horizontal FOV to a vertical one for the aspect ratio', () => {
    // 90 deg horizontal at 1:1 is 90 vertical; at 16:9 it is about 58.7.
    expect(fpVerticalFov(90, 1)).toBeCloseTo(90, 5);
    expect(fpVerticalFov(90, 16 / 9)).toBeCloseTo(58.7, 1);
    expect(fpVerticalFov(110, 16 / 9)).toBeGreaterThan(fpVerticalFov(60, 16 / 9));
    expect(fpVerticalFov(110, 0.3)).toBeLessThanOrEqual(110);
    expect(fpVerticalFov(60, 5)).toBeGreaterThanOrEqual(20);
  });
});

describe('mode-switch easing', () => {
  it('reaches the target in FP_SWITCH_SECONDS and never overshoots', () => {
    let b = 0;
    const steps = Math.ceil(FP_SWITCH_SECONDS * 60) + 1;
    for (let i = 0; i < steps; i++) {
      const next = stepBlend(b, true, 1 / 60);
      expect(next).toBeGreaterThanOrEqual(b);
      expect(next).toBeLessThanOrEqual(1);
      b = next;
    }
    expect(b).toBe(1);
    for (let i = 0; i < steps; i++) b = stepBlend(b, false, 1 / 60);
    expect(b).toBe(0);
  });
  it('smoothStep is monotone with zero slope at the ends', () => {
    expect(smoothStep01(0)).toBe(0);
    expect(smoothStep01(1)).toBe(1);
    expect(smoothStep01(0.5)).toBeCloseTo(0.5, 10);
    expect(smoothStep01(0.01)).toBeLessThan(0.001);
    let prev = 0;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const v = smoothStep01(t);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = v;
    }
  });
});

describe('eye maths', () => {
  it('rotates a rig-local eye offset by the rig yaw (forward = (sin yaw, cos yaw))', () => {
    const o = { x: 0, y: 0, z: 0 };
    eyeWorldOffset(0, 0, 1.4, 1, o);
    expect(o.x).toBeCloseTo(0, 10);
    expect(o.z).toBeCloseTo(1, 10);
    expect(o.y).toBe(1.4);
    eyeWorldOffset(Math.PI / 2, 0, 1.4, 1, o); // facing +x
    expect(o.x).toBeCloseTo(1, 10);
    expect(o.z).toBeCloseTo(0, 10);
    // Local +x is the animal's LEFT: facing +z, left is world +x.
    eyeWorldOffset(0, 0.5, 0, 0, o);
    expect(o.x).toBeCloseTo(0.5, 10);
  });
  it('lookDirection matches the movement basis and is a unit vector', () => {
    const d = { x: 0, y: 0, z: 0 };
    lookDirection(0, 0, d);
    expect(d).toEqual({ x: 0, y: 0, z: 1 });
    lookDirection(1.1, 0.7, d);
    expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 10);
    expect(d.y).toBeCloseTo(Math.sin(0.7), 10);
    expect(Math.atan2(d.x, d.z)).toBeCloseTo(1.1, 10);
  });
  it('clampLength3 bounds the head-follow displacement', () => {
    const v = { x: 3, y: 4, z: 0 };
    clampLength3(v, 1);
    expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(1, 10);
    const w = { x: 0.1, y: 0, z: 0 };
    clampLength3(w, 1);
    expect(w.x).toBe(0.1);
  });
  it('runBob is bounded by its amplitude and off at rest', () => {
    for (let p = 0; p < 20; p += 0.37) expect(Math.abs(runBob(p, 0.03, 1))).toBeLessThanOrEqual(0.03 + 1e-12);
    expect(runBob(1.2, 0.03, 0)).toBe(0);
  });
});

describe('arena clamp', () => {
  it('leaves a clear eye alone', () => {
    const off = { x: 0.5, z: 0.5 };
    clampEyeToArena(0, 0, off);
    expect(off).toEqual({ x: 0.5, z: 0.5 });
  });
  it('pulls the eye out of a pillar and back inside the wall', () => {
    const p = PILLARS[0];
    const root = { x: p.x + p.radius + 0.5, z: p.z };
    const off = { x: p.x - root.x, z: p.z - root.z }; // lands the eye on the pillar centre
    clampEyeToArena(root.x, root.z, off);
    const ex = root.x + off.x - p.x;
    const ez = root.z + off.z - p.z;
    expect(Math.hypot(ex, ez)).toBeGreaterThan(p.radius);
    const wall = { x: WALL_RADIUS - 1, z: 0 };
    const off2 = { x: 3, z: 0 }; // eye would be beyond the wall
    clampEyeToArena(wall.x, wall.z, off2);
    expect(Math.hypot(wall.x + off2.x, wall.z + off2.z)).toBeLessThan(WALL_RADIUS);
  });
});

describe('view kick', () => {
  it('jolts then settles back to level, bounded', () => {
    const k = new ViewKick();
    k.kick(0.05, -0.03);
    let peak = 0;
    for (let i = 0; i < 12; i++) {
      k.update(1 / 60);
      peak = Math.max(peak, Math.abs(k.pitch));
    }
    expect(peak).toBeGreaterThan(0.005);
    expect(peak).toBeLessThanOrEqual(0.14);
    for (let i = 0; i < 240; i++) k.update(1 / 60);
    expect(k.pitch).toBe(0);
    expect(k.roll).toBe(0);
  });
  it('stacked hits can never tumble the view', () => {
    const k = new ViewKick();
    for (let i = 0; i < 40; i++) {
      k.kick(0.2, 0.2);
      k.update(1 / 60);
      expect(Math.abs(k.pitch)).toBeLessThanOrEqual(0.14);
      expect(Math.abs(k.roll)).toBeLessThanOrEqual(0.14);
    }
  });
});

describe('angles', () => {
  it('angleDiff takes the short way round', () => {
    expect(angleDiff(0.1, -0.1)).toBeCloseTo(-0.2, 10);
    expect(angleDiff(3.0, -3.0)).toBeCloseTo(2 * Math.PI - 6, 10);
  });
  it('easeAngle converges without crossing the target', () => {
    let a = 3;
    for (let i = 0; i < 120; i++) a = easeAngle(a, -3, 8, 1 / 60);
    expect(Math.abs(angleDiff(a, -3))).toBeLessThan(0.01);
  });
});

describe('CameraRig first person', () => {
  function makeRig(): { rig: CameraRig; camera: THREE.PerspectiveCamera; body: { x: number; y: number; z: number; spin: number } } {
    const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 400);
    const rig = new CameraRig(camera);
    const body = { x: 2, y: 0, z: -5, spin: 0 };
    rig.follow((out) => out.set(body.x, body.y, body.z), 1.6);
    rig.setFpAnchor((s: FpEyeSample) => {
      // A spinning, rolling body: the eye sample only reports position (never orientation).
      s.rootX = body.x;
      s.rootY = body.y;
      s.rootZ = body.z;
      s.relX = Math.sin(body.spin) * 0.2;
      s.relY = 1.4 + Math.cos(body.spin * 3) * 0.1;
      s.relZ = Math.cos(body.spin) * 0.2;
      s.bobY = 0;
      s.bobSide = 0;
      s.roll = 0;
      s.near = 0.05;
    });
    rig.snap();
    return { rig, camera, body };
  }

  it('looks exactly along yaw / pitch and stays level while the body spins and rolls', () => {
    const { rig, camera, body } = makeRig();
    rig.setFirstPerson(true, true);
    rig.yaw = 0.8;
    rig.fpPitch = 0.25;
    const want = { x: 0, y: 0, z: 0 };
    const dir = new THREE.Vector3();
    for (let i = 0; i < 90; i++) {
      body.spin += 0.45; // furious death-roll-style spin
      body.x += 0.01;
      rig.update(1 / 60);
      camera.getWorldDirection(dir);
      lookDirection(rig.yaw, rig.fpPitch, want);
      expect(dir.x).toBeCloseTo(want.x, 4);
      expect(dir.y).toBeCloseTo(want.y, 4);
      expect(dir.z).toBeCloseTo(want.z, 4);
      // Level horizon: the camera's right axis has no vertical component.
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      expect(Math.abs(right.y)).toBeLessThan(1e-4);
    }
    expect(rig.isFirstPerson).toBe(true);
    expect(rig.fpAmount).toBe(1);
  });

  it('mouse pitch is clamped to +-80 degrees in first person and the orbit pitch is untouched', () => {
    const { rig } = makeRig();
    rig.setFirstPerson(true, true);
    const orbit = rig.pitch;
    rig.applyMouseDelta(0, -100000); // mouse up = look up
    expect(rig.fpPitch).toBeCloseTo(80 * DEG, 6);
    rig.applyMouseDelta(0, 100000);
    expect(rig.fpPitch).toBeCloseTo(-80 * DEG, 6);
    expect(rig.pitch).toBe(orbit);
  });

  it('switching modes blends smoothly (no position pop) and restores the third-person camera', () => {
    const { rig, camera } = makeRig();
    for (let i = 0; i < 60; i++) rig.update(1 / 60);
    const tp = camera.position.clone();
    rig.setFirstPerson(true);
    let prev = camera.position.clone();
    let maxStep = 0;
    for (let i = 0; i < 40; i++) {
      rig.update(1 / 60);
      maxStep = Math.max(maxStep, camera.position.distanceTo(prev));
      prev = camera.position.clone();
    }
    expect(rig.fpAmount).toBe(1);
    // The 6.5 m dolly is spread over ~25 frames: no single frame jumps more than a third of it.
    expect(maxStep).toBeLessThan(6.5 / 3);
    rig.setFirstPerson(false);
    for (let i = 0; i < 60; i++) rig.update(1 / 60);
    expect(rig.fpAmount).toBe(0);
    expect(camera.position.distanceTo(tp)).toBeLessThan(0.05);
    expect(camera.near).toBeCloseTo(0.1, 3);
    expect(camera.fov).toBeCloseTo(55, 2);
  });

  it('spectating always forces third person', () => {
    const { rig } = makeRig();
    rig.setFirstPerson(true, true);
    rig.setSpectate(true);
    expect(rig.isFirstPerson).toBe(false);
    rig.setFirstPerson(true);
    expect(rig.isFirstPerson).toBe(false);
  });

  it('applies the horizontal FOV setting and the profile near plane', () => {
    const { rig, camera } = makeRig();
    rig.setFpFov(100);
    rig.setFirstPerson(true, true);
    rig.update(1 / 60);
    expect(camera.fov).toBeCloseTo(fpVerticalFov(100, 16 / 9), 2);
    expect(camera.near).toBeCloseTo(0.05, 3);
  });
});

describe('FP profiles', () => {
  it('has a complete, sane profile for every animal', () => {
    for (const id of ANIMAL_IDS) {
      const p = getFpProfile(id);
      expect(p.animal).toBe(id);
      expect(p.eye.up).toBeGreaterThan(0.3);
      expect(p.nearPlane).toBeGreaterThan(0.01);
      expect(p.nearPlane).toBeLessThan(0.1);
      expect(p.hide.length).toBeGreaterThan(0);
      if (p.follow !== undefined) {
        expect(p.follow).toBeGreaterThanOrEqual(0);
        expect(p.follow).toBeLessThanOrEqual(1);
      }
    }
  });
});
