import { defineConfig } from 'vite';

// Static site deployed to GitHub Pages; relative base so assets resolve from
// any subpath (and from a file-less static host via `vite preview`). See §2.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
