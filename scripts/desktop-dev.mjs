#!/usr/bin/env node
/**
 * `npm run desktop:dev` (WP-L): Vite dev server + Electron pointed at it, with
 * hot reload in the desktop shell. No extra dependencies beyond electron.
 *
 *  1. starts Vite on a free-ish port (5199, strict) as a child process;
 *  2. waits until it answers HTTP;
 *  3. launches Electron with GK_DEV_SERVER_URL so electron/main.cjs loads the
 *     dev server instead of dist/ (DevTools on F12);
 *  4. when Electron exits, stops Vite (and vice versa).
 *
 * Extra args are forwarded to Electron, e.g. `npm run desktop:dev -- --smoke-test`.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.GK_DEV_PORT || 5199);
const URL_BASE = `http://localhost:${PORT}/`;
const require = createRequire(import.meta.url);

const viteBin = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const vite = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort'], {
  cwd: ROOT,
  stdio: ['ignore', 'inherit', 'inherit'],
});

let electron = null;
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (electron !== null && electron.exitCode === null) electron.kill();
  if (vite.exitCode === null) vite.kill();
  process.exitCode = code;
}

vite.on('exit', (code) => {
  if (!shuttingDown) {
    console.error(`[desktop:dev] Vite exited (${code}); is port ${PORT} already in use? Set GK_DEV_PORT.`);
    shutdown(code ?? 1);
  }
});

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const up = await waitForServer(URL_BASE, 30000);
if (!up) {
  console.error(`[desktop:dev] Vite did not come up on ${URL_BASE} within 30 s`);
  shutdown(1);
} else {
  const electronPath = require('electron'); // resolves to the Electron binary path
  electron = spawn(electronPath, ['.', ...process.argv.slice(2)], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, GK_DEV_SERVER_URL: URL_BASE },
  });
  electron.on('exit', (code) => shutdown(code ?? 0));
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(0));
