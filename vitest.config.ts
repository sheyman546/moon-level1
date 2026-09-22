import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The Compact runtime loads a WASM module; keep tests in a single process
    // to avoid re-instantiating it per worker.
    pool: 'threads',
    poolOptions: {
      threads: { singleThread: true },
    },
    testTimeout: 30_000,
  },
});
