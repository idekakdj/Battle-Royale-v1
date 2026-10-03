/**
 * Gladiator Kingdom — Electron main process (WP-L, UPGRADE-PLAN §5.1).
 *
 * Plain CommonJS, no build step. Serves the production Vite build (`dist/`)
 * over a privileged `app://gk/` protocol (stable origin for localStorage, real
 * MIME types for ES modules, no file:// filesystem exposure) inside a locked
 * down window:
 *   - contextIsolation + sandbox, no Node in the page, tiny preload bridge;
 *   - navigation and window.open denied; https github.com links go to the
 *     system browser, nothing else;
 *   - single instance, no menu bar, F11 / Alt+Enter fullscreen, window
 *     size/position/fullscreen remembered in userData;
 *   - autoplay allowed so Web Audio starts without a gesture; pointer lock
 *     allowed; Esc is never intercepted so it always reaches the game (pause).
 *
 * Flags / env:
 *   --smoke-test          load the app hidden with a throwaway profile, wait for
 *                         the lobby DOM, check version + bridge, open and
 *                         Esc-close the Version History panel, click through to
 *                         a live match, print "SMOKE OK …" and exit 0
 *                         (exit 1 + "SMOKE FAIL: …" otherwise)
 *   --devtools            allow DevTools (F12) in a packaged build
 *   GK_DEV_SERVER_URL     load a Vite dev server instead of dist/ (npm run desktop:dev)
 *   GK_UPDATE_CHECK=force run the update check in an unpackaged build too
 */
'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, screen, session, shell } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

