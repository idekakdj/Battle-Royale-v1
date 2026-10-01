/**
 * FPS counter overlay (v1.3.1). A tiny fixed element at the top-right that shows
 * the display's frame rate (rAF callbacks per second) and frame time. It lives on
 * `document.body`, so it works in the lobby, menus and matches alike, and follows
 * the `showFps` setting (Settings → View → "Show FPS counter"), which it re-reads
 * twice a second — no wiring to the settings panels is needed.
 */

import { loadSettings } from './storage';

/** How often the number refreshes and the setting is re-read (ms). */
const REFRESH_MS = 500;

/** Create the overlay once and start its (very cheap) frame-counting loop. */
export function mountFpsCounter(): void {
  if (document.getElementById('gk-fps') !== null) return;

  const el = document.createElement('div');
  el.id = 'gk-fps';
  el.className = 'gk-fps';
  el.setAttribute('aria-hidden', 'true');
  el.hidden = true;
  document.body.appendChild(el);

  let frames = 0;
  let windowStart = performance.now();
  let visible = false;

  const tick = (now: number): void => {
    frames++;
    const elapsed = now - windowStart;
    if (elapsed >= REFRESH_MS) {
      const show = loadSettings().showFps;
      if (show !== visible) {
        visible = show;
        el.hidden = !show;
      }
      if (visible) {
        const fps = (frames * 1000) / elapsed;
        const ms = elapsed / frames;
        el.textContent = `${Math.round(fps)} FPS · ${ms.toFixed(1)} ms`;
        el.classList.toggle('is-good', fps >= 55);
        el.classList.toggle('is-ok', fps < 55 && fps >= 30);
        el.classList.toggle('is-bad', fps < 30);
      }
      frames = 0;
      windowStart = now;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
