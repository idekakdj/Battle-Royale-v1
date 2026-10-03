/**
 * Fallback generic profile, derived automatically from the rig the animal actually has (joint names + rest geometry).
 * It gives every animal a basic, anatomically plausible pose from the generic archetypes until a hand-written profile
 * (animals/<animal>.ts) replaces it. Quadruped conventions: `legs.0/1` = front pair (local −X / +X), `legs.2/3` = hind pair.
 */

import * as THREE from 'three';
import type { AnimalId } from '../../../../core/types';
import type { BaseRig, Joint } from '../../../../render/animals/Animator';
import type { DofName } from '../dof';
import type { AnimalProfile, DofLink, TipDef, TipRole } from '../profile';

const _p = new THREE.Vector3();

interface Desc {
  name: string;
  min: number[];
  max: number[];
  pivot: number[];
}

function findDesc(desc: Desc[], joint: string): Desc | undefined {
  return desc.find((d) => d.name.split('|').includes(joint));
}

/** Offset (in the joint's local frame at rest) of a rig-rest-space point. */
function localOf(j: Joint, x: number, y: number, z: number): [number, number, number] {
  j.node.updateWorldMatrix(true, false);
  _p.set(x, y, z);
  j.node.worldToLocal(_p);
  const r = (n: number): number => Math.round(n * 1000) / 1000;
  return [r(_p.x), r(_p.y), r(_p.z)];
}

export function makeAutoProfile(animal: AnimalId, rig: BaseRig): AnimalProfile {
  const J = rig.brawlJoints();
  rig.root.updateMatrixWorld(true);
  const desc = rig.describeJoints() as Desc[];
  const links: Partial<Record<DofName, DofLink[]>> = {};
  const tips: Partial<Record<TipRole, TipDef>> = {};
  const mirror: [string, string][] = [];
  const put = (d: DofName, j: string, ch: DofLink['ch'], k: number): void => {
    if (!J.has(j)) return;
    (links[d] ??= []).push({ j, ch, k });
  };

  // Body.
  if (J.has('body')) {
    put('bodyPitch', 'body', 'rx', -1);
    put('bodyYaw', 'body', 'ry', 1);
    put('bodyRoll', 'body', 'rz', 1);
    put('bodyFwd', 'body', 'pz', 1);
    put('bodyUp', 'body', 'py', 1);
    put('bodyStretch', 'body', 's', 1);
    const d = findDesc(desc, 'body');
    if (d) {
      tips.body = { j: 'body', off: localOf(J.get('body') as Joint, (d.min[0] + d.max[0]) / 2, d.pivot[1] + 0.1, d.max[2] * 0.85) };
    }
  }
  // Neck / head / jaw.
  const neckName = J.has('neck') ? 'neck' : J.has('neck1') ? 'neck1' : null;
  if (neckName !== null) {
    put('neckPitch', neckName, 'rx', -1);
    put('neckYaw', neckName, 'ry', -1);
  } else {
    put('neckPitch', 'head', 'rx', -0.6);
  }
  if (J.has('head')) {
    put('headPitch', 'head', 'rx', -1);
    put('headYaw', 'head', 'ry', -1);
    put('headRoll', 'head', 'rz', 1);
    const d = findDesc(desc, 'head');
    if (d) tips.head = { j: 'head', off: localOf(J.get('head') as Joint, (d.min[0] + d.max[0]) / 2, (d.min[1] + d.max[1]) / 2, d.max[2]) };
  }
  if (J.has('jaw')) {
    put('jaw', 'jaw', 'rx', 1);
    const d = findDesc(desc, 'jaw');
    if (d) tips.jaw = { j: 'jaw', off: localOf(J.get('jaw') as Joint, (d.min[0] + d.max[0]) / 2, (d.min[1] + d.max[1]) / 2, d.max[2]) };
  }
  // Tail.
  const tailNames = ['tail', 'tail1', 'tail2', 'tail3', 'tailTip'].filter((n) => J.has(n));
  if (tailNames.length > 0) {
    put('tailPitch', tailNames[0], 'rx', 1);
    put('tailYaw', tailNames[0], 'rz', -1);
    if (tailNames.length > 1 && tailNames[1] !== tailNames[0]) {
      put('tail2Pitch', tailNames[1], 'rx', 1);
      put('tail2Yaw', tailNames[1], 'rz', -1);
    }
    const last = tailNames[tailNames.length - 1];
    const d = findDesc(desc, last);
    if (d) tips.tail = { j: last, off: localOf(J.get(last) as Joint, (d.min[0] + d.max[0]) / 2, (d.min[1] + d.max[1]) / 2, d.min[2]) };
  }
  // Legs: sides from the rest x, front/hind from the rest z.
  const legs: { name: string; x: number; z: number }[] = [];
  for (const [name, j] of J) {
    if (!/^legs\.\d+$/.test(name)) continue;
    _p.setFromMatrixPosition(j.node.matrixWorld);
    legs.push({ name, x: _p.x, z: _p.z });
  }
  const limb = (base: 'fore' | 'hind', near: boolean, l: { name: string }): void => {
    const side = near ? 'Near' : 'Far';
    put(`${base}${side}Swing` as DofName, l.name, 'rx', -1);
    put(`${base}${side}Spread` as DofName, l.name, 'rz', near ? -1 : 1);
    const role = `${base}${side}` as TipRole;
    const d = findDesc(desc, l.name);
    if (d) tips[role] = { j: l.name, off: localOf(J.get(l.name) as Joint, d.pivot[0], d.min[1], (d.min[2] + d.max[2]) / 2) };
  };
  if (legs.length >= 4) {
    const sorted = [...legs].sort((a, b) => b.z - a.z);
    const front = sorted.slice(0, 2).sort((a, b) => a.x - b.x);
    const hind = sorted.slice(2, 4).sort((a, b) => a.x - b.x);
    limb('fore', true, front[0]);
    limb('fore', false, front[1]);
    limb('hind', true, hind[0]);
    limb('hind', false, hind[1]);
    mirror.push([front[0].name, front[1].name], [hind[0].name, hind[1].name]);
  } else if (legs.length >= 2) {
    // Two-legged (talons): the legs serve as both the "fore" claws and the "hind" feet.
    const two = [...legs].sort((a, b) => a.x - b.x);
    for (const base of ['fore', 'hind'] as const) {
      limb(base, true, two[0]);
      limb(base, false, two[1]);
    }
    mirror.push([two[0].name, two[1].name]);
  }

  // Every profile needs a body tip (belly-flops, last-resort striker).
  if (tips.body === undefined && J.has('body')) tips.body = { j: 'body', off: [0, 0.15, 0.5] };
  if (tips.body === undefined && J.has('head')) tips.body = { j: 'head', off: [0, 0, 0.2] };

  return {
    animal,
    links,
    tips,
    mirror,
    hipDrop: 0.45,
    hangTilt: 1.1,
    limits: {
      foreNearSwing: [-1.2, 2.6],
      foreFarSwing: [-1.2, 2.6],
      hindNearSwing: [-1.3, 1.6],
      hindFarSwing: [-1.3, 1.6],
      foreNearSpread: [-1, 1],
      foreFarSpread: [-1, 1],
      bodyPitch: [-1.5, 1.2],
      neckPitch: [-1.2, 1.2],
      headPitch: [-0.9, 1.0],
      jaw: [0, 1.1],
    },
    note: 'auto-generated generic profile',
  };
}
