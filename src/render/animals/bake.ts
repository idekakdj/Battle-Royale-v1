/**
 * Rig bake (v1.1 WP-K). Turns a builder's hierarchy of primitive meshes under
 * articulated pivots into:
 *
 *  - ONE skinned, vertex-coloured, flat-shaded body mesh — one bone per joint
 *    pivot (rigid weight 1), so the frozen joint animation keeps working
 *    unchanged while the whole animal costs 1 draw call (+1 shadow);
 *  - an optional unlit "glow" skinned mesh for HDR parts (eyes, runes);
 *  - an inverted-hull outline skinned mesh (back faces pushed out along
 *    smoothed normals, depth-scaled so the line stays ~constant on screen).
 *
 * Colour per triangle = material colour → optional paint() pattern →
 * countershading (darker back, lighter belly by face normal) → soft ground
 * occlusion → tiny deterministic facet jitter. All init-time only.
 */

import * as THREE from 'three';
import type { PaintFn } from './parts';

export interface BakeOptions {
  /** Darkening of up-facing faces (0–1). */
  back: number;
  /** Brightening of down-facing faces (0–1). */
  belly: number;
  /** Outline hull colour. */
  outlineColor: number;
}

export interface BakeResult {
  body: THREE.SkinnedMesh;
  /**
   * Depth-only twin of the body, shown only while the rig is transparent
   * (stealth / death fade) so the faded body reads as one clean silhouette
   * instead of showing its overlapping inner parts.
   */
  depth: THREE.SkinnedMesh;
  glow: THREE.SkinnedMesh | null;
  outline: THREE.SkinnedMesh | null;
  /** Shared outline thickness uniform (metres at ~7 m camera distance). */
  outlineWidth: { value: number };
  /** Opacity-controlled materials (body + glow). */
  materials: THREE.Material[];
  outlineMaterial: THREE.MeshBasicMaterial | null;
  triangles: number;
}

interface Bucket {
  pos: number[];
  nor: number[];
  col: number[];
  skin: number[];
  outN: number[] | null;
}

