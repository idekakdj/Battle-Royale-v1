/**
 * v1.8 WP-J4: swimming + attacking-while-swimming animations.
 *
 *  - land poses are BIT-IDENTICAL when `inWater` is absent / false (golden hashes recorded before the swim layer existed, over
 *    every node of every rig for 18 scenarios per animal),
 *  - no NaN anywhere in the swim / attack-swim / block-swim poses (u × speed sweep),
 *  - the sink stays within the pool depth; the back and head stay above the water line and the feet near the pool bed,
 *  - blends in / out are continuous (per-frame step bound); a jump out of the water ends the layer at once,
 *  - the impact-frame splash fires exactly once per swing, the wake is throttled, no footsteps in water,
 *  - first person: the eye drops with the sink and stays above the surface.
 *
 * Regenerating `swimGolden.json` (only when a rig's land pose is changed ON PURPOSE): run `scenarioHash(id, sc)` for every
 * animal id and `SCENARIOS` entry (tests/render/swimHelpers.ts) and store the results under the key `${id}/${sc.name}`.
 */

import { describe, expect, it, afterEach } from 'vitest';
import * as THREE from 'three';
import { ANIMALS, ANIMAL_IDS } from '../../src/config/animals';
import { waterSpeedMultiplier } from '../../src/config/terrain';
import type { AnimalId, FighterAction, FighterState } from '../../src/core/types';
import { AnimalFactory } from '../../src/render/animals/AnimalFactory';
import { IMPACT, makeMockState, type BaseRig } from '../../src/render/animals/Animator';
import { getFpProfile } from '../../src/render/animals/fp';
import type { FpEyeSample } from '../../src/render/animals/fp/types';
import { setFxSink, type FxSink } from '../../src/render/fxBus';
import {
  SWIM_IMPACT_U,
  SWIM_TUNE,
  WATER_DEPTH,
  WAKE_PERIOD_S,
  attackWarp,
  followBump,
  poolLevel,
  swimSplash,
} from '../../src/render/animals/swim';
import golden from './swimGolden.json';
import { DT, SCENARIOS, scenarioHash, transformHash } from './swimHelpers';

const GOLD = golden as Record<string, string>;

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const BACK_BONE: Record<AnimalId, string> = {
  lion: 'body', gorilla: 'body', crocodile: 'body', hippo: 'body', rhino: 'body',
  eagle: 'torso', panther: 'body', python: 'coil', giraffe: 'body', mole: 'body',
};

function topWaterSpeed(id: AnimalId): number {
  return ANIMALS[id].speed * waterSpeedMultiplier(id);
}

interface Pose {
  rig: BaseRig;
  state: FighterState;
}

/** A rig held in one action at progress `u` (dur 0.6 s for attacks) for 14 frames so every blend has settled. */
function hold(id: AnimalId, action: FighterAction, u: number, speed: number, inWater: boolean, rig?: BaseRig): Pose {
  const r = rig ?? AnimalFactory.createRig(id);
  const s = makeMockState(id);
  s.action = action;
  s.actionDur = action.startsWith('attack') ? 0.6 : action === 'idle' || action === 'run' || action === 'block' ? 0 : 1.2;
  s.vel.z = speed;
  s.inWater = inWater;
  for (let i = 0; i < 14; i++) {
    s.actionT = u * s.actionDur;
    r.update(s, 0.05);
  }
  r.root.updateMatrixWorld(true);
  return { rig: r, state: s };
}

interface Extents {
  /** Highest vertex of the back bone / of the head bone, lowest vertex of the whole body (rig-root space, y up). */
  backTop: number;
  headTop: number;
  bottom: number;
}

const _v = new THREE.Vector3();

