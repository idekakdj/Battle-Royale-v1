/**
 * Build-time + desktop-shell globals (WP-L).
 *
 * `__APP_VERSION__` is replaced by Vite's `define` with the `version` field of
 * package.json (the single source of truth for the app version).
 *
 * `window.gkDesktop` exists only inside the Electron shell — it is exposed by
 * electron/preload.cjs through contextBridge. In the browser build it is
 * `undefined`, so every use must be guarded.
 */

declare const __APP_VERSION__: string;

/** A newer published release found by the notify-only update check. */
interface GkUpdateInfo {
  /** Newer version, normalized (no leading `v`). */
  readonly version: string;
  /** https://github.com/… release page to open in the system browser. */
  readonly url: string;
}

/** Tiny bridge the Electron preload exposes (sandboxed, context-isolated). */
interface GkDesktopApi {
  readonly isDesktop: true;
  /** App version reported by the main process (package.json `version`). */
  readonly version: string;
  /** `process.platform` of the host (`win32`, `darwin`, `linux`). */
  readonly platform: string;
  toggleFullscreen(): void;
  quit(): void;
  /** Opens an https URL on the allowlist (github.com) in the system browser. */
  openExternal(url: string): void;
  /**
   * One GitHub "latest release" lookup per app launch, performed by the main
   * process (packaged app only). Resolves `null` when up to date, offline, or
   * on any error — never rejects.
   */
  checkForUpdates(): Promise<GkUpdateInfo | null>;
}

interface Window {
  readonly gkDesktop?: GkDesktopApi;
}
