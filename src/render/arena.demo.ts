/**
 * WP-D demo (`?demo=arena`, BLUEPRINT §14): full stadium + FX playground.
 *
 * - Builds SceneManager + Stadium + Effects + CameraRig.
 * - A capsule dummy runs a scripted lap of the arena (WASD to take over,
 *   P resumes the scripted path), with wall/pillar/crate collision and the
 *   dais step-up so the camera pull-in can be exercised.
 * - Click the canvas for pointer lock; mouse orbits the camera.
 * - Debug keys (§14 acceptance): 1–9 trigger each effect type at the dummy,
 *   E cycles excitement 0 → 0.5 → 1, B breaks crates, T swaps camera targets
 *   (0.5 s blend), V toggles spectate auto-orbit, G re-rolls pickup icons.
 */

import * as THREE from 'three';
import { registerDemo } from '../core/demos';
import { angleDelta, clamp, wrapAngle } from '../core/math';
import { ANIMAL_IDS } from '../config/animals';
import { CRATES, DAIS, FALLEN_COLUMNS, PILLARS, WALL_RADIUS } from '../config/arena';
import { SceneManager } from './SceneManager';
import { Stadium, type PickupKind } from './Stadium';
import { CameraRig, type TargetPosFn } from './CameraRig';
import { Effects, type TelegraphKind } from './Effects';

const DUMMY_RADIUS = 0.45;
const DUMMY_SPEED = 6;
const EXCITEMENT_STEPS = [0, 0.5, 1] as const;
const TELEGRAPH_KINDS: readonly TelegraphKind[] = ['ring', 'arc', 'rect'];
const PICKUP_KINDS: readonly PickupKind[] = ['heal', 'speed', 'rage'];

/** Scripted lap waypoints (clear of §9 pillars/crates/columns). */
const PATH: readonly { x: number; z: number }[] = [
  { x: 20, z: 0 },
  { x: 14, z: 14 },
  { x: 0, z: 21 },
  { x: -14, z: 14 },
  { x: -21, z: 0 },
  { x: -13, z: -13 },
  { x: 0, z: -21 },
  { x: 14, z: -14 },
];

const HELP_HTML = `
<b>ARENA DEMO</b> — click canvas for mouse look<br>
WASD move (P: resume auto-path) &nbsp;|&nbsp; E: excitement 0/0.5/1<br>
1 swing &nbsp;2 hit &nbsp;3 blocked &nbsp;4 crit &nbsp;5 guard-break<br>
6 dust &nbsp;7 telegraph &nbsp;8 death+streamers &nbsp;9 ult flash<br>
B break crate &nbsp;|&nbsp; T swap cam target &nbsp;|&nbsp; V spectate orbit &nbsp;|&nbsp; G pickups
`;

function ensureCanvas(): HTMLCanvasElement {
  const existing = document.getElementById('gk-canvas');
  if (existing instanceof HTMLCanvasElement) return existing;
  const canvas = document.createElement('canvas');
  canvas.id = 'gk-canvas';
  document.body.insertBefore(canvas, document.body.firstChild);
  return canvas;
}

function buildDummy(): THREE.Group {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x7d8aa0, flatShading: true, roughness: 0.85 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(DUMMY_RADIUS, 1.0, 3, 10), mat);
  body.position.y = 0.98;
  body.castShadow = true;
  group.add(body);
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.3), mat);
  nose.position.set(0, 1.45, DUMMY_RADIUS + 0.1);
  group.add(nose);
  return group;
}

// Scratch (no per-frame allocation).
const _move = new THREE.Vector3();

