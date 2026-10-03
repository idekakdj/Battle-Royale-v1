/**
 * Champions League — the playable match Screen (plan §8). Owns the per-match object graph: BrawlWorld (sim),
 * BrawlView (3D), one bot per other slot, the keyboard/mouse reader, the DOM HUD, the pause overlay and the
 * audio hooks. The fixed-step loop itself lives in {@link BrawlSession} (DOM-free, unit-tested); this class
 * wires it to requestAnimationFrame, the DOM and the screen flow:
 *
 *   mount → countdown (sim) → fight → [Esc: pause (sim stops, static frame) → Resume / Restart / Controls /
 *   Quit] → matchOver → celebration → `onMatchEnd(results)` exactly once. `unmount()` / `dispose()` are
 *   idempotent and release every listener, raf, the view, the HUD and the audio loops.
 */

import type { Screen } from '../core/ScreenManager';
import type { AudioEngine } from '../audio/AudioEngine';
import { createBrawlView } from './render/BrawlView';
import { BrawlWorld } from './sim/BrawlWorld';
import { BrawlBot } from './ai/BrawlBot';
import { BrawlInput } from './ui/BrawlInput';
import { BrawlSession } from './ui/BrawlSession';
import { BrawlHud } from './ui/BrawlHud';
import { BrawlPause } from './ui/BrawlPause';
import { buildResultsData, type BrawlResultsData } from './ui/BrawlResults';
import { buildMatchConfig, type BrawlSetupChoice } from './ui/setup';
import { BrawlAudio } from './audio/BrawlAudio';
import type { BrawlBotApi, BrawlEvent, BrawlInputApi, BrawlMatchConfig, BrawlSnapshot, BrawlViewApi, BrawlWorldApi } from './types';

/** What the controller needs from its HUD / pause overlay / audio (the real classes satisfy these; tests inject fakes). */
export interface BrawlHudLike {
  mount(host: HTMLElement): void;
  unmount(): void;
  update(snap: BrawlSnapshot): void;
  onEvents(events: readonly BrawlEvent[]): void;
}
export interface BrawlPauseLike {
  mount(host: HTMLElement): void;
  unmount(): void;
}
export interface BrawlAudioLike {
  start(): void;
  stop(): void;
  setPaused(paused: boolean): void;
  onEvents(events: readonly BrawlEvent[], cur: BrawlSnapshot): void;
  update(cur: BrawlSnapshot): void;
}

export interface BrawlMatchControllerOptions {
  canvas: HTMLCanvasElement;
  audio: AudioEngine;
  setup: BrawlSetupChoice;
  seed: number;
  /** Fired exactly once, ~2.6 s after the sim declares the match over. */
  onMatchEnd: (results: BrawlResultsData) => void;
  /** Pause menu → Quit to lobby. */
  onQuitToLobby: () => void;
  /** Pause menu → Restart (a fresh match, same setup; the caller picks a new seed). */
  onRestart: () => void;
  /** Test / tooling seams (defaults: the real world, view and bots). */
  createWorld?: (config: BrawlMatchConfig, seed: number) => BrawlWorldApi;
  createView?: (canvas: HTMLCanvasElement, config: BrawlMatchConfig) => BrawlViewApi;
  createBot?: (id: number, config: BrawlMatchConfig, seed: number) => BrawlBotApi;
  createInput?: (hooks: { onPause: () => void; onToggleDebug: () => void }, canvas: HTMLCanvasElement) => BrawlInputApi;
  createHud?: (config: BrawlMatchConfig, project: BrawlViewApi['project']) => BrawlHudLike;
  createPause?: (hooks: { onResume: () => void; onRestart: () => void; onQuitToLobby: () => void }) => BrawlPauseLike;
  createAudio?: (engine: AudioEngine) => BrawlAudioLike;
}

export class BrawlMatchController implements Screen {
  private readonly opts: BrawlMatchControllerOptions;

  readonly config: BrawlMatchConfig;
  world!: BrawlWorldApi;
  view!: BrawlViewApi;
  session!: BrawlSession;

  private input!: BrawlInputApi;
  private hud!: BrawlHudLike;
  private pauseMenu!: BrawlPauseLike;
  private audio!: BrawlAudioLike;
  private root: HTMLElement | null = null;
  private raf = 0;
  private lastNow = 0;
  private debugBoxes = false;
  private mounted = false;
  private disposed = false;
  private paused = false;

