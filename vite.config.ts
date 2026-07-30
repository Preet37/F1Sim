import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { host: true, port: 5173 },
  build: {
    target: 'es2020',
    sourcemap: false,
    // Vite 8 bundles with rolldown, which does not accept the object form of
    // manualChunks. Three.js is a single large dependency and splitting it out
    // buys nothing here — the game needs all of it on the first screen anyway.
  },
});
