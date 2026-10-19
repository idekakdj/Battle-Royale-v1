/**
 * `?demo=ocean` (v1.9 WP-O3): the Ocean Dome QA playground.
 *
 * Builds SceneManager + the ocean `ArenaScene` (through the same `createArenaScene` entry point the match uses) + Effects + CameraRig
 * and stands the ten animal rigs on the three levels. WASD moves the selected animal (1..9, 0 select; ground height + cliff-free demo
 * collision), mouse look after a click, N cycles the camera presets, G plays a LOW serpent event (random angle), J a HIGH serpent
 * event, F makes the selected animal take a fall burst, H fires a hit flash.
 * The first click / key starts the AUDIO through a real AudioEngine + EventBus wired like the match controller. A `window.__oceanDemo`
 * API drives everything for screenshots / automated checks:
 *
 *   place(i, x, z, yaw?)   select(i)   preset('overview'|'chase'|'edge'|'plateau'|'terrace'|'strip'|'serpent'|'sky'|'fp'|
 *                                              'tower'|'towerEdge'|'causeway'|'chord'|'overhead'|'highStrip'|'highSerpent'|'towerBase')
 *   camera(x, y, z, tx, ty, tz)   releaseCamera()   orbit(yaw, pitch)   setTier('low'|'medium'|'high'|'auto')
 *   serpent(angleDeg, phase, t, tier = 'low')  (pin either serpent at a phase / time; both can be pinned at once)
 *   play(angleDeg?, tier = 'low')  (run the real timeline + events)   clearSerpent(tier?)   fall(x, z, drop = 3.5)  (a fall burst + sound + shake)
 *   hit(i, tier?)   setTime(s)   pause(on)   step(seconds, dt?)   stats()   cycle(n)  (create/dispose leak probe)   arena('ocean'|'jungle'|'colosseum')
 */

import { registerDemo } from '../../core/demos';
import { angleDelta, clamp, wrapAngle } from '../../core/math';
import { ANIMAL_IDS, ANIMALS } from '../../config/animals';
import type { AnimalId, FighterAction, FighterState, SerpentPhase, SerpentTier } from '../../core/types';
import { OCEAN_ARENA, OCEAN_STACKS, OCEAN_UPPER_HEIGHT, JUNGLE_ARENA, COLOSSEUM_ARENA, arenaGroundHeight, type ArenaDef } from '../../config/arenas';
import { SERPENT } from '../../config/serpent';
import { EventBus } from '../../core/EventBus';
import { AudioEngine } from '../../audio/AudioEngine';
import { SceneManager } from '../SceneManager';
import { createArenaScene, type ArenaScene } from '../arenaScene';
import { Effects } from '../Effects';
import { CameraRig, type TargetPosFn } from '../CameraRig';
import { AnimalFactory } from '../animals/AnimalFactory';
import { makeMockState, type BaseRig } from '../animals/Animator';
import { QUALITY_TIERS, type QualitySetting } from '../quality';
import type { OceanScene } from './OceanScene';

interface Actor {
  id: AnimalId;
  rig: BaseRig;
  state: FighterState;
  radius: number;
  speed: number;
}

const HELP = `<b>OCEAN DEMO</b> - click for mouse look · WASD move · 1-9,0 pick animal · N next camera preset · G low serpent · J high serpent · F fall burst · H hit flash · V first person<br>
<span style="opacity:.8">window.__oceanDemo: place / preset / camera / serpent(angle, phase, t, tier) / play / fall / step / setTier / stats / cycle / arena</span>`;

function ensureCanvas(): HTMLCanvasElement {
  const existing = document.getElementById('gk-canvas');
  if (existing instanceof HTMLCanvasElement) return existing;
  const canvas = document.createElement('canvas');
  canvas.id = 'gk-canvas';
  document.body.insertBefore(canvas, document.body.firstChild);
  return canvas;
}

const PRESETS = ['chase', 'overview', 'edge', 'plateau', 'terrace', 'strip', 'serpent', 'sky', 'tower', 'towerEdge', 'causeway', 'chord', 'overhead', 'highStrip', 'highSerpent', 'towerBase'] as const;
const PHASES: readonly SerpentPhase[] = ['warn', 'strike', 'hold', 'retreat'];
const PHASE_LEN: Record<SerpentPhase, number> = { warn: SERPENT.warnS, strike: SERPENT.strikeS, hold: SERPENT.holdS, retreat: SERPENT.retreatS };

