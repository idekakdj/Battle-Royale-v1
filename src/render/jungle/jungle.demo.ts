/**
 * `?demo=jungle` (v1.8 WP-J3): the jungle arena QA playground.
 *
 * Builds SceneManager + the jungle `ArenaScene` (through the same `createArenaScene` entry point the match uses) + Effects +
 * CameraRig and stands the ten animal rigs in the clearing: on dry land, on moss, wading in the pool. WASD moves the selected
 * animal (1..9, 0 select), mouse look after a click, Q splashes at the player, V toggles first person, N cycles the camera
 * presets. The first click / key also starts the jungle AUDIO (ambience bed, splash / slosh / moss squelch) through a real
 * AudioEngine + EventBus wired exactly like the match controller (`bus.on('splash', e => effects.handleSplashEvent(e))`). A `window.__jungleDemo` API drives everything for screenshots / automated checks:
 *
 *   place(i, x, z, yaw?)   walk(i, ax, az, bx, bz, speed)   select(i)   splash(x, z, strength?, entering?)
 *   setTier('low'|'medium'|'high'|'auto')   preset('overview'|'chase'|'pool'|'moss'|'trunk'|'canopy'|'fp')
 *   camera(x, y, z, tx, ty, tz)  (free camera, bypasses the rig)   releaseCamera()   orbit(yaw, pitch)
 *   pause(on)   step(seconds, dt?)   stats()   cycle(n)  (create/dispose leak probe)   colosseum(on) (swap the arena scene)
 */

import * as THREE from 'three';
import { registerDemo } from '../../core/demos';
import { angleDelta, clamp, wrapAngle } from '../../core/math';
import { ANIMAL_IDS, ANIMALS } from '../../config/animals';
import type { AnimalId, FighterAction, FighterState } from '../../core/types';
import { JUNGLE_ARENA, COLOSSEUM_ARENA, type ArenaDef } from '../../config/arenas';
import { EventBus } from '../../core/EventBus';
import { AudioEngine } from '../../audio/AudioEngine';
import { SceneManager } from '../SceneManager';
import { createArenaScene, type ArenaScene } from '../arenaScene';
import { Effects } from '../Effects';
import { CameraRig, type TargetPosFn } from '../CameraRig';
import { AnimalFactory } from '../animals/AnimalFactory';
import { makeMockState, type BaseRig } from '../animals/Animator';
import { mossZoneAt, waterZoneAt } from '../arenaContext';
import { QUALITY_TIERS, type QualitySetting } from '../quality';
import type { JungleScene } from './JungleScene';

interface Actor {
  id: AnimalId;
  rig: BaseRig;
  state: FighterState;
  radius: number;
  speed: number;
  /** Scripted walk between two points (null = stand / player controlled). */
  path: { ax: number; az: number; bx: number; bz: number; speed: number; toB: boolean } | null;
  wasInWater: boolean;
}

const HELP = `<b>JUNGLE DEMO</b> — click for mouse look · WASD move · 1-9,0 pick animal · Q splash · V first person · N next camera preset<br>
<span style="opacity:.8">window.__jungleDemo: place / walk / preset / camera / setTier / step / splash / stats / cycle / colosseum</span>`;

function ensureCanvas(): HTMLCanvasElement {
  const existing = document.getElementById('gk-canvas');
  if (existing instanceof HTMLCanvasElement) return existing;
  const canvas = document.createElement('canvas');
  canvas.id = 'gk-canvas';
  document.body.insertBefore(canvas, document.body.firstChild);
  return canvas;
}

const PRESETS = ['chase', 'overview', 'pool', 'moss', 'trunk', 'canopy'] as const;

