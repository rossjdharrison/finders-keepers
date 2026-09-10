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
        composed: resolve(import.meta.dirname, 'composed.html'),
      },
    },
  },
  // Keep esbuild's dep pre-bundler away from the QuickJS emscripten glue: it uses
  // `new URL('emscripten-module.wasm', import.meta.url)` + a dynamic import of the variant loader,
  // which pre-bundling rewrites and breaks. Excluded, they load as native ESM and the ?url'd .wasm
  // resolves to a real, separate fetch. (server.fs.allow is unneeded — Vite 7 already serves from the
  // workspace root, where the hoisted wasm lives.)
  optimizeDeps: {
    exclude: ['quickjs-emscripten-core', '@jitl/quickjs-wasmfile-release-sync'],
  },
  server: {
    proxy: {
      '/collections': { target: 'http://localhost:8787', changeOrigin: true, ws: true },
      '/workspace': { target: 'http://localhost:8787', changeOrigin: true, ws: true },
    },
  },
});
