/**
 * v1.2 WP-P trap demo (`?demo=traps`): the real stadium + Effects + the
 * {@link TrapRenderer}, driven by MOCK `TrapState`s (no sim needed).
 *
 * Eight traps in two rows (fire front row, spikes back row). Default mode
 * cycles every trap armed → active (8 s) → cooldown (5 s) → armed with
 * staggered offsets; the mock emits the same `trapTriggered` / `trapDamage` /
 * `trapExpired` events the sim does, through an EventBus that the renderer,
 * Effects and AudioEngine all listen to (exactly like MatchController).
 *
 * Keys: 1 all armed · 2 trigger all · 3 all expiring · 4 all cooldown ·
 * 5 phase-comparison rows (armed | active | expiring | cooldown) · C cycle ·
 * F freeze timers · Q quality tier · L eagle landing slam · N trap damage
 * numbers · O orbit camera.
 *
 * Debug handle: `window.__gkTraps` — preset(name), set(i, phase, timeLeft),
 * freeze(bool), quality(tier), cam(px,py,pz,tx,ty,tz), landing(), damage(),
 * stats().
 */

import * as THREE from 'three';
import { registerDemo } from '../core/demos';
import { EventBus } from '../core/EventBus';
import type { TrapKind, TrapPhase, TrapState } from '../core/types';
import { SceneManager } from './SceneManager';
import { Stadium } from './Stadium';
import { Effects } from './Effects';
import { TrapRenderer, TRAP_ACTIVE_SECONDS, WARN_SECONDS } from './traps/TrapRenderer';
import { getQualityTier, type QualitySetting, type QualityTier } from './quality';
import { AudioEngine } from '../audio/AudioEngine';

const COOLDOWN = 5;
const COLS = [-10.5, -3.5, 3.5, 10.5];
const ROWS: readonly { z: number; kind: TrapKind; radius: number }[] = [
  { z: 21, kind: 'fire', radius: 2.0 },
  { z: 14, kind: 'spikes', radius: 1.8 },
];

interface MockTrap extends TrapState {
  /** Seconds left in the armed wait before the mock steps on it (cycle mode). */
  wait: number;
  /** Next damage tick (s) while active. */
  tick: number;
}

function ensureCanvas(): HTMLCanvasElement {
  const existing = document.getElementById('gk-canvas');
  if (existing instanceof HTMLCanvasElement) return existing;
  const canvas = document.createElement('canvas');
  canvas.id = 'gk-canvas';
  document.body.insertBefore(canvas, document.body.firstChild);
  return canvas;
}