/** Skinned extents of the baked body mesh in the CURRENT pose. */
function extents(id: AnimalId, rig: BaseRig): Extents {
  const mesh = (rig as unknown as { fpxBodyMesh: THREE.SkinnedMesh }).fpxBodyMesh;
  const joints = rig.brawlJoints();
  const bone = (name: string): number => mesh.skeleton.bones.indexOf((joints.get(name) as { node: THREE.Object3D }).node as THREE.Bone);
  const back = bone(BACK_BONE[id]);
  const head = bone('head');
  const si = mesh.geometry.getAttribute('skinIndex');
  const sw = mesh.geometry.getAttribute('skinWeight');
  const n = mesh.geometry.getAttribute('position').count;
  let backTop = -1e9;
  let headTop = -1e9;
  let bottom = 1e9;
  rig.root.updateMatrixWorld(true);
  for (let i = 0; i < n; i++) {
    mesh.getVertexPosition(i, _v);
    _v.applyMatrix4(mesh.matrixWorld);
    const y = _v.y - rig.root.position.y;
    if (y < bottom) bottom = y;
    if (sw.getX(i) > 0.5) {
      const b = si.getX(i);
      if (b === back && y > backTop) backTop = y;
      if (b === head && y > headTop) headTop = y;
    }
  }
  return { backTop, headTop, bottom };
}

function allFinite(rig: BaseRig): boolean {
  let ok = true;
  rig.root.traverse((o) => {
    const p = o.position;
    const q = o.quaternion;
    const s = o.scale;
    if (!Number.isFinite(p.x + p.y + p.z + q.x + q.y + q.z + q.w + s.x + s.y + s.z)) ok = false;
  });
  return ok;
}

afterEach(() => {
  setFxSink(null);
  poolLevel.surfaceY = 0;
});

// ── data ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('swim tuning data', () => {
  it('every animal sinks by at most the pool depth, and the documented rest heights match the baked rig', () => {
    for (const id of ANIMAL_IDS) {
      const t = SWIM_TUNE[id];
      expect(t.sink, id).toBeGreaterThan(0.2);
      expect(t.sink, id).toBeLessThanOrEqual(WATER_DEPTH);
      expect(t.bob, id).toBeGreaterThanOrEqual(0.015);
      expect(t.bob, id).toBeLessThanOrEqual(0.055);
      const rig = AnimalFactory.createRig(id);
      const rows = rig.describeJoints();
      const top = (name: string): number => Math.max(...rows.filter((r) => r.name.split('|').includes(name)).map((r) => r.max[1]));
      expect(Math.abs(top(BACK_BONE[id]) - t.back), `${id} back`).toBeLessThan(0.12);
      expect(Math.abs(top('head') - t.head), `${id} head`).toBeLessThan(0.12);
      rig.dispose();
    }
  });

  it('the attack time-warp fixes 0, the impact instant and 1, and is strictly increasing', () => {
    expect(SWIM_IMPACT_U).toBe(IMPACT);
    expect(attackWarp(0)).toBe(0);
    expect(attackWarp(1)).toBe(1);
    expect(attackWarp(IMPACT)).toBeCloseTo(IMPACT, 12);
    let prev = -1;
    for (let u = 0; u <= 1.0001; u += 0.005) {
      const w = attackWarp(Math.min(1, u));
      expect(w).toBeGreaterThan(prev - 1e-12);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
      prev = w;
    }
    // A longer windup: the warped progress lags the real one before the impact.
    expect(attackWarp(0.3)).toBeLessThan(0.3);
    expect(followBump(IMPACT)).toBe(0);
    expect(followBump(1)).toBe(0);
    expect(followBump(0.775)).toBeCloseTo(1, 2);
  });

  it('splash size grows with the finisher and with the animal', () => {
    for (const id of ANIMAL_IDS) {
      const r = ANIMALS[id].radius;
      const a = swimSplash(1, r, SWIM_TUNE[id].splash);
      const b = swimSplash(3, r, SWIM_TUNE[id].splash);
      expect(b.radius).toBeGreaterThan(a.radius);
      expect(b.strength).toBeGreaterThan(a.strength);
      expect(b.strength).toBeLessThanOrEqual(1);
      expect(a.strength).toBeGreaterThan(0);
    }
    const hippo = swimSplash(2, ANIMALS.hippo.radius, SWIM_TUNE.hippo.splash);
    const mole = swimSplash(2, ANIMALS.mole.radius, SWIM_TUNE.mole.splash);
    expect(hippo.radius).toBeGreaterThan(mole.radius * 1.5);
  });
});

// ── land is untouched ───────────────────────────────────────────────────────────────────────────────────────────────────

