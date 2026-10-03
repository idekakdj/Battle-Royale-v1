/**
 * `?demo=brawl-moves` — side-view move viewer for the Champions League pose layer (WP-A1).
 *
 * One animal, side-on, no stage: pick animal / move / air-ground / chain / facing, play, pause, frame-step (one 60 Hz frame,
 * or a tenth with Shift), slow-mo, scrub. The move's hitboxes are drawn from the data (active ones bright red) and the rig's
 * strike-tip marker (the limb that has to reach the hitbox) is shown with its distance to the nearest active hitbox.
 * A second mode previews the generic states (jump, hitstun, tumble, ledge hang …).
 *
 *   Space play/pause · ←/→ step 1 frame · Shift+←/→ step 0.1 frame · 1..5 speed · L loop · H hitboxes · T tip marker
 *
 * Automation hook: `window.__brawlMoves = { set, seek, play, pause, info, render }` (screenshots / QA).
 */

import * as THREE from 'three';
import { registerDemo } from '../../../core/demos';
import { ANIMAL_IDS } from '../../../config/animals';
import type { AnimalId } from '../../../core/types';
import { getMoveBody, getMoveset } from '../../data';
import { MOVE_IDS, type BrawlAction, type BrawlFighterState, type MoveBody, type MoveId } from '../../types';
import { BrawlRig } from './BrawlRig';
import { clearBuilt, distToHitbox, getBuilt, hitboxCentre } from './build';
import { windupDebug } from './windup';

const STATE_LIST: { key: string; action: BrawlAction; frames: number; vx?: number; vy?: number; grounded: boolean }[] = [
  { key: 'idle', action: 'idle', frames: 90, grounded: true },
  { key: 'walk', action: 'walk', frames: 60, vx: 0.5, grounded: true },
  { key: 'run', action: 'run', frames: 60, vx: 1, grounded: true },
  { key: 'jumpSquat', action: 'jumpSquat', frames: 4, grounded: true },
  { key: 'rise', action: 'rise', frames: 40, vy: 12, grounded: false },
  { key: 'fall', action: 'fall', frames: 40, vy: -10, grounded: false },
  { key: 'fastFall', action: 'fastFall', frames: 40, vy: -26, grounded: false },
  { key: 'landing', action: 'landing', frames: 8, grounded: true },
  { key: 'crouch', action: 'crouch', frames: 40, grounded: true },
  { key: 'dodgeSpot', action: 'dodgeSpot', frames: 26, grounded: true },
  { key: 'dodgeRoll', action: 'dodgeRoll', frames: 26, vx: 0.8, grounded: true },
  { key: 'dodgeAir', action: 'dodgeAir', frames: 26, grounded: false },
  { key: 'hitstun', action: 'hitstun', frames: 22, grounded: false },
  { key: 'tumble', action: 'tumble', frames: 60, grounded: false },
  { key: 'knockdown', action: 'knockdown', frames: 40, grounded: true },
  { key: 'getup', action: 'getup', frames: 24, grounded: true },
  { key: 'ledgeHang', action: 'ledgeHang', frames: 60, grounded: false },
  { key: 'ledgeClimb', action: 'ledgeClimb', frames: 22, grounded: false },
  { key: 'respawn', action: 'respawn', frames: 60, grounded: false },
  // WP-A3 QA: a falling fighter at the eagle's glide speed (jump held: fall speed pinned at stats.glideFall).
  { key: 'glide', action: 'fall', frames: 40, vy: -6.5, grounded: false },
];

function mkState(animal: AnimalId, o: Partial<BrawlFighterState>): BrawlFighterState {
  return {
    id: 0,
    animal,
    isPlayer: true,
    alive: true,
    pos: { x: 0, y: 0 },
    vel: { x: 0, y: 0 },
    facing: 1,
    grounded: true,
    platformId: null,
    action: 'idle',
    actionFrame: 0,
    actionFrames: 0,
    moveId: null,
    moveChain: 0,
    moveAir: false,
    moveFrame: 0,
    moveFrames: 0,
    movePhase: null,
    dodgeCd: 0,
    hitstunTotal: 0,
    lastHitBy: -1,
    percent: 0,
    stocks: 3,
    jumpsLeft: 2,
    hitstun: 0,
    hitlag: 0,
    invuln: 0,
    lastLaunch: null,
    kos: 0,
    falls: 0,
    damageDealt: 0,
    ...o,
  };
}