function newBucket(withOutline: boolean): Bucket {
  return { pos: [], nor: [], col: [], skin: [], outN: withOutline ? [] : null };
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _cent = new THREE.Vector3();
const _col = new THREE.Color();
const _m = new THREE.Matrix4();

function jitter(x: number, y: number, z: number): number {
  const s = Math.sin(x * 91.7 + y * 47.3 + z * 13.1) * 24634.6345;
  return s - Math.floor(s);
}

function key(x: number, y: number, z: number): string {
  return `${Math.round(x * 2000)},${Math.round(y * 2000)},${Math.round(z * 2000)}`;
}

export function bakeRig(
  bodyRoot: THREE.Group,
  jointNodes: ReadonlySet<THREE.Object3D>,
  opts: BakeOptions,
): BakeResult {
  bodyRoot.updateWorldMatrix(true, true);
  const invRoot = new THREE.Matrix4().copy(bodyRoot.matrixWorld).invert();

  const bones: THREE.Object3D[] = [bodyRoot];
  const boneIndex = new Map<THREE.Object3D, number>([[bodyRoot, 0]]);
  const items: THREE.Mesh[] = [];
  bodyRoot.traverse((o) => {
    if (o instanceof THREE.Mesh && !(o instanceof THREE.SkinnedMesh)) items.push(o);
  });

  const body = newBucket(false);
  const glowB = newBucket(false);
  const outline = newBucket(true);
  let triangles = 0;

  for (const mesh of items) {
    let bone: THREE.Object3D | null = jointNodes.has(mesh) ? mesh : mesh.parent;
    while (bone !== null && bone !== bodyRoot && !jointNodes.has(bone)) bone = bone.parent;
    if (bone === null) bone = bodyRoot;
    let bi = boneIndex.get(bone);
    if (bi === undefined) {
      bi = bones.length;
      bones.push(bone);
      boneIndex.set(bone, bi);
    }

    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const ud = mesh.userData as {
      noTone?: boolean;
      noOutline?: boolean;
      glow?: number;
      paint?: PaintFn;
    };
    let glowBoost = typeof ud.glow === 'number' ? ud.glow : 0;
    const base = new THREE.Color(0xffffff);
    if (mat instanceof THREE.MeshStandardMaterial || mat instanceof THREE.MeshBasicMaterial) {
      base.copy(mat.color);
    }
    if (mat instanceof THREE.MeshStandardMaterial && glowBoost === 0 && mat.emissiveIntensity > 0) {
      const e = mat.emissive;
      if (e.r + e.g + e.b > 0.05) {
        base.copy(e);
        glowBoost = Math.max(1, mat.emissiveIntensity);
      }
    }
    const doubleSided = mat.side === THREE.DoubleSide;
    const isGlow = glowBoost > 0;
    const target = isGlow ? glowB : body;
    const wantsOutline = !isGlow && ud.noOutline !== true;

    _m.multiplyMatrices(invRoot, mesh.matrixWorld);
    const flip = _m.determinant() < 0;
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position');
    const index = geo.getIndex();
    const triCount = index !== null ? index.count / 3 : pos.count / 3;

    // Collect transformed triangles first (for the smoothed outline normals).
    const tri: number[] = [];
    for (let t = 0; t < triCount; t++) {
      const i0 = index !== null ? index.getX(t * 3) : t * 3;
      let i1 = index !== null ? index.getX(t * 3 + 1) : t * 3 + 1;
      let i2 = index !== null ? index.getX(t * 3 + 2) : t * 3 + 2;
      if (flip) {
        const s = i1;
        i1 = i2;
        i2 = s;
      }
      _a.fromBufferAttribute(pos, i0).applyMatrix4(_m);
      _b.fromBufferAttribute(pos, i1).applyMatrix4(_m);
      _c.fromBufferAttribute(pos, i2).applyMatrix4(_m);
      _e1.subVectors(_b, _a);
      _e2.subVectors(_c, _a);
      _n.crossVectors(_e1, _e2);
      if (_n.lengthSq() < 1e-14) continue; // degenerate (cone apex fans)
      tri.push(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z, _c.x, _c.y, _c.z);
    }

    const smooth = new Map<string, THREE.Vector3>();
    if (wantsOutline) {
      for (let o = 0; o < tri.length; o += 9) {
        _a.set(tri[o], tri[o + 1], tri[o + 2]);
        _b.set(tri[o + 3], tri[o + 4], tri[o + 5]);
        _c.set(tri[o + 6], tri[o + 7], tri[o + 8]);
        _n.crossVectors(_e1.subVectors(_b, _a), _e2.subVectors(_c, _a)); // area-weighted
        for (let v = 0; v < 3; v++) {
          const k = key(tri[o + v * 3], tri[o + v * 3 + 1], tri[o + v * 3 + 2]);
          const acc = smooth.get(k);
          if (acc === undefined) smooth.set(k, _n.clone());
          else acc.add(_n);
        }
      }
      for (const v of smooth.values()) v.normalize();
    }

    const passes = doubleSided ? 2 : 1;
    for (let pass = 0; pass < passes; pass++) {
      for (let o = 0; o < tri.length; o += 9) {
        const back = pass === 1;
        _a.set(tri[o], tri[o + 1], tri[o + 2]);
        if (back) {
          _b.set(tri[o + 6], tri[o + 7], tri[o + 8]);
          _c.set(tri[o + 3], tri[o + 4], tri[o + 5]);
        } else {
          _b.set(tri[o + 3], tri[o + 4], tri[o + 5]);
          _c.set(tri[o + 6], tri[o + 7], tri[o + 8]);
        }
        _n.crossVectors(_e1.subVectors(_b, _a), _e2.subVectors(_c, _a)).normalize();
        _cent.copy(_a).add(_b).add(_c).multiplyScalar(1 / 3);

        _col.copy(base);
        if (ud.paint !== undefined) ud.paint(_cent, _n, _col);
        if (isGlow) {
          _col.multiplyScalar(glowBoost);
        } else {
          let f = 1;
          if (ud.noTone !== true) {
            const ny = _n.y;
            f = ny > 0 ? 1 - opts.back * ny : 1 + opts.belly * -ny;
            const y = _cent.y;
            const ao = y < 0.32 ? 0.8 + 0.2 * (y / 0.32) : 1;
            f *= ao > 0.8 ? ao : 0.8;
          }
          f *= 0.965 + 0.07 * jitter(_cent.x, _cent.y, _cent.z);
          _col.multiplyScalar(f);
        }

        target.pos.push(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z, _c.x, _c.y, _c.z);
        for (let v = 0; v < 3; v++) {
          target.nor.push(_n.x, _n.y, _n.z);
          target.col.push(_col.r, _col.g, _col.b);
          target.skin.push(bi);
        }
        triangles++;

        if (wantsOutline && !back) {
          outline.pos.push(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z, _c.x, _c.y, _c.z);
          const on = outline.outN;
          for (let v = 0; v < 3; v++) {
            const vx = v === 0 ? _a : v === 1 ? _b : _c;
            const sn = smooth.get(key(vx.x, vx.y, vx.z));
            outline.nor.push(_n.x, _n.y, _n.z);
            if (on !== null) {
              if (sn !== undefined) on.push(sn.x, sn.y, sn.z);
              else on.push(_n.x, _n.y, _n.z);
            }
            outline.skin.push(bi);
          }
        }
      }
    }
  }

  // Remove the source parts (keep any that are joints or carry children).
  const deadMats = new Set<THREE.Material>();
  for (const mesh of items) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (jointNodes.has(mesh) || mesh.children.length > 0) {
      mesh.layers.disableAll(); // still a transform node; never drawn
      continue;
    }
    mesh.removeFromParent();
    mesh.geometry.dispose();
    for (const m of mats) deadMats.add(m);
  }
  for (const m of deadMats) m.dispose();

  // Skeleton over the joint pivots (any Object3D works as a bone in three).
  const skeleton = new THREE.Skeleton(bones as THREE.Bone[]);

  const bodyMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.78,
    metalness: 0,
  });
  const bodyMesh = makeSkinned(body, bodyMat, bodyRoot, skeleton, false);
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  const materials: THREE.Material[] = [bodyMat];

  const depthMat = new THREE.MeshBasicMaterial({ colorWrite: false });
  const depthMesh = new THREE.SkinnedMesh(bodyMesh.geometry, depthMat);
  bodyRoot.add(depthMesh);
  depthMesh.updateWorldMatrix(true, false);
  depthMesh.bind(skeleton, depthMesh.matrixWorld);
  depthMesh.boundingSphere = bodyMesh.boundingSphere;
  depthMesh.boundingBox = bodyMesh.boundingBox;
  depthMesh.renderOrder = -2;
  depthMesh.visible = false;

  let glowMesh: THREE.SkinnedMesh | null = null;
  if (glowB.pos.length > 0) {
    const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true });
    glowMesh = makeSkinned(glowB, glowMat, bodyRoot, skeleton, false);
    materials.push(glowMat);
  }

  const outlineWidth = { value: 0.022 };
  let outlineMesh: THREE.SkinnedMesh | null = null;
  let outlineMat: THREE.MeshBasicMaterial | null = null;
  if (outline.pos.length > 0) {
    outlineMat = new THREE.MeshBasicMaterial({ color: opts.outlineColor, side: THREE.BackSide });
    outlineMat.onBeforeCompile = (shader) => {
      shader.uniforms.uOutline = outlineWidth;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aOutN;\nuniform float uOutline;')
        .replace(
          '#include <begin_vertex>',
          'float gkDepth = -(modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).z;\n' +
            'vec3 transformed = vec3(position) + aOutN * uOutline * clamp(gkDepth / 7.0, 0.6, 2.6);',
        );
    };
    outlineMat.customProgramCacheKey = () => 'gk-outline-hull';
    outlineMesh = makeSkinned(outline, outlineMat, bodyRoot, skeleton, true);
    outlineMesh.renderOrder = -1;
  }

  return {
    body: bodyMesh,
    depth: depthMesh,
    glow: glowMesh,
    outline: outlineMesh,
    outlineWidth,
    materials,
    outlineMaterial: outlineMat,
    triangles,
  };
}

function makeSkinned(
  b: Bucket,
  mat: THREE.Material,
  bodyRoot: THREE.Group,
  skeleton: THREE.Skeleton,
  outline: boolean,
): THREE.SkinnedMesh {
  const n = b.pos.length / 3;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
  if (!outline) geo.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
  if (outline && b.outN !== null) geo.setAttribute('aOutN', new THREE.Float32BufferAttribute(b.outN, 3));
  const si = new Uint16Array(n * 4);
  const sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    si[i * 4] = b.skin[i];
    sw[i * 4] = 1;
  }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();

  const m = new THREE.SkinnedMesh(geo, mat);
  bodyRoot.add(m);
  m.updateWorldMatrix(true, false);
  m.bind(skeleton, m.matrixWorld);
  // Generous bounds: poses (rears, lunges, neck swings) stay inside.
  const bs = geo.boundingSphere;
  if (bs !== null) m.boundingSphere = new THREE.Sphere(bs.center.clone(), bs.radius * 1.5 + 0.6);
  const bb = geo.boundingBox;
  if (bb !== null) m.boundingBox = bb.clone();
  m.castShadow = false;
  m.receiveShadow = false;
  return m;
}
