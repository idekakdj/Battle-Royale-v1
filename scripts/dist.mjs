#!/usr/bin/env node
/**
 * electron-builder wrapper used by `npm run dist` / `npm run dist:dir` (WP-L).
 *
 * Why a wrapper: electron-builder normally extracts its own Electron zip into
 * `release/win-unpacked.tmp` and then renames the folder. Inside a synced or
 * actively scanned folder (this repo lives under OneDrive; Defender scans new
 * executables) that directory rename fails with EPERM. Instead we hand
 * electron-builder the Electron distribution that the `electron` package
 * already installed for `npm run desktop` (node_modules/electron/dist,
 * downloaded on first use) via `electronDist`, which it copies file by file —
 * same Electron version as development, no rename, works the same in CI.
 *
 * Usage: node scripts/dist.mjs [--dir]   (extra args go to electron-builder)
 * Output: release/ — see the artifact list printed at the end.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = join(ROOT, 'release');
const require = createRequire(import.meta.url);

// 1. Resolve (and if needed download) the Electron binary for this platform.
const electronExe = require('electron');
const electronDist = dirname(electronExe);
if (!existsSync(electronExe)) {
  console.error(`dist: Electron binary missing at ${electronExe}`);
  process.exit(1);
}

// 2. Clear leftovers of an interrupted run (they block the next one).
for (const stale of ['win-unpacked.tmp', 'win-unpacked.tmp.lock']) {
  const p = join(RELEASE, stale);
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}

// 3. Run electron-builder.
const extra = process.argv.slice(2);
const cli = join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
const args = [cli, '--win', ...extra, '--publish', 'never', `-c.electronDist=${electronDist}`];
const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);

// 4. Report artifacts.
const mib = (n) => `${(n / 1024 / 1024).toFixed(1)} MiB`;
function dirSize(p) {
  let total = 0;
  for (const entry of readdirSync(p, { withFileTypes: true })) {
    const full = join(p, entry.name);
    total += entry.isDirectory() ? dirSize(full) : statSync(full).size;
  }
  return total;
}
console.log('\nArtifacts:');
if (existsSync(RELEASE)) {
  for (const name of readdirSync(RELEASE)) {
    const full = join(RELEASE, name);
    const st = statSync(full);
    if (st.isDirectory() && name === 'win-unpacked') console.log(`  ${relative(ROOT, full)}\\  (${mib(dirSize(full))} unpacked)`);
    else if (/\.(exe|zip)$/i.test(name)) console.log(`  ${relative(ROOT, full)}  (${mib(st.size)})`);
  }
}