registerDemo('brawl-moves', (root: HTMLElement) => {
  // ── Renderer / scene ───────────────────────────────────────────────────────
  const existing = document.getElementById('gk-canvas');
  const canvas = existing instanceof HTMLCanvasElement ? existing : document.createElement('canvas');
  if (!canvas.isConnected) document.body.insertBefore(canvas, document.body.firstChild);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x1d2430);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x5a4a38, 1.25));
  const sun = new THREE.DirectionalLight(0xfff0d8, 2.2);
  sun.position.set(4, 9, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -6;
  sun.shadow.camera.right = 6;
  sun.shadow.camera.top = 6;
  sun.shadow.camera.bottom = -3;
  scene.add(sun);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x6b5a45, roughness: 1 });
  const ground = new THREE.Mesh(new THREE.BoxGeometry(40, 0.4, 6), groundMat);
  ground.position.set(0, -0.2, 0);
  ground.receiveShadow = true;
  scene.add(ground);
  // Metre ruler on the ground and a vertical scale at x = -3.
  const ruler = new THREE.Group();
  const tickMat = new THREE.LineBasicMaterial({ color: 0x9aa7bd, transparent: true, opacity: 0.55 });
  for (let m = -6; m <= 6; m++) {
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(m, 0.001, 0.01), new THREE.Vector3(m, m % 5 === 0 ? 0.4 : 0.2, 0.01)]);
    ruler.add(new THREE.Line(g, tickMat));
  }
  for (let y = 0; y <= 4; y++) {
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-3.2, y, 0.01), new THREE.Vector3(-3.0, y, 0.01)]);
    ruler.add(new THREE.Line(g, tickMat));
  }
  scene.add(ruler);

  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
  const camTarget = new THREE.Vector3(0, 1.1, 0);
  let camDist = 11;
  const applyCamera = (): void => {
    camera.position.set(camTarget.x, camTarget.y + camDist * Math.sin(0.07), camTarget.z + camDist);
    camera.lookAt(camTarget);
  };
  const onWheel = (e: WheelEvent): void => {
    camDist = Math.min(30, Math.max(4, camDist * (1 + e.deltaY * 0.001)));
  };
  window.addEventListener('wheel', onWheel, { passive: true });

  // Hitbox overlay (pooled line loops) and tip marker.
  const boxMat = new THREE.LineBasicMaterial({ color: 0xff3b3b, depthTest: false, transparent: true });
  const boxMatDim = new THREE.LineBasicMaterial({ color: 0xff3b3b, depthTest: false, transparent: true, opacity: 0.25 });
  const circlePts: THREE.Vector3[] = [];
  for (let i = 0; i < 48; i++) circlePts.push(new THREE.Vector3(Math.cos((i / 48) * Math.PI * 2), Math.sin((i / 48) * Math.PI * 2), 0));
  const circleGeo = new THREE.BufferGeometry().setFromPoints(circlePts);
  const rectGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.5, -0.5, 0), new THREE.Vector3(0.5, -0.5, 0), new THREE.Vector3(0.5, 0.5, 0), new THREE.Vector3(-0.5, 0.5, 0)]);
  const boxes: THREE.LineLoop[] = [];
  for (let i = 0; i < 6; i++) {
    const l = new THREE.LineLoop(circleGeo, boxMat);
    l.renderOrder = 10;
    l.visible = false;
    scene.add(l);
    boxes.push(l);
  }
  const rects: THREE.LineLoop[] = [];
  for (let i = 0; i < 6; i++) {
    const l = new THREE.LineLoop(rectGeo, boxMat);
    l.renderOrder = 10;
    l.visible = false;
    scene.add(l);
    rects.push(l);
  }
  const tipMarker = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffe14a, depthTest: false }));
  tipMarker.renderOrder = 11;
  scene.add(tipMarker);

  // ── State ──────────────────────────────────────────────────────────────────
  let animal: AnimalId = 'lion';
  let mode: 'move' | 'state' = 'move';
  let moveId: MoveId = 'lightN';
  let air = false;
  let chain = 0;
  let stateIdx = 0;
  let facing: 1 | -1 = 1;
  let playing = true;
  let loop = true;
  let speed = 1;
  let showBoxes = true;
  let showTip = true;
  let f = 0; // continuous frame inside the current move / state
  const PRE = 16; // idle frames before the move in the loop
  let rig = new BrawlRig(animal);
  rig.root.traverse((o) => {
    o.castShadow = true;
  });
  scene.add(rig.root);
  let prevSt: BrawlFighterState | null = null;
  let lastTipInfo = '';

  const body = (): MoveBody => getMoveBody(animal, moveId, air, chain);
  const totalFrames = (): number => {
    if (mode === 'state') return STATE_LIST[stateIdx].frames;
    const b = body();
    return b.startup + b.active + b.recovery;
  };

  const rebuildRig = (): void => {
    scene.remove(rig.root);
    rig.dispose();
    rig = new BrawlRig(animal);
    rig.root.traverse((o) => {
      o.castShadow = true;
    });
    scene.add(rig.root);
    prevSt = null;
  };

  /** Feed one display frame to the rig. `t` = continuous frame in the sequence (move: pre-roll then the move). */
  const feed = (t: number, dt: number): void => {
    let cur: BrawlFighterState;
    const grounded = mode === 'state' ? STATE_LIST[stateIdx].grounded : !air;
    const y = grounded ? 0 : mode === 'move' ? 2.2 : 2.5;
    if (mode === 'move') {
      const total = totalFrames();
      const mf = t - PRE; // move frame (continuous); < 0 = pre-roll idle
      if (mf < 0) {
        cur = mkState(animal, { facing, action: air ? 'fall' : 'idle', grounded: !air, pos: { x: 0, y }, vel: { x: 0, y: air ? -2 : 0 }, actionFrame: Math.floor(t) });
        rig.update(cur, prevSt, 1, dt);
      } else {
        const n = Math.floor(mf) + 1;
        const alpha = mf - Math.floor(mf);
        cur = mkState(animal, {
          facing,
          action: 'attack',
          moveId,
          moveAir: air,
          moveChain: chain,
          moveFrame: n,
          moveFrames: total,
          actionFrame: n,
          actionFrames: total,
          grounded: !air,
          pos: { x: 0, y },
          vel: { x: 0, y: air ? -1 : 0 },
        });
        // the sim's moveFrame n is displayed at alpha = 1: shift so that f = n - 1 + alpha
        cur.moveFrame = n;
        prevSt = mkState(animal, { ...cur, moveFrame: n - 1 });
        rig.update(cur, prevSt, alpha, dt);
      }
      prevSt = cur;
    } else {
      const s = STATE_LIST[stateIdx];
      const n = Math.floor(t) + 1;
      const alpha = t - Math.floor(t);
      const stats = getMoveset(animal).stats;
      cur = mkState(animal, {
        facing,
        action: s.action,
        actionFrame: n,
        actionFrames: s.action === 'idle' || s.action === 'walk' || s.action === 'run' ? 0 : s.frames,
        grounded: s.grounded,
        pos: { x: 0, y: s.grounded ? 0 : y },
        vel: { x: (s.vx ?? 0) * stats.runSpeed * facing, y: s.vy ?? 0 },
        hitstunTotal: 22,
        lastLaunch: s.action === 'hitstun' || s.action === 'tumble' ? { angle: facing === 1 ? 25 : 155, speed: 30 } : null,
      });
      rig.update(cur, prevSt, alpha, dt);
      prevSt = cur;
    }
  };

  /** Height (m) the fighter is held at: the camera follows it. */
  const airOffset = (): number => (mode === 'move' ? (air ? 2.2 : 0) : STATE_LIST[stateIdx].grounded ? 0 : 2.5);

  const hitboxFrame = (): number => {
    if (mode !== 'move') return -1;
    const mf = f - PRE;
    return mf < 0 ? -1 : Math.floor(mf + 0.5);
  };

  const updateOverlay = (): void => {
    const b = mode === 'move' ? body() : null;
    for (const l of boxes) l.visible = false;
    for (const l of rects) l.visible = false;
    let ci = 0;
    let ri = 0;
    const g = hitboxFrame();
    let best = Infinity;
    const tip = rig.tipFighterLocal('strike');
    if (b !== null && showBoxes) {
      for (const h of b.hitboxes) {
        const active = g >= h.from && g < h.to;
        const c = { x: 0, y: 0 };
        hitboxCentre(h, Math.min(Math.max(g, h.from), h.to - 1), c);
        const y = c.y + (air ? 2.2 : 0);
        const x = facing * c.x;
        if (h.shape === 'circle') {
          const l = boxes[ci++];
          if (l === undefined) continue;
          l.material = active ? boxMat : boxMatDim;
          l.position.set(x, y, 0.02);
          l.scale.set(h.r, h.r, 1);
          l.visible = true;
        } else {
          const l = rects[ri++];
          if (l === undefined) continue;
          l.material = active ? boxMat : boxMatDim;
          l.position.set(x, y, 0.02);
          l.scale.set(h.w, h.h, 1);
          l.visible = true;
        }
        if (active && tip !== null) best = Math.min(best, distToHitbox(h, g, tip.x, tip.y));
      }
    }
    const w = showTip && mode === 'move' ? rig.tipWorld('strike') : null;
    tipMarker.visible = w !== null;
    if (w !== null) tipMarker.position.set(w.x, w.y, w.z);
    lastTipInfo = tip !== null && mode === 'move' ? `tip (${tip.x.toFixed(2)}, ${tip.y.toFixed(2)})${Number.isFinite(best) ? `  d=${best.toFixed(2)} m` : ''}` : '';
  };

  // ── DOM panel ──────────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;top:10px;left:10px;z-index:10;color:#e8ecf4;font:12px/1.45 system-ui,sans-serif;' +
    'background:rgba(16,20,28,.82);padding:10px 12px;border-radius:8px;width:300px;user-select:none';
  root.appendChild(panel);
  const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement, css = ''): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    parent.appendChild(e);
    return e;
  };
  const row = (label: string): HTMLDivElement => {
    const r = mk('div', panel, 'display:flex;align-items:center;gap:6px;margin:4px 0');
    const l = mk('span', r, 'width:62px;opacity:.7');
    l.textContent = label;
    return r;
  };
  const title = mk('div', panel, 'font-weight:700;margin-bottom:4px');
  title.textContent = 'BRAWL MOVES - pose layer';
  const selAnimal = mk('select', row('animal'), 'flex:1');
  for (const id of ANIMAL_IDS) selAnimal.add(new Option(id, id));
  const selMode = mk('select', row('mode'), 'flex:1');
  selMode.add(new Option('move', 'move'));
  selMode.add(new Option('state', 'state'));
  const selMove = mk('select', row('move'), 'flex:1');
  for (const id of MOVE_IDS) selMove.add(new Option(id, id));
  const selState = mk('select', row('state'), 'flex:1');
  STATE_LIST.forEach((s, i) => selState.add(new Option(s.key, String(i))));
  const rowOpt = row('options');
  const mkCheck = (label: string, init: boolean, on: (v: boolean) => void): HTMLInputElement => {
    const lab = mk('label', rowOpt, 'display:flex;align-items:center;gap:3px');
    const c = mk('input', lab);
    c.type = 'checkbox';
    c.checked = init;
    c.addEventListener('change', () => on(c.checked));
    lab.appendChild(document.createTextNode(label));
    return c;
  };
  const cbAir = mkCheck('air', false, (v) => {
    air = v;
    restart();
  });
  const cbFace = mkCheck('face left', false, (v) => {
    facing = v ? -1 : 1;
    restart();
  });
  mkCheck('boxes', true, (v) => (showBoxes = v));
  mkCheck('tip', true, (v) => (showTip = v));
  const selChain = mk('select', row('chain'), 'flex:1');
  selChain.add(new Option('base', '0'));
  selChain.add(new Option('chain 1', '1'));
  selChain.add(new Option('chain 2', '2'));
  const rowPlay = row('play');
  const btn = (label: string, on: () => void): HTMLButtonElement => {
    const b = mk('button', rowPlay, 'padding:2px 8px');
    b.textContent = label;
    b.addEventListener('click', on);
    return b;
  };
  const bPlay = btn('pause', () => togglePlay());
  btn('<', () => step(-1));
  btn('>', () => step(1));
  const selSpeed = mk('select', rowPlay);
  for (const s of [1, 0.5, 0.25, 0.1]) selSpeed.add(new Option(`${s}x`, String(s)));
  const rowScrub = row('frame');
  const scrub = mk('input', rowScrub, 'flex:1');
  scrub.type = 'range';
  scrub.min = '0';
  scrub.step = '0.05';
  const info = mk('div', panel, 'margin-top:6px;white-space:pre;font:11px/1.4 ui-monospace,monospace;opacity:.9');

  const setPlaying = (p: boolean): void => {
    playing = p;
    bPlay.textContent = p ? 'pause' : 'play';
  };
  const togglePlay = (): void => setPlaying(!playing);
  const maxT = (): number => (mode === 'move' ? PRE + totalFrames() + 14 : totalFrames());
  const syncScrub = (): void => {
    scrub.max = String(maxT());
    scrub.value = String(f);
  };
  const restart = (): void => {
    f = 0;
    prevSt = null;
    syncScrub();
  };
  const step = (n: number, fine = false): void => {
    setPlaying(false);
    const d = fine ? n * 0.1 : n;
    f = Math.min(maxT(), Math.max(0, f + d));
    // Re-evaluate several times so the cross-fade / rate limiter converge on the scrubbed frame.
    settle();
    syncScrub();
  };
  const settle = (): void => {
    // Rewind a little so the entry blend plays through, then land on f.
    const t0 = Math.max(0, f - 5);
    for (let t = t0; t < f; t += 1) feed(t, 1 / 60);
    for (let i = 0; i < 3; i++) feed(f, 1 / 60);
  };

  const setMode = (m: 'move' | 'state'): void => {
    mode = m;
    selMode.value = m;
    restart();
  };
  selAnimal.addEventListener('change', () => {
    animal = selAnimal.value as AnimalId;
    rebuildRig();
    restart();
  });
  selMode.addEventListener('change', () => setMode(selMode.value as 'move' | 'state'));
  selMove.addEventListener('change', () => {
    moveId = selMove.value as MoveId;
    chain = 0;
    selChain.value = '0';
    restart();
  });
  selChain.addEventListener('change', () => {
    chain = Number(selChain.value);
    restart();
  });
  selState.addEventListener('change', () => {
    stateIdx = Number(selState.value);
    restart();
  });
  selSpeed.addEventListener('change', () => (speed = Number(selSpeed.value)));
  scrub.addEventListener('input', () => {
    setPlaying(false);
    f = Number(scrub.value);
    settle();
  });
  selAnimal.value = animal;
  syncScrub();

  const onKey = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) {
      if (e.code === 'Space') e.preventDefault();
    }
    switch (e.code) {
      case 'Space':
        togglePlay();
        break;
      case 'ArrowRight':
        step(1, e.shiftKey);
        break;
      case 'ArrowLeft':
        step(-1, e.shiftKey);
        break;
      case 'KeyL':
        loop = !loop;
        break;
      case 'KeyH':
        showBoxes = !showBoxes;
        break;
      case 'KeyT':
        showTip = !showTip;
        break;
      case 'Digit1':
        speed = 1;
        break;
      case 'Digit2':
        speed = 0.5;
        break;
      case 'Digit3':
        speed = 0.25;
        break;
      case 'Digit4':
        speed = 0.1;
        break;
    }
    selSpeed.value = String(speed);
  };
  window.addEventListener('keydown', onKey);

  // Automation hook for QA screenshots.
  const hook = {
    set: (o: { animal?: AnimalId; mode?: 'move' | 'state'; move?: MoveId; air?: boolean; chain?: number; state?: string; facing?: 1 | -1 }): void => {
      if (o.animal !== undefined && o.animal !== animal) {
        animal = o.animal;
        selAnimal.value = animal;
        rebuildRig();
      }
      if (o.mode !== undefined) setMode(o.mode);
      if (o.move !== undefined) {
        moveId = o.move;
        selMove.value = o.move;
      }
      if (o.air !== undefined) {
        air = o.air;
        cbAir.checked = air;
      }
      if (o.chain !== undefined) {
        chain = o.chain;
        selChain.value = String(chain);
      }
      if (o.state !== undefined) {
        const i = STATE_LIST.findIndex((s) => s.key === o.state);
        if (i >= 0) {
          stateIdx = i;
          selState.value = String(i);
        }
      }
      if (o.facing !== undefined) {
        facing = o.facing;
        cbFace.checked = facing === -1;
      }
      restart();
    },
    /** Seek to MOVE frame `mf` (state mode: state frame) and render. */
    seek: (mf: number): void => {
      setPlaying(false);
      f = mode === 'move' ? PRE + mf : mf;
      settle();
      syncScrub();
      draw();
    },
    play: (): void => setPlaying(true),
    pause: (): void => setPlaying(false),
    info: (): Record<string, unknown> => {
      const b = mode === 'move' ? getBuilt(animal, body(), air, chain) : null;
      return {
        animal,
        mode,
        moveId,
        air,
        chain,
        f,
        total: totalFrames(),
        strike: b?.strikeFrame,
        activeEnd: b?.activeEnd,
        tipRole: b?.tip,
        fit: b?.fit,
        maxStep: b?.maxStep,
        maxStrikeStep: b?.maxStrikeStep,
        tip: lastTipInfo,
        animal3: ANIMAL_IDS,
      };
    },
    render: (): void => draw(),
    rig: (): BrawlRig => rig,
    /**
     * Contact sheet for QA: renders the given frames (move frame, or state frame) side by side in one screenshot,
     * with the hitbox overlay and tip marker. `endSheet()` returns to the live view.
     */
    sheet: (frames: number[], cols = 4, dist = 6.5, states?: string[], camY?: number, camX = 0.3): void => {
      setPlaying(false);
      fit();
      sheetMode = true;
      panel.style.display = 'none';
      labels.innerHTML = '';
      sheetLabels.length = 0;
      const W = window.innerWidth;
      const H = window.innerHeight;
      const rows = Math.ceil(frames.length / cols);
      const cw = W / cols;
      const ch = H / rows;
      renderer.setScissorTest(true);
      renderer.setViewport(0, 0, W, H);
      renderer.setScissor(0, 0, W, H);
      renderer.clear();
      frames.forEach((fr, i) => {
        if (states !== undefined) {
          // One state per cell (state mode): the frame is played from the state's start so velocity-driven poses settle.
          const si = STATE_LIST.findIndex((x) => x.key === states[i]);
          if (si >= 0) {
            mode = 'state';
            stateIdx = si;
            prevSt = null;
          }
        }
        f = mode === 'move' ? PRE + fr : fr;
        settle();
        const c = i % cols;
        const r = Math.floor(i / cols);
        camera.aspect = cw / ch;
        camera.updateProjectionMatrix();
        camTarget.set(camX, (camY ?? 1.05) + airOffset(), 0);
        const saved = camDist;
        camDist = dist;
        applyCamera();
        camDist = saved;
        updateOverlay();
        const x = c * cw;
        const y = H - (r + 1) * ch;
        renderer.setViewport(x, y, cw, ch);
        renderer.setScissor(x, y, cw, ch);
        renderer.render(scene, camera);
        const lab = document.createElement('div');
        lab.style.cssText = `position:fixed;left:${x + 6}px;top:${r * ch + 4}px;color:#fff;font:bold 13px monospace;text-shadow:0 0 3px #000`;
        lab.textContent = states !== undefined ? `${states[i]} f${fr}` : `f${fr}`;
        labels.appendChild(lab);
        sheetLabels.push({ x: x + 6, y: r * ch + 18, text: states !== undefined ? `${states[i]} f${fr}` : `f${fr}` });
      });
      renderer.setScissorTest(false);
    },
    /**
     * QA (WP-A3): a contact sheet whose cells may be DIFFERENT moves / forms / facings / states of one or several animals
     * (`frame` = move frame, or state frame for `state` cells). Same camera options as `sheet`.
     */
    sheetCells: (
      cells: { animal?: AnimalId; move?: MoveId; air?: boolean; chain?: number; facing?: 1 | -1; state?: string; frame: number; label?: string }[],
      cols = 4,
      dist = 6.5,
      camY?: number,
      camX = 0.3,
    ): void => {
      setPlaying(false);
      fit();
      sheetMode = true;
      panel.style.display = 'none';
      labels.innerHTML = '';
      sheetLabels.length = 0;
      const W = window.innerWidth;
      const H = window.innerHeight;
      const rows = Math.ceil(cells.length / cols);
      const cw = W / cols;
      const ch = H / rows;
      renderer.setScissorTest(true);
      renderer.setViewport(0, 0, W, H);
      renderer.setScissor(0, 0, W, H);
      renderer.clear();
      cells.forEach((cell, i) => {
        hook.set({ animal: cell.animal, mode: cell.state !== undefined ? 'state' : 'move', move: cell.move, air: cell.air ?? false, chain: cell.chain ?? 0, state: cell.state, facing: cell.facing ?? 1 });
        f = mode === 'move' ? PRE + cell.frame : cell.frame;
        settle();
        const c = i % cols;
        const r = Math.floor(i / cols);
        camera.aspect = cw / ch;
        camera.updateProjectionMatrix();
        camTarget.set(camX, (camY ?? 1.05) + airOffset(), 0);
        const saved = camDist;
        camDist = dist;
        applyCamera();
        camDist = saved;
        updateOverlay();
        const x = c * cw;
        const y = H - (r + 1) * ch;
        renderer.setViewport(x, y, cw, ch);
        renderer.setScissor(x, y, cw, ch);
        renderer.render(scene, camera);
        const text = cell.label ?? `${cell.state ?? cell.move ?? ''}${cell.air ? ' air' : ''}${cell.chain ? ' c' + cell.chain : ''}${cell.facing === -1 ? ' <-' : ''} f${cell.frame}`;
        const lab = document.createElement('div');
        lab.style.cssText = `position:fixed;left:${x + 6}px;top:${r * ch + 4}px;color:#fff;font:bold 13px monospace;text-shadow:0 0 3px #000`;
        lab.textContent = text;
        labels.appendChild(lab);
        sheetLabels.push({ x: x + 6, y: r * ch + 18, text });
      });
      renderer.setScissorTest(false);
    },
    /**
     * QA (WP-P): one ROW per move, `K` columns of the key frames of the move: a quarter / half / the last frame of the startup,
     * the strike (first active) frame, then two frames inside the recovery (the follow-through and the settle). `frames(b)` may
     * override the picks. Same camera options as `sheet`.
     */
    rowsSheet: (
      rows: { animal?: AnimalId; move: MoveId; air?: boolean; chain?: number; facing?: 1 | -1 }[],
      dist = 5.4,
      camY?: number,
      camX = 0.3,
      frames?: (b: { strikeFrame: number; activeEnd: number; total: number }) => number[],
    ): { rows: number; cols: number } => {
      const cells: { animal?: AnimalId; move?: MoveId; air?: boolean; chain?: number; facing?: 1 | -1; state?: string; frame: number; label?: string }[] = [];
      let cols = 6;
      for (const r of rows) {
        const an = r.animal ?? animal;
        const mb = getMoveBody(an, r.move, r.air ?? false, r.chain ?? 0);
        const b = getBuilt(an, mb, r.air ?? false, r.chain ?? 0);
        const S = b.strikeFrame;
        const R = Math.max(1, b.total - b.activeEnd);
        const fr =
          frames !== undefined
            ? frames(b)
            : [Math.max(1, Math.round(S * 0.25)), Math.max(2, Math.round(S * 0.5)), Math.max(1, S - 1), S, b.activeEnd + Math.round(R * 0.25), b.activeEnd + Math.round(R * 0.6)];
        cols = fr.length;
        for (const x of fr) {
          cells.push({ animal: an, move: r.move, air: r.air ?? false, chain: r.chain ?? 0, facing: r.facing ?? 1, frame: x, label: `${r.move}${r.air ? ' air' : ''}${r.chain ? ' c' + r.chain : ''} f${x}${x === S ? ' STRIKE' : ''}` });
        }
      }
      hook.sheetCells(cells, cols, dist, camY, camX);
      return { rows: rows.length, cols };
    },
    /**
     * QA (WP-P): render the standard review sheets of the given animals and POST them as `<prefix>_<animal>_<group>.png`.
     * Groups: A = heavyS / heavyN / heavyD, B = heavyD air / lightS / lightN, C = lightN chain 1 / 2 / lightU, D = heavyU / lightD / lightU air.
     */
    shootAll: async (prefix: string, animals: AnimalId[], groups: string[] = ['A', 'B', 'C'], port = 5598): Promise<string> => {
      const cam: Partial<Record<AnimalId, [number, number, number]>> = {
        giraffe: [11, 1.6, 0.4],
        python: [9, 0.9, 0.4],
        crocodile: [9.5, 0.8, 0.0],
        hippo: [8.6, 0.95, 0.4],
        rhino: [8.6, 1, 0.4],
        eagle: [8, 1.1, 0.4],
        mole: [5.8, 0.7, 0.3],
        panther: [7.8, 0.95, 0.4],
        gorilla: [8.6, 1.3, 0.3],
        lion: [8.4, 1.0, 0.4],
      };
      type Row = { move: MoveId; air?: boolean; chain?: number };
      const G: Record<string, Row[]> = {
        A: [{ move: 'heavyS' }, { move: 'heavyN' }, { move: 'heavyD' }],
        B: [{ move: 'heavyD', air: true }, { move: 'lightS' }, { move: 'lightN', chain: 0 }],
        C: [{ move: 'lightN', chain: 1 }, { move: 'lightN', chain: 2 }, { move: 'lightU' }],
        D: [{ move: 'heavyU' }, { move: 'lightD' }, { move: 'lightU', air: true }],
        E: [{ move: 'heavyS', air: true }, { move: 'heavyN', air: true }, { move: 'lightS', air: true }],
      };
      const out: string[] = [];
      for (const an of animals) {
        const c = cam[an] ?? [5.4, 1.05, 0.3];
        for (const g of groups) {
          hook.set({ animal: an });
          hook.rowsSheet(
            (G[g] ?? []).map((r) => ({ animal: an, ...r })),
            c[0],
            c[1],
            c[2],
          );
          out.push(`${an}${g}:${await hook.shot(`${prefix}_${an}_${g}`, port)}`);
        }
      }
      return out.join(' ');
    },
    /** QA (WP-P): consecutive frames `from..to` of one move in a grid (smoothness review of transitions / follow-through). */
    strip: (o: { animal?: AnimalId; move: MoveId; air?: boolean; chain?: number; facing?: 1 | -1; from: number; to: number; step?: number }, cols = 6, dist = 5.4, camY?: number, camX = 0.3): void => {
      const cells: { animal?: AnimalId; move?: MoveId; air?: boolean; chain?: number; facing?: 1 | -1; frame: number; label?: string }[] = [];
      for (let fr = o.from; fr <= o.to; fr += o.step ?? 1) cells.push({ animal: o.animal, move: o.move, air: o.air ?? false, chain: o.chain ?? 0, facing: o.facing ?? 1, frame: fr, label: `${o.move}${o.air ? ' air' : ''} f${fr}` });
      hook.sheetCells(cells, cols, dist, camY, camX);
    },
    /** QA (WP-P): `windup(false)` rebuilds every move WITHOUT the WP-P wind-up / follow-through layer (before/after comparisons). */
    windup: (on: boolean): void => {
      windupDebug.off = !on;
      clearBuilt();
      rebuildRig();
    },
    /** QA: composite the canvas (+ contact-sheet labels) and POST it as a PNG data URL to a local receiver. */
    shot: async (name: string, port = 5599): Promise<string> => {
      const c2 = document.createElement('canvas');
      c2.width = canvas.width;
      c2.height = canvas.height;
      const g = c2.getContext('2d');
      if (g === null) return 'no 2d';
      g.drawImage(canvas, 0, 0);
      const k = canvas.width / window.innerWidth;
      g.font = `bold ${14 * k}px monospace`;
      g.fillStyle = '#fff';
      g.strokeStyle = '#000';
      g.lineWidth = 3 * k;
      for (const l of sheetLabels) {
        g.strokeText(l.text, l.x * k, l.y * k);
        g.fillText(l.text, l.x * k, l.y * k);
      }
      const r = await fetch(`http://localhost:${port}/${name}`, { method: 'POST', body: c2.toDataURL('image/png') });
      return r.statusText;
    },
    endSheet: (): void => {
      sheetMode = false;
      labels.innerHTML = '';
      panel.style.display = '';
      lastW = 0;
    },
  };
  (window as unknown as { __brawlMoves?: typeof hook }).__brawlMoves = hook;

  // ── Frame loop ─────────────────────────────────────────────────────────────
  let sheetMode = false;
  const sheetLabels: { x: number; y: number; text: string }[] = [];
  const labels = document.createElement('div');
  root.appendChild(labels);
  let raf = 0;
  let last = performance.now();
  let lastW = 0;
  let lastH = 0;
  let infoT = 0;

  const fit = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w !== lastW || h !== lastH) {
      lastW = w;
      lastH = h;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  };

  const draw = (): void => {
    if (sheetMode) return;
    fit();
    camTarget.set(0, 1.1 + airOffset() * 0.9, 0);
    applyCamera();
    updateOverlay();
    renderer.render(scene, camera);
  };

  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (playing) {
      f += dt * 60 * speed;
      const end = maxT();
      if (f >= end) {
        if (loop) f = 0;
        else {
          f = end;
          setPlaying(false);
        }
      }
      feed(f, dt * speed);
      syncScrub();
    }
    infoT += dt;
    if (infoT > 0.1) {
      infoT = 0;
      const total = totalFrames();
      const b = mode === 'move' ? getBuilt(animal, body(), air, chain) : null;
      const mf = mode === 'move' ? f - PRE : f;
      info.textContent =
        mode === 'move'
          ? `${body().name}  [${body().archetype}]  striker=${b?.tip}\n` +
            `frame ${mf.toFixed(2)} / ${total}   S=${body().startup} A=${body().active} R=${body().recovery}\n` +
            `strike=${b?.strikeFrame}  fit=${b?.fit.map((x) => x.err.toFixed(2)).join('/')}\n` +
            `raw step ${b?.maxStep.toFixed(2)} / strike ${b?.maxStrikeStep.toFixed(2)}   ${lastTipInfo}`
          : `${STATE_LIST[stateIdx].key}   frame ${mf.toFixed(2)} / ${total}`;
    }
    draw();
  };
  settle();
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('wheel', onWheel);
    panel.remove();
    labels.remove();
    scene.remove(rig.root);
    rig.dispose();
    ground.geometry.dispose();
    groundMat.dispose();
    renderer.dispose();
    delete (window as unknown as { __brawlMoves?: unknown }).__brawlMoves;
  };
});