function runOcean(root: HTMLElement): () => void {
  const params = new URLSearchParams(window.location.search);
  const canvas = ensureCanvas();
  const sm = new SceneManager(canvas);
  let arena: ArenaDef = OCEAN_ARENA;
  const arenaParam = params.get('arena');
  if (arenaParam === 'jungle') arena = JUNGLE_ARENA;
  else if (arenaParam === 'colosseum') arena = COLOSSEUM_ARENA;
  let scene: ArenaScene = createArenaScene(sm, arena);
  const fx = new Effects(sm.scene, { fovDeg: sm.camera.fov });
  const bus = new EventBus();
  const audio = new AudioEngine();
  audio.attachBus(bus);
  bus.on('serpentStrike', (e) => scene.onEvent?.(e));
  bus.on('serpentHit', (e) => scene.onEvent?.(e));
  bus.on('serpentWarning', (e) => scene.onEvent?.(e));
  bus.on('serpentEnd', (e) => scene.onEvent?.(e));
  bus.on('fall', (e) => scene.onEvent?.(e));
  let audioOn = false;
  const startAudio = (): void => {
    if (audioOn) return;
    audioOn = true;
    void audio.resume().then(() => audio.startCrowd());
  };
  const rig = new CameraRig(sm.camera);
  rig.shakeSource = () => fx.getShakeOffset();
  rig.yaw = 0;

  const ground = (x: number, z: number): number => arenaGroundHeight(arena, x, z);

  // ── Actors: one on each level, a couple on ramps, one on the plateau ──
  const actors: Actor[] = ANIMAL_IDS.map((id, i): Actor => {
    const r = AnimalFactory.createRig(id);
    sm.scene.add(r.root);
    const state = makeMockState(id);
    state.id = i;
    state.isPlayer = i === 0;
    return { id, rig: r, state, radius: ANIMALS[id].radius ?? 0.6, speed: ANIMALS[id].speed ?? 5 };
  });
  const T0 = OCEAN_STACKS[0];
  const T1 = OCEAN_STACKS[1];
  const T2 = OCEAN_STACKS[2];
  const SPOTS: [number, number, number][] = [
    [0, -24, 0],
    [-6, -18, 0.4],
    [1.2, 2.5, 2.5],
    [-2.5, -3, 1],
    [T0.x + 0.9, T0.z - 1.2, 3.6],
    [T1.x + 1.3, T1.z + 0.6, 4.7],
    [T2.x - 1.0, T2.z + 1.0, 0.4],
    [21, 12, 0.5],
    [-16, -14, 0],
    [3.5, -13, 1],
  ];
  const place = (a: Actor, x: number, z: number, yaw: number): void => {
    const y = ground(x, z);
    a.rig.root.position.set(x, y, z);
    a.rig.root.rotation.y = yaw;
    a.state.pos.x = x;
    a.state.pos.y = y;
    a.state.pos.z = z;
    a.state.yaw = yaw;
  };
  actors.forEach((a, i) => {
    const [x, z, yaw] = SPOTS[i % SPOTS.length];
    place(a, x, z, yaw);
  });
  let sel = 0;
  const target: TargetPosFn = (out) => out.copy(actors[sel].rig.root.position);
  rig.follow(target, 1.6);
  rig.snap();

  // ── Overlay ──
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:absolute;top:10px;left:10px;padding:8px 12px;font:12px/1.5 monospace;color:#d6f2f6;background:rgba(6,24,34,.72);' +
    'border:1px solid rgba(110,200,220,.4);border-radius:6px;pointer-events:none;z-index:10;white-space:nowrap';
  const help = document.createElement('div');
  help.innerHTML = HELP;
  const statsEl = document.createElement('div');
  statsEl.style.cssText = 'margin-top:4px;color:#8ee6f2';
  overlay.append(help, statsEl);
  root.appendChild(overlay);

  // ── State ──
  let paused = false;
  let freeCam = false;
  let presetIdx = 0;
  const held = { w: false, a: false, s: false, d: false };
  let locked = false;
  /** Per-serpent run state: the real-time clock (>= 0 while an event plays), its angle, whether it is pinned, the last phase index. */
  interface Run {
    clock: number;
    angle: number;
    pinned: boolean;
    last: number;
  }
  const runs: Record<SerpentTier, Run> = {
    low: { clock: -1, angle: 0, pinned: false, last: -1 },
    high: { clock: -1, angle: 0, pinned: false, last: -1 },
  };
  let serpAngle = 0; // the angle of the most recently started / pinned serpent (camera presets look along it)
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

  const strikeDir = (): { x: number; z: number } => ({ x: Math.cos((serpAngle * Math.PI) / 180), z: Math.sin((serpAngle * Math.PI) / 180) });
  const doPreset = (name: string): void => {
    const d = strikeDir();
    switch (name) {
      case 'overview':
        freeCam = true;
        sm.camera.position.set(0, 10.5, -25.5);
        sm.camera.lookAt(0, 1.2, 2);
        break;
      case 'edge':
        freeCam = true;
        sm.camera.position.set(0, 3.4, -28.2);
        sm.camera.lookAt(0, 3.2, 0);
        break;
      case 'plateau':
        freeCam = true;
        sm.camera.position.set(-6, 6.2, -7.5);
        sm.camera.lookAt(2, 3.2, 3);
        break;
      case 'terrace':
        freeCam = true;
        sm.camera.position.set(-2, 5.2, -23);
        sm.camera.lookAt(0, 1.6, -9);
        break;
      case 'strip':
        // a view along the strike line from the far side of the dome, looking toward the edge it comes from
        freeCam = true;
        sm.camera.position.set(-d.x * 17 - d.z * 1.5, 9.5, -d.z * 17 + d.x * 1.5);
        sm.camera.lookAt(d.x * 8, 0.8, d.z * 8);
        break;
      case 'serpent':
        // from the middle of the dome looking out at the head at the strike edge
        freeCam = true;
        sm.camera.position.set(d.x * 8 - d.z * 5, 5.5, d.z * 8 + d.x * 5);
        sm.camera.lookAt(d.x * 36, 3.6, d.z * 36);
        break;
      case 'sky':
        freeCam = true;
        sm.camera.position.set(0, 2.5, -10);
        sm.camera.lookAt(-12, 14, 22);
        break;
      case 'tower':
        // on the first tower's top (72 deg), by the rim, looking across the pad at the plateau and the other towers
        freeCam = true;
        sm.camera.position.set(T0.x - 0.4, OCEAN_UPPER_HEIGHT + 1.7, T0.z + 3.1);
        sm.camera.lookAt(T0.x - 0.6, OCEAN_UPPER_HEIGHT + 0.6, T0.z - 6);
        break;
      case 'towerEdge':
        // looking down the cliff of the second tower (180 deg) from just inside its parapet
        freeCam = true;
        sm.camera.position.set(T1.x - 2.2, OCEAN_UPPER_HEIGHT + 1.4, T1.z + 0.6);
        sm.camera.lookAt(T1.x - 6.5, 0.5, T1.z + 1.5);
        break;
      case 'causeway': {
        // from the plateau looking up the causeway to the first tower (the climb the bots take)
        freeCam = true;
        const ca = Math.cos((T0.deg * Math.PI) / 180);
        const sa = Math.sin((T0.deg * Math.PI) / 180);
        sm.camera.position.set(ca * 2.5 - sa * 1.2, 5.3, sa * 2.5 + ca * 1.2);
        sm.camera.lookAt(ca * 15 - sa * 0.5, 5.4, sa * 15 + ca * 0.5);
        break;
      }
      case 'chord': {
        // from the terrace foot of the first tower's chord (clockwise of the tower) looking up it
        freeCam = true;
        sm.camera.position.set(17.6, 4.8, 3.6);
        sm.camera.lookAt(T0.x + 2.0, 5.0, T0.z - 2.5);
        break;
      }
      case 'overhead':
        // a high wide view from inside the dome over the whole arena (towers, causeways, plateau)
        freeCam = true;
        sm.camera.position.set(-1, 20.5, -24.5);
        sm.camera.lookAt(0, 1.5, 2);
        break;
      case 'towerBase':
        // standing on the seabed at the foot of the third tower (288 deg): the cliff, the strata, the crown
        freeCam = true;
        sm.camera.position.set(T2.x + 9.5, 2.4, T2.z - 7.5);
        sm.camera.lookAt(T2.x, 5, T2.z);
        break;
      case 'highStrip': {
        // along the HIGH strike line from the far side, looking at the edge it comes from (the strip lies on the tower tops only)
        freeCam = true;
        const hd = { x: Math.cos((runs.high.angle * Math.PI) / 180), z: Math.sin((runs.high.angle * Math.PI) / 180) };
        sm.camera.position.set(-hd.x * 12 - hd.z * 2, 10.5, -hd.z * 12 + hd.x * 2);
        sm.camera.lookAt(hd.x * 12, 6, hd.z * 12);
        break;
      }
      case 'highSerpent': {
        // from the plateau looking out at the high head against the glass
        freeCam = true;
        const hd = { x: Math.cos((runs.high.angle * Math.PI) / 180), z: Math.sin((runs.high.angle * Math.PI) / 180) };
        sm.camera.position.set(hd.x * 6 - hd.z * 5, 6.2, hd.z * 6 + hd.x * 5);
        sm.camera.lookAt(hd.x * 36, OCEAN_UPPER_HEIGHT + 2, hd.z * 36);
        break;
      }
      case 'fp':
        freeCam = false;
        rig.setFirstPerson(true, true);
        break;
      default:
        freeCam = false;
        rig.setFirstPerson(false, true);
        break;
    }
  };

  const playSerpent = (angleDeg?: number, tier: SerpentTier = 'low'): void => {
    const r = runs[tier];
    r.angle = angleDeg ?? Math.random() * 360;
    serpAngle = r.angle;
    r.clock = 0;
    r.pinned = false;
    r.last = -1;
  };
  const fallAt = (x: number, z: number, drop = 3.5): void => {
    bus.emit({ type: 'fall', fighterId: -1, damage: 50, drop, pos: { x, y: ground(x, z), z } });
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    startAudio();
    switch (e.code) {
      case 'KeyW': held.w = true; break;
      case 'KeyA': held.a = true; break;
      case 'KeyS': held.s = true; break;
      case 'KeyD': held.d = true; break;
      case 'KeyV': rig.setFirstPerson(!rig.isFirstPerson); break;
      case 'KeyG': playSerpent(undefined, 'low'); break;
      case 'KeyJ': playSerpent(undefined, 'high'); break;
      case 'KeyF': {
        const p = actors[sel].rig.root.position;
        fallAt(p.x, p.z, 3.5);
        break;
      }
      case 'KeyH': {
        const p = actors[sel].rig.root.position;
        bus.emit({ type: 'serpentHit', fighterId: sel, damage: 300, pos: { x: p.x, y: p.y, z: p.z } });
        break;
      }
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

  // ── Movement (demo-grade: ground height, wall, round blockers) ──
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
      if (i === sel && !freeCam && (held.w || held.a || held.s || held.d)) {
        const f = (held.w ? 1 : 0) - (held.s ? 1 : 0);
        const rr = (held.d ? 1 : 0) - (held.a ? 1 : 0);
        mx = sin * f + cos * rr;
        mz = cos * f - sin * rr;
      }
      const len = Math.hypot(mx, mz);
      let vx = 0;
      let vz = 0;
      if (len > 1e-4) {
        vx = (mx / len) * a.speed;
        vz = (mz / len) * a.speed;
        p.x += vx * dt;
        p.z += vz * dt;
        const ty = Math.atan2(mx, mz);
        a.rig.root.rotation.y = wrapAngle(a.rig.root.rotation.y + clamp(angleDelta(a.rig.root.rotation.y, ty), -10 * dt, 10 * dt));
      }
      collide(a);
      p.y = ground(p.x, p.z);
      const s = a.state;
      s.pos.x = p.x;
      s.pos.y = p.y;
      s.pos.z = p.z;
      s.vel.x = vx;
      s.vel.z = vz;
      s.yaw = a.rig.root.rotation.y;
      const act: FighterAction = len > 1e-4 ? 'run' : 'idle';
      if (s.action !== act) {
        s.action = act;
        s.actionT = 0;
      }
      s.actionT += dt;
      a.rig.update(s, dt);
    });
  };

  // ── The serpent timelines: each serpent either pinned (QA) or played in real time with the real events ──
  const serpentTickOne = (tier: SerpentTier, dt: number): void => {
    const os = scene as OceanScene;
    const r = runs[tier];
    if (arena.id !== 'ocean' || typeof os.setSerpentBlock !== 'function') return;
    if (r.pinned) return;
    if (r.clock < 0) {
      os.setSerpentBlock(null, 1, tier);
      return;
    }
    let t = r.clock;
    let idx = 0;
    while (idx < PHASES.length && t >= PHASE_LEN[PHASES[idx]]) {
      t -= PHASE_LEN[PHASES[idx]];
      idx++;
    }
    const tag = tier === 'high' ? ({ tier: 'high' } as const) : {};
    if (idx >= PHASES.length) {
      os.setSerpentBlock(null, 1, tier);
      if (r.last !== PHASES.length) bus.emit({ type: 'serpentEnd', ...tag });
      r.last = PHASES.length;
      r.clock = -1;
      return;
    }
    if (idx !== r.last) {
      if (idx === 0) bus.emit({ type: 'serpentWarning', angleDeg: r.angle, warnS: SERPENT.warnS, ...tag });
      if (idx === 1) bus.emit({ type: 'serpentStrike', angleDeg: r.angle, ...tag });
      r.last = idx;
    }
    os.setSerpentBlock({ phase: PHASES[idx], angleDeg: r.angle, t }, 1, tier);
    r.clock += dt;
  };
  const serpentTick = (dt: number): void => {
    serpentTickOne('low', dt);
    serpentTickOne('high', dt);
  };

  // ── Frame ──
  const renderOnce = (dt: number): void => {
    stepActors(dt);
    const p = actors[sel].rig.root.position;
    scene.setPickupFocus(p.x, p.z);
    serpentTick(dt);
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
      statsEl.textContent = `${arena.id} | tier ${s.tier} | fps ${(fpsFrames / Math.max(1e-6, fpsAcc)).toFixed(0)} | draw calls ${s.drawCalls} | tris ${(s.triangles / 1000).toFixed(1)}k`;
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
      place(actors[i], x, z, yaw);
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
    /** Pin a serpent set piece at (phase, t s into the phase) for strike angle `angleDeg` (`tier` 'high' = the high serpent). */
    serpent(angleDeg: number, phase: SerpentPhase, t: number, tier: SerpentTier = 'low'): void {
      const r = runs[tier];
      r.angle = angleDeg;
      serpAngle = angleDeg;
      r.pinned = true;
      r.clock = -1;
      (scene as OceanScene).setSerpentBlock?.({ phase, angleDeg, t }, 1, tier);
    },
    /** Run the real event timeline in real time (events + snapshot block), starting now. */
    play(angleDeg?: number, tier: SerpentTier = 'low'): void {
      playSerpent(angleDeg, tier);
    },
    clearSerpent(tier?: SerpentTier): void {
      for (const t of tier === undefined ? (['low', 'high'] as const) : [tier]) {
        runs[t].pinned = false;
        runs[t].clock = -1;
        (scene as OceanScene).setSerpentBlock?.(null, 1, t);
      }
    },
    hit(i: number, tier: SerpentTier = 'low'): void {
      const p = actors[clamp(i, 0, actors.length - 1)].rig.root.position;
      bus.emit({ type: 'serpentHit', fighterId: i, damage: 300, pos: { x: p.x, y: p.y, z: p.z }, ...(tier === 'high' ? { tier: 'high' as const } : {}) });
    },
    /** A fall-damage landing at (x, z): the impact burst + the thud + (when the selected animal is within 2.2 m) the camera shake. */
    fall(x: number, z: number, drop = 3.5): void {
      fallAt(x, z, drop);
    },
    setTime(t: number): void {
      (scene as OceanScene).setTime?.(t);
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
        s.setPickupFocus(0, -24);
        s.update(0.016, 0);
        sm.render();
        s.dispose();
        sm.render();
      }
      const after = read();
      scene = createArenaScene(sm, arena);
      return { before, after };
    },
    /** Swap the arena scene (to compare looks / check the colosseum and the jungle are unchanged). */
    arena(id: 'ocean' | 'jungle' | 'colosseum'): void {
      scene.dispose();
      arena = id === 'ocean' ? OCEAN_ARENA : id === 'jungle' ? JUNGLE_ARENA : COLOSSEUM_ARENA;
      scene = createArenaScene(sm, arena);
      actors.forEach((a, i) => {
        const [x, z, yaw] = SPOTS[i % SPOTS.length];
        place(a, id === 'ocean' ? x : x * 0.5, id === 'ocean' ? z : z * 0.5, yaw);
      });
    },
    oceanScene(): OceanScene | null {
      return arena.id === 'ocean' ? (scene as OceanScene) : null;
    },
    tiers: QUALITY_TIERS,
  };
  (window as unknown as { __oceanDemo?: typeof api }).__oceanDemo = api;
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
    (window as unknown as { __oceanDemo?: unknown }).__oceanDemo = undefined;
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

registerDemo('ocean', (root) => runOcean(root));
