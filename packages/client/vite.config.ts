import { defineConfig } from 'vite';

// Dev proxy: forward /collections (HTTP) AND the WebSocket upgrade to the worker
// (`wrangler dev` on :8787). This makes fetch + WS same-origin, so the browser
// doesn't need CORS on the DO — zero server change for the two-tab demo.
export default defineConfig({
  server: {
    proxy: {
      '/collections': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
