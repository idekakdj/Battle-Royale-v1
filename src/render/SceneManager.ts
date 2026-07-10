/**
 * SceneManager (BLUEPRINT §11.1) — the three.js scene shell for the match.
 *
 * Owns: WebGLRenderer on the existing fullscreen canvas, PerspectiveCamera
 * (positioned by the CameraRig), warm flat-shaded lighting — hemisphere light
 * (sky #ffe8c0 / ground #6b5a3e) plus ONE directional sun with a single 2048
 * shadow map sized to the 60 m arena — subtle warm fog, a gradient sky dome
 * with a low sun, resize handling, and the shared `excitement` value (0–1)
 * that match systems set on kills/ults and the stadium crowd reads.
 */

import * as THREE from 'three';

const SKY_VERTEX = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const SKY_FRAGMENT = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uBottom;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
varying vec3 vWorld;
void main() {
  vec3 d = normalize(vWorld);
  float h = d.y;
  vec3 col = mix(uHorizon, uTop, smoothstep(0.02, 0.5, h));
  col = mix(uBottom, col, smoothstep(-0.12, 0.02, h));
  float s = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (pow(s, 220.0) * 1.2 + pow(s, 10.0) * 0.22);
  gl_FragColor = vec4(col, 1.0);
}
`;

export class SceneManager {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly sun: THREE.DirectionalLight;

  /**
   * Crowd/match excitement, 0–1. Match systems (WP-I) raise it on kills/ults
   * and decay it; the stadium crowd bob amplitude and audio follow it.
   */
  excitement = 0;

  private readonly skyMaterial: THREE.ShaderMaterial;
  private readonly skyMesh: THREE.Mesh;
  private readonly handleResize = (): void => {
    this.resize();
  };

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 400);
    this.camera.position.set(0, 14, -26);
    this.camera.lookAt(0, 1, 0);

    // Subtle warm fog: barely touches the arena, softens the far stands.
    this.scene.fog = new THREE.Fog(0xe7c093, 55, 170);

    // §11.1 lighting: hemisphere + one shadowed directional sun.
    const hemi = new THREE.HemisphereLight(0xffe8c0, 0x6b5a3e, 1.15);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xffe2b8, 2.1);
    sun.position.set(46, 40, 24); // low warm sun
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -34;
    sc.right = 34;
    sc.top = 34;
    sc.bottom = -34;
    sc.near = 10;
    sc.far = 150;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.15;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;

    // Gradient sky dome (fog-exempt, drawn first).
    this.skyMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: new THREE.Color(0x6fa3cd) },
        uHorizon: { value: new THREE.Color(0xffe0ae) },
        uBottom: { value: new THREE.Color(0xb98e5f) },
        uSunColor: { value: new THREE.Color(0xfff0c2) },
        uSunDir: { value: sun.position.clone().normalize() },
      },
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.skyMesh = new THREE.Mesh(new THREE.SphereGeometry(190, 24, 12), this.skyMaterial);
    this.skyMesh.renderOrder = -10;
    this.skyMesh.frustumCulled = false;
    this.scene.add(this.skyMesh);

    this.resize();
    window.addEventListener('resize', this.handleResize);
  }

  /** Match the drawing buffer + camera aspect to the current window size. */
  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /** Last-frame renderer stats (valid after `render()`), for budget checks. */
  getStats(): { drawCalls: number; triangles: number } {
    const r = this.renderer.info.render;
    return { drawCalls: r.calls, triangles: r.triangles };
  }

  dispose(): void {
    window.removeEventListener('resize', this.handleResize);
    this.skyMesh.geometry.dispose();
    this.skyMaterial.dispose();
    this.renderer.dispose();
  }
}
