/**
 * WP-D internal helper: accumulates flat-colored primitive geometries into ONE
 * merged, vertex-colored BufferGeometry so large static structures (all the
 * stadium stonework) render as a single draw call (BLUEPRINT §11.4 budgets).
 *
 * Everything here runs at init time only — nothing per frame.
 */

import * as THREE from 'three';

const SCRATCH_COLOR = new THREE.Color();

/** Compose a translate + yaw(Y) + scale matrix (allocates; init-time only). */
export function matAt(
  x: number,
  y: number,
  z: number,
  yawY = 0,
  sx = 1,
  sy = sx,
  sz = sx,
): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yawY, 0)),
    new THREE.Vector3(sx, sy, sz),
  );
}

/** Compose a translate + arbitrary-rotation + scale matrix (init-time only). */
export function matQuatAt(
  x: number,
  y: number,
  z: number,
  q: THREE.Quaternion,
  sx = 1,
  sy = sx,
  sz = sx,
): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    q,
    new THREE.Vector3(sx, sy, sz),
  );
}

/**
 * Yaw that points local +Z toward the arena center for a ring item placed at
 * layout angle θ (radians; layout convention x=r·cosθ, z=r·sinθ, §9). Local +X
 * ends up tangent to the ring, so wall panels/banners/gates all use this.
 */
export function ringFacingYaw(thetaRad: number): number {
  return Math.atan2(-Math.cos(thetaRad), -Math.sin(thetaRad));
}

export class GeoAccumulator {
  private parts: THREE.BufferGeometry[] = [];

  /**
   * Add `geometry` (ownership transferred — it is disposed on build) tinted
   * with `color`, transformed by `matrix`. `flipWinding` reverses triangle
   * order so faces render correctly when viewed from "inside" (e.g. stand
   * risers seen from the arena floor with a front-side material).
   */
  add(
    geometry: THREE.BufferGeometry,
    color: THREE.ColorRepresentation,
    matrix?: THREE.Matrix4,
    flipWinding = false,
  ): void {
    if (matrix !== undefined) geometry.applyMatrix4(matrix);

    if (geometry.getIndex() === null) {
      const n = geometry.getAttribute('position').count;
      const seq = new Uint32Array(n);
      for (let i = 0; i < n; i++) seq[i] = i;
      geometry.setIndex(new THREE.BufferAttribute(seq, 1));
    }
    if (flipWinding) {
      const idx = geometry.getIndex();
      if (idx !== null) {
        for (let t = 0; t + 2 < idx.count; t += 3) {
          const b = idx.getX(t + 1);
          idx.setX(t + 1, idx.getX(t + 2));
          idx.setX(t + 2, b);
        }
      }
    }

    SCRATCH_COLOR.set(color);
    const count = geometry.getAttribute('position').count;
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      col[i * 3] = SCRATCH_COLOR.r;
      col[i * 3 + 1] = SCRATCH_COLOR.g;
      col[i * 3 + 2] = SCRATCH_COLOR.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.parts.push(geometry);
  }

  /**
   * Merge everything added so far into a single indexed geometry carrying
   * position / normal / color. UVs are dropped (untextured materials).
   */
  buildGeometry(): THREE.BufferGeometry {
    let totalV = 0;
    let totalI = 0;
    for (const g of this.parts) {
      totalV += g.getAttribute('position').count;
      const idx = g.getIndex();
      totalI += idx === null ? 0 : idx.count;
    }
    const pos = new Float32Array(totalV * 3);
    const nor = new Float32Array(totalV * 3);
    const col = new Float32Array(totalV * 3);
    const idxOut = new Uint32Array(totalI);

    let vOfs = 0;
    let iOfs = 0;
    for (const g of this.parts) {
      const p = g.getAttribute('position');
      const n = g.getAttribute('normal');
      const c = g.getAttribute('color');
      const count = p.count;
      for (let i = 0; i < count; i++) {
        const o = (vOfs + i) * 3;
        pos[o] = p.getX(i);
        pos[o + 1] = p.getY(i);
        pos[o + 2] = p.getZ(i);
        nor[o] = n.getX(i);
        nor[o + 1] = n.getY(i);
        nor[o + 2] = n.getZ(i);
        col[o] = c.getX(i);
        col[o + 1] = c.getY(i);
        col[o + 2] = c.getZ(i);
      }
      const idx = g.getIndex();
      if (idx !== null) {
        for (let k = 0; k < idx.count; k++) idxOut[iOfs + k] = idx.getX(k) + vOfs;
        iOfs += idx.count;
      }
      vOfs += count;
      g.dispose();
    }
    this.parts = [];

    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('color', new THREE.BufferAttribute(col, 3));
    out.setIndex(new THREE.BufferAttribute(idxOut, 1));
    return out;
  }

  /** Build a single mesh from the accumulated parts. */
  build(material: THREE.Material): THREE.Mesh {
    return new THREE.Mesh(this.buildGeometry(), material);
  }
}
