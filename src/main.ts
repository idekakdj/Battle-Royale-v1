/**
 * Boot + screen flow (BLUEPRINT §3/§14, WP-A shell integrated by WP-I).
 *
 * Responsibilities:
 *  1. Create the full-screen WebGL canvas behind the DOM UI layer (#app).
 *  2. If `?demo=<name>` is present, load demo-registration modules and run the
 *     matching demo, then stop (BLUEPRINT §14 demo-flag convention).
 *  3. Otherwise run the real game flow:
 *     Lobby → CharacterSelect → DifficultySelect → Match → Results, with
 *     REMATCH (same settings, fresh seed) / CHANGE GLADIATOR / LOBBY loops.
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
  CharacterSelect,
  DifficultySelect,
  Results,
  type MatchResults,
  type GkSettings,
  setPreviewFactory,
  loadAnimal,
  loadDifficulty,
} from './ui';
import { MatchController } from './match/MatchController';

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
function runGame(canvas: HTMLCanvasElement, root: HTMLElement): void {
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
        onPlay: () => showCharacterSelect(),
        getSelectedAnimal: () => loadAnimal(),
        onSettingsChange: applySettings,
      }),
    );
  };

  const showCharacterSelect = (): void => {
    audio.playLobbyMusic();
    screens.transition(
      new CharacterSelect({
        initialAnimal: loadAnimal(),
        onConfirm: (animal) => showDifficultySelect(animal),
        onBack: () => showLobby(),
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

  showLobby();
}

async function boot(): Promise<void> {
  const canvas = ensureCanvas();
  const root = ensureAppRoot();

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

  runGame(canvas, root);
}

void boot();
