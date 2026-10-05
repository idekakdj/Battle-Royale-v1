/**
 * Boot + screen flow (BLUEPRINT §3/§14, WP-A shell integrated by WP-I).
 *
 * Responsibilities:
 *  1. Create the full-screen WebGL canvas behind the DOM UI layer (#app).
 *  2. If `?demo=<name>` is present, load demo-registration modules and run the
 *     matching demo, then stop (BLUEPRINT §14 demo-flag convention).
 *  3. Otherwise run the real game flow:
 *     Lobby → ModeSelect → (Battle Royale) CharacterSelect → DifficultySelect → Match → Results, with
 *     REMATCH (same settings, fresh seed) / CHANGE GLADIATOR / LOBBY loops; or
 *     Lobby → ModeSelect → (Champions League) fighter/stage setup → Match → Results (lazily loaded).
 *     Back chain: DifficultySelect → CharacterSelect / BrawlSetup → ModeSelect → Lobby.
 *
 * Demo convention: any module named `*.demo.ts` that calls `registerDemo(...)`
 * is auto-discovered — packages never edit this file to add a demo.
 */

import { ScreenManager } from './core/ScreenManager';
import { getDemo, demoNames } from './core/demos';
import type { AnimalId, Difficulty } from './core/types';
import { AudioEngine } from './audio/AudioEngine';
import { createPreview } from './render/preview';
import {
  Lobby,
  ModeSelect,
  CharacterSelect,
  DifficultySelect,
  Results,
  type MatchResults,
  type GkSettings,
  setPreviewFactory,
  loadAnimal,
  loadDifficulty,
  loadMode,
  loadBrawlSetup,
} from './ui';
import { MatchController } from './match/MatchController';
import { mountFpsCounter } from './ui/FpsCounter';
// v1.4 Champions League: the whole mode is loaded lazily (`await import('./brawl')`); only types are imported here.
import type { BrawlSetupChoice } from './brawl/ui/setup';
import type { BrawlResultsData } from './brawl/ui/BrawlResults';
import { parseBrawlParams } from './brawl/ui/urlParams';
// Tiny pure helper (no room/netcode code): the rest of the online UI is loaded lazily via `await import('./online/ui')`.
import { joinCodeFromSearch } from './online/ui/helpers';

/** Create (once) the canvas the renderer will draw into, behind the UI. */
function ensureCanvas(): HTMLCanvasElement {
  const existing = document.getElementById('gk-canvas');
  if (existing instanceof HTMLCanvasElement) return existing;
  const canvas = document.createElement('canvas');
  canvas.id = 'gk-canvas';
  // Insert before #app so the DOM UI layer paints on top of the canvas.
  document.body.insertBefore(canvas, document.body.firstChild);
  return canvas;
}

/** Locate the #app UI root, creating it if index.html was trimmed. */
function ensureAppRoot(): HTMLElement {
  let root = document.getElementById('app');
  if (root === null) {
    root = document.createElement('div');
    root.id = 'app';
    document.body.appendChild(root);
  }
  return root;
}

/** Render a minimal fallback when `?demo=<name>` matched no registered demo. */
function showDemoFallback(root: HTMLElement, requested: string): void {
  const names = demoNames();
  const list = names.length > 0 ? names.join(', ') : 'none registered yet';
  const el = document.createElement('div');
  el.className = 'gk-demo-fallback';
  el.textContent = `No demo named "${requested}". Available: ${list}.`;
  root.appendChild(el);
}

