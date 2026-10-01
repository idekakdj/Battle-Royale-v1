/**
 * First-person ULTIMATE camera director (v1.3 Phase-3c): the pure channel / spring / yaw-ease maths in `fp/ultCam.ts`, the
 * ten per-animal directives in `fp/ult/*`, the CameraRig composition (view-only offsets, mouse locks) and the near-camera
 * fade of the ultimate VFX in `ultFx/index.ts`.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ANIMAL_IDS } from '../../src/config/animals';
import type { AnimalId, FighterState } from '../../src/core/types';
import { CameraRig } from '../../src/render/CameraRig';
import type { FpEyeSample } from '../../src/render/animals/fp/types';
import {
  KickSpring,
  RETURN_RATE,
  UltCamOut,
  UltCamera,
  type UltDirector,
  type UltEnv,
  bump,
  lerp,
  pitchTo,
  ramp,
  sm,
  yawToPoint,
} from '../../src/render/animals/fp/ultCam';
import { getUltDirector } from '../../src/render/animals/fp/ult';
import { UltFxDispatcher, type UltFxHost } from '../../src/render/ultFx';

const DT = 1 / 60;

function fighter(over: Partial<FighterState> = {}): FighterState {
  return {
    id: 0,
    animal: 'lion',
    isPlayer: true,
    alive: true,
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    hp: 100,
    maxHp: 100,
    guard: 0,
    maxGuard: 0,
    guardRegenDelay: 0,
    ultCharge: 0,
    specialCd: 0,
    action: 'idle',
    actionT: 0,
    actionDur: 0,
    comboIndex: 0,
    comboWindow: 0,
    buffs: [],
    kills: 0,
    damageDealt: 0,
    damageBlocked: 0,
    ultsUsed: 0,
    grabTargetId: -1,
    grabbedById: -1,
    airborne: false,
    glideT: 0,
    burrowT: 0,
    ...over,
  } as FighterState;
}

function env(over: Partial<UltEnv> = {}): UltEnv & { yawLog: number[] } {
  const yawLog: number[] = [];
  const e: UltEnv & { yawLog: number[] } = {
    yaw: 0,
    pitch: 0,
    eye: { x: 0, y: 1.4, z: 0 },
    eyeForward: 1,
    victim: (id) => (id === 1 ? { x: 0, y: 0, z: 6 } : null),
    setYaw(y) {
      e.yaw = y;
      yawLog.push(y);
    },
    yawLog,
    ...over,
  };
  return e;
}

const casting = (phase: 'windup' | 'active' | 'recovery', stage: number, extra: Partial<FighterState> = {}): FighterState =>
  fighter({ action: 'ultimate', ultPhase: phase, ultStage: stage, ultTargetId: 1, actionDur: 1, ...extra });

describe('helpers', () => {
  it('ramp / sm / bump / lerp behave', () => {
    expect(ramp(0.5, 0, 1)).toBeCloseTo(0.5);
    expect(ramp(-1, 0, 1)).toBe(0);
    expect(ramp(2, 0, 1)).toBe(1);
    expect(ramp(1, 1, 1)).toBe(1); // degenerate range = step
    expect(sm(0.5, 0, 1)).toBeCloseTo(0.5);
    expect(sm(0, 0, 1)).toBe(0);
    expect(sm(1, 0, 1)).toBe(1);
    expect(bump(0.5, 0, 0.5, 1)).toBeCloseTo(1);
    expect(bump(0, 0, 0.5, 1)).toBe(0);
    expect(bump(1, 0, 0.5, 1)).toBeCloseTo(0);
    expect(lerp(2, 4, 0.25)).toBeCloseTo(2.5);
  });

  it('pitchTo / yawToPoint use the game conventions (+pitch up, forward = (sin yaw, cos yaw))', () => {
    const eye = { x: 0, y: 2, z: 0 };
    expect(pitchTo(eye, 0, 2, 5)).toBeCloseTo(0);
    expect(pitchTo(eye, 0, 0, 2)).toBeCloseTo(-Math.PI / 4);
    expect(pitchTo(eye, 0, 4, 2)).toBeCloseTo(Math.PI / 4);
    expect(yawToPoint(eye, 0, 5)).toBeCloseTo(0);
    expect(yawToPoint(eye, 5, 0)).toBeCloseTo(Math.PI / 2);
    expect(Number.isFinite(pitchTo(eye, 0, 0, 0))).toBe(true); // directly below: finite
  });
});

describe('KickSpring', () => {
  it('peaks at the requested displacement, never rings, and settles to rest', () => {
    const s = new KickSpring();
    s.impulse(-0.1);
    let min = 0;
    let crossed = false;
    for (let i = 0; i < 120; i++) {
      s.step(DT);
      min = Math.min(min, s.x);
      if (s.x > 1e-6) crossed = true;
    }
    expect(min).toBeCloseTo(-0.1, 2);
    expect(crossed).toBe(false); // critically damped: no overshoot to the other side
    expect(s.x).toBe(0);
    expect(s.v).toBe(0);
  });

  it('is stable for large frame times', () => {
    const s = new KickSpring();
    s.impulse(0.3);
    for (let i = 0; i < 40; i++) s.step(0.1);
    expect(Math.abs(s.x)).toBeLessThan(1e-3);
  });
});

describe('UltCamera channels', () => {
  const lift: UltDirector = {
    view(c, v) {
      v.pitch = 0.4;
      v.eyeY = -0.3;
      v.fovPct = 0.1;
      v.follow = 0;
      v.mouseYaw = 0;
      v.vignette = 0.5;
      c.fx.shake(0);
    },
  };

  it('stays neutral when no ultimate runs', () => {
    const cam = new UltCamera(() => lift);
    const e = env();
    for (let i = 0; i < 30; i++) cam.update(DT, fighter(), e);
    expect(cam.out.active).toBe(false);
    expect(cam.out.pitch).toBe(0);
    expect(cam.out.mouseYaw).toBe(1);
    expect(cam.out.follow).toBe(1);
    expect(cam.isCasting).toBe(false);
  });

  it('eases to the directive targets while casting and returns to neutral smoothly after it', () => {
    const cam = new UltCamera(() => lift);
    const e = env();
    const st = casting('active', 1);
    for (let i = 0; i < 60; i++) cam.update(DT, st, e);
    expect(cam.isCasting).toBe(true);
    expect(cam.out.active).toBe(true);
    expect(cam.out.pitch).toBeCloseTo(0.4, 1);
    expect(cam.out.eyeY).toBeCloseTo(-0.3, 1);
    expect(cam.out.fovPct).toBeCloseTo(0.1, 1);
    expect(cam.out.follow).toBeCloseTo(0, 1);
    expect(cam.out.mouseYaw).toBeCloseTo(0, 1);
    // The ultimate ends: monotone, smooth relaxation (no pop), neutral within ~1 s.
    let prev = cam.out.pitch;
    const idle = fighter();
    for (let i = 0; i < 90; i++) {
      cam.update(DT, idle, e);
      expect(cam.out.pitch).toBeLessThanOrEqual(prev + 1e-9);
      expect(prev - cam.out.pitch).toBeLessThan(0.1); // never a pop
      prev = cam.out.pitch;
    }
    expect(Math.abs(cam.out.pitch)).toBeLessThan(0.005);
    expect(cam.out.mouseYaw).toBeCloseTo(1, 2);
    expect(cam.out.follow).toBeCloseTo(1, 2);
    expect(RETURN_RATE).toBeGreaterThan(3);
  });

  it('a dead or third-person player (null state) relaxes at once', () => {
    const cam = new UltCamera(() => lift);
    const e = env();
    for (let i = 0; i < 60; i++) cam.update(DT, casting('active', 1), e);
    for (let i = 0; i < 120; i++) cam.update(DT, null, e);
    expect(cam.isCasting).toBe(false);
    expect(Math.abs(cam.out.eyeY)).toBeLessThan(0.005);
  });

  it('ignores zero / negative frame times (pause)', () => {
    const cam = new UltCamera(() => lift);
    const e = env();
    cam.update(0, casting('active', 1), e);
    cam.update(-1, casting('active', 1), e);
    expect(cam.isCasting).toBe(false);
  });

  it('moves the PLAYER yaw toward yawTo (eased, shortest way) and leaves it alone with NaN', () => {
    const dir: UltDirector = {
      view(_c, v) {
        v.yawTo = 3; // from 0: shortest way is the positive direction
        v.yawRate = 6;
      },
    };
    const cam = new UltCamera(() => dir);
    const e = env();
    for (let i = 0; i < 60; i++) cam.update(DT, casting('active', 1), e);
    expect(e.yaw).toBeGreaterThan(2.9);
    // yawTo across the +-pi seam turns the short way
    const e2 = env({ yaw: 3 });
    const dir2: UltDirector = {
      view(_c, v) {
        v.yawTo = -3;
        v.yawRate = 5;
      },
    };
    const cam2 = new UltCamera(() => dir2);
    cam2.update(DT, casting('active', 1), e2);
    expect(e2.yawLog[0]).toBeGreaterThan(3); // 3 -> -3 is +0.28 rad the short way, not -6
    const e3 = env();
    const cam3 = new UltCamera(() => ({ view: () => undefined }));
    cam3.update(DT, casting('active', 1), e3);
    expect(e3.yawLog.length).toBe(0);
  });

  it('delivers each (phase, stage) beat exactly once, including beats that exist only as events', () => {
    const seen: string[] = [];
    const dir: UltDirector = {
      view: () => undefined,
      stage(c, s) {
        seen.push(c.phase + s);
      },
    };
    const cam = new UltCamera(() => dir);
    const e = env();
    for (let i = 0; i < 5; i++) cam.update(DT, casting('windup', 0), e);
    for (let i = 0; i < 5; i++) cam.update(DT, casting('active', 1), e);
    cam.onStage(7, { x: 0, y: 0, z: 0 }); // the panther's execute: an event the snapshot never shows
    cam.update(DT, casting('active', 1), e);
    cam.update(DT, casting('active', 1), e);
    cam.onStage(1, { x: 0, y: 0, z: 0 }); // already delivered
    for (let i = 0; i < 5; i++) cam.update(DT, casting('active', 2), e);
    expect(seen).toEqual(['windup0', 'active1', 'active7', 'active2']);
  });

  it('once() fires a trigger a single time per cast and re-arms for the next cast', () => {
    let fired = 0;
    const dir: UltDirector = {
      view(c) {
        if (c.once('x', c.t > 0.05)) fired++;
      },
    };
    const cam = new UltCamera(() => dir);
    const e = env();
    for (let i = 0; i < 30; i++) cam.update(DT, casting('active', 1), e);
    expect(fired).toBe(1);
    for (let i = 0; i < 10; i++) cam.update(DT, fighter(), e);
    for (let i = 0; i < 30; i++) cam.update(DT, casting('active', 1), e);
    expect(fired).toBe(2);
  });

  it('kicks, FOV kicks, shake, vignette and flash are impulses that die out on their own', () => {
    const dir: UltDirector = {
      view: () => undefined,
      stage(c) {
        c.fx.kick(-0.1, 0.05);
        c.fx.fov(0.08);
        c.fx.shake(1);
        c.fx.vignette(0.7);
        c.fx.flash(0.6);
      },
    };
    const cam = new UltCamera(() => dir);
    const e = env();
    cam.update(DT, casting('active', 1), e);
    let minKick = 0;
    let maxFov = 0;
    let maxVig = 0;
    let maxFlash = 0;
    for (let i = 0; i < 20; i++) {
      cam.update(DT, casting('active', 1), e);
      minKick = Math.min(minKick, cam.out.kick);
      maxFov = Math.max(maxFov, cam.out.fovPct);
      maxVig = Math.max(maxVig, cam.out.vignette);
      maxFlash = Math.max(maxFlash, cam.out.flash);
    }
    expect(minKick).toBeLessThan(-0.05);
    expect(maxFov).toBeGreaterThan(0.04);
    expect(maxVig).toBeGreaterThan(0.3);
    expect(maxFlash).toBeGreaterThan(0.3);
    for (let i = 0; i < 180; i++) cam.update(DT, fighter(), e);
    expect(cam.out.active).toBe(false);
    expect(cam.out.kick).toBe(0);
    expect(cam.out.flash).toBe(0);
  });

  it('a blink slides the eye from the old spot back to zero without a pop (bounded)', () => {
    const cam = new UltCamera(() => ({ view: () => undefined }));
    const e = env();
    cam.update(DT, casting('active', 1), e);
    cam.onBlink({ x: 0, y: 0, z: 0 }, { x: 40, y: 0, z: 0 }); // absurd distance: clamped
    cam.update(DT, casting('active', 1), e);
    expect(Math.hypot(cam.out.slideX, cam.out.slideY, cam.out.slideZ)).toBeLessThanOrEqual(6.01);
    let prev = Math.abs(cam.out.slideX);
    for (let i = 0; i < 40; i++) {
      cam.update(DT, casting('active', 1), e);
      expect(Math.abs(cam.out.slideX)).toBeLessThanOrEqual(prev + 1e-9);
      prev = Math.abs(cam.out.slideX);
    }
    expect(prev).toBeLessThan(0.05);
  });

  it('exposes the cast context (victim, stage point, aim, stage clock) to directives', () => {
    let seen = false;
    const dir: UltDirector = {
      view(c) {
        if (c.stage === 3 && c.st > 0.1 && c.victim !== null && c.stagePos !== null && c.aim !== null) {
          expect(c.victim.z).toBe(6);
          expect(c.stagePos.x).toBe(2);
          expect(c.aim.z).toBe(9);
          expect(c.eye0.z).toBeCloseTo(1, 5); // root z 0 + eyeForward 1 along yaw 0
          seen = true;
        }
      },
    };
    const cam = new UltCamera(() => dir);
    const e = env();
    cam.onTarget({ x: 0, y: 0, z: 9 });
    cam.onStage(3, { x: 2, y: 0, z: 0 });
    for (let i = 0; i < 20; i++) cam.update(DT, casting('active', 3), e);
    expect(seen).toBe(true);
  });
});

describe('the ten per-animal directives', () => {
  /** Representative cast timelines: [phase, stage, seconds]. */
  const TIMELINES: Record<AnimalId, [('windup' | 'active' | 'recovery'), number, number][]> = {
    lion: [['windup', 0, 0.55], ['active', 1, 0.5], ['active', 2, 0.2], ['active', 3, 0.3], ['active', 4, 0.3], ['active', 5, 0.3], ['active', 6, 0.35], ['active', 7, 0.55], ['recovery', 7, 0.45]],
    panther: [['windup', 0, 0.35], ['active', 1, 0.22], ['active', 2, 0.22], ['active', 3, 0.22], ['active', 4, 0.22], ['active', 5, 0.22], ['active', 6, 0.2], ['active', 7, 0.2], ['recovery', 8, 1]],
    gorilla: [['windup', 0, 1], ['recovery', 1, 0.8]],
    giraffe: [['windup', 0, 0.6], ['windup', 1, 0.5], ['active', 1, 0.14], ['recovery', 2, 0.9]],
    hippo: [['windup', 0, 0.9], ['active', 1, 0.8], ['recovery', 2, 0.7]],
    rhino: [['windup', 0, 0.8], ['active', 1, 1.2], ['active', 2, 0.3], ['recovery', 3, 0.5], ['recovery', 4, 0.5]],
    eagle: [['windup', 0, 0.8], ['active', 0, 1.2], ['active', 1, 1.2], ['active', 1, 0.9], ['recovery', 2, 0.6]],
    mole: [['windup', 0, 1.3], ['active', 1, 2], ['recovery', 2, 0.7]],
    crocodile: [['windup', 0, 0.55], ['active', 2, 0.25], ['active', 3, 0.28], ['active', 4, 0.42], ['active', 5, 0.8], ['active', 6, 0.8], ['active', 7, 0.8], ['active', 8, 0.2], ['recovery', 8, 0.5]],
    python: [['windup', 0, 0.6], ['active', 2, 0.3], ['active', 3, 0.4], ['active', 4, 0.65], ['active', 5, 0.65], ['active', 6, 0.65], ['active', 7, 0.65], ['active', 8, 0.2], ['recovery', 8, 0.5]],
  };

  it.each(ANIMAL_IDS as readonly AnimalId[])('%s: finite, bounded, view-only outputs along its whole cast, then neutral', (animal) => {
    const dir = getUltDirector(animal);
    expect(dir).not.toBeNull();
    const cam = new UltCamera(getUltDirector);
    const e = env();
    cam.onTarget({ x: 0, y: 0, z: 8 });
    cam.onStage(1, { x: 1, y: 0, z: 7 });
    let elapsed = 0;
    for (const [phase, stage, secs] of TIMELINES[animal]) {
      for (let t = 0; t < secs; t += DT) {
        elapsed += DT;
        const st = casting(phase, stage, {
          animal,
          pos: { x: 0, y: 0, z: -0.03 * elapsed },
          vel: { x: 0, y: animal === 'eagle' && stage === 1 && secs < 1 ? -24 : 0, z: animal === 'rhino' ? 12 : 0 },
          yaw: 0.1,
          // The sim body is spinning wildly: it must NEVER reach the camera (the directives have no roll input at all).
          actionT: t,
        });
        e.yaw = 0;
        cam.update(DT, st, e);
        const o = cam.out;
        for (const k of Object.keys(o) as (keyof UltCamOut)[]) {
          const val = o[k];
          if (typeof val === 'number') expect(Number.isFinite(val)).toBe(true);
        }
        expect(Math.abs(o.pitch)).toBeLessThanOrEqual(1.0);
        expect(Math.abs(o.kick)).toBeLessThanOrEqual(0.6);
        expect(Math.abs(o.roll)).toBeLessThanOrEqual(0.6);
        expect(o.lookW).toBeGreaterThanOrEqual(0);
        expect(o.lookW).toBeLessThanOrEqual(1);
        expect(o.eyeY).toBeGreaterThanOrEqual(-0.6);
        expect(o.eyeY).toBeLessThanOrEqual(0.7);
        expect(Math.abs(o.eyeF)).toBeLessThanOrEqual(2);
        expect(o.fovPct).toBeGreaterThanOrEqual(-0.01);
        expect(o.fovPct).toBeLessThanOrEqual(0.2);
        expect(o.follow).toBeGreaterThanOrEqual(0);
        expect(o.follow).toBeLessThanOrEqual(1);
        expect(o.mouseYaw).toBeGreaterThanOrEqual(0);
        expect(o.mouseYaw).toBeLessThanOrEqual(1);
      }
    }
    expect(cam.isCasting).toBe(true);
    for (let i = 0; i < 150; i++) cam.update(DT, fighter({ animal }), e);
    expect(cam.isCasting).toBe(false);
    expect(cam.out.active).toBe(false);
    expect(Math.abs(cam.out.pitch) + Math.abs(cam.out.eyeY) + Math.abs(cam.out.eyeF) + Math.abs(cam.out.kick)).toBeLessThan(0.01);
    expect(cam.out.mouseYaw).toBeCloseTo(1, 2);
  });

  it('crocodile: the head follow is cut for the whole cast; hippo locks the yaw look briefly; mole drops the eye', () => {
    const run = (animal: AnimalId, phase: 'windup' | 'active', stage: number, secs: number) => {
      const cam = new UltCamera(getUltDirector);
      const e = env();
      for (let t = 0; t < secs; t += DT) cam.update(DT, casting(phase, stage, { animal }), e);
      return cam.out;
    };
    expect(run('crocodile', 'active', 5, 1).follow).toBeLessThan(0.05);
    expect(run('hippo', 'windup', 0, 0.8).mouseYaw).toBeLessThan(0.3);
    expect(run('mole', 'windup', 0, 0.9).eyeY).toBeLessThan(-0.25);
    expect(run('eagle', 'active', 1, 1.5).fovPct).toBeGreaterThanOrEqual(0); // fov grows only with the dive speed
  });

  it('eagle: pitches toward the reticle in the hold and widens the FOV in the stoop', () => {
    const cam = new UltCamera(getUltDirector);
    const e = env({ eye: { x: 0, y: 20, z: 0 } });
    cam.onStage(0, { x: 0, y: 0, z: 6.5 }); // reticle
    for (let t = 0; t < 1; t += DT) cam.update(DT, casting('active', 0, { animal: 'eagle', ultTargetId: -1 }), e);
    expect(cam.out.lookW).toBeGreaterThan(0.8);
    expect(cam.out.lookPitch).toBeLessThan(-0.55);
    const dive = new UltCamera(getUltDirector);
    dive.onStage(1, { x: 0, y: 0, z: 3 });
    for (let t = 0; t < 1; t += DT) dive.update(DT, casting('active', 1, { animal: 'eagle', ultTargetId: -1, vel: { x: 0, y: -24, z: 4 } }), e);
    expect(dive.out.fovPct).toBeGreaterThan(0.07);
    expect(dive.out.lookPitch).toBeLessThan(-0.9);
  });

  it('panther: re-aims at the victim much faster right after a blink', () => {
    const base = (blinkNow: boolean): number => {
      const cam = new UltCamera(getUltDirector);
      const e = env({ yaw: 2 }); // looking away from the victim at +z
      cam.update(DT, casting('active', 1, { animal: 'panther' }), e); // start the cast
      if (blinkNow) cam.onBlink({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
      for (let i = 0; i < 4; i++) {
        e.eye.x = 0;
        cam.update(DT, casting('active', 1, { animal: 'panther' }), e);
      }
      return Math.abs(e.yaw); // distance still to go (victim is at yaw 0)
    };
    expect(base(true)).toBeLessThan(base(false));
  });
});

