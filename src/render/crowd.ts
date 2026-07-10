/**
 * WP-D internal helper: the InstancedMesh crowd (BLUEPRINT §11.2).
 *
 * ≥1200 low-poly torsos with per-instance color variety and a coarse bob/wave
 * animation updated at ~10 Hz. Cheer amplitude is driven by the `excitement`
 * value (0–1) passed into {@link Crowd.update} each frame.
 *
 * Per-frame cost: one accumulator check; on a 10 Hz tick, one float write per
 * instance (the matrix Y-translation element) — no allocation.
 */

import * as THREE from 'three';
import type { Rng } from '../core/math';
import { GeoAccumulator, matAt } from './geo';

export interface CrowdSeat {
  x: number;
  y: number;
  z: number;
  /** Facing yaw (radians; local +Z convention, see core/math dirToYaw). */
  yaw: number;
  /** Uniform body scale (~0.85–1.15 variety). */
  scale: number;
  /** Bob phase offset; include the seat's ring angle for stadium-wave motion. */
  phase: number;
}

/** Muted tunic palette; multiplied by a random shade for variety. */
const TUNIC_COLORS: readonly number[] = [
  0x9a3b2e, 0xb0703a, 0x8a7c54, 0x5f7561, 0x566a80, 0x74586e, 0xa08a4e, 0x7d6b52, 0x8f5a44,
  0x6b7a6e,
];

const TICK = 0.1; // 10 Hz coarse animation (BLUEPRINT §11.2)

const scratchColor = new THREE.Color();

/** Build the shared ~24-tri torso+head geometry (vertex-colored, tint-ready). */
function buildBodyGeometry(): THREE.BufferGeometry {
  const acc = new GeoAccumulator();
  // Torso: white → takes the per-instance tunic tint fully.
  acc.add(new THREE.BoxGeometry(0.52, 0.62, 0.32), 0xffffff, matAt(0, 0.31, 0));
  // Head: warm lighter shade so it reads against the tunic after tinting.
  acc.add(new THREE.BoxGeometry(0.24, 0.26, 0.24), 0xffe6cf, matAt(0, 0.75, 0));
  return acc.buildGeometry();
}

export class Crowd {
  readonly mesh: THREE.InstancedMesh;

  private readonly baseY: Float32Array;
  private readonly phase: Float32Array;
  private readonly ampMul: Float32Array;
  private readonly material: THREE.MeshStandardMaterial;

  private time = 0;
  private acc = 0;

  constructor(seats: readonly CrowdSeat[], rng: Rng) {
    const n = seats.length;
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 1,
      metalness: 0,
    });
    const mesh = new THREE.InstancedMesh(buildBodyGeometry(), this.material, n);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // Instances span the whole stands ring; skip per-instance culling maths.
    mesh.frustumCulled = false;

    this.baseY = new Float32Array(n);
    this.phase = new Float32Array(n);
    this.ampMul = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      const s = seats[i];
      mesh.setMatrixAt(i, matAt(s.x, s.y, s.z, s.yaw, s.scale));
      this.baseY[i] = s.y;
      this.phase[i] = s.phase;
      this.ampMul[i] = 0.7 + rng() * 0.6;

      scratchColor.setHex(TUNIC_COLORS[Math.floor(rng() * TUNIC_COLORS.length)]);
      scratchColor.multiplyScalar(0.72 + rng() * 0.42);
      mesh.setColorAt(i, scratchColor);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    this.mesh = mesh;
  }

  get count(): number {
    return this.mesh.count;
  }

  /** Advance the coarse 10 Hz bob/wave; `excitement` in [0,1] scales amplitude. */
  update(dt: number, excitement: number): void {
    this.acc += dt;
    if (this.acc < TICK) return;
    this.time += this.acc;
    this.acc = 0;

    const ex = excitement < 0 ? 0 : excitement > 1 ? 1 : excitement;
    const amp = 0.045 + 0.3 * ex;
    const freq = 2.2 + 5.5 * ex;
    const t = this.time;
    const arr = this.mesh.instanceMatrix.array as Float32Array;
    const n = this.mesh.count;
    for (let i = 0; i < n; i++) {
      const bob = (Math.sin(this.phase[i] + t * freq) * 0.5 + 0.5) * amp * this.ampMul[i];
      arr[i * 16 + 13] = this.baseY[i] + bob;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
