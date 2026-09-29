/**
 * GLSL for the v1.2 trap renderer (WP-P). All four materials are instanced so
 * every trap in the arena shares one draw call per layer:
 *
 *  - SCORCH  (normal blend)  soot / disturbed-sand decal left by a spent trap;
 *  - OVERLAY (additive)      plate rune/hole glow pulse, fire-vent heat and the
 *                            red-orange danger ring for the active window;
 *  - FLAME   (additive)      camera-facing flame tongues (HDR → bloom on high);
 *  - EMBER   (additive)      vertex-animated embers rising off a fire pit.
 *
 * Per-instance layout (shared by scorch + overlay):
 *   aT = (x, z, radius, kind)  kind: 1 = fire, 0 = spikes
 *   aS = overlay: (armedGlow, danger, heat, seed)   scorch: (amount, heat, 0, seed)
 */

const NOISE = /* glsl */ `
float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float tNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(tHash(i), tHash(i + vec2(1.0, 0.0)), u.x),
             mix(tHash(i + vec2(0.0, 1.0)), tHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

/** Flat quad (PlaneGeometry(2,2) lying in XZ) stretched over the trap. */
export const DISC_VERTEX = /* glsl */ `
attribute vec4 aT;
attribute vec4 aS;
uniform float uExtent;
uniform float uLift;
varying vec2 vP;
varying vec4 vT;
varying vec4 vS;
void main() {
  vT = aT;
  vS = aS;
  vec2 p = position.xz * uExtent;
  vP = p;
  vec3 w = vec3(aT.x + p.x * aT.z, uLift, aT.y + p.y * aT.z);
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

export const SCORCH_FRAGMENT = /* glsl */ `
varying vec2 vP;
varying vec4 vT;
varying vec4 vS;
${NOISE}
void main() {
  float amt = vS.x;
  if (amt < 0.002) discard;
  float d = length(vP);
  float n = tNoise(vP * 4.0 + vS.w * 13.0);
  float n2 = tNoise(vP * 11.0 - vS.w * 7.0);
  vec3 col;
  float a;
  if (vT.w > 0.5) {
    // Fire: a charred blast ring on the sand (ragged, radial streaks) and a
    // lighter soot glaze over the plate so its runes stay faintly readable.
    vec2 dir = vP / max(d, 1e-3);
    float rays = 0.65 + 0.35 * tNoise(dir * 2.6 + vS.w * 20.0);
    float outer = 1.0 - smoothstep(0.9, 1.08 + 0.3 * rays, d + (n - 0.5) * 0.25);
    float onSand = smoothstep(0.9, 1.0, d);
    float glaze = (1.0 - onSand) * (0.38 + 0.22 * smoothstep(0.55, 0.0, d));
    a = amt * outer * mix(glaze, 0.8 * (0.8 + 0.2 * n2), onSand);
    col = mix(vec3(0.015, 0.012, 0.01), vec3(0.06, 0.045, 0.035), n2 * onSand);
    // Faint dying glow in the ash while still hot.
    col += vS.y * vec3(0.5, 0.13, 0.02) * smoothstep(0.7, 0.15, d) * n2;
  } else {
    // Spikes: churned, darker sand ring kicked up around the plate.
    float ring = 1.0 - smoothstep(0.0, 0.22, abs(d - 1.1 + (n - 0.5) * 0.14));
    a = amt * ring * 0.5 * (0.75 + 0.25 * n2) * step(0.97, d);
    col = mix(vec3(0.3, 0.22, 0.14), vec3(0.42, 0.32, 0.2), n2);
  }
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
  #include <colorspace_fragment>
}
`;

export const OVERLAY_FRAGMENT = /* glsl */ `
uniform sampler2D uMask;
uniform float uTime;
varying vec2 vP;
varying vec4 vT;
varying vec4 vS;
void main() {
  float d = length(vP);
  float fire = step(0.5, vT.w);
  vec3 m = vec3(0.0);
  if (d < 1.0) m = texture2D(uMask, vec2((vP.x + 1.0) * 0.5, (1.0 - vP.y) * 0.5)).rgb;
  float armed = vS.x;
  float danger = vS.y;
  float heat = vS.z;
  float seed = vS.w;
  float pulse = 0.62 + 0.38 * sin(uTime * 1.7 + seed * 6.2831);
  vec3 col = vec3(0.0);
  // Armed: fire runes glow ember-orange; spike holes smoulder dull red.
  col += fire * m.r * armed * pulse * vec3(2.3, 0.8, 0.2);
  col += (1.0 - fire) * m.g * armed * pulse * vec3(1.5, 0.3, 0.1);
  // Active fire: white-hot vents, blazing runes, a core glow.
  float core = exp(-d * d * 3.2) * step(d, 1.0);
  col += fire * heat * (m.b * vec3(3.2, 1.2, 0.3) + m.r * vec3(2.0, 0.6, 0.14) + core * vec3(0.8, 0.22, 0.05));
  // Danger ring (both kinds) — marching dashes + faint fill + outer halo.
  float ang = atan(vP.y, vP.x);
  float dash = 0.55 + 0.45 * step(0.0, sin(ang * 16.0 - uTime * 3.4));
  float ring = 1.0 - smoothstep(0.02, 0.085, abs(d - 1.0));
  float fill = (1.0 - smoothstep(0.88, 1.0, d)) * 0.03;
  float halo = step(1.0, d) * exp(-(d - 1.0) * 11.0) * 0.25;
  col += danger * (ring * dash + fill + halo) * vec3(2.6, 0.55, 0.12);
  float lum = max(max(col.r, col.g), col.b);
  if (lum < 0.004) discard;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export const FLAME_VERTEX = /* glsl */ `
attribute vec4 aFlame;
attribute vec2 aInfo;
varying vec2 vUv;
varying vec2 vInfo;
void main() {
  vUv = uv;
  vInfo = aInfo;
  vec4 mv = viewMatrix * vec4(aFlame.xyz, 1.0);
  mv.xy += (uv - vec2(0.5, 0.14)) * vec2(1.35, 2.1) * aFlame.w;
  gl_Position = projectionMatrix * mv;
}
`;

export const FLAME_FRAGMENT = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying vec2 vInfo;
${NOISE}
void main() {
  float ph = vInfo.x;
  float bright = vInfo.y;
  float t = uTime + ph * 7.0;
  vec2 p = vUv;
  float n1 = tNoise(vec2(p.x * 4.0 + ph * 3.0, p.y * 3.0 - t * 3.6));
  float n2 = tNoise(vec2(p.x * 9.0 - ph, p.y * 7.0 - t * 6.0));
  float y = (p.y - 0.1) / 0.9;
  float x = (p.x - 0.5) * 2.0 + (n1 - 0.5) * 0.6 * y;
  float width = 0.64 * (1.0 - smoothstep(0.0, 1.0, y)) * (0.78 + 0.22 * sin(t * 9.0 + ph));
  float body = 1.0 - smoothstep(width * 0.5, width + 0.03, abs(x) + (n2 - 0.5) * 0.28);
  body *= smoothstep(-0.05, 0.08, y) * (1.0 - smoothstep(0.5, 0.97, y + (n2 - 0.5) * 0.35));
  float core = body * (1.0 - smoothstep(0.0, width * 0.5 + 0.05, abs(x))) * (1.0 - smoothstep(0.08, 0.5, y));
  // Pit fire: deeper orange than the torches (many tongues overlap additively).
  vec3 col = mix(vec3(1.3, 0.22, 0.03), vec3(2.8, 0.95, 0.16), body);
  col = mix(col, vec3(3.6, 2.0, 0.7), core);
  // Weak (dying / warning) flames cool toward deep red.
  col = mix(vec3(1.2, 0.16, 0.03) * body, col, clamp(bright * 1.3, 0.0, 1.0));
  float flick = 0.84 + 0.16 * sin(t * 14.0) * sin(t * 7.7);
  float halo = exp(-length((p - vec2(0.5, 0.22)) * vec2(1.6, 1.1)) * 5.0) * 0.16 * flick;
  vec3 outc = (col * body * flick) * 0.33 + vec3(1.0, 0.36, 0.08) * halo;
  float a = clamp(max(body, halo), 0.0, 1.0) * clamp(bright, 0.0, 1.0);
  if (a < 0.01) discard;
  gl_FragColor = vec4(outc, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export const EMBER_VERTEX = /* glsl */ `
attribute vec4 aSeed;
attribute float aAmp;
uniform float uTime;
uniform float uScale;
varying float vA;
void main() {
  if (aAmp < 0.004) {
    vA = 0.0;
    gl_PointSize = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float life = fract(uTime * (0.45 + aSeed.z * 0.55) + aSeed.w * 17.3);
  vec3 p = position;
  p.x += aSeed.x * life * 0.9 + sin(uTime * 2.3 + aSeed.w * 40.0) * 0.3 * life;
  p.z += aSeed.y * life * 0.9 + cos(uTime * 1.9 + aSeed.w * 23.0) * 0.3 * life;
  p.y += life * (1.8 + aSeed.z * 2.6) * (0.5 + 0.5 * aAmp);
  vA = aAmp * (1.0 - life) * smoothstep(0.0, 0.07, life);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = 0.085 * (0.6 + aSeed.z * 0.8) * uScale / max(0.2, -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

export const EMBER_FRAGMENT = /* glsl */ `
varying float vA;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = vA * (1.0 - smoothstep(0.2, 1.0, d));
  if (a < 0.01) discard;
  gl_FragColor = vec4(vec3(3.2, 1.25, 0.3), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