  private readonly onFrame = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.onFrame);
    const dt = (now - this.lastNow) / 1000;
    this.lastNow = now;
    this.tick(dt);
  };

  private readonly onVisibility = (): void => {
    if (typeof document !== 'undefined' && document.hidden) this.requestPause();
  };

  constructor(opts: BrawlMatchControllerOptions) {
    this.opts = opts;
    this.config = buildMatchConfig(opts.setup, opts.seed);
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  // ── Screen lifecycle ───────────────────────────────────────────────────────

  mount(root: HTMLElement): void {
    if (this.mounted || this.disposed) return;
    this.mounted = true;
    this.root = root;
    const { canvas, seed } = this.opts;
    const config = this.config;

    this.world = (this.opts.createWorld ?? ((c, s) => new BrawlWorld(c, s)))(config, seed);
    this.view = (this.opts.createView ?? ((cv, c) => createBrawlView(cv, c)))(canvas, config);
    const hooks = { onPause: () => this.togglePause(), onToggleDebug: () => this.toggleDebug() };
    this.input = this.opts.createInput !== undefined ? this.opts.createInput(hooks, canvas) : new BrawlInput({ mouseTarget: canvas, ...hooks });

    const createBot = this.opts.createBot ?? ((id, c, s) => new BrawlBot(id, c.difficulty, s));
    const bots: Array<{ id: number; bot: BrawlBotApi }> = [];
    for (let id = 0; id < config.roster.length; id++) {
      if (config.roster[id].isPlayer) continue;
      bots.push({ id, bot: createBot(id, config, (seed + id * 7919) >>> 0) });
    }

    const project: BrawlViewApi['project'] = (x, y) => this.view.project(x, y);
    this.hud = this.opts.createHud !== undefined ? this.opts.createHud(config, project) : new BrawlHud({ config, project });
    this.hud.mount(root);
    this.audio = this.opts.createAudio !== undefined ? this.opts.createAudio(this.opts.audio) : new BrawlAudio(this.opts.audio);
    this.audio.start();
    const pauseHooks = {
      onResume: () => this.resume(),
      onRestart: () => this.opts.onRestart(),
      onQuitToLobby: () => this.opts.onQuitToLobby(),
    };
    this.pauseMenu = this.opts.createPause !== undefined ? this.opts.createPause(pauseHooks) : new BrawlPause(pauseHooks);

    this.session = new BrawlSession({
      world: this.world,
      view: this.view,
      input: this.input,
      bots,
      onEvents: (events, cur) => this.audio.onEvents(events, cur),
      onRender: (cur, events) => {
        this.hud.onEvents(events);
        this.hud.update(cur);
        this.audio.update(cur);
      },
      onMatchOver: () => {
        this.input.setEnabled(false);
      },
      onResults: (cur) => this.finish(cur),
    });

    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.installDevHook();

    // First frame: show the opening pose before the loop starts.
    this.view.render(this.session.snapshot, this.session.snapshot, 0, [], 0);
    this.hud.update(this.session.snapshot);
    this.lastNow = performance.now();
    this.raf = requestAnimationFrame(this.onFrame);
  }

  unmount(): void {
    this.dispose();
  }

  /** Release everything (idempotent). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf !== 0) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (!this.mounted) return;
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    // Each part may be missing when mount() threw half-way (e.g. no WebGL): release whatever exists.
    this.session?.dispose();
    this.input?.dispose();
    this.pauseMenu?.unmount();
    this.hud?.unmount();
    this.audio?.stop();
    this.view?.dispose();
    this.removeDevHook();
    this.root = null;
  }

  // ── loop ───────────────────────────────────────────────────────────────────

  /** One animation frame (called by the rAF loop; public for tools / tests). */
  tick(dtSeconds: number): void {
    if (this.disposed || !this.mounted) return;
    this.session.advance(dtSeconds);
  }

  // ── pause ──────────────────────────────────────────────────────────────────

  togglePause(): void {
    if (this.paused) this.resume();
    else this.requestPause();
  }

  requestPause(): void {
    if (this.disposed || !this.mounted || this.paused || this.root === null) return;
    if (this.session.matchOver) return; // decided: let the celebration play out
    this.paused = true;
    this.session.setPaused(true);
    this.input.setEnabled(false);
    this.audio.setPaused(true);
    this.pauseMenu.mount(this.root);
  }

  resume(): void {
    if (this.disposed || !this.paused) return;
    this.paused = false;
    this.pauseMenu.unmount();
    this.session.setPaused(false);
    this.input.setEnabled(true);
    this.audio.setPaused(false);
  }

  // ── misc ───────────────────────────────────────────────────────────────────

  toggleDebug(): void {
    this.debugBoxes = !this.debugBoxes;
    this.view.setDebugBoxes(this.debugBoxes);
  }

  private readonly onResize = (): void => {
    this.view.resize();
  };

  private finish(cur: BrawlSnapshot): void {
    if (this.disposed) return;
    this.opts.onMatchEnd(buildResultsData(this.opts.setup, this.config, cur));
  }

  private installDevHook(): void {
    if (typeof window === 'undefined') return;
    let qa = false;
    try {
      qa = new URLSearchParams(window.location.search).get('qa') === '1';
    } catch {
      qa = false;
    }
    if (import.meta.env.DEV || qa) {
      (window as unknown as { __gkBrawl?: unknown }).__gkBrawl = { world: this.world, view: this.view, controller: this };
    }
  }

  private removeDevHook(): void {
    if (typeof window === 'undefined') return;
    const w = window as unknown as { __gkBrawl?: { controller?: unknown } };
    if (w.__gkBrawl?.controller === this) delete w.__gkBrawl;
  }
}
