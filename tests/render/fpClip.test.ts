/**
 * First-person clear-view guarantees (v1.3.x): the screen-space safe-zone maths + shader patch, the "hide a triangle when ANY
 * vertex is skinned to a hidden bone" rule, and the profiles of the four animals whose own model used to get in the way
 * (crocodile, hippo, rhino, eagle): whole head hidden (no kept snout / beak / horn), safe-zone clip enabled.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { AnimalFactory } from '../../src/render/animals/AnimalFactory';
import type { BaseRig } from '../../src/render/animals/Animator';
import { getFpProfile } from '../../src/render/animals/fp';
import {
  CLIP_CHUNKS,
  FpClipControl,
  clipHalfExtents,
  clipZoneRect,
  inClipZone,
  patchClipShader,
} from '../../src/render/animals/fp/clip';
import { bandTip, calmJoints, edgeTip } from '../../src/render/animals/fp/common';
import type { FpPoseCtx } from '../../src/render/animals/fp/types';
import type { FighterState } from '../../src/core/types';
import { UltCamera, ultClock, type UltEnv } from '../../src/render/animals/fp/ultCam';

const CLEAR_VIEW = ['crocodile', 'hippo', 'rhino', 'eagle'] as const;
const SAFE = { w: 0.5, h: 0.6 };

describe('safe-zone maths', () => {
  it('half extents equal the screen fractions (NDC spans 2) and clamp to 0..1', () => {
    expect(clipHalfExtents(SAFE)).toEqual({ x: 0.5, y: 0.6 });
    expect(clipHalfExtents({ w: 2, h: -1 })).toEqual({ x: 1, y: 0 });
  });

  it('classifies NDC points: centre 50% x 60% is inside, the rim is not', () => {
    expect(inClipZone(0, 0, SAFE)).toBe(true);
    expect(inClipZone(0.49, 0.59, SAFE)).toBe(true);
    expect(inClipZone(-0.49, -0.59, SAFE)).toBe(true);
    expect(inClipZone(0.5, 0, SAFE)).toBe(false);
    expect(inClipZone(0, 0.6, SAFE)).toBe(false);
    expect(inClipZone(0.7, 0.1, SAFE)).toBe(false);
    expect(inClipZone(0.1, -0.9, SAFE)).toBe(false);
  });

  it('turns the zone into a centred pixel rectangle', () => {
    const r = clipZoneRect(SAFE, 800, 450);
    expect(r.x0).toBe(200);
    expect(r.x1).toBe(600);
    expect(r.y0).toBe(90);
    expect(r.y1).toBe(360);
    // 50% of the width x 60% of the height.
    expect((r.x1 - r.x0) / 800).toBeCloseTo(0.5, 5);
    expect((r.y1 - r.y0) / 450).toBeCloseTo(0.6, 5);
  });
});

describe('clip shader patch', () => {
  const vert = '#include <common>\nvoid main() {\n#include <begin_vertex>\n#include <project_vertex>\n}';
  const frag = '#include <common>\nvoid main() {\n#include <clipping_planes_fragment>\n gl_FragColor = vec4(1.0);\n}';

  it('adds the clip-space varying, the uniform and the discard exactly once', () => {
    const uniform = { value: new THREE.Vector3(0.5, 0.6, 1) };
    const shader = { vertexShader: vert, fragmentShader: frag, uniforms: {} as Record<string, { value: unknown }> };
    patchClipShader(shader, uniform);
    expect(shader.vertexShader).toContain(CLIP_CHUNKS.vertexDecl);
    expect(shader.vertexShader).toContain(CLIP_CHUNKS.vertexSet);
    expect(shader.fragmentShader).toContain('uniform vec3 uGkClip;');
    expect(shader.fragmentShader).toContain('discard');
    expect(shader.uniforms.uGkClip).toBe(uniform);
    // The vertex copy of gl_Position must come after the projection chunk.
    expect(shader.vertexShader.indexOf(CLIP_CHUNKS.vertexSet)).toBeGreaterThan(shader.vertexShader.indexOf('#include <project_vertex>'));
    const once = shader.fragmentShader;
    patchClipShader(shader, uniform);
    expect(shader.fragmentShader).toBe(once);
  });

  it('control stays off (nothing patched) until a clip is first applied, then only flips a uniform', () => {
    const mat = new THREE.MeshBasicMaterial();
    const ctl = new FpClipControl([mat]);
    const compile = mat.onBeforeCompile;
    expect(ctl.active).toBe(false);
    ctl.set(undefined);
    expect(mat.onBeforeCompile).toBe(compile); // no patch while no profile asks for a clip
    ctl.set(SAFE);
    expect(ctl.active).toBe(true);
    expect(ctl.uniform.value.x).toBe(0.5);
    expect(ctl.uniform.value.y).toBe(0.6);
    const patched = mat.onBeforeCompile;
    expect(patched).not.toBe(compile);
    ctl.set(undefined);
    expect(ctl.active).toBe(false);
    ctl.set(SAFE);
    expect(mat.onBeforeCompile).toBe(patched); // later toggles never re-wrap / recompile
    mat.dispose();
  });
});

describe('pose helpers', () => {
  it('edgeTip puts the tip where the screen coordinates say (reference view)', () => {
    const t = edgeTip(0.8, -0.9, 1, 0.3, 0.1);
    expect(t.z).toBe(1);
    expect(t.x).toBeGreaterThan(0);
    expect(t.y).toBeLessThan(0);
    // Round trip: NDC = (x / z / tanH, y / z / tanV).
    const tanH = Math.tan((85 / 2) * (Math.PI / 180));
    expect(t.x / t.z / tanH).toBeCloseTo(0.8, 6);
    expect(t.y / t.z / (tanH / (16 / 9))).toBeCloseTo(-0.9, 6);
  });

  it('calmJoints pulls channels toward rest without touching missing joints', () => {
    const j = { rx: 1, ry: 1, rz: 1, px: 1, py: 1, pz: 1, s: 1 };
    const ctx = { j: (n: string) => (n === 'body' ? j : undefined) } as unknown as FpPoseCtx;
    calmJoints(ctx, ['body', 'nope'], 0.25);
    expect(j.rx).toBeCloseTo(0.25, 10);
    expect(j.pz).toBeCloseTo(0.25, 10);
    expect(j.s).toBe(1);
  });
});

describe('clear-view profiles', () => {
  it('hide the whole head (no kept snout / beak / horn) and enable the safe-zone clip', () => {
    for (const id of CLEAR_VIEW) {
      const p = getFpProfile(id);
      expect(p.keepFront).toBeUndefined();
      expect(p.hide).toContain('head');
      expect(p.clip).toEqual(SAFE);
      expect(p.viewPitch).toBe(1);
    }
    expect(getFpProfile('crocodile').hide).toContain('jaw');
    expect(getFpProfile('hippo').hide).toContain('jaw');
    expect(getFpProfile('eagle').hide).toEqual(expect.arrayContaining(['body', 'torso']));
  });

  it('leaves the six approved animals without a clip', () => {
    for (const id of ['lion', 'gorilla', 'giraffe', 'mole', 'python', 'panther'] as const) {
      expect(getFpProfile(id).clip).toBeUndefined();
    }
  });
});

interface Baked {
  geometry: THREE.BufferGeometry;
}
interface RigPriv {
  fpxBaked: Baked[];
  fpxBodyMesh: THREE.SkinnedMesh;
  fpxNames: Map<string, { node: THREE.Object3D }>;
}

/** Bone indices of the profile's hidden joints. */
function hiddenBones(rig: BaseRig, names: string[]): Set<number> {
  const p = rig as unknown as RigPriv;
  const bones = p.fpxBodyMesh.skeleton.bones as THREE.Object3D[];
  const out = new Set<number>();
  for (const n of names) {
    const j = p.fpxNames.get(n);
    if (j !== undefined) {
      const i = bones.indexOf(j.node);
      if (i >= 0) out.add(i);
    }
  }
  return out;
}