// ── Constants ────────────────────────────────────────────────────────────────
const APP_SCHEME = 'app';
const APP_HOST = 'gk';
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const GITHUB_REPO = 'idekakdj/Battle-Royale-v1';
const LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${GITHUB_REPO}/releases/latest`;
const UPDATE_TIMEOUT_MS = 5000;
/** Hosts `openExternal` may open (https only). */
const EXTERNAL_HOSTS = new Set(['github.com', 'www.github.com']);
/** Renderer permissions the game needs; everything else is denied. */
const ALLOWED_PERMISSIONS = new Set(['pointerLock', 'fullscreen', 'clipboard-sanitized-write']);

const DEFAULT_BOUNDS = { width: 1280, height: 720 };
const MIN_SIZE = { width: 960, height: 540 };
const BACKGROUND = '#14110d'; // --gk-stone-900

const SMOKE = process.argv.includes('--smoke-test');
const DEV_URL = process.env.GK_DEV_SERVER_URL || null;
const IS_DEV = !app.isPackaged;
const DEVTOOLS = IS_DEV || process.argv.includes('--devtools');

const DIST_DIR = path.join(app.getAppPath(), 'dist');

/** Production CSP for pages served from app:// (the dev server sets none). */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "form-action 'none'",
].join('; ');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
};

// ── Pre-ready setup (must run before app 'ready') ────────────────────────────
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true },
  },
]);

// Desktop games should start their audio immediately (the web build unlocks on
// the first click; here the AudioContext is allowed to run from launch).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (SMOKE) {
  // Isolated, fresh profile: never touches the player's data or instance lock.
  const smokeDir = path.join(app.getPath('temp'), 'gladiator-kingdom-smoke');
  try {
    fs.rmSync(smokeDir, { recursive: true, force: true });
  } catch {
    /* a previous run may still hold a lock file; a stale profile is fine */
  }
  app.setPath('userData', smokeDir);
} else if (IS_DEV) {
  // Keep `npm run desktop` data (and its single-instance lock) apart from an
  // installed copy of the game.
  app.setPath('userData', path.join(app.getPath('appData'), `${app.getName()} (dev)`));
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function log(...args) {
  if (IS_DEV || SMOKE) console.log('[gk]', ...args);
}

/** URL belongs to the app itself (app:// origin or the dev server). */
function isAppUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return false;
  if (url.startsWith(`${APP_ORIGIN}/`)) return true;
  if (DEV_URL !== null) {
    try {
      return new URL(url).origin === new URL(DEV_URL).origin;
    } catch {
      return false;
    }
  }
  return false;
}

/** Open an https URL on the allowlist in the system browser; ignore anything else. */
function openExternalSafe(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || !EXTERNAL_HOSTS.has(parsed.hostname)) {
    log('blocked external URL', parsed.href);
    return false;
  }
  void shell.openExternal(parsed.href);
  return true;
}

function isTrustedSender(event) {
  const frameUrl = event.senderFrame ? event.senderFrame.url : '';
  return isAppUrl(frameUrl);
}

/** Minimal semver precedence (twin of src/version/semver.ts). */
function parseSemver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v).trim());
  if (m === null) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

function isNewerVersion(candidate, current) {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  if (a === null || b === null) return false;
  for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i];
  if (a.pre.length === 0 || b.pre.length === 0) return a.pre.length === 0 && b.pre.length > 0;
  const n = Math.min(a.pre.length, b.pre.length);
  for (let i = 0; i < n; i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) > Number(y);
    if (xn !== yn) return yn; // alphanumeric outranks numeric
    return x > y;
  }
  return a.pre.length > b.pre.length;
}

// ── Window state persistence ─────────────────────────────────────────────────
function stateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  const fallback = { ...DEFAULT_BOUNDS, maximized: false, fullscreen: false, saved: false };
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    const width = Math.max(MIN_SIZE.width, Math.round(Number(s.width)));
    const height = Math.max(MIN_SIZE.height, Math.round(Number(s.height)));
    if (!Number.isFinite(width) || !Number.isFinite(height)) return fallback;
    const state = { width, height, maximized: s.maximized === true, fullscreen: s.fullscreen === true, saved: true };
    if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
      // Only restore a position that is still visible on a connected display.
      const bounds = { x: Math.round(s.x), y: Math.round(s.y), width, height };
      const area = screen.getDisplayMatching(bounds).workArea;
      const visibleW = Math.min(bounds.x + width, area.x + area.width) - Math.max(bounds.x, area.x);
      const visibleH = Math.min(bounds.y + height, area.y + area.height) - Math.max(bounds.y, area.y);
      if (visibleW >= 120 && visibleH >= 80) {
        state.x = bounds.x;
        state.y = bounds.y;
      }
    }
    return state;
  } catch {
    return fallback;
  }
}

/**
 * Persist the last *normal* (not maximized/fullscreen) outer window bounds.
 * First launch sizes the *content* to 1280×720; later launches restore these
 * outer bounds exactly (no `useContentSize`), so the size never drifts.
 */
function saveWindowState(win, normal) {
  if (SMOKE || win.isDestroyed() || normal === null) return;
  try {
    const state = {
      x: normal.x,
      y: normal.y,
      width: normal.width,
      height: normal.height,
      maximized: win.isMaximized(),
      fullscreen: win.isFullScreen(),
    };
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(state));
  } catch (err) {
    log('could not save window state', err);
  }
}

// ── app:// protocol (serves dist/) ───────────────────────────────────────────
function registerAppProtocol() {
  const root = path.resolve(DIST_DIR);
  protocol.handle(APP_SCHEME, async (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    if (url.host !== APP_HOST) return new Response('Not found', { status: 404 });
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    if (rel === '' || rel === '/') rel = '/index.html';
    const file = path.resolve(root, `.${rel}`);
    if (file !== root && !file.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 });
    try {
      const data = await fsp.readFile(file);
      const ext = path.extname(file).toLowerCase();
      const headers = { 'content-type': MIME[ext] || 'application/octet-stream', 'x-content-type-options': 'nosniff' };
      if (ext === '.html') headers['content-security-policy'] = CSP;
      return new Response(data, { status: 200, headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

// ── Security: navigation, popups, permissions ────────────────────────────────
app.on('web-contents-created', (_event, contents) => {
  const guardNavigation = (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternalSafe(url);
  };
  contents.on('will-navigate', guardNavigation);
  contents.on('will-redirect', guardNavigation);
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
});

function installPermissionHandlers() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const origin = (details && details.requestingUrl) || contents.getURL();
    callback(ALLOWED_PERMISSIONS.has(permission) && isAppUrl(origin));
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    return ALLOWED_PERMISSIONS.has(permission) && isAppUrl(`${requestingOrigin}/`);
  });
}

// ── Update check (notify-only; packaged builds) ──────────────────────────────
let updatePromise = null;

async function fetchLatestRelease() {
  if (SMOKE) return null;
  if (IS_DEV && process.env.GK_UPDATE_CHECK !== 'force') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPDATE_TIMEOUT_MS);
  try {
    const request = net.fetch(LATEST_RELEASE_API, {
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `GladiatorKingdom/${app.getVersion()}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), UPDATE_TIMEOUT_MS + 250));
    const res = await Promise.race([request, timeout]);
    if (res === null || !res.ok) return null; // offline, 404 (no releases yet), rate limit …
    const body = await res.json();
    if (body === null || typeof body !== 'object' || body.draft === true || body.prerelease === true) return null;
    const version = String(body.tag_name || '').replace(/^v/, '');
    if (!isNewerVersion(version, app.getVersion())) return null;
    const htmlUrl = typeof body.html_url === 'string' ? body.html_url : '';
    const url = htmlUrl.startsWith('https://github.com/') ? htmlUrl : RELEASES_PAGE;
    log('update available', version, url);
    return { version, url };
  } catch {
    return null; // silent on any failure
  } finally {
    clearTimeout(timer);
  }
}

