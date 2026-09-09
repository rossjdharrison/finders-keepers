import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Two entries: index.html (the finders-keepers model over the DO) and cassette.html (the
// client-only cassette player over the in-browser engine — no server). Dev proxy forwards the
// DO surface for index.html; the cassette player needs no proxy.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        cassette: resolve(import.meta.dirname, 'cassette.html'),
      },
    },
  },
  server: {
    proxy: {
      '/collections': { target: 'http://localhost:8787', changeOrigin: true, ws: true },
      '/workspace': { target: 'http://localhost:8787', changeOrigin: true, ws: true },
    },
  },
});
