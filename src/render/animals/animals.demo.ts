/**
 * `?demo=animals` (BLUEPRINT §14 WP-E acceptance): all 10 rigs in a row on a
 * simple self-built ground/light scene (deliberately NOT the WP-D SceneManager).
 *
 *   1..0        select animal            Q/W/E  attack1/2/3
 *   R special   T ultimate   Y block(t)  U hit   I stagger   O knockdown
 *   P death(t)  J jump       G glide(t)  B burrow(t)  F feared  Z grab  X grabbed
 *   A auto-cycle everything  ·  Arrow keys move the selected animal (run gait)
 */

import * as THREE from 'three';
import { registerDemo } from '../../core/demos';
import { ANIMALS, ANIMAL_IDS, type AnimalDef } from '../../config/animals';
import type { FighterAction, FighterState } from '../../core/types';
import { AnimalFactory } from './AnimalFactory';
import { makeMockState, type BaseRig } from './Animator';

interface Actor {
  def: AnimalDef;
  rig: BaseRig;
  state: FighterState;
  home: { x: number; z: number };
  autoIdx: number;
}

const AUTO_SEQ: readonly FighterAction[] = [
  'idle', 'run', 'attack1', 'attack2', 'attack3', 'special', 'ultimate', 'block',
  'hit', 'stagger', 'knockdown', 'feared', 'jump', 'glide', 'burrowed', 'grab',
  'grabbed', 'dead',
];

/** Demo-side action durations (the real sim owns these in a match). */
function actionDur(def: AnimalDef, a: FighterAction): number {
  switch (a) {
    case 'attack1':
    case 'attack2':
    case 'attack3':
      return 1 / def.attackRate;
    case 'special': {
      const s = def.special;
      const active = s.duration ?? s.maxTime
        ?? (s.range !== undefined && s.moveSpeed !== undefined ? s.range / s.moveSpeed : 0.65);
      return s.windup + Math.min(active, 1.2);
    }
    case 'ultimate': {
      const u = def.ultimate;
      const active = u.duration ?? (u.untargetableT !== undefined ? u.untargetableT + 0.8 : 1.2);
      return u.windup + Math.min(active, 2.6);
    }
    case 'hit':
      return 0.15;
    case 'stagger':
      return 0.5;
    case 'knockdown':
      return 1.1;
    case 'feared':
      return 1.6;
    case 'jump':
      return 0.7;
    case 'grab':
    case 'grabbed':
      return 2.2;
    case 'block':
    case 'glide':
    case 'burrowed':
    case 'dead':
      return 1.8; // used by auto-cycle only; manual toggles hold indefinitely
    default:
      return 0;
  }
}

function setAction(actor: Actor, a: FighterAction): void {
  const s = actor.state;
  s.action = a;
  s.actionT = 0;
  s.actionDur = actionDur(actor.def, a);
  s.buffs.length = 0;
  s.airborne = a === 'jump' || a === 'glide';
  s.glideT = a === 'glide' ? 2.5 : 0;
  s.burrowT = 0;
  if (a === 'glide') s.pos.y = 1.6;
  else if (a !== 'jump') s.pos.y = 0;
  if (a === 'ultimate' && s.animal === 'panther') {
    s.buffs.push({ kind: 'stealth', t: 0, dur: 5, mag: 0 });
  }
}

