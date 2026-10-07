/**
 * `?demo=animals` (BLUEPRINT §14 WP-E acceptance): all 10 rigs in a row on a
 * simple self-built ground/light scene (deliberately NOT the WP-D SceneManager).
 *
 *   1..0        select animal            Q/W/E  attack1/2/3
 *   R special   T ultimate   Y block(t)  U hit   I stagger   O knockdown
 *   P death(t)  J jump       G glide(t)  H soar  B burrow(t)  F feared  Z grab  X grabbed
 *   A auto-cycle everything  ·  Arrow keys move the selected animal (run gait)
 *   K pool on/off (QA water plane at the waterline; ALL animals wade)   L the selected animal in/out of the water
 *   (v1.8 WP-J4 swim animations: `?demo=animals&water=1` starts in the pool; the real water is the jungle scene's)
 */

import * as THREE from 'three';
import { registerDemo } from '../../core/demos';
import { ANIMALS, ANIMAL_IDS, type AnimalDef } from '../../config/animals';
import type { FighterAction, FighterState } from '../../core/types';
import { AnimalFactory } from './AnimalFactory';
import { makeMockState, type BaseRig } from './Animator';
import { WATER_DEPTH } from './swim';
import { waterSpeedMultiplier } from '../../config/terrain';

interface Actor {
  def: AnimalDef;
  rig: BaseRig;
  state: FighterState;
  home: { x: number; z: number };
  autoIdx: number;
  /** v1.8: standing in the (QA) pool — drives `FighterState.inWater`. */
  water: boolean;
}

/** Contact-sheet cell (see `__gkAnimals.sheet`). */
interface SheetCell {
  /** Animal index (0..9, roster order) — default: the sheet's animal, so one sheet can mix animals. */
  i?: number;
  a: FighterAction;
  /** Action progress 0..1 (default 0.5). */
  u?: number;
  /** Treadmill speed (m/s); default: run → the animal's speed (water speed in the pool). */
  speed?: number;
  /** In the pool? default: the actor's current flag. */
  water?: boolean;
  /** Camera yaw (rad; π/2 = the animal's side) and pitch (rad) for this cell. */
  yaw?: number;
  pitch?: number;
  /** Camera distance multiplier (default 1). */
  zoom?: number;
  /** Label painted on the sheet. */
  label?: string;
}

/** Rough top-of-body height per animal for framing the QA cameras (m). */
const FRAME_H: Record<string, number> = {
  lion: 1.8, gorilla: 1.75, crocodile: 0.9, hippo: 1.6, rhino: 1.6, eagle: 1.3, panther: 1.35, python: 2.2, giraffe: 4.1, mole: 0.8,
};

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

/**
 * Scripted v1.2 soar for QA (mirrors the sim's shape, not its numbers):
 * glide entry → level glide → climb at ≈4 m/s to 6.5 m → hover with a banking
 * sideslip → released: accelerating fall → touchdown.
 */
