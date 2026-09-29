/**
 * Gladiator Kingdom — preload bridge (WP-L, UPGRADE-PLAN §5.1).
 *
 * Runs sandboxed with contextIsolation, so only `contextBridge`/`ipcRenderer`
 * are available. Exposes exactly one frozen object to the page:
 *
 *   window.gkDesktop = { isDesktop, version, platform, toggleFullscreen(),
 *                        quit(), openExternal(url), checkForUpdates() }
 *
 * Typed for the renderer in src/version/globals.d.ts (GkDesktopApi). The main
 * process re-validates every call (sender origin, URL allowlist).
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit === undefined ? '' : hit.slice(prefix.length);
}

contextBridge.exposeInMainWorld(
  'gkDesktop',
  Object.freeze({
    isDesktop: true,
    version: argValue('gk-version'),
    platform: process.platform,
    toggleFullscreen: () => ipcRenderer.send('gk:toggle-fullscreen'),
    quit: () => ipcRenderer.send('gk:quit'),
    openExternal: (url) => {
      if (typeof url === 'string') ipcRenderer.send('gk:open-external', url);
    },
    checkForUpdates: () => ipcRenderer.invoke('gk:check-updates').catch(() => null),
  }),
);