describe('CameraRig composition of the director output', () => {
  const sample = (s: FpEyeSample): void => {
    s.rootX = 0;
    s.rootY = 0;
    s.rootZ = 0;
    s.relX = 0;
    s.relY = 1.4;
    s.relZ = 0;
    s.bobY = 0;
    s.bobSide = 0;
    s.roll = 0;
    s.near = 0.05;
  };

  function fpRig(): CameraRig {
    const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 500);
    const rig = new CameraRig(cam);
    rig.follow((out) => out.set(0, 0, 0), 1.6);
    rig.setFpAnchor(sample);
    rig.setFirstPerson(true, true);
    rig.fpPitch = 0; // entering first person starts slightly down; the tests want an exactly level look
    for (let i = 0; i < 30; i++) rig.update(DT);
    return rig;
  }

  const euler = (rig: CameraRig): THREE.Euler => new THREE.Euler().setFromQuaternion(rig.camera.quaternion, 'YXZ');

  it('is untouched when the director is idle', () => {
    const rig = fpRig();
    const before = euler(rig);
    expect(rig.ult.active).toBe(false);
    expect(before.x).toBeCloseTo(0, 5);
    expect(before.z).toBeCloseTo(0, 5);
  });

  it('adds pitch / roll / kick / eye offsets and a FOV scale as VIEW-ONLY offsets on top of the player look', () => {
    const rig = fpRig();
    const fov0 = rig.camera.fov;
    rig.fpPitch = 0.1;
    rig.ult.active = true;
    rig.ult.pitch = 0.3;
    rig.ult.kick = -0.05;
    rig.ult.roll = 0.04;
    rig.ult.eyeY = -0.3;
    rig.ult.eyeF = 0.5;
    rig.ult.fovPct = 0.1;
    rig.update(DT);
    const e = euler(rig);
    expect(e.x).toBeCloseTo(0.1 + 0.3 - 0.05, 4);
    expect(e.z).toBeCloseTo(0.04, 4);
    expect(rig.camera.position.y).toBeCloseTo(1.4 - 0.3, 3);
    // eyeF pushes the eye forward along the VIEW yaw (yaw 0 -> +z)
    expect(rig.camera.position.z).toBeCloseTo(0.5, 3);
    expect(rig.camera.fov).toBeCloseTo(fov0 * 1.1, 2);
  });

  it('blends the pitch toward an absolute look-at pitch (the eagle looking down at the reticle)', () => {
    const rig = fpRig();
    rig.ult.active = true;
    rig.ult.lookW = 1;
    rig.ult.lookPitch = -0.9;
    rig.update(DT);
    expect(euler(rig).x).toBeCloseTo(-0.9, 4);
    rig.ult.lookW = 0.5;
    rig.update(DT);
    expect(euler(rig).x).toBeCloseTo(-0.45, 4);
  });

  it('never lets the director flip the view past the vertical', () => {
    const rig = fpRig();
    rig.ult.active = true;
    rig.ult.pitch = 5;
    rig.update(DT);
    expect(euler(rig).x).toBeLessThan(1.51);
    rig.ult.pitch = -5;
    rig.update(DT);
    expect(euler(rig).x).toBeGreaterThan(-1.51);
  });

  it('a directive can lock the mouse look; the default is free', () => {
    const rig = fpRig();
    rig.applyMouseDelta(100, 100);
    const yawFree = rig.yaw;
    const pitchFree = rig.fpPitch;
    expect(yawFree).not.toBe(0);
    rig.yaw = 0;
    rig.fpPitch = 0;
    rig.ult.mouseYaw = 0;
    rig.ult.mousePitch = 0.5;
    rig.applyMouseDelta(100, 100);
    expect(rig.yaw).toBeCloseTo(0, 8);
    expect(rig.fpPitch).toBeCloseTo(pitchFree * 0.5, 8);
  });

  it('third person ignores the director entirely', () => {
    const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 500);
    const rig = new CameraRig(cam);
    rig.follow((out) => out.set(0, 0, 0), 1.6);
    rig.setFpAnchor(sample);
    for (let i = 0; i < 60; i++) rig.update(DT);
    const p0 = rig.camera.position.clone();
    rig.ult.active = true;
    rig.ult.eyeY = -1;
    rig.ult.pitch = 1;
    rig.ult.fovPct = 0.5;
    for (let i = 0; i < 10; i++) rig.update(DT);
    expect(rig.camera.position.distanceTo(p0)).toBeLessThan(0.05);
    expect(rig.camera.fov).toBeCloseTo(60, 1);
  });
});