function runArena(root: HTMLElement): () => void {
  const canvas = ensureCanvas();
  const sm = new SceneManager(canvas);
  const stadium = new Stadium();
  sm.scene.add(stadium.root);
  const fx = new Effects(sm.scene, { fovDeg: sm.camera.fov });
  const rig = new CameraRig(sm.camera);
  rig.shakeSource = () => fx.getShakeOffset();
  rig.yaw = Math.PI;

  const dummy = buildDummy();
  dummy.position.set(PATH[0].x, 0, PATH[0].z);
  sm.scene.add(dummy);

  // Initial pickup icons: one of each kind around the ring.
  for (let i = 0; i < 6; i++) stadium.setPickupVisible(i, PICKUP_KINDS[i % 3], true);

  const dummyTarget: TargetPosFn = (out) => out.copy(dummy.position);
  const daisTarget: TargetPosFn = (out) => out.set(DAIS.x, DAIS.height, DAIS.z);
  rig.follow(dummyTarget, 1.5);
  rig.snap();

  // ── Overlay (help + live stats) ────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:absolute;top:12px;left:12px;padding:10px 14px;font:12px/1.6 monospace;' +
    'color:#ece3d0;background:rgba(20,17,13,.72);border:1px solid rgba(217,164,65,.4);' +
    'border-radius:6px;pointer-events:none;z-index:10;white-space:nowrap';
  const help = document.createElement('div');
  help.innerHTML = HELP_HTML;
  const stats = document.createElement('div');
  stats.style.marginTop = '6px';
  stats.style.color = '#d9a441';
  overlay.append(help, stats);
  root.appendChild(overlay);

  // ── Input ──────────────────────────────────────────────────────────────────
  let locked = false;
  const held = { w: false, a: false, s: false, d: false };
  let manual = false;
  let waypoint = 1;
  let excitementIdx = 0;
  let telegraphIdx = 0;
  let telegraphFriendly = true;
  let swingFriendly = true;
  let ultIdx = 0;
  let crateIdx = 0;
  let camOnDummy = true;
  let pickupRoll = 0;

  const onClick = (): void => {
    if (!locked) canvas.requestPointerLock();
  };
  const onLockChange = (): void => {
    locked = document.pointerLockElement === canvas;
  };
  const onMouseMove = (e: MouseEvent): void => {
    if (locked) rig.applyMouseDelta(e.movementX, e.movementY);
  };

  const triggerEffect = (code: string): boolean => {
    const p = dummy.position;
    const at = { x: p.x, y: p.y, z: p.z };
    switch (code) {
      case 'Digit1':
        fx.onSwing(at, dummy.rotation.y, 2.6, 120, swingFriendly);
        swingFriendly = !swingFriendly;
        return true;
      case 'Digit2':
        fx.onHit(at, 60 + Math.floor(Math.random() * 45));
        return true;
      case 'Digit3':
        fx.onHit(at, 18 + Math.floor(Math.random() * 20), { blocked: true });
        return true;
      case 'Digit4':
        fx.onHit(at, 110 + Math.floor(Math.random() * 90), { crit: true });
        return true;
      case 'Digit5':
        fx.onGuardBreak(at);
        return true;
      case 'Digit6':
        fx.onDust(at, 1.3);
        return true;
      case 'Digit7': {
        const kind = TELEGRAPH_KINDS[telegraphIdx % TELEGRAPH_KINDS.length];
        telegraphIdx++;
        const radius = kind === 'rect' ? 10 : 4;
        fx.telegraph(kind, at, radius, dummy.rotation.y, 120, 0.9, telegraphFriendly);
        telegraphFriendly = !telegraphFriendly;
        return true;
      }
      case 'Digit8':
        fx.onDeath(at, 0xc8402f);
        return true;
      case 'Digit9': {
        const animal = ANIMAL_IDS[ultIdx % ANIMAL_IDS.length];
        ultIdx++;
        fx.onUltimate(at, animal);
        return true;
      }
      default:
        return false;
    }
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    if (triggerEffect(e.code)) return;
    switch (e.code) {
      case 'KeyW': held.w = true; manual = true; break;
      case 'KeyA': held.a = true; manual = true; break;
      case 'KeyS': held.s = true; manual = true; break;
      case 'KeyD': held.d = true; manual = true; break;
      case 'KeyP': manual = false; break;
      case 'KeyE':
        excitementIdx = (excitementIdx + 1) % EXCITEMENT_STEPS.length;
        sm.excitement = EXCITEMENT_STEPS[excitementIdx];
        break;
      case 'KeyB':
        if (crateIdx >= CRATES.length) {
          stadium.resetCrates();
          crateIdx = 0;
        } else {
          const c = CRATES[crateIdx];
          stadium.breakCrate(crateIdx);
          fx.onDust({ x: c.x, y: 0.4, z: c.z }, 1.4);
          crateIdx++;
        }
        break;
      case 'KeyT':
        camOnDummy = !camOnDummy;
        rig.follow(camOnDummy ? dummyTarget : daisTarget, camOnDummy ? 1.5 : 1.2);
        break;
      case 'KeyV':
        rig.setSpectate(!rig.isSpectate);
        break;
      case 'KeyG':
        pickupRoll++;
        for (let i = 0; i < 6; i++) {
          stadium.setPickupVisible(i, PICKUP_KINDS[(i + pickupRoll) % 3], (i + pickupRoll) % 4 !== 0);
        }
        break;
      default:
        break;
    }
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    switch (e.code) {
      case 'KeyW': held.w = false; break;
      case 'KeyA': held.a = false; break;
      case 'KeyS': held.s = false; break;
      case 'KeyD': held.d = false; break;
      default: break;
    }
  };

  canvas.addEventListener('click', onClick);
  document.addEventListener('pointerlockchange', onLockChange);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  // ── Dummy movement + demo-grade collision (§9 shapes from config) ──────────
  const moveDummy = (dt: number): void => {
    const p = dummy.position;
    _move.set(0, 0, 0);
    if (manual) {
      const f = (held.w ? 1 : 0) - (held.s ? 1 : 0);
      const r = (held.d ? 1 : 0) - (held.a ? 1 : 0);
      if (f !== 0 || r !== 0) {
        const sin = Math.sin(rig.yaw);
        const cos = Math.cos(rig.yaw);
        _move.set(sin * f + cos * r, 0, cos * f - sin * r).normalize();
      }
    } else {
      const wp = PATH[waypoint];
      const dx = wp.x - p.x;
      const dz = wp.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d < 1) waypoint = (waypoint + 1) % PATH.length;
      else _move.set(dx / d, 0, dz / d);
    }

    if (_move.lengthSq() > 0) {
      p.x += _move.x * DUMMY_SPEED * dt;
      p.z += _move.z * DUMMY_SPEED * dt;
      const targetYaw = Math.atan2(_move.x, _move.z);
      const delta = angleDelta(dummy.rotation.y, targetYaw);
      dummy.rotation.y = wrapAngle(dummy.rotation.y + clamp(delta, -8 * dt, 8 * dt));
      if (Math.random() < dt * 6) fx.onDust({ x: p.x, y: 0, z: p.z }, 0.35);
    }

    // Wall clamp.
    const r = Math.hypot(p.x, p.z);
    const maxR = WALL_RADIUS - DUMMY_RADIUS - 0.15;
    if (r > maxR) {
      p.x *= maxR / r;
      p.z *= maxR / r;
    }
    // Pillar push-out.
    for (const pil of PILLARS) {
      const dx = p.x - pil.x;
      const dz = p.z - pil.z;
      const d = Math.hypot(dx, dz);
      const min = pil.radius + DUMMY_RADIUS;
      if (d > 1e-5 && d < min) {
        p.x = pil.x + (dx / d) * min;
        p.z = pil.z + (dz / d) * min;
      }
    }
    // Live crates as circles.
    for (let i = 0; i < CRATES.length; i++) {
      if (!stadium.isCrateAlive(i)) continue;
      const c = CRATES[i];
      const dx = p.x - c.x;
      const dz = p.z - c.z;
      const d = Math.hypot(dx, dz);
      const min = c.halfX + 0.2 + DUMMY_RADIUS;
      if (d > 1e-5 && d < min) {
        p.x = c.x + (dx / d) * min;
        p.z = c.z + (dz / d) * min;
      }
    }
    // Fallen columns: point-vs-segment push-out.
    for (const seg of FALLEN_COLUMNS) {
      const ex = seg.bx - seg.ax;
      const ez = seg.bz - seg.az;
      const len2 = ex * ex + ez * ez;
      const t = clamp(((p.x - seg.ax) * ex + (p.z - seg.az) * ez) / len2, 0, 1);
      const cx = seg.ax + ex * t;
      const cz = seg.az + ez * t;
      const dx = p.x - cx;
      const dz = p.z - cz;
      const d = Math.hypot(dx, dz);
      const min = seg.thickness / 2 + DUMMY_RADIUS;
      if (d > 1e-5 && d < min) {
        p.x = cx + (dx / d) * min;
        p.z = cz + (dz / d) * min;
      }
    }
    // Dais step-up (walkable, §9).
    const rNow = Math.hypot(p.x, p.z);
    const targetY = rNow < DAIS.radius - 0.1 ? DAIS.height : 0;
    p.y += clamp(targetY - p.y, -4 * dt, 4 * dt);
  };

  // ── Main loop ──────────────────────────────────────────────────────────────
  let raf = 0;
  let prev = performance.now();
  let fpsAcc = 0;
  let fpsFrames = 0;
  let statTimer = 0;

  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - prev) / 1000);
    prev = now;

    moveDummy(dt);
    stadium.update(dt, sm.excitement);
    fx.update(dt);
    rig.update(dt);
    sm.render();

    fpsAcc += dt;
    fpsFrames++;
    statTimer += dt;
    if (statTimer >= 0.5) {
      const fps = fpsFrames / Math.max(1e-6, fpsAcc);
      const s = sm.getStats();
      stats.textContent =
        `fps ${fps.toFixed(0)} | draw calls ${s.drawCalls} | tris ${(s.triangles / 1000).toFixed(1)}k` +
        ` | particles ${fx.liveParticles} | crowd ${stadium.crowdCount} | excitement ${sm.excitement}`;
      fpsAcc = 0;
      fpsFrames = 0;
      statTimer = 0;
    }
  };
  raf = requestAnimationFrame(frame);

  // Kick a little ambience so the arena doesn't look frozen on load.
  fx.telegraph('ring', { x: 0, y: 0, z: 0 }, DAIS.radius + 1, 0, 360, 1.4, true);

  return () => {
    cancelAnimationFrame(raf);
    canvas.removeEventListener('click', onClick);
    document.removeEventListener('pointerlockchange', onLockChange);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    overlay.remove();
    fx.dispose();
    stadium.dispose();
    sm.dispose();
  };
}

registerDemo('arena', (root) => runArena(root));