function runJungle(root: HTMLElement): () => void {
  const params = new URLSearchParams(window.location.search);
  const canvas = ensureCanvas();
  const sm = new SceneManager(canvas);
  let arena: ArenaDef = params.get('arena') === 'colosseum' ? COLOSSEUM_ARENA : JUNGLE_ARENA;
  let scene: ArenaScene = createArenaScene(sm, arena);
  const fx = new Effects(sm.scene, { fovDeg: sm.camera.fov });
  // Audio + the same splash wiring the match controller uses.
  const bus = new EventBus();
  const audio = new AudioEngine();
  audio.attachBus(bus);
  bus.on('splash', (e) => fx.handleSplashEvent(e));
  let audioOn = false;
  const startAudio = (): void => {
    if (audioOn) return;
    audioOn = true;
    void audio.resume().then(() => audio.startCrowd());
  };
  const rig = new CameraRig(sm.camera);
  rig.shakeSource = () => fx.getShakeOffset();
  rig.yaw = 0;

  // ── Actors ──
  const actors: Actor[] = ANIMAL_IDS.map((id, i): Actor => {
    const r = AnimalFactory.createRig(id);
    sm.scene.add(r.root);
    const state = makeMockState(id);
    state.id = i;
    state.isPlayer = i === 0;
    return { id, rig: r, state, radius: ANIMALS[id].radius ?? 0.6, speed: ANIMALS[id].speed ?? 5, path: null, wasInWater: false };
  });
  const SPOTS: [number, number][] = [
    [0, -19], [-13, -11], [3, 3], [-2, -2], [4.5, -3], [-5, 4], [6, 0], [-3.5, 2.5], [5.1, 8.6], [-17.9, -14.1],
  ];
  actors.forEach((a, i) => {
    const [x, z] = SPOTS[i % SPOTS.length];
    a.rig.root.position.set(x, 0, z);
    a.state.pos.x = x;
    a.state.pos.z = z;
  });
  let sel = 0;
  const playerPos = new THREE.Vector3();
  const target: TargetPosFn = (out) => out.copy(actors[sel].rig.root.position);
  const syncFollow = (): void => {
    rig.follow(target, 1.6);
  };
  syncFollow();
  rig.snap();

  // ── Overlay ──
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:absolute;top:10px;left:10px;padding:8px 12px;font:12px/1.5 monospace;color:#e6efd8;background:rgba(14,22,12,.72);' +
    'border:1px solid rgba(140,200,110,.4);border-radius:6px;pointer-events:none;z-index:10;white-space:nowrap';
  const help = document.createElement('div');
  help.innerHTML = HELP;
  const statsEl = document.createElement('div');
  statsEl.style.cssText = 'margin-top:4px;color:#b8e68a';
  overlay.append(help, statsEl);
  root.appendChild(overlay);

  // ── State ──
  let paused = false;
  let freeCam = false;
  let presetIdx = 0;
  const held = { w: false, a: false, s: false, d: false };
  let locked = false;
  const onClick = (): void => {
    startAudio();
    if (!locked) canvas.requestPointerLock();
  };
  const onLockChange = (): void => {
    locked = document.pointerLockElement === canvas;
  };
  const onMouseMove = (e: MouseEvent): void => {
    if (locked) rig.applyMouseDelta(e.movementX, e.movementY);
  };
  const doPreset = (name: string): void => {
    const p = actors[sel].rig.root.position;
    switch (name) {
      case 'overview':
        freeCam = true;
        sm.camera.position.set(0, 17, -27);
        sm.camera.lookAt(0, 0.5, 2);
        break;
      case 'pool':
        freeCam = true;
        sm.camera.position.set(-1, 3.6, -9.4);
        sm.camera.lookAt(1, 0, 0);
        break;
      case 'moss':
        freeCam = true;
        sm.camera.position.set(1.4, 4.2, 3.2);
        sm.camera.lookAt(5.1, 0, 8.6);
        break;
      case 'trunk': {
        // Player stands right behind the big tree at (-9.5, -0.3); the camera is on the other side of it.
        freeCam = false;
        actors[sel].rig.root.position.set(-13.2, 0, -0.3);
        rig.yaw = -Math.PI / 2;
        break;
      }
      case 'canopy':
        freeCam = true;
        sm.camera.position.set(0, 1.8, -12);
        sm.camera.lookAt(-8, 11, 4);
        break;
      case 'fp':
        freeCam = false;
        rig.setFirstPerson(true, true);
        break;
      default:
        freeCam = false;
        rig.setFirstPerson(false, true);
        break;
    }
    void p;
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    startAudio();
    switch (e.code) {
      case 'KeyW': held.w = true; break;
      case 'KeyA': held.a = true; break;
      case 'KeyS': held.s = true; break;
      case 'KeyD': held.d = true; break;
      case 'KeyQ': {
        const p = actors[sel].rig.root.position;
        bus.emit({ type: 'splash', fighterId: sel, pos: { x: p.x, y: 0, z: p.z }, entering: true, strength: 0.8 });
        break;
      }
      case 'KeyV': rig.setFirstPerson(!rig.isFirstPerson); break;
      case 'KeyN':
        presetIdx = (presetIdx + 1) % PRESETS.length;
        doPreset(PRESETS[presetIdx]);
        break;
      default:
        if (/^Digit[0-9]$/.test(e.code)) {
          const k = e.code === 'Digit0' ? 9 : Number(e.code.slice(5)) - 1;
          sel = clamp(k, 0, actors.length - 1);
        }
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

  // ── Movement + terrain (demo-grade collision from the arena data) ──
  const collide = (a: Actor): void => {
    const p = a.rig.root.position;
    const wallR = arena.wallRadius - a.radius - 0.15;
    const r = Math.hypot(p.x, p.z);
    if (r > wallR) {
      p.x *= wallR / r;
      p.z *= wallR / r;
    }
    for (const c of arena.circles) {
      const dx = p.x - c.x;
      const dz = p.z - c.z;
      const d = Math.hypot(dx, dz);
      const min = c.radius + a.radius;
      if (d > 1e-5 && d < min) {
        p.x = c.x + (dx / d) * min;
        p.z = c.z + (dz / d) * min;
      }
    }
  };

  const stepActors = (dt: number): void => {
    const sin = Math.sin(rig.yaw);
    const cos = Math.cos(rig.yaw);
    actors.forEach((a, i) => {
      const p = a.rig.root.position;
      let mx = 0;
      let mz = 0;
      let speed = a.speed;
      if (i === sel && !freeCam && (held.w || held.a || held.s || held.d)) {
        const f = (held.w ? 1 : 0) - (held.s ? 1 : 0);
        const rr = (held.d ? 1 : 0) - (held.a ? 1 : 0);
        mx = sin * f + cos * rr;
        mz = cos * f - sin * rr;
      } else if (a.path !== null) {
        const w = a.path;
        const tx = w.toB ? w.bx : w.ax;
        const tz = w.toB ? w.bz : w.az;
        const dx = tx - p.x;
        const dz = tz - p.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.5) w.toB = !w.toB;
        else {
          mx = dx / d;
          mz = dz / d;
        }
        speed = w.speed;
      }
      const inWaterNow = waterZoneAt(p.x, p.z) !== null;
      const onMossNow = mossZoneAt(p.x, p.z, a.radius * 0.6) !== null;
      const len = Math.hypot(mx, mz);
      let vx = 0;
      let vz = 0;
      if (len > 1e-4) {
        const k = inWaterNow ? 0.55 : onMossNow ? 0.65 : 1;
        vx = (mx / len) * speed * k;
        vz = (mz / len) * speed * k;
        p.x += vx * dt;
        p.z += vz * dt;
        const ty = Math.atan2(mx, mz);
        a.rig.root.rotation.y = wrapAngle(a.rig.root.rotation.y + clamp(angleDelta(a.rig.root.rotation.y, ty), -10 * dt, 10 * dt));
      }
      collide(a);
      const s = a.state;
      s.pos.x = p.x;
      s.pos.z = p.z;
      s.vel.x = vx;
      s.vel.z = vz;
      s.yaw = a.rig.root.rotation.y;
      const moving = len > 1e-4;
      const act: FighterAction = moving ? 'run' : 'idle';
      if (s.action !== act) {
        s.action = act;
        s.actionT = 0;
      }
      s.actionT += dt;
      const inWater = waterZoneAt(p.x, p.z, a.wasInWater ? 0.15 : 0) !== null;
      if (inWater !== a.wasInWater) {
        a.wasInWater = inWater;
        bus.emit({ type: 'splash', fighterId: i, pos: { x: p.x, y: 0, z: p.z }, entering: inWater, strength: moving ? 0.55 : 0.2 });
      }
      s.inWater = inWater || undefined;
      s.onMoss = onMossNow || undefined;
      a.rig.update(s, dt);
    });
  };

  // ── Frame ──
  const renderOnce = (dt: number): void => {
    stepActors(dt);
    const p = actors[sel].rig.root.position;
    playerPos.copy(p);
    scene.setPickupFocus(p.x, p.z);
    scene.update(dt, sm.excitement);
    fx.update(dt);
    if (!freeCam) rig.update(dt);
    sm.render();
  };
  let raf = 0;
  let prev = performance.now();
  let statT = 0;
  let fpsFrames = 0;
  let fpsAcc = 0;
  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - prev) / 1000);
    prev = now;
    if (!paused) renderOnce(dt);
    fpsAcc += dt;
    fpsFrames++;
    statT += dt;
    if (statT >= 0.5) {
      const s = sm.getStats();
      statsEl.textContent =
        `${arena.id} | tier ${s.tier} | fps ${(fpsFrames / Math.max(1e-6, fpsAcc)).toFixed(0)} | draw calls ${s.drawCalls} | tris ${(s.triangles / 1000).toFixed(1)}k | particles ${fx.liveParticles}`;
      statT = 0;
      fpsAcc = 0;
      fpsFrames = 0;
    }
  };
  raf = requestAnimationFrame(frame);

  // ── QA API ──
  const api = {
    sm,
    fx,
    bus,
    audio,
    rig,
    actors,
    get scene(): ArenaScene {
      return scene;
    },
    place(i: number, x: number, z: number, yaw = 0): void {
      const a = actors[i];
      a.rig.root.position.set(x, 0, z);
      a.rig.root.rotation.y = yaw;
      a.path = null;
    },
    walk(i: number, ax: number, az: number, bx: number, bz: number, speed?: number): void {
      const a = actors[i];
      a.rig.root.position.set(ax, 0, az);
      a.path = { ax, az, bx, bz, speed: speed ?? a.speed, toB: true };
    },
    select(i: number): void {
      sel = clamp(i, 0, actors.length - 1);
    },
    setTier(t: QualitySetting): void {
      sm.setQuality(t);
    },
    preset(name: string): void {
      doPreset(name);
    },
    camera(x: number, y: number, z: number, tx: number, ty: number, tz: number): void {
      freeCam = true;
      sm.camera.position.set(x, y, z);
      sm.camera.lookAt(tx, ty, tz);
    },
    releaseCamera(): void {
      freeCam = false;
    },
    orbit(yaw: number, pitch?: number): void {
      rig.yaw = yaw;
      if (pitch !== undefined) rig.pitch = pitch;
    },
    pause(on: boolean): void {
      paused = on;
    },
    step(seconds: number, dt = 1 / 60): void {
      let t = seconds;
      while (t > 1e-6) {
        const d = Math.min(dt, t);
        renderOnce(d);
        t -= d;
      }
    },
    splash(x: number, z: number, strength = 0.8, entering = true): void {
      bus.emit({ type: 'splash', fighterId: 0, pos: { x, y: 0, z }, entering, strength });
    },
    breakCrate(id: number): void {
      scene.breakCrate(id);
    },
    stats(): { drawCalls: number; triangles: number; fps: number; tier: string; geometries: number; textures: number; programs: number } {
      const s = sm.getStats();
      const mem = sm.renderer.info.memory;
      return {
        drawCalls: s.drawCalls,
        triangles: s.triangles,
        fps: s.fps,
        tier: s.tier,
        geometries: mem.geometries,
        textures: mem.textures,
        programs: sm.renderer.info.programs?.length ?? 0,
      };
    },
    /** Build + dispose the arena scene `n` times; returns the renderer memory counters before / after. */
    cycle(n = 5): { before: { geometries: number; textures: number }; after: { geometries: number; textures: number } } {
      const mem = sm.renderer.info.memory;
      const read = (): { geometries: number; textures: number } => ({ geometries: mem.geometries, textures: mem.textures });
      scene.dispose();
      sm.render();
      const before = read();
      for (let i = 0; i < n; i++) {
        const s = createArenaScene(sm, arena);
        s.setPickupFocus(0, -19);
        s.update(0.016, 0);
        sm.render();
        s.dispose();
        sm.render();
      }
      const after = read();
      scene = createArenaScene(sm, arena);
      return { before, after };
    },
    /** Swap the arena scene (true = colosseum, false = jungle) to compare looks / check the colosseum is unchanged. */
    colosseum(on: boolean): void {
      scene.dispose();
      arena = on ? COLOSSEUM_ARENA : JUNGLE_ARENA;
      scene = createArenaScene(sm, arena);
    },
    jungleScene(): JungleScene | null {
      return arena.id === 'jungle' ? (scene as JungleScene) : null;
    },
    tiers: QUALITY_TIERS,
  };
  (window as unknown as { __jungleDemo?: typeof api }).__jungleDemo = api;
  if (params.get('preset') !== null) doPreset(params.get('preset') as string);
  const tierParam = params.get('tier');
  if (tierParam === 'low' || tierParam === 'medium' || tierParam === 'high') sm.setQuality(tierParam);

  return () => {
    cancelAnimationFrame(raf);
    canvas.removeEventListener('click', onClick);
    document.removeEventListener('pointerlockchange', onLockChange);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    (window as unknown as { __jungleDemo?: unknown }).__jungleDemo = undefined;
    overlay.remove();
    for (const a of actors) {
      sm.scene.remove(a.rig.root);
      a.rig.dispose();
    }
    audio.stopCrowd();
    audio.dispose();
    bus.clear();
    fx.dispose();
    scene.dispose();
    sm.dispose();
  };
}

registerDemo('jungle', (root) => runJungle(root));