describe('hidden geometry (no fragments)', () => {
  for (const id of CLEAR_VIEW) {
    it(`${id}: no drawn triangle touches a hidden bone, in the body, glow and outline meshes`, () => {
      const rig = AnimalFactory.createRig(id);
      const prof = getFpProfile(id);
      rig.setFirstPerson(prof, true);
      const hidden = hiddenBones(rig, prof.hide);
      expect(hidden.size).toBe(prof.hide.length);
      const p = rig as unknown as RigPriv;
      expect(p.fpxBaked.length).toBeGreaterThan(0);
      let removedAny = false;
      for (const mesh of p.fpxBaked) {
        const geo = mesh.geometry;
        const idx = geo.getIndex();
        const si = geo.getAttribute('skinIndex');
        const sw = geo.getAttribute('skinWeight');
        expect(idx).not.toBeNull();
        if (idx === null) continue;
        const total = geo.getAttribute('position').count;
        if (idx.count < total) removedAny = true;
        for (let k = 0; k < idx.count; k++) {
          const v = idx.getX(k);
          for (let c = 0; c < 4; c++) {
            if (sw.getComponent(v, c) > 0) expect(hidden.has(si.getComponent(v, c))).toBe(false);
          }
        }
      }
      expect(removedAny).toBe(true);
      // Restoring brings every triangle back (non-indexed draw again).
      rig.setFirstPerson(null);
      for (const mesh of p.fpxBaked) expect(mesh.geometry.getIndex()).toBeNull();
      rig.dispose();
    });
  }
});

