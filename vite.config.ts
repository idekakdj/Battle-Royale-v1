import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// package.json `version` is the single source of truth for the app version
// (WP-L). It is baked into the bundle as `__APP_VERSION__` (typed in
// src/version/globals.d.ts) and shown in the lobby footer / Version History.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// Static site deployed to GitHub Pages; relative base so assets resolve from
// any subpath (and from a file-less static host via `vite preview`). See §2.
// The same relative build is loaded by the Electron shell over its `app://`
// protocol (electron/main.cjs), so one `dist/` serves both targets.
export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          // three.js dwarfs the app code; isolating it lets the browser cache
          // it across game updates and silences the chunk-size warning.
          three: ['three'],
        },
      },
    },
  },
});
