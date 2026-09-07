import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// Runs the tests INSIDE workerd (real Durable Objects + SQLite), configured from
// the same wrangler.jsonc the deploy uses.
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        // isolatedStorage's per-suite SQLite file juggling hits EBUSY on Windows;
        // one worker + shared storage is reliable cross-platform for this suite.
        isolatedStorage: false,
        singleWorker: true,
        wrangler: { configPath: './wrangler.jsonc' },
      },
    },
  },
});