// ── Ultimate-only clear view for the six approved animals ──────────────────────────────────────────────────────────────

const APPROVED = ['lion', 'gorilla', 'giraffe', 'mole', 'python', 'panther'] as const;
const REF_TAN_H = Math.tan((85 / 2) * (Math.PI / 180));
const REF_TAN_V = REF_TAN_H / (16 / 9);

/** NDC of a tip in the reference view. */
const ndc = (t: { x: number; y: number; z: number }): [number, number] => [t.x / (t.z * REF_TAN_H), t.y / (t.z * REF_TAN_V)];

describe('bandTip (ultimate viewmodels stay at the edges)', () => {
  it('keeps the screen position of tips that are already out of the centre (pushed no nearer than 1.3 m)', () => {
    const side = edgeTip(0.9, -0.3, 0.8, 0.3);
    const b = bandTip(side);
    expect(ndc(b)[0]).toBeCloseTo(0.9, 6);
    expect(ndc(b)[1]).toBeCloseTo(-0.3, 6);
    expect(b.z).toBeCloseTo(1.3, 9);
    expect(bandTip(edgeTip(0.9, 0.3, 1.4, -0.9)).down).toBe(0.25); // an upward-pointing paw would stretch along the screen side
    const far = edgeTip(0.1, -0.95, 2, 0.3);
    expect(bandTip(far)).toEqual(far);
  });

  it('pushes every central tip out of the 50% x 60% safe zone; never nearer than 1.3 m, pointing at least 0.25 rad down', () => {
    for (let ix = -10; ix <= 10; ix++) {
      for (let iy = -10; iy <= 10; iy++) {
        const t = edgeTip(ix * 0.1, iy * 0.1, 1.2, 0.3, 0.1, 0.2);
        const b = bandTip(t);
        const [nx, ny] = ndc(b);
        expect(Math.abs(nx) >= 0.5 - 1e-9 || Math.abs(ny) >= 0.6 - 1e-9).toBe(true);
        expect(b.z).toBeGreaterThanOrEqual(1.3 - 1e-9);
        expect(b.down).toBe(Math.max(t.down, 0.25));
        expect(b.out).toBe(t.out);
        expect(b.roll).toBe(t.roll);
      }
    }
  });

  it('prefers the bottom edge for tips low in the middle and the side for tips at the side', () => {
    const [, nyLow] = ndc(bandTip(edgeTip(0.05, -0.2, 1, 0.3)));
    expect(nyLow).toBeLessThan(-0.7);
    const [nxSide] = ndc(bandTip(edgeTip(0.55, 0.3, 1, 0.3)));
    expect(nxSide).toBeGreaterThan(0.6);
  });
});