describe('land poses are bit-identical when inWater is false', () => {
  for (const id of ANIMAL_IDS) {
    it(`${id}: every scenario matches the pre-swim golden hashes (inWater absent and false)`, () => {
      for (const sc of SCENARIOS) {
        const want = GOLD[`${id}/${sc.name}`];
        expect(want, `${id}/${sc.name} golden`).toBeTypeOf('string');
        expect(scenarioHash(id, sc), `${id}/${sc.name} (absent)`).toBe(want);
        expect(scenarioHash(id, sc, false), `${id}/${sc.name} (false)`).toBe(want);
      }
    });
  }

  it('after a swim and back on land the rig is exactly the land rig again (sink undone, no residue)', () => {
    for (const id of ANIMAL_IDS) {
      const wet = AnimalFactory.createRig(id);
      const dry = AnimalFactory.createRig(id);
      const sw = makeMockState(id);
      const sd = makeMockState(id);
      for (const s of [sw, sd]) {
        s.action = 'run';
        s.vel.z = 2;
      }
      for (let i = 0; i < 100; i++) {
        sw.inWater = i >= 20 && i < 60;
        wet.update(sw, DT);
        dry.update(sd, DT);
      }
      expect(wet.root.children[0].position.y, id).toBe(0); // bodyRoot
      expect(transformHash(wet, 1), id).toBe(transformHash(dry, 1));
      wet.dispose();
      dry.dispose();
    }
  });
});

// ── swim poses ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('swim poses', () => {
  it('no NaN / Infinity in any swim, attack-swim or block-swim pose over a u × speed sweep', () => {
    for (const id of ANIMAL_IDS) {
      const rig = AnimalFactory.createRig(id);
      const top = topWaterSpeed(id);
      const s = makeMockState(id);
      s.inWater = true;
      const actions: FighterAction[] = ['idle', 'run', 'attack1', 'attack2', 'attack3', 'block', 'feared', 'hit', 'stagger', 'knockdown', 'dead', 'special', 'grabbed'];
      for (const a of actions) {
        s.action = a;
        s.actionDur = a === 'idle' || a === 'run' || a === 'block' ? 0 : 0.6;
        for (const sp of [0, 0.3 * top, top, 1.6 * top]) {
          s.vel.z = sp;
          for (let k = 0; k <= 20; k++) {
            s.actionT = (k / 20) * s.actionDur;
            rig.update(s, DT);
            expect(allFinite(rig), `${id} ${a} sp=${sp.toFixed(1)} u=${k / 20}`).toBe(true);
          }
        }
      }
      rig.dispose();
    }
  });

  it('the sink never exceeds the pool depth; the back and head stay above the water line and the feet near the pool bed', () => {
    for (const id of ANIMAL_IDS) {
      const rig = AnimalFactory.createRig(id);
      const top = topWaterSpeed(id);
      const cases: [FighterAction, number, number][] = [
        ['idle', 0, 0],
        ['run', 0.35 * top, 0],
        ['run', top, 0],
        ['block', 0, 0],
      ];
      for (const u of [0.1, 0.3, 0.45, 0.55, 0.7, 0.9]) for (const a of ['attack1', 'attack2', 'attack3'] as const) cases.push([a, 0, u]);
      for (const [a, sp, u] of cases) {
        const { rig: r } = hold(id, a, u, sp, true, rig);
        const sink = -(r.root.children[0].position.y);
        const tag = `${id} ${a} u=${u} sp=${sp.toFixed(1)}`;
        expect(sink, tag).toBeGreaterThan(0.2);
        expect(sink, tag).toBeLessThanOrEqual(WATER_DEPTH + 1e-9);
        const e = extents(id, r);
        expect(Number.isFinite(e.backTop + e.headTop + e.bottom), tag).toBe(true);
        expect(e.backTop, `${tag} back above water`).toBeGreaterThan(0.0);
        expect(e.headTop, `${tag} head above water`).toBeGreaterThan(0.05);
        expect(e.bottom, `${tag} feet vs bed`).toBeGreaterThan(-(WATER_DEPTH + 0.15));
      }
      rig.dispose();
    }
  });

  it('tall legs keep more of the body above the water; small animals are mostly submerged but head and back stay out', () => {
    const wet = (id: AnimalId): Extents => extents(id, hold(id, 'idle', 0, 0, true).rig);
    const g = wet('giraffe');
    const m = wet('mole');
    const c = wet('crocodile');
    expect(g.backTop).toBeGreaterThan(1.2); // the giraffe's back is still over a metre above the surface
    for (const e of [m, c]) {
      expect(e.backTop).toBeGreaterThan(0.0);
      expect(e.backTop).toBeLessThan(0.5); // mostly submerged
      expect(e.headTop).toBeGreaterThan(0.05);
    }
  });

  it('a knocked-down or dead animal settles at the water line and never sinks below the pool floor', () => {
    for (const id of ANIMAL_IDS) {
      for (const a of ['knockdown', 'dead'] as const) {
        const rig = AnimalFactory.createRig(id);
        const s = makeMockState(id);
        s.inWater = true;
        s.action = a;
        s.actionDur = a === 'dead' ? 0 : 1.2;
        for (let i = 0; i < 120; i++) {
          s.actionT = Math.min(0.8, i * DT);
          rig.update(s, DT);
        }
        const e = extents(id, rig);
        expect(e.bottom, `${id} ${a}`).toBeGreaterThan(-(WATER_DEPTH + 0.05));
        expect(e.backTop, `${id} ${a} stays out of the water`).toBeGreaterThan(-0.12);
        rig.dispose();
      }
    }
  });

  it('a raised-water scene (poolLevel.surfaceY = depth) turns the sink off', () => {
    poolLevel.surfaceY = WATER_DEPTH;
    const { rig } = hold('lion', 'idle', 0, 0, true);
    expect(rig.root.children[0].position.y).toBeCloseTo(0, 12);
  });

  it('idle swimming bobs with a ~1.6 s period and a few centimetres of amplitude', () => {
    for (const id of ANIMAL_IDS) {
      const rig = AnimalFactory.createRig(id);
      const s = makeMockState(id);
      s.inWater = true;
      let lo = 1e9;
      let hi = -1e9;
      for (let i = 0; i < 200; i++) {
        rig.update(s, DT);
        if (i < 30) continue;
        const y = (rig as unknown as { body: { node: THREE.Object3D } }).body.node.position.y;
        lo = Math.min(lo, y);
        hi = Math.max(hi, y);
      }
      const amp = (hi - lo) / 2;
      expect(amp, id).toBeGreaterThan(0.012);
      expect(amp, id).toBeLessThan(0.07);
      rig.dispose();
    }
  });
});

