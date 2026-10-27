import { defineConfig } from 'vitest/config';

// Sequential on purpose: one test file at a time, one worker, so a full run never saturates the machine.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
    environment: 'node',
    // Several end-to-end tests exercise retry back-off; a loaded machine must not turn that into a spurious failure.
    testTimeout: 20_000,
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