describe('near-camera fade of the ultimate VFX', () => {
  function makeHost(indicators: unknown = { all: [] }): { host: UltFxHost; scene: THREE.Scene; camera: THREE.PerspectiveCamera } {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 500);
    const snap = { fighters: [fighter()], time: 0 } as unknown as ReturnType<UltFxHost['snapshot']>;
    const host: UltFxHost = {
      scene,
      effects: {} as UltFxHost['effects'],
      indicators: indicators as UltFxHost['indicators'],
      camera,
      snapshot: () => snap,
      root: () => new THREE.Object3D(),
      focusId: () => 0,
      playerId: 0,
    };
    return { host, scene, camera };
  }

  it('fades a transparent volume the camera is inside of, restores it when away or off, and leaves ground decals alone', () => {
    const { host, camera } = makeHost();
    const fx = new UltFxDispatcher(host);
    const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.6 });
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(2, 12, 8), mat);
    fx.scene.add(sphere);
    const decalMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.8 });
    const decal = new THREE.Mesh(new THREE.PlaneGeometry(6, 6).rotateX(-Math.PI / 2), decalMat);
    decal.position.y = 0.02;
    fx.scene.add(decal);

    camera.position.set(0, 0, 0); // inside the sphere
    fx.nearFade(camera, true);
    expect(mat.opacity).toBeLessThan(0.02);
    expect(decalMat.opacity).toBeCloseTo(0.8, 6);

    camera.position.set(0, 0, 6); // well outside
    fx.nearFade(camera, true);
    expect(mat.opacity).toBeCloseTo(0.6, 6);

    camera.position.set(0, 0, 0);
    fx.nearFade(camera, true);
    expect(mat.opacity).toBeLessThan(0.02);
    fx.nearFade(camera, false); // first person off: everything restored
    expect(mat.opacity).toBeCloseTo(0.6, 6);
    fx.dispose();
  });

  it('respects an opacity the module re-assigns itself (the new value becomes the base)', () => {
    const { host, camera } = makeHost();
    const fx = new UltFxDispatcher(host);
    const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5 });
    fx.scene.add(new THREE.Mesh(new THREE.SphereGeometry(2, 8, 6), mat));
    camera.position.set(0, 0, 3.0); // 1 m from the surface: partial fade
    fx.nearFade(camera, true);
    const faded = mat.opacity;
    expect(faded).toBeLessThan(0.5);
    expect(faded).toBeGreaterThan(0);
    mat.opacity = 0.3; // the module animates it
    fx.nearFade(camera, true);
    expect(mat.opacity).toBeCloseTo(0.3 * (faded / 0.5), 6);
    camera.position.set(0, 0, 20);
    fx.nearFade(camera, true);
    expect(mat.opacity).toBeCloseTo(0.3, 6);
    fx.dispose();
  });

  it('scales the alpha uniform of shader-material billboards (the lion / panther claw streaks) near the camera', () => {
    const { host, camera } = makeHost();
    const fx = new UltFxDispatcher(host);
    const mat = new THREE.ShaderMaterial({ uniforms: { uFade: { value: 1 } }, transparent: true });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 1), mat);
    quad.position.set(0, 1, 2);
    fx.scene.add(quad);
    camera.position.set(0, 1, 2.3); // right on top of it
    fx.nearFade(camera, true);
    expect(mat.uniforms.uFade.value).toBeLessThan(0.3);
    camera.position.set(0, 1, 12);
    fx.nearFade(camera, true);
    expect(mat.uniforms.uFade.value).toBeCloseTo(1, 6);
    fx.dispose();
  });

  it('dims the ribbon that runs under the camera (own: strongly) and arcs that start at it, but not far ones', () => {
    const ribMat = new THREE.ShaderMaterial({ uniforms: { uAlpha: { value: 1 }, uLen: { value: 7 } } });
    const rib = new THREE.Mesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), ribMat);
    rib.position.set(0, 0.03, 4);
    rib.scale.set(0.5, 1, 4); // half-width 0.5, half-length 4 along +z (yaw 0)
    const arcMat = new THREE.ShaderMaterial({ uniforms: { uAlpha: { value: 1 }, uFrom: { value: new THREE.Vector3(0, 1.5, 0) } } });
    const arc = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), arcMat);
    const handles = [
      { mesh: rib, owner: 0, active: true },
      { mesh: arc, owner: 1000, active: true },
    ];
    const { host, camera } = makeHost({ all: handles });
    const fx = new UltFxDispatcher(host);

    camera.position.set(0, 1.4, 0.5); // above the start of the ribbon, next to the arc's start
    fx.nearFade(camera, true);
    expect(ribMat.uniforms.uAlpha.value).toBeLessThan(0.3);
    expect(arcMat.uniforms.uAlpha.value).toBeLessThan(0.45);

    ribMat.uniforms.uAlpha.value = 1; // the pool re-assigns every frame
    arcMat.uniforms.uAlpha.value = 1;
    camera.position.set(8, 1.4, 4); // far to the side
    fx.nearFade(camera, true);
    expect(ribMat.uniforms.uAlpha.value).toBeCloseTo(1, 6);
    expect(arcMat.uniforms.uAlpha.value).toBeCloseTo(1, 6);

    // another fighter's ribbon under the camera is only dimmed to the (higher) floor: it is still a danger warning
    handles[0].owner = 3;
    ribMat.uniforms.uAlpha.value = 1;
    camera.position.set(0, 1.4, 4);
    fx.nearFade(camera, true);
    expect(ribMat.uniforms.uAlpha.value).toBeGreaterThan(0.4);
    expect(ribMat.uniforms.uAlpha.value).toBeLessThan(0.5);
    fx.dispose();
  });
});