registerDemo('animals', (root: HTMLElement) => {
  // ── Renderer / scene (self-contained; not WP-D's) ──────────────────────────
  const existing = document.getElementById('gk-canvas');
  const canvas = existing instanceof HTMLCanvasElement ? existing : document.createElement('canvas');
  if (!canvas.isConnected) document.body.insertBefore(canvas, document.body.firstChild);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x2b2320);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x2b2320, 40, 90);
  scene.add(new THREE.HemisphereLight(0xffe8c0, 0x6b5a3e, 0.9));
  const sun = new THREE.DirectionalLight(0xffe0b0, 1.9);
  sun.position.set(10, 16, 8);
  scene.add(sun);

  const groundMat = new THREE.MeshStandardMaterial({ color: 0xc2a46b, roughness: 1, flatShading: true });
  const ground = new THREE.Mesh(new THREE.CircleGeometry(32, 40), groundMat);
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  const ringMat = new THREE.MeshStandardMaterial({ color: 0xa8895a, roughness: 1 });
  const ring = new THREE.Mesh(new THREE.RingGeometry(29.2, 30, 40), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.01;
  scene.add(ring);

  // Selection marker.
  const markMat = new THREE.MeshBasicMaterial({ color: 0xd9b24a });
  const marker = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.045, 6, 24), markMat);
  marker.rotation.x = -Math.PI / 2;
  marker.position.y = 0.03;
  scene.add(marker);

  // ── Actors: all ten in a row ───────────────────────────────────────────────
  const actors: Actor[] = ANIMAL_IDS.map((id, i) => {
    const rig = AnimalFactory.createRig(id);
    const state = makeMockState(id);
    const home = { x: -13.5 + i * 3, z: 0 };
    state.pos.x = home.x;
    state.pos.z = home.z;
    scene.add(rig.root);
    return { def: ANIMALS[id], rig, state, home, autoIdx: 0 };
  });
  let selected = 0;
  let auto = false;

  // ── Camera with a minimal drag-orbit ───────────────────────────────────────
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
  const camTarget = new THREE.Vector3(0, 1.3, 0);
  let camYaw = 0;
  let camPitch = 0.34;
  let camDist = 21;
  let dragging = false;
  const applyCamera = (): void => {
    camera.position.set(
      camTarget.x + Math.sin(camYaw) * Math.cos(camPitch) * camDist,
      camTarget.y + Math.sin(camPitch) * camDist,
      camTarget.z + Math.cos(camYaw) * Math.cos(camPitch) * camDist,
    );
    camera.lookAt(camTarget);
  };
  const onPointerDown = (e: PointerEvent): void => {
    if (e.target === canvas) dragging = true;
  };
  const onPointerUp = (): void => {
    dragging = false;
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (!dragging) return;
    camYaw -= e.movementX * 0.005;
    camPitch = Math.min(1.25, Math.max(0.06, camPitch + e.movementY * 0.004));
  };
  const onWheel = (e: WheelEvent): void => {
    camDist = Math.min(45, Math.max(5, camDist * (1 + e.deltaY * 0.001)));
  };
  window.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('wheel', onWheel, { passive: true });

  // ── Overlay ────────────────────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;top:12px;left:12px;z-index:10;color:#f3e6c8;font:13px/1.5 monospace;' +
    'background:rgba(20,14,10,.72);padding:10px 14px;border-radius:8px;pointer-events:none;' +
    'white-space:pre;max-width:92vw';
  root.appendChild(overlay);
  let fps = 0;
  let fpsFrames = 0;
  let fpsTime = 0;
  const refreshOverlay = (): void => {
    const a = actors[selected];
    const names = ANIMAL_IDS.map((id, i) => (i === selected ? `[${id.toUpperCase()}]` : id)).join(' ');
    overlay.textContent =
      `ANIMALS DEMO   ${fps.toFixed(0)} fps   auto-cycle: ${auto ? 'ON (A)' : 'off (A)'}\n` +
      `${names}\n` +
      `selected: ${a.def.displayName.toUpperCase()} — ${a.state.action}` +
      ` (t=${a.state.actionT.toFixed(2)}/${a.state.actionDur.toFixed(2)})\n` +
      `1..0 select · Q/W/E atk1/2/3 · R special · T ult · Y block · U hit · I stagger\n` +
      `O knockdown · P death · J jump · G glide · B burrow · F feared · Z grab · X grabbed\n` +
      `arrows move · drag orbit · wheel zoom`;
  };

  // ── Input ──────────────────────────────────────────────────────────────────
  const held = new Set<string>();
  const toggling: FighterAction[] = ['block', 'glide', 'burrowed', 'dead'];
  const trigger = (a: FighterAction): void => {
    const actor = actors[selected];
    if (toggling.includes(a) && actor.state.action === a) setAction(actor, 'idle');
    else setAction(actor, a);
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    held.add(e.code);
    if (e.key >= '1' && e.key <= '9') selected = Number(e.key) - 1;
    else if (e.key === '0') selected = 9;
    else {
      switch (e.code) {
        case 'KeyQ': trigger('attack1'); break;
        case 'KeyW': trigger('attack2'); break;
        case 'KeyE': trigger('attack3'); break;
        case 'KeyR': trigger('special'); break;
        case 'KeyT': trigger('ultimate'); break;
        case 'KeyY': trigger('block'); break;
        case 'KeyU': trigger('hit'); break;
        case 'KeyI': trigger('stagger'); break;
        case 'KeyO': trigger('knockdown'); break;
        case 'KeyP': trigger('dead'); break;
        case 'KeyJ': trigger('jump'); break;
        case 'KeyG': trigger('glide'); break;
        case 'KeyB': trigger('burrowed'); break;
        case 'KeyF': trigger('feared'); break;
        case 'KeyZ': trigger('grab'); break;
        case 'KeyX': trigger('grabbed'); break;
        case 'KeyA':
          auto = !auto;
          if (!auto) for (const ac of actors) setAction(ac, 'idle');
          break;
      }
    }
  };
  const onKeyUp = (e: KeyboardEvent): void => held.delete(e.code) as unknown as void;
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  // ── Frame loop ─────────────────────────────────────────────────────────────
  let raf = 0;
  let last = performance.now();
  let lastW = 0;
  let lastH = 0;
  let overlayT = 0;

  const step = (actor: Actor, dt: number, isSelected: boolean): void => {
    const s = actor.state;
    s.actionT += dt;
    s.vel.x = 0;
    s.vel.z = 0;

    // Auto-cycle advances each actor independently through everything.
    if (auto && s.actionT >= s.actionDur + 0.35) {
      actor.autoIdx = (actor.autoIdx + 1) % AUTO_SEQ.length;
      setAction(actor, AUTO_SEQ[actor.autoIdx]);
      if (s.actionDur === 0) s.actionDur = 1.4; // idle/run showcase length
    }

    // Synthetic locomotion for showcase actions.
    if (s.action === 'run' || s.action === 'feared') {
      s.vel.z = actor.def.speed; // treadmill gait
    }

    // Arrow-key movement drives the selected animal for real.
    if (isSelected && !auto && s.action !== 'dead') {
      let dx = 0;
      let dz = 0;
      if (held.has('ArrowLeft')) dx -= 1;
      if (held.has('ArrowRight')) dx += 1;
      if (held.has('ArrowUp')) dz -= 1;
      if (held.has('ArrowDown')) dz += 1;
      const moving = dx !== 0 || dz !== 0;
      if (moving) {
        const inv = 1 / Math.hypot(dx, dz);
        const spd = actor.def.speed * (s.action === 'burrowed' ? 1.3 : 1);
        s.vel.x = dx * inv * spd;
        s.vel.z = dz * inv * spd;
        s.pos.x = Math.max(-15, Math.min(15, s.pos.x + s.vel.x * dt));
        s.pos.z = Math.max(-9, Math.min(9, s.pos.z + s.vel.z * dt));
        s.yaw = Math.atan2(s.vel.x, s.vel.z);
        if (s.action === 'idle') setAction(actor, 'run');
      } else if (s.action === 'run') {
        setAction(actor, 'idle');
      }
    }

    // Jump ballistics (§4: v=7, g=20).
    if (s.action === 'jump') {
      const t = s.actionT;
      s.pos.y = Math.max(0, 7 * t - 10 * t * t);
      s.vel.y = 7 - 20 * t;
      if (t >= 0.7) setAction(actor, 'idle');
    } else if (s.action !== 'glide') {
      s.vel.y = 0;
    }

    // Timed actions revert to idle (block/glide/burrowed/dead are toggles).
    if (!auto && s.actionDur > 0 && s.actionT >= s.actionDur && !toggling.includes(s.action)) {
      setAction(actor, 'idle');
    }

    // The caller owns root pos/yaw (§5.1); the rig animates the body.
    actor.rig.root.position.set(s.pos.x, s.pos.y, s.pos.z);
    actor.rig.root.rotation.y = s.yaw;
    actor.rig.update(s, dt);
  };

  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    fpsFrames++;
    fpsTime += dt;
    if (fpsTime >= 0.5) {
      fps = fpsFrames / fpsTime;
      fpsFrames = 0;
      fpsTime = 0;
    }

    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w !== lastW || h !== lastH) {
      lastW = w;
      lastH = h;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }

    for (let i = 0; i < actors.length; i++) step(actors[i], dt, i === selected);

    const sel = actors[selected].state;
    marker.position.set(sel.pos.x, 0.03, sel.pos.z);
    marker.scale.setScalar(actors[selected].def.radius * 1.5);

    applyCamera();
    overlayT += dt;
    if (overlayT >= 0.2) {
      overlayT = 0;
      refreshOverlay();
    }
    renderer.render(scene, camera);
  };
  refreshOverlay();
  raf = requestAnimationFrame(frame);

  // ── Teardown ───────────────────────────────────────────────────────────────
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('wheel', onWheel);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    overlay.remove();
    for (const a of actors) a.rig.dispose();
    ground.geometry.dispose();
    groundMat.dispose();
    ring.geometry.dispose();
    ringMat.dispose();
    marker.geometry.dispose();
    markMat.dispose();
    renderer.dispose();
  };
});