describe('ultimate-only clip (six approved animals)', () => {
  it('profiles enable ultClip (not the always-on clip) with the same safe zone', () => {
    for (const id of APPROVED) {
      const p = getFpProfile(id);
      expect(p.clip).toBeUndefined();
      expect(p.ultClip).toEqual(SAFE);
    }
    expect(getFpProfile('gorilla').hideProps).toEqual(['boulder-slab']);
  });

  const fighter = (action: FighterState['action']): FighterState =>
    ({
      id: 0, animal: 'lion', isPlayer: true, alive: true, pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0,
      hp: 100, maxHp: 100, guard: 0, maxGuard: 0, guardRegenDelay: 0, ultCharge: 0, specialCd: 0, action, actionT: 0.2,
      actionDur: 1, comboIndex: 0, comboWindow: 0, buffs: [], kills: 0, damageDealt: 0, damageBlocked: 0, ultsUsed: 0,
      grabTargetId: -1, grabbedById: -1, airborne: false, glideT: 0, burrowT: 0,
      ultPhase: action === 'ultimate' ? 'active' : undefined, ultStage: action === 'ultimate' ? 3 : undefined,
    }) as FighterState;

  interface ClipRig {
    fpxClip: { active: boolean; uniform: { value: THREE.Vector3 } };
  }

  for (const id of APPROVED) {
    it(`${id}: the clear zone is active only while the own ultimate runs`, () => {
      const rig = AnimalFactory.createRig(id);
      const clip = (rig as unknown as ClipRig).fpxClip;
      rig.setFirstPerson(getFpProfile(id), true);
      rig.update(fighter('idle'), 1 / 60);
      expect(clip.active).toBe(false);
      rig.update(fighter('attack1'), 1 / 60);
      expect(clip.active).toBe(false);
      rig.update(fighter('ultimate'), 1 / 60);
      expect(clip.active).toBe(true);
      expect(clip.uniform.value.x).toBe(0.5);
      expect(clip.uniform.value.y).toBe(0.6);
      rig.update(fighter('idle'), 1 / 60);
      expect(clip.active).toBe(false);
      // Not while the head is still shown (camera outside the eye), whatever the action.
      rig.setFpHidden(false);
      rig.update(fighter('ultimate'), 1 / 60);
      expect(clip.active).toBe(false);
      rig.setFpHidden(true);
      expect(clip.active).toBe(true);
      rig.setFirstPerson(null);
      expect(clip.active).toBe(false);
      rig.dispose();
    });
  }

  it('the clear-view four keep their always-on clip regardless of the action', () => {
    const rig = AnimalFactory.createRig('hippo');
    const clip = (rig as unknown as ClipRig).fpxClip;
    rig.setFirstPerson(getFpProfile('hippo'), true);
    rig.update(fighter('idle'), 1 / 60);
    expect(clip.active).toBe(true);
    rig.setFirstPerson(null);
    expect(clip.active).toBe(false);
    rig.dispose();
  });

  it('gorilla: the held slab is not drawn in first person and is restored afterwards (shadow keeps casting)', () => {
    const rig = AnimalFactory.createRig('gorilla');
    const slab = rig.root.getObjectByName('boulder-slab') as THREE.Mesh;
    const mat = slab.material as THREE.Material;
    expect(mat.colorWrite).toBe(true);
    rig.setFirstPerson(getFpProfile('gorilla'), true);
    expect(mat.colorWrite).toBe(false);
    expect(mat.depthWrite).toBe(false);
    expect(slab.castShadow).toBe(true);
    rig.setFirstPerson(null);
    expect(mat.colorWrite).toBe(true);
    expect(mat.depthWrite).toBe(true);
    rig.dispose();
  });
});

describe('clip control: hide-all (director eye slides)', () => {
  it('discards the whole rig only while a clip is active, and releases cleanly', () => {
    const ctl = new FpClipControl([new THREE.MeshBasicMaterial()]);
    ctl.hideAll(true);
    expect(ctl.active).toBe(false); // no clip applies -> nothing to hide
    ctl.set(SAFE);
    expect(ctl.hidingAll).toBe(true); // the pending request applies as soon as a clip is active
    expect(ctl.uniform.value.z).toBe(2);
    ctl.hideAll(false);
    expect(ctl.hidingAll).toBe(false);
    expect(ctl.uniform.value.z).toBe(1);
    ctl.hideAll(true);
    ctl.set(undefined);
    expect(ctl.active).toBe(false);
    expect(ctl.uniform.value.z).toBe(0);
  });

  it('the patched fragment shader discards everything at z > 1.5 and the zone at z > 0.5', () => {
    expect(CLIP_CHUNKS.fragmentTest).toContain('uGkClip.z > 1.5) discard');
    expect(CLIP_CHUNKS.fragmentTest).toContain('uGkClip.z > 0.5');
  });
});