function soarProfile(t: number): { y: number; vy: number; vx: number; vz: number; done: boolean } {
  const glideV = 6;
  if (t < 0.9) return { y: 1.6, vy: 0, vx: 0, vz: glideV, done: false };
  if (t < 2.125) return { y: 1.6 + 4 * (t - 0.9), vy: 4, vx: 0, vz: glideV, done: false };
  if (t < 3.6) {
    const bank = Math.sin((t - 2.125) * 2.4) * 4;
    return { y: 6.5, vy: 0, vx: bank, vz: glideV, done: false };
  }
  const f = t - 3.6;
  const y = 6.5 - 7 * f * f;
  if (y <= 0) return { y: 0, vy: 0, vx: 0, vz: 0, done: true };
  return { y, vy: -14 * f, vx: 0, vz: glideV * 0.6, done: false };
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
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x2b2320, 40, 90);
  scene.add(new THREE.HemisphereLight(0xffe6bf, 0x6e5536, 1.2));
  const sun = new THREE.DirectionalLight(0xffd9a8, 2.35);
  sun.position.set(10, 16, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -18;
  sun.shadow.camera.right = 18;
  sun.shadow.camera.top = 12;
  sun.shadow.camera.bottom = -12;
  sun.shadow.normalBias = 0.05;
  scene.add(sun);

  const groundMat = new THREE.MeshStandardMaterial({ color: 0xc2a46b, roughness: 1, flatShading: true });
  const ground = new THREE.Mesh(new THREE.CircleGeometry(32, 40), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
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

  // ── QA pool (v1.8): a translucent plane at the waterline over an opaque bed WATER_DEPTH lower (NOT the jungle scene's water) ──
  const bedMat = new THREE.MeshStandardMaterial({ color: 0x6a5a3a, roughness: 1, flatShading: true });
  const bed = new THREE.Mesh(new THREE.CircleGeometry(32, 40), bedMat);
  bed.rotation.x = -Math.PI / 2;
  bed.position.y = -WATER_DEPTH;
  bed.receiveShadow = true;
  bed.visible = false;
  scene.add(bed);
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x2a86c4, transparent: true, opacity: 0.58, roughness: 0.15, metalness: 0, side: THREE.DoubleSide, depthWrite: false,
  });
  const water = new THREE.Mesh(new THREE.CircleGeometry(32, 40), waterMat);
  water.rotation.x = -Math.PI / 2;
  water.visible = false;
  scene.add(water);
  const grid = new THREE.GridHelper(64, 64, 0x6f5f3a, 0x7f6f48);
  grid.position.y = -WATER_DEPTH + 0.01;
  grid.visible = false;
  scene.add(grid);
  // A 0.25 m ruler (white / blue bands) standing on the bed beside the selected animal: reads the waterline at a glance.
  const rulerMat = [new THREE.MeshBasicMaterial({ color: 0xf2f2f2 }), new THREE.MeshBasicMaterial({ color: 0x2255aa })];
  const ruler = new THREE.Group();
  for (let k = 0; k < 8; k++) {
    const seg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.25, 0.06), rulerMat[k % 2]);
    seg.position.y = -WATER_DEPTH + 0.125 + k * 0.25;
    ruler.add(seg);
  }
  ruler.visible = false;
  scene.add(ruler);
  let pool = false;
  const setPool = (on: boolean): void => {
    pool = on;
    bed.visible = on;
    water.visible = on;
    grid.visible = on;
    ruler.visible = on;
    ground.visible = !on;
    ring.visible = !on;
    for (const a of actors) a.water = on;
  };

  // ── Actors: all ten in a row ───────────────────────────────────────────────
  const actors: Actor[] = ANIMAL_IDS.map((id, i) => {
    const rig = AnimalFactory.createRig(id);
    const state = makeMockState(id);
    const home = { x: -13.5 + i * 3, z: 0 };
    state.pos.x = home.x;
    state.pos.z = home.z;
    scene.add(rig.root);
    return { def: ANIMALS[id], rig, state, home, autoIdx: 0, water: false };
  });
  let selected = 0;
  let auto = false;
  let focus = false;
  let frozen = false;
  if (new URLSearchParams(window.location.search).get('water') === '1') setPool(true);

  // ── Camera with a minimal drag-orbit ───────────────────────────────────────
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
  const camTarget = new THREE.Vector3(0, 1.3, 0);
  let camYaw = 0;
  let camPitch = 0.34;
  let camDist = 21;
  let dragging = false;
  let pinned: { y: number; vy: number; vz: number } | null = null;
  let soarT = -1;
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

  let lastW = 0;
  let lastH = 0;
  /** Keep the renderer / camera matched to the window (the loop may be frozen / stubbed in QA, so hooks call this too). */
  const fitSize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w === lastW && h === lastH) return;
    lastW = w;
    lastH = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const placeMarkers = (): void => {
    const sel = actors[selected];
    marker.position.set(sel.state.pos.x, 0.03, sel.state.pos.z);
    marker.scale.setScalar(sel.def.radius * 1.5);
    ruler.position.set(sel.state.pos.x + sel.def.radius * 1.5 + 0.35, 0, sel.state.pos.z);
  };

  /** Pose one actor for a contact-sheet cell: set the action, hold its progress `u`, settle 12 x 50 ms (as the fp sheet does). */
  const poseCell = (actor: Actor, c: SheetCell): void => {
    const s = actor.state;
    actor.water = c.water ?? actor.water;
    setAction(actor, c.a);
    const dur = s.actionDur;
    const u = c.u ?? 0.5;
    s.vel.x = 0;
    s.vel.z = c.speed ?? (c.a === 'run' || c.a === 'feared' ? topSpeed(actor) : 0);
    for (let k = 0; k < 12; k++) {
      s.actionT = u * dur;
      s.inWater = actor.water;
      actor.rig.root.position.set(s.pos.x, s.pos.y, s.pos.z);
      actor.rig.root.rotation.y = s.yaw;
      actor.rig.update(s, 0.05);
    }
  };

  // Debug/verification hook: frame one animal up close, read tri counts.
  const hook = {
    focus: (i: number, dist = 4.2, yaw = 0.6, pitch = 0.2): void => {
      selected = Math.max(0, Math.min(actors.length - 1, i));
      focus = true;
      camDist = dist;
      camYaw = yaw;
      camPitch = pitch;
    },
    overview: (): void => {
      focus = false;
      camTarget.set(0, 1.3, 0);
      camDist = 21;
      camYaw = 0;
      camPitch = 0.34;
    },
    action: (a: FighterAction): void => trigger(a),
    /**
     * Pin the selected actor's altitude / vertical speed (e.g. glide poses:
     * `fly(6.2, 0)` hover, `fly(3, 3.5)` climb, `fly(4, -8)` dive). Pass
     * `null` to release. Also `fly(y, vy, vx)` to add horizontal speed.
     */
    fly: (y: number | null, vy = 0, vz = 0): void => {
      pinned = y === null ? null : { y, vy, vz };
    },
    /** Scripted eagle soar: jump → glide → climb → hover/bank → dive → flare. */
    soar: (): void => {
      pinned = null;
      soarT = 0;
      setAction(actors[selected], 'glide');
    },
    tris: (): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const a of actors) out[a.def.id] = a.rig.triangleCount;
      return out;
    },
    /** v1.8: the QA pool (translucent water at the waterline over a bed 0.55 m lower) on/off; every animal wades with it. */
    water: (on: boolean): void => setPool(on),
    /** v1.8: put one animal in / out of the water (drives `FighterState.inWater`). */
    swim: (i: number, on: boolean): void => {
      actors[i].water = on;
    },
    /** Freeze / resume the per-frame simulation of the demo (the loop keeps rendering). */
    freeze: (on = true): void => {
      frozen = on;
      if (!on) hook.unsheet();
    },
    /** Manual step (use with `window.requestAnimationFrame = () => 0`): advance every actor by `dt` and draw. */
    tick: (dt = 1 / 60, n = 1): void => {
      for (let k = 0; k < n; k++) for (let i = 0; i < actors.length; i++) step(actors[i], dt, i === selected);
      hook.render();
    },
    render: (): void => {
      fitSize();
      placeMarkers();
      const sel = actors[selected];
      if (focus) camTarget.set(sel.state.pos.x, 0.9 + sel.state.pos.y, sel.state.pos.z);
      applyCamera();
      renderer.render(scene, camera);
    },
    /**
     * Contact sheet of ONE animal: each cell poses it (action at progress u, treadmill speed, in/out of the water — 12 settling
     * updates, exactly as in a match) and frames it from `yaw` / `pitch`; painted in a grid over the whole window (an <img>, so a
     * screenshot never depends on the WebGL back buffer) with the labels. \`unsheet()\` / \`freeze(false)\` removes it.
     */
    sheet: (i: number, cells: SheetCell[], cols = 4): { cw: number; ch: number } => {
      selected = Math.max(0, Math.min(actors.length - 1, i));
      frozen = true;
      hook.unsheet();
      fitSize();
      placeMarkers();
      const keepWater = actors.map((a) => a.water);
      const W = window.innerWidth;
      const H = window.innerHeight;
      const rows = Math.ceil(cells.length / cols);
      const cw = Math.floor(W / cols);
      const ch = Math.floor(H / rows);
      const keep = { yaw: camYaw, pitch: camPitch, dist: camDist, aspect: camera.aspect };
      renderer.setViewport(0, 0, W, H);
      renderer.setScissorTest(false);
      renderer.setRenderTarget(null);
      renderer.clear();
      renderer.setScissorTest(true);
      cells.forEach((c, k) => {
        const actor = actors[c.i ?? selected];
        for (const o of actors) o.rig.root.visible = o === actor;
        const hgt = FRAME_H[actor.def.id] ?? 1.6;
        poseCell(actor, c);
        const wet = actor.water;
        camera.aspect = cw / ch;
        camera.updateProjectionMatrix();
        camTarget.set(actor.state.pos.x, hgt * 0.42 - (wet ? 0.18 : 0), actor.state.pos.z);
        camYaw = c.yaw ?? Math.PI / 2;
        camPitch = c.pitch ?? 0.12;
        camDist = (2.6 + hgt * 1.7) * (c.zoom ?? 1);
        applyCamera();
        const x = (k % cols) * cw;
        const y = H - (Math.floor(k / cols) + 1) * ch;
        renderer.setViewport(x, y, cw, ch);
        renderer.setScissor(x, y, cw, ch);
        renderer.render(scene, camera);
      });
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, W, H);
      camera.aspect = keep.aspect;
      camera.updateProjectionMatrix();
      camYaw = keep.yaw;
      camPitch = keep.pitch;
      camDist = keep.dist;
      actors.forEach((a, k) => (a.water = keepWater[k]));
      hook.solo(false);
      const img = document.createElement('img');
      img.id = 'gk-anim-sheet';
      img.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:99998;background:#000';
      img.src = renderer.domElement.toDataURL('image/jpeg', 0.9);
      document.body.appendChild(img);
      cells.forEach((c, k) => {
        const lab = document.createElement('div');
        lab.className = 'gk-anim-sheet-label';
        lab.textContent = c.label ?? `${c.a}${c.u !== undefined ? ' u=' + c.u : ''}${c.water === false ? ' (land)' : ''}`;
        lab.style.cssText =
          `position:fixed;z-index:99999;left:${(k % cols) * cw + 6}px;top:${Math.floor(k / cols) * ch + 4}px;` +
          'color:#fff;font:12px monospace;background:rgba(0,0,0,.55);padding:1px 5px;border-radius:4px';
        document.body.appendChild(lab);
      });
      return { cw, ch };
    },
    /** Show only the selected animal (the row's neighbours would block side views). */
    solo: (on: boolean): void => {
      for (let k = 0; k < actors.length; k++) actors[k].rig.root.visible = !on || k === selected;
    },
    unsheet: (): void => {
      document.getElementById('gk-anim-sheet')?.remove();
      for (const el of Array.from(document.getElementsByClassName('gk-anim-sheet-label'))) el.remove();
    },
  };
  (window as unknown as { __gkAnimals?: typeof hook }).__gkAnimals = hook;

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
      `O knockdown · P death · J jump · G glide · H soar · B burrow · F feared · Z grab · X grabbed\n` +
      `K pool ${pool ? 'ON' : 'off'} (QA water) · L selected in water: ${a.water ? 'YES' : 'no'}\n` +
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
        case 'KeyH': hook.soar(); break;
        case 'KeyB': trigger('burrowed'); break;
        case 'KeyF': trigger('feared'); break;
        case 'KeyZ': trigger('grab'); break;
        case 'KeyX': trigger('grabbed'); break;
        case 'KeyK': setPool(!pool); break;
        case 'KeyL': actors[selected].water = !actors[selected].water; break;
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
  let overlayT = 0;

  /** Top ground speed (m/s): the land speed, or the animal's WATER speed while it wades (def.speed × waterSpeedMultiplier). */
  const topSpeed = (actor: Actor): number => actor.def.speed * (actor.water ? waterSpeedMultiplier(actor.def) : 1);

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
      s.vel.z = topSpeed(actor); // treadmill gait
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
        const spd = topSpeed(actor) * (s.action === 'burrowed' ? 1.3 : 1);
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

    // Debug altitude pin / scripted soar (selected actor only).
    if (isSelected && s.action === 'glide' && soarT >= 0) {
      soarT += dt;
      const f = soarProfile(soarT);
      s.pos.y = f.y;
      s.vel.y = f.vy;
      s.vel.z = f.vz;
      s.vel.x = f.vx;
      if (f.done) {
        soarT = -1;
        setAction(actor, 'idle');
      }
    } else if (isSelected && pinned !== null && s.action === 'glide') {
      s.pos.y = pinned.y;
      s.vel.y = pinned.vy;
      s.vel.z = pinned.vz;
    }

    // Timed actions revert to idle (block/glide/burrowed/dead are toggles).
    if (!auto && s.actionDur > 0 && s.actionT >= s.actionDur && !toggling.includes(s.action)) {
      setAction(actor, 'idle');
    }

    // v1.8: the sim clears `inWater` above the grounded line (0.6 m), so a jump out of the pool ends the swim layer.
    s.inWater = actor.water && s.pos.y <= 0.6;
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

    fitSize();

    if (!frozen) for (let i = 0; i < actors.length; i++) step(actors[i], dt, i === selected);

    const sel = actors[selected].state;
    placeMarkers();

    if (focus) camTarget.set(sel.pos.x, 0.9 + sel.pos.y, sel.pos.z);
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
    bed.geometry.dispose();
    bedMat.dispose();
    water.geometry.dispose();
    waterMat.dispose();
    grid.geometry.dispose();
    for (const m of rulerMat) m.dispose();
    ruler.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    hook.unsheet();
    ringMat.dispose();
    marker.geometry.dispose();
    markMat.dispose();
    renderer.dispose();
  };
});
