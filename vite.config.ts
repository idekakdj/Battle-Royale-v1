import { defineConfig } from 'vite';

// Static site deployed to GitHub Pages; relative base so assets resolve from
// any subpath (and from a file-less static host via `vite preview`). See §2.
export default defineConfig({
  base: './',
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