// ── blend continuity ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('land <-> water transitions', () => {
  it('every node moves a bounded amount per frame while wading in and out (no pops)', () => {
    for (const id of ANIMAL_IDS) {
      const rig = AnimalFactory.createRig(id);
      const s = makeMockState(id);
      s.action = 'run';
      s.vel.z = Math.min(ANIMALS[id].speed, topWaterSpeed(id) * 1.3);
      const prev = new Map<THREE.Object3D, { p: THREE.Vector3; q: THREE.Quaternion }>();
      let maxRot = 0;
      let maxPos = 0;
      for (let i = 0; i < 160; i++) {
        s.inWater = i >= 40 && i < 100;
        rig.update(s, DT);
        rig.root.traverse((o) => {
          const pr = prev.get(o);
          if (pr !== undefined && i > 10) {
            maxRot = Math.max(maxRot, 2 * Math.acos(Math.min(1, Math.abs(pr.q.dot(o.quaternion)))));
            maxPos = Math.max(maxPos, pr.p.distanceTo(o.position));
          }
          prev.set(o, { p: o.position.clone(), q: o.quaternion.clone() });
        });
      }
      expect(maxRot, `${id} rotation step`).toBeLessThan(0.5);
      expect(maxPos, `${id} position step`).toBeLessThan(0.16);
      rig.dispose();
    }
  });

  it('the water blend takes about 0.15 s in and out', () => {
    const rig = AnimalFactory.createRig('lion');
    const s = makeMockState('lion');
    s.inWater = true;
    const bodyRoot = rig.root.children[0];
    const ys: number[] = [];
    for (let i = 0; i < 20; i++) {
      rig.update(s, DT);
      ys.push(bodyRoot.position.y);
    }
    expect(ys[0]).toBeGreaterThan(-0.05); // starts soft
    expect(ys[3]).toBeLessThan(0);
    expect(Math.abs(ys[8] - ys[19])).toBeLessThan(0.02); // done in ~9-10 frames (0.15 s)
    expect(ys[19]).toBeCloseTo(-SWIM_TUNE.lion.sink, 6);
    s.inWater = false;
    for (let i = 0; i < 12; i++) rig.update(s, DT);
    expect(bodyRoot.position.y).toBe(0);
    rig.dispose();
  });

  it('a jump out of the water ends the swim layer at once (airborne), without a one-frame teleport', () => {
    const rig = AnimalFactory.createRig('hippo');
    const s = makeMockState('hippo');
    s.inWater = true;
    for (let i = 0; i < 30; i++) rig.update(s, DT);
    const bodyRoot = rig.root.children[0];
    const sunk = bodyRoot.position.y;
    expect(sunk).toBeLessThan(-0.4);
    s.action = 'jump';
    s.actionDur = 0.7;
    s.airborne = true; // the sim keeps inWater up to 0.6 m: the layer must end anyway
    let prev = sunk;
    let maxStep = 0;
    for (let i = 0; i < 8; i++) {
      s.actionT = i * DT;
      rig.update(s, DT);
      maxStep = Math.max(maxStep, bodyRoot.position.y - prev);
      prev = bodyRoot.position.y;
    }
    expect(bodyRoot.position.y).toBe(0);
    expect(maxStep).toBeLessThan(0.2);
    rig.dispose();
  });
});