function installIpc() {
  ipcMain.on('gk:toggle-fullscreen', (event) => {
    if (!isTrustedSender(event)) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win !== null) win.setFullScreen(!win.isFullScreen());
  });
  ipcMain.on('gk:quit', (event) => {
    if (isTrustedSender(event)) app.quit();
  });
  ipcMain.on('gk:open-external', (event, url) => {
    if (isTrustedSender(event) && typeof url === 'string') openExternalSafe(url);
  });
  ipcMain.handle('gk:check-updates', (event) => {
    if (!isTrustedSender(event)) return null;
    if (updatePromise === null) updatePromise = fetchLatestRelease();
    return updatePromise;
  });
}

// ── Window ───────────────────────────────────────────────────────────────────
function windowIcon() {
  // Packaged builds use the icon embedded in the .exe; dev uses build/icon.png.
  const png = path.join(__dirname, '..', 'build', 'icon.png');
  return fs.existsSync(png) ? png : undefined;
}

function createWindow() {
  const state = loadWindowState();
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    useContentSize: !state.saved,
    backgroundColor: BACKGROUND,
    title: 'Gladiator Kingdom',
    icon: windowIcon(),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: DEVTOOLS,
      additionalArguments: [`--gk-version=${app.getVersion()}`],
    },
  });
  win.setMenuBarVisibility(false);

  let normal = null;
  const captureNormal = () => {
    if (win.isDestroyed() || win.isMaximized() || win.isFullScreen() || win.isMinimized()) return;
    const b = win.getBounds();
    normal = { x: b.x, y: b.y, width: b.width, height: b.height };
  };

  win.once('ready-to-show', () => {
    if (SMOKE) return; // stays hidden
    captureNormal();
    if (state.maximized) win.maximize();
    if (state.fullscreen) win.setFullScreen(true);
    win.show();
    win.focus();
  });

  // F11 / Alt+Enter toggle fullscreen. Esc is deliberately NOT handled here:
  // it must reach the page (pause menu / pointer-lock release).
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11' || (input.alt && input.key === 'Enter')) {
      event.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    } else if (input.key === 'F12' && DEVTOOLS) {
      event.preventDefault();
      win.webContents.toggleDevTools();
    }
  });

  let saveTimer = null;
  const scheduleSave = () => {
    captureNormal();
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowState(win, normal), 400);
  };
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    win.on(ev, scheduleSave);
  }
  win.on('close', () => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    captureNormal();
    saveWindowState(win, normal);
  });

  if (DEV_URL !== null) {
    void win.loadURL(DEV_URL);
  } else {
    void win.loadURL(`${APP_ORIGIN}/index.html`);
  }
  return win;
}

