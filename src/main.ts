/**
 * Boot + screen-flow shell (BLUEPRINT §14, WP-A).
 *
 * Responsibilities:
 *  1. Create the full-screen WebGL canvas behind the DOM UI layer (#app).
 *  2. If `?demo=<name>` is present, load demo-registration modules and run the
 *     matching demo, then stop (BLUEPRINT §14 demo-flag convention).
 *  3. Otherwise mount a placeholder lobby via {@link ScreenManager}. Real screens
 *     (lobby, select, HUD, results…) arrive from WP-F; the wiring points here are
 *     intentionally obvious and typed so later packages slot in cleanly.
 *
 * Demo convention: any module named `*.demo.ts` that calls `registerDemo(...)`
 * is auto-discovered — packages never edit this file to add a demo.
 */

import { ScreenManager, type Screen } from './core/ScreenManager';
import { getDemo, demoNames } from './core/demos';

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

/**
 * Placeholder lobby shown until WP-F supplies the real one. Plain DOM only,
 * implementing the shared {@link Screen} contract so it drops straight into the
 * {@link ScreenManager}.
 */
class PlaceholderLobbyScreen implements Screen {
  private el: HTMLElement | null = null;

  mount(root: HTMLElement): void {
    const el = document.createElement('div');
    el.className = 'gk-placeholder';
    el.innerHTML = `
      <h1 class="gk-placeholder__title">Gladiator Kingdom</h1>
      <p class="gk-placeholder__subtitle">Under Construction</p>
      <button class="gk-placeholder__play" type="button" disabled>Play</button>
      <p class="gk-placeholder__note">
        Foundation shell is live. Lobby, character select, and the arena are
        delivered by later work packages. Append <code>?demo=&lt;name&gt;</code>
        to preview a package once its demo is registered.
      </p>
    `;
    root.appendChild(el);
    this.el = el;
  }

  unmount(): void {
    this.el?.remove();
    this.el = null;
  }
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

async function boot(): Promise<void> {
  ensureCanvas();
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

  // Normal path: mount the screen shell. WP-F/WP-I replace this with real screens.
  const screens = new ScreenManager(root);
  screens.transition(new PlaceholderLobbyScreen());
}

void boot();