describe('ultimate director publishes the effective view for the viewmodel', () => {
  const env = (pitch: number): UltEnv => ({
    yaw: 0,
    pitch,
    eye: { x: 0, y: 1.4, z: 0 },
    eyeForward: 1,
    victim: () => null,
    setYaw: () => undefined,
  });
  const casting = (): FighterState =>
    ({
      id: 0, animal: 'lion', isPlayer: true, alive: true, pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0,
      hp: 100, maxHp: 100, guard: 0, maxGuard: 0, guardRegenDelay: 0, ultCharge: 0, specialCd: 0, action: 'ultimate',
      actionT: 0.1, actionDur: 1, comboIndex: 0, comboWindow: 0, buffs: [], kills: 0, damageDealt: 0, damageBlocked: 0,
      ultsUsed: 0, grabTargetId: -1, grabbedById: -1, airborne: false, glideT: 0, burrowT: 0, ultPhase: 'active', ultStage: 1,
    }) as FighterState;

  it('ultClock.view follows the mouse pitch and ultClock.slide the blink slide', () => {
    const cam = new UltCamera(() => null);
    cam.update(1 / 60, casting(), env(-0.4));
    expect(ultClock.view).toBeCloseTo(-0.4, 6);
    expect(ultClock.slide).toBe(0);
    cam.onBlink({ x: 0, y: 0, z: -4 }, { x: 0, y: 0, z: 0 });
    cam.update(1 / 60, casting(), env(-0.4));
    expect(ultClock.slide).toBeGreaterThan(0.45); // above the threshold at which the own rig is not drawn
    for (let i = 0; i < 30; i++) cam.update(1 / 60, casting(), env(-0.4));
    expect(ultClock.slide).toBeLessThan(0.05);
  });

  it('profiles: ultViewLock + ultHide only where the ultimate needs them', () => {
    for (const id of ['lion', 'panther'] as const) {
      const p = getFpProfile(id);
      expect(p.ultViewLock).toBe(true);
      expect(p.ultHide).toEqual(expect.arrayContaining(['body', 'tail']));
      // the pinned fore paws must never be in the hide list
      expect(p.ultHide).not.toContain('legs.0');
      expect(p.ultHide).not.toContain('legs.1');
    }
    expect(getFpProfile('gorilla').ultViewLock).toBe(true);
    expect(getFpProfile('python').ultHide).toEqual(expect.arrayContaining(['coil', 'neckJ.0']));
  });

  it('lion: the body triangles are hidden only while the own ultimate runs, the fore paws never', () => {
    const rig = AnimalFactory.createRig('lion');
    const prof = getFpProfile('lion');
    const p = rig as unknown as RigPriv;
    const drawn = (names: string[]): number => {
      const bones = hiddenBones(rig, names);
      let n = 0;
      const geo = p.fpxBodyMesh.geometry;
      const idx = geo.getIndex();
      const si = geo.getAttribute('skinIndex');
      const count = idx === null ? geo.getAttribute('position').count : idx.count;
      for (let k = 0; k < count; k++) if (bones.has(si.getX(idx === null ? k : idx.getX(k)))) n++;
      return n;
    };
    const f = (action: FighterState['action']): FighterState =>
      ({ ...({} as FighterState), id: 0, animal: 'lion', isPlayer: true, alive: true, pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, hp: 1, maxHp: 1, guard: 0, maxGuard: 0, guardRegenDelay: 0, ultCharge: 0, specialCd: 0, action, actionT: 0.2, actionDur: 1, comboIndex: 0, comboWindow: 0, buffs: [], kills: 0, damageDealt: 0, damageBlocked: 0, ultsUsed: 0, grabTargetId: -1, grabbedById: -1, airborne: false, glideT: 0, burrowT: 0 }) as FighterState;
    rig.setFirstPerson(prof, true);
    rig.update(f('idle'), 1 / 60);
    const normalBody = drawn(['body']);
    const normalPaws = drawn(['legs.0', 'legs.1']);
    expect(normalBody).toBeGreaterThan(0);
    expect(normalPaws).toBeGreaterThan(0);
    rig.update(f('ultimate'), 1 / 60);
    expect(drawn(['body', 'tail'])).toBe(0);
    expect(drawn(['legs.0', 'legs.1'])).toBe(normalPaws);
    rig.update(f('idle'), 1 / 60);
    expect(drawn(['body'])).toBe(normalBody);
    rig.dispose();
  });
});