/** The full game flow: menus ↔ match ↔ results around one ScreenManager. */
function runGame(canvas: HTMLCanvasElement, root: HTMLElement, params: URLSearchParams): void {
  // UI previews render through WP-E's procedural rigs (never a direct import).
  setPreviewFactory(createPreview);

  // One AudioEngine for the whole app (installs its own gesture unlock).
  const audio = new AudioEngine();
  const applySettings = (s: GkSettings): void => {
    audio.setVolumes({ master: s.master, music: s.music, sfx: s.sfx });
    audio.setMuted(s.muted);
  };

  const screens = new ScreenManager(root);

  const showLobby = (): void => {
    audio.playLobbyMusic();
    screens.transition(
      new Lobby({
        onPlay: () => showModeSelect(),
        onOnline: () => void startOnline(),
        getSelectedAnimal: () => loadAnimal(),
        onSettingsChange: applySettings,
      }),
    );
  };

  /** PLAY → choose a game mode; each mode goes straight to its own gladiator-selection screen. */
  const showModeSelect = (): void => {
    audio.playLobbyMusic();
    screens.transition(
      new ModeSelect({
        initialMode: loadMode(),
        onSelect: (mode) => (mode === 'battleRoyale' ? showCharacterSelect() : void showBrawlSetup()),
        onBack: () => showLobby(),
      }),
    );
  };

  const showCharacterSelect = (): void => {
    audio.playLobbyMusic();
    screens.transition(
      new CharacterSelect({
        initialAnimal: loadAnimal(),
        onConfirm: (animal) => showDifficultySelect(animal),
        onBack: () => showModeSelect(),
      }),
    );
  };

  const showDifficultySelect = (animal: AnimalId): void => {
    screens.transition(
      new DifficultySelect({
        initialDifficulty: loadDifficulty(),
        onStart: (difficulty) => startMatch(animal, difficulty),
        onBack: () => showCharacterSelect(),
      }),
    );
  };

  const startMatch = (animal: AnimalId, difficulty: Difficulty): void => {
    audio.stopMusic();
    screens.transition(
      new MatchController({
        canvas,
        audio,
        animal,
        difficulty,
        seed: Date.now(),
        onMatchEnd: (results) => showResults(results),
        onQuitToLobby: () => showLobby(),
      }),
    );
  };

  const showResults = (results: MatchResults): void => {
    audio.playResultsFanfare(results.victory);
    screens.transition(
      new Results({
        results,
        // REMATCH: same animal + difficulty, fresh seed inside startMatch.
        onRematch: () => startMatch(results.animal, results.difficulty),
        onChangeGladiator: () => showCharacterSelect(),
        onLobby: () => showLobby(),
      }),
    );
  };

  // ── v1.4 Champions League (platform fighter): setup → match → results, all lazily loaded ────────────────────

  /** Champions League failed to load / start (e.g. no WebGL): log it and fall back to the lobby. */
  const brawlFailed = (what: string, err: unknown): void => {
    console.error(`Champions League: ${what} failed`, err);
    showLobby();
  };

  const showBrawlSetup = async (initial?: BrawlSetupChoice): Promise<void> => {
    try {
      const brawl = await import('./brawl');
      audio.playLobbyMusic();
      screens.transition(
        new brawl.BrawlSetup({
          initial,
          onStart: (setup) => void startBrawl(setup),
          onBack: () => showModeSelect(),
        }),
      );
    } catch (err) {
      brawlFailed('setup', err);
    }
  };

  const startBrawl = async (setup: BrawlSetupChoice): Promise<void> => {
    try {
      const brawl = await import('./brawl');
      audio.stopMusic();
      screens.transition(
        new brawl.BrawlMatchController({
          canvas,
          audio,
          setup,
          seed: (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0,
          onMatchEnd: (results) => void showBrawlResults(results),
          onQuitToLobby: () => showLobby(),
          // Restart / Rematch: same setup, fresh seed (new random roster of bots).
          onRestart: () => void startBrawl(setup),
        }),
      );
    } catch (err) {
      brawlFailed('match', err);
    }
  };

  const showBrawlResults = async (results: BrawlResultsData): Promise<void> => {
    try {
      const brawl = await import('./brawl');
      audio.playResultsFanfare(results.playerWon);
      screens.transition(
        new brawl.BrawlResults({
          results,
          onRematch: () => void startBrawl(results.setup),
          onChangeSetup: () => void showBrawlSetup(results.setup),
          onLobby: () => showLobby(),
        }),
      );
    } catch (err) {
      brawlFailed('results', err);
    }
  };

  // ── v1.5 Online multiplayer: Lobby → Online → Room → networked match → Room, lazily loaded ──────────────────────

  /** Open the online screens (a `?join=CODE` deep link opens the Join tab prefilled). Falls back to the lobby if the module fails to load. */
  const startOnline = async (joinCode: string | null = null): Promise<void> => {
    try {
      const online = await import('./online/ui');
      online.startOnlineFlow({
        screens,
        canvas,
        audio,
        joinCode,
        onExit: () => showLobby(),
        onMenu: () => audio.playLobbyMusic(),
      });
    } catch (err) {
      console.error('Online: failed to load', err);
      showLobby();
    }
  };

  // QA / power-user shortcut: `?brawl=1&animal=lion&stage=skyAqueduct&bots=3&level=3&stocks=3[&time=5]` boots
  // straight into a Champions League match. (`&qa=1` also exposes `window.__gkBrawl` in production builds.)
  const shortcut = parseBrawlParams(params, loadBrawlSetup());
  if (shortcut !== null) {
    void startBrawl(shortcut);
    return;
  }

  // Invite link `…/?join=K7P4Q`: straight to the Join tab (the lobby is one Back away).
  const joinCode = joinCodeFromSearch(window.location.search);
  if (joinCode !== null) {
    void startOnline(joinCode);
    return;
  }

  showLobby();
}

async function boot(): Promise<void> {
  const canvas = ensureCanvas();
  const root = ensureAppRoot();
  mountFpsCounter(); // v1.3.1: shown only when Settings → "Show FPS counter" is on

  const params = new URLSearchParams(window.location.search);
  const demoName = params.get('demo');

  if (demoName !== null && demoName.length > 0) {
    // Lazily load every `*.demo.ts` so their registerDemo side effects run only
    // when a demo is actually requested (keeps normal lobby boot lightweight).
    const demoModules = import.meta.glob('./**/*.demo.ts');
    await Promise.all(Object.values(demoModules).map((load) => load()));

    const demo = getDemo(demoName);
    if (demo !== undefined) {
      await demo(root);
      return;
    }
    showDemoFallback(root, demoName);
    return;
  }

  runGame(canvas, root, params);
}

void boot();