// ── Smoke test ───────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll a page expression until it is truthy (returns it) or `timeoutMs` passes (returns null). */
async function waitFor(js, expr, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await js(expr);
    if (v) return v;
    await sleep(150);
  }
  return null;
}

function runSmokeTest(win) {
  const started = Date.now();
  const consoleErrors = [];
  let finished = false;
  const finish = (ok, detail) => {
    if (finished) return;
    finished = true;
    const line = ok ? `SMOKE OK ${detail}` : `SMOKE FAIL: ${detail}`;
    process.stdout.write(`${line}\n`);
    if (consoleErrors.length > 0) process.stdout.write(`renderer console errors:\n  ${consoleErrors.join('\n  ')}\n`);
    app.exit(ok ? 0 : 1);
  };

  const hardTimeout = setTimeout(() => finish(false, 'timed out after 55 s (lobby, Battle Royale match or Champions League match)'), 55000);
  win.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (isMainFrame) finish(false, `did-fail-load ${code} ${description} ${url}`);
  });
  win.webContents.on('render-process-gone', (_e, details) => finish(false, `renderer gone: ${details.reason}`));
  win.webContents.on('console-message', (event, legacyLevel, legacyMessage) => {
    const level = event && event.level !== undefined ? event.level : legacyLevel;
    const message = event && event.message !== undefined ? event.message : legacyMessage;
    if (level === 'error' || level === 3) consoleErrors.push(String(message));
  });

  const js = (code) => win.webContents.executeJavaScript(code, true);

  win.webContents.once('did-finish-load', async () => {
    try {
      let probe = null;
      while (probe === null && Date.now() - started < 40000) {
        probe = await js(`(() => {
          if (!document.querySelector('.gk-lobby')) return null;
          const v = document.querySelector('.gk-lobby__version');
          return {
            version: v ? v.textContent : '',
            desktop: !!(window.gkDesktop && window.gkDesktop.isDesktop),
            bridgeVersion: window.gkDesktop ? window.gkDesktop.version : '',
            origin: location.origin,
          };
        })()`);
        if (probe === null) await sleep(200);
      }
      if (probe === null) return finish(false, 'lobby DOM (.gk-lobby) never appeared');
      const version = app.getVersion();
      if (!String(probe.version).includes(version)) {
        return finish(false, `lobby footer "${probe.version}" does not show version ${version}`);
      }
      if (!probe.desktop || probe.bridgeVersion !== version) {
        return finish(false, `preload bridge missing or wrong (desktop=${probe.desktop}, version=${probe.bridgeVersion})`);
      }

      // Version History panel: open from the lobby, count entries, close with a real Esc key event.
      await js(`(() => { const b = document.querySelector('.gk-lobby__whatsnew'); if (b) b.click(); return !!b; })()`);
      await sleep(300);
      const entries = await js(`document.querySelectorAll('.gk-vp .gk-vp__entry').length`);
      if (!(entries > 0)) return finish(false, 'Version History panel did not open or has no entries');
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await sleep(400);
      const panelOpen = await js(`!!document.querySelector('.gk-vp')`);
      if (panelOpen) return finish(false, 'Esc did not reach the page (Version History panel still open)');

      // Drive the menus into a real match: proves WebGL, the sim and audio boot in the shell.
      for (const sel of ['.gk-lobby__play', '.gk-cs__confirm', '.gk-ds__card', '.gk-ds__start']) {
        const clicked = await waitFor(
          js,
          `(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.click(); return true; })()`,
          8000,
        );
        if (!clicked) return finish(false, `menu step ${sel} never appeared`);
        await sleep(300);
      }
      const hud = await waitFor(js, `!!document.querySelector('.gk-hud')`, 10000);
      if (!hud) return finish(false, 'match HUD (.gk-hud) never appeared after START');
      await sleep(2500); // let the match run a few hundred sim ticks
      const canvas = await js(`(() => { const c = document.getElementById('gk-canvas'); return c ? c.width + 'x' + c.height : 'none'; })()`);

      const csp = consoleErrors.filter((m) => /Content Security Policy/i.test(m));
      if (csp.length > 0) return finish(false, `CSP violations: ${csp.join(' | ')}`);
      // A hidden smoke window cannot take pointer lock; anything else uncaught is a real failure.
      const uncaught = consoleErrors.filter((m) => /Uncaught/.test(m) && !/pointer ?lock/i.test(m));
      if (uncaught.length > 0) return finish(false, `uncaught renderer errors: ${uncaught.join(' | ')}`);

      // Champions League (v1.4): its code is a lazily loaded chunk — prove it loads under app://, builds the view and steps the sim.
      const base = await js(`location.origin + location.pathname`);
      await win.loadURL(`${base}?brawl=1&qa=1&animal=lion&stage=skyAqueduct&bots=2&level=2`);
      const cl = await waitFor(
        js,
        `(() => { const g = window.__gkBrawl; if (!g || !g.controller) return false; for (let i = 0; i < 200; i++) g.controller.tick(1 / 60); const s = g.world.snapshot(); return s.frame >= 200 && s.fighters.length === 3 ? s.frame + 'f/' + s.fighters.length + 'p' : false; })()`,
        20000,
      );
      if (!cl) return finish(false, 'Champions League match did not start from ?brawl=1 (lazy chunk / view failed to load)');
      const clHud = await js(`!!document.querySelector('.gk-brawl-hud') || !!document.querySelector('[class*="gk-brawl"]')`);
      if (!clHud) return finish(false, 'Champions League HUD missing');
      const clErrors = consoleErrors.filter((m) => /Uncaught|Failed to fetch dynamically|TypeError/i.test(m) && !/pointer ?lock/i.test(m));
      if (clErrors.length > 0) return finish(false, `Champions League renderer errors: ${clErrors.join(' | ')}`);

      clearTimeout(hardTimeout);
      finish(
        true,
        `version=${version} origin=${probe.origin} desktopBridge=true changelogEntries=${entries} escReachesPage=true matchStarted=true championsLeague=${cl} canvas=${canvas} loadMs=${Date.now() - started}`,
      );
    } catch (err) {
      finish(false, `probe error: ${err && err.message ? err.message : String(err)}`);
    }
  });
}

// ── Boot ─────────────────────────────────────────────────────────────────────
function main() {
  if (!SMOKE && !app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  let mainWindow = null;
  app.on('second-instance', () => {
    if (mainWindow === null || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on('window-all-closed', () => app.quit());

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    registerAppProtocol();
    installPermissionHandlers();
    installIpc();

    if (DEV_URL === null && !fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
      const msg = `No production build found at:\n${DIST_DIR}\n\nRun "npm run build" (or "npm run desktop") first.`;
      if (SMOKE) {
        process.stdout.write(`SMOKE FAIL: ${msg.replace(/\n+/g, ' ')}\n`);
        app.exit(1);
        return;
      }
      dialog.showErrorBox('Gladiator Kingdom', msg);
      app.quit();
      return;
    }

    mainWindow = createWindow();
    if (SMOKE) runSmokeTest(mainWindow);
  });
}

main();
