/**
 * `?demo=brawl-view` — runs a REAL `BrawlWorld` with scripted dummy intents through the Champions League 3D view.
 *
 *   ?demo=brawl-view&stage=skyAqueduct&n=4&a=lion,eagle,gorilla,panther&q=high&pct=80&stocks=3&seed=7&ai=1&p=0
 *

 *   stage    brokenColosseum | skyAqueduct | clockworkHeights | crumblingAmphitheatre   n      2..4 fighters        a   animal ids (csv)
 *   q        low | medium | high (forces the tier)  pct   starting percent       ai  1 = dummy bots drive everyone
 *   p        1 = fighter 0 is yours (A/D move · W jump · S down · J light · K heavy · L dodge)
 *   Keys: F3 debug boxes · Q cycle quality · U force-KO fighter 1 · P +30 % to all · Space pause · R restart · [ ] slow-mo
 *
 * Automation hook: `window.__brawlDemo = { world, view, tick(dt), place(id,x,y,vx,vy), percent(id,p), ko(id), … }`.
 */

import { registerDemo } from '../../core/demos';
import { ANIMAL_IDS } from '../../config/animals';
import { mulberry32 } from '../../core/math';
import type { AnimalId } from '../../core/types';
import { setQualitySetting, getQualitySetting, type QualitySetting } from '../../render/quality';
import { BrawlWorld } from '../sim/BrawlWorld';
import { STAGE_IDS, idleIntent, type BrawlEvent, type BrawlIntent, type BrawlMatchConfig, type BrawlSnapshot, type StageId } from '../types';
import { createBrawlView, type BrawlView } from './BrawlView';

const DT = 1 / 60;

interface DemoApi {
  world: BrawlWorld;
  view: BrawlView;
  tick(dt: number): void;
  place(id: number, x: number, y: number, vx?: number, vy?: number): void;
  percent(id: number, p: number): void;
  ko(id: number, side?: 'left' | 'right' | 'top' | 'bottom'): void;
  paused: boolean;
  /** true = the rAF loop only re-draws the frozen frame (dt 0); drive time with `tick(dt)` yourself (screenshots). */
  manual: boolean;
  timeScale: number;
  restart(): void;
  cur(): BrawlSnapshot;
  /** v1.6: apply `count` counted hits to a breakable platform through the sim (events + cosmetics flow normally). */
  hitPlatform(id: string, count?: number): boolean;
  /** v1.6: break every breakable (-> the stage's final form). */
  breakAll(): void;
  /** Advance the world `frames` fixed steps without rendering (clockwork layouts: 36 s = 2160 frames). */
  advance(frames: number): void;
}

function parseAnimals(csv: string | null, n: number): AnimalId[] {
  const out: AnimalId[] = [];
  if (csv !== null) {
    for (const s of csv.split(',')) {
      const t = s.trim() as AnimalId;
      if ((ANIMAL_IDS as readonly string[]).includes(t)) out.push(t);
    }
  }
  const def: AnimalId[] = ['lion', 'panther', 'gorilla', 'eagle'];
  while (out.length < n) out.push(def[out.length % def.length]);
  return out.slice(0, n);
}

