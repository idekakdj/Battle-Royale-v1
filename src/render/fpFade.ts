/**
 * Near-camera fade for own-body effects in first person (v1.3 WP-Q).
 *
 * In first person the camera sits INSIDE the player's own effects: the ultimate
 * flash (a 7 m billboard at chest height), impact / guard-break flashes on a hit
 * the player takes, damage numbers popping at the eye. This pass runs after
 * `Effects.update()` and scales down the opacity of every effect Sprite whose
 * radius swallows the camera, so the effect stays readable at the edges but
 * never whites out the view. Effect pools assign `material.opacity` afresh
 * every frame, so scaling it here needs no bookkeeping / restore.
 *
 * Usage: snapshot `scene.children` BEFORE constructing Effects, then
 * `new NearCameraFade(scene, before)` collects the sprites Effects added.
 */

import * as THREE from 'three';

/** Fully faded inside this fraction of the sprite radius, fully visible past `FADE_END` × radius. */
const FADE_START = 0.55;
const FADE_END = 1.7;

export function nearFadeFactor(distance: number, radius: number): number {
  if (radius <= 1e-6) return 1;
  const t = (distance / radius - FADE_START) / (FADE_END - FADE_START);
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

export class NearCameraFade {
  private readonly sprites: THREE.Sprite[] = [];
  private enabled = false;
  private readonly _p = new THREE.Vector3();

  constructor(scene: THREE.Scene, before: ReadonlySet<THREE.Object3D>) {
    for (const child of scene.children) {
      if (before.has(child)) continue;
      child.traverse((o) => {
        if (o instanceof THREE.Sprite) this.sprites.push(o);
      });
    }
  }

  /** On while the first-person camera is (mostly) active; off restores nothing (pools re-assign every frame). */
  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  /** Call once per frame after the effects update and the camera placement. */
  apply(camera: THREE.Camera): void {
    if (!this.enabled) return;
    const cam = camera.position;
    for (let i = 0; i < this.sprites.length; i++) {
      const s = this.sprites[i];
      if (!s.visible) continue;
      s.getWorldPosition(this._p);
      const r = Math.max(s.scale.x, s.scale.y) * 0.5;
      const f = nearFadeFactor(this._p.distanceTo(cam), r);
      if (f < 1) s.material.opacity *= f;
    }
  }
}
