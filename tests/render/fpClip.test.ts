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
import { calmJoints, edgeTip } from '../../src/render/animals/fp/common';
import type { FpPoseCtx } from '../../src/render/animals/fp/types';

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
