/**
 * Debug overlay (F3 / `setDebugBoxes`): hurtboxes (green), hitboxes (red, from `snapshot.hitboxes`), ledge grab boxes
 * (yellow), platform surfaces (grey) and blast zones (cyan). One LineSegments draw call; buffers preallocated.
 */

import * as THREE from 'three';
import { PHYS } from '../config';
import { getMoveset } from '../data';
import type { BrawlSnapshot, StageDef } from '../types';

const CIRCLE_SEGS = 20;

export class DebugBoxes {
  readonly lines: THREE.LineSegments;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.LineBasicMaterial;
  private n = 0;
  private readonly maxVerts: number;
  private on = false;
  private readonly sizes = new Map<string, { w: number; h: number }>();

  constructor(private readonly stage: StageDef, maxSegments = 2400) {
    this.maxVerts = maxSegments * 2;
    this.pos = new Float32Array(this.maxVerts * 3);
    this.col = new Float32Array(this.maxVerts * 3);
    this.geo = new THREE.BufferGeometry();
    const pa = new THREE.BufferAttribute(this.pos, 3);
    pa.setUsage(THREE.DynamicDrawUsage);
    const ca = new THREE.BufferAttribute(this.col, 3);
    ca.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', pa);
    this.geo.setAttribute('color', ca);
    this.geo.setDrawRange(0, 0);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.mat = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, fog: false, toneMapped: false });
    this.lines = new THREE.LineSegments(this.geo, this.mat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 900;
    this.lines.visible = false;
    this.lines.name = 'brawl-debug-boxes';
  }

  setEnabled(on: boolean): void {
    this.on = on;
    this.lines.visible = on;
  }

  get enabled(): boolean {
    return this.on;
  }

  /** Number of line segments drawn last update (tests). */
  get segments(): number {
    return this.n / 2;
  }

  private seg(x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number): void {
    if (this.n + 2 > this.maxVerts) return;
    const i = this.n * 3;
    this.pos[i] = x0;
    this.pos[i + 1] = y0;
    this.pos[i + 2] = 1.2;
    this.pos[i + 3] = x1;
    this.pos[i + 4] = y1;
    this.pos[i + 5] = 1.2;
    for (let k = 0; k < 2; k++) {
      this.col[i + k * 3] = r;
      this.col[i + k * 3 + 1] = g;
      this.col[i + k * 3 + 2] = b;
    }
    this.n += 2;
  }

  private rect(cx: number, cy: number, w: number, h: number, r: number, g: number, b: number): void {
    const x0 = cx - w / 2;
    const x1 = cx + w / 2;
    const y0 = cy - h / 2;
    const y1 = cy + h / 2;
    this.seg(x0, y0, x1, y0, r, g, b);
    this.seg(x1, y0, x1, y1, r, g, b);
    this.seg(x1, y1, x0, y1, r, g, b);
    this.seg(x0, y1, x0, y0, r, g, b);
  }

  private circle(cx: number, cy: number, rad: number, r: number, g: number, b: number): void {
    let px = cx + rad;
    let py = cy;
    for (let i = 1; i <= CIRCLE_SEGS; i++) {
      const a = (i / CIRCLE_SEGS) * Math.PI * 2;
      const nx = cx + Math.cos(a) * rad;
      const ny = cy + Math.sin(a) * rad;
      this.seg(px, py, nx, ny, r, g, b);
      px = nx;
      py = ny;
    }
  }

  update(snap: BrawlSnapshot): void {
    if (!this.on) return;
    this.n = 0;
    const st = this.stage;
    const bl = st.blast;
    // Blast zones
    this.rect((bl.left + bl.right) / 2, (bl.bottom + bl.top) / 2, bl.right - bl.left, bl.top - bl.bottom, 0.3, 0.9, 1);
    // Platforms (live positions) + ledge grab boxes on solid ones
    for (const p of snap.platforms) {
      this.seg(p.x0, p.y, p.x1, p.y, 0.75, 0.75, 0.75);
      const def = st.platforms.find((d) => d.id === p.id);
      if (def !== undefined && def.kind === 'solid') {
        for (const s of [-1, 1] as const) {
          if (s < 0 ? !def.ledgeLeft : !def.ledgeRight) continue;
          const cx = s < 0 ? p.x0 : p.x1;
          // grab box: out (away from the stage) / in (toward it), up / down from the corner
          const xo = cx + s * PHYS.ledgeBoxOut;
          const xi = cx - s * PHYS.ledgeBoxIn;
          const x0 = Math.min(xo, xi);
          const x1 = Math.max(xo, xi);
          const y0 = p.y - PHYS.ledgeBoxDown;
          const y1 = p.y + PHYS.ledgeBoxUp;
          this.rect((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0, 1, 0.85, 0.1);
        }
      }
    }
    // Hurtboxes
    for (const f of snap.fighters) {
      if (!f.alive) continue;
      let sz = this.sizes.get(f.animal);
      if (sz === undefined) {
        const s = getMoveset(f.animal).stats;
        sz = { w: s.width, h: s.height };
        this.sizes.set(f.animal, sz);
      }
      const inv = f.invuln > 0;
      this.rect(f.pos.x, f.pos.y + sz.h / 2, sz.w, sz.h, inv ? 0.4 : 0.1, 1, inv ? 0.9 : 0.25);
    }
    // Hitboxes
    for (const hb of snap.hitboxes) {
      if (hb.shape === 'circle') this.circle(hb.x, hb.y, hb.r, 1, 0.15, 0.1);
      else this.rect(hb.x, hb.y, hb.w, hb.h, 1, 0.15, 0.1);
    }
    this.geo.setDrawRange(0, this.n);
    (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.lines.removeFromParent();
  }
}
