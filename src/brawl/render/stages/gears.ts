/**
 * Procedural cogs for Clockwork Heights (v1.6): a vertex-coloured gear (toothed outline, lightening holes, a rim ring and a hub) in the
 * XY plane facing +Z, built through the shared `GeoBuilder`, plus the tick-synced rotation curve used by every cog and dial of the stage.
 * Node-safe (no DOM).
 */

import * as THREE from 'three';
import { GeoBuilder } from './common';

export interface GearSpec {
  /** Tip radius (m). */
  radius: number;
  teeth: number;
  /** Tooth height as a fraction of the radius. */
  toothH?: number;
  /** Thickness along Z (m). */
  depth: number;
  /** Lightening holes between spokes (0 = solid disc). */
  holes?: number;
  body: number;
  rim: number;
  hub: number;
}

/** Outline of a gear (teeth + optional round holes) as a three.js Shape. */
function gearShape(r: number, teeth: number, toothH: number, holes: number): THREE.Shape {
  const rb = r * (1 - toothH);
  const s = new THREE.Shape();
  const step = (Math.PI * 2) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    const pts: [number, number][] = [
      [a, rb],
      [a + step * 0.12, r],
      [a + step * 0.38, r],
      [a + step * 0.5, rb],
    ];
    for (let k = 0; k < pts.length; k++) {
      const x = Math.cos(pts[k][0]) * pts[k][1];
      const y = Math.sin(pts[k][0]) * pts[k][1];
      if (i === 0 && k === 0) s.moveTo(x, y);
      else s.lineTo(x, y);
    }
  }
  s.closePath();
  if (holes > 0) {
    const hr = rb * 0.17 * Math.min(1.35, 3.2 / Math.max(2, holes) + 0.55);
    const ring = rb * 0.58;
    for (let i = 0; i < holes; i++) {
      const a = (i / holes) * Math.PI * 2 + Math.PI / holes;
      const h = new THREE.Path();
      h.absarc(Math.cos(a) * ring, Math.sin(a) * ring, hr, 0, Math.PI * 2, true);
      s.holes.push(h);
    }
  }
  return s;
}

/** A merged vertex-coloured gear centred on the origin (front face toward +Z). */
export function buildGear(spec: GearSpec, rng: () => number): THREE.BufferGeometry {
  const toothH = spec.toothH ?? 0.16;
  const b = new GeoBuilder(rng);
  const shape = gearShape(spec.radius, spec.teeth, toothH, spec.holes ?? 0);
  const ex = new THREE.ExtrudeGeometry(shape, { depth: spec.depth, bevelEnabled: false, curveSegments: 4 });
  ex.translate(0, 0, -spec.depth / 2);
  b.add(ex, spec.body, 0, 0, 0, { jitter: 0.02 });
  ex.dispose();
  const rb = spec.radius * (1 - toothH);
  // rim ring (a slightly thicker, brighter band just inside the teeth) and the hub boss + axle
  const ring = new THREE.RingGeometry(rb * 0.86, rb * 0.97, Math.max(16, spec.teeth * 2));
  b.add(ring, spec.rim, 0, 0, spec.depth / 2 + 0.012, { jitter: 0 });
  ring.dispose();
  b.cyl(rb * 0.2, rb * 0.22, spec.depth * 1.5, spec.hub, 0, 0, 0, 10, { rx: Math.PI / 2, jitter: 0 });
  b.cyl(rb * 0.09, rb * 0.09, spec.depth * 1.9, spec.rim, 0, 0, 0, 8, { rx: Math.PI / 2, jitter: 0 });
  const g = b.build();
  if (g === null) throw new Error('gear: empty geometry');
  return g;
}

/**
 * Tick-synced rotation: every `period` seconds the cog advances `stepRad` with a quick ease-out and a hint of overshoot, then holds —
 * a clockwork escapement rather than a smooth spin. `phase` offsets the tick (seconds). Pure function of the FX clock.
 */
export function tickAngle(time: number, period: number, stepRad: number, phase = 0): number {
  const t = (time + phase) / period;
  const n = Math.floor(t);
  const f = t - n;
  const e = f < 0.22 ? f / 0.22 : 1;
  // ease-out-back, small overshoot
  const c = 1.7;
  const k = e - 1;
  const eased = 1 + (c + 1) * k * k * k + c * k * k;
  return (n + (e >= 1 ? 1 : eased)) * stepRad;
}
