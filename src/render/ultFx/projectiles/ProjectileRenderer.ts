/**
 * ProjectileRenderer (v1.3 WP-T) — draws `snapshot.projectiles` (gorilla Boulder
 * Hurl). A small pool of low-poly, flat-shaded stone meshes (jittered
 * icosahedron with per-face shading, shadow-casting), each with a faint ground
 * shadow disc so its landing spot reads, plus a dust / spark trail from
 * {@link Effects.boulderTrail}. Allocation-free after construction.
 *
 * Positions are drawn like the fighters: the snapshot is the state after the
 * last sim step, so the draw position is pulled back by `(1 - alpha) · dt`
 * along the velocity to line up with the interpolated fighter transforms.
 */

import * as THREE from 'three';
import type { ProjectileState } from '../../../core/types';
import type { Effects } from '../../Effects';

const MAX = 8;
const TAU = Math.PI * 2;

function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

/** Low-poly jittered stone, radius ~1, per-face vertex colours (non-indexed → flat facets). */
function makeStoneGeometry(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const n = pos.count;
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    // Same position → same hash → shared vertices stay welded.
    const k = 0.8 + hash3(Math.round(x * 100), Math.round(y * 100), Math.round(z * 100)) * 0.32;
    pos.setXYZ(i, x * k, y * k * 0.94, z * k);
  }
  g.computeVertexNormals();
  const colors = new Float32Array(n * 3);
  for (let t = 0; t < n; t += 3) {
    const cx = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3;
    const cy = (pos.getY(t) + pos.getY(t + 1) + pos.getY(t + 2)) / 3;
    const cz = (pos.getZ(t) + pos.getZ(t + 1) + pos.getZ(t + 2)) / 3;
    const shade = 0.62 + hash3(cx * 91, cy * 91, cz * 91) * 0.42;
    // Warm sandstone grey with the odd darker / rust facet.
    const rust = hash3(cx * 33, cy * 47, cz * 29) > 0.86 ? 0.82 : 1;
    for (let v = 0; v < 3; v++) {
      colors[(t + v) * 3] = 0.6 * shade;
      colors[(t + v) * 3 + 1] = 0.55 * shade * rust;
      colors[(t + v) * 3 + 2] = 0.47 * shade * rust * rust;
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

export class ProjectileRenderer {
  private readonly scene: THREE.Scene;
  private readonly effects: Effects;
  private readonly group = new THREE.Group();
  private readonly meshes: THREE.Mesh[] = [];
  private readonly shadows: THREE.Mesh[] = [];
  private readonly ids = new Int32Array(MAX).fill(-1);
  private readonly seen = new Uint8Array(MAX);
  private readonly stoneGeo: THREE.BufferGeometry;
  private readonly discGeo: THREE.BufferGeometry;
  private readonly stoneMat: THREE.MeshStandardMaterial;
  private readonly shadowMat: THREE.MeshBasicMaterial;

  constructor(scene: THREE.Scene, effects: Effects) {
    this.scene = scene;
    this.effects = effects;
    this.group.name = 'projectiles';
    this.stoneGeo = makeStoneGeometry();
    this.discGeo = new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2);
    this.stoneMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0.02,
      flatShading: true,
    });
    this.shadowMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    for (let i = 0; i < MAX; i++) {
      const m = new THREE.Mesh(this.stoneGeo, this.stoneMat);
      m.castShadow = true;
      m.visible = false;
      m.frustumCulled = false;
      this.group.add(m);
      this.meshes.push(m);
      const s = new THREE.Mesh(this.discGeo, this.shadowMat.clone());
      s.visible = false;
      s.renderOrder = 2;
      this.group.add(s);
      this.shadows.push(s);
    }
    scene.add(this.group);
  }

  private slotFor(id: number): number {
    for (let i = 0; i < MAX; i++) if (this.ids[i] === id) return i;
    for (let i = 0; i < MAX; i++) {
      if (this.ids[i] === -1) {
        this.ids[i] = id;
        return i;
      }
    }
    return -1;
  }

  /**
   * Per render frame. `backDt` = `(1 - alpha) · fixedDt` (how far the snapshot
   * is ahead of the drawn fighters); `dt` = real frame time (spin, trail).
   */
  update(list: readonly ProjectileState[], dt: number, backDt: number): void {
    this.seen.fill(0);
    for (let n = 0; n < list.length; n++) {
      const p = list[n];
      const first = this.ids.indexOf(p.id) === -1;
      const i = this.slotFor(p.id);
      if (i < 0) continue;
      this.seen[i] = 1;
      const m = this.meshes[i];
      const r = p.radius > 0.1 ? p.radius : 0.6;
      const x = p.pos.x - p.vel.x * backDt;
      const y = Math.max(r * 0.5, p.pos.y - p.vel.y * backDt);
      const z = p.pos.z - p.vel.z * backDt;
      m.position.set(x, y, z);
      m.scale.set(r * 1.05, r * 0.95, r * 1.1);
      if (first) {
        m.rotation.set(Math.random() * TAU, Math.random() * TAU, Math.random() * TAU);
        this.effects.onDust(p.pos, 0.9);
      }
      m.rotation.x += (p.vel.z / r) * dt * 0.7;
      m.rotation.z -= (p.vel.x / r) * dt * 0.7;
      m.rotation.y += dt * 1.6;
      m.visible = true;

      const s = this.shadows[i];
      const sh = Math.max(0.25, Math.min(1, 1.15 - y * 0.09));
      s.position.set(x, 0.035, z);
      s.scale.set(r * 1.2 * sh, 1, r * 1.2 * sh);
      (s.material as THREE.MeshBasicMaterial).opacity = 0.34 * sh;
      s.visible = true;

      this.effects.boulderTrail(m.position, p.vel.x, p.vel.y, p.vel.z, dt);
    }
    for (let i = 0; i < MAX; i++) {
      if (this.ids[i] !== -1 && this.seen[i] === 0) {
        this.ids[i] = -1;
        this.meshes[i].visible = false;
        this.shadows[i].visible = false;
      }
    }
  }

  /** Number of boulders currently drawn (tests / debug). */
  get visibleCount(): number {
    let n = 0;
    for (let i = 0; i < MAX; i++) if (this.meshes[i].visible) n++;
    return n;
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.stoneGeo.dispose();
    this.discGeo.dispose();
    this.stoneMat.dispose();
    this.shadowMat.dispose();
    for (const s of this.shadows) (s.material as THREE.Material).dispose();
    this.meshes.length = 0;
    this.shadows.length = 0;
  }
}