function runTraps(root: HTMLElement): () => void {
  const canvas = ensureCanvas();
  const sm = new SceneManager(canvas);
  const stadium = new Stadium();
  sm.scene.add(stadium.root);
  const fx = new Effects(sm.scene, { fovDeg: sm.camera.fov });
  const traps = new TrapRenderer(sm.scene, fx);
  const bus = new EventBus();
  const audio = new AudioEngine();
  audio.attachBus(bus);

  const mocks: MockTrap[] = [];
  let id = 0;
  for (const row of ROWS) {
    for (let c = 0; c < COLS.length; c++) {
      mocks.push({
        id: id++,
        kind: row.kind,
        pos: { x: COLS[c], y: 0, z: row.z },
        radius: row.radius,
        phase: 'armed',
        timeLeft: 0,
        triggeredBy: -1,
        wait: 1.2 + c * 2.1 + (row.kind === 'spikes' ? 1 : 0),
        tick: 0,
      });
    }
  }

  bus.on('trapTriggered', (e) => traps.onTriggered(e));
  bus.on('trapExpired', (e) => traps.onExpired(e));
  bus.on('trapDamage', (e) => fx.onTrapDamage(e.pos, e.damage, e.kind));
  bus.on('landingImpact', (e) => fx.onLandingImpact(e.pos, e.radius, e.damage, 1));

  let mode: 'cycle' | 'manual' = 'cycle';
  let frozen = false;
  let orbit = false;
  let orbitT = 0;
  const camPos = new THREE.Vector3(0, 12.5, 33);
  const camTarget = new THREE.Vector3(0, 0, 16);

  const victimPos = { x: 0, y: 0, z: 0 };

  const setPhase = (m: MockTrap, phase: TrapPhase, timeLeft: number): void => {
    const was = m.phase;
    m.phase = phase;
    m.timeLeft = timeLeft;
    if (phase === 'active' && was !== 'active') {
      m.triggeredBy = 1;
      m.tick = 0;
      bus.emit({ type: 'trapTriggered', trapId: m.id, kind: m.kind, pos: m.pos, fighterId: 1 });
    } else if (was === 'active' && phase !== 'active') {
      bus.emit({ type: 'trapExpired', trapId: m.id, kind: m.kind, pos: m.pos });
    }
    if (phase === 'armed') {
      m.triggeredBy = -1;
      m.timeLeft = 0;
    }
  };

  const stepMocks = (dt: number): void => {
    for (const m of mocks) {
      if (!frozen) {
        if (m.phase === 'armed') {
          if (mode === 'cycle') {
            m.wait -= dt;
            if (m.wait <= 0) setPhase(m, 'active', TRAP_ACTIVE_SECONDS);
          }
        } else if (m.phase === 'active') {
          m.timeLeft -= dt;
          if (m.timeLeft <= 0) setPhase(m, 'cooldown', COOLDOWN);
        } else {
          m.timeLeft -= dt;
          if (m.timeLeft <= 0) {
            setPhase(m, 'armed', 0);
            m.wait = 2 + Math.random() * 3;
          }
        }
      }
      // A pretend victim standing in each active hazard: damage ~2×/s.
      if (m.phase === 'active' && !frozen) {
        m.tick -= dt;
        if (m.tick <= 0) {
          m.tick = 0.5;
          victimPos.x = m.pos.x + 0.6;
          victimPos.y = 0;
          victimPos.z = m.pos.z + 0.4;
          bus.emit({
            type: 'trapDamage',
            trapId: m.id,
            kind: m.kind,
            targetId: 1,
            damage: m.kind === 'fire' ? 6 : 20,
            pos: { ...victimPos },
          });
        }
      }
    }
  };

  const allTo = (phase: TrapPhase, timeLeft: number): void => {
    mode = 'manual';
    for (const m of mocks) {
      if (phase === 'active' && m.phase === 'active') {
        // Re-trigger: bounce through cooldown so the burst replays.
        setPhase(m, 'cooldown', COOLDOWN);
      }
      setPhase(m, phase, timeLeft);
    }
  };

  const presetRows = (): void => {
    mode = 'manual';
    for (const m of mocks) {
      const col = m.id % COLS.length;
      if (m.phase === 'active') setPhase(m, 'cooldown', COOLDOWN);
      setPhase(m, 'armed', 0);
      if (col === 1) setPhase(m, 'active', 5.5);
      else if (col === 2) setPhase(m, 'active', WARN_SECONDS * 0.6);
      else if (col === 3) {
        setPhase(m, 'active', 0.01);
        setPhase(m, 'cooldown', 4);
      }
    }
  };

  const landing = (): void => {
    bus.emit({
      type: 'landingImpact',
      fighterId: 1,
      pos: { x: 0, y: 0, z: 17.5 },
      radius: 3.2,
      damage: 48,
      height: 6.2,
    });
  };

  const damageBurst = (): void => {
    for (const m of mocks) {
      bus.emit({
        type: 'trapDamage',
        trapId: m.id,
        kind: m.kind,
        targetId: 1,
        damage: m.kind === 'fire' ? 6 : 20,
        pos: { x: m.pos.x, y: 0, z: m.pos.z },
      });
    }
  };

  const tiers: readonly QualitySetting[] = ['low', 'medium', 'high'];
  const cycleQuality = (): void => {
    const cur = getQualityTier();
    const next = tiers[(tiers.indexOf(cur) + 1) % tiers.length];
    sm.setQuality(next);
  };

  // ── Overlay ────────────────────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:absolute;top:12px;left:12px;padding:10px 14px;font:12px/1.6 monospace;' +
    'color:#ece3d0;background:rgba(20,17,13,.72);border:1px solid rgba(217,164,65,.4);' +
    'border-radius:6px;pointer-events:none;z-index:10;white-space:nowrap';
  overlay.innerHTML =
    '<b>TRAPS DEMO</b> — front row fire, back row spikes<br>' +
    '1 armed · 2 trigger · 3 expiring · 4 cooldown · 5 compare rows · C cycle<br>' +
    'F freeze · Q quality · L landing slam · N damage numbers · O orbit';
  const stats = document.createElement('div');
  stats.style.marginTop = '6px';
  stats.style.color = '#d9a441';
  overlay.appendChild(stats);
  root.appendChild(overlay);

  const onKey = (e: KeyboardEvent): void => {
    const k = e.key.toLowerCase();
    if (k === '1') allTo('armed', 0);
    else if (k === '2') allTo('active', TRAP_ACTIVE_SECONDS);
    else if (k === '3') allTo('active', WARN_SECONDS);
    else if (k === '4') {
      allTo('active', 0.01);
      allTo('cooldown', COOLDOWN);
    } else if (k === '5') presetRows();
    else if (k === 'c') mode = 'cycle';
    else if (k === 'f') frozen = !frozen;
    else if (k === 'q') cycleQuality();
    else if (k === 'l') landing();
    else if (k === 'n') damageBurst();
    else if (k === 'o') orbit = !orbit;
    void audio.resume();
  };
  window.addEventListener('keydown', onKey);

  const handle = {
    preset(name: 'rows' | 'armed' | 'active' | 'expiring' | 'cooldown' | 'cycle'): void {
      if (name === 'rows') presetRows();
      else if (name === 'armed') allTo('armed', 0);
      else if (name === 'active') allTo('active', TRAP_ACTIVE_SECONDS);
      else if (name === 'expiring') allTo('active', WARN_SECONDS);
      else if (name === 'cooldown') {
        allTo('active', 0.01);
        allTo('cooldown', COOLDOWN);
      } else mode = 'cycle';
    },
    set(i: number, phase: TrapPhase, timeLeft: number): void {
      mode = 'manual';
      const m = mocks[i];
      if (m !== undefined) setPhase(m, phase, timeLeft);
    },
    freeze(b: boolean): void {
      frozen = b;
    },
    quality(t: QualityTier): void {
      sm.setQuality(t);
    },
    cam(px: number, py: number, pz: number, tx: number, ty: number, tz: number): void {
      orbit = false;
      camPos.set(px, py, pz);
      camTarget.set(tx, ty, tz);
    },
    landing,
    damage: damageBurst,
    /** Hide / show every trap mesh (draw-call delta measurements). */
    trapsVisible(b: boolean): void {
      traps.group.visible = b;
    },
    /** Restart the frame loop (after swapping in a requestAnimationFrame shim). */
    kick(): void {
      cancelAnimationFrame(raf);
      prev = performance.now();
      raf = requestAnimationFrame(frame);
    },
    stats(): Record<string, unknown> {
      const s = sm.getStats();
      return { ...traps.stats(), drawCalls: s.drawCalls, triangles: s.triangles, particles: fx.liveParticles, tier: getQualityTier() };
    },
  };
  (window as unknown as { __gkTraps?: typeof handle }).__gkTraps = handle;

  // ── Loop ───────────────────────────────────────────────────────────────────
  let raf = 0;
  let prev = performance.now();
  let fpsAcc = 0;
  let fpsFrames = 0;
  let statTimer = 0;
  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, Math.max(0, (now - prev) / 1000));
    prev = now;

    stepMocks(dt);
    if (orbit) {
      orbitT += dt * 0.15;
      camPos.set(Math.sin(orbitT) * 16, 9, 17 + Math.cos(orbitT) * 16);
      camTarget.set(0, 0, 17);
    }
    sm.camera.position.copy(camPos);
    sm.camera.lookAt(camTarget);
    traps.setFocus(camTarget.x, camTarget.z);
    traps.update(mocks, dt);
    stadium.update(dt, sm.excitement);
    fx.update(dt);
    sm.render();

    fpsAcc += dt;
    fpsFrames++;
    statTimer += dt;
    if (statTimer >= 0.5) {
      const s = sm.getStats();
      const t = traps.stats();
      stats.textContent =
        `fps ${(fpsFrames / Math.max(1e-6, fpsAcc)).toFixed(0)} | draw calls ${s.drawCalls} | tris ${(s.triangles / 1000).toFixed(1)}k` +
        ` | particles ${fx.liveParticles} | flames ${t.flames} | spikes ${t.spikes} | light ${t.light ? 'on' : 'off'}` +
        ` | tier ${getQualityTier()} | ${mode}${frozen ? ' (frozen)' : ''}`;
      fpsAcc = 0;
      fpsFrames = 0;
      statTimer = 0;
    }
  };
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKey);
    delete (window as unknown as { __gkTraps?: typeof handle }).__gkTraps;
    overlay.remove();
    bus.clear();
    audio.detachBus();
    audio.dispose();
    traps.dispose();
    fx.dispose();
    stadium.dispose();
    sm.dispose();
  };
}

registerDemo('traps', (root) => runTraps(root));
