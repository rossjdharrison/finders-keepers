import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Entries: index.html (the finders-keepers model over the DO — needs the dev proxy below), the
// client-only surfaces catalogue.html (the cassette index) + play.html (the one player, ?cassette=<id>)
// + admin.html (the rules editor), all over the in-browser engine with no server/proxy.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        admin: resolve(import.meta.dirname, 'admin.html'),
        play: resolve(import.meta.dirname, 'play.html'),
        catalogue: resolve(import.meta.dirname, 'catalogue.html'),
      },
      output: {
        // Keep the QuickJS/emscripten runtime in its OWN chunk. play.ts is now its sole consumer, so
        // rollup would otherwise INLINE it into the play chunk — turning the loader's dynamic import
        // into a same-chunk `Promise.resolve().then(() => <const>)` that hits a temporal-dead-zone
        // ("Cannot access 'X' before initialization") when play's top-level await runs during init.
        // A dedicated chunk keeps the import cross-chunk (a real lazy load), so it initializes first.
        manualChunks(id) {
          if (id.includes('quickjs') || id.includes('emscripten')) return 'quickjs';
        },
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
