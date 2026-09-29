/**
 * Attack-range indicator (v1.2 §5b, WP-P): a faint gold ground sector in
 * front of the player's fighter showing the REAL basic-attack reach — the
 * animal's `range` / `arcDeg` from config, the same sector the sim tests
 * (a rival whose body touches the wedge is hit). Oriented by the fighter's
 * interpolated yaw; fades in when a rival is near or during a swing, and
 * brightens for a moment at the impact instant ({@link RangeIndicator.pulse}).
 *
 * One quad, one draw call, no per-frame allocation. Local frame matches the
 * swing ribbon: +z is forward at yaw 0, `rotation.y = yaw`.
 */

import * as THREE from 'three';
import { DEG2RAD } from '../core/math';

const VERTEX = /* glsl */ `
varying vec2 vP;
void main() {
  vP = position.xz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform float uHalfArc;
uniform float uAlpha;
uniform float uPulse;
uniform vec3 uColor;
varying vec2 vP;
void main() {
  float d = length(vP);
  if (d > 1.05) discard;
  float ang = atan(vP.x, vP.y);
  float over = abs(ang) - uHalfArc;
  float dw = fwidth(d) * 1.5;
  float full = step(3.1, uHalfArc);
  float inArc = max(full, 1.0 - smoothstep(0.0, dw + 0.004, over * d));
  float inR = 1.0 - smoothstep(1.0 - dw, 1.0 + dw, d);
  float mask = inArc * inR;
  if (mask < 0.002) discard;
  // Crisp rim along the reach + the two side edges; soft fill in between.
  float rim = 1.0 - smoothstep(0.0, 0.03 + dw, 1.0 - d);
  float edgeD = abs(over) * d;
  float side = (1.0 - full) * (1.0 - smoothstep(0.0, 0.022 + dw, edgeD));
  float fill = 0.14 + 0.12 * smoothstep(0.25, 1.0, d);
  float hub = smoothstep(0.1, 0.32, d); // fade under the fighter's own body
  float a = (fill + max(rim, side) * 0.75) * hub * mask * uAlpha * (1.0 + uPulse * 1.4);
  vec3 col = uColor * (1.0 + uPulse * 0.7);
  gl_FragColor = vec4(col, clamp(a, 0.0, 0.95));
  #include <colorspace_fragment>
}
`;

const FADE_RATE = 9; // 1/s
const PULSE_TAU = 0.14; // s
const LIFT = 0.035;

export class RangeIndicator {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.PlaneGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private readonly scene: THREE.Scene;
  private enabled = true;
  private alpha = 0;
  private pulseAmt = 0;

  constructor(scene: THREE.Scene, color: THREE.ColorRepresentation = 0xffd27a) {
    this.scene = scene;
    this.geo = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uHalfArc: { value: 1 },
        uAlpha: { value: 0 },
        uPulse: { value: 0 },
        uColor: { value: new THREE.Color(color) },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
      fog: false,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /** Settings toggle ("Attack range indicator"). Off hides it at once. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.alpha = 0;
      this.pulseAmt = 0;
      this.mesh.visible = false;
    }
  }

  /** Flash brighter (impact instant of the player's own swing). */
  pulse(strength = 1): void {
    if (!this.enabled) return;
    if (strength > this.pulseAmt) this.pulseAmt = strength;
  }

  /**
   * Per render frame. `show` = a rival is near or a swing is running; the
   * sector fades toward it. `range` in metres, `arcDeg` full arc (360 = ring).
   */
  update(
    dt: number,
    x: number, y: number, z: number, yaw: number,
    range: number, arcDeg: number,
    show: boolean,
  ): void {
    if (!this.enabled) return;
    const target = show ? 1 : 0;
    this.alpha += (target - this.alpha) * (1 - Math.exp(-dt * FADE_RATE));
    this.pulseAmt *= Math.exp(-dt / PULSE_TAU);
    if (this.pulseAmt < 0.01) this.pulseAmt = 0;
    const a = Math.max(this.alpha, this.pulseAmt * 0.8);
    if (a < 0.01) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    this.mesh.position.set(x, y + LIFT, z);
    this.mesh.rotation.y = yaw;
    this.mesh.scale.set(range, 1, range);
    this.mat.uniforms.uHalfArc.value = Math.min(Math.PI, (arcDeg * DEG2RAD) / 2);
    this.mat.uniforms.uAlpha.value = a;
    this.mat.uniforms.uPulse.value = this.pulseAmt;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.geo.dispose();
    this.mat.dispose();
  }
}