// ── FX ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Calls {
  splash: { x: number; z: number; radius: number; strength: number; frame: number }[];
  wake: number[];
  foot: number;
  land: number;
}

function recordSink(frame: { n: number }): Calls {
  const calls: Calls = { splash: [], wake: [], foot: 0, land: 0 };
  const sink: FxSink = {
    footstep: () => {
      calls.foot++;
    },
    land: () => {
      calls.land++;
    },
    slam: () => {},
    splash: (_src, x, z, radius, strength) => {
      calls.splash.push({ x, z, radius, strength, frame: frame.n });
    },
    wake: (_src, _x, _z, speed) => {
      calls.wake.push(speed);
    },
  };
  setFxSink(sink);
  return calls;
}

describe('water FX hooks', () => {
  it('the basic-attack splash fires exactly once per swing, on the impact frame, only in the water', () => {
    for (const id of ANIMAL_IDS) {
      for (const [a, n] of [['attack1', 1], ['attack2', 2], ['attack3', 3]] as const) {
        for (const water of [true, false]) {
          const frame = { n: 0 };
          const calls = recordSink(frame);
          const rig = AnimalFactory.createRig(id);
          const s = makeMockState(id);
          s.action = a;
          s.actionDur = 0.6;
          s.inWater = water;
          const steps = Math.round(0.6 / DT) + 6;
          let impactFrame = -1;
          for (let i = 0; i < steps; i++) {
            frame.n = i;
            s.actionT = Math.min(0.6, i * DT);
            const u = s.actionT / s.actionDur;
            if (impactFrame < 0 && u >= IMPACT) impactFrame = i;
            rig.update(s, DT);
          }
          const tag = `${id} ${a} water=${water}`;
          if (water) {
            expect(calls.splash.length, tag).toBe(1);
            expect(calls.splash[0].frame, tag).toBe(impactFrame);
            const sp = swimSplash(n, ANIMALS[id].radius, SWIM_TUNE[id].splash);
            expect(calls.splash[0].radius, tag).toBeCloseTo(sp.radius, 9);
            expect(calls.splash[0].strength, tag).toBeCloseTo(sp.strength, 9);
            // The splash lands IN FRONT of the fighter (yaw 0 = +z).
            expect(calls.splash[0].z, tag).toBeGreaterThan(ANIMALS[id].radius);
          } else {
            expect(calls.splash.length, tag).toBe(0);
          }
          rig.dispose();
          setFxSink(null);
        }
      }
    }
  });

  it('a new swing of the same action fires its own splash; an older sink without splash / wake never throws', () => {
    const frame = { n: 0 };
    const calls = recordSink(frame);
    const rig = AnimalFactory.createRig('gorilla');
    const s = makeMockState('gorilla');
    s.action = 'attack3';
    s.actionDur = 0.6;
    s.inWater = true;
    for (let swing = 0; swing < 3; swing++) {
      for (let i = 0; i < 40; i++) {
        s.actionT = Math.min(0.6, i * DT);
        rig.update(s, DT);
      }
    }
    expect(calls.splash.length).toBe(3);
    setFxSink({ footstep: () => {}, land: () => {}, slam: () => {} });
    s.action = 'run';
    s.vel.z = 3;
    for (let i = 0; i < 60; i++) rig.update(s, DT);
    s.action = 'attack1';
    for (let i = 0; i < 40; i++) {
      s.actionT = Math.min(0.6, i * DT);
      rig.update(s, DT);
    }
    rig.dispose();
  });

  it('the wake is throttled (~every 0.12 s) while swimming and moving, and silent when treading or on land', () => {
    const frame = { n: 0 };
    const calls = recordSink(frame);
    const rig = AnimalFactory.createRig('crocodile');
    const s = makeMockState('crocodile');
    s.action = 'run';
    s.vel.z = 4;
    s.inWater = true;
    for (let i = 0; i < 120; i++) rig.update(s, DT); // 2 s
    const expected = 2 / WAKE_PERIOD_S;
    expect(calls.wake.length).toBeGreaterThan(expected - 4);
    expect(calls.wake.length).toBeLessThan(expected + 3);
    expect(calls.wake.every((v) => Math.abs(v - 4) < 1e-9)).toBe(true);
    expect(calls.foot).toBe(0); // no dust in the water
    const n0 = calls.wake.length;
    s.action = 'idle';
    s.vel.z = 0;
    for (let i = 0; i < 60; i++) rig.update(s, DT);
    expect(calls.wake.length).toBe(n0);
    // On land: footsteps again, never a wake.
    s.inWater = false;
    s.action = 'run';
    s.vel.z = 4;
    for (let i = 0; i < 120; i++) rig.update(s, DT);
    expect(calls.wake.length).toBe(n0);
    expect(calls.foot).toBeGreaterThan(2);
    rig.dispose();
  });

  it('landing in the pool does not kick up landing dust (the scene splashes instead)', () => {
    const frame = { n: 0 };
    const calls = recordSink(frame);
    for (const water of [true, false]) {
      const rig = AnimalFactory.createRig('lion');
      const s = makeMockState('lion');
      s.action = 'jump';
      s.airborne = true;
      s.actionDur = 0.7;
      for (let i = 0; i < 10; i++) rig.update(s, DT);
      s.action = 'idle';
      s.airborne = false;
      s.inWater = water;
      rig.update(s, DT);
      rig.dispose();
    }
    expect(calls.land).toBe(1); // the dry landing only
  });
});

// ── first person ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('first-person eye in the water', () => {
  it('the eye drops with the sink, never rises, and stays clear above the surface', () => {
    for (const id of ANIMAL_IDS) {
      const prof = getFpProfile(id);
      const eye: FpEyeSample = { rootX: 0, rootY: 0, rootZ: 0, relX: 0, relY: 0, relZ: 0, bobY: 0, bobSide: 0, roll: 0, near: 0 };
      const sample = (water: boolean): number => {
        const rig = AnimalFactory.createRig(id);
        rig.setFirstPerson(prof, true);
        const s = makeMockState(id);
        s.inWater = water;
        s.isPlayer = true;
        for (let i = 0; i < 60; i++) rig.update(s, DT);
        expect(rig.sampleFpEye(eye)).toBe(true);
        const y = eye.relY;
        rig.dispose();
        return y;
      };
      const land = sample(false);
      const wet = sample(true);
      const sink = SWIM_TUNE[id].sink;
      expect(land - wet, `${id} eye drop`).toBeGreaterThan(0.35 * sink);
      expect(land - wet, `${id} eye drop`).toBeLessThan(1.15 * sink);
      expect(wet, `${id} eye above the water`).toBeGreaterThan(0.1);
    }
  });
});