registerDemo('brawl-view', (root) => {
  const params = new URLSearchParams(window.location.search);
  const stageParam = params.get('stage') as StageId | null;
  const stage: StageId = stageParam !== null && STAGE_IDS.includes(stageParam) ? stageParam : 'brokenColosseum';
  const n = Math.max(2, Math.min(4, Number(params.get('n') ?? 4) || 4));
  const animals = parseAnimals(params.get('a'), n);
  const seed = Number(params.get('seed') ?? 7) || 7;
  const pct0 = Number(params.get('pct') ?? 0) || 0;
  const stocks = Number(params.get('stocks') ?? 3) || 3;
  const ai = params.get('ai') !== '0';
  const mine = params.get('p') === '1';
  const q = params.get('q');
  if (q === 'low' || q === 'medium' || q === 'high') setQualitySetting(q);

  const canvas = document.getElementById('gk-canvas') as HTMLCanvasElement;
  const config: BrawlMatchConfig = {
    stage,
    roster: animals.map((a, i) => ({ animal: a, isPlayer: i === 0 })),
    difficulty: 3,
    stocks,
    timeLimitS: 0,
  };

  let world = new BrawlWorld(config, seed);
  let view: BrawlView = createBrawlView(canvas, config, { debugBoxes: params.get('debug') === '1' });
  const api = {} as DemoApi;
  let prev: BrawlSnapshot;
  let cur: BrawlSnapshot;
  const events: BrawlEvent[] = [];
  let acc = 0;
  let frames = 0;
  let rng = mulberry32(seed * 31 + 1);

  const start = (): void => {
    world = new BrawlWorld(config, seed);
    if (params.get('countdown') !== '1') world.skipCountdown();
    for (let i = 0; i < n; i++) world.debugSetPercent(i, pct0);
    cur = world.snapshot();
    prev = cur;
    acc = 0;
    frames = 0;
    rng = mulberry32(seed * 31 + 1);
    api.world = world;
  };
  start();

  // ── dummy intents ──
  const mem: { until: number; intent: BrawlIntent }[] = [];
  for (let i = 0; i < n; i++) mem.push({ until: 0, intent: idleIntent() });
  const keys = new Set<string>();
  const think = (id: number, snap: BrawlSnapshot): BrawlIntent => {
    const me = snap.fighters[id];
    const m = mem[id];
    const it = idleIntent();
    if (!me.alive) return it;
    // Held between decisions (edges are re-fired only on decision frames).
    let foe = null as null | (typeof snap.fighters)[number];
    let best = 1e9;
    for (const f of snap.fighters) {
      if (f.id === id || !f.alive) continue;
      const d = Math.abs(f.pos.x - me.pos.x) + Math.abs(f.pos.y - me.pos.y) * 0.6;
      if (d < best) {
        best = d;
        foe = f;
      }
    }
    const off = Math.abs(me.pos.x) > 11.5 || me.pos.y < -1.2;
    if (frames >= m.until) {
      m.until = frames + 6 + Math.floor(rng() * 12);
      const mi = idleIntent();
      if (off) {
        mi.moveX = me.pos.x > 0 ? -1 : 1;
        mi.jumpHeld = true;
        mi.jump = me.jumpsLeft > 0 && rng() < 0.7;
        mi.heavy = me.pos.y < -3 && rng() < 0.4;
        mi.moveY = mi.heavy ? 1 : 0;
      } else if (foe !== null) {
        const dx = foe.pos.x - me.pos.x;
        const dy = foe.pos.y - me.pos.y;
        const near = Math.abs(dx) < 2.6 && Math.abs(dy) < 2.4;
        mi.moveX = near ? (rng() < 0.2 ? -Math.sign(dx) : Math.sign(dx) * 0.4) : Math.sign(dx);
        if (near) {
          const r = rng();
          if (r < 0.5) mi.light = true;
          else if (r < 0.8) mi.heavy = true;
          else if (r < 0.9) mi.dodge = true;
          if (dy > 1.2) mi.moveY = 1;
          else if (dy < -1.2) mi.moveY = -1;
        } else if (dy > 2 && rng() < 0.5) {
          mi.jump = true;
          mi.jumpHeld = true;
        } else if (rng() < 0.12) {
          mi.jump = true;
          mi.jumpHeld = true;
        }
      } else mi.moveX = Math.sin(frames * 0.02 + id);
      m.intent = mi;
    }
    // Edge fields are only true on the decision frame.
    const base = m.intent;
    it.moveX = base.moveX;
    it.moveY = base.moveY;
    it.jumpHeld = base.jumpHeld;
    if (frames === m.until - 1 || frames < m.until - 5) {
      // keep edges off except the first frame of the decision window
    }
    if (m.until - frames > 0 && m.until - frames >= 5) {
      it.jump = base.jump;
      it.light = base.light;
      it.heavy = base.heavy;
      it.dodge = base.dodge;
      base.jump = base.light = base.heavy = base.dodge = false;
    }
    return it;
  };
  const human = (): BrawlIntent => {
    const it = idleIntent();
    it.moveX = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
    it.moveY = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
    it.jumpHeld = keys.has('w') || keys.has('arrowup') || keys.has(' ');
    if (pressed.has('w') || pressed.has('arrowup') || pressed.has(' ')) it.jump = true;
    if (pressed.has('j')) it.light = true;
    if (pressed.has('k')) it.heavy = true;
    if (pressed.has('l')) it.dodge = true;
    pressed.clear();
    return it;
  };
  const pressed = new Set<string>();

  const stepOnce = (): void => {
    for (let i = 0; i < n; i++) {
      if (i === 0 && mine) world.setIntent(0, human());
      else if (ai) world.setIntent(i, think(i, cur));
    }
    world.step();
    frames++;
    prev = cur;
    cur = world.snapshot();
    for (const e of world.drainEvents()) events.push(e);
  };

  // ── overlay ──
  const hud = document.createElement('div');
  hud.style.cssText =
    'position:fixed;left:10px;top:10px;z-index:50;font:12px/1.35 ui-monospace,Consolas,monospace;color:#fff;background:rgba(0,0,0,.45);padding:6px 9px;border-radius:6px;pointer-events:none;white-space:pre';
  root.appendChild(hud);
  let hudT = 0;

  api.paused = false;
  api.manual = false;
  api.timeScale = 1;
  api.view = view;
  api.world = world;
  api.cur = () => cur;
  api.tick = (dt: number): void => {
    if (!api.paused) {
      acc += dt * api.timeScale;
      let guard = 0;
      while (acc >= DT && guard++ < 6) {
        stepOnce();
        acc -= DT;
      }
      if (acc > DT * 6) acc = 0;
    }
    view.render(prev, cur, api.paused ? 1 : acc / DT, events, dt);
    events.length = 0;
    hudT += dt;
    if (hudT > 0.25) {
      hudT = 0;
      const s = view.stats();
      const c = view.cam;
      const fs = cur.fighters.map((f) => `${f.animal.slice(0, 4)} ${f.percent.toFixed(0)}% x${f.stocks}`).join('  ');
      hud.textContent =
        `brawl-view ${stage} n=${n} tier=${s.tier} (${getQualitySetting()})\n` +
        `fps ${s.fps.toFixed(0)}  draws ${s.drawCalls}  tris ${(s.triangles / 1000).toFixed(1)}k  geo ${s.geometries} tex ${s.textures}  vfx ${s.vfxLive}\n` +
        `cam x=${c.x.toFixed(1)} y=${c.y.toFixed(1)} halfW=${c.halfW.toFixed(1)}  frame ${cur.frame}\n${fs}\n` +
        `F3 boxes · Q quality · U KO #1 · P +30% · Space pause · R restart · [ ] slow-mo` +
        (cur.matchOver ? `\nMATCH OVER winner ${cur.winnerId}` : '');
    }
  };
  api.place = (id, x, y, vx = 0, vy = 0): void => {
    world.debugPlace(id, x, y, vx, vy);
    prev = cur = world.snapshot();
  };
  api.percent = (id, p): void => {
    world.debugSetPercent(id, p);
    cur = world.snapshot();
  };
  api.ko = (id, side = 'right'): void => {
    const b = world.stage.blast;
    const pos = side === 'left' ? [b.left - 1, 6, -4, 4] : side === 'right' ? [b.right - 0.3, 6, 40, 6] : side === 'top' ? [0, b.top - 0.5, 0, 40] : [0, b.bottom + 0.5, 0, -40];
    world.debugPlace(id, pos[0], pos[1], pos[2], pos[3]);
  };
  api.hitPlatform = (id, count = 1): boolean => {
    const ok = world.debugHitPlatform(id, 0, count);
    for (const e of world.drainEvents()) events.push(e);
    prev = cur;
    cur = world.snapshot();
    return ok;
  };
  api.breakAll = (): void => {
    for (const p of world.stage.platforms) if (p.breakable !== undefined) api.hitPlatform(p.id, p.breakable.hits);
  };
  api.advance = (frames): void => {
    for (let i = 0; i < frames; i++) {
      world.step();
      world.drainEvents();
    }
    prev = cur = world.snapshot();
  };
  api.restart = (): void => {
    view.dispose();
    view = createBrawlView(canvas, config, {});
    api.view = view;
    start();
  };
  (window as unknown as { __brawlDemo?: DemoApi }).__brawlDemo = api;

  // ── input ──
  const onKeyDown = (e: KeyboardEvent): void => {
    const k = e.key.toLowerCase();
    if (e.key === 'F3') {
      e.preventDefault();
      view.setDebugBoxes(!view.getDebugBoxes());
      return;
    }
    if (e.repeat) return;
    if (!keys.has(k)) pressed.add(k);
    keys.add(k);
    if (mine && ['w', 'a', 's', 'd', 'j', 'k', 'l', ' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) return;
    if (k === 'q') {
      const order: QualitySetting[] = ['low', 'medium', 'high'];
      const curS = getQualitySetting();
      setQualitySetting(order[(Math.max(0, order.indexOf(curS)) + 1) % 3]);
    } else if (k === 'u') api.ko(Math.min(1, n - 1), 'right');
    else if (k === 'p') for (let i = 0; i < n; i++) api.percent(i, cur.fighters[i].percent + 30);
    else if (k === ' ') api.paused = !api.paused;
    else if (k === 'r') api.restart();
    else if (k === '[') api.timeScale = Math.max(0.05, api.timeScale * 0.5);
    else if (k === ']') api.timeScale = Math.min(2, api.timeScale * 2);
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    keys.delete(e.key.toLowerCase());
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  let last = performance.now();
  let raf = 0;
  const loop = (now: number): void => {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    api.tick(api.manual ? 0 : dt);
  };
  raf = requestAnimationFrame(loop);

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    hud.remove();
    view.dispose();
    delete (window as unknown as { __brawlDemo?: DemoApi }).__brawlDemo;
  };
});
