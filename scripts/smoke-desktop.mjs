#!/usr/bin/env node
/**
 * `npm run desktop:smoke` (WP-L): launches the *packaged, unpacked* app
 * (release/win-unpacked/Gladiator Kingdom.exe, produced by `npm run dist:dir`
 * or `npm run dist`) with `--smoke-test`, relays its output, and exits with
 * its exit code. The app runs hidden with a throwaway profile, waits for the
 * lobby DOM, opens + Esc-closes the Version History panel, prints
 * "SMOKE OK …" and quits — it never installs anything.
 *
 * `--dev` runs the same check against `electron .` (the unpackaged dist/ build).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const useDev = process.argv.includes('--dev');

let command;
let args;
if (useDev) {
  command = require('electron');
  args = ['.', '--smoke-test'];
} else {
  command = join(ROOT, 'release', 'win-unpacked', 'Gladiator Kingdom.exe');
  args = ['--smoke-test'];
  if (!existsSync(command)) {
    console.error(`desktop:smoke: ${command} not found — run "npm run dist:dir" first.`);
    process.exit(1);
  }
}

const started = Date.now();
const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => {
  out += d;
  process.stdout.write(d);
});
child.stderr.on('data', (d) => process.stderr.write(d));

const killer = setTimeout(() => {
  console.error('desktop:smoke: no result after 60 s — killing the app');
  child.kill();
}, 60000);

child.on('exit', (code) => {
  clearTimeout(killer);
  const ok = code === 0 && out.includes('SMOKE OK');
  console.log(`desktop:smoke: exit code ${code} after ${((Date.now() - started) / 1000).toFixed(1)} s → ${ok ? 'PASS' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
});
